import { boatProxySandboxId, withBoatProxyToken } from "@t3tools/shared/boatProxy";
import type {
  DesktopSandboxEnvironmentTarget,
  DesktopSshEnvironmentTarget,
  EnvironmentId,
} from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";

import { bootstrapRemoteBearerSession } from "../authorization/remote.ts";
import { deriveWsBaseUrl, normalizeHttpBaseUrl } from "../environment/endpoint.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCatalogEntry,
  type ConnectionCredential,
  SandboxConnectionProfile,
  SandboxConnectionRegistration,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  SandboxConnectionTarget,
  SshConnectionTarget,
  type ConnectionAttemptError,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";
import { connectionRoutes, routeEntry, sshTargetKey } from "./routes.ts";
import {
  describeSandboxEnvironment,
  sandboxConnectionId,
  sandboxProviderLabel,
  sandboxUnavailableError,
  withKeptSandboxDetail,
} from "./sandbox.ts";

export type SandboxControlError =
  | ConnectionAttemptError
  | Persistence.ConnectionPersistenceError
  | EnvironmentRegistry.EnvironmentNotRegisteredError;

export interface PairingConnectionInput {
  readonly boatVm?: { readonly sandboxId: string; readonly hostEnvironmentId: EnvironmentId };
  readonly boatProxy?: {
    readonly sandboxId: string;
    readonly token: string;
    readonly tailnetHttpBaseUrl?: string;
  };
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
  readonly expectedEnvironmentId?: EnvironmentId;
}

export interface SshConnectionInput {
  readonly target: DesktopSshEnvironmentTarget;
  readonly label?: string;
  readonly expectedEnvironmentId?: EnvironmentId;
}

export interface SandboxConnectionInput {
  readonly target: DesktopSandboxEnvironmentTarget;
  /**
   * Identifies one "add" attempt: retrying it after a failure adopts the
   * sandbox the first try created instead of paying for another.
   */
  readonly idempotencyKey: string;
  readonly label?: string;
}

export interface BearerConnectionUpdateInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
}

