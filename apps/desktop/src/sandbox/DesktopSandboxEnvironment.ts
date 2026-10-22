import {
  DesktopSandboxEnvironmentDoneType,
  DesktopSandboxEnvironmentFailedType,
  DesktopSandboxEnvironmentStoppedType,
  type DesktopSandboxEnvironmentActionResult,
  type DesktopSandboxEnvironmentEnsureInput,
  type DesktopSandboxEnvironmentEnsureResult,
  type DesktopSandboxEnvironmentFailure,
  type DesktopSandboxEnvironmentReconnectInput,
  type DesktopSandboxEnvironmentReconnectResult,
  type DesktopSandboxEnvironmentStage,
  type DesktopSandboxEnvironmentTarget,
  type DesktopSandboxProviderId,
  type DesktopSandboxRef,
} from "@t3tools/contracts";
import {
  SandboxEnvironmentError,
  SandboxEnvironmentManager,
  SandboxProviderError,
  type SandboxEnvironmentBootstrap,
  type SandboxProviderShape,
} from "@t3tools/sandbox-core";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopSandboxCredentials from "./DesktopSandboxCredentials.ts";
import * as DesktopSandboxForwards from "./DesktopSandboxForwards.ts";
import {
  DESKTOP_SANDBOX_PROVIDER_FACTORIES,
  sandboxProviderName,
  type DesktopSandboxProviderFactory,
} from "./DesktopSandboxProviders.ts";

/**
 * Runs cloud sandbox environments for the renderer. Every result is a value:
 * a failure carries its stage and provider failure kind across IPC, and
 * nothing here ever returns a provider credential or the GitHub token.
 */
export class DesktopSandboxEnvironment extends Context.Service<
  DesktopSandboxEnvironment,
  {
    readonly ensure: (
      input: DesktopSandboxEnvironmentEnsureInput,
    ) => Effect.Effect<DesktopSandboxEnvironmentEnsureResult>;
    readonly reconnect: (
      input: DesktopSandboxEnvironmentReconnectInput,
    ) => Effect.Effect<DesktopSandboxEnvironmentReconnectResult>;
    readonly stop: (
      sandbox: DesktopSandboxRef,
    ) => Effect.Effect<DesktopSandboxEnvironmentActionResult>;
    readonly destroy: (
      sandbox: DesktopSandboxRef,
    ) => Effect.Effect<DesktopSandboxEnvironmentActionResult>;
  }
>()("@t3tools/desktop/sandbox/DesktopSandboxEnvironment") {}

/** An operation that ended in a failure result; caught where results leave this module. */
class SandboxOperationFailed extends Data.TaggedError("SandboxOperationFailed")<{
  readonly result: DesktopSandboxEnvironmentFailure;
}> {}

function failed(
  stage: DesktopSandboxEnvironmentStage,
  detail: string,
  extra: Pick<DesktopSandboxEnvironmentFailure, "failure" | "sandbox"> = {},
): SandboxOperationFailed {
  return new SandboxOperationFailed({
    result: {
      type: DesktopSandboxEnvironmentFailedType,
      stage,
      detail,
      ...(extra.failure === undefined ? {} : { failure: extra.failure }),
      ...(extra.sandbox === undefined ? {} : { sandbox: extra.sandbox }),
    },
  });
}

const isSandboxEnvironmentError = Schema.is(SandboxEnvironmentError);
/** Retries of one add that each found the sandbox before them deleted. */
const MAX_REPLACED_SANDBOXES = 3;
type GoneSandboxError = SandboxEnvironmentError & {
  readonly ref: NonNullable<SandboxEnvironmentError["ref"]>;
};

/**
 * A sentence for a provider call made here rather than through the manager
 * (the status check before an automatic reconnect). Built from labels only,
 * like the manager's: the provider error's own text is for logs.
 */
function providerFailureDetail(error: SandboxProviderError): string {
  const name = sandboxProviderName(error.providerId);
  switch (error.failure) {
    case "unauthorized":
      return `${name} rejected the saved API key. Enter a new one in Settings, Connections.`;
    case "not-found":
      return `${name} no longer has this sandbox; it was deleted.`;
    case "quota-exceeded":
      return `${name} refused the request because the account is over its quota.`;
    case "timeout":
      return `${name} did not answer in time.`;
    case "unsupported":
      return `${name} does not support this request.`;
    case "network":
      return `Could not reach ${name}.`;
    case "provider-error":
      return `${name} could not look up the sandbox.`;
  }
}

