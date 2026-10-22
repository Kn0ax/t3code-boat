/**
 * The contract a cloud sandbox implements. This build has one provider, boat.
 * A provider creates a Linux VM, runs a shell script in it, and makes one TCP
 * port reachable over HTTPS. Installing `t3`, starting `t3 serve`, and pairing
 * sit on top in `SandboxEnvironmentManager`.
 */
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const SandboxProviderId = Schema.Literals(["boat"]);
export type SandboxProviderId = typeof SandboxProviderId.Type;

export const SandboxSize = Schema.Literals(["small", "medium", "large"]);
export type SandboxSize = typeof SandboxSize.Type;

export const SandboxStatus = Schema.Literals([
  "creating",
  "running",
  "stopping",
  "stopped",
  "error",
  "destroyed",
]);
export type SandboxStatus = typeof SandboxStatus.Type;

/** Stable, serializable pointer to one sandbox; safe to persist in a connection profile. */
export const SandboxRef = Schema.Struct({
  providerId: SandboxProviderId,
  sandboxId: Schema.String,
});
export type SandboxRef = typeof SandboxRef.Type;

export interface SandboxCreateInput {
  /** Human label shown in the provider's dashboard. */
  readonly label: string;
  /**
   * Environment variables set for every process in the sandbox (GH_TOKEN,
   * ANTHROPIC_API_KEY, ...). Values are secrets: adapters must never log them.
   */
  readonly env: Readonly<Record<string, string>>;
  readonly size: SandboxSize;
  /** Provider-specific region id; adapters ignore it when they have no regions. */
  readonly region?: string;
  /** Auto-stop after this many idle minutes. 0 disables auto-stop where allowed. */
  readonly idleTimeoutMinutes: number;
  /** Retrying a create with the same key must not create a second (billable) sandbox. */
  readonly idempotencyKey: string;
  /**
   * Named disk snapshot to start from. Fails `not-found` when no snapshot has
   * that name; adapters without named snapshots ignore it.
   */
  readonly snapshot?: string;
}

export interface SandboxInfo {
  readonly ref: SandboxRef;
  readonly status: SandboxStatus;
  readonly label: string;
  /** `uname -m` style architecture when the provider reports it. */
  readonly arch?: "x64" | "arm64";
}

export interface SandboxExecInput {
  /** POSIX sh script. Adapters must deliver it byte-exact (stdin or base64), never via naive quoting. */
  readonly script: string;
  /** Extra args available to the script as "$@". */
  readonly args?: ReadonlyArray<string>;
  readonly timeoutMs: number;
}

export interface SandboxBackgroundInput {
  /** POSIX sh script, delivered byte-exact like `exec`. */
  readonly script: string;
  readonly args?: ReadonlyArray<string>;
  /** File in the sandbox that receives the process's stdout and stderr. */
  readonly logPath: string;
}

export interface SandboxExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SandboxExposedPort {
  /** Public https origin that forwards to the port, without a trailing slash. */
  readonly httpBaseUrl: string;
  /**
   * Headers for requests through the provider's proxy. The desktop forward
   * attaches them; the renderer never sees them.
   */
  readonly headers: Readonly<Record<string, string>>;
}

export const SandboxProviderOperation = Schema.Literals([
  "create",
  "get",
  "list",
  "exec",
  "startBackground",
  "writeFile",
  "readFile",
  "exposePort",
  "stop",
  "resume",
  "destroy",
  "fork",
  "extendAutoStop",
]);
export type SandboxProviderOperation = typeof SandboxProviderOperation.Type;

/**
 * Failure kinds callers can act on. Provider error text can contain secrets
 * and is never copied into this error; `cause` is kept for logs behind a
 * Defect so it is not serialized over IPC.
 */
export const SandboxProviderFailure = Schema.Literals([
  "unauthorized",
  "not-found",
  "quota-exceeded",
  "timeout",
  "unsupported",
  "network",
  "provider-error",
]);
export type SandboxProviderFailure = typeof SandboxProviderFailure.Type;

export class SandboxProviderError extends Schema.TaggedError<SandboxProviderError>()(
  "SandboxProviderError",
  {
    providerId: SandboxProviderId,
    operation: SandboxProviderOperation,
    failure: SandboxProviderFailure,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Sandbox provider ${this.providerId} failed to ${this.operation} (${this.failure}).`;
  }
}

export interface SandboxProviderShape {
  readonly id: SandboxProviderId;
  readonly create: (input: SandboxCreateInput) => Effect.Effect<SandboxInfo, SandboxProviderError>;
  readonly get: (ref: SandboxRef) => Effect.Effect<SandboxInfo, SandboxProviderError>;
  readonly list: () => Effect.Effect<ReadonlyArray<SandboxInfo>, SandboxProviderError>;
  readonly exec: (
    ref: SandboxRef,
    input: SandboxExecInput,
  ) => Effect.Effect<SandboxExecResult, SandboxProviderError>;
  /**
   * Start a long-running process (`t3 serve`) and return as soon as it has
   * started. A synchronous exec waits until every child exits, so a
   * backgrounded server never returns. boat uses a detached command instead.
   */
  readonly startBackground: (
    ref: SandboxRef,
    input: SandboxBackgroundInput,
  ) => Effect.Effect<void, SandboxProviderError>;
  readonly writeFile: (
    ref: SandboxRef,
    path: string,
    content: Uint8Array,
  ) => Effect.Effect<void, SandboxProviderError>;
  readonly readFile: (
    ref: SandboxRef,
    path: string,
  ) => Effect.Effect<Uint8Array, SandboxProviderError>;
  readonly exposePort: (
    ref: SandboxRef,
    port: number,
  ) => Effect.Effect<SandboxExposedPort, SandboxProviderError>;
  readonly stop: (ref: SandboxRef) => Effect.Effect<void, SandboxProviderError>;
  readonly resume: (ref: SandboxRef) => Effect.Effect<SandboxInfo, SandboxProviderError>;
  readonly destroy: (ref: SandboxRef) => Effect.Effect<void, SandboxProviderError>;
  /**
   * Push a running sandbox's auto-stop out to `minutes` from now. Only for
   * providers whose auto-stop is a deadline rather than idle time (boat).
   */
  readonly extendAutoStop?: (
    ref: SandboxRef,
    minutes: number,
  ) => Effect.Effect<void, SandboxProviderError>;
  /** Disk-level fork for parallel attempts. Absent when the provider has none. */
  readonly fork?: (
    ref: SandboxRef,
    label: string,
  ) => Effect.Effect<SandboxInfo, SandboxProviderError>;
}
