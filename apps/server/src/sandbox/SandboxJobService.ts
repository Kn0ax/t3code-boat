/**
 * Sandbox jobs: ephemeral nodes that hold one job and its disk until an
 * agent or the user says the job is done.
 *
 * A node is a cloud sandbox running its own `t3 serve`. This server creates
 * it with the provider key it holds, copies the caller's workspace in (with
 * uncommitted work), signs in to the node's own MCP endpoint, and drives the
 * node's threads with the ordinary orchestrator tools. Runs end; the node
 * does not. When no run is active it is stopped after the idle window and
 * resumed on the next run. Completing the job brings the work back under
 * `refs/t3/sandbox/<jobId>` in the local repository, then destroys the node.
 *
 * @module SandboxJobService
 */
import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  MessageId,
  OrchestratorMcpFailure,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitResult,
  ProjectId,
  ProviderDriverKind,
  RunId,
  SandboxJobId,
  ThreadId,
  isSandboxJobFinished,
  type OrchestratorMcpThreadReadInput,
  type SandboxJob,
  type SandboxJobAgent,
  type SandboxJobCompleteInput,
  SandboxJobProviderId,
  type SandboxJobReadInput,
  type SandboxJobSendInput,
  type SandboxJobSettings,
  type SandboxJobStartInput,
} from "@t3tools/contracts";
import {
  SandboxEnvironmentManager,
  sandboxAgentEnvironment,
  sandboxModelProxyActive,
  type SandboxEnvironmentBootstrap,
  type SandboxProviderShape,
  type SandboxRef,
} from "@t3tools/sandbox-core";
import {
  SANDBOX_IMPORT_EXIT_CODES,
  buildSandboxCollectScript,
  buildSandboxImportScript,
  importCollectedBundle,
  runGit,
  snapshotWorkspace,
} from "@t3tools/sandbox-handoff";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { compareExactServiceVersions } from "../cloud/serviceProtocol.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../serverSettings.ts";
import * as SandboxJobStore from "./SandboxJobStore.ts";
import * as SandboxNodeMcp from "./SandboxNodeMcp.ts";

/** Who started a job: an agent's thread (whose workspace the node copies) or an outside client. */
export interface SandboxJobCaller {
  readonly parentThreadId: ThreadId | null;
  /** The checkout the node starts from and its work comes back to. */
  readonly workspaceRoot: string;
  /** Namespaced idempotency key, when the caller passed one. */
  readonly requestKey: string | null;
}

export interface SandboxJobResult {
  readonly job: SandboxJob;
  readonly waitTimedOut: boolean;
}

/** Builds a provider for one operation. Tests replace the key-backed default. */
export type SandboxJobProviderResolver = (
  providerId: SandboxJobProviderId,
) => Effect.Effect<SandboxProviderShape, OrchestratorMcpFailure, Scope.Scope>;

export class SandboxJobService extends Context.Service<
  SandboxJobService,
  {
    readonly start: (
      input: SandboxJobStartInput,
      caller: SandboxJobCaller,
    ) => Effect.Effect<SandboxJobResult, OrchestratorMcpFailure>;
    readonly status: (input: {
      readonly jobId: SandboxJobId;
      readonly wait?: boolean | undefined;
      readonly timeoutMs?: number | undefined;
    }) => Effect.Effect<SandboxJobResult, OrchestratorMcpFailure>;
    readonly send: (
      input: SandboxJobSendInput,
    ) => Effect.Effect<SandboxJobResult, OrchestratorMcpFailure>;
    readonly cancel: (jobId: SandboxJobId) => Effect.Effect<SandboxJob, OrchestratorMcpFailure>;
    readonly complete: (
      input: SandboxJobCompleteInput,
    ) => Effect.Effect<SandboxJob, OrchestratorMcpFailure>;
    readonly discard: (jobId: SandboxJobId) => Effect.Effect<SandboxJob, OrchestratorMcpFailure>;
    readonly list: (input: {
      readonly includeFinished: boolean;
    }) => Effect.Effect<ReadonlyArray<SandboxJob>, OrchestratorMcpFailure>;
    readonly read: (
      input: SandboxJobReadInput,
    ) => Effect.Effect<typeof OrchestratorMcpThreadReadResult.Type, OrchestratorMcpFailure>;
    /** Stops idle nodes and ends expired jobs. Runs every minute; tests call it directly. */
    readonly runMaintenance: Effect.Effect<void>;
  }
>()("t3/sandbox/SandboxJobService") {}

const fail = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });
const notFound = (jobId: SandboxJobId) => fail("sandbox_job_not_found", `No sandbox job ${jobId}.`);
const storeFailure = () => fail("orchestration_error", "The sandbox job store could not be read.");

const DEFAULT_WAIT_MS = 10 * 60_000;
/** One `t3_thread_wait` on the node; the watcher loops until the run ends. */
const NODE_WAIT_SLICE_MS = 5 * 60_000;
const SUMMARY_MAX_CHARS = 8_000;
const PARENT_SUMMARY_MAX_CHARS = 4_000;
const NODE_STATE_DIR = ".t3-job";

/** The agent keys that let a node run each agent. */
const AGENT_KEYS: Readonly<
  Record<SandboxJobAgent, ReadonlyArray<keyof SandboxJobSettings["agentKeys"]>>
> = {
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex: ["OPENAI_API_KEY"],
};

const ThreadLaunchResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  runId: Schema.NullOr(RunId),
});
const ProjectCreateResult = Schema.Struct({ id: ProjectId });
/** The collect script's last line. */
const decodeCollectReport = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ head: Schema.String, changed: Schema.Boolean })),
);

const tokenSecretName = (jobId: SandboxJobId) => `sandbox-job-${jobId}`;
const resultRefFor = (jobId: SandboxJobId) => `refs/t3/sandbox/${jobId}`;
const nodeBranchFor = (jobId: SandboxJobId) => `t3/sandbox/${jobId}`;

