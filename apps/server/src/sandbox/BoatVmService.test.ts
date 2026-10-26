// @effect-diagnostics nodeBuiltinImport:off - The fake VM runs the sync and busy scripts in a real shell and git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import {
  OrchestrationV2ThreadDetailSnapshot,
  parseBoatVmSandboxLabel,
  ProjectId,
  ThreadId,
  type OrchestrationProjectShell,
  type SandboxJobSettings,
} from "@t3tools/contracts";
import {
  SANDBOX_STATE_KEY,
  SandboxEnvironmentError,
  SandboxEnvironmentManager,
  type SandboxEnvironmentTarget,
  type SandboxInfo,
  type SandboxProviderShape,
  type SandboxRef,
} from "@t3tools/sandbox-core";
import { makeFakeSandboxProvider } from "@t3tools/sandbox-core/testing";
import type { BoatCatalogShape } from "@t3tools/sandbox-boat";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../config.ts";
import { EventSinkWriteError } from "../orchestration-v2/EventSink.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as FollowedThreadCopies from "../orchestration-v2/FollowedThreadCopies.ts";
import * as ThreadImportService from "../orchestration-v2/ThreadImportService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BoatVmLifecycle from "./BoatVmLifecycle.ts";
import * as BoatVmManagerAccess from "./BoatVmManagerAccess.ts";
import * as BoatVmService from "./BoatVmService.ts";
import * as BoatVmProxy from "./BoatVmProxy.ts";