export class ConnectionOnboarding extends Context.Service<
  ConnectionOnboarding,
  {
    readonly registerPairing: (
      input: PairingConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly registerSsh: (
      input: SshConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly updateBearer: (
      input: BearerConnectionUpdateInput,
    ) => Effect.Effect<void, ConnectionAttemptError | Persistence.ConnectionPersistenceError>;
    /** Creates a cloud sandbox, starts T3 in it, pairs, and saves it as a new environment. */
    readonly registerSandbox: (
      input: SandboxConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    /** Starts a stopped sandbox, switches its environment on, and connects. */
    readonly resumeSandbox: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, SandboxControlError>;
    /**
     * Switches the environment off, then stops its sandbox, so nothing
     * reconnects (and restarts it) until the user resumes it.
     */
    readonly stopSandbox: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, SandboxControlError>;
    /** Deletes the sandbox at its provider, then forgets the environment here. */
    readonly destroySandbox: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      void,
      SandboxControlError | EnvironmentRegistry.PlatformEnvironmentRemovalError
    >;
  }
>()("@t3tools/client-runtime/connection/onboarding/ConnectionOnboarding") {}

const resolvePairingTarget = Effect.fn("clientRuntime.connection.onboarding.resolvePairingTarget")(
  function* (input: PairingConnectionInput) {
    return yield* Effect.try({
      try: () => resolveRemotePairingTarget(input),
      catch: (cause) =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail: cause instanceof Error ? cause.message : "The pairing details are invalid.",
        }),
    });
  },
);

function bearerConnectionId(environmentId: EnvironmentId, httpBaseUrl: string): string {
  const sandboxId = boatProxySandboxId(httpBaseUrl);
  // A relayed VM keeps one route at whatever address its host was reached, so a
  // relaunch from another address replaces the stale route instead of adding one.
  return sandboxId === undefined
    ? `bearer:${environmentId}:${new URL(httpBaseUrl).origin}`
    : `bearer:${environmentId}:boat-proxy:${sandboxId}`;
}

function differentMachineError(label: string) {
  return new ConnectionBlockedError({
    reason: "configuration",
    detail: `That address reaches ${label}, a different machine. Add it as its own environment instead.`,
  });
}

export const preparePairingRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.preparePairingRegistration",
)(function* (input: PairingConnectionInput) {
  const target = yield* resolvePairingTarget(input);
  const presentation = yield* ClientCapabilities.ClientPresentation;
  if (
    input.boatProxy !== undefined &&
    boatProxySandboxId(target.httpBaseUrl) !== input.boatProxy.sandboxId
  ) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "The Boat proxy does not match this VM.",
    });
  }
  const requestBaseUrl =
    input.boatProxy === undefined
      ? target.httpBaseUrl
      : withBoatProxyToken(target.httpBaseUrl, input.boatProxy.token);
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: requestBaseUrl,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  // Checked before redeeming the one-time code, so a wrong link is not spent.
  if (
    input.expectedEnvironmentId !== undefined &&
    descriptor.environmentId !== input.expectedEnvironmentId
  ) {
    return yield* differentMachineError(descriptor.label);
  }
  const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
  // An outdated server is still saved so it can be updated from this client.
  if (compatibilityError !== null && compatibilityError.serverUpdateRequired !== true) {
    return yield* compatibilityError;
  }
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl: requestBaseUrl,
    credential: target.credential,
    clientMetadata: presentation.metadata,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  const connectionId = bearerConnectionId(descriptor.environmentId, target.httpBaseUrl);

  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      ...(input.boatVm === undefined ? {} : { boatVm: input.boatVm }),
      ...(input.boatProxy === undefined
        ? {}
        : {
            boatProxy: {
              sandboxId: input.boatProxy.sandboxId,
              ...(input.boatProxy.tailnetHttpBaseUrl === undefined
                ? {}
                : { tailnetHttpBaseUrl: input.boatProxy.tailnetHttpBaseUrl }),
            },
          }),
    }),
    credential: new BearerConnectionCredential({
      token: access.access_token,
      ...(input.boatProxy === undefined ? {} : { proxyToken: input.boatProxy.token }),
    }),
  });
});

const registerPairingConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerPairingConnection",
)(function* (input: PairingConnectionInput) {
  const registration = yield* preparePairingRegistration(input);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  if (!(yield* registry.register(registration))) return registration.target.environmentId;
  yield* registry.setCompatibility(registration.target.environmentId, null);
  yield* registry
    .setEnabled(registration.target.environmentId, true)
    .pipe(Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void }));
  return registration.target.environmentId;
});

const isBearerCredential = Schema.is(BearerConnectionCredential);
const isBearerProfile = Schema.is(BearerConnectionProfile);

const updateBearerConnection = Effect.fn(
  "clientRuntime.connection.onboarding.updateBearerConnection",
)(function* (input: BearerConnectionUpdateInput) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const saved = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
  const route =
    saved === undefined
      ? undefined
      : connectionRoutes(saved).find(
          (candidate) => candidate.target._tag === "BearerConnectionTarget",
        );
  const entry = saved === undefined || route === undefined ? saved : routeEntry(saved, route);
  const credential =
    entry?.target._tag === "BearerConnectionTarget"
      ? yield* credentials.get(entry.target.connectionId)
      : Option.none();
  const registration = yield* prepareBearerConnectionUpdate({
    input,
    entry: Option.fromUndefinedOr(entry),
    credential,
  });
  yield* registry.register(registration);
});

