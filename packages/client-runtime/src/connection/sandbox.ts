import type {
  DesktopSandboxEnvironmentBootstrap,
  DesktopSandboxProviderId,
  DesktopSandboxRef,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { bootstrapRemoteBearerSession } from "../authorization/remote.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";
import { environmentMismatchError, mapRemoteEnvironmentError } from "./errors.ts";
import {
  type ConnectionAttemptError,
  ConnectionBlockedError,
  ConnectionTransientError,
} from "./model.ts";

const SANDBOX_PROVIDER_LABELS: Readonly<Record<DesktopSandboxProviderId, string>> = {
  boat: "boat",
};

/** The provider's product name, for labels such as "boat sandbox". */
export function sandboxProviderLabel(providerId: DesktopSandboxProviderId): string {
  return SANDBOX_PROVIDER_LABELS[providerId];
}

/** One route per provider sandbox, so the same sandbox registered twice replaces its route. */
export function sandboxConnectionId(environmentId: EnvironmentId, sandbox: DesktopSandboxRef) {
  return `sandbox:${environmentId}:${sandbox.providerId}:${sandbox.sandboxId}`;
}

/** Address key for a sandbox route; its URL can change, the provider sandbox cannot. */
export function sandboxRefKey(sandbox: DesktopSandboxRef): string {
  return JSON.stringify([sandbox.providerId, sandbox.sandboxId]);
}

/**
 * A failed add that got as far as creating a sandbox leaves it running, and
 * billing, with no saved row to stop or delete it from, so the error says so.
 */
export function keptSandboxDetail(detail: string, sandbox: DesktopSandboxRef): string {
  const provider = sandboxProviderLabel(sandbox.providerId);
  return `${detail} The ${provider} sandbox it created is kept and billed: create it again with the same settings to retry with it, or delete it in your ${provider} dashboard.`;
}

/** The same error, with `keptSandboxDetail` appended to what the user reads. */
export function withKeptSandboxDetail(
  error: ConnectionAttemptError,
  sandbox: DesktopSandboxRef,
): ConnectionAttemptError {
  const detail = keptSandboxDetail(error.detail, sandbox);
  const traceId = error.traceId === undefined ? {} : { traceId: error.traceId };
  return error._tag === "ConnectionBlockedError"
    ? new ConnectionBlockedError({
        reason: error.reason,
        detail,
        ...traceId,
        ...(error.serverUpdateRequired === undefined
          ? {}
          : { serverUpdateRequired: error.serverUpdateRequired }),
      })
    : new ConnectionTransientError({ reason: error.reason, detail, ...traceId });
}

export function sandboxUnavailableError(): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "unsupported",
    detail: "Cloud sandbox environments are only available in the desktop app.",
  });
}

/**
 * The environment a sandbox bootstrap's forward serves. A URL that answers as
 * another environment (with `expectedEnvironmentId`) or with a protocol this
 * client cannot speak fails; an outdated server passes, so it can be updated
 * remotely.
 */
export const describeSandboxEnvironment = Effect.fn("clientRuntime.connection.sandbox.describe")(
  function* (input: {
    readonly bootstrap: DesktopSandboxEnvironmentBootstrap;
    readonly expectedEnvironmentId?: EnvironmentId;
  }) {
    const descriptor: ExecutionEnvironmentDescriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: input.bootstrap.httpBaseUrl,
    }).pipe(Effect.mapError((error) => mapRemoteEnvironmentError(error)));
    if (
      input.expectedEnvironmentId !== undefined &&
      descriptor.environmentId !== input.expectedEnvironmentId
    ) {
      return yield* environmentMismatchError({
        expected: input.expectedEnvironmentId,
        actual: descriptor.environmentId,
      });
    }
    const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
    if (compatibilityError !== null && compatibilityError.serverUpdateRequired !== true) {
      return yield* compatibilityError;
    }
    return descriptor;
  },
);

/**
 * Exchanges a sandbox bootstrap's pairing token for a bearer token, after
 * `describeSandboxEnvironment` accepts it, so a wrong or incompatible server
 * never gets the one-time token.
 */
export const pairSandboxEnvironment = Effect.fn("clientRuntime.connection.sandbox.pair")(
  function* (input: {
    readonly bootstrap: DesktopSandboxEnvironmentBootstrap;
    readonly expectedEnvironmentId?: EnvironmentId;
  }) {
    const presentation = yield* ClientCapabilities.ClientPresentation;
    const descriptor = yield* describeSandboxEnvironment(input);
    const access = yield* bootstrapRemoteBearerSession({
      httpBaseUrl: input.bootstrap.httpBaseUrl,
      credential: input.bootstrap.pairingToken,
      clientMetadata: presentation.metadata,
    }).pipe(Effect.mapError((error) => mapRemoteEnvironmentError(error)));
    return { descriptor, bearerToken: access.access_token };
  },
);