/** Both error types carry only secret-free text; their `cause` is never copied. */
function toOperationFailed(
  stage: DesktopSandboxEnvironmentStage,
  sandbox: DesktopSandboxRef | undefined,
) {
  return (error: SandboxEnvironmentError | SandboxProviderError): SandboxOperationFailed => {
    if (isSandboxEnvironmentError(error)) {
      const ref = error.ref ?? sandbox;
      return failed(error.stage, error.detail, {
        ...(error.failure === undefined ? {} : { failure: error.failure }),
        ...(ref === undefined ? {} : { sandbox: ref }),
      });
    }
    return failed(stage, providerFailureDetail(error), {
      failure: error.failure,
      ...(sandbox === undefined ? {} : { sandbox }),
    });
  };
}

/** The GitHub token the user chose to forward could not be read; nothing was created. */
export class DesktopGitHubTokenUnavailableError extends Schema.TaggedError<DesktopGitHubTokenUnavailableError>()(
  "DesktopGitHubTokenUnavailableError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export type DesktopGitHubTokenReader = Effect.Effect<
  Redacted.Redacted<string>,
  DesktopGitHubTokenUnavailableError,
  ChildProcessSpawner.ChildProcessSpawner
>;

const GITHUB_TOKEN_UNAVAILABLE =
  "Forwarding the GitHub token needs the GitHub CLI signed in on this computer. Run `gh auth login`, or turn forwarding off.";

/** This machine's `gh` token for github.com, read only when the user chose to forward it. */
const readGitHubCliToken: DesktopGitHubTokenReader = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("gh", ["auth", "token", "--hostname", "github.com"], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          // Never let gh print the token into a debug log or wait on a prompt.
          env: { GH_DEBUG: "", GH_PROMPT_DISABLED: "1" },
          extendEnv: true,
        }),
      );
      return yield* Effect.all([Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode], {
        concurrency: 2,
      });
    }),
  ).pipe(
    Effect.timeoutOption("10 seconds"),
    Effect.mapError(
      (error) =>
        new DesktopGitHubTokenUnavailableError({
          detail:
            error instanceof PlatformError.PlatformError && error.reason._tag === "NotFound"
              ? "Forwarding the GitHub token needs the GitHub CLI (gh), which T3 Code could not find. Install it, or turn forwarding off."
              : GITHUB_TOKEN_UNAVAILABLE,
        }),
    ),
  );
  const token = Option.isSome(output) && output.value[1] === 0 ? output.value[0].trim() : "";
  if (token === "") {
    return yield* new DesktopGitHubTokenUnavailableError({ detail: GITHUB_TOKEN_UNAVAILABLE });
  }
  return Redacted.make(token);
}).pipe(Effect.withSpan("desktop.sandbox.readGitHubCliToken"));

export interface DesktopSandboxEnvironmentOptions {
  /** Defaults to every provider this build ships. */
  readonly factories?: Readonly<
    Partial<Record<DesktopSandboxProviderId, DesktopSandboxProviderFactory>>
  >;
  /** Defaults to `gh auth token --hostname github.com`. */
  readonly readGitHubToken?: DesktopGitHubTokenReader;
}

/** A provider status that a reconnect may only leave alone without the user's say-so. */
const STOPPED_STATUSES = new Set(["stopped", "stopping"]);

