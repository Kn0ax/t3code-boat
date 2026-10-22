// @effect-diagnostics nodeBuiltinImport:off - The fake node runs the job's scripts in a real shell and git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import {
  ProjectId,
  SandboxJobId,
  ThreadId,
  type SandboxJobStartInput,
  type SandboxJobSettings,
} from "@t3tools/contracts";
import {
  SandboxEnvironmentError,
  SandboxEnvironmentManager,
  SandboxProviderError,
  type SandboxEnvironmentBootstrap,
  type SandboxProviderShape,
} from "@t3tools/sandbox-core";
import { makeFakeSandboxProvider } from "@t3tools/sandbox-core/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SandboxJobService from "./SandboxJobService.ts";
import * as SandboxJobStore from "./SandboxJobStore.ts";
import * as SandboxNodeMcp from "./SandboxNodeMcp.ts";

const hostPath = process.env.PATH ?? "/usr/bin:/bin";
const gitEnv = {
  PATH: hostPath,
  HOME: NodeOS.tmpdir(),
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

const git = (cwd: string, args: ReadonlyArray<string>) => {
  const result = NodeChildProcess.spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

let scratch: string;
let repository: string;
let nodeHome: string;

beforeEach(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sandbox-job-test-"));
  repository = NodePath.join(scratch, "repo");
  nodeHome = NodePath.join(scratch, "node-home");
  NodeFS.mkdirSync(repository);
  NodeFS.mkdirSync(nodeHome);
  git(repository, ["init", "--quiet", "--initial-branch=main"]);
  NodeFS.writeFileSync(NodePath.join(repository, "app.ts"), "export const app = 1;\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "base"]);
  // Uncommitted work the node should see too.
  NodeFS.writeFileSync(NodePath.join(repository, "app.ts"), "export const app = 2;\n");
});

afterEach(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

/** A provider whose one node is a directory on this machine, so the job's scripts really run. */
const makeLocalNodeProvider = (
  extensions: Array<number>,
  failures: { readFile: boolean },
): SandboxProviderShape => ({
  ...makeFakeSandboxProvider(),
  extendAutoStop: (_ref, minutes) => Effect.sync(() => void extensions.push(minutes)),
  exec: (_ref, input) =>
    Effect.sync(() => {
      const result = NodeChildProcess.spawnSync("sh", ["-s"], {
        input: input.script,
        encoding: "utf8",
        env: { HOME: nodeHome, PATH: hostPath },
        timeout: 60_000,
      });
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    }),
  writeFile: (_ref, path, content) =>
    Effect.sync(() => {
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, content);
    }),
  readFile: (_ref, path) =>
    Effect.suspend(() =>
      failures.readFile
        ? Effect.fail(
            new SandboxProviderError({
              providerId: "boat",
              operation: "readFile",
              failure: "network",
            }),
          )
        : Effect.sync(() => new Uint8Array(NodeFS.readFileSync(path))),
    ),
});

interface ManagerRecord {
  readonly calls: Array<"provision" | "reconnect" | "stop" | "destroy">;
  provisionEnv: Readonly<Record<string, string>> | undefined;
  failStop?: boolean;
}

const makeManager = (record: ManagerRecord) => {
  let pairings = 0;
  const bootstrap = (): SandboxEnvironmentBootstrap => ({
    ref: { providerId: "boat", sandboxId: "node-1" },
    httpBaseUrl: "https://node-1.sandbox.test",
    wsBaseUrl: "wss://node-1.sandbox.test",
    pairingToken: `pairing-${++pairings}`,
    requestHeaders: { "x-preview-token": "preview" },
  });
  return SandboxEnvironmentManager.of({
    provision: (input) =>
      Effect.sync(() => {
        record.calls.push("provision");
        record.provisionEnv = input.env;
        return bootstrap();
      }),
    reconnect: () =>
      Effect.sync(() => {
        record.calls.push("reconnect");
        return bootstrap();
      }),
    stop: () =>
      Effect.suspend(() => {
        record.calls.push("stop");
        return record.failStop
          ? Effect.fail(new SandboxEnvironmentError({ stage: "stop", detail: "gone" }))
          : Effect.void;
      }),
    destroy: () => Effect.sync(() => void record.calls.push("destroy")),
  });
};

/**
 * The node's T3 server, as its orchestrator tools answer. Each run "does
 * work" by writing a file into the node's workspace. A test that needs a run
 * to stay active sets `hold`; t3_thread_interrupt releases it.
 */
interface FakeNode {
  readonly signIns: Array<string>;
  readonly tools: Array<string>;
  hold: Deferred.Deferred<void> | undefined;
  /** Completed once a watcher is waiting on a held run. */
  waiting: Deferred.Deferred<void> | undefined;
  failTool: string | undefined;
  /** How each run ends; a failed run leaves an error item and no answer. */
  runStatus: "completed" | "failed";
  launches: Array<Readonly<Record<string, unknown>>>;
}

const makeNodeMcp = (node: FakeNode) => {
  let workspaceRoot = "";
  let runs = 0;
  const startRun = (threadId: string) => {
    runs += 1;
    NodeFS.writeFileSync(NodePath.join(workspaceRoot, `run-${runs}.md`), `run ${runs}\n`);
    return { threadId, runId: `run-${runs}` };
  };
  const answer = (tool: string, args: Readonly<Record<string, unknown>>) =>
    Effect.gen(function* () {
      node.tools.push(tool);
      if (node.failTool === tool) {
        return yield* new SandboxNodeMcp.SandboxNodeToolError({
          tool,
          code: "orchestration_error",
          detail: "scripted failure",
        });
      }
      switch (tool) {
        case "t3_project_create":
          workspaceRoot = String(args.workspaceRoot);
          return { id: "node-project" };
        case "t3_thread_launch":
          node.launches.push(args);
          return { ...startRun("node-thread-1"), projectId: "node-project" };
        case "t3_thread_send":
          return {
            ...startRun(String(args.threadId)),
            messageId: `message-${runs}`,
            status: "running",
            delivery: "started",
          };
        case "t3_thread_wait":
          if (node.hold !== undefined) {
            if (node.waiting !== undefined) yield* Deferred.succeed(node.waiting, undefined);
            yield* Deferred.await(node.hold);
          }
          return {
            threadId: args.threadId,
            runId: `run-${runs}`,
            status: node.hold === undefined ? node.runStatus : "interrupted",
            timedOut: false,
          };
        case "t3_thread_interrupt":
          if (node.hold !== undefined) yield* Deferred.succeed(node.hold, undefined);
          return { threadId: args.threadId, runId: `run-${runs}`, status: "interrupt_requested" };
        case "t3_thread_read":
          return {
            thread: { activeRunId: null },
            recentRuns: [],
            items:
              args.limit === 1
                ? []
                : node.runStatus === "completed"
                  ? [
                      {
                        type: "assistant_message",
                        runId: `run-${runs}`,
                        text: `Finished run ${runs}.`,
                      },
                    ]
                  : args.view === "activity"
                    ? [{ type: "error", runId: `run-${runs}`, text: "Invalid API key." }]
                    : [],
            nextPosition: null,
            hasMore: false,
          };
      }
      return yield* Effect.die(`unexpected tool ${tool}`);
    });
  return SandboxNodeMcp.SandboxNodeMcp.of({
    signIn: (_endpoint, pairingCode) =>
      Effect.sync(() => {
        node.signIns.push(pairingCode);
        return Redacted.make(`token-for-${pairingCode}`);
      }),
    // The fake answers in the node's own shapes; decoding them is SandboxNodeMcp's job.
    call: (input) =>
      answer(input.tool, input.arguments) as Effect.Effect<
        never,
        SandboxNodeMcp.SandboxNodeToolError
      >,
  });
};

const makeSecretStore = () => {
  const values = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: (name) => Effect.sync(() => values.get(name) ?? new Uint8Array(32)),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  });
};

