import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Result from "effect/Result";
import { TestClock } from "effect/testing";
import { HttpClient } from "effect/http";

import {
  SANDBOX_T3_PORT,
  SandboxEnvironmentError,
  SandboxEnvironmentManager,
  type SandboxStoppedError,
  type SandboxEnvironmentManagerOptions,
  type SandboxEnvironmentManagerShape,
  type SandboxEnvironmentTarget,
} from "./SandboxEnvironmentManager.ts";
import { SandboxProviderError } from "./SandboxProvider.ts";
import {
  FAKE_PAIRING_CREDENTIAL_PREFIX,
  FAKE_SANDBOX_SERVER_LOG_PATH,
  fakeEnvironmentDescriptorBody,
  makeFakeEnvironmentHttpClient,
  makeFakeSandboxProvider,
  type FakeEnvironmentHttpClient,
  type FakeHttpAnswer,
  type FakeSandboxProvider,
} from "./testing.ts";

const TARGET: SandboxEnvironmentTarget = {
  label: "Feature work",
  size: "medium",
  region: "eu",
  idleTimeoutMinutes: 30,
  t3Version: "1.2.3",
  installAgentClis: true,
};

const SECRETS = {
  GH_TOKEN: "ghp_SECRETgithubTOKEN0123456789",
  ANTHROPIC_API_KEY: "sk-ant-SECRETanthropicKEY",
  OPENAI_API_KEY: "sk-SECRETopenaiKEY",
} as const;
const PREVIEW_TOKEN = "preview-SECRET-token";

const FAST_TIMING: SandboxEnvironmentManagerOptions["timing"] = {
  runningTimeoutMs: 10_000,
  statusPollIntervalMs: 1_000,
  probeTimeoutMs: 5_000,
  probeIntervalMs: 1_000,
  probeRequestTimeoutMs: 500,
};

const captureLogs = () => {
  const lines: Array<string> = [];
  const logger = Logger.make(({ message }) => {
    lines.push(JSON.stringify(message));
  });
  return { lines, layer: Logger.layer([logger], { mergeWithExisting: false }) };
};

/** Runs `use` against a manager whose probe goes to a fake `t3 serve`, capturing every log line. */
const withManager = <A, E>(
  use: (
    manager: SandboxEnvironmentManagerShape,
    http: FakeEnvironmentHttpClient,
  ) => Effect.Effect<A, E>,
  options: {
    readonly answers?: ReadonlyArray<FakeHttpAnswer>;
    readonly logs?: ReturnType<typeof captureLogs>;
    readonly timing?: SandboxEnvironmentManagerOptions["timing"];
  } = {},
) => {
  const http = makeFakeEnvironmentHttpClient(options.answers);
  const managerLayer = SandboxEnvironmentManager.layer({
    timing: { ...FAST_TIMING, ...options.timing },
  }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http.client)));
  return Effect.gen(function* () {
    const manager = yield* SandboxEnvironmentManager;
    return yield* use(manager, http);
  }).pipe(
    Effect.provide(
      options.logs === undefined ? managerLayer : Layer.merge(managerLayer, options.logs.layer),
    ),
  );
};

/** Lets an effect that polls on the clock run to completion under the TestClock. */
const settle = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.result(effect));
    for (let step = 0; step < 40; step += 1) {
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(500));
    }
    return yield* Fiber.join(fiber);
  });

const expectEnvironmentError = <A>(
  result: Result.Result<A, SandboxEnvironmentError | SandboxProviderError | SandboxStoppedError>,
): SandboxEnvironmentError => {
  assert.isTrue(Result.isFailure(result), "expected the operation to fail");
  if (!Result.isFailure(result)) {
    throw new Error("unreachable");
  }
  assert.instanceOf(result.failure, SandboxEnvironmentError);
  return result.failure as SandboxEnvironmentError;
};

const assertNoSecrets = (text: string) => {
  for (const secret of [...Object.values(SECRETS), PREVIEW_TOKEN, FAKE_PAIRING_CREDENTIAL_PREFIX]) {
    assert.notInclude(text, secret);
  }
};

