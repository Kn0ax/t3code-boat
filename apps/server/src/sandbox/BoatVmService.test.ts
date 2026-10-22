// @effect-diagnostics nodeBuiltinImport:off - The fake VM runs the sync and busy scripts in a real shell and git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import type { OrchestrationProjectShell, SandboxJobSettings } from "@t3tools/contracts";
import {
  SandboxEnvironmentError,
  SandboxEnvironmentManager,
  type SandboxEnvironmentTarget,
  type SandboxInfo,
  type SandboxProviderShape,
  type SandboxRef,
} from "@t3tools/sandbox-core";
import { makeFakeSandboxProvider } from "@t3tools/sandbox-core/testing";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
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
  readonly written: Array<{ readonly path: string; readonly content: string }>;
  /** The hex port each VM's busy check looks at; the host's own T3 may hold 3773. */
  readonly busyPorts: Map<string, string>;
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
      if (input.script.includes("sudo ")) {
        throw new Error("A test script would run sudo on this machine.");
      }
      const args =
        input.script === BoatVmService.BUSY_SCRIPT
          ? [input.args?.[0] ?? "", record.busyPorts.get(ref.sandboxId) ?? "0001"]
          : (input.args ?? []);
      const result = NodeChildProcess.spawnSync("sh", ["-s", ...args], {
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
    stop: () => Effect.void,
    destroy: () => Effect.void,
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
    Pick<OrchestrationProjectShell, "workspaceRoot" | "repositoryIdentity">
  >;
}) => {
  const record: Record = {
    targets: [],
    reconnects: [],
    extended: [],
    resets: [],
    tailnetJoins: [],
    destroyed: [],
    written: [],
    busyPorts: new Map(),
    resumed: [],
    provisionEnv: undefined,
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
    Layer.provide(NodeServices.layer),
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
      assert.equal(record.targets[0]!.label, "vm Acme/app");
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
        assert.equal(record.targets[0]!.label, "vm scratch");
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

  it.effect("keeps only running VMs that had work alive", () => {
    const vm = (sandboxId: string, status: SandboxInfo["status"], label = `vm ${sandboxId}`) => ({
      ref: { providerId: "boat" as const, sandboxId },
      status,
      label,
    });
    const { record, layer } = makeHarness({
      vms: [
        vm("busy", "running"),
        vm("quiet", "running"),
        vm("archived", "stopped"),
        vm("job-node", "running", "sandbox job 1"),
        vm("deleted", "destroyed", "old sandbox"),
      ],
    });
    for (const sandboxId of ["busy", "job-node"]) {
      const userdata = NodePath.join(homeOf(sandboxId), ".t3", "userdata");
      NodeFS.mkdirSync(userdata, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(userdata, "statev2.sqlite-wal"), "");
    }
    // Seconds since the epoch: a 2001 timestamp, long outside any idle window.
    const old = 1_000_000_000;
    const quiet = NodePath.join(homeOf("quiet"), ".t3", "userdata");
    NodeFS.mkdirSync(quiet, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(quiet, "statev2.sqlite-wal"), "");
    NodeFS.utimesSync(NodePath.join(quiet, "statev2.sqlite-wal"), old, old);
    NodeFS.utimesSync(quiet, old, old);
    return Effect.gen(function* () {
      const vms = yield* BoatVmService.BoatVmService;

      yield* vms.keepAlive;
      const listed = yield* vms.list;

      assert.deepEqual(record.extended, [{ sandboxId: "busy", minutes: 30 }]);
      assert.deepEqual(listed.sandboxIds, ["busy", "quiet", "archived", "job-node"]);
      assert.deepEqual(
        listed.vms.map((entry) => entry.label),
        ["busy", "quiet", "archived"],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect.skipIf(!NodeFS.existsSync("/proc/net/tcp"))(
    "counts a connected client and anything the server runs as work",
    () => {
      const running = (sandboxId: string) => ({
        ref: { providerId: "boat" as const, sandboxId },
        status: "running" as const,
        label: `vm ${sandboxId}`,
      });
      const { record, layer } = makeHarness({
        vms: [running("connected"), running("working"), running("idle-server")],
      });
      const writePid = (sandboxId: string, pid: number) => {
        const state = NodePath.join(homeOf(sandboxId), ".t3", "ssh-launch", "sandbox");
        NodeFS.mkdirSync(state, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(state, "pid"), `${pid}\n`);
      };
      // This test process stands in for a server running a terminal; the
      // terminal itself is a server with nothing under it.
      const terminal = NodeChildProcess.spawn("sleep", ["60"], { stdio: "ignore" });
      writePid("working", process.pid);
      writePid("idle-server", terminal.pid!);
      return Effect.acquireUseRelease(
        Effect.promise(
          () =>
            new Promise<{ server: NodeNet.Server; client: NodeNet.Socket }>((resolve) => {
              const server = NodeNet.createServer();
              server.listen(0, "127.0.0.1", () => {
                const { port } = server.address() as NodeNet.AddressInfo;
                const client = NodeNet.connect(port, "127.0.0.1");
                server.once("connection", () => resolve({ server, client }));
              });
            }),
        ),
        ({ server }) =>
          Effect.gen(function* () {
            const { port } = server.address() as NodeNet.AddressInfo;
            record.busyPorts.set("connected", BoatVmService.busyPortArg(port));

            yield* (yield* BoatVmService.BoatVmService).keepAlive;

            assert.sameMembers(
              record.extended.map((entry) => entry.sandboxId),
              ["connected", "working"],
            );
          }).pipe(Effect.provide(layer)),
        ({ server, client }) =>
          Effect.sync(() => {
            terminal.kill();
            client.destroy();
            server.close();
          }),
      );
    },
  );
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
        { BackendState: "Running", Self: { DNSName: "invalid/name" } },
        { BackendState: "Running", Self: { DNSName: "existing.tail.ts.net." } },
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
    const vm = shell([{ BackendState: "Running", Self: { DNSName: "existing.tail.ts.net." } }]);
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
      ...Array.from({ length: 16 }, () => needsLogin),
      { BackendState: "Running", Self: { DNSName: "rescued.tail.ts.net." } },
    ]);
    NodeFS.mkdirSync(NodePath.join(vm.home, ".t3"));
    NodeFS.writeFileSync(NodePath.join(vm.home, ".t3", "tailscale-authkey"), "saved-key");

    const result = vm.run(BoatVmService.SNAPSHOT_TAILNET_SCRIPT, ["http"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "rescued.tail.ts.net");
    assert.equal(
      vm.commands(),
      "status --json\n".repeat(16) +
        "up --reset --auth-key=saved-key\nstatus --json\nserve --bg --http=80 http://127.0.0.1:3773\n",
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(vm.home, ".t3", "tailscale-authkey")));
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
      BoatVmService.boatVmCloneUrl("git@github.com:Kn0ax/t3code.git"),
      "https://github.com/Kn0ax/t3code.git",
    );
    assert.equal(
      BoatVmService.boatVmCloneUrl("ssh://git@github.com/Kn0ax/t3code.git"),
      "https://github.com/Kn0ax/t3code.git",
    );
    assert.equal(
      BoatVmService.boatVmCloneUrl("https://github.com/Kn0ax/t3code.git"),
      "https://github.com/Kn0ax/t3code.git",
    );
  });
});