export const prepareBearerConnectionUpdate = Effect.fn(
  "clientRuntime.connection.onboarding.prepareBearerConnectionUpdate",
)(function* (options: {
  readonly input: BearerConnectionUpdateInput;
  readonly entry: Option.Option<ConnectionCatalogEntry>;
  readonly credential: Option.Option<ConnectionCredential>;
}) {
  const entry = Option.getOrNull(options.entry);
  if (
    entry === undefined ||
    entry === null ||
    entry.target._tag !== "BearerConnectionTarget" ||
    Option.isNone(entry.profile) ||
    !isBearerProfile(entry.profile.value)
  ) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Only saved bearer environments can be edited.",
    });
  }

  const credential = options.credential;
  if (Option.isNone(credential) || !isBearerCredential(credential.value)) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The saved bearer credential is unavailable.",
    });
  }

  const label = options.input.label.trim();
  if (label === "") {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Environment label cannot be empty.",
    });
  }
  const httpBaseUrl = yield* Effect.try({
    try: () => normalizeHttpBaseUrl(options.input.httpBaseUrl),
    catch: (cause) =>
      new ConnectionBlockedError({
        reason: "configuration",
        detail: cause instanceof Error ? cause.message : "The environment URL is invalid.",
      }),
  });
  const connectionId = entry.target.connectionId;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: options.input.environmentId,
      label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: options.input.environmentId,
      label,
      httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
      ...(entry.profile.value.boatVm === undefined ? {} : { boatVm: entry.profile.value.boatVm }),
      ...(entry.profile.value.boatProxy !== undefined &&
      boatProxySandboxId(httpBaseUrl) === entry.profile.value.boatProxy.sandboxId
        ? { boatProxy: entry.profile.value.boatProxy }
        : {}),
    }),
    credential: credential.value,
  });
});

export const prepareSshRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.prepareSshRegistration",
)(function* (input: SshConnectionInput) {
  const gateway = yield* ClientCapabilities.SshEnvironmentGateway;
  const provisioned = yield* gateway.provision(input.target, input.expectedEnvironmentId);
  const connectionId = `ssh:${provisioned.environmentId}:${sshTargetKey(provisioned.bootstrap.target)}`;
  const label = input.label?.trim() || provisioned.label || provisioned.bootstrap.target.alias;

  return new SshConnectionRegistration({
    target: new SshConnectionTarget({
      environmentId: provisioned.environmentId,
      label,
      connectionId,
    }),
    profile: new SshConnectionProfile({
      connectionId,
      environmentId: provisioned.environmentId,
      label,
      target: provisioned.bootstrap.target,
    }),
    credential: new BearerConnectionCredential({ token: provisioned.bearerToken }),
  });
});

const registerSshConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerSshConnection",
)(function* (input: SshConnectionInput) {
  const registration = yield* prepareSshRegistration(input);
  if (
    input.expectedEnvironmentId !== undefined &&
    registration.target.environmentId !== input.expectedEnvironmentId
  ) {
    return yield* differentMachineError(registration.target.label);
  }
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.register(registration);
  return registration.target.environmentId;
});

export const prepareSandboxRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.prepareSandboxRegistration",
)(function* (input: SandboxConnectionInput) {
  const gateway = yield* Effect.serviceOption(ClientCapabilities.SandboxEnvironmentGateway);
  if (Option.isNone(gateway)) {
    return yield* sandboxUnavailableError();
  }
  const bootstrap = yield* gateway.value.provision({
    target: input.target,
    idempotencyKey: input.idempotencyKey,
  });
  // The sandbox exists, and bills, from here on, but no saved row can stop or
  // delete it until it is registered. Its pairing token stays unspent: the
  // first connect redeems it instead of preparing the sandbox again.
  const descriptor = yield* describeSandboxEnvironment({ bootstrap }).pipe(
    Effect.mapError((error) => withKeptSandboxDetail(error, bootstrap.sandbox)),
  );
  const connectionId = sandboxConnectionId(descriptor.environmentId, bootstrap.sandbox);
  const label =
    input.label?.trim() ||
    bootstrap.target.label.trim() ||
    `${sandboxProviderLabel(bootstrap.sandbox.providerId)} sandbox`;

  return new SandboxConnectionRegistration({
    target: new SandboxConnectionTarget({
      environmentId: descriptor.environmentId,
      label,
      connectionId,
    }),
    profile: new SandboxConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label,
      target: bootstrap.target,
      sandbox: bootstrap.sandbox,
      providerUrl: bootstrap.providerUrl,
    }),
  });
});

const registerSandboxConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerSandboxConnection",
)(function* (input: SandboxConnectionInput) {
  const registration = yield* prepareSandboxRegistration(input);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.register(registration);
  return registration.target.environmentId;
});

const isSandboxProfile = Schema.is(SandboxConnectionProfile);

/** The saved sandbox behind an environment, or a blocked error when it has none. */
const savedSandboxProfile = Effect.fn("clientRuntime.connection.onboarding.savedSandboxProfile")(
  function* (environmentId: EnvironmentId) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
    if (entry === undefined) {
      return yield* new EnvironmentRegistry.EnvironmentNotRegisteredError({ environmentId });
    }
    for (const route of connectionRoutes(entry)) {
      const profile = Option.getOrNull(route.profile);
      if (profile !== null && isSandboxProfile(profile)) {
        return { entry, profile };
      }
    }
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: `${entry.target.label} is not a cloud sandbox environment.`,
    });
  },
);

const requireSandboxGateway = Effect.serviceOption(
  ClientCapabilities.SandboxEnvironmentGateway,
).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.fail(sandboxUnavailableError()),
      onSome: Effect.succeed,
    }),
  ),
);

const resumeSandboxEnvironment = Effect.fn("clientRuntime.connection.onboarding.resumeSandbox")(
  function* (environmentId: EnvironmentId) {
    const { entry, profile } = yield* savedSandboxProfile(environmentId);
    const gateway = yield* requireSandboxGateway;
    yield* gateway.resume({ target: profile.target, sandbox: profile.sandbox });
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    if (entry.enabled) {
      yield* registry.retryNow(environmentId);
    } else {
      yield* registry.setEnabled(environmentId, true);
    }
  },
);

const stopSandboxEnvironment = Effect.fn("clientRuntime.connection.onboarding.stopSandbox")(
  function* (environmentId: EnvironmentId) {
    const { profile } = yield* savedSandboxProfile(environmentId);
    const gateway = yield* requireSandboxGateway;
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* registry.setEnabled(environmentId, false);
    yield* gateway.stop(profile.sandbox);
  },
);

const destroySandboxEnvironment = Effect.fn("clientRuntime.connection.onboarding.destroySandbox")(
  function* (environmentId: EnvironmentId) {
    const { profile } = yield* savedSandboxProfile(environmentId);
    const gateway = yield* requireSandboxGateway;
    yield* gateway.destroy(profile.sandbox);
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* registry.remove(environmentId);
  },
);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const sandbox = yield* Effect.serviceOption(ClientCapabilities.SandboxEnvironmentGateway);
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  // The sandbox gateway is read with `serviceOption`, so a client without
  // one (mobile, a browser tab) still builds this service.
  const withSandbox = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const provided = Effect.provideService(
      effect,
      EnvironmentRegistry.EnvironmentRegistry,
      registry,
    );
    return Option.isSome(sandbox)
      ? Effect.provideService(provided, ClientCapabilities.SandboxEnvironmentGateway, sandbox.value)
      : provided;
  };

  return ConnectionOnboarding.of({
    registerPairing: (input) =>
      registerPairingConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
    registerSsh: (input) =>
      registerSshConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ClientCapabilities.SshEnvironmentGateway, ssh),
      ),
    updateBearer: (input) =>
      updateBearerConnection(input).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(ConnectionCredentialStore.ConnectionCredentialStore, credentials),
      ),
    registerSandbox: (input) =>
      withSandbox(registerSandboxConnection(input)).pipe(
        Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
    resumeSandbox: (environmentId) => withSandbox(resumeSandboxEnvironment(environmentId)),
    stopSandbox: (environmentId) => withSandbox(stopSandboxEnvironment(environmentId)),
    destroySandbox: (environmentId) => withSandbox(destroySandboxEnvironment(environmentId)),
  });
});

export const layer = Layer.effect(ConnectionOnboarding, make);