const hostPath = process.env.PATH ?? "/usr/bin:/bin";
const gitEnv = {
  PATH: hostPath,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

const git = (cwd: string, args: ReadonlyArray<string>) => {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    env: { ...gitEnv, HOME: NodeOS.tmpdir() },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

let scratch: string;
let remote: string;

beforeEach(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-boat-vm-test-"));
  remote = NodePath.join(scratch, "remote");
  NodeFS.mkdirSync(remote);
  git(remote, ["init", "--quiet", "--initial-branch=main"]);
  NodeFS.writeFileSync(NodePath.join(remote, "app.ts"), "export const app = 1;\n");
  git(remote, ["add", "."]);
  git(remote, ["commit", "--quiet", "-m", "base"]);
});

afterEach(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

const homeOf = (sandboxId: string) => {
  const home = NodePath.join(scratch, "vms", sandboxId);
  NodeFS.mkdirSync(home, { recursive: true });
  return home;
};

interface Record {
  readonly targets: Array<SandboxEnvironmentTarget>;
  readonly reconnects: Array<string>;
  readonly resumed: Array<string>;
  readonly extended: Array<{ readonly sandboxId: string; readonly minutes: number }>;
  readonly resets: Array<string>;
  readonly tailnetJoins: Array<{ readonly sandboxId: string; readonly script: string }>;
  readonly destroyed: Array<string>;
  readonly stopped: Array<string>;
  /** Thread mirrors, copy deletes, and VM stops and deletes, in the order they happened. */
  readonly events: Array<string>;
  readonly written: Array<{ readonly path: string; readonly content: string }>;
  /** Codes minted and ended for VMs to link back here, as "grant:<id>" and "revoke:<id>". */
  readonly managerAccess: Array<string>;
  /** The link requests VMs were sent, by sandbox id. */
  readonly managerLinks: Array<{ readonly sandboxId: string; readonly request: string }>;
  /** The copies last published as following a VM thread. */
  followed: ReadonlySet<string>;
  provisionEnv: Readonly<{ [name: string]: string }> | undefined;
}

/** VMs whose scripts run in a local shell, each with its own home directory. */
const makeProvider = (record: Record, vms: ReadonlyArray<SandboxInfo>): SandboxProviderShape => ({
  ...makeFakeSandboxProvider({ id: "boat" }),
  list: () => Effect.succeed(vms),
  get: (ref) =>
    Effect.succeed(
      vms.find((vm) => vm.ref.sandboxId === ref.sandboxId) ?? {
        ref,
        status: "running",
        label: "vm acme/app",
      },
    ),
  exec: (ref, input) =>
    Effect.sync(() => {
      // Resetting and joining Tailscale use sudo, which only a VM can do.
      if (input.script === BoatVmService.CLONE_RESET_SCRIPT) {
        record.resets.push(ref.sandboxId);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (input.script === BoatVmService.TAILNET_LOGOUT_SCRIPT) {
        record.tailnetJoins.push({ sandboxId: ref.sandboxId, script: input.script });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (
        input.script === BoatVmService.TAILNET_SCRIPT ||
        input.script === BoatVmService.SNAPSHOT_TAILNET_SCRIPT
      ) {
        record.tailnetJoins.push({ sandboxId: ref.sandboxId, script: input.script });
        return { exitCode: 0, stdout: `t3-vm-${ref.sandboxId}.tail.ts.net`, stderr: "" };
      }
      if (input.script === BoatVmService.VM_MANAGER_LINK_SCRIPT) {
        const request = NodePath.join(
          homeOf(ref.sandboxId),
          `.t3/boat-manager-link-${input.args?.[0] ?? ""}.json`,
        );
        record.managerLinks.push({
          sandboxId: ref.sandboxId,
          request: NodeFS.readFileSync(request, "utf8"),
        });
        NodeFS.rmSync(request);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (input.script.includes("sudo ")) {
        throw new Error("A test script would run sudo on this machine.");
      }
      const result = NodeChildProcess.spawnSync("sh", ["-s", ...(input.args ?? [])], {
        input: input.script,
        encoding: "utf8",
        env: { ...gitEnv, HOME: homeOf(ref.sandboxId) },
        timeout: 60_000,
      });
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    }),
  writeFile: (ref, path, content) =>
    Effect.sync(() => {
      const target = NodePath.join(homeOf(ref.sandboxId), path.replace(/^~\//, ""));
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.writeFileSync(target, content);
      record.written.push({ path, content: new TextDecoder().decode(content) });
    }),
  readFile: (_ref, path) => Effect.sync(() => new Uint8Array(NodeFS.readFileSync(path))),
  destroy: (ref) => Effect.sync(() => void record.destroyed.push(ref.sandboxId)),
  resume: (ref) =>
    Effect.sync(() => {
      record.resumed.push(ref.sandboxId);
      return { ref, status: "creating" as const, label: "vm acme/app" };
    }),
  extendAutoStop: (ref, minutes) =>
    Effect.sync(() => void record.extended.push({ sandboxId: ref.sandboxId, minutes })),
});

const bootstrapFor = (ref: SandboxRef, pairing: string) => ({
  ref,
  httpBaseUrl: `https://t3-vm-${ref.sandboxId}.tail.ts.net`,
  wsBaseUrl: `wss://t3-vm-${ref.sandboxId}.tail.ts.net`,
  pairingToken: pairing,
  requestHeaders: {},
});

/** Only snapshots named in `snapshots` exist. */
const makeManager = (record: Record, snapshots: ReadonlySet<string>) =>
  SandboxEnvironmentManager.of({
    provision: (input) =>
      Effect.gen(function* () {
        record.targets.push(input.target);
        record.provisionEnv = input.env;
        if (input.target.snapshot !== undefined && !snapshots.has(input.target.snapshot)) {
          return yield* new SandboxEnvironmentError({
            stage: "create",
            detail: "No such snapshot.",
            failure: "not-found",
          });
        }
        return bootstrapFor({ providerId: "boat", sandboxId: "new" }, "pair-new");
      }),
    reconnect: (input) =>
      Effect.sync(() => {
        record.reconnects.push(input.ref.sandboxId);
        return bootstrapFor(input.ref, "pair-again");
      }),
    stop: (input) =>
      Effect.sync(() => {
        record.stopped.push(input.ref.sandboxId);
        record.events.push(`stop:${input.ref.sandboxId}`);
      }),
    destroy: (input) =>
      Effect.sync(() => {
        record.destroyed.push(input.ref.sandboxId);
        record.events.push(`destroy:${input.ref.sandboxId}`);
      }),
  });

const makeHarness = (input: {
  readonly snapshots?: ReadonlyArray<string>;
  readonly vms?: ReadonlyArray<SandboxInfo>;
  readonly settings?: Partial<SandboxJobSettings>;
  readonly provider?: (provider: SandboxProviderShape) => SandboxProviderShape;
  readonly manager?: (
    manager: SandboxEnvironmentManager["Service"],
  ) => SandboxEnvironmentManager["Service"];
  readonly projects?: ReadonlyArray<
    Pick<OrchestrationProjectShell, "workspaceRoot" | "repositoryIdentity"> & {
      readonly id?: ProjectId;
      readonly title?: string;
    }
  >;
  readonly mirrorThread?: ThreadImportService.ThreadImportService["Service"]["mirrorThread"];
  readonly deleteCopy?: ThreadImportService.ThreadImportService["Service"]["deleteCopy"];
  /** The copies' states here; none are settled when omitted. */
  readonly copyState?: ThreadImportService.ThreadImportService["Service"]["copyState"];
  readonly copySnapshot?: ThreadImportService.ThreadImportService["Service"]["copySnapshot"];
  /** The copies' titles here; none when omitted. */
  readonly copyTitle?: ThreadImportService.ThreadImportService["Service"]["copyTitle"];
  /** A T3 home that outlives one server, for state kept across restarts. */
  readonly baseDir?: string;
  /** This server's tailnet origin for VMs to link back to; none when omitted. */
  readonly managerUrl?: string;
  /** The boat account's snapshots; none when omitted. */
  readonly catalog?: BoatCatalogShape;
}) => {
  const record: Record = {
    targets: [],
    reconnects: [],
    extended: [],
    resets: [],
    tailnetJoins: [],
    destroyed: [],
    stopped: [],
    events: [],
    written: [],
    managerAccess: [],
    managerLinks: [],
    resumed: [],
    provisionEnv: undefined,
    followed: new Set(),
  };
  const baseProvider = makeProvider(record, input.vms ?? []);
  const provider = input.provider?.(baseProvider) ?? baseProvider;
  const manager = makeManager(record, new Set(input.snapshots));
  const layer = Layer.effect(
    BoatVmService.BoatVmService,
    BoatVmService.make({
      resolveProvider: (settings) =>
        Effect.succeed(settings.providerKeys.boat === "" ? undefined : provider),
      t3Version: "0.0.0-test",
      keepAliveInterval: null,
      resolveCatalog: () => Effect.succeed(input.catalog),
    }),
  ).pipe(
    Layer.provide(Layer.succeed(SandboxEnvironmentManager, input.manager?.(manager) ?? manager)),
    Layer.provide(
      Layer.succeed(ProjectService.ProjectService, {
        listShells: () => Effect.succeed(input.projects ?? []),
      } as unknown as ProjectService.ProjectService["Service"]),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        sandboxJobs: {
          providerKeys: { boat: "boat-key" },
          agentKeys: { ANTHROPIC_API_KEY: "sk-test" },
          tailscaleAuthKey: "tskey-test",
          boatVmConnectionMode: "tailscale",
          boatVmTailscale: "auth-key",
          ...input.settings,
        },
      }),
    ),
    Layer.provide(
      Layer.succeed(FollowedThreadCopies.FollowedThreadCopies, {
        has: (threadId) => Effect.sync(() => record.followed.has(threadId)),
        replace: (threadIds) =>
          Effect.sync(() => {
            record.followed = threadIds;
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadImportService.ThreadImportService, {
        importThread: () => Effect.die("No thread import expected"),
        mirrorThread: (mirrorInput) =>
          input.mirrorThread === undefined
            ? Effect.die("No thread mirror expected")
            : input
                .mirrorThread(mirrorInput)
                .pipe(
                  Effect.tap(({ outcome }) =>
                    Effect.sync(() =>
                      record.events.push(
                        `mirror:${mirrorInput.originKey} ${mirrorInput.projectId} ${outcome}`,
                      ),
                    ),
                  ),
                ),
        deleteCopy: (originKey) =>
          input.deleteCopy === undefined
            ? Effect.die("No copy delete expected")
            : input
                .deleteCopy(originKey)
                .pipe(
                  Effect.tap(() => Effect.sync(() => record.events.push(`delete:${originKey}`))),
                ),
        copyState: (originKey) => input.copyState?.(originKey) ?? Effect.succeed(null),
        copyTitle: (originKey) => input.copyTitle?.(originKey) ?? Effect.succeed(null),
        settleCopy: (originKey) =>
          Effect.sync(() => void record.events.push(`settle:${originKey}`)),
        copySnapshot: (originKey) => input.copySnapshot?.(originKey) ?? Effect.succeed(null),
      }),
    ),
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        ensureScratchProject: Effect.succeed({ projectId: ProjectId.make("home-scratch") }),
        namedProjectsRoot: "/unused",
      }),
    ),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), input.baseDir ?? { prefix: "t3-boat-vm-config-" }),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.succeed(BoatVmManagerAccess.BoatVmManagerAccess, {
        grant: (sandboxId) =>
          Effect.sync(() => {
            record.managerAccess.push(`grant:${sandboxId}`);
            return input.managerUrl === undefined
              ? Option.none()
              : Option.some({ managerUrl: input.managerUrl, pairingCode: `code-${sandboxId}` });
          }),
        revoke: (sandboxId) =>
          Effect.sync(() => void record.managerAccess.push(`revoke:${sandboxId}`)),
      }),
    ),
    Layer.provide(
      Layer.succeed(BoatVmProxy.BoatVmProxy, {
        register: () => Effect.succeed("proxy-token"),
        forward: () => Effect.die("No relay request expected"),
      }),
    ),
  );
  return { record, layer };
};

const repository = () => ({ remoteUrl: remote, owner: "Acme", name: "app" });

describe("BoatVmService", () => {
  it.effect(
    "syncs the repository during bootstrap without consuming the server's credentials",
    () =>
      Effect.gen(function* () {
        const syncStarted = yield* Deferred.make<void>();
        const serverReady = yield* Deferred.make<void>();
        const ref: SandboxRef = { providerId: "boat", sandboxId: "new" };
        const { layer, record } = makeHarness({
          provider: (provider) => ({
            ...provider,
            startBackground: () => Effect.void,
            exec: (ref, command) =>
              command.script === BoatVmService.SYNC_SCRIPT
                ? Deferred.succeed(syncStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(serverReady)),
                    Effect.andThen(provider.exec(ref, command)),
                  )
                : provider.exec(ref, command),
          }),
          manager: (manager) => ({
            ...manager,
            provision: ({ provider }) =>
              Effect.gen(function* () {
                yield* provider.exec(ref, {
                  script: "# t3-sandbox-script: install\ntrue",
                  timeoutMs: 1_000,
                });
                yield* Deferred.await(syncStarted);
                yield* provider.startBackground(ref, {
                  script: "true",
                  logPath: "/tmp/server.log",
                });
                yield* Deferred.succeed(serverReady, undefined);
                return bootstrapFor(ref, "pair-new");
              }),
          }),
        });
        const vm = yield* Effect.gen(function* () {
          return yield* (yield* BoatVmService.BoatVmService).launch({ repository: repository() });
        }).pipe(Effect.provide(layer));
        assert.equal(
          git(vm.workspaceRoot, ["rev-parse", "HEAD"]),
          git(remote, ["rev-parse", "HEAD"]),
        );
        assert.sameMembers(
          record.written.map(({ path }) => path),
          ["~/.t3/launch-env", "~/.t3/boat-sync-env"],
        );
        assert.isTrue(NodeFS.existsSync(NodePath.join(homeOf("new"), ".t3", "launch-env")));
        assert.isFalse(NodeFS.existsSync(NodePath.join(homeOf("new"), ".t3", "boat-sync-env")));
      }),
  );

  it.effect("starts the repository sync while T3 installs, not after", () =>
    Effect.gen(function* () {
      const syncStarted = yield* Deferred.make<void>();
      const install = "# t3-sandbox-script: install\ntrue";
      const { layer } = makeHarness({
        provider: (provider) => ({
          ...provider,
          // The install finishes only once the sync has begun.
          exec: (ref, command) =>
            command.script === BoatVmService.SYNC_SCRIPT
              ? Deferred.succeed(syncStarted, undefined).pipe(
                  Effect.andThen(provider.exec(ref, command)),
                )
              : command.script === install
                ? Deferred.await(syncStarted).pipe(Effect.andThen(provider.exec(ref, command)))
                : provider.exec(ref, command),
        }),
        manager: (manager) => ({
          ...manager,
          provision: ({ provider }) =>
            Effect.gen(function* () {
              const ref: SandboxRef = { providerId: "boat", sandboxId: "new" };
              yield* provider.exec(ref, { script: install, timeoutMs: 1_000 });
              return bootstrapFor(ref, "pair-new");
            }),
        }),
      });
      const vm = yield* Effect.gen(function* () {
        return yield* (yield* BoatVmService.BoatVmService).launch({ repository: repository() });
      }).pipe(Effect.provide(layer));
      assert.equal(
        git(vm.workspaceRoot, ["rev-parse", "HEAD"]),
        git(remote, ["rev-parse", "HEAD"]),
      );
    }),
  );

  it.effect("cancels the repository sync if bootstrap fails", () =>
    Effect.gen(function* () {
      const syncStarted = yield* Deferred.make<void>();
      let cancelled = false;
      const { layer } = makeHarness({
        provider: (provider) => ({
          ...provider,
          startBackground: () => Effect.void,
          exec: (ref, command) =>
            command.script === BoatVmService.SYNC_SCRIPT
              ? Deferred.succeed(syncStarted, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(
                    Effect.sync(() => {
                      cancelled = true;
                    }),
                  ),
                )
              : provider.exec(ref, command),
        }),
        manager: (manager) => ({
          ...manager,
          provision: ({ provider }) =>
            Effect.gen(function* () {
              yield* provider.exec(
                { providerId: "boat", sandboxId: "new" },
                {
                  script: "# t3-sandbox-script: install\ntrue",
                  timeoutMs: 1_000,
                },
              );
              yield* Deferred.await(syncStarted);
              return yield* new SandboxEnvironmentError({ stage: "probe", detail: "not ready" });
            }),
        }),
      });
      yield* Effect.gen(function* () {
        return yield* Effect.flip(
          (yield* BoatVmService.BoatVmService).launch({ repository: repository() }),
        );
      }).pipe(Effect.provide(layer));
      assert.isTrue(cancelled);
      assert.isFalse(NodeFS.existsSync(NodePath.join(homeOf("new"), ".t3", "boat-sync-env")));
    }),
  );

  it.effect("can authenticate GitHub sync before the server installs a credential helper", () => {
    const { layer } = makeHarness({
      settings: {
        agentKeys: {
          ANTHROPIC_API_KEY: "",
          CLAUDE_CODE_OAUTH_TOKEN: "",
          OPENAI_API_KEY: "",
          GH_TOKEN: "github-test",
        },
      },
      provider: (provider) => ({
        ...provider,
        exec: (ref, input) =>
          provider.exec(
            ref,
            input.script !== BoatVmService.SYNC_SCRIPT
              ? input
              : {
                  ...input,
                  script: input.script.replace(
                    'EXPECTED="$(remote_identity "$REMOTE")"',
                    'printf "url=https://github.com/sample/app\\n\\n" | git credential fill > "$HOME/git-credential-check"\nEXPECTED="$(remote_identity "$REMOTE")"',
                  ),
                },
          ),
      }),
    });
    return Effect.gen(function* () {
      yield* (yield* BoatVmService.BoatVmService).launch({
        sandboxId: "old",
        repository: repository(),
      });
      const credentials = NodeFS.readFileSync(
        NodePath.join(homeOf("old"), "git-credential-check"),
        "utf8",
      );
      assert.include(credentials, "username=x-access-token\n");
      assert.include(credentials, "password=github-test\n");
    }).pipe(Effect.provide(layer));
  });

  it.effect("starts a new VM from the general snapshot when the repository has none", () => {
    const { record, layer } = makeHarness({ snapshots: ["t3-base"] });
    return Effect.gen(function* () {
      const vms = yield* BoatVmService.BoatVmService;

      const launched = yield* vms.launch({ repository: repository() });

      assert.deepEqual(
        record.targets.map((target) => target.snapshot),
        ["t3-acme-app", "t3-base"],
      );
      assert.equal(record.targets[0]!.label, "t3:Acme/app");
      assert.equal(record.targets[0]!.idleTimeoutMinutes, 30);
      assert.equal(record.targets[0]!.size, "small");
      // The keys never become boat sandbox env, which snapshots would copy.
      assert.deepEqual(record.provisionEnv, {});
      assert.deepEqual(record.written, [
        {
          path: "~/.t3/boat-sync-env",
          content: "ANTHROPIC_API_KEY='sk-test'\nT3_GIT_ALLOW_PUSH='0'\n",
        },
      ]);
      assert.isFalse(NodeFS.existsSync(NodePath.join(homeOf("new"), ".t3", "boat-sync-env")));
      assert.deepEqual(record.resets, ["new"]);
      assert.deepEqual(launched, {
        sandboxId: "new",
        label: "Acme/app",
        httpBaseUrl: "https://t3-vm-new.tail.ts.net",
        pairingCode: "pair-new",
        workspaceRoot: NodePath.join(homeOf("new"), "work", "app"),
      });
      assert.equal(
        NodeFS.readFileSync(NodePath.join(launched.workspaceRoot, "app.ts"), "utf8"),
        "export const app = 1;\n",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("creates a bare VM when no snapshot exists", () => {
    const { record, layer } = makeHarness({});
    return Effect.gen(function* () {
      yield* (yield* BoatVmService.BoatVmService).launch({ repository: repository() });

      assert.deepEqual(
        record.targets.map((target) => target.snapshot),
        ["t3-acme-app", "t3-base", undefined],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("falls back to the configured base snapshot, or none when it is empty", () =>
    Effect.gen(function* () {
      for (const [boatVmBaseSnapshot, expected] of [
        ["team-base", ["t3-acme-app", "team-base", undefined]],
        ["", ["t3-acme-app", undefined]],
      ] as const) {
        const { record, layer } = makeHarness({ settings: { boatVmBaseSnapshot } });
        yield* Effect.gen(function* () {
          yield* (yield* BoatVmService.BoatVmService).launch({ repository: repository() });
        }).pipe(Effect.provide(layer));
        assert.deepEqual(
          record.targets.map((target) => target.snapshot),
          [...expected],
        );
      }
    }),
  );

  it.effect("gives a launch without a repository a scratch folder and no repository snapshot", () =>
    Effect.gen(function* () {
      for (const [boatVmBaseSnapshot, snapshots, expected] of [
        ["t3-base", ["t3-base"], ["t3-base"]],
        ["t3-base", [], ["t3-base", undefined]],
        ["", [], [undefined]],
      ] as const) {
        const { record, layer } = makeHarness({ snapshots, settings: { boatVmBaseSnapshot } });
        const launched = yield* Effect.gen(function* () {
          return yield* (yield* BoatVmService.BoatVmService).launch({});
        }).pipe(Effect.provide(layer));

        assert.deepEqual(
          record.targets.map((target) => target.snapshot),
          [...expected],
        );
        assert.equal(record.targets[0]!.label, "t3:no-project");
        // No sync, so no sync env file with the keys.
        assert.deepEqual(record.written, []);
        assert.deepEqual(launched, {
          sandboxId: "new",
          label: "scratch",
          httpBaseUrl: "https://t3-vm-new.tail.ts.net",
          pairingCode: "pair-new",
          workspaceRoot: NodePath.join(homeOf("new"), ".t3", "scratch"),
        });
        assert.isTrue(NodeFS.statSync(launched.workspaceRoot).isDirectory());
        assert.isFalse(NodeFS.existsSync(NodePath.join(homeOf("new"), "work")));
        NodeFS.rmSync(homeOf("new"), { recursive: true, force: true });
      }
    }),
  );

  it.effect("resumes an existing VM without a repository into its scratch folder", () => {
    const { record, layer } = makeHarness({});
    return Effect.gen(function* () {
      const launched = yield* (yield* BoatVmService.BoatVmService).launch({ sandboxId: "old" });

      assert.deepEqual(record.reconnects, ["old"]);
      assert.deepEqual(record.targets, []);
      assert.equal(launched.workspaceRoot, NodePath.join(homeOf("old"), ".t3", "scratch"));
      assert.isTrue(NodeFS.statSync(launched.workspaceRoot).isDirectory());
    }).pipe(Effect.provide(layer));
  });

  it.effect("names only the base snapshot when a launch without a repository finds none", () => {
    const { layer } = makeHarness({
      settings: { tailscaleAuthKey: "", boatVmTailscale: "snapshot", boatVmBaseSnapshot: "" },
    });
    return Effect.gen(function* () {
      const error = yield* (yield* BoatVmService.BoatVmService).launch({}).pipe(Effect.flip);
      assert.include(error.message, "Set a Base snapshot");
    }).pipe(Effect.provide(layer));
  });

  it.effect("removes a new VM whose launch fails, but keeps a resumed one", () =>
    Effect.gen(function* () {
      const missing = { ...repository(), remoteUrl: "/nonexistent/repository.git" };
      for (const [sandboxId, removed] of [
        [undefined, ["new"]],
        ["old", []],
      ] as const) {
        const { record, layer } = makeHarness({ snapshots: ["t3-base"] });
        const error = yield* Effect.gen(function* () {
          return yield* (yield* BoatVmService.BoatVmService).launch({
            repository: missing,
            ...(sandboxId === undefined ? {} : { sandboxId }),
          });
        }).pipe(Effect.provide(layer), Effect.flip);

        assert.include(error.message, "could not clone or pull");
        assert.deepEqual(record.destroyed, [...removed]);
        assert.deepEqual(
          record.tailnetJoins
            .filter((join) => join.script === BoatVmService.TAILNET_LOGOUT_SCRIPT)
            .map((join) => join.sandboxId),
          [...removed],
        );
      }
    }),
  );

  it.effect("reports a launch's stages in order, for a new VM and a resume", () =>
    Effect.gen(function* () {
      const created: SandboxInfo = {
        ref: { providerId: "boat", sandboxId: "new" },
        status: "running",
        label: "vm Acme/app",
      };
      let launches: BoatVmService.BoatVmService["Service"]["launches"] | undefined;
      const seen: Array<string> = [];
      // The stream keeps only the latest list, so the steps sample it as they run.
      const sample = Effect.suspend(() => Stream.runHead(launches!)).pipe(
        Effect.map((list) => {
          const launch = Option.getOrThrow(list).find((entry) => entry.launchId === "launch-1");
          seen.push(
            launch === undefined
              ? "none"
              : [launch.stage, launch.detail, launch.sandboxId, launch.status]
                  .filter((part) => part !== undefined)
                  .join(" "),
          );
        }),
      );
      const bringUp = (provider: SandboxProviderShape, ref: SandboxRef) =>
        Effect.gen(function* () {
          yield* provider.exec(ref, {
            script: "# t3-sandbox-script: install\ntrue",
            timeoutMs: 1_000,
          });
          yield* sample;
          yield* provider.exec(ref, {
            script: "# t3-sandbox-script: launch\ntrue",
            timeoutMs: 1_000,
          });
          yield* sample;
          yield* provider.exposePort(ref, 3773);
          yield* sample;
          return bootstrapFor(ref, "pair");
        });
      const { layer } = makeHarness({
        snapshots: ["t3-acme-app"],
        provider: (provider) => ({ ...provider, create: () => Effect.succeed(created) }),
        manager: (manager) => ({
          ...manager,
          provision: ({ provider, target }) =>
            Effect.gen(function* () {
              const info = yield* provider.create({
                label: target.label,
                env: {},
                size: target.size,
                idleTimeoutMinutes: target.idleTimeoutMinutes,
                idempotencyKey: "key",
                ...(target.snapshot === undefined ? {} : { snapshot: target.snapshot }),
              });
              yield* sample;
              return yield* bringUp(provider, info.ref);
            }),
          reconnect: ({ provider, ref }) => sample.pipe(Effect.andThen(bringUp(provider, ref))),
        }),
      });
      yield* Effect.gen(function* () {
        const vms = yield* BoatVmService.BoatVmService;
        launches = vms.launches;
        for (const [sandboxId, withRepository] of [
          [undefined, true],
          ["old", true],
          [undefined, false],
        ] as const) {
          yield* vms.launch({
            ...(withRepository ? { repository: repository() } : {}),
            launchId: "launch-1",
            ...(sandboxId === undefined ? {} : { sandboxId }),
          });
          yield* sample;
        }
      }).pipe(Effect.provide(layer));

      assert.deepEqual(seen, [
        "creating t3-acme-app new running",
        "installing new running",
        "starting new running",
        "tailscale new running",
        "syncing new done",
        "resuming old running",
        "installing old running",
        "starting old running",
        "tailscale old running",
        "syncing old done",
        "creating t3-base new running",
        "installing new running",
        "starting new running",
        "tailscale new running",
        "preparing new done",
      ]);
    }),
  );

  it.effect("cancels a launch, removing a new VM but not a resumed one", () =>
    Effect.gen(function* () {
      for (const [sandboxId, removed] of [
        [undefined, ["new"]],
        ["old", []],
      ] as const) {
        const installed = yield* Deferred.make<void>();
        const hang = (provider: SandboxProviderShape, ref: SandboxRef) =>
          provider
            .exec(ref, { script: "# t3-sandbox-script: install\ntrue", timeoutMs: 1_000 })
            .pipe(
              Effect.andThen(Deferred.succeed(installed, undefined)),
              Effect.andThen(Effect.never),
            );
        const { record, layer } = makeHarness({
          provider: (provider) => ({
            ...provider,
            create: () =>
              Effect.succeed({
                ref: { providerId: "boat", sandboxId: "new" },
                status: "running",
                label: "vm Acme/app",
              }),
          }),
          manager: (manager) => ({
            ...manager,
            provision: ({ provider, target }) =>
              provider
                .create({
                  label: target.label,
                  env: {},
                  size: target.size,
                  idleTimeoutMinutes: target.idleTimeoutMinutes,
                  idempotencyKey: "key",
                })
                .pipe(Effect.flatMap((info) => hang(provider, info.ref))),
            reconnect: ({ provider, ref }) => hang(provider, ref),
          }),
        });
        const { error, applied, after } = yield* Effect.gen(function* () {
          const vms = yield* BoatVmService.BoatVmService;
          const launching = yield* Effect.forkChild(
            vms.launch({
              repository: repository(),
              launchId: "launch-2",
              ...(sandboxId === undefined ? {} : { sandboxId }),
            }),
          );
          yield* Deferred.await(installed);
          const { applied } = yield* vms.cancelLaunch({ launchId: "launch-2" });
          const error = yield* Effect.flip(Fiber.join(launching));
          const after = Option.getOrThrow(yield* Stream.runHead(vms.launches));
          return { error, applied, after };
        }).pipe(Effect.provide(layer));

        assert.isTrue(applied);
        assert.include(error.message, "cancelled");
        assert.deepEqual(
          after.map((launch) => launch.status),
          ["cancelled"],
        );
        assert.deepEqual(record.destroyed, [...removed]);
        assert.deepEqual(
          record.tailnetJoins
            .filter((join) => join.script === BoatVmService.TAILNET_LOGOUT_SCRIPT)
            .map((join) => join.sandboxId),
          [...removed],
        );
      }
    }),
  );

  it.effect("keeps launching a new VM when the client that started it goes away", () =>
    Effect.gen(function* () {
      const installed = yield* Deferred.make<void>();
      const { record, layer } = makeHarness({
        manager: (manager) => ({
          ...manager,
          provision: ({ provider }) =>
            provider
              .exec(
                { providerId: "boat", sandboxId: "new" },
                { script: "# t3-sandbox-script: install\ntrue", timeoutMs: 1_000 },
              )
              .pipe(
                Effect.andThen(Deferred.succeed(installed, undefined)),
                Effect.andThen(Effect.never),
              ),
        }),
      });
      const { status, destroyed } = yield* Effect.gen(function* () {
        const vms = yield* BoatVmService.BoatVmService;
        const waiting = yield* Effect.forkChild(
          vms.launch({ repository: repository(), launchId: "launch-3" }),
        );
        yield* Deferred.await(installed);
        yield* Fiber.interrupt(waiting);
        const list = Option.getOrThrow(yield* Stream.runHead(vms.launches));
        return {
          status: list.find((launch) => launch.launchId === "launch-3")?.status,
          destroyed: [...record.destroyed],
        };
      }).pipe(Effect.provide(layer));

      assert.equal(status, "running");
      assert.deepEqual(destroyed, []);
    }),
  );

  it.effect("launches from a snapshot without a Tailscale auth key", () => {
    const { record, layer } = makeHarness({
      snapshots: ["t3-base"],
      settings: { tailscaleAuthKey: "", boatVmTailscale: "snapshot" },
    });
    return Effect.gen(function* () {
      const launched = yield* (yield* BoatVmService.BoatVmService).launch({
        repository: repository(),
      });

      assert.equal(launched.sandboxId, "new");
      assert.deepEqual(
        record.targets.map((target) => target.snapshot),
        ["t3-acme-app", "t3-base"],
      );
      assert.isFalse(record.written.some((write) => write.path === BoatVmService.TAILNET_KEY_PATH));
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not fall back to a bare VM when the snapshot must join Tailscale", () => {
    const { record, layer } = makeHarness({
      settings: { tailscaleAuthKey: "", boatVmTailscale: "snapshot" },
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        (yield* BoatVmService.BoatVmService).launch({ repository: repository() }),
      );

      assert.include(error.message, "No Boat snapshot was found");
      assert.include(error.message, "automatic Tailscale setup");
      assert.deepEqual(
        record.targets.map((target) => target.snapshot),
        ["t3-acme-app", "t3-base"],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("creates a bare VM over the Boat relay even with snapshot Tailscale", () => {
    const { record, layer } = makeHarness({
      settings: {
        tailscaleAuthKey: "",
        boatVmConnectionMode: "boat",
        boatVmTailscale: "snapshot",
      },
    });
    return Effect.gen(function* () {
      yield* (yield* BoatVmService.BoatVmService).launch({ repository: repository() });

      assert.deepEqual(
        record.targets.map((target) => target.snapshot),
        ["t3-acme-app", "t3-base", undefined],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("connects over the Boat relay and joins the tailnet only for direct ports", () =>
    Effect.gen(function* () {
      for (const [settings, tailnetHttpBaseUrl] of [
        [{ tailscaleAuthKey: "tskey-test" }, "http://t3-vm-new.tail.ts.net"],
        [{ tailscaleAuthKey: "" }, undefined],
        [{ boatVmTailscale: "off" }, undefined],
      ] as const) {
        const { record, layer } = makeHarness({
          settings: { ...settings, boatVmConnectionMode: "boat" },
        });
        const launched = yield* Effect.gen(function* () {
          return yield* (yield* BoatVmService.BoatVmService).launch({
            repository: repository(),
          });
        }).pipe(Effect.provide(layer));

        assert.equal(launched.httpBaseUrl, "https://t3-vm-new.tail.ts.net");
        assert.deepEqual(launched.boatProxy, {
          token: "proxy-token",
          ...(tailnetHttpBaseUrl === undefined ? {} : { tailnetHttpBaseUrl }),
        });
        assert.deepEqual(
          record.tailnetJoins.map((join) => join.script),
          tailnetHttpBaseUrl === undefined ? [] : [BoatVmService.TAILNET_SCRIPT],
        );
      }
    }),
  );

  it.effect("sizes a new VM by the launch's size over the boat VM size", () => {
    const { record, layer } = makeHarness({
      snapshots: ["t3-base"],
      settings: { boatVmSize: "medium" },
    });
    return Effect.gen(function* () {
      yield* (yield* BoatVmService.BoatVmService).launch({
        repository: repository(),
        size: "large",
      });

      assert.deepEqual(
        record.targets.map((target) => target.size),
        ["large", "large"],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("sizes VMs by the boat VM size, not the jobs' default size", () => {
    const { record, layer } = makeHarness({
      snapshots: ["t3-base"],
      settings: { defaultSize: "small", boatVmSize: "large" },
    });
    return Effect.gen(function* () {
      yield* (yield* BoatVmService.BoatVmService).launch({ repository: repository() });

      assert.deepEqual(
        record.targets.map((target) => target.size),
        ["large", "large"],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("resumes an existing VM, pulls the repository and restarts its idle window", () => {
    const { record, layer } = makeHarness({});
    return Effect.gen(function* () {
      const vms = yield* BoatVmService.BoatVmService;
      const first = yield* vms.launch({ sandboxId: "old", repository: repository() });
      NodeFS.writeFileSync(NodePath.join(remote, "app.ts"), "export const app = 2;\n");
      git(remote, ["commit", "--quiet", "-am", "next"]);

      const second = yield* vms.launch({ sandboxId: "old", repository: repository() });

      assert.deepEqual(record.reconnects, ["old", "old"]);
      assert.equal(record.targets.length, 0);
      assert.deepEqual(record.extended, [
        { sandboxId: "old", minutes: 30 },
        { sandboxId: "old", minutes: 30 },
      ]);
      assert.equal(second.workspaceRoot, first.workspaceRoot);
      assert.equal(second.pairingCode, "pair-again");
      assert.equal(
        NodeFS.readFileSync(NodePath.join(second.workspaceRoot, "app.ts"), "utf8"),
        "export const app = 2;\n",
      );
      assert.isUndefined(second.warning);
    }).pipe(Effect.provide(layer));
  });

  it.effect("links a VM on the tailnet back here on every launch and resume, by file", () => {
    const managerUrl = "https://manager.example.test";
    const { record, layer } = makeHarness({ managerUrl });
    return Effect.gen(function* () {
      const vms = yield* BoatVmService.BoatVmService;
      yield* vms.launch({ repository: repository() });
      yield* vms.launch({ sandboxId: "old", repository: repository() });

      assert.deepEqual(record.managerAccess, ["grant:new", "grant:old"]);
      assert.deepEqual(
        record.managerLinks.map(({ sandboxId, request }) => ({
          sandboxId,
          request: JSON.parse(request),
        })),
        [
          { sandboxId: "new", request: { managerUrl, pairingCode: "code-new" } },
          { sandboxId: "old", request: { managerUrl, pairingCode: "code-old" } },
        ],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not link a VM reached only over the Boat relay", () => {
    const { record, layer } = makeHarness({
      managerUrl: "https://manager.example.test",
      settings: { tailscaleAuthKey: "", boatVmConnectionMode: "boat" },
    });
    return Effect.gen(function* () {
      yield* (yield* BoatVmService.BoatVmService).launch({ repository: repository() });
      assert.deepEqual(record.managerAccess, []);
      assert.deepEqual(record.managerLinks, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("launches without the link when this server has no tailnet origin", () => {
    const { record, layer } = makeHarness({});
    return Effect.gen(function* () {
      yield* (yield* BoatVmService.BoatVmService).launch({ repository: repository() });
      assert.deepEqual(record.managerAccess, ["grant:new"]);
      assert.deepEqual(record.managerLinks, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "reuses a snapshot checkout whose origin spells the same repository differently",
    () => {
      const { layer } = makeHarness({});
      return Effect.gen(function* () {
        const vms = yield* BoatVmService.BoatVmService;
        const first = yield* vms.launch({ sandboxId: "old", repository: repository() });
        for (const origin of [
          "git@github.com:Sample/App.git",
          "https://x-access-token@github.com/sample/app/",
        ]) {
          git(first.workspaceRoot, ["remote", "set-url", "origin", origin]);
          git(first.workspaceRoot, ["config", `url.${remote}.insteadOf`, origin]);

          const second = yield* vms.launch({
            sandboxId: "old",
            repository: { ...repository(), remoteUrl: "https://github.com/sample/app" },
          });

          assert.equal(second.workspaceRoot, first.workspaceRoot);
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("does not reuse an SSH checkout on a custom port for an HTTPS repository", () => {
    const { layer } = makeHarness({});
    return Effect.gen(function* () {
      const vms = yield* BoatVmService.BoatVmService;
      const first = yield* vms.launch({ sandboxId: "old", repository: repository() });
      const sshOrigin = "ssh://git@github.com:2222/sample/app.git";
      const httpsRemote = "https://github.com/sample/app";
      git(first.workspaceRoot, ["remote", "set-url", "origin", sshOrigin]);
      git(first.workspaceRoot, ["config", `url.${remote}.insteadOf`, sshOrigin]);
      git(homeOf("old"), [
        "config",
        "--file",
        NodePath.join(homeOf("old"), ".gitconfig"),
        `url.${remote}.insteadOf`,
        httpsRemote,
      ]);

      const second = yield* vms.launch({
        sandboxId: "old",
        repository: { ...repository(), remoteUrl: httpsRemote },
      });

      assert.notEqual(second.workspaceRoot, first.workspaceRoot);
      assert.equal(
        git(first.workspaceRoot, ["config", "--get", "remote.origin.url"]).trim(),
        sshOrigin,
      );
      assert.isTrue(NodeFS.existsSync(NodePath.join(second.workspaceRoot, "app.ts")));
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "keeps a different repository with the same name and reuses the correct checkout",
    () => {
      const { layer } = makeHarness({});
      const otherRemote = NodePath.join(scratch, "other", "remote");
      NodeFS.mkdirSync(otherRemote, { recursive: true });
      git(otherRemote, ["init", "--quiet", "--initial-branch=main"]);
      NodeFS.writeFileSync(NodePath.join(otherRemote, "other.ts"), "export const other = 1;\n");
      git(otherRemote, ["add", "."]);
      git(otherRemote, ["commit", "--quiet", "-m", "base"]);

      return Effect.gen(function* () {
        const vms = yield* BoatVmService.BoatVmService;
        const first = yield* vms.launch({ sandboxId: "old", repository: repository() });
        const input = {
          sandboxId: "old",
          repository: { ...repository(), owner: "Other", remoteUrl: otherRemote },
        };
        const second = yield* vms.launch(input);
        const again = yield* vms.launch(input);

        assert.notEqual(second.workspaceRoot, first.workspaceRoot);
        assert.equal(again.workspaceRoot, second.workspaceRoot);
        assert.equal(git(first.workspaceRoot, ["remote", "get-url", "origin"]).trim(), remote);
        assert.equal(
          git(second.workspaceRoot, ["remote", "get-url", "origin"]).trim(),
          otherRemote,
        );
        assert.isTrue(NodeFS.existsSync(NodePath.join(first.workspaceRoot, "app.ts")));
        assert.isTrue(NodeFS.existsSync(NodePath.join(second.workspaceRoot, "other.ts")));
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("says when the VM's checkout is left as it is", () => {
    const { layer } = makeHarness({});
    return Effect.gen(function* () {
      const vms = yield* BoatVmService.BoatVmService;
      const first = yield* vms.launch({ sandboxId: "old", repository: repository() });
      NodeFS.writeFileSync(NodePath.join(first.workspaceRoot, "app.ts"), "export const app = 3;\n");
      NodeFS.writeFileSync(NodePath.join(remote, "app.ts"), "export const app = 2;\n");
      git(remote, ["commit", "--quiet", "-am", "next"]);

      const dirty = yield* vms.launch({ sandboxId: "old", repository: repository() });
      git(first.workspaceRoot, ["commit", "--quiet", "-am", "local"]);
      const diverged = yield* vms.launch({ sandboxId: "old", repository: repository() });

      assert.include(dirty.warning, "uncommitted changes");
      assert.include(diverged.warning, "could not fast-forward");
      assert.equal(
        NodeFS.readFileSync(NodePath.join(first.workspaceRoot, "app.ts"), "utf8"),
        "export const app = 3;\n",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "refuses to launch without a Tailscale key, and lists nothing without a boat key",
    () => {
      const { layer } = makeHarness({ settings: { tailscaleAuthKey: "" } });
      const { layer: tailscaleOff } = makeHarness({ settings: { boatVmTailscale: "off" } });
      const { layer: keyless } = makeHarness({
        settings: { providerKeys: { boat: "" } },
      });
      return Effect.gen(function* () {
        const error = yield* Effect.flip(
          (yield* BoatVmService.BoatVmService).launch({ repository: repository() }),
        );
        assert.include(error.message, "Tailscale auth key");
        const offError = yield* Effect.flip(
          BoatVmService.BoatVmService.pipe(
            Effect.flatMap((vms) => vms.launch({ repository: repository() })),
            Effect.provide(tailscaleOff),
          ),
        );
        assert.include(offError.message, "Tailscale is off");
        const listed = yield* BoatVmService.BoatVmService.pipe(
          Effect.flatMap((vms) => vms.list),
          Effect.provide(keyless),
        );
        assert.deepEqual(listed, { available: false, vms: [] });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("lists VMs named either way, with their repository and task", () => {
    const vm = (sandboxId: string, label: string) => ({
      ref: { providerId: "boat" as const, sandboxId },
      status: "stopped" as const,
      label,
    });
    const { layer } = makeHarness({
      vms: [
        vm("legacy", "vm Acme/app"),
        vm("named", "t3:Acme/app:Fix the login: again"),
        vm("bare", "t3:Acme/app"),
        vm("scratch", "t3:no-project:Explore"),
        vm("job-node", "sandbox job 1"),
      ],
    });
    return Effect.gen(function* () {
      const listed = yield* (yield* BoatVmService.BoatVmService).list;
      assert.deepEqual(listed.vms, [
        { sandboxId: "legacy", label: "Acme/app", status: "stopped" },
        { sandboxId: "named", label: "Acme/app", status: "stopped", task: "Fix the login: again" },
        { sandboxId: "bare", label: "Acme/app", status: "stopped" },
        { sandboxId: "scratch", label: "scratch", status: "stopped", task: "Explore" },
      ]);
    }).pipe(Effect.provide(layer));
  });
});

describe("boat VM bring home", () => {
  const stoppedVm: SandboxInfo = {
    ref: { providerId: "boat", sandboxId: "old" },
    status: "stopped",
    label: "vm Acme/app",
  };
  const localCheckout = () => {
    const local = NodePath.join(scratch, "local");
    git(scratch, ["clone", "--quiet", remote, local]);
    return local;
  };
  const projectFor = (local: string) => ({
    workspaceRoot: local,
    repositoryIdentity: {
      canonicalKey: normalizeGitRemoteUrl(remote),
      locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: remote },
      rootPath: local,
    },
  });

  it.effect("fetches the VM's branches under refs/t3/boat without touching local branches", () => {
    const local = localCheckout();
    const { record, layer } = makeHarness({ vms: [stoppedVm], projects: [projectFor(local)] });
    return Effect.gen(function* () {
      const vms = yield* BoatVmService.BoatVmService;
      const { workspaceRoot } = yield* vms.launch({ sandboxId: "old", repository: repository() });
      git(workspaceRoot, ["switch", "--quiet", "-c", "feature"]);
      NodeFS.writeFileSync(NodePath.join(workspaceRoot, "app.ts"), "export const app = 3;\n");
      git(workspaceRoot, ["commit", "--quiet", "-am", "on the VM"]);
      NodeFS.writeFileSync(NodePath.join(workspaceRoot, "draft.ts"), "unsaved\n");

      const brought = yield* vms.bringHome({ sandboxId: "old" });

      assert.deepEqual(record.resumed, ["old"]);
      assert.deepEqual(brought, {
        checkouts: [
          {
            repositoryRoot: local,
            refs: ["refs/t3/boat/old/feature", "refs/t3/boat/old/main"],
            uncommitted: true,
          },
        ],
        unmatched: [],
      });
      assert.equal(
        git(local, ["rev-parse", "refs/t3/boat/old/feature"]),
        git(workspaceRoot, ["rev-parse", "HEAD"]),
      );
      assert.equal(git(local, ["branch", "--format=%(refname:short)"]), "main\n");
      assert.deepEqual(
        NodeFS.readdirSync(homeOf("old")).filter((name) => name.startsWith(".t3-bring-home.")),
        [],
      );

      // A branch deleted on the VM goes from the local mirror too.
      git(workspaceRoot, ["switch", "--quiet", "main"]);
      git(workspaceRoot, ["branch", "--quiet", "-D", "feature"]);
      const again = yield* vms.bringHome({ sandboxId: "old" });
      assert.deepEqual(again.checkouts[0]!.refs, ["refs/t3/boat/old/main"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("names the checkout when this environment has no project for it", () => {
    const { layer } = makeHarness({ vms: [stoppedVm], projects: [] });
    return Effect.gen(function* () {
      const vms = yield* BoatVmService.BoatVmService;
      yield* vms.launch({ sandboxId: "old", repository: repository() });

      const error = yield* Effect.flip(vms.bringHome({ sandboxId: "old" }));

      assert.include(error.message, "No project here is a checkout of app.");
    }).pipe(Effect.provide(layer));
  });
});

describe("boat VM tailnet", () => {
  it.effect("prepares snapshot HTTPS while bootstrap continues and shares its result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const connected = yield* Deferred.make<void>();
        let preparations = 0;
        const provider = BoatVmService.withTailnet(
          {
            ...makeFakeSandboxProvider({ id: "boat" }),
            exec: (_ref, command) =>
              command.script === BoatVmService.SNAPSHOT_TAILNET_SCRIPT
                ? Effect.gen(function* () {
                    preparations += 1;
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(connected);
                    return { exitCode: 0, stdout: "existing.tail.ts.net", stderr: "" };
                  })
                : Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
          },
          "",
          true,
          yield* Effect.scope,
        );
        const ref: SandboxRef = { providerId: "boat", sandboxId: "clone" };
        yield* provider.exec(ref, {
          script: "# t3-sandbox-script: install\ntrue",
          timeoutMs: 1_000,
        });
        yield* Deferred.await(started);
        yield* Deferred.succeed(connected, undefined);
        assert.equal(
          (yield* provider.exposePort(ref, 3773)).httpBaseUrl,
          "https://existing.tail.ts.net",
        );
        assert.equal(
          (yield* provider.exposePort(ref, 3773)).httpBaseUrl,
          "https://existing.tail.ts.net",
        );
        assert.equal(preparations, 1);
      }),
    ),
  );

  const shell = (statuses: ReadonlyArray<unknown>) => {
    const home = homeOf("tailnet");
    const bin = NodePath.join(home, "bin");
    NodeFS.mkdirSync(bin);
    const scripts = {
      sudo: 'case "$1" in tailscale) exec "$@" ;; *) exit 99 ;; esac\n',
      sleep: ":\n",
      tailscale: `printf '%s\\n' "$*" >>"$HOME/commands"
if [ "$1" = status ]; then
  count="$(cat "$HOME/status-count" 2>/dev/null || printf 0)"
  count=$((count + 1))
  printf '%s' "$count" >"$HOME/status-count"
  if [ -f "$HOME/status-$count" ]; then cat "$HOME/status-$count"; else cat "$HOME/status-1"; fi
fi
`,
    };
    for (const [name, script] of Object.entries(scripts)) {
      NodeFS.writeFileSync(NodePath.join(bin, name), `#!/bin/sh\n${script}`, { mode: 0o755 });
    }
    statuses.forEach((status, index) =>
      NodeFS.writeFileSync(NodePath.join(home, `status-${index + 1}`), JSON.stringify(status)),
    );
    return {
      home,
      run: (script: string, args: ReadonlyArray<string> = []) =>
        NodeChildProcess.spawnSync("sh", ["-s", ...args], {
          input: script,
          encoding: "utf8",
          env: { PATH: `${bin}:${hostPath}`, HOME: home },
          timeout: 15_000,
        }),
      commands: () => NodeFS.readFileSync(NodePath.join(home, "commands"), "utf8"),
    };
  };

  it("resets cloned T3 data while preserving the snapshot's Tailscale identity", () => {
    const vm = shell([]);
    const data = NodePath.join(vm.home, ".t3", "userdata");
    NodeFS.mkdirSync(data, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(data, "source-identity"), "source");
    NodeFS.writeFileSync(NodePath.join(vm.home, ".t3", "boat-vm-id"), "source");
    // Any privileged reset would fail: the snapshot must own tailscaled state.
    NodeFS.writeFileSync(NodePath.join(vm.home, "bin", "sudo"), "#!/bin/sh\nexit 99\n");

    const reset = vm.run(BoatVmService.CLONE_RESET_SCRIPT, ["clone", "snapshot"]);

    assert.equal(reset.status, 0, reset.stderr);
    assert.isFalse(NodeFS.existsSync(data));
    assert.equal(NodeFS.readFileSync(NodePath.join(vm.home, ".t3", "boat-vm-id"), "utf8"), "clone");
    NodeFS.mkdirSync(data);
    NodeFS.writeFileSync(NodePath.join(data, "clone-identity"), "clone");
    assert.equal(vm.run(BoatVmService.CLONE_RESET_SCRIPT, ["clone", "snapshot"]).status, 0);
    assert.isTrue(NodeFS.existsSync(NodePath.join(data, "clone-identity")));
  });

  it.effect(
    "waits for the snapshot's connected DNS name and serves it without a key or login",
    () => {
      const vm = shell([
        { BackendState: "Starting", Self: { DNSName: "existing.tail.ts.net." } },
        { BackendState: "Running", Self: {} },
        { BackendState: "Running", Self: { DNSName: "invalid/name", Online: true } },
        { BackendState: "Running", Self: { DNSName: "existing.tail.ts.net.", Online: true } },
      ]);
      const provider = BoatVmService.withTailnet(
        {
          ...makeFakeSandboxProvider({ id: "boat" }),
          writeFile: () => Effect.die("Snapshot mode must not write a Tailscale auth key"),
          exec: (_ref, input) =>
            Effect.sync(() => {
              const result = vm.run(input.script, input.args);
              return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
            }),
        },
        "",
        true,
      );
      return Effect.gen(function* () {
        yield* provider.exec(
          { providerId: "boat", sandboxId: "clone" },
          { script: "# t3-sandbox-script: install\ntrue", timeoutMs: 1_000 },
        );
        assert.include(vm.commands(), "serve --bg --https=443");
        const exposed = yield* provider.exposePort(
          { providerId: "boat", sandboxId: "clone" },
          3773,
        );

        assert.equal(exposed.httpBaseUrl, "https://existing.tail.ts.net");
        assert.equal(
          vm.commands(),
          "status --json\n".repeat(4) + "serve --bg --https=443 http://127.0.0.1:3773\n",
        );
      });
    },
  );

  it("times out without exposing a disconnected snapshot", () => {
    const vm = shell([{ BackendState: "NeedsLogin", Self: { DNSName: "old.tail.ts.net." } }]);

    const result = vm.run(BoatVmService.SNAPSHOT_TAILNET_SCRIPT);

    assert.equal(result.status, 3, result.stderr);
    assert.include(result.stderr, "did not connect to Tailscale within 120 seconds");
    assert.equal(vm.commands(), "status --json\n".repeat(60));
    assert.equal(result.stdout, "");
  });

  it.effect("exposes snapshot HTTP without requesting a TLS certificate", () => {
    const vm = shell([
      { BackendState: "Running", Self: { DNSName: "existing.tail.ts.net.", Online: true } },
    ]);
    const provider = BoatVmService.withTailnet(
      {
        ...makeFakeSandboxProvider({ id: "boat" }),
        exec: (_ref, input) =>
          Effect.sync(() => {
            const result = vm.run(input.script, input.args);
            return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
          }),
      },
      "",
      true,
      undefined,
      "http",
    );
    return Effect.gen(function* () {
      const endpoint = yield* provider.exposePort({ providerId: "boat", sandboxId: "clone" }, 3773);
      assert.equal(endpoint.httpBaseUrl, "http://existing.tail.ts.net");
      assert.equal(vm.commands(), "status --json\nserve --bg --http=80 http://127.0.0.1:3773\n");
    });
  });

  it("logs a snapshot VM in with the saved key only after it stays logged out", () => {
    const needsLogin = { BackendState: "NeedsLogin", Self: {} };
    const vm = shell([
      ...Array.from({ length: 46 }, () => needsLogin),
      { BackendState: "Running", Self: { DNSName: "rescued.tail.ts.net.", Online: true } },
    ]);
    NodeFS.mkdirSync(NodePath.join(vm.home, ".t3"));
    NodeFS.writeFileSync(NodePath.join(vm.home, ".t3", "tailscale-authkey"), "saved-key");

    const result = vm.run(BoatVmService.SNAPSHOT_TAILNET_SCRIPT, ["http"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "rescued.tail.ts.net");
    assert.equal(
      vm.commands(),
      "status --json\n".repeat(46) +
        "up --reset --auth-key=saved-key\nstatus --json\nserve --bg --http=80 http://127.0.0.1:3773\n",
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(vm.home, ".t3", "tailscale-authkey")));
  });

  it("logs in a resumed snapshot VM that reports Running from saved state but is offline", () => {
    // A resumed VM whose ephemeral node was removed keeps its old name and Running state.
    const stale = {
      BackendState: "Running",
      Self: { DNSName: "old.tail.ts.net.", HostName: "sfvm-old", Online: false },
    };
    const vm = shell([
      ...Array.from({ length: 46 }, () => stale),
      { BackendState: "Running", Self: { DNSName: "rescued.tail.ts.net.", Online: true } },
    ]);
    NodeFS.mkdirSync(NodePath.join(vm.home, ".t3"));
    NodeFS.writeFileSync(NodePath.join(vm.home, ".t3", "tailscale-authkey"), "saved-key");

    const result = vm.run(BoatVmService.SNAPSHOT_TAILNET_SCRIPT, ["http"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "rescued.tail.ts.net");
    assert.equal(
      vm.commands(),
      "status --json\n".repeat(46) +
        "up --reset --auth-key=saved-key --hostname=sfvm-old\nstatus --json\nserve --bg --http=80 http://127.0.0.1:3773\n",
    );
  });

  it("joins with an auth key and serves plain HTTP when requested", () => {
    const vm = shell([{ BackendState: "Running", Self: { DNSName: "joined.tail.ts.net." } }]);
    NodeFS.mkdirSync(NodePath.join(vm.home, ".t3"));
    NodeFS.writeFileSync(NodePath.join(vm.home, ".t3", "tailscale-authkey"), "test-key");
    const result = vm.run(BoatVmService.TAILNET_SCRIPT, ["joined", "http"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "joined.tail.ts.net");
    assert.include(vm.commands(), "up --reset --auth-key=test-key --hostname=joined\n");
    assert.include(vm.commands(), "serve --bg --http=80 http://127.0.0.1:3773\n");
    assert.notInclude(vm.commands(), "--https");
    assert.isFalse(NodeFS.existsSync(NodePath.join(vm.home, ".t3", "tailscale-authkey")));
  });

  it.effect("hands every start the current Tailscale key as a file, never as an argument", () => {
    const written: Array<{ readonly path: string; readonly content: string }> = [];
    const args: Array<ReadonlyArray<string>> = [];
    const provider = BoatVmService.withTailnet(
      {
        ...makeFakeSandboxProvider({ id: "boat" }),
        writeFile: (_ref, path, content) =>
          Effect.sync(
            () => void written.push({ path, content: new TextDecoder().decode(content) }),
          ),
        exec: (_ref, input) =>
          Effect.sync(() => {
            args.push(input.args ?? []);
            return { exitCode: 0, stdout: "t3-vm-bx1.tail.ts.net\n", stderr: "" };
          }),
      },
      "tskey-current",
    );
    return Effect.gen(function* () {
      const exposed = yield* provider.exposePort({ providerId: "boat", sandboxId: "bx_1" }, 3773);

      assert.equal(exposed.httpBaseUrl, "https://t3-vm-bx1.tail.ts.net");
      assert.deepEqual(written, [
        { path: BoatVmService.TAILNET_KEY_PATH, content: "tskey-current" },
      ]);
      assert.notInclude(args.flat().join(" "), "tskey-current");
    });
  });
});

describe("boat VM launch env", () => {
  it.effect("hands the keys to each server start as a file the shell reads back as given", () => {
    const events: Array<string> = [];
    const home = homeOf("bx_2");
    const provider = BoatVmService.withLaunchEnv(
      {
        ...makeFakeSandboxProvider({ id: "boat" }),
        writeFile: (_ref, path, content) =>
          Effect.sync(() => {
            events.push(`write ${path}`);
            NodeFS.mkdirSync(NodePath.join(home, ".t3"), { recursive: true });
            NodeFS.writeFileSync(NodePath.join(home, path.replace(/^~\//, "")), content);
          }),
        startBackground: () => Effect.sync(() => void events.push("start")),
      },
      { OPENAI_API_KEY: `sk-'quoted' $HOME \`x\``, "NOT-A-NAME": "dropped" },
    );
    return Effect.gen(function* () {
      yield* provider.startBackground(
        { providerId: "boat", sandboxId: "bx_2" },
        { script: "true", logPath: "/tmp/log" },
      );

      assert.deepEqual(events, ["write ~/.t3/launch-env", "start"]);
      const read = NodeChildProcess.spawnSync(
        "sh",
        ["-c", '. "$HOME/.t3/launch-env"; printf %s "$OPENAI_API_KEY"'],
        { encoding: "utf8", env: { PATH: hostPath, HOME: home } },
      );
      assert.equal(read.stdout, "sk-'quoted' $HOME `x`");
      assert.notInclude(
        NodeFS.readFileSync(NodePath.join(home, ".t3", "launch-env"), "utf8"),
        "dropped",
      );
    });
  });
});

describe("boat VM naming", () => {
  it("turns SSH remotes into HTTPS", () => {
    assert.equal(
      BoatVmService.boatVmCloneUrl("git@github.com:acme/app.git"),
      "https://github.com/acme/app.git",
    );
    assert.equal(
      BoatVmService.boatVmCloneUrl("ssh://git@github.com/acme/app.git"),
      "https://github.com/acme/app.git",
    );
    assert.equal(
      BoatVmService.boatVmCloneUrl("https://github.com/acme/app.git"),
      "https://github.com/acme/app.git",
    );
  });
});

const nowMs = Date.parse("2026-10-20T12:00:00.000Z");
const minutesAgo = (minutes: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(nowMs - minutes * 60_000));
const vmThread = (
  id: string,
  fields: Partial<BoatVmLifecycle.VmThread> = {},
): BoatVmLifecycle.VmThread => ({
  id,
  projectId: "vm-project",
  parentThreadId: null,
  status: "idle",
  settled: false,
  settledAt: null,
  unsettledAt: null,
  snoozedUntil: null,
  latestUserMessageAt: minutesAgo(5),
  createdAt: minutesAgo(60),
  version: "v1",
  ...fields,
});

/** A thread snapshot as a VM's T3 answers it, with only `messages` of its history. */
const snapshotOf = (
  id: string,
  projectId: string,
  archivedAt: string | null,
  messages: ReadonlyArray<unknown> = [],
) =>
  JSON.stringify({
    snapshotSequence: 1,
    projection: {
      thread: {
        id,
        projectId,
        title: "Fix the login",
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: minutesAgo(60),
        updatedAt: minutesAgo(1),
        archivedAt,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      runs: [],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      messages,
      plans: [],
      turnItems: [],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [],
      updatedAt: minutesAgo(1),
    },
  });

/** What the VM's own T3 holds: its unarchived threads, and which of the others are archived. */
interface VmContents {
  threads: Array<BoatVmLifecycle.VmThread>;
  archived: Array<string>;
}

const vmRemote = "https://github.com/acme/app.git";
const homeProjectId = ProjectId.make("home");
const homeProject = {
  id: homeProjectId,
  workspaceRoot: "/home/app",
  repositoryIdentity: {
    canonicalKey: normalizeGitRemoteUrl(vmRemote),
    locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: vmRemote },
  },
};
const running = (sandboxId: string, label = `vm ${sandboxId}`): SandboxInfo => ({
  ref: { providerId: "boat", sandboxId },
  status: "running",
  label,
});

/**
 * A harness whose VMs answer the lifecycle's thread and snapshot scripts from
 * `contents`; every other script runs as usual. VM threads in "vm-scratch"
 * belong to a project with no repository remote.
 */
const makeLifecycleHarness = (
  input: Parameters<typeof makeHarness>[0] & {
    readonly contents: Map<string, VmContents>;
    readonly execs?: Array<string>;
    /** Threads whose snapshot was fetched. */
    readonly fetched?: Array<string>;
    /** The messages of every thread's snapshot. */
    readonly messages?: ReadonlyArray<unknown>;
    /** Other files on the VMs, by path; a snapshot's T3 home is ".". */
    readonly vmFiles?: Map<string, Uint8Array>;
  },
) => {
  // An archived thread keeps the project it was listed in.
  const projectOf = new Map<string, string>();
  const parentOf = new Map<string, string | null>();
  return makeHarness({
    projects: [homeProject],
    mirrorThread: (mirrorInput) =>
      Effect.succeed({
        threadId: ThreadId.make(`import:${mirrorInput.originKey}`),
        outcome: "created" as const,
      }),
    deleteCopy: () => Effect.void,
    ...input,
    provider: (provider) => ({
      ...provider,
      exec: (ref, command) => {
        const vm = input.contents.get(ref.sandboxId);
        if (command.script === BoatVmLifecycle.VM_THREADS_SCRIPT) {
          input.execs?.push(ref.sandboxId);
          if (vm === undefined) return Effect.succeed({ exitCode: 3, stdout: "", stderr: "" });
          for (const thread of vm.threads) {
            projectOf.set(thread.id, thread.projectId);
            parentOf.set(thread.id, thread.parentThreadId);
          }
          const listed = new Set(vm.threads.map((thread) => thread.id));
          const departed = (command.args ?? [])
            .filter((id) => !listed.has(id))
            .map((id) =>
              vm.archived.includes(id)
                ? {
                    id,
                    state: "archived",
                    version: `${id}:archived`,
                    parentThreadId: parentOf.get(id) ?? null,
                  }
                : { id, state: "deleted", version: null, parentThreadId: null },
            );
          const stdout = JSON.stringify({
            threads: vm.threads,
            departed,
            projects: [
              { id: "vm-project", remoteUrl: vmRemote },
              { id: "vm-scratch", remoteUrl: null },
            ],
          });
          return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
        }
        if (command.script === BoatVmLifecycle.THREAD_SNAPSHOT_SCRIPT) {
          const threadId = command.args?.[0] ?? "";
          input.fetched?.push(threadId);
          const exists =
            vm !== undefined &&
            (vm.archived.includes(threadId) || vm.threads.some(({ id }) => id === threadId));
          const stdout = exists ? `snapshot:${threadId}` : "missing";
          return Effect.succeed({ exitCode: 0, stdout, stderr: "" });
        }
        return provider.exec(ref, command);
      },
      readFile: (ref, path) => {
        const file = input.vmFiles?.get(path);
        if (file !== undefined) return Effect.succeed(file);
        if (!path.startsWith("snapshot:")) return provider.readFile(ref, path);
        const threadId = path.slice("snapshot:".length);
        const archived = input.contents.get(ref.sandboxId)?.archived.includes(threadId) ?? false;
        const projectId = projectOf.get(threadId) ?? "vm-project";
        return Effect.succeed(
          new TextEncoder().encode(
            snapshotOf(threadId, projectId, archived ? minutesAgo(1) : null, input.messages),
          ),
        );
      },
    }),
  });
};

const pass = BoatVmService.BoatVmService.use((vms) => vms.keepAlive);
const logouts = (record: { tailnetJoins: ReadonlyArray<{ sandboxId: string; script: string }> }) =>
  record.tailnetJoins
    .filter((join) => join.script === BoatVmService.TAILNET_LOGOUT_SCRIPT)
    .map((join) => join.sandboxId);
const mirrored = (sandboxId: string, threadId: string, projectId: string = homeProjectId) =>
  `mirror:boat-vm:${sandboxId}:${threadId} ${projectId} created`;
const writeFailed = new EventSinkWriteError({ eventCount: 1 });
/** Fails the first call with `error`, then succeeds. */
const failOnce = <A, E>(error: E, succeed: () => Effect.Effect<A>) => {
  let failures = 1;
  return () => (failures-- > 0 ? Effect.fail(error) : succeed());
};

describe("boat VM lifecycle", () => {
  it.effect("mirrors a VM's threads, refetching only threads that changed", () => {
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1"), vmThread("t2")], archived: [] }],
    ]);
    const fetched: Array<string> = [];
    const { record, layer } = makeLifecycleHarness({
      contents,
      fetched,
      vms: [running("vm1"), { ...running("parked"), status: "stopped" }],
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      assert.deepEqual(record.events, [mirrored("vm1", "t1"), mirrored("vm1", "t2")]);

      yield* pass;
      contents.set("vm1", {
        threads: [vmThread("t1", { version: "v2" }), vmThread("t2")],
        archived: [],
      });
      yield* pass;

      assert.deepEqual(fetched, ["t1", "t2", "t1"]);
      assert.deepEqual(record.events.slice(2), [mirrored("vm1", "t1")]);
      assert.deepEqual(record.stopped, []);
      assert.deepEqual(record.destroyed, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists a VM by the title of its latest thread copied here", () => {
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1"), vmThread("t2"), vmThread("t3")], archived: [] }],
    ]);
    const long = `Fix the login redirect ${"and more ".repeat(10)}`;
    const titles = new Map([
      ["boat-vm:vm1:t1", { title: "Older thread", updatedAtMs: 1 }],
      ["boat-vm:vm1:t2", { title: `  ${long}`, updatedAtMs: 3 }],
    ]);
    const { layer } = makeLifecycleHarness({
      contents,
      vms: [running("vm1", "t3:no-project"), running("named", "t3:no-project:Explore")],
      // t3's copy is archived or deleted here, so it has no title.
      copyTitle: (originKey) => Effect.succeed(titles.get(originKey) ?? null),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      const listed = yield* (yield* BoatVmService.BoatVmService).list;
      assert.deepEqual(
        listed.vms.map(({ sandboxId, task }) => ({ sandboxId, task })),
        [
          { sandboxId: "vm1", task: `${long.slice(0, 59).trimEnd()}…` },
          { sandboxId: "named", task: "Explore" },
        ],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("syncs a VM's threads once more, then stops it once all are archived", () => {
    const contents = new Map<string, VmContents>([
      ["done", { threads: [vmThread("t1")], archived: [] }],
    ]);
    const execs: Array<string> = [];
    const { record, layer } = makeLifecycleHarness({
      contents,
      execs,
      vms: [
        running("done"),
        { ...running("parked"), status: "stopped" },
        running("job", "sandbox job 1"),
      ],
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      assert.deepEqual(record.destroyed, []);

      contents.set("done", { threads: [], archived: ["t1"] });
      yield* pass;

      assert.deepEqual(record.events, [
        mirrored("done", "t1"),
        mirrored("done", "t1"),
        "stop:done",
      ]);
      assert.deepEqual(record.destroyed, []);
      // Stopped VMs and other sandboxes are never read.
      assert.deepEqual(execs, ["done", "done"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("deletes the copy of a thread deleted on the VM, and counts settled as done", () => {
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1"), vmThread("t2"), vmThread("t3")], archived: [] }],
    ]);
    const { record, layer } = makeLifecycleHarness({ contents, vms: [running("vm1")] });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;

      // t2 was deleted, t3 archived, and t1 settled.
      contents.set("vm1", { threads: [vmThread("t1", { settled: true })], archived: ["t3"] });
      yield* pass;

      assert.deepEqual(record.events.slice(3), [
        "delete:boat-vm:vm1:t2",
        mirrored("vm1", "t3"),
        "stop:vm1",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a VM while one thread is still active", () => {
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1"), vmThread("t2", { settled: true })], archived: ["t3"] }],
    ]);
    const { record, layer } = makeLifecycleHarness({ contents, vms: [running("vm1")] });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      yield* pass;
      assert.deepEqual(record.events, [mirrored("vm1", "t1"), mirrored("vm1", "t2")]);
      assert.deepEqual(record.stopped, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never copies a thread deleted before it was mirrored", () => {
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1")], archived: [] }],
    ]);
    const { record, layer } = makeLifecycleHarness({
      contents,
      vms: [running("vm1")],
      // The copy never lands, so t1 is never mirrored.
      mirrorThread: () => Effect.fail(writeFailed),
      deleteCopy: () => Effect.die("A thread never mirrored has no copy"),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      contents.set("vm1", { threads: [], archived: [] });
      yield* pass;
      assert.deepEqual(record.events, ["destroy:vm1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a VM when its final sync fails and retries on the next pass", () => {
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1")], archived: [] }],
    ]);
    let calls = 0;
    const { record, layer } = makeLifecycleHarness({
      contents,
      vms: [running("vm1")],
      // The second call, the sync once t1 is archived, fails.
      mirrorThread: () =>
        ++calls === 2
          ? Effect.fail(writeFailed)
          : Effect.succeed({ threadId: ThreadId.make("import:copy"), outcome: "created" as const }),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      contents.set("vm1", { threads: [], archived: ["t1"] });

      yield* pass;
      assert.deepEqual(record.stopped, []);

      yield* pass;
      assert.deepEqual(record.events, [mirrored("vm1", "t1"), mirrored("vm1", "t1"), "stop:vm1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("blocks a delete while a copy of a deleted thread cannot be removed", () => {
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1")], archived: [] }],
    ]);
    const { record, layer } = makeLifecycleHarness({
      contents,
      vms: [running("vm1")],
      deleteCopy: failOnce(
        new OrchestratorProjectionError({ threadId: ThreadId.make("import:copy") }),
        () => Effect.void,
      ),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      contents.set("vm1", { threads: [], archived: [] });
      yield* pass;
      assert.deepEqual(record.destroyed, []);
      yield* pass;
      assert.deepEqual(record.events, [
        mirrored("vm1", "t1"),
        "delete:boat-vm:vm1:t1",
        "destroy:vm1",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("remembers mirrored threads across a server restart", () => {
    const baseDir = NodePath.join(scratch, "t3-home");
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1"), vmThread("t2")], archived: [] }],
    ]);
    const fetched: Array<string> = [];
    const before = makeLifecycleHarness({ contents, vms: [running("vm1")], baseDir });
    const after = makeLifecycleHarness({ contents, vms: [running("vm1")], baseDir, fetched });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass.pipe(Effect.provide(before.layer));
      contents.set("vm1", { threads: [vmThread("t2")], archived: ["t1"] });
      yield* pass.pipe(Effect.provide(after.layer));
      // t2 is unchanged since the restart, so only the archived t1 is fetched again.
      assert.deepEqual(fetched, ["t1"]);
      assert.deepEqual(after.record.events, [mirrored("vm1", "t1")]);
    });
  });

  it.effect("brings a mirrored thread's attachment files here", () => {
    const baseDir = NodePath.join(scratch, "t3-home");
    const image = {
      type: "image",
      id: "t1-00000000-0000-4000-8000-000000000001",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1")], archived: [] }],
    ]);
    const { layer } = makeLifecycleHarness({
      contents,
      vms: [running("vm1")],
      baseDir,
      messages: [
        {
          id: "m1",
          threadId: "t1",
          runId: null,
          nodeId: null,
          role: "user",
          text: "fix this",
          attachments: [image],
          streaming: false,
          createdBy: "user",
          creationSource: "web",
          createdAt: minutesAgo(5),
          updatedAt: minutesAgo(5),
        },
      ],
      vmFiles: new Map([[`userdata/attachments/${image.id}.png`, bytes]]),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass.pipe(Effect.provide(layer));
      assert.deepEqual(
        new Uint8Array(
          NodeFS.readFileSync(NodePath.join(baseDir, "userdata", "attachments", `${image.id}.png`)),
        ),
        bytes,
      );
    });
  });

  it.effect("syncs before stopping a quiet VM, and stops it even when the sync fails", () => {
    const contents = new Map<string, VmContents>([
      ["snoozed", { threads: [vmThread("t1", { snoozedUntil: minutesAgo(-60) })], archived: [] }],
      [
        "quiet",
        { threads: [vmThread("t2", { latestUserMessageAt: minutesAgo(45) })], archived: [] },
      ],
      [
        "working",
        {
          threads: [vmThread("t3", { status: "running", latestUserMessageAt: minutesAgo(45) })],
          archived: [],
        },
      ],
    ]);
    const { record, layer } = makeLifecycleHarness({
      contents,
      vms: [running("snoozed"), running("quiet"), running("working")],
      mirrorThread: (mirrorInput) =>
        mirrorInput.originKey === "boat-vm:quiet:t2"
          ? Effect.fail(writeFailed)
          : Effect.succeed({
              threadId: ThreadId.make(`import:${mirrorInput.originKey}`),
              outcome: "created" as const,
            }),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      assert.sameMembers(record.stopped, ["snoozed", "quiet"]);
      assert.deepEqual(
        record.events.filter((event) => event.includes("snoozed")),
        [mirrored("snoozed", "t1"), "stop:snoozed"],
      );
      assert.deepEqual(
        record.extended.map((entry) => entry.sandboxId),
        ["working"],
      );
      assert.deepEqual(record.destroyed, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("moves a VM's deadline only while a thread on it shows as working", () => {
    const contents = new Map<string, VmContents>([
      ["working", { threads: [vmThread("t1", { status: "running" })], archived: [] }],
      ["answering", { threads: [vmThread("t2", { status: "waiting" })], archived: [] }],
      [
        "subagent",
        {
          threads: [vmThread("t3"), vmThread("t4", { status: "running", parentThreadId: "t3" })],
          archived: [],
        },
      ],
      // Idle threads inside the idle window, and a VM with no thread yet.
      ["idle", { threads: [vmThread("t5")], archived: [] }],
      ["fresh", { threads: [], archived: [] }],
    ]);
    const { record, layer } = makeLifecycleHarness({
      contents,
      vms: [...contents.keys()].map((sandboxId) => running(sandboxId)),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      assert.sameMembers(
        record.extended.map((entry) => entry.sandboxId),
        ["working", "answering", "subagent"],
      );
      assert.deepEqual(record.stopped, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never copies a subagent on its own, and removes a copy made of one earlier", () => {
    const contents = new Map<string, VmContents>([
      // Listed as top-level, the way every thread was mirrored before.
      ["vm1", { threads: [vmThread("t1"), vmThread("sub")], archived: [] }],
    ]);
    const fetched: Array<string> = [];
    const { record, layer } = makeLifecycleHarness({ contents, fetched, vms: [running("vm1")] });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      contents.set("vm1", {
        threads: [vmThread("t1", { version: "v2" }), vmThread("sub", { parentThreadId: "t1" })],
        archived: [],
      });
      yield* pass;
      contents.set("vm1", {
        threads: [vmThread("t1", { version: "v2" })],
        archived: ["sub"],
      });
      yield* pass;
      assert.deepEqual(fetched, ["t1", "sub", "t1"]);
      assert.deepEqual(record.events, [
        mirrored("vm1", "t1"),
        mirrored("vm1", "sub"),
        "delete:boat-vm:vm1:sub",
        mirrored("vm1", "t1"),
      ]);
      assert.deepEqual([...record.followed], ["import:boat-vm:vm1:t1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a quiet VM while a subagent on it is still running", () => {
    const quiet = vmThread("t1", { latestUserMessageAt: minutesAgo(45) });
    const contents = new Map<string, VmContents>([
      [
        "vm1",
        {
          threads: [quiet, vmThread("sub", { parentThreadId: "t1", status: "running" })],
          archived: [],
        },
      ],
    ]);
    const { record, layer } = makeLifecycleHarness({ contents, vms: [running("vm1")] });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      assert.deepEqual(record.stopped, []);
      contents.set("vm1", {
        threads: [quiet, vmThread("sub", { parentThreadId: "t1", status: "idle" })],
        archived: [],
      });
      yield* pass;
      assert.deepEqual(record.stopped, ["vm1"]);
      assert.deepEqual(record.events, [mirrored("vm1", "t1"), "stop:vm1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops a settled VM, and deletes it while stopped after the grace period", () => {
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1")], archived: [] }],
    ]);
    const copies = new Map<string, ThreadImportService.CopyState>();
    const vms: Array<SandboxInfo> = [running("vm1")];
    const execs: Array<string> = [];
    const { record, layer } = makeLifecycleHarness({
      contents,
      vms,
      execs,
      copyState: (originKey) => Effect.succeed(copies.get(originKey) ?? null),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      assert.deepEqual([...record.followed], ["import:boat-vm:vm1:t1"]);
      copies.set("boat-vm:vm1:t1", { doneAtMs: null, reopenedAtMs: null });
      contents.set("vm1", {
        threads: [vmThread("t1", { settled: true, settledAt: minutesAgo(1) })],
        archived: [],
      });
      yield* pass;
      // Settled on the VM: the copy is settled too, and the VM only stops.
      assert.deepEqual(record.events.slice(1), ["settle:boat-vm:vm1:t1", "stop:vm1"]);
      copies.set("boat-vm:vm1:t1", { doneAtMs: nowMs, reopenedAtMs: null });
      vms[0] = { ...running("vm1"), status: "stopped" };

      yield* TestClock.setTime(nowMs + BoatVmLifecycle.BOAT_VM_SETTLED_DELETE_AFTER_MS - 60_000);
      yield* pass;
      assert.deepEqual(record.destroyed, []);
      assert.deepEqual([...record.followed], ["import:boat-vm:vm1:t1"]);

      yield* TestClock.setTime(nowMs + BoatVmLifecycle.BOAT_VM_SETTLED_DELETE_AFTER_MS);
      yield* pass;
      assert.deepEqual(record.destroyed, ["vm1"]);
      // The stopped VM is never reached, not even to log out of the tailnet.
      assert.deepEqual(execs, ["vm1", "vm1"]);
      assert.deepEqual(logouts(record), []);
      assert.deepEqual(record.managerAccess, ["revoke:vm1"]);
      assert.deepEqual([...record.followed], []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("counts a copy settled here as settled, and keeps the VM once it is reopened", () => {
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1")], archived: [] }],
    ]);
    const copies = new Map<string, ThreadImportService.CopyState>();
    const vms: Array<SandboxInfo> = [running("vm1")];
    const { record, layer } = makeLifecycleHarness({
      contents,
      vms,
      copyState: (originKey) => Effect.succeed(copies.get(originKey) ?? null),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      // Settled here after the thread's last message on the VM.
      copies.set("boat-vm:vm1:t1", { doneAtMs: nowMs, reopenedAtMs: null });
      yield* pass;
      assert.deepEqual(record.events.slice(1), ["stop:vm1"]);
      vms[0] = { ...running("vm1"), status: "stopped" };

      yield* TestClock.setTime(nowMs + 60 * 60_000);
      copies.set("boat-vm:vm1:t1", { doneAtMs: null, reopenedAtMs: nowMs + 60 * 60_000 });
      yield* pass;
      // Settling it again later does not bring back the old deadline.
      copies.set("boat-vm:vm1:t1", { doneAtMs: nowMs + 2 * 60 * 60_000, reopenedAtMs: null });
      yield* TestClock.setTime(nowMs + BoatVmLifecycle.BOAT_VM_SETTLED_DELETE_AFTER_MS * 2);
      yield* pass;
      assert.deepEqual(record.destroyed, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("deletes a VM stopped while idle once its copies are settled here", () => {
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1", { latestUserMessageAt: minutesAgo(90) })], archived: [] }],
    ]);
    const copies = new Map<string, ThreadImportService.CopyState>();
    const vms: Array<SandboxInfo> = [running("vm1")];
    const { record, layer } = makeLifecycleHarness({
      contents,
      vms,
      copyState: (originKey) => Effect.succeed(copies.get(originKey) ?? null),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      assert.deepEqual(record.stopped, ["vm1"]);
      vms[0] = { ...running("vm1"), status: "stopped" };
      copies.set("boat-vm:vm1:t1", { doneAtMs: null, reopenedAtMs: null });
      yield* pass;
      // Settled from a client while the VM sleeps.
      copies.set("boat-vm:vm1:t1", { doneAtMs: nowMs, reopenedAtMs: null });
      yield* pass;
      yield* TestClock.setTime(nowMs + BoatVmLifecycle.BOAT_VM_SETTLED_DELETE_AFTER_MS);
      yield* pass;
      assert.deepEqual(record.destroyed, ["vm1"]);
      assert.deepEqual(logouts(record), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("deletes a VM at once when a copy is deleted here and nothing else is at work", () => {
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1"), vmThread("t2")], archived: [] }],
    ]);
    const copies = new Map<string, ThreadImportService.CopyState | "deleted">();
    const fetched: Array<string> = [];
    const { record, layer } = makeLifecycleHarness({
      contents,
      fetched,
      vms: [running("vm1")],
      copyState: (originKey) => Effect.succeed(copies.get(originKey) ?? null),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      copies.set("boat-vm:vm1:t1", "deleted");
      contents.set("vm1", {
        threads: [
          vmThread("t1", { version: "v2" }),
          vmThread("t2", { settled: true, settledAt: minutesAgo(1) }),
        ],
        archived: [],
      });
      yield* pass;
      // No stop and no grace period, and the deleted thread is not synced again.
      assert.deepEqual(record.events.slice(2), ["destroy:vm1"]);
      assert.deepEqual(fetched, ["t1", "t2"]);
      assert.deepEqual(logouts(record), ["vm1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a VM whose copy was deleted while other work goes on", () => {
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1"), vmThread("t2")], archived: [] }],
    ]);
    const copies = new Map<string, ThreadImportService.CopyState | "deleted">();
    const { record, layer } = makeLifecycleHarness({
      contents,
      vms: [running("vm1")],
      copyState: (originKey) => Effect.succeed(copies.get(originKey) ?? null),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      copies.set("boat-vm:vm1:t1", "deleted");
      copies.set("boat-vm:vm1:t2", { doneAtMs: null, reopenedAtMs: null });
      contents.set("vm1", {
        threads: [vmThread("t1"), vmThread("t2", { status: "running" })],
        archived: [],
      });
      yield* pass;
      assert.deepEqual(record.events.slice(2), []);

      // Once t2 settles, the usual rule applies and t1 no longer counts.
      contents.set("vm1", {
        threads: [vmThread("t1"), vmThread("t2", { settled: true, settledAt: minutesAgo(1) })],
        archived: [],
      });
      yield* pass;
      assert.deepEqual(record.events.slice(2), ["settle:boat-vm:vm1:t2", "stop:vm1"]);
      assert.deepEqual(record.destroyed, []);
      assert.deepEqual([...record.followed], ["import:boat-vm:vm1:t2"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("deletes a stopped VM without reaching it once its only copy is deleted here", () => {
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1")], archived: [] }],
    ]);
    const copies = new Map<string, ThreadImportService.CopyState | "deleted">();
    const vms: Array<SandboxInfo> = [running("vm1")];
    const execs: Array<string> = [];
    const { record, layer } = makeLifecycleHarness({
      contents,
      vms,
      execs,
      copyState: (originKey) => Effect.succeed(copies.get(originKey) ?? null),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      vms[0] = { ...running("vm1"), status: "stopped" };
      copies.set("boat-vm:vm1:t1", { doneAtMs: null, reopenedAtMs: null });
      yield* pass;
      assert.deepEqual(record.destroyed, []);

      copies.set("boat-vm:vm1:t1", "deleted");
      yield* pass;
      assert.deepEqual(record.destroyed, ["vm1"]);
      assert.deepEqual(execs, ["vm1"]);
      assert.deepEqual(logouts(record), []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("checks a copy left alone by an earlier start once more", () => {
    const baseDir = NodePath.join(scratch, "t3-home-left-alone");
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1")], archived: [] }],
    ]);
    const continued = () =>
      Effect.succeed({ threadId: ThreadId.make("import:copy"), outcome: "continued" as const });
    const fetched: Array<string> = [];
    const first = makeLifecycleHarness({
      contents,
      vms: [running("vm1")],
      baseDir,
      mirrorThread: continued,
    });
    const stillContinued = makeLifecycleHarness({
      contents,
      vms: [running("vm1")],
      baseDir,
      fetched,
      mirrorThread: continued,
    });
    // Its runs all failed, so it is a copy after all.
    const nowACopy = makeLifecycleHarness({ contents, vms: [running("vm1")], baseDir });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass.pipe(Effect.provide(first.layer));
      assert.deepEqual([...first.record.followed], []);
      yield* Effect.all([pass, pass]).pipe(Effect.provide(stillContinued.layer));
      assert.deepEqual(fetched, ["t1"]);
      yield* pass.pipe(Effect.provide(nowACopy.layer));
      assert.deepEqual(nowACopy.record.events, [mirrored("vm1", "t1")]);
      assert.deepEqual([...nowACopy.record.followed], ["import:boat-vm:vm1:t1"]);
    });
  });

  it.effect("stops mirroring a thread whose copy was continued here", () => {
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1")], archived: [] }],
    ]);
    const fetched: Array<string> = [];
    const { record, layer } = makeLifecycleHarness({
      contents,
      fetched,
      vms: [running("vm1")],
      mirrorThread: () =>
        Effect.succeed({ threadId: ThreadId.make("import:copy"), outcome: "continued" as const }),
      deleteCopy: () => Effect.die("A continued copy is never deleted"),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      contents.set("vm1", { threads: [vmThread("t1", { version: "v2" })], archived: [] });
      yield* pass;
      assert.deepEqual(fetched, ["t1"]);

      contents.set("vm1", { threads: [], archived: [] });
      yield* pass;
      assert.deepEqual(record.events, ["mirror:boat-vm:vm1:t1 home continued", "destroy:vm1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("mirrors a scratch VM's threads into this server's scratch project", () => {
    const contents = new Map<string, VmContents>([
      ["scratch", { threads: [vmThread("t1", { projectId: "vm-scratch" })], archived: [] }],
    ]);
    const { record, layer } = makeLifecycleHarness({ contents, vms: [running("scratch")] });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      contents.set("scratch", { threads: [], archived: ["t1"] });
      yield* pass;
      assert.deepEqual(record.events, [
        mirrored("scratch", "t1", "home-scratch"),
        mirrored("scratch", "t1", "home-scratch"),
        "stop:scratch",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("mirrors a thread of a repository no project here checks out into scratch", () => {
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1")], archived: [] }],
    ]);
    const { record, layer } = makeLifecycleHarness({
      contents,
      vms: [running("vm1")],
      projects: [],
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      contents.set("vm1", { threads: [], archived: ["t1"] });
      yield* pass;
      assert.deepEqual(record.events, [
        mirrored("vm1", "t1", "home-scratch"),
        mirrored("vm1", "t1", "home-scratch"),
        "stop:vm1",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("ends a VM's link back here when it deletes the VM", () => {
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1")], archived: [] }],
    ]);
    const { record, layer } = makeLifecycleHarness({ contents, vms: [running("vm1")] });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      assert.deepEqual(record.managerAccess, []);
      contents.set("vm1", { threads: [], archived: [] });
      yield* pass;
      assert.include(record.events, "destroy:vm1");
      assert.deepEqual(logouts(record), ["vm1"]);
      assert.deepEqual(record.managerAccess, ["revoke:vm1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves a VM the user just resumed running for the idle window", () => {
    const contents = new Map<string, VmContents>([
      ["vm1", { threads: [vmThread("t1", { snoozedUntil: minutesAgo(-60) })], archived: [] }],
    ]);
    // Listed as running, as boat lists it once the resume began.
    const { record, layer } = makeLifecycleHarness({ contents, vms: [running("vm1")] });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const vms = yield* BoatVmService.BoatVmService;
      yield* vms.launch({ repository: repository(), sandboxId: "vm1" });
      yield* vms.keepAlive;
      assert.deepEqual(record.stopped, []);

      yield* TestClock.adjust("31 minutes");
      yield* vms.keepAlive;
      assert.deepEqual(record.stopped, ["vm1"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "deletes a VM the user just started once its only thread's copy is deleted here",
    () => {
      const contents = new Map<string, VmContents>([
        ["vm1", { threads: [vmThread("t1")], archived: [] }],
      ]);
      const copies = new Map<string, ThreadImportService.CopyState | "deleted">();
      const { record, layer } = makeLifecycleHarness({
        contents,
        vms: [running("vm1")],
        copyState: (originKey) => Effect.succeed(copies.get(originKey) ?? null),
      });
      return Effect.gen(function* () {
        yield* TestClock.setTime(nowMs);
        const vms = yield* BoatVmService.BoatVmService;
        yield* vms.launch({ repository: repository(), sandboxId: "vm1" });
        yield* vms.keepAlive;
        copies.set("boat-vm:vm1:t1", "deleted");
        yield* vms.keepAlive;
        assert.include(record.events, "destroy:vm1");
      }).pipe(Effect.provide(layer));
    },
  );
});

/**
 * The VM's T3 on loopback: MCP sign-in with a pairing code, then the project
 * and thread tools, answering tools/call as server-sent events like the real
 * server does when a response carries more than one message.
 */
const startFakeVmT3 = (launchFailure?: string, importStatus = 200) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{
          readonly server: NodeHttp.Server;
          readonly port: number;
          readonly decisions: Array<unknown>;
          readonly calls: Array<{ readonly name: string; readonly arguments: unknown }>;
          /** Bodies posted to the thread import endpoint with the issued token. */
          readonly imports: Array<{ readonly originKey: string; readonly [key: string]: unknown }>;
        }>((resolve) => {
          const decisions: Array<unknown> = [];
          const calls: Array<{ readonly name: string; readonly arguments: unknown }> = [];
          const imports: Array<{ readonly originKey: string }> = [];
          const server = NodeHttp.createServer((request, response) => {
            let body = "";
            request.on("data", (chunk) => (body += chunk));
            request.on("end", () => {
              const json = (status: number, value: unknown, headers = {}) => {
                response.writeHead(status, { "content-type": "application/json", ...headers });
                response.end(JSON.stringify(value));
              };
              if (request.url === "/api/orchestration/threads/import") {
                if (
                  request.headers.authorization !== "Bearer session-token" ||
                  request.headers["x-t3-orchestration-protocol"] !== "2"
                ) {
                  return json(401, {});
                }
                if (importStatus !== 200) return json(importStatus, {});
                const imported = JSON.parse(body);
                imports.push(imported);
                return json(200, {
                  threadId: `import:${imported.originKey}`,
                  projectId: "vm-project",
                  created: true,
                });
              }
              switch (request.url) {
                case "/.well-known/oauth-protected-resource/mcp":
                  return json(200, { resource: `http://127.0.0.1:${port}/mcp` });
                case "/oauth/mcp/register":
                  return json(200, { client_id: "client" });
                case "/oauth/mcp/decision":
                  decisions.push(JSON.parse(body).decision);
                  return json(200, {
                    redirectTo: "http://127.0.0.1/t3-boat-vm-thread?code=granted",
                  });
                case "/oauth/mcp/token":
                  return new URLSearchParams(body).get("code") === "granted"
                    ? json(200, { access_token: "vm-token", token_type: "Bearer" })
                    : json(400, {});
              }
              if (request.headers.authorization !== "Bearer vm-token") return json(401, {});
              const message = JSON.parse(body);
              if (message.method === "initialize") {
                return json(
                  200,
                  { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } },
                  { "mcp-session-id": "session" },
                );
              }
              if (message.id === undefined) {
                response.writeHead(202).end();
                return;
              }
              const { name, arguments: args } = message.params;
              calls.push({ name, arguments: args });
              const result =
                name === "t3_project_list"
                  ? { structuredContent: { projects: [], nextCursor: null } }
                  : name === "t3_project_create"
                    ? { structuredContent: { id: "vm-project" } }
                    : name === "t3_thread_send"
                      ? { structuredContent: { threadId: args.threadId, delivery: "started" } }
                      : launchFailure !== undefined
                        ? {
                            isError: true,
                            structuredContent: { code: "invalid_request", message: launchFailure },
                          }
                        : {
                            structuredContent: {
                              threadId: "vm-thread",
                              projectId: args.projectId ?? "vm-scratch",
                            },
                          };
              response.writeHead(200, { "content-type": "text/event-stream" });
              response.end(
                `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
              );
            });
          });
          let port = 0;
          server.listen(0, "127.0.0.1", () => {
            port = (server.address() as NodeNet.AddressInfo).port;
            resolve({ server, port, decisions, calls, imports });
          });
        }),
    ),
    ({ server }) => Effect.promise(() => new Promise<void>((done) => server.close(() => done()))),
  );

/**
 * Runs the thread launch and hand-over scripts for real, in the background so
 * the fake T3 can answer them. The VM's `t3` issues a fixed token and pairing code.
 */
const withVmT3 = (port: number) => (provider: SandboxProviderShape) => ({
  ...provider,
  exec: (ref: SandboxRef, command: Parameters<SandboxProviderShape["exec"]>[1]) => {
    if (
      command.script !== BoatVmService.VM_THREAD_LAUNCH_SCRIPT &&
      command.script !== BoatVmService.VM_THREAD_HANDOVER_SCRIPT
    ) {
      return provider.exec(ref, command);
    }
    const home = homeOf(ref.sandboxId);
    const stateDir = NodePath.join(home, ".t3", "ssh-launch", SANDBOX_STATE_KEY);
    NodeFS.mkdirSync(stateDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(stateDir, "port"), String(port));
    NodeFS.writeFileSync(
      NodePath.join(stateDir, "run-t3.sh"),
      `#!/bin/sh
case "$*" in
  "auth session issue"*) printf 'session-token\\n' ;;
  "auth pairing create"*) printf 'log line\\n{"id":"p1","credential":"vm-minted"}\\n' ;;
  *) exit 9 ;;
esac
`,
      { mode: 0o755 },
    );
    return Effect.promise(
      () =>
        new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
          const child = NodeChildProcess.spawn("sh", ["-s", ...(command.args ?? [])], {
            env: { ...gitEnv, HOME: home },
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => (stdout += chunk));
          child.stderr.on("data", (chunk) => (stderr += chunk));
          child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
          child.stdin.end(command.script);
        }),
    );
  },
});

describe("boat VM thread launch", () => {
  const hostProjectId = ProjectId.make("host-app");
  const hostProject = () => ({
    id: hostProjectId,
    title: "app",
    workspaceRoot: "/home/app",
    repositoryIdentity: {
      canonicalKey: normalizeGitRemoteUrl(remote),
      locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: remote },
      owner: "Acme",
      name: "app",
    },
  });

  it.effect("checks out the project on a new VM and starts the thread in its project there", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const vmT3 = yield* startFakeVmT3();
        const { record, layer } = makeHarness({
          projects: [hostProject()],
          provider: withVmT3(vmT3.port),
        });
        const started = yield* BoatVmService.BoatVmService.use((vms) =>
          vms.launchThread({
            projectId: hostProjectId,
            title: "Fix the build",
            message: "Make the tests pass",
            runtimeMode: "approval-required",
          }),
        ).pipe(Effect.provide(layer));

        assert.deepEqual(started, {
          sandboxId: "new",
          label: "Acme/app",
          threadId: ThreadId.make("vm-thread"),
          projectId: ProjectId.make("vm-project"),
        });
        assert.equal(record.targets[0]!.label, "t3:Acme/app:Fix the build");
        const checkout = NodePath.join(homeOf("new"), "work", "app");
        assert.equal(git(checkout, ["rev-parse", "HEAD"]), git(remote, ["rev-parse", "HEAD"]));
        assert.deepEqual(vmT3.decisions, [
          { _tag: "pairing-code", access: "full-access", code: "pair-new" },
        ]);
        assert.deepEqual(vmT3.calls, [
          { name: "t3_project_list", arguments: { cursor: 0, limit: 100 } },
          {
            name: "t3_project_create",
            arguments: {
              title: "app",
              workspaceRoot: checkout,
              createWorkspaceRootIfMissing: false,
            },
          },
          {
            name: "t3_thread_launch",
            arguments: {
              title: "Fix the build",
              message: "Make the tests pass",
              runtimeMode: "approval-required",
              projectId: "vm-project",
            },
          },
        ]);
        // The request carried the pairing code, so it must not outlive the launch.
        assert.deepEqual(
          NodeFS.readdirSync(NodePath.join(homeOf("new"), ".t3")).filter((name) =>
            name.startsWith("boat-thread-launch-"),
          ),
          [],
        );
      }),
    ),
  );

  it.effect("starts a thread without a project in the VM's Scratch and reports a refusal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const vmT3 = yield* startFakeVmT3("No model is configured.");
        const { layer } = makeHarness({ provider: withVmT3(vmT3.port) });
        const error = yield* BoatVmService.BoatVmService.use((vms) =>
          vms.launchThread({ projectId: null, title: "Explore", message: "Look around" }),
        ).pipe(Effect.provide(layer), Effect.flip);

        assert.equal(
          error.message,
          "scratch (new) is running, but its t3_thread_launch refused: No model is configured.",
        );
        assert.deepEqual(vmT3.calls, [
          {
            name: "t3_thread_launch",
            arguments: { title: "Explore", message: "Look around", scratch: true },
          },
        ]);
      }),
    ),
  );

  it.effect("checks out a repository a linked server sends, without a project here", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const vmT3 = yield* startFakeVmT3();
        const { record, layer } = makeHarness({ provider: withVmT3(vmT3.port) });
        const started = yield* BoatVmService.BoatVmService.use((vms) =>
          vms.launchThread({
            projectId: null,
            repository: repository(),
            title: "Fix the build",
            message: "Make the tests pass",
          }),
        ).pipe(Effect.provide(layer));

        assert.equal(started.projectId, ProjectId.make("vm-project"));
        assert.equal(record.targets[0]!.label, "t3:Acme/app:Fix the build");
        const checkout = NodePath.join(homeOf("new"), "work", "app");
        assert.equal(git(checkout, ["rev-parse", "HEAD"]), git(remote, ["rev-parse", "HEAD"]));
        assert.deepEqual(
          vmT3.calls.map((call) => call.name),
          ["t3_project_list", "t3_project_create", "t3_thread_launch"],
        );
      }),
    ),
  );

  it.effect("refuses a project without a repository remote before starting a VM", () => {
    const { record, layer } = makeHarness({
      projects: [{ ...hostProject(), title: "Notes", repositoryIdentity: null }],
    });
    return Effect.gen(function* () {
      const error = yield* BoatVmService.BoatVmService.use((vms) =>
        vms.launchThread({ projectId: hostProjectId, title: "Notes", message: "Tidy up" }),
      ).pipe(Effect.flip);
      assert.equal(
        error.message,
        "Notes has no repository remote, so a boat VM cannot check it out.",
      );
      assert.deepEqual(record.targets, []);
    }).pipe(Effect.provide(layer));
  });
});

describe("continuing a copy whose boat VM was deleted", () => {
  const copyThreadId = ThreadId.make("import:boat-vm:gone:vm-thread");
  const homeId = ProjectId.make("home");
  const decodeSnapshot = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot)),
  );
  const copyOf = (projectId: ProjectId, branch: string) => {
    const snapshot = decodeSnapshot(snapshotOf(copyThreadId, projectId, null));
    return {
      snapshot: {
        ...snapshot,
        projection: {
          ...snapshot.projection,
          thread: { ...snapshot.projection.thread, branch },
        },
      },
      continuedHere: false,
    };
  };
  /** The manager's checkout, holding a branch the deleted VM's last stop brought home. */
  const checkoutWithBroughtHome = () => {
    const local = NodePath.join(scratch, "local");
    git(scratch, ["clone", "--quiet", remote, local]);
    git(local, ["switch", "--quiet", "-c", "feature"]);
    NodeFS.writeFileSync(NodePath.join(local, "app.ts"), "export const app = 2;\n");
    git(local, ["commit", "--quiet", "-am", "on the deleted VM"]);
    git(local, ["update-ref", "refs/t3/boat/gone/feature", "feature"]);
    git(local, ["update-ref", "refs/t3/boat/gone/main", "main"]);
    git(local, ["switch", "--quiet", "main"]);
    git(local, ["branch", "--quiet", "-D", "feature"]);
    return local;
  };
  const homeProjectFor = (local: string) => ({
    id: homeId,
    workspaceRoot: local,
    repositoryIdentity: {
      canonicalKey: normalizeGitRemoteUrl(remote),
      locator: { source: "git-remote" as const, remoteName: "origin", remoteUrl: remote },
      owner: "Acme",
      name: "app",
      rootPath: local,
    },
  });
  /** A launch that runs install, then starts the server, recording each step in `order`. */
  const recordingOrder = (order: Array<string>) => ({
    provider: (provider: SandboxProviderShape): SandboxProviderShape => ({
      ...provider,
      startBackground: () => Effect.sync(() => void order.push("serve")),
      exec: (ref, command) => {
        const step =
          command.script === BoatVmService.SYNC_SCRIPT
            ? "sync"
            : command.script === BoatVmService.RESTORE_BRANCHES_SCRIPT
              ? "restore"
              : command.script === BoatVmService.VM_THREAD_HANDOVER_SCRIPT
                ? "handover"
                : undefined;
        return provider.exec(ref, command).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (step !== undefined) order.push(step);
            }),
          ),
        );
      },
    }),
    manager: (
      manager: SandboxEnvironmentManager["Service"],
    ): SandboxEnvironmentManager["Service"] => ({
      ...manager,
      provision: (input) =>
        Effect.gen(function* () {
          const ref: SandboxRef = { providerId: "boat", sandboxId: "new" };
          yield* input.provider.exec(ref, {
            script: "# t3-sandbox-script: install\ntrue",
            timeoutMs: 1_000,
          });
          yield* input.provider.startBackground(ref, { script: "true", logPath: "/tmp/t3.log" });
          return bootstrapFor(ref, "pair-new");
        }).pipe(Effect.orDie),
    }),
  });

  it.effect(
    "restores the brought-home branches and hands the thread over before the copy goes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const local = checkoutWithBroughtHome();
          const vmT3 = yield* startFakeVmT3();
          const order: Array<string> = [];
          const recording = recordingOrder(order);
          const { record, layer } = makeHarness({
            projects: [homeProjectFor(local)],
            copySnapshot: (originKey) =>
              Effect.succeed(
                originKey === "boat-vm:gone:vm-thread" ? copyOf(homeId, "feature") : null,
              ),
            deleteCopy: () => Effect.void,
            manager: recording.manager,
            provider: (provider) => recording.provider(withVmT3(vmT3.port)(provider)),
          });
          const launched = yield* BoatVmService.BoatVmService.use((vms) =>
            vms.launch({ continueThreadId: copyThreadId, message: "Keep going" }),
          ).pipe(Effect.provide(layer));

          assert.equal(launched.threadId, "import:boat-vm:gone:vm-thread");
          assert.equal(launched.pairingCode, "pair-new");
          assert.isUndefined(launched.warning);
          assert.equal(launched.label, "Acme/app");
          // The server is up and the checkout synced before the thread reaches it.
          assert.isBelow(order.indexOf("serve"), order.indexOf("handover"));
          assert.deepEqual(
            order.filter((step) => step !== "serve"),
            ["sync", "restore", "handover"],
          );
          const checkout = launched.workspaceRoot;
          assert.equal(git(checkout, ["symbolic-ref", "--short", "HEAD"]), "feature\n");
          assert.equal(
            git(checkout, ["rev-parse", "HEAD"]),
            git(local, ["rev-parse", "refs/t3/boat/gone/feature"]),
          );
          assert.lengthOf(vmT3.imports, 1);
          assert.equal(vmT3.imports[0]!.originKey, "boat-vm:gone:vm-thread");
          assert.equal(vmT3.imports[0]!.repositoryRemoteUrl, remote);
          // The VM minted its own code, so the launch's stays the client's.
          assert.deepEqual(vmT3.decisions, [
            { _tag: "pairing-code", access: "full-access", code: "vm-minted" },
          ]);
          assert.deepEqual(vmT3.calls.at(-1), {
            name: "t3_thread_send",
            arguments: { threadId: "import:boat-vm:gone:vm-thread", message: "Keep going" },
          });
          assert.deepEqual(record.events, ["delete:boat-vm:gone:vm-thread"]);
          assert.deepEqual(record.destroyed, []);
          assert.deepEqual(
            NodeFS.readdirSync(NodePath.join(homeOf("new"), ".t3")).filter(
              (name) => name.startsWith("boat-thread-handover-") || name === "boat-restore.bundle",
            ),
            [],
          );
        }),
      ),
  );

  it.effect("continues a Scratch copy in the new VM's Scratch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const vmT3 = yield* startFakeVmT3();
        const { layer } = makeHarness({
          projects: [],
          copySnapshot: () => Effect.succeed(copyOf(ProjectId.make("home-scratch"), "main")),
          deleteCopy: () => Effect.void,
          provider: withVmT3(vmT3.port),
        });
        const launched = yield* BoatVmService.BoatVmService.use((vms) =>
          vms.launch({ continueThreadId: copyThreadId }),
        ).pipe(Effect.provide(layer));
        assert.equal(launched.threadId, "import:boat-vm:gone:vm-thread");
        assert.lengthOf(vmT3.imports, 1);
        assert.notProperty(vmT3.imports[0]!, "repositoryRemoteUrl");
        // No project to register and no message to send.
        assert.deepEqual(vmT3.calls, []);
      }),
    ),
  );

  it.effect("removes the new VM and keeps the copy when the VM cannot take the thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const local = checkoutWithBroughtHome();
        const vmT3 = yield* startFakeVmT3(undefined, 404);
        const { record, layer } = makeHarness({
          projects: [homeProjectFor(local)],
          copySnapshot: () => Effect.succeed(copyOf(homeId, "feature")),
          provider: withVmT3(vmT3.port),
        });
        const error = yield* BoatVmService.BoatVmService.use((vms) =>
          vms.launch({ continueThreadId: copyThreadId, message: "Keep going" }),
        ).pipe(Effect.provide(layer), Effect.flip);
        assert.include(error.message, "The new VM could not take the thread");
        assert.include(error.message, "cannot import threads");
        assert.deepEqual(record.destroyed, ["new"]);
        assert.deepEqual(record.events, []);
      }),
    ),
  );

  it.effect("refuses a copy whose VM still exists, or that was continued here", () => {
    const { record, layer } = makeHarness({
      vms: [{ ref: { providerId: "boat", sandboxId: "gone" }, status: "stopped", label: "vm app" }],
      copySnapshot: (originKey) =>
        Effect.succeed({ ...copyOf(homeId, "main"), continuedHere: originKey.endsWith(":mine") }),
    });
    return Effect.gen(function* () {
      const vms = yield* BoatVmService.BoatVmService;
      const exists = yield* Effect.flip(vms.launch({ continueThreadId: copyThreadId }));
      assert.equal(exists.message, "This thread's boat VM still exists. Continue it there.");
      const mine = yield* Effect.flip(
        vms.launch({ continueThreadId: ThreadId.make("import:boat-vm:other:mine") }),
      );
      assert.include(mine.message, "continued here");
      assert.deepEqual(record.targets, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("brings a VM's branches home before the lifecycle stops it", () => {
    const local = NodePath.join(scratch, "local");
    git(scratch, ["clone", "--quiet", remote, local]);
    const vmCheckout = NodePath.join(homeOf("quiet"), "work", "app");
    git(scratch, ["clone", "--quiet", remote, vmCheckout]);
    git(vmCheckout, ["switch", "--quiet", "-c", "feature"]);
    NodeFS.writeFileSync(NodePath.join(vmCheckout, "app.ts"), "export const app = 4;\n");
    git(vmCheckout, ["commit", "--quiet", "-am", "on the VM"]);
    const atStop: Array<string> = [];
    const { record, layer } = makeLifecycleHarness({
      contents: new Map([
        [
          "quiet",
          { threads: [vmThread("t1", { latestUserMessageAt: minutesAgo(45) })], archived: [] },
        ],
      ]),
      vms: [running("quiet")],
      projects: [homeProject, homeProjectFor(local)],
      manager: (manager) => ({
        ...manager,
        stop: (input) =>
          Effect.sync(() =>
            atStop.push(git(local, ["for-each-ref", "--format=%(refname)", "refs/t3/boat/"])),
          ).pipe(Effect.andThen(manager.stop(input))),
      }),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      yield* pass;
      assert.deepEqual(record.stopped, ["quiet"]);
      assert.deepEqual(atStop, ["refs/t3/boat/quiet/feature\nrefs/t3/boat/quiet/main\n"]);
    }).pipe(Effect.provide(layer));
  });
});

describe("BoatVmService base snapshot", () => {
  const catalogOf = (events: Array<string>, statuses: Array<string>): BoatCatalogShape => ({
    snapshots: Effect.succeed([]),
    environments: Effect.succeed([]),
    saveSnapshot: (input) =>
      Effect.sync(() => {
        events.push(`save:${input.sandboxId} ${input.name}`);
        return { name: input.name, status: "saving" };
      }),
    snapshotStatus: (name) => Effect.sync(() => ({ name, status: statuses.shift() ?? "saving" })),
    desktop: () => Effect.die("No desktop expected"),
  });
  const cleaningWith =
    (events: Array<string>, exitCode: number) => (provider: SandboxProviderShape) => ({
      ...provider,
      exec: (ref: SandboxRef, command: { readonly script: string }) =>
        command.script === BoatVmService.BASE_SNAPSHOT_CLEAN_SCRIPT
          ? Effect.sync(() => {
              events.push(`clean:${ref.sandboxId}`);
              return { exitCode, stdout: "", stderr: "" };
            })
          : provider.exec(ref, command as Parameters<SandboxProviderShape["exec"]>[1]),
    });

  it.effect("saves a cleaned plain VM and deletes it once boat has saved it", () => {
    const events: Array<string> = [];
    const { layer, record } = makeHarness({
      provider: cleaningWith(events, 0),
      catalog: catalogOf(events, ["saving", "ready"]),
    });
    return Effect.gen(function* () {
      const vms = yield* BoatVmService.BoatVmService;
      const started = yield* vms.createBaseSnapshot({ name: "t3-base" });
      assert.deepEqual(started, { name: "t3-base", status: "saving" });
      assert.deepEqual(events, ["clean:new", "save:new t3-base"]);
      const target = record.targets[0];
      assert.equal(target?.snapshot, undefined);
      assert.equal(target?.label, "snapshot t3-base");
      assert.isNull(parseBoatVmSandboxLabel(target?.label ?? ""));
      assert.deepEqual(record.destroyed, []);

      yield* TestClock.adjust("30 seconds");
      assert.deepEqual(record.destroyed, ["new"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("deletes the VM and saves nothing when it cannot be cleaned", () => {
    const events: Array<string> = [];
    const { layer, record } = makeHarness({
      provider: cleaningWith(events, 1),
      catalog: catalogOf(events, []),
    });
    return Effect.gen(function* () {
      const vms = yield* BoatVmService.BoatVmService;
      const error = yield* Effect.flip(vms.createBaseSnapshot({ name: "t3-base" }));
      assert.include(error.message, "prepare the VM");
      assert.deepEqual(events, ["clean:new"]);
      assert.deepEqual(record.destroyed, ["new"]);
    }).pipe(Effect.provide(layer));
  });
});
