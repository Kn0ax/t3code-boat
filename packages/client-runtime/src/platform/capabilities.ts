import {
  type AuthClientPresentationMetadata,
  type DesktopSandboxEnvironmentBootstrap,
  type DesktopSandboxEnvironmentTarget,
  type DesktopSandboxRef,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ConnectionAttemptError } from "../connection/model.ts";

export interface PreparedSshEnvironment {
  readonly bootstrap: DesktopSshEnvironmentBootstrap;
  readonly bearerToken: string;
}

export interface ProvisionedSshEnvironment extends PreparedSshEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** Stable for one signed-in session, including same-account token refreshes. */
export interface CloudSessionIdentity {
  readonly accountId: string;
}

export class CloudSession extends Context.Service<
  CloudSession,
  {
    readonly identity: Effect.Effect<Option.Option<CloudSessionIdentity>>;
    readonly clerkToken: Effect.Effect<string, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/platform/capabilities/CloudSession") {}

export class RelayDeviceIdentity extends Context.Service<
  RelayDeviceIdentity,
  {
    readonly deviceId: Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/platform/capabilities/RelayDeviceIdentity") {}

/**
 * A random id this client keeps across launches. Environments it connects to
 * record its hash, so two environments opened from one device share an owner
 * in analytics even when nobody is signed in.
 */
export class AnalyticsDevice extends Context.Reference<{
  readonly id: Effect.Effect<Option.Option<string>>;
}>("@t3tools/client-runtime/platform/capabilities/AnalyticsDevice", {
  defaultValue: () => ({ id: Effect.succeedNone }),
}) {}

export class ClientPresentation extends Context.Service<
  ClientPresentation,
  {
    readonly metadata: AuthClientPresentationMetadata;
  }
>()("@t3tools/client-runtime/platform/capabilities/ClientPresentation") {}

export class PrimaryEnvironmentAuth extends Context.Service<
  PrimaryEnvironmentAuth,
  {
    readonly bearerToken: Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/platform/capabilities/PrimaryEnvironmentAuth") {}

export class SshEnvironmentGateway extends Context.Service<
  SshEnvironmentGateway,
  {
    /**
     * With `expectedEnvironmentId`, a server that is a different machine fails
     * before its one-time pairing credential is spent.
     */
    readonly provision: (
      target: DesktopSshEnvironmentTarget,
      expectedEnvironmentId?: EnvironmentId,
    ) => Effect.Effect<ProvisionedSshEnvironment, ConnectionAttemptError>;
    /**
     * Starts or reuses the remote server for a saved connection. Returns
     * `bearerToken`, the token this client saved from an earlier pairing, while
     * the host still accepts it with the standard scopes, and pairs again only
     * when it does not, so a reconnect adds no session on the host.
     */
    readonly prepare: (input: {
      readonly connectionId: string;
      readonly expectedEnvironmentId: EnvironmentId;
      readonly target: DesktopSshEnvironmentTarget;
      readonly bearerToken?: string;
    }) => Effect.Effect<PreparedSshEnvironment, ConnectionAttemptError>;
    readonly disconnect: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/platform/capabilities/SshEnvironmentGateway") {}

/**
 * Cloud sandboxes, provisioned by the platform (the desktop main process) so
 * provider API keys stay there. Shaped like `SshEnvironmentGateway`, except
 * that it returns the bootstrap with its pairing token unspent: the sandbox's
 * public URL is reachable from the client, which checks it and pairs itself.
 * Clients without the capability cannot use sandbox routes.
 */
export class SandboxEnvironmentGateway extends Context.Service<
  SandboxEnvironmentGateway,
  {
    /**
     * Creates a sandbox and brings a paired `t3 serve` up in it. Retrying
     * with the same `idempotencyKey` adopts the sandbox an earlier attempt
     * created instead of paying for a second one.
     */
    readonly provision: (input: {
      readonly target: DesktopSandboxEnvironmentTarget;
      readonly idempotencyKey: string;
    }) => Effect.Effect<DesktopSandboxEnvironmentBootstrap, ConnectionAttemptError>;
    /**
     * Makes sure `t3 serve` runs in a saved sandbox and mints a fresh pairing
     * token. A stopped sandbox is not started: that fails as blocked, so an
     * automatic reconnect never resumes (and bills) a sandbox on its own.
     */
    readonly prepare: (input: {
      readonly connectionId: string;
      readonly expectedEnvironmentId: EnvironmentId;
      readonly target: DesktopSandboxEnvironmentTarget;
      readonly sandbox: DesktopSandboxRef;
    }) => Effect.Effect<DesktopSandboxEnvironmentBootstrap, ConnectionAttemptError>;
    /** Starts a stopped sandbox and its server, at the user's request. */
    readonly resume: (input: {
      readonly target: DesktopSandboxEnvironmentTarget;
      readonly sandbox: DesktopSandboxRef;
    }) => Effect.Effect<void, ConnectionAttemptError>;
    /** Stops `t3 serve` and the sandbox; its disk is kept. */
    readonly stop: (sandbox: DesktopSandboxRef) => Effect.Effect<void, ConnectionAttemptError>;
    /** Deletes the sandbox and its disk. Already deleted counts as done. */
    readonly destroy: (sandbox: DesktopSandboxRef) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/platform/capabilities/SandboxEnvironmentGateway") {}