/**
 * Every provider call in order, with the script kind an exec or background
 * start carried: the shape of the bootstrap sequence.
 */
const callSequence = (provider: FakeSandboxProvider) =>
  provider.calls.map((call) =>
    call.exec !== undefined
      ? `exec:${call.exec.kind ?? "?"}`
      : call.background !== undefined
        ? `startBackground:${call.background.kind ?? "?"}`
        : call.operation,
  );

/** No exec may start a server: on real providers it would never return. */
const assertNoServerStartedByExec = (provider: FakeSandboxProvider) => {
  for (const call of provider.callsOf("exec")) {
    assert.notEqual(call.exec?.kind, "serve");
    assert.notInclude(call.exec?.script ?? "", "serve --host");
    assert.notInclude(call.exec?.script ?? "", "nohup");
  }
};

const provisionInput = (provider: ReturnType<typeof makeFakeSandboxProvider>) => ({
  provider,
  target: TARGET,
  env: SECRETS,
  idempotencyKey: "provision-1",
});

describe("SandboxEnvironmentManager.provision", () => {
  it.effect("creates the sandbox, bootstraps t3 serve and returns a paired endpoint", () => {
    const provider = makeFakeSandboxProvider({
      exposePort: (sandbox, port) => ({
        httpBaseUrl: `https://${port}-${sandbox.ref.sandboxId}.proxy.test/`,
        headers: { "X-Preview-Token": PREVIEW_TOKEN },
      }),
    });
    return withManager((manager, http) =>
      Effect.gen(function* () {
        const bootstrap = yield* manager.provision(provisionInput(provider));

        const [sandbox] = provider.sandboxes();
        assert.deepEqual(bootstrap.ref, sandbox?.ref);
        assert.equal(bootstrap.httpBaseUrl, "https://3773-fake-sandbox-1.proxy.test");
        assert.equal(bootstrap.wsBaseUrl, "wss://3773-fake-sandbox-1.proxy.test");
        assert.equal(bootstrap.pairingToken, `${FAKE_PAIRING_CREDENTIAL_PREFIX}1`);
        assert.deepEqual(bootstrap.requestHeaders, { "X-Preview-Token": PREVIEW_TOKEN });

        const [create] = provider.callsOf("create");
        assert.deepEqual(create?.create, {
          label: "Feature work",
          env: SECRETS,
          size: "medium",
          region: "eu",
          idleTimeoutMinutes: 30,
          idempotencyKey: "provision-1",
        });
        assert.deepEqual(callSequence(provider), [
          "create",
          "exec:install",
          "exec:agent-clis",
          "exec:launch",
          "startBackground:serve",
          "exec:ready",
          "exposePort",
          "exec:pair",
        ]);
        const [background] = provider.callsOf("startBackground");
        assert.equal(background?.background?.logPath, FAKE_SANDBOX_SERVER_LOG_PATH);
        assert.isUndefined(background?.background?.args);
        assert.include(background?.background?.script ?? "", "serve --host 0.0.0.0");
        assertNoServerStartedByExec(provider);
        assert.deepEqual(
          provider.callsOf("exposePort").map((call) => call.port),
          [SANDBOX_T3_PORT],
        );
        assert.deepEqual(
          http.requests.map((request) => request.url),
          ["https://3773-fake-sandbox-1.proxy.test/.well-known/t3/environment"],
        );
        assert.equal(http.requests[0]?.headers["x-preview-token"], PREVIEW_TOKEN);
        assert.lengthOf(provider.callsOf("destroy"), 0);
      }),
    );
  });

  it.effect("keeps secrets out of scripts, argv and logs", () => {
    const logs = captureLogs();
    const provider = makeFakeSandboxProvider({
      exposePort: () => ({
        httpBaseUrl: "https://preview.proxy.test",
        headers: { "x-preview-token": PREVIEW_TOKEN },
      }),
    });
    return withManager(
      (manager) =>
        Effect.gen(function* () {
          yield* manager.provision(provisionInput(provider));
          for (const call of provider.callsOf("exec")) {
            assertNoSecrets(call.exec?.script ?? "");
            assert.isUndefined(call.exec?.args);
          }
          for (const call of provider.callsOf("startBackground")) {
            assertNoSecrets(call.background?.script ?? "");
            assertNoSecrets(call.background?.logPath ?? "");
            assert.isUndefined(call.background?.args);
          }
          assert.isAbove(logs.lines.length, 0);
          assertNoSecrets(logs.lines.join("\n"));
          assert.notInclude(logs.lines.join("\n"), "preview.proxy.test");
        }),
      { logs },
    );
  });

  it.effect("skips the agent CLI step when the target does not ask for it", () => {
    const provider = makeFakeSandboxProvider();
    return withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.provision({
          ...provisionInput(provider),
          target: { ...TARGET, installAgentClis: false },
        });
        assert.deepEqual(provider.execKinds(), ["install", "launch", "ready", "pair"]);
      }),
    );
  });

  it.effect("does not fail the bootstrap when installing agent CLIs fails", () => {
    const provider = makeFakeSandboxProvider({
      exec: ({ kind }) =>
        kind === "agent-clis"
          ? Effect.fail(
              new SandboxProviderError({
                providerId: "boat",
                operation: "exec",
                failure: "timeout",
              }),
            )
          : undefined,
    });
    return withManager((manager) =>
      Effect.gen(function* () {
        const bootstrap = yield* manager.provision(provisionInput(provider));
        assert.equal(bootstrap.pairingToken, `${FAKE_PAIRING_CREDENTIAL_PREFIX}1`);
      }),
    );
  });

  it.effect("waits for a sandbox that is still being created", () => {
    const provider = makeFakeSandboxProvider({
      createStatus: "creating",
      getStatuses: ["creating", "creating", "running"],
    });
    return withManager((manager) =>
      Effect.gen(function* () {
        const result = yield* settle(manager.provision(provisionInput(provider)));
        assert.isTrue(Result.isSuccess(result));
        assert.lengthOf(provider.callsOf("get"), 3);
        assert.deepEqual(provider.execKinds(), [
          "install",
          "agent-clis",
          "launch",
          "ready",
          "pair",
        ]);
      }),
    );
  });

  it.effect("gives up on a sandbox that never starts, without deleting it", () => {
    const provider = makeFakeSandboxProvider({ createStatus: "creating" });
    return withManager((manager) =>
      Effect.gen(function* () {
        const error = expectEnvironmentError(
          yield* settle(manager.provision(provisionInput(provider))),
        );
        assert.equal(error.stage, "create");
        assert.equal(error.failure, "timeout");
        assert.include(error.detail, "still creating");
        assert.deepEqual(error.ref, provider.sandboxes()[0]?.ref);
        assert.lengthOf(provider.callsOf("destroy"), 0);
        assert.lengthOf(provider.callsOf("exec"), 0);
      }),
    );
  });

  it.effect("maps provider failures to their kind without quoting the provider", () => {
    const provider = makeFakeSandboxProvider();
    provider.failNext("create", "quota-exceeded", {
      cause: new Error(`402 for key ${SECRETS.GH_TOKEN}: quota exceeded`),
    });
    return withManager((manager) =>
      Effect.gen(function* () {
        const error = expectEnvironmentError(
          yield* Effect.result(manager.provision(provisionInput(provider))),
        );
        assert.equal(error.stage, "create");
        assert.equal(error.failure, "quota-exceeded");
        assert.isUndefined(error.ref);
        assert.equal(
          error.detail,
          "boat refused to create the sandbox because the account is over its quota.",
        );
        assertNoSecrets(error.message);
        // The raw provider error survives only as the cause, for logs.
        assert.instanceOf(error.cause, SandboxProviderError);
      }),
    );
  });

  it.effect.each([
    ["exposePort", "unauthorized", "expose", "boat rejected the credentials"],
    ["resume", "network", "resume", "Could not reach boat"],
  ] as const)(
    "maps a %s %s failure after create to the %s stage and keeps the ref",
    ([operation, failure, stage, detail]) => {
      const provider = makeFakeSandboxProvider({ createStatus: "stopped" });
      provider.failNext(operation, failure, { cause: new Error(PREVIEW_TOKEN) });
      return withManager((manager) =>
        Effect.gen(function* () {
          const error = expectEnvironmentError(
            yield* Effect.result(manager.provision(provisionInput(provider))),
          );
          assert.equal(error.stage, stage);
          assert.equal(error.failure, failure);
          assert.include(error.detail, detail);
          assert.deepEqual(error.ref, provider.sandboxes()[0]?.ref);
          assertNoSecrets(error.message);
        }),
      );
    },
  );

  it.effect("classifies a failed install from its stderr without quoting it", () => {
    const provider = makeFakeSandboxProvider({
      exec: ({ kind }) =>
        kind === "install"
          ? {
              exitCode: 22,
              stdout: "",
              stderr: `GH_TOKEN=${SECRETS.GH_TOKEN}\ncurl: (22) The requested URL returned error: 404\n`,
            }
          : undefined,
    });
    return withManager((manager) =>
      Effect.gen(function* () {
        const error = expectEnvironmentError(
          yield* Effect.result(manager.provision(provisionInput(provider))),
        );
        assert.equal(error.stage, "install");
        assert.equal(
          error.detail,
          "Installing t3 1.2.3 in the sandbox failed (exit 22): the t3 release was not found for download.",
        );
        assert.isUndefined(error.cause);
        assertNoSecrets(error.message);
        // The sandbox stays for the UI's retry or destroy.
        assert.equal(provider.sandboxes()[0]?.status, "running");
        assert.lengthOf(provider.callsOf("destroy"), 0);
        assert.deepEqual(provider.execKinds(), ["install"]);
      }),
    );
  });

  it.effect("reports an exec timeout against the step's own budget", () => {
    const provider = makeFakeSandboxProvider({
      exec: ({ kind }) =>
        kind === "launch"
          ? Effect.fail(
              new SandboxProviderError({
                providerId: "boat",
                operation: "exec",
                failure: "timeout",
              }),
            )
          : undefined,
    });
    return withManager((manager) =>
      Effect.gen(function* () {
        const error = expectEnvironmentError(
          yield* Effect.result(manager.provision(provisionInput(provider))),
        );
        assert.equal(error.stage, "launch");
        assert.equal(error.failure, "timeout");
        assert.equal(
          error.detail,
          "Starting the T3 server in the sandbox did not finish within 2 minutes.",
        );
      }),
    );
  });

  it.effect("maps a failed background start to the launch stage and skips the ready step", () => {
    const provider = makeFakeSandboxProvider();
    provider.failNext("startBackground", "provider-error", { cause: new Error(PREVIEW_TOKEN) });
    return withManager((manager) =>
      Effect.gen(function* () {
        const error = expectEnvironmentError(
          yield* Effect.result(manager.provision(provisionInput(provider))),
        );
        assert.equal(error.stage, "launch");
        assert.equal(error.failure, "provider-error");
        assert.equal(error.detail, "boat failed to start the T3 server in the sandbox.");
        assert.deepEqual(error.ref, provider.sandboxes()[0]?.ref);
        assertNoSecrets(error.message);
        assert.deepEqual(provider.execKinds(), ["install", "agent-clis", "launch"]);
        assert.lengthOf(provider.callsOf("exposePort"), 0);
      }),
    );
  });

  it.effect("stops waiting for a background start that never returns", () => {
    const provider = makeFakeSandboxProvider({ startBackground: () => Effect.never });
    return withManager(
      (manager) =>
        Effect.gen(function* () {
          const error = expectEnvironmentError(
            yield* settle(manager.provision(provisionInput(provider))),
          );
          assert.equal(error.stage, "launch");
          assert.equal(error.failure, "timeout");
          assert.equal(
            error.detail,
            "boat timed out trying to start the T3 server in the sandbox.",
          );
          assert.deepEqual(provider.execKinds(), ["install", "agent-clis", "launch"]);
        }),
      { timing: { startServerTimeoutMs: 5_000 } },
    );
  });

  it.effect("stops waiting for an exec the provider never ends", () => {
    const provider = makeFakeSandboxProvider({
      exec: ({ kind }) => (kind === "ready" ? Effect.never : undefined),
    });
    return withManager(
      (manager) =>
        Effect.gen(function* () {
          const error = expectEnvironmentError(
            yield* settle(manager.provision(provisionInput(provider))),
          );
          assert.equal(error.stage, "launch");
          assert.equal(error.failure, "timeout");
          assert.equal(
            error.detail,
            "Waiting for the T3 server to start in the sandbox did not finish within 2 seconds.",
          );
        }),
      { timing: { serverReadyTimeoutMs: 2_000 } },
    );
  });

  it.effect("reports a server that exits before it is ready from the ready step", () => {
    const provider = makeFakeSandboxProvider({
      // The process starts and dies at once, so the server never comes up.
      startBackground: () => Effect.void,
    });
    return withManager((manager, http) =>
      Effect.gen(function* () {
        const error = expectEnvironmentError(
          yield* Effect.result(manager.provision(provisionInput(provider))),
        );
        assert.equal(error.stage, "launch");
        assert.equal(
          error.detail,
          "Waiting for the T3 server to start in the sandbox failed (exit 1): the T3 server exited during startup (its log is ~/.t3/ssh-launch/sandbox/server.log).",
        );
        assert.lengthOf(provider.callsOf("startBackground"), 1);
        assert.lengthOf(provider.callsOf("exposePort"), 0);
        assert.lengthOf(http.requests, 0);
      }),
    );
  });

  it.effect.each([
    ["no JSON at all", "motd: welcome\n"],
    ["no decision", '{"remotePort":3773}'],
    ["a new server without a log path", '{"serverKind":"managed","reused":false}'],
    [
      "a log path outside the state directory",
      '{"serverKind":"managed","reused":false,"logPath":"/etc/passwd"}',
    ],
    [
      "a log path with an unexpanded home",
      '{"serverKind":"managed","reused":false,"logPath":"~/.t3/ssh-launch/sandbox/server.log"}',
    ],
  ] as const)("fails the launch stage on %s without starting anything", ([_label, stdout]) => {
    const provider = makeFakeSandboxProvider({
      exec: ({ kind }) => (kind === "launch" ? { exitCode: 0, stdout, stderr: "" } : undefined),
    });
    return withManager((manager) =>
      Effect.gen(function* () {
        const error = expectEnvironmentError(
          yield* Effect.result(manager.provision(provisionInput(provider))),
        );
        assert.equal(error.stage, "launch");
        assert.lengthOf(provider.callsOf("startBackground"), 0);
        assert.deepEqual(provider.execKinds(), ["install", "agent-clis", "launch"]);
      }),
    );
  });

  it.effect("reuses a server the launch step finds running without starting another", () => {
    const provider = makeFakeSandboxProvider({
      exec: ({ kind }) =>
        kind === "launch"
          ? {
              exitCode: 0,
              stdout: '{"remotePort":3773,"serverKind":"external","reused":true}\n',
              stderr: "",
            }
          : undefined,
    });
    return withManager((manager) =>
      Effect.gen(function* () {
        const bootstrap = yield* manager.provision(provisionInput(provider));
        assert.equal(bootstrap.pairingToken, `${FAKE_PAIRING_CREDENTIAL_PREFIX}1`);
        assert.lengthOf(provider.callsOf("startBackground"), 0);
        assert.deepEqual(provider.execKinds(), ["install", "agent-clis", "launch", "pair"]);
      }),
    );
  });

  it.effect("rejects a preview URL that is not a bare origin without quoting it", () => {
    const provider = makeFakeSandboxProvider({
      exposePort: () => ({
        httpBaseUrl: `https://preview.proxy.test/?token=${PREVIEW_TOKEN}`,
        headers: {},
      }),
    });
    return withManager((manager, http) =>
      Effect.gen(function* () {
        const error = expectEnvironmentError(
          yield* Effect.result(manager.provision(provisionInput(provider))),
        );
        assert.equal(error.stage, "expose");
        assertNoSecrets(error.message);
        assert.lengthOf(http.requests, 0);
      }),
    );
  });

  it.effect("keeps probing until t3 serve answers through the proxy", () => {
    const provider = makeFakeSandboxProvider({
      exposePort: (sandbox, port) => ({
        httpBaseUrl: `https://${port}-${sandbox.ref.sandboxId}.proxy.test`,
        headers: { "X-Daytona-Skip-Preview-Warning": "true" },
      }),
    });
    return withManager(
      (manager, http) =>
        Effect.gen(function* () {
          const result = yield* settle(manager.provision(provisionInput(provider)));
          assert.isTrue(Result.isSuccess(result));
          assert.lengthOf(http.requests, 6);
          // Every attempt carries the provider's headers, not just the first.
          for (const request of http.requests) {
            assert.equal(request.headers["x-daytona-skip-preview-warning"], "true");
          }
        }),
      {
        answers: [
          "transport-error",
          // The provider has not routed the new port yet.
          { status: 404, body: "no such route" },
          { status: 502, body: "Bad Gateway" },
          { status: 200, body: "<html>Preview is starting</html>" },
          // JSON that is not a whole descriptor is not T3 either.
          { status: 200, body: '{"environmentId":"e","serverVersion":"1.2.3"}' },
          { status: 200, body: fakeEnvironmentDescriptorBody("1.2.3") },
        ],
      },
    );
  });

  it.effect.each([
    [{ status: 502, body: "Bad Gateway" }, "the last response was HTTP 502"],
    [{ status: 200, body: "<html>proxy warning</html>" }, "not with a T3 environment"],
    ["hang", "requests to the URL timed out"],
    ["transport-error", "the URL could not be reached"],
  ] as const)("times out the probe and says what it last saw (%j)", ([answer, expected]) => {
    const provider = makeFakeSandboxProvider();
    return withManager(
      (manager, http) =>
        Effect.gen(function* () {
          const error = expectEnvironmentError(
            yield* settle(manager.provision(provisionInput(provider))),
          );
          assert.equal(error.stage, "probe");
          assert.include(error.detail, "within 5 seconds");
          assert.include(error.detail, expected);
          assert.isAbove(http.requests.length, 1);
          assert.deepEqual(provider.execKinds(), ["install", "agent-clis", "launch", "ready"]);
          assert.deepEqual(error.ref, provider.sandboxes()[0]?.ref);
        }),
      { answers: [answer] },
    );
  });

  it.effect.each([
    ["truncated JSON", `{"id":"p1","credential":"${SECRETS.GH_TOKEN}`],
    ["an empty credential", '{"credential":"  "}'],
    ["no JSON at all", `Token: ${SECRETS.GH_TOKEN}`],
  ] as const)("fails the pair stage on %s without exposing the output", ([_label, stdout]) => {
    const provider = makeFakeSandboxProvider({
      exec: ({ kind }) => (kind === "pair" ? { exitCode: 0, stdout, stderr: "" } : undefined),
    });
    return withManager((manager) =>
      Effect.gen(function* () {
        const error = expectEnvironmentError(
          yield* Effect.result(manager.provision(provisionInput(provider))),
        );
        assert.equal(error.stage, "pair");
        assert.equal(error.detail, "The sandbox returned a pairing response T3 could not read.");
        assert.isUndefined(error.cause);
        assertNoSecrets(error.message);
      }),
    );
  });

  it.effect("accepts pairing JSON after shell startup noise", () => {
    const provider = makeFakeSandboxProvider({
      exec: ({ kind }) =>
        kind === "pair"
          ? { exitCode: 0, stdout: 'motd: welcome\n{\n  "credential": "cred-1"\n}\n', stderr: "" }
          : undefined,
    });
    return withManager((manager) =>
      Effect.gen(function* () {
        const bootstrap = yield* manager.provision(provisionInput(provider));
        assert.equal(bootstrap.pairingToken, "cred-1");
      }),
    );
  });

  it.effect("fails before creating anything when the version is not an exact release", () => {
    const provider = makeFakeSandboxProvider();
    return withManager((manager) =>
      Effect.gen(function* () {
        const error = expectEnvironmentError(
          yield* Effect.result(
            manager.provision({
              ...provisionInput(provider),
              target: { ...TARGET, t3Version: "latest" },
            }),
          ),
        );
        assert.equal(error.stage, "install");
        assert.lengthOf(provider.calls, 0);
      }),
    );
  });

  it.effect("retries a failed provision into the same sandbox", () => {
    const provider = makeFakeSandboxProvider({
      // The first server dies on startup; the retry's starts normally.
      startBackground: ({ attempt }) => (attempt === 0 ? Effect.void : undefined),
    });
    return withManager((manager) =>
      Effect.gen(function* () {
        const first = expectEnvironmentError(
          yield* Effect.result(manager.provision(provisionInput(provider))),
        );
        assert.equal(first.stage, "launch");
        assert.include(first.detail, "exited during startup");
        const bootstrap = yield* manager.provision(provisionInput(provider));
        assert.deepEqual(bootstrap.ref, first.ref);
        assert.lengthOf(provider.sandboxes(), 1);
        assert.deepEqual(provider.backgroundKinds(), ["serve", "serve"]);
        assertNoServerStartedByExec(provider);
      }),
    );
  });
});