/** Where a crash is reported, so the renderer retries it like any failure at that stage. */
const OPERATION_STAGES = {
  ensure: "create",
  reconnect: "resume",
  stop: "stop",
  destroy: "destroy",
} as const satisfies Record<string, DesktopSandboxEnvironmentStage>;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("desktop.sandbox.makeEnvironment")(function* (
  options: DesktopSandboxEnvironmentOptions = {},
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const credentials = yield* DesktopSandboxCredentials.DesktopSandboxCredentials;
  const manager = yield* SandboxEnvironmentManager;
  const forwards = yield* DesktopSandboxForwards.DesktopSandboxForwards;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const factories = options.factories ?? DESKTOP_SANDBOX_PROVIDER_FACTORIES;
  const readGitHubToken = (options.readGitHubToken ?? readGitHubCliToken).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  // The sandbox runs the same release as this app, so client and server agree.
  const t3Version = environment.appVersion;

  /** Builds the provider from its stored credential for one operation. */
  const withProvider = <A>(
    providerId: DesktopSandboxProviderId,
    use: (provider: SandboxProviderShape) => Effect.Effect<A, SandboxOperationFailed>,
  ): Effect.Effect<A, SandboxOperationFailed> =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = sandboxProviderName(providerId);
        const factory = factories[providerId];
        if (factory === undefined) {
          return yield* failed(
            "credentials",
            `${name} sandboxes are not available in this build.`,
            {
              failure: "unsupported",
            },
          );
        }
        const credential = yield* credentials.get(providerId).pipe(
          Effect.mapError((error) => failed("credentials", error.message)),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  failed(
                    "credentials",
                    `Add a ${name} API key in Settings, Connections, before using ${name} sandboxes.`,
                    { failure: "unauthorized" },
                  ),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
        const provider = yield* factory(credential).pipe(
          Effect.mapError((error) => failed("credentials", error.detail)),
        );
        return yield* use(provider);
      }),
    );

  const finish = <A>(
    operation: keyof typeof OPERATION_STAGES,
    sandbox: DesktopSandboxRef | undefined,
    effect: Effect.Effect<A, SandboxOperationFailed>,
  ): Effect.Effect<A | DesktopSandboxEnvironmentFailure> =>
    effect.pipe(
      Effect.catchTags({
        SandboxOperationFailed: (error) =>
          Effect.logWarning("Cloud sandbox operation failed.", {
            operation,
            stage: error.result.stage,
            failure: error.result.failure,
            providerId: error.result.sandbox?.providerId,
          }).pipe(Effect.as(error.result)),
      }),
      Effect.catchDefect((defect) =>
        Effect.logError("Cloud sandbox operation crashed.", { operation, defect }).pipe(
          Effect.as<DesktopSandboxEnvironmentFailure>({
            type: DesktopSandboxEnvironmentFailedType,
            stage: OPERATION_STAGES[operation],
            failure: "provider-error",
            detail: "The cloud sandbox operation failed unexpectedly. See the desktop log.",
            ...(sandbox === undefined ? {} : { sandbox }),
          }),
        ),
      ),
      Effect.withSpan(`desktop.sandbox.${operation}`),
    );

  /** The renderer reaches the server only through the sandbox's loopback forward. */
  const toBootstrap = (
    target: DesktopSandboxEnvironmentTarget,
    bootstrap: SandboxEnvironmentBootstrap,
  ) =>
    forwards
      .open(bootstrap.ref, {
        httpBaseUrl: bootstrap.httpBaseUrl,
        headers: bootstrap.requestHeaders,
      })
      .pipe(
        Effect.mapError((error) => failed("expose", error.message, { sandbox: bootstrap.ref })),
        Effect.map((local) => ({
          target,
          sandbox: bootstrap.ref,
          httpBaseUrl: local.httpBaseUrl,
          wsBaseUrl: local.wsBaseUrl,
          providerUrl: bootstrap.httpBaseUrl,
          pairingToken: bootstrap.pairingToken,
        })),
      );

  const ensure = (input: DesktopSandboxEnvironmentEnsureInput) =>
    finish(
      "ensure",
      undefined,
      withProvider(input.target.providerId, (provider) =>
        Effect.gen(function* () {
          // Read before anything is created, so a missing login cannot leave
          // a billable sandbox behind.
          const env: Record<string, string> = input.target.forwardGithubToken
            ? {
                GH_TOKEN: Redacted.value(
                  yield* readGitHubToken.pipe(
                    Effect.mapError((error) => failed("credentials", error.detail)),
                  ),
                ),
              }
            : {};
          const label = input.target.label.trim() || "T3 Code";
          const provision = (
            idempotencyKey: string,
            replaced: number,
          ): Effect.Effect<
            SandboxEnvironmentBootstrap,
            SandboxEnvironmentError | SandboxProviderError
          > =>
            manager
              .provision({
                provider,
                target: {
                  label,
                  size: input.target.size,
                  ...(input.target.region === undefined || input.target.region.trim() === ""
                    ? {}
                    : { region: input.target.region.trim() }),
                  idleTimeoutMinutes: input.target.idleTimeoutMinutes,
                  t3Version,
                  installAgentClis: input.target.installAgentClis,
                },
                env,
                idempotencyKey,
              })
              .pipe(
                // A provider can hand back a deleted sandbox for a reused key
                // (Docker does), which would fail every retry of the add. A
                // replacement's key names the sandbox it replaces, so later
                // retries of the same add still adopt the replacement.
                Effect.catchIf(
                  (error): error is GoneSandboxError =>
                    replaced < MAX_REPLACED_SANDBOXES &&
                    isSandboxEnvironmentError(error) &&
                    error.failure === "not-found" &&
                    error.ref !== undefined,
                  (error) =>
                    provision(`${idempotencyKey}:replaces=${error.ref.sandboxId}`, replaced + 1),
                ),
              );
          // A provider hands back the sandbox an earlier attempt made under a
          // key, env included. Folding the token choice in means no caller
          // that reuses a key across a forwarding change adopts a sandbox
          // holding GH_TOKEN; the form already mints a new key for one.
          const bootstrap = yield* provision(
            `${input.idempotencyKey}:github-token=${
              input.target.forwardGithubToken ? "forwarded" : "none"
            }`,
            0,
          ).pipe(Effect.mapError(toOperationFailed("create", undefined)));
          return yield* toBootstrap(input.target, bootstrap);
        }),
      ),
    );

  const reconnect = (input: DesktopSandboxEnvironmentReconnectInput) =>
    finish(
      "reconnect",
      input.sandbox,
      withProvider(input.sandbox.providerId, (provider) =>
        Effect.gen(function* () {
          if (!input.resume) {
            const info = yield* provider
              .get(input.sandbox)
              .pipe(Effect.mapError(toOperationFailed("resume", input.sandbox)));
            if (STOPPED_STATUSES.has(info.status)) {
              return { type: DesktopSandboxEnvironmentStoppedType, sandbox: input.sandbox };
            }
            if (info.status === "destroyed") {
              return yield* failed(
                "resume",
                `${sandboxProviderName(input.sandbox.providerId)} no longer has this sandbox; it was deleted.`,
                { failure: "not-found", sandbox: input.sandbox },
              );
            }
          }
          // The manager checks again under the lock a stop takes, in case the
          // user stops the sandbox while this reconnect waits for it.
          const bootstrap = yield* manager
            .reconnect({ provider, ref: input.sandbox, t3Version, resume: input.resume })
            .pipe(
              Effect.map(Option.some),
              Effect.catchTags({
                SandboxStoppedError: () =>
                  Effect.succeed(Option.none<SandboxEnvironmentBootstrap>()),
              }),
              Effect.mapError(toOperationFailed("resume", input.sandbox)),
            );
          if (Option.isNone(bootstrap)) {
            return { type: DesktopSandboxEnvironmentStoppedType, sandbox: input.sandbox };
          }
          return yield* toBootstrap(input.target, bootstrap.value);
        }).pipe(
          // A forward to a deleted sandbox would serve nothing until the app quits.
          Effect.tapError((error) =>
            error.result.failure === "not-found" ? forwards.close(input.sandbox) : Effect.void,
          ),
        ),
      ),
    );

  const stop = (sandbox: DesktopSandboxRef) =>
    finish(
      "stop",
      sandbox,
      withProvider(sandbox.providerId, (provider) =>
        manager
          .stop({ provider, ref: sandbox })
          .pipe(
            Effect.mapError(toOperationFailed("stop", sandbox)),
            Effect.andThen(forwards.close(sandbox)),
            Effect.as({ type: DesktopSandboxEnvironmentDoneType }),
          ),
      ),
    );

  const destroy = (sandbox: DesktopSandboxRef) =>
    finish(
      "destroy",
      sandbox,
      withProvider(sandbox.providerId, (provider) =>
        manager.destroy({ provider, ref: sandbox }).pipe(
          Effect.mapError(toOperationFailed("destroy", sandbox)),
          Effect.tap(() => forwards.close(sandbox)),
          // A sandbox the provider no longer has is gone either way.
          Effect.tapError((error) =>
            error.result.failure === "not-found" ? forwards.close(sandbox) : Effect.void,
          ),
          Effect.as({ type: DesktopSandboxEnvironmentDoneType }),
        ),
      ),
    );

  return DesktopSandboxEnvironment.of({ ensure, reconnect, stop, destroy });
});

/** Needs an `HttpClient` for the manager's probes through the provider's proxy. */
export const layer = (options: DesktopSandboxEnvironmentOptions = {}) =>
  Layer.effect(DesktopSandboxEnvironment, make(options)).pipe(
    Layer.provide(Layer.mergeAll(SandboxEnvironmentManager.layer(), DesktopSandboxForwards.layer)),
  );
