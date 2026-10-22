/**
 * Turns any `SandboxProviderShape` into a T3 environment: create (or resume)
 * the sandbox, install the pinned `t3` release with the same runner the SSH
 * path uses, start `t3 serve`, publish its port, and mint a pairing token.
 *
 * `t3 serve` starts through `provider.startBackground`, never `exec`: live runs
 * showed a provider's exec waits for every child its script leaves running.
 * The launch is an exec that decides (reuse a running server, or where a new
 * one logs), the background start, and an exec that waits for readiness.
 *
 * The result has the same shape the desktop SSH flow hands the web client
 * (`DesktopSshEnvironmentBootstrap`), so the client connects to a sandbox the
 * way it connects to any remote environment.
 *
 * Failures never tear down what they leave behind: a sandbox that was created
 * but did not come up is billable, but deleting it is the user's call. Every
 * failure is a `SandboxEnvironmentError` naming the stage and, once a sandbox
 * exists, its `ref`, so the UI can offer retry (`reconnect`) or `destroy`.
 * Provider failures are folded into it with their `failure` kind.
 */
import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { extractJsonObject, fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import {
  buildSandboxAgentClisScript,
  buildSandboxInstallScript,
  buildSandboxLaunchScript,
  buildSandboxPairingScript,
  buildSandboxReadyScript,
  buildSandboxServeScript,
  buildSandboxStopScript,
  isSandboxServerLogPath,
  SANDBOX_PAIRING_TOKEN_TTL_MINUTES,
  SANDBOX_SERVER_LOG_PATH,
  sandboxRunnerOptions,
} from "./bootstrapScripts.ts";
import {
  SandboxProviderError,
  SandboxProviderFailure,
  SandboxRef,
  type SandboxExecInput,
  type SandboxExecResult,
  type SandboxExposedPort,
  type SandboxInfo,
  type SandboxProviderId,
  type SandboxProviderOperation,
  type SandboxProviderShape,
  type SandboxSize,
} from "./SandboxProvider.ts";

/** Port `t3 serve` listens on inside every sandbox. */
export const SANDBOX_T3_PORT = 3773;

export interface SandboxEnvironmentTarget {
  readonly label: string;
  readonly size: SandboxSize;
  readonly region?: string;
  readonly idleTimeoutMinutes: number;
  /** Named disk snapshot to start from (see `SandboxCreateInput.snapshot`). */
  readonly snapshot?: string;
  /** Exact t3 release version to install (normally the desktop app's own version). */
  readonly t3Version: string;
  /** Install the Claude Code and Codex CLIs when the image lacks them. */
  readonly installAgentClis: boolean;
}

export interface SandboxEnvironmentBootstrap {
  readonly ref: SandboxRef;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  /** One-time pairing credential for `/oauth/token`. Secret. */
  readonly pairingToken: string;
  /**
   * The exposed port's headers. Desktop main's loopback forward adds them to
   * every request, so clients never see them.
   */
  readonly requestHeaders: Readonly<Record<string, string>>;
}

export const SandboxEnvironmentStage = Schema.Literals([
  "create",
  "resume",
  "install",
  "launch",
  "expose",
  "probe",
  "pair",
  "stop",
  "destroy",
]);
export type SandboxEnvironmentStage = typeof SandboxEnvironmentStage.Type;

export class SandboxEnvironmentError extends Schema.TaggedError<SandboxEnvironmentError>()(
  "SandboxEnvironmentError",
  {
    stage: SandboxEnvironmentStage,
    /** Safe, secret-free explanation suitable for the UI. */
    detail: Schema.String,
    /**
     * The sandbox the failure concerns, once one exists. A failed provision
     * leaves it running so the UI can retry with `reconnect` or `destroy` it.
     */
    ref: Schema.optional(SandboxRef),
    /** Set when a provider call failed, so callers can act on the kind (re-auth, quota, ...). */
    failure: Schema.optional(SandboxProviderFailure),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Cloud sandbox ${this.stage} failed: ${this.detail}`;
  }
}

/** A reconnect that may not start the sandbox found it stopped. */
export class SandboxStoppedError extends Schema.TaggedError<SandboxStoppedError>()(
  "SandboxStoppedError",
  { ref: SandboxRef },
) {
  override get message(): string {
    return "The cloud sandbox is stopped.";
  }
}

/**
 * The manager reports provider failures as a
 * `SandboxEnvironmentError` carrying the stage, the sandbox `ref` and the
 * provider's `failure` kind, with the `SandboxProviderError` as its `cause`.
 */
export interface SandboxEnvironmentManagerShape {
  /** Create a new sandbox and bring a paired `t3 serve` up in it. */
  readonly provision: (input: {
    readonly provider: SandboxProviderShape;
    readonly target: SandboxEnvironmentTarget;
    /** Secrets injected as env (GH_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY, ...). */
    readonly env: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
  }) => Effect.Effect<SandboxEnvironmentBootstrap, SandboxEnvironmentError | SandboxProviderError>;
  /** Resume a stopped sandbox if needed, make sure `t3 serve` runs, mint a fresh pairing token. */
  readonly reconnect: (input: {
    readonly provider: SandboxProviderShape;
    readonly ref: SandboxRef;
    readonly t3Version: string;
    /**
     * False fails a stopped sandbox with `SandboxStoppedError` instead of
     * starting it. The check holds the lock `stop` takes, so a stop that
     * lands while an automatic reconnect waits is not undone by it.
     */
    readonly resume: boolean;
  }) => Effect.Effect<
    SandboxEnvironmentBootstrap,
    SandboxEnvironmentError | SandboxProviderError | SandboxStoppedError
  >;
  readonly stop: (input: {
    readonly provider: SandboxProviderShape;
    readonly ref: SandboxRef;
  }) => Effect.Effect<void, SandboxEnvironmentError | SandboxProviderError>;
  readonly destroy: (input: {
    readonly provider: SandboxProviderShape;
    readonly ref: SandboxRef;
  }) => Effect.Effect<void, SandboxEnvironmentError | SandboxProviderError>;
}

export interface SandboxEnvironmentTiming {
  /** How long a new or resumed sandbox may take to report `running`. */
  readonly runningTimeoutMs: number;
  readonly statusPollIntervalMs: number;
  /** Exec budget for installing the pinned release (a ~70 MB download on a cold sandbox). */
  readonly installTimeoutMs: number;
  readonly agentClisTimeoutMs: number;
  /**
   * Exec budget for the launch step, which reuses a running server or stops a
   * stale one (up to a few seconds) and starts nothing itself.
   */
  readonly launchTimeoutMs: number;
  /** How long `provider.startBackground` may take to report that `t3 serve` started. */
  readonly startServerTimeoutMs: number;
  /** Exec budget for the ready step, which waits up to 60s for a new server on loopback. */
  readonly serverReadyTimeoutMs: number;
  /** How long `t3 serve` may take to answer through the provider's proxy. */
  readonly probeTimeoutMs: number;
  /** Bound on one probe request, so a hung proxy connection cannot eat the whole budget. */
  readonly probeRequestTimeoutMs: number;
  readonly probeIntervalMs: number;
  readonly pairTimeoutMs: number;
  /** Budget for stopping `t3 serve` cleanly before the sandbox itself stops. */
  readonly stopServerTimeoutMs: number;
}

const DEFAULT_SANDBOX_ENVIRONMENT_TIMING: SandboxEnvironmentTiming = {
  runningTimeoutMs: 180_000,
  statusPollIntervalMs: 2_000,
  installTimeoutMs: 900_000,
  agentClisTimeoutMs: 300_000,
  launchTimeoutMs: 120_000,
  startServerTimeoutMs: 60_000,
  serverReadyTimeoutMs: 120_000,
  probeTimeoutMs: 60_000,
  probeRequestTimeoutMs: 5_000,
  probeIntervalMs: 1_000,
  pairTimeoutMs: 120_000,
  stopServerTimeoutMs: 15_000,
};

export interface SandboxEnvironmentManagerOptions {
  /** Release download origin override for mirrors and staging builds. */
  readonly releaseBaseUrl?: string;
  readonly timing?: Partial<SandboxEnvironmentTiming>;
}

const PROVIDER_NAMES: Readonly<Record<SandboxProviderId, string>> = {
  boat: "boat",
};

const OPERATION_PHRASES: Readonly<Record<SandboxProviderOperation, string>> = {
  create: "create the sandbox",
  get: "look up the sandbox",
  list: "list sandboxes",
  exec: "run a command in the sandbox",
  startBackground: "start the T3 server in the sandbox",
  writeFile: "write a file in the sandbox",
  readFile: "read a file from the sandbox",
  exposePort: "publish the T3 port",
  stop: "stop the sandbox",
  resume: "start the sandbox",
  destroy: "delete the sandbox",
  fork: "fork the sandbox",
  extendAutoStop: "extend the sandbox's auto-stop",
};

/** A secret-free sentence for a provider failure, built from its labels only. */
function providerFailureDetail(error: SandboxProviderError): string {
  const name = PROVIDER_NAMES[error.providerId];
  const operation = OPERATION_PHRASES[error.operation];
  switch (error.failure) {
    case "unauthorized":
      return `${name} rejected the credentials while trying to ${operation}. Check the API key.`;
    case "not-found":
      return `${name} could not find the sandbox; it may have been deleted.`;
    case "quota-exceeded":
      return `${name} refused to ${operation} because the account is over its quota.`;
    case "timeout":
      return `${name} timed out trying to ${operation}.`;
    case "unsupported":
      return `${name} cannot ${operation}.`;
    case "network":
      return `Could not reach ${name} to ${operation}.`;
    case "provider-error":
      return `${name} failed to ${operation}.`;
  }
}

const fromProviderError =
  (stage: SandboxEnvironmentStage, ref: SandboxRef | undefined) =>
  (error: SandboxProviderError): SandboxEnvironmentError =>
    new SandboxEnvironmentError({
      stage,
      ref,
      failure: error.failure,
      detail: providerFailureDetail(error),
      cause: error,
    });

/**
 * Bootstrap stderr is classified into fixed phrases and never quoted: the
 * sandbox's env holds the user's tokens, and a script's output is not ours to
 * vouch for. Patterns match the messages the runner and launch scripts print,
 * most specific first.
 */
const SCRIPT_DIAGNOSTICS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Cannot determine the home directory/u, "the sandbox user has no home directory"],
  [/Checksum mismatch/u, "the downloaded t3 release failed checksum verification"],
  [/has no t3 release archive/u, "no t3 release exists for this sandbox's operating system or CPU"],
  [/needs curl or wget/u, "the sandbox image has neither curl nor wget"],
  [/does not run on this host/u, "the t3 executable does not run in this sandbox image"],
  [
    /installation has held .* for too long/u,
    "another t3 installation in the sandbox never finished",
  ],
  [/returned error: 404|404 Not Found/u, "the t3 release was not found for download"],
  [/curl: \(\d+\)|wget: /u, "downloading the t3 release failed"],
  [/No space left on device/u, "the sandbox is out of disk space"],
  [/already in use inside the sandbox/u, `port ${SANDBOX_T3_PORT} is taken inside the sandbox`],
  [
    /exited before becoming ready/u,
    `the T3 server exited during startup (its log is ${SANDBOX_SERVER_LOG_PATH})`,
  ],
  [/Another T3 server is already running/u, "another T3 server is already running in the sandbox"],
  [
    /did not become ready/u,
    `the T3 server did not become ready (its log is ${SANDBOX_SERVER_LOG_PATH})`,
  ],
  [/process did not start/u, "the sandbox never ran the T3 server process"],
];

/**
 * Slack on top of an exec's own `timeoutMs` before the manager gives up on the
 * call itself, so an adapter that cannot enforce the budget (or a script that
 * leaves a child the provider waits for) cannot hold a sandbox's lock forever.
 */
const EXEC_GRACE_MS = 15_000;

function classifyScriptStderr(stderr: string): string | undefined {
  return SCRIPT_DIAGNOSTICS.find(([pattern]) => pattern.test(stderr))?.[1];
}

function formatBudget(ms: number): string {
  return ms >= 120_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1_000)} seconds`;
}

function refLogFields(ref: SandboxRef) {
  return { providerId: ref.providerId, sandboxId: ref.sandboxId };
}

function refKey(ref: SandboxRef): string {
  return `${ref.providerId}:${ref.sandboxId}`;
}

interface SandboxEndpoint {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * The client joins endpoint paths onto the origin and drops any path or query
 * (`environmentEndpointUrl`), so a preview URL must be a bare origin: a token
 * in its query would silently vanish. The URL itself can be a signed preview
 * link, so it is never logged or quoted.
 */
function resolveEndpoint(exposed: SandboxExposedPort): SandboxEndpoint | undefined {
  if (!URL.canParse(exposed.httpBaseUrl)) {
    return undefined;
  }
  const url = new URL(exposed.httpBaseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return undefined;
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  if (url.username !== "" || url.password !== "") {
    return undefined;
  }
  return {
    httpBaseUrl: url.origin,
    wsBaseUrl: url.origin.replace(/^http/u, "ws"),
    headers: { ...exposed.headers },
  };
}

const AgentClisOutput = Schema.Struct({
  npm: Schema.optional(Schema.Boolean),
  failed: Schema.optional(Schema.String),
});

/** What the launch step decided; `logPath` is set when a new server has to start. */
const LaunchOutput = Schema.Struct({
  serverKind: Schema.Literals(["managed", "external"]),
  reused: Schema.Boolean,
  logPath: Schema.optional(Schema.String),
});

const PairingOutput = Schema.Struct({ credential: Schema.String });

const decodeAgentClisOutput = Schema.decodeEffect(fromLenientJson(AgentClisOutput));
const decodeLaunchOutput = Schema.decodeEffect(fromLenientJson(LaunchOutput));
const decodePairingOutput = Schema.decodeEffect(fromLenientJson(PairingOutput));
/**
 * The probe accepts only a descriptor the client itself can decode, which
 * tells `t3 serve` from a proxy's own 200 page (a preview warning, a
 * "starting" placeholder) and fails early on a server the client could not use.
 */
const decodeEnvironmentDescriptor = Schema.decodeEffect(
  Schema.fromJsonString(ExecutionEnvironmentDescriptor),
);

/** Decodes a script's JSON line, tolerating shell startup noise around it (as the SSH path does). */
const decodeScriptJson = <A, E>(
  stdout: string,
  decode: (input: string) => Effect.Effect<A, E>,
): Effect.Effect<Option.Option<A>> =>
  decode(stdout).pipe(
    Effect.catch(() => decode(extractJsonObject(stdout))),
    Effect.asSome,
    Effect.orElseSucceed(() => Option.none<A>()),
  );

type ProbeObservation =
  | { readonly _tag: "Ready"; readonly serverVersion: string }
  | { readonly _tag: "Status"; readonly status: number }
  | { readonly _tag: "NotT3" }
  | { readonly _tag: "Unreachable" }
  | { readonly _tag: "RequestTimeout" };

function describeLastProbe(observation: ProbeObservation): string {
  switch (observation._tag) {
    case "Status":
      return `the last response was HTTP ${observation.status}`;
    case "NotT3":
      return "the URL answered, but not with a T3 environment";
    case "Unreachable":
      return "the URL could not be reached";
    case "RequestTimeout":
      return "requests to the URL timed out";
    case "Ready":
      return "the server answered";
  }
}

type ScriptStage = "install" | "launch" | "pair";

/** A secret-free stand-in for a provider call the manager stopped waiting for. */
const managerTimeout = (providerId: SandboxProviderId, operation: SandboxProviderOperation) =>
  new SandboxProviderError({ providerId, operation, failure: "timeout" });

type ProvisionInput = Parameters<SandboxEnvironmentManagerShape["provision"]>[0];
type ReconnectInput = Parameters<SandboxEnvironmentManagerShape["reconnect"]>[0];
type SandboxTargetInput = Parameters<SandboxEnvironmentManagerShape["stop"]>[0];

interface SandboxScripts {
  readonly install: string;
  readonly agentClis: string | null;
  readonly launch: string;
  readonly serve: string;
  readonly ready: string;
  readonly pair: string;
}

const makeSandboxEnvironmentManager = Effect.fn("sandbox-core/SandboxEnvironmentManager.make")(
  function* (
    options: SandboxEnvironmentManagerOptions = {},
  ): Effect.fn.Return<SandboxEnvironmentManagerShape, never, HttpClient.HttpClient> {
    const httpClient = yield* HttpClient.HttpClient;
    const timing: SandboxEnvironmentTiming = {
      ...DEFAULT_SANDBOX_ENVIRONMENT_TIMING,
      ...options.timing,
    };
    // One lock per sandbox so a reconnect cannot launch a server while a stop is
    // pending, and one per idempotency key so a double-clicked provision does not
    // run two bootstraps into the same (deduplicated) sandbox.
    const locks = yield* KeyedLock.make<string>();

    // Built before any provider call: an unusable version must fail before a
    // billable sandbox exists.
    const buildScripts = (input: {
      readonly t3Version: string;
      readonly installAgentClis: boolean;
      readonly ref?: SandboxRef;
    }): Effect.Effect<SandboxScripts, SandboxEnvironmentError> =>
      Effect.try({
        try: () => {
          const runner = sandboxRunnerOptions({
            t3Version: input.t3Version,
            releaseBaseUrl: options.releaseBaseUrl,
          });
          return {
            install: buildSandboxInstallScript(runner),
            agentClis: input.installAgentClis ? buildSandboxAgentClisScript() : null,
            launch: buildSandboxLaunchScript({ runner, port: SANDBOX_T3_PORT }),
            serve: buildSandboxServeScript({ port: SANDBOX_T3_PORT }),
            ready: buildSandboxReadyScript({ port: SANDBOX_T3_PORT }),
            pair: buildSandboxPairingScript({
              runner,
              ttlMinutes: SANDBOX_PAIRING_TOKEN_TTL_MINUTES,
            }),
          };
        },
        catch: (cause) =>
          new SandboxEnvironmentError({
            stage: "install",
            ref: input.ref,
            detail: `"${input.t3Version}" is not an exact t3 release version.`,
            cause,
          }),
      });

    // Every exec goes through here: the provider enforces `timeoutMs`, and the
    // manager stops waiting a little after it in case the provider does not.
    const execScript = (
      provider: SandboxProviderShape,
      ref: SandboxRef,
      input: SandboxExecInput,
    ): Effect.Effect<SandboxExecResult, SandboxProviderError> =>
      provider.exec(ref, input).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(input.timeoutMs + EXEC_GRACE_MS),
          orElse: () => Effect.fail(managerTimeout(provider.id, "exec")),
        }),
      );

    const ensureRunning = Effect.fn("sandbox-core/SandboxEnvironmentManager.ensureRunning")(
      function* (input: {
        readonly provider: SandboxProviderShape;
        readonly info: SandboxInfo;
        readonly stage: "create" | "resume";
      }): Effect.fn.Return<SandboxInfo, SandboxEnvironmentError> {
        const { provider, stage } = input;
        const ref = input.info.ref;
        const startedAt = yield* Clock.currentTimeMillis;
        let info = input.info;
        let resumed = false;
        while (true) {
          switch (info.status) {
            case "running":
              return info;
            case "error":
              return yield* new SandboxEnvironmentError({
                stage,
                ref,
                detail: `${PROVIDER_NAMES[ref.providerId]} reports the sandbox in an error state.`,
              });
            case "destroyed":
              return yield* new SandboxEnvironmentError({
                stage,
                ref,
                failure: "not-found",
                detail: `${PROVIDER_NAMES[ref.providerId]} reports the sandbox as deleted.`,
              });
            case "stopped":
              if (!resumed) {
                resumed = true;
                yield* Effect.logInfo("sandbox.environment.resume", refLogFields(ref));
                info = yield* provider
                  .resume(ref)
                  .pipe(Effect.mapError(fromProviderError("resume", ref)));
                continue;
              }
              break;
            case "creating":
            case "stopping":
              break;
          }
          const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
          if (elapsed + timing.statusPollIntervalMs > timing.runningTimeoutMs) {
            return yield* new SandboxEnvironmentError({
              stage,
              ref,
              failure: "timeout",
              detail: `The sandbox was still ${info.status} after ${formatBudget(timing.runningTimeoutMs)}.`,
            });
          }
          yield* Effect.sleep(Duration.millis(timing.statusPollIntervalMs));
          info = yield* provider.get(ref).pipe(Effect.mapError(fromProviderError(stage, ref)));
        }
      },
    );

    const runScript = Effect.fn("sandbox-core/SandboxEnvironmentManager.runScript")(
      function* (input: {
        readonly provider: SandboxProviderShape;
        readonly ref: SandboxRef;
        readonly stage: ScriptStage;
        /** "Installing t3 1.2.3 in the sandbox": the subject of the failure sentence. */
        readonly summary: string;
        readonly script: string;
        readonly timeoutMs: number;
      }): Effect.fn.Return<SandboxExecResult, SandboxEnvironmentError> {
        const { ref, stage } = input;
        const result = yield* execScript(input.provider, ref, {
          script: input.script,
          timeoutMs: input.timeoutMs,
        }).pipe(
          Effect.mapError((error) =>
            error.operation === "exec" && error.failure === "timeout"
              ? new SandboxEnvironmentError({
                  stage,
                  ref,
                  failure: "timeout",
                  detail: `${input.summary} did not finish within ${formatBudget(input.timeoutMs)}.`,
                  cause: error,
                })
              : fromProviderError(stage, ref)(error),
          ),
        );
        if (result.exitCode === 0) {
          return result;
        }
        const diagnostic = classifyScriptStderr(result.stderr);
        yield* Effect.logWarning("sandbox.environment.script.failed", {
          ...refLogFields(ref),
          stage,
          exitCode: result.exitCode,
          diagnostic: diagnostic ?? null,
        });
        return yield* new SandboxEnvironmentError({
          stage,
          ref,
          detail: `${input.summary} failed (exit ${result.exitCode})${
            diagnostic === undefined ? "." : `: ${diagnostic}.`
          }`,
        });
      },
    );

    // Best effort by contract: a missing agent CLI must not fail the bootstrap,
    // so every failure here, including the exec itself, only logs.
    const installAgentClis = Effect.fn("sandbox-core/SandboxEnvironmentManager.installAgentClis")(
      function* (input: {
        readonly provider: SandboxProviderShape;
        readonly ref: SandboxRef;
        readonly script: string;
      }) {
        const exit = yield* Effect.exit(
          execScript(input.provider, input.ref, {
            script: input.script,
            timeoutMs: timing.agentClisTimeoutMs,
          }),
        );
        if (Exit.isFailure(exit)) {
          const failure = Option.getOrUndefined(Exit.findErrorOption(exit));
          yield* Effect.logWarning("sandbox.environment.agentClis.failed", {
            ...refLogFields(input.ref),
            failure: failure?.failure ?? "defect",
          });
          return;
        }
        const status = yield* decodeScriptJson(exit.value.stdout, decodeAgentClisOutput);
        const report = Option.getOrUndefined(status);
        if (exit.value.exitCode !== 0 || report?.npm === false || (report?.failed ?? "") !== "") {
          yield* Effect.logWarning("sandbox.environment.agentClis.incomplete", {
            ...refLogFields(input.ref),
            exitCode: exit.value.exitCode,
            npmAvailable: report?.npm ?? null,
            failed: report?.failed ?? null,
          });
          return;
        }
        yield* Effect.logInfo("sandbox.environment.agentClis.ready", refLogFields(input.ref));
      },
    );

    const probeOnce = (
      request: HttpClientRequest.HttpClientRequest,
    ): Effect.Effect<ProbeObservation> =>
      httpClient.execute(request).pipe(
        Effect.flatMap((response): Effect.Effect<ProbeObservation> => {
          if (response.status < 200 || response.status >= 300) {
            return response.text.pipe(
              Effect.ignore,
              Effect.as<ProbeObservation>({ _tag: "Status", status: response.status }),
            );
          }
          return response.text.pipe(
            Effect.flatMap(decodeEnvironmentDescriptor),
            Effect.map((body): ProbeObservation => ({
              _tag: "Ready",
              serverVersion: body.serverVersion,
            })),
            Effect.orElseSucceed((): ProbeObservation => ({ _tag: "NotT3" })),
          );
        }),
        // HttpClientError carries the request, whose headers hold the provider's
        // preview token: keep only the fact that it failed.
        Effect.orElseSucceed((): ProbeObservation => ({ _tag: "Unreachable" })),
        Effect.timeoutOption(Duration.millis(timing.probeRequestTimeoutMs)),
        Effect.map(Option.getOrElse((): ProbeObservation => ({ _tag: "RequestTimeout" }))),
      );

    const probeEnvironment = Effect.fn("sandbox-core/SandboxEnvironmentManager.probe")(
      function* (input: {
        readonly ref: SandboxRef;
        readonly endpoint: SandboxEndpoint;
      }): Effect.fn.Return<string, SandboxEnvironmentError> {
        const { ref } = input;
        const request = HttpClientRequest.get(
          `${input.endpoint.httpBaseUrl}/.well-known/t3/environment`,
          { headers: input.endpoint.headers, acceptJson: true },
        );
        const startedAt = yield* Clock.currentTimeMillis;
        let attempts = 0;
        while (true) {
          attempts += 1;
          const observation = yield* probeOnce(request);
          if (observation._tag === "Ready") {
            yield* Effect.logInfo("sandbox.environment.probe.ready", {
              ...refLogFields(ref),
              attempts,
              serverVersion: observation.serverVersion,
            });
            return observation.serverVersion;
          }
          const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
          if (elapsed + timing.probeIntervalMs > timing.probeTimeoutMs) {
            yield* Effect.logWarning("sandbox.environment.probe.timedOut", {
              ...refLogFields(ref),
              attempts,
              last: observation._tag,
              ...(observation._tag === "Status" ? { status: observation.status } : {}),
            });
            const name = PROVIDER_NAMES[ref.providerId];
            const budget = formatBudget(timing.probeTimeoutMs);
            return yield* new SandboxEnvironmentError({
              stage: "probe",
              ref,
              detail: `T3 did not answer through the ${name} preview URL within ${budget}; ${describeLastProbe(observation)}.`,
            });
          }
          yield* Effect.sleep(Duration.millis(timing.probeIntervalMs));
        }
      },
    );

    /**
     * Reuses a running `t3 serve` or starts one: the launch exec decides, a
     * new server starts through `startBackground`, and the ready exec waits for
     * it on loopback. No exec ever leaves the server as its child.
     */
    const launchServer = Effect.fn("sandbox-core/SandboxEnvironmentManager.launchServer")(
      function* (input: {
        readonly provider: SandboxProviderShape;
        readonly ref: SandboxRef;
        readonly scripts: SandboxScripts;
      }): Effect.fn.Return<typeof LaunchOutput.Type, SandboxEnvironmentError> {
        const { provider, ref, scripts } = input;
        const launch = yield* runScript({
          provider,
          ref,
          stage: "launch",
          summary: "Starting the T3 server in the sandbox",
          script: scripts.launch,
          timeoutMs: timing.launchTimeoutMs,
        });
        const plan = Option.getOrUndefined(
          yield* decodeScriptJson(launch.stdout, decodeLaunchOutput),
        );
        if (plan === undefined) {
          return yield* new SandboxEnvironmentError({
            stage: "launch",
            ref,
            detail: "The sandbox returned a launch response T3 could not read.",
          });
        }
        if (plan.reused) {
          return plan;
        }
        if (plan.logPath === undefined || !isSandboxServerLogPath(plan.logPath)) {
          return yield* new SandboxEnvironmentError({
            stage: "launch",
            ref,
            detail: "The sandbox did not say where the T3 server should write its log.",
          });
        }
        yield* provider.startBackground(ref, { script: scripts.serve, logPath: plan.logPath }).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(timing.startServerTimeoutMs),
            orElse: () => Effect.fail(managerTimeout(provider.id, "startBackground")),
          }),
          Effect.mapError(fromProviderError("launch", ref)),
        );
        yield* runScript({
          provider,
          ref,
          stage: "launch",
          summary: "Waiting for the T3 server to start in the sandbox",
          script: scripts.ready,
          timeoutMs: timing.serverReadyTimeoutMs,
        });
        return plan;
      },
    );

    /** Everything after the sandbox exists; shared by provision and reconnect. */
    const bringUp = Effect.fn("sandbox-core/SandboxEnvironmentManager.bringUp")(function* (input: {
      readonly provider: SandboxProviderShape;
      readonly info: SandboxInfo;
      readonly startStage: "create" | "resume";
      readonly scripts: SandboxScripts;
      readonly t3Version: string;
    }): Effect.fn.Return<SandboxEnvironmentBootstrap, SandboxEnvironmentError> {
      const { provider, scripts } = input;
      const ref = input.info.ref;
      yield* ensureRunning({ provider, info: input.info, stage: input.startStage });

      yield* runScript({
        provider,
        ref,
        stage: "install",
        summary: `Installing t3 ${input.t3Version} in the sandbox`,
        script: scripts.install,
        timeoutMs: timing.installTimeoutMs,
      });
      if (scripts.agentClis !== null) {
        yield* installAgentClis({ provider, ref, script: scripts.agentClis });
      }

      const launch = yield* launchServer({ provider, ref, scripts });
      yield* Effect.logInfo("sandbox.environment.launch.ready", {
        ...refLogFields(ref),
        serverKind: launch.serverKind,
        reused: launch.reused,
      });

      const exposed = yield* provider
        .exposePort(ref, SANDBOX_T3_PORT)
        .pipe(Effect.mapError(fromProviderError("expose", ref)));
      const endpoint = resolveEndpoint(exposed);
      if (endpoint === undefined) {
        return yield* new SandboxEnvironmentError({
          stage: "expose",
          ref,
          detail: `${PROVIDER_NAMES[ref.providerId]} returned a preview URL that is not a bare http(s) origin.`,
        });
      }

      const serverVersion = yield* probeEnvironment({ ref, endpoint });
      if (serverVersion !== input.t3Version) {
        // Only a server the launch script did not start (an "external" one) can
        // differ; the client's protocol negotiation decides whether it is usable.
        yield* Effect.logWarning("sandbox.environment.serverVersionMismatch", {
          ...refLogFields(ref),
          expected: input.t3Version,
          actual: serverVersion,
        });
      }

      const pairing = yield* runScript({
        provider,
        ref,
        stage: "pair",
        summary: "Creating a pairing token in the sandbox",
        script: scripts.pair,
        timeoutMs: timing.pairTimeoutMs,
      });
      // The output holds the credential, so neither it nor the decode error
      // (which quotes its input) goes anywhere.
      const credential = Option.getOrUndefined(
        yield* decodeScriptJson(pairing.stdout, decodePairingOutput),
      )?.credential.trim();
      if (credential === undefined || credential.length === 0) {
        return yield* new SandboxEnvironmentError({
          stage: "pair",
          ref,
          detail: "The sandbox returned a pairing response T3 could not read.",
        });
      }

      return {
        ref,
        httpBaseUrl: endpoint.httpBaseUrl,
        wsBaseUrl: endpoint.wsBaseUrl,
        pairingToken: credential,
        requestHeaders: endpoint.headers,
      };
    });

    // `detail` is secret-free by construction; `cause` is left out of logs.
    const logFailure =
      (event: string) =>
      <A, R>(
        self: Effect.Effect<A, SandboxEnvironmentError, R>,
      ): Effect.Effect<A, SandboxEnvironmentError, R> =>
        self.pipe(
          Effect.tapError((error) =>
            Effect.logWarning(event, {
              ...(error.ref === undefined ? {} : refLogFields(error.ref)),
              stage: error.stage,
              failure: error.failure ?? null,
              detail: error.detail,
            }),
          ),
        );

    const provision = Effect.fn("sandbox-core/SandboxEnvironmentManager.provision")(function* (
      input: ProvisionInput,
    ): Effect.fn.Return<SandboxEnvironmentBootstrap, SandboxEnvironmentError> {
      const { provider, target } = input;
      yield* Effect.logInfo("sandbox.environment.provision.start", {
        providerId: provider.id,
        size: target.size,
        region: target.region ?? null,
        t3Version: target.t3Version,
        installAgentClis: target.installAgentClis,
      });
      const scripts = yield* buildScripts({
        t3Version: target.t3Version,
        installAgentClis: target.installAgentClis,
      });
      const bootstrap = yield* locks
        .withLock(
          `provision:${provider.id}:${input.idempotencyKey}`,
          Effect.gen(function* () {
            const info = yield* provider
              .create({
                label: target.label,
                env: input.env,
                size: target.size,
                ...(target.region === undefined ? {} : { region: target.region }),
                idleTimeoutMinutes: target.idleTimeoutMinutes,
                idempotencyKey: input.idempotencyKey,
                ...(target.snapshot === undefined ? {} : { snapshot: target.snapshot }),
              })
              .pipe(Effect.mapError(fromProviderError("create", undefined)));
            yield* Effect.logInfo("sandbox.environment.created", {
              ...refLogFields(info.ref),
              status: info.status,
            });
            return yield* locks.withLock(
              refKey(info.ref),
              bringUp({
                provider,
                info,
                startStage: "create",
                scripts,
                t3Version: target.t3Version,
              }),
            );
          }),
        )
        .pipe(logFailure("sandbox.environment.provision.failed"));
      yield* Effect.logInfo("sandbox.environment.provision.succeeded", refLogFields(bootstrap.ref));
      return bootstrap;
    });

    const reconnect = Effect.fn("sandbox-core/SandboxEnvironmentManager.reconnect")(function* (
      input: ReconnectInput,
    ): Effect.fn.Return<
      SandboxEnvironmentBootstrap,
      SandboxEnvironmentError | SandboxStoppedError
    > {
      const { provider, ref } = input;
      yield* Effect.logInfo("sandbox.environment.reconnect.start", {
        ...refLogFields(ref),
        t3Version: input.t3Version,
      });
      const scripts = yield* buildScripts({
        t3Version: input.t3Version,
        installAgentClis: false,
        ref,
      });
      const bootstrap = yield* locks
        .withLock(
          refKey(ref),
          Effect.gen(function* () {
            const info = yield* provider
              .get(ref)
              .pipe(Effect.mapError(fromProviderError("resume", ref)));
            if (!input.resume && (info.status === "stopped" || info.status === "stopping")) {
              return Option.none<SandboxEnvironmentBootstrap>();
            }
            return Option.some(
              yield* bringUp({
                provider,
                info,
                startStage: "resume",
                scripts,
                t3Version: input.t3Version,
              }),
            );
          }),
        )
        .pipe(logFailure("sandbox.environment.reconnect.failed"));
      if (Option.isNone(bootstrap)) {
        return yield* new SandboxStoppedError({ ref });
      }
      yield* Effect.logInfo("sandbox.environment.reconnect.succeeded", refLogFields(ref));
      return bootstrap.value;
    });

    const stop = Effect.fn("sandbox-core/SandboxEnvironmentManager.stop")(function* (
      input: SandboxTargetInput,
    ): Effect.fn.Return<void, SandboxEnvironmentError> {
      const { provider, ref } = input;
      yield* locks
        .withLock(
          refKey(ref),
          Effect.gen(function* () {
            const info = yield* provider
              .get(ref)
              .pipe(Effect.mapError(fromProviderError("stop", ref)));
            if (info.status === "stopped" || info.status === "destroyed") {
              yield* Effect.logInfo("sandbox.environment.stop.alreadyStopped", {
                ...refLogFields(ref),
                status: info.status,
              });
              return;
            }
            if (info.status === "running") {
              // Let `t3 serve` shut down cleanly (and flush its database) before the
              // machine stops under it. The provider stop below is what matters, so
              // a failure here only logs.
              const exit = yield* Effect.exit(
                execScript(provider, ref, {
                  script: buildSandboxStopScript(),
                  timeoutMs: timing.stopServerTimeoutMs,
                }),
              );
              if (Exit.isFailure(exit) || exit.value.exitCode !== 0) {
                yield* Effect.logWarning("sandbox.environment.stop.serverStopFailed", {
                  ...refLogFields(ref),
                  exitCode: Exit.isSuccess(exit) ? exit.value.exitCode : null,
                  failure: Exit.isFailure(exit)
                    ? (Option.getOrUndefined(Exit.findErrorOption(exit))?.failure ?? "defect")
                    : null,
                });
              }
            }
            yield* provider.stop(ref).pipe(Effect.mapError(fromProviderError("stop", ref)));
            yield* Effect.logInfo("sandbox.environment.stop.succeeded", refLogFields(ref));
          }),
        )
        .pipe(logFailure("sandbox.environment.stop.failed"));
    });

    const destroy = Effect.fn("sandbox-core/SandboxEnvironmentManager.destroy")(function* (
      input: SandboxTargetInput,
    ): Effect.fn.Return<void, SandboxEnvironmentError> {
      const { provider, ref } = input;
      yield* locks
        .withLock(
          refKey(ref),
          provider.destroy(ref).pipe(
            // Already gone is the state destroy asks for.
            Effect.catch((error) =>
              error.failure === "not-found"
                ? Effect.logInfo("sandbox.environment.destroy.alreadyGone", refLogFields(ref))
                : Effect.fail(fromProviderError("destroy", ref)(error)),
            ),
          ),
        )
        .pipe(logFailure("sandbox.environment.destroy.failed"));
      yield* Effect.logInfo("sandbox.environment.destroy.succeeded", refLogFields(ref));
    });

    return SandboxEnvironmentManager.of({ provision, reconnect, stop, destroy });
  },
);

export class SandboxEnvironmentManager extends Context.Service<
  SandboxEnvironmentManager,
  SandboxEnvironmentManagerShape
>()("@t3tools/sandbox-core/SandboxEnvironmentManager") {
  static readonly layer = (options: SandboxEnvironmentManagerOptions = {}) =>
    Layer.effect(SandboxEnvironmentManager, makeSandboxEnvironmentManager(options));
}