describe("SandboxEnvironmentManager.reconnect", () => {
  it.effect("resumes a stopped sandbox, restarts the server and mints a fresh token", () => {
    const provider = makeFakeSandboxProvider();
    const seeded = provider.seed({ status: "stopped" });
    return withManager((manager) =>
      Effect.gen(function* () {
        const first = yield* manager.reconnect({
          provider,
          ref: seeded.ref,
          t3Version: "1.2.3",
          resume: true,
        });
        assert.deepEqual(first.ref, seeded.ref);
        assert.lengthOf(provider.callsOf("resume"), 1);
        assert.deepEqual(provider.execKinds(), ["install", "launch", "ready", "pair"]);
        assert.deepEqual(provider.backgroundKinds(), ["serve"]);
        assert.isTrue(provider.sandbox(seeded.ref.sandboxId)?.serverRunning);

        // The server is still up: the launch step reuses it and nothing starts.
        const second = yield* manager.reconnect({
          provider,
          ref: seeded.ref,
          t3Version: "1.2.3",
          resume: true,
        });
        assert.lengthOf(provider.callsOf("resume"), 1);
        assert.deepEqual(provider.backgroundKinds(), ["serve"]);
        assert.deepEqual(provider.execKinds().slice(4), ["install", "launch", "pair"]);
        assert.notEqual(second.pairingToken, first.pairingToken);
        assertNoServerStartedByExec(provider);
      }),
    );
  });

  it.effect("waits for a stopping sandbox to stop before resuming it", () => {
    const provider = makeFakeSandboxProvider();
    const seeded = provider.seed({ status: "stopping" });
    provider.queueStatuses(seeded.ref.sandboxId, ["stopping", "stopping", "stopped"]);
    return withManager((manager) =>
      Effect.gen(function* () {
        const result = yield* settle(
          manager.reconnect({ provider, ref: seeded.ref, t3Version: "1.2.3", resume: true }),
        );
        assert.isTrue(Result.isSuccess(result));
        assert.lengthOf(provider.callsOf("resume"), 1);
      }),
    );
  });

  it.effect.each(["stopped", "stopping"] as const)(
    "leaves a %s sandbox alone when the reconnect may not start it",
    (status) => {
      const provider = makeFakeSandboxProvider();
      const seeded = provider.seed({ status });
      return withManager((manager) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(
            manager.reconnect({ provider, ref: seeded.ref, t3Version: "1.2.3", resume: false }),
          );
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) {
            assert.strictEqual(result.failure._tag, "SandboxStoppedError");
          }
          assert.lengthOf(provider.callsOf("resume"), 0);
          assert.lengthOf(provider.callsOf("exec"), 0);
        }),
      );
    },
  );

  it.effect.each([
    ["error", undefined, "error state"],
    ["destroyed", "not-found", "could not find the sandbox"],
  ] as const)("fails the resume stage for a sandbox in %s", ([status, failure, detail]) => {
    const provider = makeFakeSandboxProvider();
    const seeded = provider.seed({ status });
    return withManager((manager) =>
      Effect.gen(function* () {
        const error = expectEnvironmentError(
          yield* Effect.result(
            manager.reconnect({ provider, ref: seeded.ref, t3Version: "1.2.3", resume: true }),
          ),
        );
        assert.equal(error.stage, "resume");
        assert.equal(error.failure, failure);
        assert.include(error.detail, detail);
        assert.deepEqual(error.ref, seeded.ref);
        assert.lengthOf(provider.callsOf("exec"), 0);
      }),
    );
  });
});