const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`;

/** A directory name for the workspace inside the node, from the local checkout's name. */
const nodeDirectoryName = (workspaceRoot: string) => {
  const base = workspaceRoot.split("/").findLast((part) => part !== "") ?? "workspace";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "");
  return safe === "" ? "workspace" : safe.slice(0, 64);
};

/** The node's built-in provider instance for each agent; its id is also its driver kind. */
const AGENT_INSTANCES: Readonly<Record<SandboxJobAgent, string>> = {
  claude: "claudeAgent",
  codex: "codex",
};

const modelSelectionFor = (agent: SandboxJobAgent, model: string | undefined | null) => ({
  instanceId: AGENT_INSTANCES[agent],
  model:
    model ??
    DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make(AGENT_INSTANCES[agent])] ??
    "default",
});

/** Fixed wording for a node that could not come up; provider output is never quoted. */
const SAFE_MESSAGE_TAGS: ReadonlySet<unknown> = new Set([
  "SandboxEnvironmentError",
  "SandboxProviderError",
  "SandboxNodeMcpError",
  "SandboxNodeToolError",
  "OrchestratorMcpFailure",
]);
const bringUpFailure = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  SAFE_MESSAGE_TAGS.has(error._tag) &&
  "message" in error &&
  typeof error.message === "string"
    ? error.message
    : "The sandbox node could not be prepared. See the server log.";

interface NodeConnection {
  readonly endpoint: SandboxNodeMcp.SandboxNodeEndpoint;
  readonly token: Redacted.Redacted<string>;
}

/**
 * The oldest release a node may run: the first with the MCP OAuth
 * pairing-code sign-in the job server uses (SandboxNodeMcp). Nodes run it
 * when this server's own version is not one they can install.
 */
export const SANDBOX_NODE_T3_VERSION = "0.0.46-nightly.20261012.3035";

// The shapes the release pipeline publishes: stable, or a channel build.
const PUBLISHED_T3_VERSION = /^\d+\.\d+\.\d+(?:-(?:nightly|preview)\.\d{8}\.\d+)?$/;

/**
 * Nodes and VMs run this server's own release, so a client that pairs with
 * them speaks the protocol of the host it already knows. A version the
 * release pipeline never publishes (a local build, an rc) or one older than
 * `SANDBOX_NODE_T3_VERSION` has no usable archive, so those get the pin.
 */
export const sandboxT3Version = (hostVersion: string): string =>
  PUBLISHED_T3_VERSION.test(hostVersion) &&
  compareExactServiceVersions(hostVersion, SANDBOX_NODE_T3_VERSION) >= 0
    ? hostVersion
    : SANDBOX_NODE_T3_VERSION;

export interface SandboxJobServiceOptions {
  readonly resolveProvider?: SandboxJobProviderResolver;
  /** The t3 release nodes install. Defaults to `sandboxT3Version` of this server. */
  readonly t3Version?: string;
  /** Turns off the background maintenance loop (tests call `runMaintenance`). */
  readonly maintenanceInterval?: Duration.Input | null;
}

export const make = Effect.fn("SandboxJobService.make")(function* (
  options: SandboxJobServiceOptions = {},
) {
  const store = yield* SandboxJobStore.SandboxJobStore;
  const nodeMcp = yield* SandboxNodeMcp.SandboxNodeMcp;
  const manager = yield* SandboxEnvironmentManager;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const settingsService = yield* Settings.ServerSettingsService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const t3Version = options.t3Version ?? sandboxT3Version(packageJson.version);

  const withGit = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
    >,
  ) =>
    effect.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const resolveProvider: SandboxJobProviderResolver =
    options.resolveProvider ??
    ((providerId) =>
      Effect.gen(function* () {
        // The provider SDKs load on first use, so servers without sandbox jobs never pay for them.
        const settings = (yield* settingsService.getSettings.pipe(Effect.mapError(storeFailure)))
          .sandboxJobs;
        const secret = settings.providerKeys[providerId].trim();
        if (secret === "") {
          return yield* fail(
            "sandbox_provider_unavailable",
            "Add a boat API key in Settings, Integrations, Sandbox jobs, before starting a sandbox job.",
          );
        }
        const boat = yield* Effect.promise(() => import("@t3tools/sandbox-boat"));
        return yield* boat.boatSandboxProvider(Redacted.make(secret));
      }));

  /** Runs `use` with the job's provider; its scope closes after. */
  const withProvider = <A, E>(
    providerId: SandboxJobProviderId,
    use: (provider: SandboxProviderShape) => Effect.Effect<A, E>,
  ) => Effect.scoped(Effect.flatMap(resolveProvider(providerId), use));

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  // One lock per job: lifecycle steps on a node never interleave.
  const locks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const withJobLock = <A, E, R>(jobId: SandboxJobId, effect: Effect.Effect<A, E, R>) =>
    SynchronizedRef.modifyEffect(locks, (current) => {
      const existing = current.get(jobId);
      if (existing !== undefined) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => [semaphore, new Map(current).set(jobId, semaphore)] as const),
      );
    }).pipe(Effect.flatMap((semaphore) => semaphore.withPermits(1)(effect)));

  /** Live connections; a node that was stopped or this server restarted reconnects on use. */
  const connections = yield* SynchronizedRef.make(new Map<string, NodeConnection>());
  /** Completed when the job's active run ends. */
  const runSettled = yield* SynchronizedRef.make(new Map<string, Deferred.Deferred<void>>());
  /** Each job's watcher, by a token only that watcher holds. */
  const watching = yield* SynchronizedRef.make(new Map<string, object>());

  const getJob = (jobId: SandboxJobId) =>
    store.get(jobId).pipe(
      Effect.mapError(storeFailure),
      Effect.flatMap((job) =>
        job === undefined ? Effect.fail(notFound(jobId)) : Effect.succeed(job),
      ),
    );
  const update = (jobId: SandboxJobId, patch: SandboxJobStore.SandboxJobRecordPatch) =>
    Effect.flatMap(now, (updatedAt) => store.update(jobId, patch, updatedAt)).pipe(
      Effect.mapError(storeFailure),
    );

  const settledSignal = (jobId: SandboxJobId) =>
    SynchronizedRef.modifyEffect(runSettled, (current) => {
      const existing = current.get(jobId);
      if (existing !== undefined) return Effect.succeed([existing, current] as const);
      return Deferred.make<void>().pipe(
        Effect.map((deferred) => [deferred, new Map(current).set(jobId, deferred)] as const),
      );
    });
  const signalSettled = (jobId: SandboxJobId) =>
    SynchronizedRef.modifyEffect(runSettled, (current) => {
      const existing = current.get(jobId);
      const next = new Map(current);
      next.delete(jobId);
      return (existing === undefined ? Effect.void : Deferred.succeed(existing, undefined)).pipe(
        Effect.as([undefined, next] as const),
      );
    });

  const refOf = (job: SandboxJobStore.SandboxJobRecord): SandboxRef | undefined =>
    job.sandboxId === null ? undefined : { providerId: job.providerId, sandboxId: job.sandboxId };

  const saveToken = (jobId: SandboxJobId, token: Redacted.Redacted<string>) =>
    secrets
      .set(tokenSecretName(jobId), new TextEncoder().encode(Redacted.value(token)))
      .pipe(
        Effect.mapError(() => fail("orchestration_error", "Could not save the node's session.")),
      );

  const connectFrom = Effect.fn("SandboxJobService.connectFrom")(function* (
    jobId: SandboxJobId,
    bootstrap: SandboxEnvironmentBootstrap,
  ) {
    const endpoint = { httpBaseUrl: bootstrap.httpBaseUrl, headers: bootstrap.requestHeaders };
    const token = yield* nodeMcp.signIn(endpoint, bootstrap.pairingToken);
    yield* saveToken(jobId, token);
    const connection: NodeConnection = { endpoint, token };
    yield* SynchronizedRef.update(connections, (current) =>
      new Map(current).set(jobId, connection),
    );
    return connection;
  });

  /**
   * The node's connection, resuming a stopped node first. Every reconnect
   * signs in again with the fresh pairing code it mints, since the node's
   * address can change across a stop.
   */
  const ensureConnected = Effect.fn("SandboxJobService.ensureConnected")(function* (
    job: SandboxJobStore.SandboxJobRecord,
  ) {
    const cached = (yield* SynchronizedRef.get(connections)).get(job.jobId);
    if (cached !== undefined && job.state !== "stopped") return cached;
    const ref = refOf(job);
    if (ref === undefined) {
      return yield* fail("sandbox_job_not_ready", "This sandbox job has no node yet.");
    }
    const bootstrap = yield* withProvider(job.providerId, (provider) =>
      manager.reconnect({ provider, ref, t3Version, resume: true }),
    ).pipe(
      Effect.mapError((error) =>
        error._tag === "OrchestratorMcpFailure"
          ? error
          : fail("sandbox_node_unavailable", bringUpFailure(error)),
      ),
    );
    const connection = yield* connectFrom(job.jobId, bootstrap).pipe(
      Effect.mapError((error) => fail("sandbox_node_unavailable", error.message)),
    );
    if (job.state === "stopped") {
      yield* update(job.jobId, { state: "idle", idleSince: yield* now });
    }
    return connection;
  });

  const callNode = <S extends Schema.Top>(
    connection: NodeConnection,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    result: S,
  ) =>
    nodeMcp
      .call({
        endpoint: connection.endpoint,
        token: connection.token,
        tool,
        arguments: args,
        result,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "SandboxNodeToolError"
            ? fail(
                "sandbox_node_error",
                `On the sandbox node, ${error.tool} failed (${error.code}): ${error.detail}`,
              )
            : fail("sandbox_node_unavailable", error.message),
        ),
      );

  /** The text of the last item of `type` in a node thread's `view`, from `runId` when known. */
  const lastItemText = Effect.fn("SandboxJobService.lastItemText")(function* (
    connection: NodeConnection,
    threadId: ThreadId,
    runId: string | null,
    view: "messages" | "activity",
    type: string,
  ) {
    let afterPosition: number | undefined;
    let text: string | null = null;
    for (let page = 0; page < 50; page++) {
      const read = yield* callNode(
        connection,
        "t3_thread_read",
        {
          threadId,
          view,
          limit: 100,
          maxCharsPerItem: SUMMARY_MAX_CHARS,
          ...(afterPosition === undefined ? {} : { afterPosition }),
        } satisfies OrchestratorMcpThreadReadInput,
        OrchestratorMcpThreadReadResult,
      );
      for (const item of read.items) {
        if (item.type !== type || item.text === null) continue;
        if (runId === null || item.runId === runId) text = item.text;
      }
      if (!read.hasMore || read.nextPosition === null) break;
      afterPosition = read.nextPosition;
    }
    return text;
  });

  /**
   * What a run left for its caller: the latest assistant answer, or for a run
   * that ended without one and did not complete, the error that ended it, so
   * a bad agent key reads differently from a real failure.
   */
  const runSummary = Effect.fn("SandboxJobService.runSummary")(function* (
    connection: NodeConnection,
    threadId: ThreadId,
    runId: string | null,
    status: string,
  ) {
    const answer = yield* lastItemText(
      connection,
      threadId,
      runId,
      "messages",
      "assistant_message",
    );
    if (answer !== null || status === "completed") return answer;
    const error = yield* lastItemText(connection, threadId, runId, "activity", "error");
    return error === null ? null : `The run ${status}: ${error}`;
  });

  /** Tells the parent thread a run on its node ended, once per run. */
  const deliverToParent = Effect.fn("SandboxJobService.deliverToParent")(
    function* (job: SandboxJobStore.SandboxJobRecord, runId: string, status: string) {
      if (job.parentThreadId === null) return;
      const parent = yield* threads
        .getThreadShell(job.parentThreadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (parent === null || parent.deletedAt !== null) return;
      const summary =
        job.lastSummary === null
          ? ""
          : `\n\n${truncate(job.lastSummary, PARENT_SUMMARY_MAX_CHARS)}`;
      yield* threads
        .sendToThread({
          projectId: parent.projectId,
          commandId: CommandId.make(`sandbox-job:${job.jobId}:run:${runId}`),
          threadId: job.parentThreadId,
          messageId: MessageId.make(`sandbox-job:${job.jobId}:run:${runId}`),
          text: `Sandbox job "${job.title}" (${job.jobId}) finished a run (${status}). Its node keeps the workspace.${summary}\n\nContinue with sandbox_job_send, bring the work back with sandbox_job_complete, or drop it with sandbox_job_discard.`,
          attachments: [],
          mode: "queue",
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(Effect.asVoid);
    },
    Effect.catch((cause) =>
      Effect.logWarning("Could not tell the parent thread about a sandbox run.", { cause }),
    ),
  );

  const releaseWatch = (jobId: SandboxJobId, claim: object) =>
    SynchronizedRef.update(watching, (current) => {
      if (current.get(jobId) !== claim) return current;
      const next = new Map(current);
      next.delete(jobId);
      return next;
    });

  /**
   * Follows a node thread until it has no active run, then records the
   * result, marks the node idle and tells the parent. One watcher per job.
   * The last check holds the job lock, so a send that lands meanwhile is
   * either seen here or starts a watcher of its own after this one let go.
   */
  const watch = Effect.fn("SandboxJobService.watch")(function* (
    jobId: SandboxJobId,
    threadId: ThreadId,
  ) {
    const claim = {};
    const claimed = yield* SynchronizedRef.modify(watching, (current) =>
      current.has(jobId) ? [false, current] : [true, new Map(current).set(jobId, claim)],
    );
    if (!claimed) return;
    yield* Effect.gen(function* () {
      let lastRunId: string | null = null;
      let lastStatus = "completed";
      while (true) {
        const job = yield* getJob(jobId);
        if (job.state !== "running") return;
        const connection = yield* ensureConnected(job);
        const waited = yield* callNode(
          connection,
          "t3_thread_wait",
          {
            threadId,
            timeoutMs: NODE_WAIT_SLICE_MS,
            ...(job.activeRunId === null ? {} : { runId: job.activeRunId }),
          },
          OrchestratorMcpThreadWaitResult,
        );
        if (waited.timedOut) continue;
        lastRunId = waited.runId ?? lastRunId;
        lastStatus = waited.status;
        const finished = yield* withJobLock(
          jobId,
          Effect.gen(function* () {
            // Expiry may have collected the job while this waited for the lock.
            if ((yield* getJob(jobId)).state !== "running") {
              yield* signalSettled(jobId);
              return true;
            }
            const detail = yield* callNode(
              connection,
              "t3_thread_read",
              { threadId, view: "messages", limit: 1 },
              OrchestratorMcpThreadReadResult,
            );
            // A send while this waited queued another run; follow that one.
            if (detail.thread.activeRunId !== null) {
              yield* update(jobId, { activeRunId: detail.thread.activeRunId });
              return false;
            }
            const summary = yield* runSummary(connection, threadId, lastRunId, lastStatus);
            const idleSince = yield* now;
            const settled = yield* update(jobId, {
              state: "idle",
              idleSince,
              activeThreadId: null,
              activeRunId: null,
              lastRunStatus: lastStatus,
              lastSummary: summary,
            });
            yield* releaseWatch(jobId, claim);
            yield* deliverToParent(settled, lastRunId ?? idleSince, lastStatus);
            yield* signalSettled(jobId);
            return true;
          }),
        );
        if (finished) return;
      }
    }).pipe(
      // A node that stops answering mid-run is retried; the job stays running.
      Effect.retry({ schedule: Schedule.spaced("30 seconds"), times: 20 }),
      Effect.catch((error) =>
        Effect.logWarning("Lost track of a sandbox job's run.", {
          jobId,
          error: error.message,
        }).pipe(
          Effect.andThen(
            now.pipe(
              Effect.flatMap((idleSince) =>
                update(jobId, {
                  state: "idle",
                  idleSince,
                  activeThreadId: null,
                  activeRunId: null,
                  lastRunStatus: "unknown",
                }),
              ),
              Effect.ignore,
            ),
          ),
          Effect.andThen(releaseWatch(jobId, claim)),
          Effect.andThen(signalSettled(jobId)),
        ),
      ),
      Effect.ensuring(releaseWatch(jobId, claim)),
    );
  });

  const startWatching = (jobId: SandboxJobId, threadId: ThreadId) =>
    Effect.forkIn(watch(jobId, threadId), scope).pipe(Effect.asVoid);

  /** Launches a thread on the node and marks the job running. */
  const launchOnNode = Effect.fn("SandboxJobService.launchOnNode")(function* (
    job: SandboxJobStore.SandboxJobRecord,
    connection: NodeConnection,
    input: {
      readonly message: string;
      readonly title: string;
      readonly agent: SandboxJobAgent;
      readonly model: string | null;
    },
  ) {
    if (job.remoteProjectId === null) {
      return yield* fail("sandbox_job_not_ready", "This sandbox job's workspace is not ready.");
    }
    yield* settledSignal(job.jobId);
    const launched = yield* callNode(
      connection,
      "t3_thread_launch",
      {
        projectId: job.remoteProjectId,
        title: input.title,
        message: input.message,
        modelSelection: modelSelectionFor(input.agent, input.model),
        // The node is the isolation boundary: its agents run without prompts nobody would see.
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      ThreadLaunchResult,
    );
    const updated = yield* update(job.jobId, {
      state: "running",
      idleSince: null,
      threads: [
        ...job.threads,
        { threadId: launched.threadId, title: input.title, agent: input.agent },
      ],
      activeThreadId: launched.threadId,
      activeRunId: launched.runId,
    });
    yield* startWatching(job.jobId, launched.threadId);
    return updated;
  });

  /** Destroys the node and forgets its session. A node the provider no longer has is gone either way. */
  const destroyNode = Effect.fn("SandboxJobService.destroyNode")(function* (
    job: SandboxJobStore.SandboxJobRecord,
  ) {
    const ref = refOf(job);
    if (ref !== undefined) {
      yield* withProvider(job.providerId, (provider) => manager.destroy({ provider, ref })).pipe(
        Effect.catchIf(
          (error) => error._tag === "SandboxEnvironmentError" && error.failure === "not-found",
          () => Effect.void,
        ),
        Effect.mapError((error) =>
          error._tag === "OrchestratorMcpFailure"
            ? error
            : fail("sandbox_node_unavailable", bringUpFailure(error)),
        ),
      );
    }
    yield* SynchronizedRef.update(connections, (current) => {
      const next = new Map(current);
      next.delete(job.jobId);
      return next;
    });
    yield* secrets.remove(tokenSecretName(job.jobId)).pipe(Effect.ignore);
  });

  /** Creates the node, copies the workspace in and launches the first run. */
  const bringUp = Effect.fn("SandboxJobService.bringUp")(
    function* (jobId: SandboxJobId, bundlePath: string) {
      const job = yield* getJob(jobId);
      const settings = (yield* settingsService.getSettings.pipe(Effect.orDie)).sandboxJobs;
      const env = sandboxAgentEnvironment(settings);
      const bootstrap = yield* withProvider(job.providerId, (provider) =>
        manager.provision({
          provider,
          target: {
            label: `T3 job: ${job.title}`.slice(0, 63),
            size: job.size,
            // boat's auto-stop is a deadline from the last start, not idle time.
            // Maintenance calls extendAutoStop while this server is up.
            idleTimeoutMinutes: Math.max(60, settings.idleStopMinutes * 4),
            t3Version,
            installAgentClis: true,
          },
          env,
          idempotencyKey: jobId,
        }),
      ).pipe(
        Effect.tapError((error) =>
          error._tag === "SandboxEnvironmentError" && error.ref !== undefined
            ? update(jobId, { sandboxId: error.ref.sandboxId }).pipe(Effect.ignore)
            : Effect.void,
        ),
        Effect.mapError((error) =>
          error._tag === "OrchestratorMcpFailure"
            ? error
            : fail("sandbox_failed", bringUpFailure(error)),
        ),
      );
      yield* update(jobId, { state: "preparing", sandboxId: bootstrap.ref.sandboxId });
      const connection = yield* connectFrom(jobId, bootstrap).pipe(
        Effect.mapError((error) => fail("sandbox_failed", error.message)),
      );
      const nodeCwd = yield* withProvider(job.providerId, (provider) =>
        Effect.gen(function* () {
          const home = yield* provider.exec(bootstrap.ref, {
            script: 'cd "$HOME" && pwd -P',
            timeoutMs: 30_000,
          });
          const homePath = home.stdout.trim();
          if (home.exitCode !== 0 || !homePath.startsWith("/")) {
            return yield* fail(
              "sandbox_failed",
              "Could not find the sandbox node's home directory.",
            );
          }
          const stateDir = `${homePath}/${NODE_STATE_DIR}`;
          const target = `${homePath}/work/${nodeDirectoryName(job.workspaceRoot)}`;
          const bundle = yield* fileSystem
            .readFile(bundlePath)
            .pipe(
              Effect.mapError(() =>
                fail("sandbox_failed", "Could not read the workspace snapshot."),
              ),
            );
          yield* provider.exec(bootstrap.ref, {
            script: `mkdir -p '${stateDir}'`,
            timeoutMs: 30_000,
          });
          yield* provider.writeFile(bootstrap.ref, `${stateDir}/workspace.bundle`, bundle);
          const imported = yield* provider.exec(bootstrap.ref, {
            script: buildSandboxImportScript({
              bundleRemotePath: `${stateDir}/workspace.bundle`,
              branchName: nodeBranchFor(jobId),
              targetCwd: target,
            }),
            timeoutMs: 5 * 60_000,
          });
          if (imported.exitCode !== 0) {
            return yield* fail(
              "sandbox_failed",
              imported.exitCode === SANDBOX_IMPORT_EXIT_CODES.gitUnavailable
                ? "git is not installed in the sandbox node."
                : `Copying the workspace into the sandbox node failed (exit ${imported.exitCode}).`,
            );
          }
          return target;
        }),
      ).pipe(
        Effect.mapError((error) =>
          error._tag === "OrchestratorMcpFailure"
            ? error
            : fail("sandbox_failed", bringUpFailure(error)),
        ),
      );
      const project = yield* callNode(
        connection,
        "t3_project_create",
        { title: job.title, workspaceRoot: nodeCwd },
        ProjectCreateResult,
      );
      const prepared = yield* update(jobId, { nodeCwd, remoteProjectId: project.id });
      yield* launchOnNode(prepared, connection, {
        message: job.task,
        title: job.title,
        agent: job.agent,
        model: job.model,
      });
    },
    (effect, jobId, bundlePath) =>
      effect.pipe(
        Effect.ensuring(
          fileSystem.remove(path.dirname(bundlePath), { recursive: true }).pipe(Effect.ignore),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("A sandbox job's node could not come up.", {
              jobId,
              error: error.message,
              cause: "cause" in error ? error.cause : undefined,
            });
            const job = yield* getJob(jobId);
            // A node that never became usable is destroyed rather than left billing.
            yield* destroyNode(job).pipe(Effect.ignore);
            yield* update(jobId, {
              state: "failed",
              error: error.message,
              activeThreadId: null,
              activeRunId: null,
            });
            yield* signalSettled(jobId);
          }).pipe(Effect.ignore),
        ),
      ),
  );

  const waitForRun = Effect.fn("SandboxJobService.waitForRun")(function* (
    jobId: SandboxJobId,
    wait: boolean | undefined,
    timeoutMs: number | undefined,
  ) {
    // Taken before the state is read, so a run that settles in between still completes it.
    const signal = wait === true ? yield* settledSignal(jobId) : undefined;
    const job = yield* getJob(jobId);
    const busy =
      job.state === "running" || job.state === "provisioning" || job.state === "preparing";
    if (signal === undefined || !busy)
      return { job: SandboxJobStore.toPublicJob(job), waitTimedOut: false };
    const settled = yield* Deferred.await(signal).pipe(
      Effect.timeoutOption(Duration.millis(timeoutMs ?? DEFAULT_WAIT_MS)),
    );
    return {
      job: SandboxJobStore.toPublicJob(yield* getJob(jobId)),
      waitTimedOut: Option.isNone(settled),
    };
  });

  const startLock = yield* Semaphore.make(1);
  const requireCapacity = (maxActiveJobs: number) =>
    store.list({ includeFinished: false }).pipe(
      Effect.mapError(storeFailure),
      Effect.flatMap((active) =>
        active.length >= maxActiveJobs
          ? Effect.fail(
              fail(
                "sandbox_limit_reached",
                `${active.length} sandbox jobs are open, the most this environment allows. Complete or discard one first.`,
              ),
            )
          : Effect.void,
      ),
    );

  const start = Effect.fn("SandboxJobService.start")(function* (
    input: SandboxJobStartInput,
    caller: SandboxJobCaller,
  ) {
    const settings = (yield* settingsService.getSettings.pipe(Effect.mapError(storeFailure)))
      .sandboxJobs;
    if (!settings.enabled) {
      return yield* fail(
        "sandbox_disabled",
        "Sandbox jobs are off. The user can turn them on in Settings, Integrations, Sandbox jobs.",
      );
    }
    if (caller.requestKey !== null) {
      const existing = yield* store
        .getByRequestKey(caller.requestKey)
        .pipe(Effect.mapError(storeFailure));
      if (existing !== undefined)
        return yield* waitForRun(existing.jobId, input.wait, input.timeoutMs);
    }
    yield* requireCapacity(settings.maxActiveJobs);
    const providerId = input.provider ?? "boat";
    if (settings.providerKeys.boat.trim() === "") {
      return yield* fail(
        "sandbox_provider_unavailable",
        "Add a boat API key in Settings, Integrations, Sandbox jobs, before starting a sandbox job.",
      );
    }
    const agent = input.agent ?? "claude";
    if (
      !sandboxModelProxyActive(settings) &&
      !AGENT_KEYS[agent].some((name) => settings.agentKeys[name].trim() !== "")
    ) {
      return yield* fail(
        "sandbox_agent_unavailable",
        `Sandbox nodes need a key for ${agent} (${AGENT_KEYS[agent].join(" or ")}) or a model proxy. The user can add one in Settings, Integrations, Sandbox jobs.`,
      );
    }

    const jobId = SandboxJobId.make(
      `sbx_${(yield* crypto.randomUUIDv4().pipe(Effect.orDie)).replaceAll("-", "").slice(0, 20)}`,
    );
    // Snapshot now, so a workspace that cannot be copied fails before anything is billed.
    const stagingDir = yield* fileSystem
      .makeTempDirectory({ prefix: "t3-sandbox-job-" })
      .pipe(
        Effect.mapError(() =>
          fail("orchestration_error", "Could not stage the workspace snapshot."),
        ),
      );
    const snapshot = yield* withGit(
      snapshotWorkspace({
        cwd: caller.workspaceRoot,
        bundlePath: path.join(stagingDir, "workspace.bundle"),
      }),
    ).pipe(
      Effect.tapError(() => fileSystem.remove(stagingDir, { recursive: true }).pipe(Effect.ignore)),
      Effect.mapError((error) =>
        fail(
          "invalid_request",
          error._tag === "HandoffNotAWorkTreeError"
            ? "The calling thread's workspace is not a git repository, so it cannot be copied to a sandbox node."
            : error._tag === "HandoffUnmergedPathsError"
              ? "The workspace has unresolved merge conflicts. Resolve them before starting a sandbox job."
              : error._tag === "HandoffUnbornHeadError"
                ? "The workspace has no commits yet. Commit once before starting a sandbox job."
                : "The workspace could not be copied for the sandbox node.",
        ),
      ),
    );
    const createdAt = yield* DateTime.now;
    const title = input.title ?? truncate(input.task.split("\n")[0] ?? "Sandbox job", 80);
    const record: SandboxJobStore.SandboxJobRecord = {
      jobId,
      requestKey: caller.requestKey,
      parentThreadId: caller.parentThreadId,
      workspaceRoot: snapshot.repositoryRoot,
      title,
      task: input.task,
      providerId,
      size: input.size ?? settings.defaultSize,
      agent,
      model: input.model ?? null,
      state: "provisioning",
      sandboxId: null,
      nodeCwd: null,
      baseCommit: snapshot.baseCommitSha,
      remoteProjectId: null,
      threads: [],
      activeThreadId: null,
      activeRunId: null,
      lastRunStatus: null,
      lastSummary: null,
      resultRef: null,
      resultBranch: null,
      pushed: false,
      error: null,
      idleSince: null,
      expiresAt: DateTime.formatIso(DateTime.add(createdAt, { hours: settings.maxLifetimeHours })),
      createdAt: DateTime.formatIso(createdAt),
      updatedAt: DateTime.formatIso(createdAt),
    };
    // Checked again with the insert, so concurrent starts cannot both take the last slot.
    yield* startLock
      .withPermits(1)(
        requireCapacity(settings.maxActiveJobs).pipe(
          Effect.andThen(store.insert(record).pipe(Effect.mapError(storeFailure))),
        ),
      )
      .pipe(
        Effect.tapError(() =>
          fileSystem.remove(stagingDir, { recursive: true }).pipe(Effect.ignore),
        ),
      );
    yield* settledSignal(jobId);
    yield* Effect.forkIn(withJobLock(jobId, bringUp(jobId, snapshot.bundlePath)), scope);
    return yield* waitForRun(jobId, input.wait, input.timeoutMs);
  });

  const requireOpen = (job: SandboxJobStore.SandboxJobRecord) =>
    isSandboxJobFinished(job.state) || job.state === "collecting"
      ? Effect.fail(fail("sandbox_job_finished", `Sandbox job ${job.jobId} is ${job.state}.`))
      : Effect.void;

  const send = Effect.fn("SandboxJobService.send")(function* (input: SandboxJobSendInput) {
    yield* withJobLock(
      input.jobId,
      Effect.gen(function* () {
        const job = yield* getJob(input.jobId);
        yield* requireOpen(job);
        if (job.state === "provisioning" || job.state === "preparing") {
          return yield* fail(
            "sandbox_job_not_ready",
            "The node is still being prepared. Wait for its first run.",
          );
        }
        const connection = yield* ensureConnected(job);
        const current = yield* getJob(input.jobId);
        const latest = current.threads.at(-1);
        if (input.newThread === undefined && latest !== undefined) {
          yield* settledSignal(current.jobId);
          const sent = yield* callNode(
            connection,
            "t3_thread_send",
            { threadId: latest.threadId, message: input.message, mode: "auto" },
            OrchestratorMcpThreadSendResult,
          );
          yield* update(current.jobId, {
            state: "running",
            idleSince: null,
            activeThreadId: latest.threadId,
            activeRunId: sent.runId,
          });
          yield* startWatching(current.jobId, latest.threadId);
          return;
        }
        if (current.state === "running") {
          return yield* fail(
            "sandbox_job_busy",
            "A run is active on this node. Wait for it, or cancel it, before starting another thread.",
          );
        }
        const agent = input.newThread?.agent ?? current.agent;
        yield* launchOnNode(current, connection, {
          message: input.message,
          title:
            input.newThread?.title ?? truncate(input.message.split("\n")[0] ?? current.title, 80),
          agent,
          model: input.newThread?.model ?? (agent === current.agent ? current.model : null),
        });
      }),
    );
    return yield* waitForRun(input.jobId, input.wait, input.timeoutMs);
  });

  const cancel = Effect.fn("SandboxJobService.cancel")(function* (jobId: SandboxJobId) {
    const job = yield* getJob(jobId);
    if (job.state !== "running" || job.activeThreadId === null)
      return SandboxJobStore.toPublicJob(job);
    const connection = yield* ensureConnected(job);
    yield* callNode(
      connection,
      "t3_thread_interrupt",
      { threadId: job.activeThreadId, reason: "Cancelled through sandbox_job_cancel." },
      OrchestratorMcpThreadInterruptResult,
    );
    return SandboxJobStore.toPublicJob(yield* getJob(jobId));
  });

  const git = (cwd: string, args: ReadonlyArray<string>) =>
    runGit({ step: args[0] ?? "git", cwd, args }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  /** Brings the node's work back, then destroys the node. */
  const collectAndDestroy = Effect.fn("SandboxJobService.collectAndDestroy")(function* (
    job: SandboxJobStore.SandboxJobRecord,
    input: { readonly branch?: string | undefined; readonly push?: boolean | undefined },
  ) {
    if (input.branch !== undefined) {
      const exists = yield* git(job.workspaceRoot, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${input.branch}`,
      ]).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (exists) {
        return yield* fail(
          "invalid_request",
          `A local branch named ${input.branch} already exists.`,
        );
      }
    }
    yield* update(job.jobId, { state: "collecting" });
    let resultRef: string | null = null;
    if (job.nodeCwd !== null && job.baseCommit !== null && job.sandboxId !== null) {
      yield* ensureConnected(job);
      const ref = refOf(job)!;
      // The workspace is `$HOME/work/<name>`; the job's files sit in `$HOME/.t3-job`.
      const nodeHome = job.nodeCwd.split("/").slice(0, -2).join("/");
      const nodeBundle = `${nodeHome}/${NODE_STATE_DIR}/collect.bundle`;
      const collected = yield* withProvider(job.providerId, (provider) =>
        Effect.gen(function* () {
          const result = yield* provider.exec(ref, {
            script: buildSandboxCollectScript({
              targetCwd: job.nodeCwd!,
              baseCommit: job.baseCommit!,
              bundleRemotePath: nodeBundle,
              commitMessage: `T3 Code sandbox job ${job.jobId}: ${job.title}`,
            }),
            timeoutMs: 5 * 60_000,
          });
          if (result.exitCode !== 0) {
            return yield* fail(
              "sandbox_failed",
              `Collecting the node's work failed (exit ${result.exitCode}).`,
            );
          }
          const parsed = yield* decodeCollectReport(
            result.stdout.trim().split("\n").at(-1) ?? "",
          ).pipe(
            Effect.mapError(() =>
              fail("sandbox_failed", "The node reported its work in an unexpected shape."),
            ),
          );
          if (!parsed.changed) return Option.none<Uint8Array>();
          return Option.some(yield* provider.readFile(ref, nodeBundle));
        }),
      ).pipe(
        Effect.mapError((error) =>
          error._tag === "OrchestratorMcpFailure"
            ? error
            : fail("sandbox_failed", bringUpFailure(error)),
        ),
      );
      if (Option.isSome(collected)) {
        const stagingDir = yield* fileSystem
          .makeTempDirectory({ prefix: "t3-sandbox-collect-" })
          .pipe(
            Effect.mapError(() =>
              fail("orchestration_error", "Could not stage the collected work."),
            ),
          );
        const localBundle = path.join(stagingDir, "collect.bundle");
        yield* fileSystem.writeFile(localBundle, collected.value).pipe(
          Effect.andThen(
            withGit(
              importCollectedBundle({
                repositoryRoot: job.workspaceRoot,
                bundlePath: localBundle,
                ref: resultRefFor(job.jobId),
              }),
            ),
          ),
          Effect.ensuring(fileSystem.remove(stagingDir, { recursive: true }).pipe(Effect.ignore)),
          Effect.mapError(() =>
            fail("sandbox_failed", "The node's work could not be filed in the local repository."),
          ),
        );
        resultRef = resultRefFor(job.jobId);
      }
    }
    // The work is safe under resultRef from here, so the node goes first; the
    // branch and push are conveniences whose failure is reported, not fatal.
    yield* destroyNode(job);
    let pushed = false;
    let error: string | null = null;
    let resultBranch: string | null = null;
    if (resultRef !== null && input.branch !== undefined) {
      const branch = input.branch;
      const branched = yield* git(job.workspaceRoot, ["branch", branch, resultRef]).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!branched) {
        error = `The work is under ${resultRef}, but the local branch ${branch} could not be created.`;
      } else {
        resultBranch = branch;
        if (input.push === true) {
          pushed = yield* git(job.workspaceRoot, [
            "push",
            "--quiet",
            "origin",
            `refs/heads/${branch}:refs/heads/${branch}`,
          ]).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (!pushed)
            error = `The work is on local branch ${branch}, but pushing it to origin failed.`;
        }
      }
    }
    return yield* update(job.jobId, {
      state: "completed",
      resultRef,
      resultBranch,
      pushed,
      error,
      activeThreadId: null,
      activeRunId: null,
    });
  });

  const complete = Effect.fn("SandboxJobService.complete")(function* (
    input: SandboxJobCompleteInput,
  ) {
    return yield* withJobLock(
      input.jobId,
      Effect.gen(function* () {
        const job = yield* getJob(input.jobId);
        yield* requireOpen(job);
        if (job.state === "running" || job.state === "provisioning" || job.state === "preparing") {
          return yield* fail(
            "sandbox_job_busy",
            "A run is active on this node. Wait for it, or cancel it, before completing the job.",
          );
        }
        const completed = yield* collectAndDestroy(job, input).pipe(
          // A failed collection leaves the node in place so nothing is lost.
          Effect.tapError(() =>
            Effect.flatMap(now, (idleSince) =>
              update(job.jobId, { state: "idle", idleSince }),
            ).pipe(Effect.ignore),
          ),
        );
        return SandboxJobStore.toPublicJob(completed);
      }),
    );
  });

  const discard = Effect.fn("SandboxJobService.discard")(function* (jobId: SandboxJobId) {
    return yield* withJobLock(
      jobId,
      Effect.gen(function* () {
        const job = yield* getJob(jobId);
        if (isSandboxJobFinished(job.state)) return SandboxJobStore.toPublicJob(job);
        yield* destroyNode(job);
        const discarded = yield* update(jobId, {
          state: "discarded",
          activeThreadId: null,
          activeRunId: null,
        });
        yield* signalSettled(jobId);
        return SandboxJobStore.toPublicJob(discarded);
      }),
    );
  });

  const read = Effect.fn("SandboxJobService.read")(function* (input: SandboxJobReadInput) {
    const job = yield* getJob(input.jobId);
    yield* requireOpen(job);
    const threadId = input.threadId ?? job.threads.at(-1)?.threadId;
    if (threadId === undefined) {
      return yield* fail("sandbox_job_not_ready", "This node has no thread yet.");
    }
    if (!job.threads.some((thread) => thread.threadId === threadId)) {
      return yield* fail(
        "thread_not_found",
        `Thread ${threadId} does not belong to sandbox job ${job.jobId}.`,
      );
    }
    const connection = yield* ensureConnected(job);
    return yield* callNode(
      connection,
      "t3_thread_read",
      {
        threadId,
        ...(input.view === undefined ? {} : { view: input.view }),
        ...(input.afterPosition === undefined ? {} : { afterPosition: input.afterPosition }),
      },
      OrchestratorMcpThreadReadResult,
    );
  });

  const runMaintenance = Effect.gen(function* () {
    const settings = (yield* settingsService.getSettings.pipe(Effect.orDie)).sandboxJobs;
    const nowTime = yield* DateTime.now;
    const jobs = yield* store.list({ includeFinished: false }).pipe(Effect.orDie);
    for (const job of jobs) {
      const expired = DateTime.toEpochMillis(nowTime) >= Date.parse(job.expiresAt);
      // Failed expiry collection keeps the disk for an explicit completion retry.
      if (expired && job.state === "stopped" && job.error !== null) continue;
      if (expired && job.state !== "collecting") {
        yield* withJobLock(
          job.jobId,
          Effect.gen(function* () {
            const current = yield* getJob(job.jobId);
            const activeThreadId = current.state === "running" ? current.activeThreadId : null;
            const stopRun = Effect.gen(function* () {
              if (activeThreadId === null) return;
              yield* cancel(current.jobId);
              // An interrupt only acknowledges dispatch; the agent can still write
              // files until the node reports the run ended.
              const waited = yield* callNode(
                yield* ensureConnected(current),
                "t3_thread_wait",
                { threadId: activeThreadId, timeoutMs: NODE_WAIT_SLICE_MS },
                OrchestratorMcpThreadWaitResult,
              );
              if (waited.timedOut) {
                return yield* fail(
                  "sandbox_failed",
                  "The expired job's run did not stop after it was interrupted.",
                );
              }
            });
            yield* stopRun.pipe(
              Effect.andThen(getJob(job.jobId)),
              Effect.flatMap((latest) => collectAndDestroy(latest, {})),
              Effect.tapError((error) =>
                Effect.gen(function* () {
                  yield* update(job.jobId, {
                    state: "idle",
                    idleSince: yield* now,
                    error: error.message,
                  });
                  const current = yield* getJob(job.jobId);
                  const ref = refOf(current);
                  if (ref !== undefined) {
                    // A node boat already archived or deleted cannot stop; it must
                    // still leave the retry loop, which would resume it every tick.
                    yield* withProvider(current.providerId, (provider) =>
                      manager.stop({ provider, ref }),
                    ).pipe(Effect.ignore);
                  }
                  yield* SynchronizedRef.update(connections, (map) => {
                    const next = new Map(map);
                    next.delete(job.jobId);
                    return next;
                  });
                  yield* update(job.jobId, { state: "stopped", error: error.message });
                }),
              ),
            );
          }),
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              "Could not collect an expired sandbox job; retaining its disk for manual recovery.",
              {
                jobId: job.jobId,
                error: error.message,
              },
            ),
          ),
        );
        continue;
      }
      if (
        job.state === "idle" &&
        job.idleSince !== null &&
        DateTime.toEpochMillis(nowTime) - Date.parse(job.idleSince) >=
          settings.idleStopMinutes * 60_000
      ) {
        yield* withJobLock(
          job.jobId,
          Effect.gen(function* () {
            const current = yield* getJob(job.jobId);
            if (current.state !== "idle") return;
            const ref = refOf(current);
            if (ref === undefined) return;
            yield* withProvider(current.providerId, (provider) => manager.stop({ provider, ref }));
            yield* SynchronizedRef.update(connections, (map) => {
              const next = new Map(map);
              next.delete(current.jobId);
              return next;
            });
            yield* update(current.jobId, { state: "stopped" });
          }),
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not stop an idle sandbox node.", {
              jobId: job.jobId,
              error: String(error),
            }),
          ),
        );
        continue;
      }
      // boat's auto-stop is a deadline from the last start. Slide it while this
      // server is up so a long run is not archived out from under the job.
      if (job.state !== "stopped") {
        const minutes = Math.max(60, settings.idleStopMinutes * 4);
        yield* withJobLock(
          job.jobId,
          Effect.gen(function* () {
            const current = yield* getJob(job.jobId);
            const ref = refOf(current);
            if (ref === undefined || current.state === "stopped") return;
            yield* withProvider(current.providerId, (provider) =>
              provider.extendAutoStop === undefined
                ? Effect.void
                : provider.extendAutoStop(ref, minutes),
            );
          }),
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not extend a sandbox job's stop deadline.", {
              jobId: job.jobId,
              error: String(error),
            }),
          ),
        );
      }
    }
  }).pipe(Effect.withSpan("SandboxJobService.runMaintenance"));

  /** After a restart: resume watching running jobs; a node caught mid-bring-up is failed. */
  const recover = Effect.gen(function* () {
    const jobs = yield* store.list({ includeFinished: false }).pipe(Effect.orDie);
    for (const job of jobs) {
      if (job.state === "provisioning" || job.state === "preparing") {
        yield* destroyNode(job).pipe(Effect.ignore);
        yield* update(job.jobId, {
          state: "failed",
          error: "T3 Code restarted while this node was being prepared. Start the job again.",
        }).pipe(Effect.ignore);
      } else if (job.state === "running" && job.activeThreadId !== null) {
        yield* settledSignal(job.jobId);
        yield* startWatching(job.jobId, job.activeThreadId);
      } else if (job.state === "collecting") {
        // The collection was interrupted; the node still has the work. Let the user or agent retry.
        yield* update(job.jobId, { state: "idle", idleSince: yield* now }).pipe(Effect.ignore);
      }
    }
  });
  yield* Effect.forkIn(recover, scope);
  if (options.maintenanceInterval !== null) {
    yield* Effect.forkIn(
      runMaintenance.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Sandbox job maintenance failed.", { cause }),
        ),
        Effect.repeat(Schedule.spaced(options.maintenanceInterval ?? "1 minute")),
      ),
      scope,
    );
  }

  return SandboxJobService.of({
    start,
    status: (input) => waitForRun(input.jobId, input.wait, input.timeoutMs),
    send,
    cancel,
    complete,
    discard,
    list: (input) =>
      store.list(input).pipe(
        Effect.mapError(storeFailure),
        Effect.map((jobs) => jobs.map(SandboxJobStore.toPublicJob)),
      ),
    read,
    runMaintenance,
  });
});

export const layer = (options: SandboxJobServiceOptions = {}) =>
  Layer.effect(SandboxJobService, make(options)).pipe(
    Layer.provide(
      Layer.mergeAll(
        SandboxJobStore.layer,
        SandboxNodeMcp.layer,
        SandboxEnvironmentManager.layer(),
      ),
    ),
  );
