import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { DesktopSandboxEnvironmentTarget } from "@t3tools/contracts";
import {
  SandboxEnvironmentError,
  SandboxStoppedError,
  SandboxEnvironmentManager,
  type SandboxEnvironmentManagerShape,
} from "@t3tools/sandbox-core";
import { makeFakeSandboxProvider, type FakeSandboxProvider } from "@t3tools/sandbox-core/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopSandboxCredentials from "./DesktopSandboxCredentials.ts";
import * as DesktopSandboxEnvironment from "./DesktopSandboxEnvironment.ts";
import * as DesktopSandboxForwards from "./DesktopSandboxForwards.ts";
import type { DesktopSandboxProviderCredential } from "./DesktopSandboxCredentials.ts";

const TARGET: DesktopSandboxEnvironmentTarget = {
  providerId: "boat",
  label: "Agent box",
  size: "medium",
  idleTimeoutMinutes: 30,
  installAgentClis: true,
  forwardGithubToken: false,
};

const BOOTSTRAP = {
  ref: { providerId: "boat" as const, sandboxId: "sandbox-1" },
  httpBaseUrl: "https://3773-sandbox-1.daytonaproxy01.net",
  wsBaseUrl: "wss://3773-sandbox-1.daytonaproxy01.net",
  pairingToken: "pairing-secret",
  requestHeaders: { "x-daytona-skip-preview-warning": "true" },
};

const FORWARD = { httpBaseUrl: "http://127.0.0.1:4100/", wsBaseUrl: "ws://127.0.0.1:4100/" };

interface Harness {
  readonly provider: FakeSandboxProvider;
  readonly managerCalls: Array<{ readonly operation: string; readonly input: unknown }>;
  readonly usedCredentials: Array<DesktopSandboxProviderCredential>;
  readonly forwardCalls: Array<{ readonly operation: string; readonly input: unknown }>;
}

function makeHarness(options?: {
  readonly stored?: Partial<Record<string, DesktopSandboxProviderCredential>>;
  readonly manager?: Partial<SandboxEnvironmentManagerShape>;
  /** A token to forward, "unavailable" for a reader that fails, or unset to forbid reading. */
  readonly gitHubToken?: string;
  readonly realFactories?: boolean;
}) {
  const provider = makeFakeSandboxProvider({ id: "boat" });
  const managerCalls: Harness["managerCalls"] = [];
  const usedCredentials: Harness["usedCredentials"] = [];
  const forwardCalls: Harness["forwardCalls"] = [];
  const forwards = DesktopSandboxForwards.DesktopSandboxForwards.of({
    open: (sandbox, upstream) =>
      Effect.sync(() => {
        forwardCalls.push({ operation: "open", input: { sandbox, upstream } });
        return FORWARD;
      }),
    close: (sandbox) =>
      Effect.sync(() => void forwardCalls.push({ operation: "close", input: sandbox })),
  });
  const stored = options?.stored ?? { boat: { secret: Redacted.make("boat-key") } };
  const record =
    (operation: string) =>
    (input: unknown): Effect.Effect<void> =>
      Effect.sync(() => void managerCalls.push({ operation, input }));
  const manager = SandboxEnvironmentManager.of({
    provision: (input) => record("provision")(input).pipe(Effect.as(BOOTSTRAP)),
    reconnect: (input) => record("reconnect")(input).pipe(Effect.as(BOOTSTRAP)),
    stop: (input) => record("stop")(input),
    destroy: (input) => record("destroy")(input),
    ...options?.manager,
  });
  const credentials = DesktopSandboxCredentials.DesktopSandboxCredentials.of({
    get: (providerId) => Effect.succeed(Option.fromNullishOr(stored[providerId])),
    has: (providerId) => Effect.succeed(stored[providerId] !== undefined),
    set: () => Effect.die("unused"),
    clear: () => Effect.die("unused"),
  });
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: "/home/test",
    platform: "darwin",
    processArch: "arm64",
    appVersion: "0.0.45",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: "/home/test" })),
    ),
  );
  const gitHubToken = options?.gitHubToken;
  const layer = Layer.effect(
    DesktopSandboxEnvironment.DesktopSandboxEnvironment,
    DesktopSandboxEnvironment.make({
      ...(options?.realFactories === true
        ? {}
        : {
            factories: {
              boat: (credential) =>
                Effect.sync(() => {
                  usedCredentials.push(credential);
                  return provider;
                }),
            },
          }),
      readGitHubToken:
        gitHubToken === undefined
          ? Effect.die("the GitHub token must not be read")
          : gitHubToken === "unavailable"
            ? Effect.fail(
                new DesktopSandboxEnvironment.DesktopGitHubTokenUnavailableError({
                  detail: "The GitHub CLI is not signed in.",
                }),
              )
            : Effect.succeed(Redacted.make(gitHubToken)),
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerEnvironment,
        NodeServices.layer,
        Layer.succeed(SandboxEnvironmentManager, manager),
        Layer.succeed(DesktopSandboxCredentials.DesktopSandboxCredentials, credentials),
        Layer.succeed(DesktopSandboxForwards.DesktopSandboxForwards, forwards),
      ),
    ),
  );
  return {
    harness: { provider, managerCalls, usedCredentials, forwardCalls } satisfies Harness,
    layer,
  };
}