describe("SandboxEnvironmentManager.stop and destroy", () => {
  it.effect("stops t3 serve cleanly before stopping the sandbox", () => {
    const provider = makeFakeSandboxProvider();
    const seeded = provider.seed({ status: "running", serverRunning: true });
    return withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.stop({ provider, ref: seeded.ref });
        assert.deepEqual(provider.execKinds(), ["stop"]);
        assert.lengthOf(provider.callsOf("stop"), 1);
        assert.equal(provider.sandbox(seeded.ref.sandboxId)?.status, "stopped");

        yield* manager.stop({ provider, ref: seeded.ref });
        assert.lengthOf(provider.callsOf("stop"), 1);
      }),
    );
  });

  it.effect("still stops the sandbox when stopping the server fails", () => {
    const provider = makeFakeSandboxProvider({
      exec: () => ({ exitCode: 1, stdout: "", stderr: "did not stop" }),
    });
    const seeded = provider.seed({ status: "running", serverRunning: true });
    return withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.stop({ provider, ref: seeded.ref });
        assert.lengthOf(provider.callsOf("stop"), 1);
      }),
    );
  });

  it.effect("maps a failed stop to the stop stage", () => {
    const provider = makeFakeSandboxProvider();
    const seeded = provider.seed({ status: "running" });
    provider.failNext("stop", "provider-error");
    return withManager((manager) =>
      Effect.gen(function* () {
        const error = expectEnvironmentError(
          yield* Effect.result(manager.stop({ provider, ref: seeded.ref })),
        );
        assert.equal(error.stage, "stop");
        assert.equal(error.detail, "boat failed to stop the sandbox.");
      }),
    );
  });

  it.effect("destroys a sandbox and treats one that is already gone as destroyed", () => {
    const provider = makeFakeSandboxProvider();
    const seeded = provider.seed();
    return withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.destroy({ provider, ref: seeded.ref });
        assert.equal(provider.sandbox(seeded.ref.sandboxId)?.status, "destroyed");
        yield* manager.destroy({ provider, ref: seeded.ref });
        assert.lengthOf(provider.callsOf("destroy"), 2);
      }),
    );
  });

  it.effect("maps other destroy failures to the destroy stage", () => {
    const provider = makeFakeSandboxProvider({ id: "boat" });
    const seeded = provider.seed();
    provider.failNext("destroy", "unauthorized");
    return withManager((manager) =>
      Effect.gen(function* () {
        const error = expectEnvironmentError(
          yield* Effect.result(manager.destroy({ provider, ref: seeded.ref })),
        );
        assert.equal(error.stage, "destroy");
        assert.equal(error.failure, "unauthorized");
        assert.include(error.detail, "boat rejected the credentials");
      }),
    );
  });
});