const parentThreadId = ThreadId.make("parent-thread");

interface Harness {
  readonly manager: ManagerRecord;
  readonly node: FakeNode;
  readonly parentMessages: Array<string>;
  readonly extensions: Array<number>;
  readonly failures: { readFile: boolean };
}

const makeHarness = (
  settings: Partial<SandboxJobSettings> = {},
  agentKeys: Partial<SandboxJobSettings["agentKeys"]> = { ANTHROPIC_API_KEY: "sk-test" },
) => {
  const harness: Harness = {
    manager: { calls: [], provisionEnv: undefined },
    node: {
      signIns: [],
      tools: [],
      hold: undefined,
      waiting: undefined,
      failTool: undefined,
      runStatus: "completed",
      launches: [],
    },
    parentMessages: [],
    extensions: [],
    failures: { readFile: false },
  };
  const provider = makeLocalNodeProvider(harness.extensions, harness.failures);
  const layer = Layer.effect(
    SandboxJobService.SandboxJobService,
    SandboxJobService.make({
      resolveProvider: () => Effect.succeed(provider),
      t3Version: "0.0.0-test",
      maintenanceInterval: null,
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SandboxJobStore.layer,
        Layer.succeed(SandboxNodeMcp.SandboxNodeMcp, makeNodeMcp(harness.node)),
        Layer.succeed(SandboxEnvironmentManager, makeManager(harness.manager)),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        SqlitePersistence.layerMemory,
        Layer.succeed(ServerSecretStore.ServerSecretStore, makeSecretStore()),
        ServerSettings.layerTest({
          sandboxJobs: {
            enabled: true,
            providerKeys: { boat: "test-boat-key" },
            agentKeys,
            ...settings,
          },
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({
              id: parentThreadId,
              projectId: ProjectId.make("project-1"),
              deletedAt: null,
            } as never),
          sendToThread: (input) =>
            Effect.sync(() => {
              harness.parentMessages.push(input.text);
              return {} as never;
            }),
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { harness, layer };
};

const caller = (requestKey: string | null = null): SandboxJobService.SandboxJobCaller => ({
  parentThreadId,
  workspaceRoot: repository,
  requestKey,
});

const startInput: SandboxJobStartInput = {
  task: "Add the feature.",
  provider: "boat",
  wait: true,
};

describe("SandboxJobService", () => {
  it.effect("keeps retired provider records without blocking Boat jobs", () => {
    const { harness, layer } = makeHarness();
    return Effect.gen(function* () {
      const jobs = yield* SandboxJobService.SandboxJobService;
      const sql = yield* SqlClient.SqlClient;
      const started = yield* jobs.start(startInput, caller());
      const [row] = yield* sql`SELECT * FROM sandbox_jobs`;
      for (const providerId of ["daytona", "docker"]) {
        yield* sql`INSERT INTO sandbox_jobs ${sql.insert({
          ...row,
          job_id: `legacy-${providerId}`,
          provider_id: providerId,
          request_key: null,
          state: providerId === "docker" ? "completed" : "running",
        })}`;
      }
      for (const includeFinished of [true, false]) {
        const listed = yield* jobs.list({ includeFinished });
        assert.deepEqual(
          listed.map((job) => job.jobId),
          [started.job.jobId],
        );
      }
      const retired = yield* jobs
        .status({ jobId: SandboxJobId.make("legacy-daytona") })
        .pipe(Effect.flip);
      assert.equal(retired.code, "sandbox_job_not_found");
      yield* jobs.runMaintenance;
      assert.notInclude(harness.manager.calls, "destroy");
      const legacy =
        yield* sql`SELECT provider_id, state FROM sandbox_jobs WHERE provider_id != 'boat' ORDER BY provider_id`;
      assert.deepEqual(legacy, [
        { provider_id: "daytona", state: "running" },
        { provider_id: "docker", state: "completed" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "stops failed expiry collection without waking it on later ticks and allows manual recovery",
    () => {
      const { harness, layer } = makeHarness({ maxLifetimeHours: 1 });
      return Effect.gen(function* () {
        const jobs = yield* SandboxJobService.SandboxJobService;
        const started = yield* jobs.start(startInput, caller());
        harness.failures.readFile = true;
        yield* TestClock.adjust("2 hours");
        yield* jobs.runMaintenance;
        const retained = (yield* jobs.status({ jobId: started.job.jobId })).job;
        assert.equal(retained.state, "stopped");
        assert.isNotNull(retained.error);
        assert.notInclude(harness.manager.calls, "destroy");

        yield* jobs.runMaintenance;
        yield* jobs.runMaintenance;
        assert.deepEqual(harness.manager.calls, ["provision", "stop"]);
        harness.failures.readFile = false;
        yield* jobs.complete({ jobId: started.job.jobId });
        const completed = (yield* jobs.status({ jobId: started.job.jobId })).job;
        assert.equal(completed.state, "completed");
        assert.equal(git(repository, ["show", `${completed.resultRef}:run-1.md`]), "run 1\n");
        assert.deepEqual(harness.manager.calls, ["provision", "stop", "reconnect", "destroy"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("leaves the expiry retry loop when the node cannot stop either", () => {
    const { harness, layer } = makeHarness({ maxLifetimeHours: 1 });
    return Effect.gen(function* () {
      const jobs = yield* SandboxJobService.SandboxJobService;
      const started = yield* jobs.start(startInput, caller());
      harness.failures.readFile = true;
      harness.manager.failStop = true;
      yield* TestClock.adjust("2 hours");
      yield* jobs.runMaintenance;
      yield* jobs.runMaintenance;
      assert.equal((yield* jobs.status({ jobId: started.job.jobId })).job.state, "stopped");
      assert.deepEqual(harness.manager.calls, ["provision", "stop"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("holds one node across runs until the job is completed", () => {
    const { harness, layer } = makeHarness();
    return Effect.gen(function* () {
      const jobs = yield* SandboxJobService.SandboxJobService;

      const started = yield* jobs.start(startInput, caller());
      assert.equal(started.job.state, "idle");
      assert.equal(started.job.lastSummary, "Finished run 1.");
      assert.deepEqual(harness.manager.provisionEnv, {
        ANTHROPIC_API_KEY: "sk-test",
        T3_GIT_ALLOW_PUSH: "0",
      });
      assert.equal(harness.parentMessages.length, 1);
      // Claude's built-in instance on the node is claudeAgent.
      assert.deepInclude(harness.node.launches[0]?.modelSelection as object, {
        instanceId: "claudeAgent",
      });

      const continued = yield* jobs.send({
        jobId: started.job.jobId,
        message: "Now test it.",
        wait: true,
      });
      assert.equal(continued.job.state, "idle");
      assert.equal(continued.job.threads.length, 1);
      assert.equal(continued.job.lastSummary, "Finished run 2.");
      assert.equal(harness.parentMessages.length, 2);

      const statusBefore = git(repository, ["status", "--porcelain"]);
      const completed = yield* jobs.complete({
        jobId: started.job.jobId,
        branch: "sandbox-result",
      });
      assert.equal(completed.state, "completed");
      assert.equal(completed.resultRef, `refs/t3/sandbox/${started.job.jobId}`);
      assert.equal(completed.resultBranch, "sandbox-result");
      // Both runs' work and the checkout's uncommitted change come back; the checkout is untouched.
      assert.equal(git(repository, ["show", "sandbox-result:run-1.md"]), "run 1\n");
      assert.equal(git(repository, ["show", "sandbox-result:run-2.md"]), "run 2\n");
      assert.equal(git(repository, ["show", "sandbox-result:app.ts"]), "export const app = 2;\n");
      assert.equal(git(repository, ["status", "--porcelain"]), statusBefore);
      assert.deepEqual(harness.manager.calls, ["provision", "destroy"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports why a run failed when it left no answer", () => {
    const { harness, layer } = makeHarness();
    harness.node.runStatus = "failed";
    return Effect.gen(function* () {
      const jobs = yield* SandboxJobService.SandboxJobService;
      const started = yield* jobs.start(startInput, caller());
      assert.equal(started.job.state, "idle");
      assert.equal(started.job.lastRunStatus, "failed");
      assert.equal(started.job.lastSummary, "The run failed: Invalid API key.");
      assert.include(harness.parentMessages[0], "Invalid API key.");
      yield* jobs.discard(started.job.jobId);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops an idle node and resumes it on the next send", () => {
    const { harness, layer } = makeHarness({ idleStopMinutes: 15 });
    return Effect.gen(function* () {
      const jobs = yield* SandboxJobService.SandboxJobService;
      const started = yield* jobs.start(startInput, caller());

      yield* TestClock.adjust("14 minutes");
      yield* jobs.runMaintenance;
      assert.equal((yield* jobs.status({ jobId: started.job.jobId })).job.state, "idle");
      // Still inside the idle window, so the deadline slides instead of stopping.
      assert.deepEqual(harness.extensions, [60]);

      yield* TestClock.adjust("2 minutes");
      yield* jobs.runMaintenance;
      assert.equal((yield* jobs.status({ jobId: started.job.jobId })).job.state, "stopped");
      assert.deepEqual(harness.extensions, [60]);

      const resumed = yield* jobs.send({
        jobId: started.job.jobId,
        message: "Keep going.",
        wait: true,
      });
      assert.equal(resumed.job.state, "idle");
      assert.deepEqual(harness.manager.calls, ["provision", "stop", "reconnect"]);
      // The node is signed in to again with the pairing code its resume minted.
      assert.deepEqual(harness.node.signIns, ["pairing-1", "pairing-2"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "cancels a run without ending the job, and refuses to complete while one is active",
    () => {
      const { harness, layer } = makeHarness();
      return Effect.gen(function* () {
        harness.node.hold = yield* Deferred.make<void>();
        harness.node.waiting = yield* Deferred.make<void>();
        const jobs = yield* SandboxJobService.SandboxJobService;
        const started = yield* jobs.start({ ...startInput, wait: false }, caller());

        yield* Deferred.await(harness.node.waiting);
        assert.equal((yield* jobs.status({ jobId: started.job.jobId })).job.state, "running");
        const refused = yield* jobs.complete({ jobId: started.job.jobId }).pipe(Effect.flip);
        assert.equal(refused.code, "sandbox_job_busy");

        yield* jobs.cancel(started.job.jobId);
        const settled = yield* jobs.status({ jobId: started.job.jobId, wait: true });
        assert.equal(settled.job.state, "idle");
        assert.equal(settled.job.lastRunStatus, "interrupted");
        assert.notInclude(harness.manager.calls, "destroy");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("discards a job by destroying its node without collecting", () => {
    const { harness, layer } = makeHarness();
    return Effect.gen(function* () {
      const jobs = yield* SandboxJobService.SandboxJobService;
      const started = yield* jobs.start(startInput, caller());
      const discarded = yield* jobs.discard(started.job.jobId);
      assert.equal(discarded.state, "discarded");
      assert.isNull(discarded.resultRef);
      assert.deepEqual(harness.manager.calls, ["provision", "destroy"]);
      assert.equal(git(repository, ["for-each-ref", "refs/t3/sandbox"]), "");
      const refused = yield* jobs
        .send({ jobId: started.job.jobId, message: "More." })
        .pipe(Effect.flip);
      assert.equal(refused.code, "sandbox_job_finished");
    }).pipe(Effect.provide(layer));
  });

  it.effect("destroys a node that cannot be prepared and fails the job", () => {
    const { harness, layer } = makeHarness();
    return Effect.gen(function* () {
      harness.node.failTool = "t3_project_create";
      const jobs = yield* SandboxJobService.SandboxJobService;
      const result = yield* jobs.start(startInput, caller());
      assert.equal(result.job.state, "failed");
      assert.include(result.job.error ?? "", "t3_project_create");
      assert.deepEqual(harness.manager.calls, ["provision", "destroy"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("returns the same job for a retried request", () => {
    const { harness, layer } = makeHarness();
    return Effect.gen(function* () {
      const jobs = yield* SandboxJobService.SandboxJobService;
      const first = yield* jobs.start(startInput, caller("client:retry-1"));
      const second = yield* jobs.start(startInput, caller("client:retry-1"));
      assert.equal(second.job.jobId, first.job.jobId);
      assert.deepEqual(harness.manager.calls, ["provision"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to start without an agent key or while turned off", () => {
    const off = makeHarness({ enabled: false });
    const on = makeHarness({}, {});
    return Effect.gen(function* () {
      const disabled = yield* Effect.flatMap(SandboxJobService.SandboxJobService, (jobs) =>
        jobs.start(startInput, caller()),
      ).pipe(Effect.flip, Effect.provide(off.layer));
      assert.equal(disabled.code, "sandbox_disabled");

      const keyless = yield* Effect.flatMap(SandboxJobService.SandboxJobService, (jobs) =>
        jobs.start(startInput, caller()),
      ).pipe(Effect.flip, Effect.provide(on.layer));
      assert.equal(keyless.code, "sandbox_agent_unavailable");
      assert.deepEqual(on.harness.manager.calls, []);
    });
  });

  it.effect("starts with only a model proxy and hands the node its URL and key", () => {
    const { harness, layer } = makeHarness(
      { modelProxy: { baseUrl: "http://radxa:8317/v1/", key: "proxy-key" } },
      { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" },
    );
    return Effect.gen(function* () {
      const jobs = yield* SandboxJobService.SandboxJobService;
      yield* jobs.start({ ...startInput, agent: "codex" }, caller());
      assert.deepEqual(harness.manager.provisionEnv, {
        ANTHROPIC_API_KEY: "proxy-key",
        T3_MODEL_PROXY_BASE_URL: "http://radxa:8317",
        T3_MODEL_PROXY_KEY: "proxy-key",
        T3_GIT_ALLOW_PUSH: "0",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports an unknown job", () => {
    const { layer } = makeHarness();
    return Effect.gen(function* () {
      const jobs = yield* SandboxJobService.SandboxJobService;
      const error = yield* jobs
        .status({ jobId: SandboxJobId.make("sbx_missing") })
        .pipe(Effect.flip);
      assert.equal(error.code, "sandbox_job_not_found");
    }).pipe(Effect.provide(layer));
  });
});

describe("sandbox t3 version", () => {
  it("follows a published host release and falls back to the pin otherwise", () => {
    const pin = SandboxJobService.SANDBOX_NODE_T3_VERSION;
    for (const published of ["0.1.1-nightly.20261019.3101", "0.1.1-preview.20261019.4", "0.1.0"]) {
      assert.equal(SandboxJobService.sandboxT3Version(published), published);
    }
    for (const unusable of [
      "0.0.45",
      "0.0.46-nightly.20261001.3000",
      "0.1.1-rc.1",
      "0.1.1-local",
    ]) {
      assert.equal(SandboxJobService.sandboxT3Version(unusable), pin, unusable);
    }
  });
});