describe("DesktopSandboxEnvironment", () => {
  it.effect("provisions with the app's own release and no GitHub token by default", () => {
    const { harness, layer } = makeHarness();
    return Effect.gen(function* () {
      const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
      const result = yield* sandboxes.ensure({ target: TARGET, idempotencyKey: "attempt-1" });

      assert.deepStrictEqual(result, {
        target: TARGET,
        sandbox: BOOTSTRAP.ref,
        httpBaseUrl: FORWARD.httpBaseUrl,
        wsBaseUrl: FORWARD.wsBaseUrl,
        providerUrl: BOOTSTRAP.httpBaseUrl,
        pairingToken: BOOTSTRAP.pairingToken,
      });
      assert.strictEqual(harness.managerCalls.length, 1);
      assert.deepInclude(harness.managerCalls[0]!.input as object, {
        target: {
          label: "Agent box",
          size: "medium",
          idleTimeoutMinutes: 30,
          t3Version: "0.0.45",
          installAgentClis: true,
        },
        env: {},
        idempotencyKey: "attempt-1:github-token=none",
      });
      assert.strictEqual(Redacted.value(harness.usedCredentials[0]!.secret), "boat-key");
    }).pipe(Effect.provide(layer));
  });

  it.effect("forwards the GitHub token only when the target opts in", () => {
    const { harness, layer } = makeHarness({ gitHubToken: "gho_forwarded" });
    return Effect.gen(function* () {
      const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
      yield* sandboxes.ensure({
        target: { ...TARGET, forwardGithubToken: true, region: " us " },
        idempotencyKey: "attempt-1",
      });

      const input = harness.managerCalls[0]!.input as {
        readonly env: Record<string, string>;
        readonly target: { readonly region?: string };
      };
      assert.deepStrictEqual(input.env, { GH_TOKEN: "gho_forwarded" });
      assert.strictEqual(input.target.region, "us");
    }).pipe(Effect.provide(layer));
  });

  it.effect("never lets a retry without the GitHub token adopt a sandbox made with it", () => {
    const { harness, layer } = makeHarness({ gitHubToken: "gho_forwarded" });
    return Effect.gen(function* () {
      const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
      // A caller that reuses one attempt key across a forwarding change.
      yield* sandboxes.ensure({
        target: { ...TARGET, forwardGithubToken: true },
        idempotencyKey: "attempt-1",
      });
      yield* sandboxes.ensure({ target: TARGET, idempotencyKey: "attempt-1" });

      const [withToken, withoutToken] = harness.managerCalls.map(
        (call) =>
          call.input as {
            readonly env: Record<string, string>;
            readonly idempotencyKey: string;
          },
      );
      assert.deepStrictEqual(withToken!.env, { GH_TOKEN: "gho_forwarded" });
      assert.deepStrictEqual(withoutToken!.env, {});
      assert.notStrictEqual(withoutToken!.idempotencyKey, withToken!.idempotencyKey);
    }).pipe(Effect.provide(layer));
  });

  it.effect("creates nothing when the GitHub token to forward is unavailable", () => {
    const { harness, layer } = makeHarness({ gitHubToken: "unavailable" });
    return Effect.gen(function* () {
      const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
      const result = yield* sandboxes.ensure({
        target: { ...TARGET, forwardGithubToken: true },
        idempotencyKey: "attempt-1",
      });

      assert.deepStrictEqual(result, {
        type: "sandbox-environment-failed",
        stage: "credentials",
        detail: "The GitHub CLI is not signed in.",
      });
      assert.deepStrictEqual(harness.managerCalls, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks for an API key before touching a provider without one", () => {
    const { harness, layer } = makeHarness({ stored: {} });
    return Effect.gen(function* () {
      const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
      const result = yield* sandboxes.ensure({ target: TARGET, idempotencyKey: "attempt-1" });

      assert.deepInclude(result, {
        type: "sandbox-environment-failed",
        stage: "credentials",
        failure: "unauthorized",
      });
      assert.deepStrictEqual(harness.managerCalls, []);
      assert.deepStrictEqual(harness.usedCredentials, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a stopped sandbox instead of starting it on an automatic reconnect", () => {
    const { harness, layer } = makeHarness();
    const sandbox = harness.provider.seed({ status: "stopped" });
    return Effect.gen(function* () {
      const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
      const result = yield* sandboxes.reconnect({
        target: TARGET,
        sandbox: sandbox.ref,
        resume: false,
      });

      assert.deepStrictEqual(result, { type: "sandbox-environment-stopped", sandbox: sandbox.ref });
      assert.deepStrictEqual(harness.managerCalls, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("resumes and relaunches a stopped sandbox when the user asks", () => {
    const { harness, layer } = makeHarness();
    const sandbox = harness.provider.seed({ status: "stopped" });
    return Effect.gen(function* () {
      const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
      const result = yield* sandboxes.reconnect({
        target: TARGET,
        sandbox: sandbox.ref,
        resume: true,
      });

      assert.deepInclude(result, { pairingToken: "pairing-secret", sandbox: BOOTSTRAP.ref });
      assert.deepStrictEqual(
        harness.managerCalls.map((call) => call.operation),
        ["reconnect"],
      );
      assert.deepInclude(harness.managerCalls[0]!.input as object, {
        ref: sandbox.ref,
        t3Version: "0.0.45",
        resume: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a sandbox stopped while an automatic reconnect waited for it", () => {
    const { harness, layer } = makeHarness({
      manager: {
        reconnect: (input) =>
          input.resume ? Effect.succeed(BOOTSTRAP) : new SandboxStoppedError({ ref: input.ref }),
      },
    });
    const sandbox = harness.provider.seed({ status: "running" });
    return Effect.gen(function* () {
      const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
      const result = yield* sandboxes.reconnect({
        target: TARGET,
        sandbox: sandbox.ref,
        resume: false,
      });

      assert.deepStrictEqual(result, { type: "sandbox-environment-stopped", sandbox: sandbox.ref });
      assert.deepStrictEqual(harness.forwardCalls, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a crashed reconnect at its stage, with its sandbox", () => {
    const { harness, layer } = makeHarness({
      manager: { reconnect: () => Effect.die(new Error("boom")) },
    });
    const sandbox = harness.provider.seed({ status: "running" });
    return Effect.gen(function* () {
      const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
      const result = yield* sandboxes.reconnect({
        target: TARGET,
        sandbox: sandbox.ref,
        resume: false,
      });

      assert.deepInclude(result, {
        type: "sandbox-environment-failed",
        stage: "resume",
        failure: "provider-error",
        sandbox: sandbox.ref,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("relaunches a running sandbox on an automatic reconnect", () => {
    const { harness, layer } = makeHarness();
    const sandbox = harness.provider.seed({ status: "running" });
    return Effect.gen(function* () {
      const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
      const result = yield* sandboxes.reconnect({
        target: TARGET,
        sandbox: sandbox.ref,
        resume: false,
      });

      assert.deepInclude(result, {
        httpBaseUrl: FORWARD.httpBaseUrl,
        providerUrl: BOOTSTRAP.httpBaseUrl,
      });
      assert.deepStrictEqual(
        harness.managerCalls.map((call) => call.operation),
        ["reconnect"],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("points the sandbox's forward at the provider URL with the provider's headers", () => {
    const { harness, layer } = makeHarness({
      manager: {
        provision: () =>
          Effect.succeed({
            ...BOOTSTRAP,
            requestHeaders: {
              "x-daytona-skip-preview-warning": "true",
              "x-daytona-preview-token": "preview-secret",
            },
          }),
      },
    });
    return Effect.gen(function* () {
      const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
      const result = yield* sandboxes.ensure({ target: TARGET, idempotencyKey: "attempt-1" });

      assert.deepStrictEqual(harness.forwardCalls, [
        {
          operation: "open",
          input: {
            sandbox: BOOTSTRAP.ref,
            upstream: {
              httpBaseUrl: BOOTSTRAP.httpBaseUrl,
              headers: {
                "x-daytona-skip-preview-warning": "true",
                "x-daytona-preview-token": "preview-secret",
              },
            },
          },
        },
      ]);
      // The preview token stays in desktop main.
      assert.notInclude(JSON.stringify(result), "preview-secret");
    }).pipe(Effect.provide(layer));
  });

  it.effect("explains a sandbox the provider no longer has on an automatic reconnect", () => {
    const { harness, layer } = makeHarness();
    const gone = { providerId: "boat" as const, sandboxId: "deleted-in-dashboard" };
    return Effect.gen(function* () {
      const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
      const result = yield* sandboxes.reconnect({ target: TARGET, sandbox: gone, resume: false });

      assert.deepStrictEqual(result, {
        type: "sandbox-environment-failed",
        stage: "resume",
        failure: "not-found",
        detail: "boat no longer has this sandbox; it was deleted.",
        sandbox: gone,
      });
      assert.deepStrictEqual(harness.managerCalls, []);
      assert.deepStrictEqual(harness.forwardCalls, [{ operation: "close", input: gone }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("replaces a sandbox a retried add finds deleted, under a key naming it", () => {
    const keys: Array<string> = [];
    const { layer } = makeHarness({
      manager: {
        provision: (input) =>
          Effect.suspend(() => {
            keys.push(input.idempotencyKey);
            return keys.length === 1
              ? Effect.fail(
                  new SandboxEnvironmentError({
                    stage: "create",
                    detail:
                      "Docker Sandboxes could not find the sandbox; it may have been deleted.",
                    failure: "not-found",
                    ref: { providerId: "boat", sandboxId: "deleted-1" },
                  }),
                )
              : Effect.succeed(BOOTSTRAP);
          }),
      },
    });
    return Effect.gen(function* () {
      const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
      const result = yield* sandboxes.ensure({ target: TARGET, idempotencyKey: "attempt-1" });

      assert.deepInclude(result, { sandbox: BOOTSTRAP.ref });
      assert.deepStrictEqual(keys, [
        "attempt-1:github-token=none",
        "attempt-1:github-token=none:replaces=deleted-1",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("gives up on an add whose replacements keep turning up deleted", () => {
    let calls = 0;
    const { layer } = makeHarness({
      manager: {
        provision: () =>
          Effect.suspend(() => {
            calls += 1;
            return Effect.fail(
              new SandboxEnvironmentError({
                stage: "create",
                detail: "Docker Sandboxes could not find the sandbox; it may have been deleted.",
                failure: "not-found",
                ref: { providerId: "boat", sandboxId: `deleted-${calls}` },
              }),
            );
          }),
      },
    });
    return Effect.gen(function* () {
      const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
      const result = yield* sandboxes.ensure({ target: TARGET, idempotencyKey: "attempt-1" });

      assert.deepInclude(result, { type: "sandbox-environment-failed", failure: "not-found" });
      assert.strictEqual(calls, 4);
    }).pipe(Effect.provide(layer));
  });

  it.effect("returns a manager failure with its stage, kind and sandbox", () => {
    const sandbox = { providerId: "boat" as const, sandboxId: "sandbox-9" };
    const { layer } = makeHarness({
      manager: {
        destroy: () =>
          Effect.fail(
            new SandboxEnvironmentError({
              stage: "destroy",
              detail: "Daytona rejected the credentials while trying to delete the sandbox.",
              failure: "unauthorized",
              ref: sandbox,
              cause: new Error("secret provider text"),
            }),
          ),
      },
    });
    return Effect.gen(function* () {
      const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
      const result = yield* sandboxes.destroy(sandbox);

      assert.deepStrictEqual(result, {
        type: "sandbox-environment-failed",
        stage: "destroy",
        failure: "unauthorized",
        detail: "Daytona rejected the credentials while trying to delete the sandbox.",
        sandbox,
      });
      assert.notInclude(JSON.stringify(result), "secret provider text");
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops a sandbox through the manager", () => {
    const sandbox = { providerId: "boat" as const, sandboxId: "sandbox-2" };
    const { harness, layer } = makeHarness();
    return Effect.gen(function* () {
      const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
      assert.deepStrictEqual(yield* sandboxes.stop(sandbox), {
        type: "sandbox-environment-done",
      });
      assert.deepStrictEqual(harness.managerCalls, [
        { operation: "stop", input: { provider: harness.provider, ref: sandbox } },
      ]);
      assert.deepStrictEqual(harness.forwardCalls, [{ operation: "close", input: sandbox }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("closes a deleted sandbox's forward, and keeps it when the delete fails", () => {
    const sandbox = { providerId: "boat" as const, sandboxId: "sandbox-3" };
    const failing = (failure: "not-found" | "network") =>
      makeHarness({
        manager: {
          destroy: () =>
            Effect.fail(
              new SandboxEnvironmentError({
                stage: "destroy",
                detail: "Daytona could not delete the sandbox.",
                failure,
                ref: sandbox,
              }),
            ),
        },
      });
    const destroy = Effect.gen(function* () {
      const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
      return yield* sandboxes.destroy(sandbox);
    });
    return Effect.gen(function* () {
      const deleted = makeHarness();
      yield* destroy.pipe(Effect.provide(deleted.layer));
      assert.deepStrictEqual(deleted.harness.forwardCalls, [
        { operation: "close", input: sandbox },
      ]);

      const gone = failing("not-found");
      yield* destroy.pipe(Effect.provide(gone.layer));
      assert.deepStrictEqual(gone.harness.forwardCalls, [{ operation: "close", input: sandbox }]);

      const offline = failing("network");
      yield* destroy.pipe(Effect.provide(offline.layer));
      assert.deepStrictEqual(offline.harness.forwardCalls, []);
    });
  });
});
