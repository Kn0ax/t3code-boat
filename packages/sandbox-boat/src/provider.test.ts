// @effect-diagnostics nodeBuiltinImport:off - The fake sandbox shell is a local child process.
import type {
  CommandRequest,
  CreateSandboxRequest,
  ForkRequest,
  HostPortRequest,
} from "@boatdev/sdk";
import { FetchError, ResponseError } from "@boatdev/sdk";
import { assert, describe, it } from "@effect/vitest";
import type { SandboxCreateInput, SandboxRef } from "@t3tools/sandbox-core";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  BoatClient,
  BoatCommandFinished,
  BoatCommandStarted,
  BoatCommandStatus,
  BoatHostedPort,
} from "./client.ts";
import { BOAT_SANDBOX_NAME_PREFIX, boatIdempotencyKey } from "./mapping.ts";
import { BOAT_HOSTED_PORT_TITLE, makeBoatSandboxProviderFromClient } from "./provider.ts";

const ENV_SECRET = "sk-ant-api03-env-secret";
const PORT_TOKEN = "port-token-secret";

/**
 * Asserts nothing reachable from `error` except its `cause` contains
 * `secret`. The contract keeps the raw provider error in `cause` (a Defect
 * that is not serialized over IPC); everything else may reach the UI.
 */
function assertCarriesNoSecret(error: object, secret: string): void {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      assert.notInclude(value, secret, `${path} leaked a secret`);
      return;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) {
      return;
    }
    seen.add(value);
    for (const [key, nested] of Object.entries(value)) {
      if (key !== "cause") {
        walk(nested, `${path}.${key}`);
      }
    }
  };
  walk(error, "error");
  assert.notInclude((error as { message?: string }).message ?? "", secret);
  assert.notInclude(String(error), secret);
}

/** What the SDK throws for a non-2xx answer, with boat's error envelope as the body. */
function boatError(status: number, envelope: Record<string, unknown> = {}): ResponseError {
  return new ResponseError(
    new Response(
      JSON.stringify({ ok: false, status, message: `echo ${ENV_SECRET}`, ...envelope }),
      {
        status,
        headers: { "content-type": "application/json" },
      },
    ),
    "Response returned an error code",
  );
}

function networkError(): FetchError {
  return new FetchError(
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" }),
    }),
    "The request failed and the interceptors did not return an alternative response",
  );
}

/** Runs a command the way boat's command endpoint does: one string through bash, no stdin. */
function runInBash(command: string, env?: Readonly<Record<string, string>>) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    const child = NodeChildProcess.spawn("bash", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    });
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

const finished = (result: Partial<BoatCommandFinished> = {}): BoatCommandFinished => ({
  type: "command.finished",
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...result,
});

const startedProcess = (processId: number): BoatCommandStarted => ({
  type: "command.started",
  processId,
});

const commandStatus = (status: Partial<BoatCommandStatus>): BoatCommandStatus => ({
  status: "running",
  running: true,
  exitCode: null,
  stdout: "",
  stderr: "",
  ...status,
});

interface FakeSandbox {
  id: string;
  name?: string;
  ttlSeconds?: number;
  state: string;
  stop?: { status: string } | null;
  access?: string;
}

type Method = keyof BoatClient;

interface Call {
  readonly method: Method;
  readonly sandboxId: string | undefined;
  readonly request: unknown;
}

/**
 * An in-memory boat. Every method records its call, then throws the next
 * error queued for it with `failNext`, if any. Creates and forks honor the
 * `Idempotency-Key`, and commands run in a local bash unless replaced.
 */
function makeFakeBoat() {
  const sandboxes = new Map<string, FakeSandbox>();
  const calls: Array<Call> = [];
  const queued = new Map<Method, Array<unknown>>();
  const keys = new Map<string, string>();
  const files = new Map<string, { content: string; encoding: string }>();
  let nextId = 0;

  let onCommand: (
    sandboxId: string,
    request: CommandRequest,
  ) => Promise<BoatCommandFinished | BoatCommandStarted | { readonly type?: undefined }> = async (
    _sandboxId,
    request,
  ) => finished(await runInBash(request.command));
  let onCommandStatus: (request: {
    readonly processId: number;
    readonly stdoutOffset: number;
    readonly stderrOffset: number;
  }) => Promise<BoatCommandStatus> = async () =>
    commandStatus({ status: "exited", running: false, exitCode: 0 });
  let onHostPort: (sandboxId: string, request: HostPortRequest) => Promise<BoatHostedPort> = async (
    sandboxId,
    request,
  ) => ({
    url: `https://${sandboxId}-${request.port}.on.boat.dev/?_token=${PORT_TOKEN}`,
    access: "private",
    isProtected: true,
  });

  const enter = (method: Method, sandboxId?: string, request?: unknown) => {
    calls.push({ method, sandboxId, request });
    const error = queued.get(method)?.shift();
    if (error !== undefined) {
      throw error;
    }
  };

  const addSandbox = (init: Partial<FakeSandbox> = {}): FakeSandbox => {
    nextId += 1;
    const sandbox: FakeSandbox = { id: `sb-${nextId}`, state: "ready", access: "owner", ...init };
    sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  };

  const sandboxOf = (sandboxId: string): FakeSandbox => {
    const sandbox = sandboxes.get(sandboxId);
    if (sandbox === undefined) {
      throw boatError(404, { code: "sandbox_not_found" });
    }
    return sandbox;
  };

  const client: BoatClient = {
    create: async (request) => {
      enter("create", undefined, request);
      const existing = keys.get(request.idempotencyKey);
      if (existing !== undefined) {
        return { sandbox: { ...sandboxOf(existing) } };
      }
      const sandbox = addSandbox({ state: "provisioning" });
      keys.set(request.idempotencyKey, sandbox.id);
      return { sandbox: { ...sandbox } };
    },
    get: async (sandboxId) => {
      enter("get", sandboxId);
      return { sandbox: { ...sandboxOf(sandboxId) } };
    },
    list: async (request) => {
      enter("list", undefined, request);
      return { sandboxes: [...sandboxes.values()].map((sandbox) => ({ ...sandbox })) };
    },
    rename: async (sandboxId, name) => {
      enter("rename", sandboxId, name);
      const sandbox = sandboxOf(sandboxId);
      sandbox.name = name;
      return { sandbox: { ...sandbox } };
    },
    command: async (sandboxId, request) => {
      enter("command", sandboxId, request);
      sandboxOf(sandboxId);
      return onCommand(sandboxId, request);
    },
    commandStatus: async (sandboxId, request) => {
      enter("commandStatus", sandboxId, request);
      return onCommandStatus(request);
    },
    stopCommand: async (sandboxId, processId) => {
      enter("stopCommand", sandboxId, processId);
      return {};
    },
    readFile: async (sandboxId, path) => {
      enter("readFile", sandboxId, path);
      const file = files.get(`${sandboxOf(sandboxId).id}:${path}`);
      if (file === undefined) {
        throw boatError(404, { code: "file_not_found" });
      }
      return file;
    },
    writeFile: async (sandboxId, request) => {
      enter("writeFile", sandboxId, request);
      files.set(`${sandboxOf(sandboxId).id}:${request.path}`, {
        content: request.contentBase64,
        encoding: "base64",
      });
      return {};
    },
    hostPort: async (sandboxId, request) => {
      enter("hostPort", sandboxId, request);
      sandboxOf(sandboxId);
      return onHostPort(sandboxId, request);
    },
    setTtl: async (sandboxId, ttlSeconds) => {
      enter("setTtl", sandboxId, ttlSeconds);
      const sandbox = sandboxOf(sandboxId);
      sandbox.ttlSeconds = ttlSeconds;
      return { sandbox: { ...sandbox } };
    },
    stop: async (sandboxId) => {
      enter("stop", sandboxId);
      sandboxOf(sandboxId).state = "archiving";
      return {};
    },
    resume: async (sandboxId) => {
      enter("resume", sandboxId);
      const sandbox = sandboxOf(sandboxId);
      sandbox.state = "provisioning";
      return { sandbox: { ...sandbox } };
    },
    deleteSandbox: async (sandboxId) => {
      enter("deleteSandbox", sandboxId);
      sandboxOf(sandboxId);
      sandboxes.delete(sandboxId);
      return {};
    },
    fork: async (sandboxId, request) => {
      enter("fork", sandboxId, request);
      const source = sandboxOf(sandboxId);
      const existing = keys.get(request.idempotencyKey);
      if (existing !== undefined) {
        return { id: existing, sandbox: { ...sandboxOf(existing) } };
      }
      const forked = addSandbox({
        state: "provisioning",
        ...(source.name === undefined ? {} : { name: source.name }),
      });
      keys.set(request.idempotencyKey, forked.id);
      return { id: forked.id, sandbox: { ...forked } };
    },
  };

  return {
    client,
    calls,
    sandboxes,
    files,
    addSandbox,
    failNext: (method: Method, ...errors: ReadonlyArray<unknown>) => {
      queued.set(method, [...(queued.get(method) ?? []), ...errors]);
    },
    callsOf: (method: Method) => calls.filter((entry) => entry.method === method),
    setCommand: (handler: typeof onCommand) => {
      onCommand = handler;
    },
    setCommandStatus: (handler: typeof onCommandStatus) => {
      onCommandStatus = handler;
    },
    setHostPort: (handler: typeof onHostPort) => {
      onHostPort = handler;
    },
  };
}

const refOf = (sandbox: { readonly id: string }): SandboxRef => ({
  providerId: "boat",
  sandboxId: sandbox.id,
});

const createInput: SandboxCreateInput = {
  label: "fix the flaky test",
  env: { GH_TOKEN: "ghp_token", ANTHROPIC_API_KEY: ENV_SECRET },
  size: "medium",
  idleTimeoutMinutes: 30,
  idempotencyKey: "provision-1",
};

/**
 * Runs `effect` while moving the test clock on, for code that sleeps or
 * retries; the in-memory fake answers between steps.
 */
const withClock = <A, E>(effect: Effect.Effect<A, E>, step = Duration.seconds(1)) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    for (let tick = 0; tick < 5_000 && fiber.pollUnsafe() === undefined; tick += 1) {
      for (let spin = 0; spin < 5; spin += 1) {
        yield* Effect.yieldNow;
      }
      if (fiber.pollUnsafe() === undefined) {
        yield* TestClock.adjust(step);
      }
    }
    return yield* Fiber.join(fiber);
  });

describe("create", () => {
  it.effect("creates a no-env sandbox with the size, TTL, sorted env and a hashed key", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      const info = yield* provider.create(createInput);

      const [create] = fake.callsOf("create");
      const request = create!.request as { idempotencyKey: string; body: CreateSandboxRequest };
      assert.equal(request.idempotencyKey, boatIdempotencyKey("provision-1"));
      assert.deepEqual(request.body, {
        type: "default",
        ttlSeconds: 1800,
        env: { ANTHROPIC_API_KEY: ENV_SECRET, GH_TOKEN: "ghp_token" },
        noEnv: true,
      });
      assert.deepEqual(Object.keys(request.body.env ?? {}), ["ANTHROPIC_API_KEY", "GH_TOKEN"]);
      assert.deepEqual(
        fake.callsOf("rename")[0]!.request,
        `${BOAT_SANDBOX_NAME_PREFIX}fix the flaky test`,
      );
      assert.deepEqual(info, {
        ref: { providerId: "boat", sandboxId: "sb-1" },
        status: "creating",
        label: "fix the flaky test",
      });
    }),
  );

  it.effect("maps sizes and auto-stop, and attaches an environment only when asked", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const withEnvironment = makeBoatSandboxProviderFromClient(fake.client, {
        environment: "t3",
        monitoring: false,
      });
      const optedIn = makeBoatSandboxProviderFromClient(fake.client, { noEnv: false });

      yield* withEnvironment.create({ ...createInput, size: "small", idleTimeoutMinutes: 0 });
      yield* optedIn.create({
        ...createInput,
        size: "large",
        idleTimeoutMinutes: Number.NaN,
        idempotencyKey: "provision-2",
      });

      const [first, second] = fake
        .callsOf("create")
        .map((entry) => (entry.request as { body: CreateSandboxRequest }).body);
      assert.deepInclude(first, {
        type: "small",
        ttlSeconds: null,
        noEnv: false,
        environment: "t3",
        monitoring: false,
      });
      assert.equal(second!.type, "large");
      assert.equal(second!.noEnv, false);
      // NaN must not turn auto-stop off: boat's 1 hour default applies.
      assert.notProperty(second, "ttlSeconds");
      assert.notProperty(second, "environment");
    }),
  );

  it.effect("starts from a named snapshot and reports a missing one as not-found", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      yield* provider.create({ ...createInput, snapshot: "t3-acme-app" });
      fake.failNext("create", boatError(404, { code: "snapshot_not_found" }));
      const missing = yield* Effect.flip(
        provider.create({ ...createInput, snapshot: "t3-base", idempotencyKey: "provision-2" }),
      );

      const body = (fake.callsOf("create")[0]!.request as { body: CreateSandboxRequest }).body;
      assert.equal(body.from, "t3-acme-app");
      assert.equal(missing.failure, "not-found");
      assert.equal(fake.sandboxes.size, 1);
    }),
  );

  it.effect("answers a retried create with the first sandbox and does not rename it again", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      const first = yield* provider.create(createInput);
      const second = yield* provider.create(createInput);

      assert.deepEqual(second.ref, first.ref);
      assert.equal(fake.sandboxes.size, 1);
      assert.equal(fake.callsOf("rename").length, 1);
    }),
  );

  it.effect("refuses a region boat cannot honor and env boat would reject, before any call", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      const region = yield* provider
        .create({ ...createInput, region: "us-east" })
        .pipe(Effect.flip);
      const reserved = yield* provider
        .create({ ...createInput, env: { BOAT_CLI_TOKEN: ENV_SECRET } })
        .pipe(Effect.flip);
      const badName = yield* provider
        .create({ ...createInput, env: { [`BAD-${ENV_SECRET}`]: ENV_SECRET } })
        .pipe(Effect.flip);
      const eu = yield* provider.create({ ...createInput, region: "eu" });

      for (const error of [region, reserved, badName]) {
        assert.equal(error.operation, "create");
        assert.equal(error.failure, "unsupported");
        assertCarriesNoSecret(error, ENV_SECRET);
      }
      assert.equal(eu.status, "creating");
      assert.equal(fake.callsOf("create").length, 1);
    }),
  );

  it.effect("waits out a create still minting under the same key", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      fake.failNext(
        "create",
        boatError(409, { code: "idempotency_in_progress" }),
        boatError(409, { code: "idempotency_in_progress" }),
      );
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      const info = yield* withClock(provider.create(createInput));

      assert.equal(info.ref.sandboxId, "sb-1");
      const keys = fake
        .callsOf("create")
        .map((entry) => (entry.request as { idempotencyKey: string }).idempotencyKey);
      assert.deepEqual(keys, Array(3).fill(boatIdempotencyKey("provision-1")));
    }),
  );

  it.effect("resends a create that got no answer or a 502, but not one refused for capacity", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      fake.failNext("create", networkError(), boatError(502));
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      const info = yield* withClock(provider.create(createInput));
      assert.equal(info.ref.sandboxId, "sb-1");
      assert.equal(fake.callsOf("create").length, 3);

      fake.failNext("create", boatError(503, { code: "out_of_capacity" }));
      const capacity = yield* withClock(
        provider.create({ ...createInput, idempotencyKey: "provision-2" }).pipe(Effect.flip),
      );
      assert.equal(capacity.failure, "provider-error");
      assert.equal(fake.callsOf("create").length, 4);

      fake.failNext("create", networkError(), networkError(), networkError());
      const offline = yield* withClock(
        provider.create({ ...createInput, idempotencyKey: "provision-3" }).pipe(Effect.flip),
      );
      assert.equal(offline.failure, "network");
      assert.equal(fake.callsOf("create").length, 7);
    }),
  );

  it.effect("keeps a created sandbox when naming it fails", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      fake.failNext("rename", boatError(500));
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      const info = yield* provider.create(createInput);

      assert.equal(info.ref.sandboxId, "sb-1");
      assert.equal(info.label, "fix the flaky test");
    }),
  );

  it.effect("maps a rejected create without quoting boat's error body", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      fake.failNext(
        "create",
        boatError(401),
        boatError(402, { code: "credit_required" }),
        boatError(429, { code: "limit_reached" }),
      );
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      const failures = [];
      for (const key of ["a", "b", "c"]) {
        const error = yield* provider
          .create({ ...createInput, idempotencyKey: key })
          .pipe(Effect.flip);
        assertCarriesNoSecret(error, ENV_SECRET);
        failures.push(error.failure);
      }

      assert.deepEqual(failures, ["unauthorized", "quota-exceeded", "quota-exceeded"]);
    }),
  );

  it.effect("gives up on a create boat never answers", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const provider = makeBoatSandboxProviderFromClient(
        { ...fake.client, create: () => new Promise<never>(() => {}) },
        { requestTimeoutMs: 5_000 },
      );

      const error = yield* withClock(provider.create(createInput).pipe(Effect.flip));

      assert.equal(error.failure, "timeout");
    }),
  );
});

describe("get / list", () => {
  it.effect("reads a sandbox and lists only the caller's T3 sandboxes across pages", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const mine = fake.addSandbox({ name: `${BOAT_SANDBOX_NAME_PREFIX}mine`, state: "idle" });
      fake.addSandbox({ name: "not t3" });
      fake.addSandbox({ name: `${BOAT_SANDBOX_NAME_PREFIX}teammate`, access: "use" });
      fake.addSandbox({ name: `${BOAT_SANDBOX_NAME_PREFIX}gone`, state: "cancelled" });
      const stopped = fake.addSandbox({
        name: `${BOAT_SANDBOX_NAME_PREFIX}stopped`,
        state: "archived",
      });
      const pages = [
        {
          sandboxes: [...fake.sandboxes.values()].slice(0, 3),
          pageInfo: { nextCursor: "c2", hasMore: true },
        },
        {
          sandboxes: [...fake.sandboxes.values()].slice(3),
          pageInfo: { nextCursor: null, hasMore: false },
        },
      ];
      const cursors: Array<string | undefined> = [];
      const provider = makeBoatSandboxProviderFromClient({
        ...fake.client,
        list: async (request) => {
          cursors.push(request.cursor);
          return pages[cursors.length - 1]!;
        },
      });

      const info = yield* provider.get(refOf(mine));
      const listed = yield* provider.list();

      assert.deepEqual(info, { ref: refOf(mine), status: "running", label: "mine" });
      assert.deepEqual(cursors, [undefined, "c2"]);
      assert.deepEqual(
        listed.map((entry) => [entry.ref.sandboxId, entry.status, entry.label]),
        [
          [mine.id, "running", "mine"],
          [stopped.id, "stopped", "stopped"],
        ],
      );
    }),
  );

  it.effect("reports a missing sandbox and refuses another provider's ref", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      const missing = yield* provider
        .get({ providerId: "boat", sandboxId: "nope" })
        .pipe(Effect.flip);
      const foreign = yield* provider
        .get({ providerId: "elsewhere", sandboxId: "sb-1" } as unknown as SandboxRef)
        .pipe(Effect.flip);

      assert.equal(missing.failure, "not-found");
      assert.equal(foreign.failure, "unsupported");
      assert.equal(fake.callsOf("get").length, 1);
    }),
  );
});

describe("exec", () => {
  it.effect('delivers the script byte-exact with "$@" through a synchronous command', () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const sandbox = fake.addSandbox();
      const provider = makeBoatSandboxProviderFromClient(fake.client);
      const script = [
        "# quotes ' \" ` $HOME $(id) \\ and unicode: héllo ✓",
        'printf "%s|" "$#" "$@"',
        "printf 'to stderr' >&2",
        "exit 3",
        "",
      ].join("\n");
      const args = ["with space", "it's", "$(id)", "", "trailing\n"];

      const result = yield* provider.exec(refOf(sandbox), { script, args, timeoutMs: 90_500 });

      assert.deepEqual(result, {
        exitCode: 3,
        stdout: "5|with space|it's|$(id)||trailing\n|",
        stderr: "to stderr",
      });
      const request = fake.callsOf("command")[0]!.request as CommandRequest;
      assert.equal(request.timeoutSeconds, 91);
      assert.isUndefined(request.detached);
      assert.notInclude(request.command, "with space");
    }),
  );

  it.effect("maps boat's verdicts: signals, timeouts, truncation and odd answers", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const sandbox = fake.addSandbox();
      const provider = makeBoatSandboxProviderFromClient(fake.client);
      const answers = [
        finished({ exitCode: null, signal: "SIGTERM" }),
        finished({ exitCode: null, oomKilled: true }),
        finished({ timedOut: true, exitCode: null }),
        finished({ stdout: '{"partial":', stdoutTruncated: true }),
        finished({ exitCode: null }),
        startedProcess(1),
      ];
      fake.setCommand(async () => answers.shift()!);
      const run = provider.exec(refOf(sandbox), { script: "true", timeoutMs: 10_000 });

      const signaled = yield* run;
      const oom = yield* run;
      const timedOut = yield* Effect.flip(run);
      const truncated = yield* Effect.flip(run);
      const noStatus = yield* Effect.flip(run);
      const notFinished = yield* Effect.flip(run);

      assert.equal(signaled.exitCode, 143);
      assert.equal(oom.exitCode, 137);
      assert.equal(timedOut.failure, "timeout");
      assert.equal(truncated.failure, "provider-error");
      assert.equal(noStatus.failure, "provider-error");
      assert.equal(notFinished.failure, "provider-error");
    }),
  );

  it.effect("refuses what it cannot run before calling boat", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const sandbox = fake.addSandbox();
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      const tooLarge = yield* provider
        .exec(refOf(sandbox), { script: "x".repeat(100_000), timeoutMs: 1_000 })
        .pipe(Effect.flip);
      const noBudget = yield* provider
        .exec(refOf(sandbox), { script: "true", timeoutMs: Number.NaN })
        .pipe(Effect.flip);
      const foreign = yield* provider
        .exec({ providerId: "elsewhere", sandboxId: sandbox.id } as unknown as SandboxRef, {
          script: "true",
          timeoutMs: 1_000,
        })
        .pipe(Effect.flip);

      for (const error of [tooLarge, noBudget, foreign]) {
        assert.equal(error.operation, "exec");
        assert.equal(error.failure, "unsupported");
      }
      assert.equal(fake.callsOf("command").length, 0);
    }),
  );

  it.effect("resends a command boat refused as retryable while the sandbox was starting", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const sandbox = fake.addSandbox();
      fake.setCommand(async () => finished({ stdout: "ok" }));
      fake.failNext("command", boatError(409, { code: "boat_starting", retryable: true }));
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      const result = yield* withClock(
        provider.exec(refOf(sandbox), { script: "true", timeoutMs: 1_000 }),
      );
      assert.equal(result.stdout, "ok");
      assert.equal(fake.callsOf("command").length, 2);

      // Not retryable: the sandbox is stopped, and resending would not help.
      fake.failNext("command", boatError(409, { code: "sandbox_not_ready", retryable: false }));
      const notReady = yield* withClock(
        provider.exec(refOf(sandbox), { script: "true", timeoutMs: 1_000 }).pipe(Effect.flip),
      );
      assert.equal(notReady.failure, "provider-error");
      assert.equal(fake.callsOf("command").length, 3);
    }),
  );

  it.effect("fails with a timeout when boat never answers a synchronous command", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const sandbox = fake.addSandbox();
      fake.setCommand(() => new Promise<never>(() => {}));
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      const fiber = yield* provider
        .exec(refOf(sandbox), { script: "sleep 600", timeoutMs: 5_000 })
        .pipe(Effect.flip, Effect.forkChild);
      for (let attempt = 0; attempt < 100 && fake.callsOf("command").length === 0; attempt++) {
        yield* Effect.yieldNow;
      }
      // boat may hold a command 60 s for a starting sandbox before running it.
      yield* TestClock.adjust(Duration.seconds(94));
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust(Duration.seconds(2));
      const error = yield* Fiber.join(fiber);

      assert.equal(error.operation, "exec");
      assert.equal(error.failure, "timeout");
    }),
  );

  it.effect("runs a long exec detached and reads its output on from each offset", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const sandbox = fake.addSandbox();
      fake.setCommand(async () => startedProcess(42));
      const polls = [
        commandStatus({ stdout: "héllo ", stdoutNextOffset: 7, more: true }),
        commandStatus({
          stdout: "wörld",
          stderr: "warn",
          stdoutOffset: 7,
          stdoutNextOffset: 13,
          stderrNextOffset: 4,
        }),
        commandStatus({ stdoutOffset: 13, stderrOffset: 4 }),
        commandStatus({
          status: "exited",
          running: false,
          exitCode: 0,
          stdout: "\n",
          stdoutOffset: 13,
          stderrOffset: 4,
        }),
      ];
      fake.setCommandStatus(async () => polls.shift()!);
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      const result = yield* withClock(
        provider.exec(refOf(sandbox), { script: "install", timeoutMs: 900_000 }),
      );

      assert.deepEqual(result, { exitCode: 0, stdout: "héllo wörld\n", stderr: "warn" });
      const request = fake.callsOf("command")[0]!.request as CommandRequest;
      assert.isTrue(request.detached);
      assert.isUndefined(request.timeoutSeconds);
      assert.deepEqual(
        fake.callsOf("commandStatus").map((entry) => entry.request),
        [
          { processId: 42, stdoutOffset: 0, stderrOffset: 0 },
          { processId: 42, stdoutOffset: 7, stderrOffset: 0 },
          { processId: 42, stdoutOffset: 13, stderrOffset: 4 },
          { processId: 42, stdoutOffset: 13, stderrOffset: 4 },
        ],
      );
      assert.equal(fake.callsOf("stopCommand").length, 0);
    }),
  );

  it.effect("stops a detached exec that runs out of budget", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const sandbox = fake.addSandbox();
      fake.setCommand(async () => startedProcess(7));
      fake.setCommandStatus(async () => commandStatus({}));
      const provider = makeBoatSandboxProviderFromClient(fake.client, {
        execPollIntervalMs: 5_000,
      });

      const error = yield* withClock(
        provider
          .exec(refOf(sandbox), { script: "sleep 9999", timeoutMs: 601_000 })
          .pipe(Effect.flip),
        Duration.seconds(5),
      );

      assert.equal(error.failure, "timeout");
      assert.deepEqual(
        fake.callsOf("stopCommand").map((entry) => entry.request),
        [7],
      );
    }),
  );

  it.effect("rides out a blip while polling, but not a replaced log or a lost process", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const sandbox = fake.addSandbox();
      fake.setCommand(async () => startedProcess(9));
      const provider = makeBoatSandboxProviderFromClient(fake.client);
      const run = provider.exec(refOf(sandbox), { script: "x", timeoutMs: 700_000 });

      fake.failNext("commandStatus", networkError(), boatError(502));
      fake.setCommandStatus(async () =>
        commandStatus({ status: "exited", running: false, exitCode: 4 }),
      );
      const recovered = yield* withClock(run);
      assert.equal(recovered.exitCode, 4);
      assert.equal(fake.callsOf("stopCommand").length, 0);

      const replaced = [
        commandStatus({ stdout: "a", stdoutNextOffset: 1 }),
        commandStatus({ stdout: "b", stdoutOffset: 0, stdoutNextOffset: 1 }),
      ];
      fake.setCommandStatus(async () => replaced.shift()!);
      const lostLog = yield* withClock(Effect.flip(run));
      assert.equal(lostLog.failure, "provider-error");
      assert.equal(fake.callsOf("stopCommand").length, 1);

      fake.setCommandStatus(async () => commandStatus({ status: "lost", running: false }));
      const lost = yield* withClock(Effect.flip(run));
      assert.equal(lost.failure, "provider-error");
    }),
  );
});

describe("startBackground", () => {
  it.effect("starts a detached command that writes everything to the log", () =>
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-boat-bg-"))),
        (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
      );
      const fake = makeFakeBoat();
      const sandbox = fake.addSandbox();
      const ran: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
      fake.setCommand(async (_sandboxId, request) => {
        // boat answers at once and leaves the process running; the fake runs it to the end.
        ran.push(await runInBash(request.command, { HOME: home }));
        return startedProcess(11);
      });
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      yield* provider.startBackground(refOf(sandbox), {
        script: 'printf "serving %s\\n" "$1"; printf "warn\\n" >&2',
        args: ["--port 3773"],
        logPath: "~/.t3/ssh-launch/sandbox/server.log",
      });

      const request = fake.callsOf("command")[0]!.request as CommandRequest;
      assert.isTrue(request.detached);
      assert.isUndefined(request.timeoutSeconds);
      assert.notInclude(request.command, "server.log");
      assert.deepEqual(ran, [{ exitCode: 0, stdout: "", stderr: "" }]);
      assert.equal(
        NodeFS.readFileSync(NodePath.join(home, ".t3/ssh-launch/sandbox/server.log"), "utf8"),
        "serving --port 3773\nwarn\n",
      );
    }),
  );

  it.effect("refuses an empty log path and reports an answer that is not a start", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const sandbox = fake.addSandbox();
      fake.setCommand(async () => finished());
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      const noLog = yield* provider
        .startBackground(refOf(sandbox), { script: "serve", logPath: " " })
        .pipe(Effect.flip);
      const notStarted = yield* provider
        .startBackground(refOf(sandbox), { script: "serve", logPath: "/tmp/log" })
        .pipe(Effect.flip);

      assert.equal(noLog.operation, "startBackground");
      assert.equal(noLog.failure, "unsupported");
      assert.equal(notStarted.failure, "provider-error");
      assert.equal(fake.callsOf("command").length, 1);
    }),
  );

  it.effect("resends a retryable refusal and maps a missing sandbox", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const sandbox = fake.addSandbox();
      fake.setCommand(async () => startedProcess(3));
      fake.failNext("command", boatError(409, { code: "boat_starting", retryable: true }));
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      yield* withClock(
        provider.startBackground(refOf(sandbox), { script: "serve", logPath: "/tmp/log" }),
      );
      const missing = yield* provider
        .startBackground(
          { providerId: "boat", sandboxId: "gone" },
          { script: "serve", logPath: "/tmp/log" },
        )
        .pipe(Effect.flip);

      assert.equal(fake.callsOf("command").length, 3);
      assert.equal(missing.operation, "startBackground");
      assert.equal(missing.failure, "not-found");
    }),
  );
});

describe("files", () => {
  it.effect("writes and reads bytes as base64, resolving ~ against the work directory", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const sandbox = fake.addSandbox();
      const provider = makeBoatSandboxProviderFromClient(fake.client);
      const bytes = new Uint8Array([0, 1, 2, 255, 10, 13]);

      yield* provider.writeFile(refOf(sandbox), "~/.config/creds.json", bytes);
      const read = yield* provider.readFile(refOf(sandbox), "~/.config/creds.json");

      assert.deepEqual(fake.callsOf("writeFile")[0]!.request, {
        path: ".config/creds.json",
        contentBase64: Base64.encode(bytes),
      });
      assert.deepEqual(fake.callsOf("readFile")[0]!.request, ".config/creds.json");
      assert.deepEqual([...read], [...bytes]);
    }),
  );

  it.effect("accepts a utf8 answer, and maps missing files and bad base64", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const sandbox = fake.addSandbox();
      fake.files.set(`${sandbox.id}:/tmp/text`, { content: "héllo", encoding: "utf8" });
      fake.files.set(`${sandbox.id}:/tmp/broken`, { content: "not base64!", encoding: "base64" });
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      const text = yield* provider.readFile(refOf(sandbox), "/tmp/text");
      const missing = yield* provider.readFile(refOf(sandbox), "/tmp/none").pipe(Effect.flip);
      const broken = yield* provider.readFile(refOf(sandbox), "/tmp/broken").pipe(Effect.flip);

      assert.equal(new TextDecoder().decode(text), "héllo");
      assert.equal(missing.failure, "not-found");
      assert.equal(broken.failure, "provider-error");
      assert.equal(fake.callsOf("command").length, 0);
    }),
  );

  /**
   * A boat whose file API and commands share one real home directory, with
   * the file API's 5 MiB limit, so large files must go through the sandbox.
   */
  const makeDiskBoat = (home: string) => {
    const fake = makeFakeBoat();
    const sandbox = fake.addSandbox();
    const onDisk = (path: string) => (NodePath.isAbsolute(path) ? path : NodePath.join(home, path));
    fake.setCommand(async (_sandboxId, request) =>
      finished(await runInBash(request.command, { HOME: home })),
    );
    const client: BoatClient = {
      ...fake.client,
      readFile: async (sandboxId, path) => {
        fake.calls.push({ method: "readFile", sandboxId, request: path });
        const file = onDisk(path);
        if (!NodeFS.existsSync(file)) {
          throw boatError(404, { code: "file_not_found" });
        }
        if (NodeFS.statSync(file).size > 5 * 1024 * 1024) {
          throw boatError(413, { code: "file_too_large" });
        }
        return { content: NodeFS.readFileSync(file).toString("base64"), encoding: "base64" };
      },
      writeFile: async (sandboxId, request) => {
        fake.calls.push({ method: "writeFile", sandboxId, request: request.path });
        const bytes = Buffer.from(request.contentBase64, "base64");
        if (bytes.byteLength > 5 * 1024 * 1024) {
          throw boatError(413, { code: "file_too_large" });
        }
        NodeFS.mkdirSync(NodePath.dirname(onDisk(request.path)), { recursive: true });
        NodeFS.writeFileSync(onDisk(request.path), bytes);
        return {};
      },
    };
    return { fake, sandbox, client };
  };

  const tempHome = Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-boat-files-"))),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

  it.effect("moves files over the 5 MiB file API limit in parts, leaving none behind", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      const { fake, sandbox, client } = makeDiskBoat(home);
      const provider = makeBoatSandboxProviderFromClient(client);
      const bytes = new Uint8Array(11 * 1024 * 1024 + 7);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = (index * 31 + (index >> 12)) & 0xff;
      }

      yield* provider.writeFile(refOf(sandbox), "~/.t3/state/workspace.bundle", bytes);
      const onDisk = NodeFS.readFileSync(NodePath.join(home, ".t3/state/workspace.bundle"));
      const read = yield* provider.readFile(refOf(sandbox), ".t3/state/workspace.bundle");

      assert.isTrue(Buffer.from(bytes).equals(onDisk));
      assert.isTrue(Buffer.from(bytes).equals(Buffer.from(read)));
      // Three 4 MiB parts each way, plus the refused whole read.
      assert.equal(fake.callsOf("writeFile").length, 3);
      assert.equal(fake.callsOf("readFile").length, 4);
      assert.deepEqual(
        NodeFS.readdirSync(home).filter((name) => name.startsWith(".t3-transfer.")),
        [],
      );
    }),
  );

  it.effect("keeps a small file's refusal and reports a missing large read as not-found", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      const { fake, sandbox, client } = makeDiskBoat(home);
      const refusing: BoatClient = {
        ...client,
        readFile: async (sandboxId, path) => {
          fake.calls.push({ method: "readFile", sandboxId, request: path });
          throw boatError(400, { code: "bad_path" });
        },
      };
      NodeFS.writeFileSync(NodePath.join(home, "small"), "hi");
      const provider = makeBoatSandboxProviderFromClient(refusing);

      const small = yield* provider.readFile(refOf(sandbox), "small").pipe(Effect.flip);
      const missing = yield* provider.readFile(refOf(sandbox), "/nowhere/file").pipe(Effect.flip);

      assert.equal(small.operation, "readFile");
      assert.equal(small.failure, "provider-error");
      assert.equal(missing.failure, "not-found");
      assert.equal(fake.callsOf("readFile").length, 2);
    }),
  );
});

describe("exposePort", () => {
  it.effect("hosts the port privately and separates its token from the bare origin", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const sandbox = fake.addSandbox();
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      const exposed = yield* provider.exposePort(refOf(sandbox), 3773);

      assert.deepEqual(fake.callsOf("hostPort")[0]!.request, {
        port: 3773,
        _public: false,
        title: BOAT_HOSTED_PORT_TITLE,
      });
      assert.deepEqual(exposed, {
        httpBaseUrl: `https://${sandbox.id}-3773.on.boat.dev`,
        headers: { Cookie: `_port_auth=${PORT_TOKEN}` },
      });
    }),
  );

  it.effect("accepts tokenized private responses even without optional access metadata", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const sandbox = fake.addSandbox();
      const provider = makeBoatSandboxProviderFromClient(fake.client);
      const tokenized = `https://x-3773.on.boat.dev/?_token=${PORT_TOKEN}`;

      fake.setHostPort(async () => ({ url: tokenized }));
      const exposed = yield* provider.exposePort(refOf(sandbox), 3773);
      assert.deepEqual(exposed, {
        httpBaseUrl: "https://x-3773.on.boat.dev",
        headers: { Cookie: `_port_auth=${PORT_TOKEN}` },
      });
    }),
  );

  it.effect("refuses public downgrades and malformed responses without exposing tokens", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const sandbox = fake.addSandbox();
      const provider = makeBoatSandboxProviderFromClient(fake.client);
      for (const response of [
        { url: "https://x-3773.on.boat.dev", access: "public" },
        { url: `https://x-3773.on.boat.dev/?_token=${PORT_TOKEN}`, isProtected: false },
        { url: "https://x-3773.on.boat.dev", access: "private" },
        { url: `https://x-3773.on.boat.dev/?_token=${PORT_TOKEN}&extra=1` },
      ]) {
        fake.setHostPort(async () => response);
        const error = yield* provider.exposePort(refOf(sandbox), 3773).pipe(Effect.flip);
        assert.equal(error.failure, "unsupported");
        assert.isUndefined(error.cause);
        assertCarriesNoSecret(error, PORT_TOKEN);
      }
      fake.setHostPort(async () => ({}));
      const noUrl = yield* provider.exposePort(refOf(sandbox), 3773).pipe(Effect.flip);
      const badPort = yield* provider.exposePort(refOf(sandbox), 70_000).pipe(Effect.flip);

      assert.equal(noUrl.failure, "provider-error");
      assert.equal(badPort.failure, "unsupported");
    }),
  );
});

describe("stop / resume / destroy", () => {
  it.effect("stops a running sandbox once and leaves one already stopping alone", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const running = fake.addSandbox({ state: "idle" });
      const archiving = fake.addSandbox({ state: "archiving" });
      const pending = fake.addSandbox({ state: "ready", stop: { status: "pending" } });
      const archived = fake.addSandbox({ state: "archived" });
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      for (const sandbox of [running, archiving, pending, archived]) {
        yield* provider.stop(refOf(sandbox));
      }

      assert.deepEqual(
        fake.callsOf("stop").map((entry) => entry.sandboxId),
        [running.id],
      );
      assert.equal((yield* provider.get(refOf(running))).status, "stopping");
    }),
  );

  it.effect("resumes a stopped sandbox and reports one already up as it is", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const archived = fake.addSandbox({ state: "archived" });
      const ready = fake.addSandbox({ state: "ready" });
      const failed = fake.addSandbox({ state: "error" });
      const cancelled = fake.addSandbox({ state: "cancelled" });
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      const resumed = yield* provider.resume(refOf(archived));
      const up = yield* provider.resume(refOf(ready));
      const broken = yield* provider.resume(refOf(failed));
      const gone = yield* provider.resume(refOf(cancelled)).pipe(Effect.flip);

      assert.equal(resumed.status, "creating");
      assert.equal(up.status, "running");
      assert.equal(broken.status, "error");
      assert.equal(gone.failure, "not-found");
      assert.deepEqual(
        fake.callsOf("resume").map((entry) => entry.sandboxId),
        [archived.id],
      );
    }),
  );

  it.effect("reads a conflicting resume as won by someone else when the sandbox is coming up", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const sandbox = fake.addSandbox({ state: "archived" });
      const provider = makeBoatSandboxProviderFromClient({
        ...fake.client,
        resume: async () => {
          sandbox.state = "provisioning";
          throw boatError(409, { code: "already_resuming" });
        },
      });

      const info = yield* provider.resume(refOf(sandbox));
      assert.equal(info.status, "creating");

      sandbox.state = "archived";
      const stuck = yield* makeBoatSandboxProviderFromClient({
        ...fake.client,
        resume: async () => {
          throw boatError(409);
        },
      })
        .resume(refOf(sandbox))
        .pipe(Effect.flip);
      assert.equal(stuck.failure, "provider-error");
    }),
  );

  it.effect("destroys a sandbox, treats one already gone as destroyed, maps other failures", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const sandbox = fake.addSandbox();
      const other = fake.addSandbox();
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      yield* provider.destroy(refOf(sandbox));
      yield* provider.destroy(refOf(sandbox));
      fake.failNext("deleteSandbox", boatError(403));
      const forbidden = yield* provider.destroy(refOf(other)).pipe(Effect.flip);

      assert.isFalse(fake.sandboxes.has(sandbox.id));
      assert.equal(fake.callsOf("deleteSandbox").length, 3);
      assert.equal(forbidden.operation, "destroy");
      assert.equal(forbidden.failure, "unauthorized");
    }),
  );
});

describe("fork", () => {
  it.effect("forks under a fresh key per call and names the fork after its label", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const source = fake.addSandbox({ name: `${BOAT_SANDBOX_NAME_PREFIX}source` });
      const provider = makeBoatSandboxProviderFromClient(fake.client);
      assert.isFunction(provider.fork);

      const first = yield* provider.fork!(refOf(source), "attempt 2");
      const second = yield* provider.fork!(refOf(source), "attempt 2");

      const requests = fake
        .callsOf("fork")
        .map((entry) => entry.request as { idempotencyKey: string; body: ForkRequest });
      assert.match(requests[0]!.idempotencyKey, /^t3code-fork-[0-9a-f-]{36}$/);
      assert.notEqual(requests[0]!.idempotencyKey, requests[1]!.idempotencyKey);
      assert.deepEqual(requests[0]!.body, {});
      assert.notEqual(first.ref.sandboxId, second.ref.sandboxId);
      assert.deepEqual(first, { ref: first.ref, status: "creating", label: "attempt 2" });
      assert.equal(
        fake.sandboxes.get(first.ref.sandboxId)!.name,
        `${BOAT_SANDBOX_NAME_PREFIX}attempt 2`,
      );
    }),
  );

  it.effect("resends a fork that got no answer under the same key, so it forks once", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const source = fake.addSandbox();
      fake.failNext("fork", networkError());
      const provider = makeBoatSandboxProviderFromClient(fake.client);

      const forked = yield* withClock(provider.fork!(refOf(source), "retry"));

      const keys = fake
        .callsOf("fork")
        .map((entry) => (entry.request as { idempotencyKey: string }).idempotencyKey);
      assert.equal(keys.length, 2);
      assert.equal(keys[0], keys[1]);
      assert.equal(forked.ref.sandboxId, "sb-2");
      assert.equal(fake.sandboxes.size, 2);
    }),
  );

  it.effect("reports a fork boat answered without its sandbox as provisioning", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const source = fake.addSandbox();
      const provider = makeBoatSandboxProviderFromClient({
        ...fake.client,
        fork: async (sandboxId) => {
          if (!fake.sandboxes.has(sandboxId)) {
            throw boatError(404, { code: "sandbox_not_found" });
          }
          fake.addSandbox({ id: "sb-forked", state: "provisioning" });
          return { id: "sb-forked", sandbox: null };
        },
      });

      const forked = yield* provider.fork!(refOf(source), "bare");
      const missing = yield* provider.fork!({ providerId: "boat", sandboxId: "gone" }, "x").pipe(
        Effect.flip,
      );

      assert.deepEqual(forked, {
        ref: { providerId: "boat", sandboxId: "sb-forked" },
        status: "creating",
        label: "bare",
      });
      assert.equal(missing.operation, "fork");
      assert.equal(missing.failure, "not-found");
    }),
  );
});

describe("secrets", () => {
  it.effect("never put env values or boat's error text into errors of any operation", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const sandbox = fake.addSandbox();
      const provider = makeBoatSandboxProviderFromClient(fake.client);
      const methods: ReadonlyArray<Method> = [
        "get",
        "command",
        "writeFile",
        "readFile",
        "hostPort",
        "deleteSandbox",
      ];
      for (const method of methods) {
        fake.failNext(method, boatError(500, { code: "internal", detail: ENV_SECRET }));
      }
      const ref = refOf(sandbox);

      const errors = [
        yield* provider.get(ref).pipe(Effect.flip),
        yield* provider.exec(ref, { script: "true", timeoutMs: 1_000 }).pipe(Effect.flip),
        yield* provider.writeFile(ref, "/tmp/x", new Uint8Array([1])).pipe(Effect.flip),
        yield* provider.readFile(ref, "/tmp/x").pipe(Effect.flip),
        yield* provider.exposePort(ref, 3773).pipe(Effect.flip),
        yield* provider.destroy(ref).pipe(Effect.flip),
      ];

      for (const error of errors) {
        assert.equal(error.failure, "provider-error");
        assertCarriesNoSecret(error, ENV_SECRET);
        // The cause names boat's status and code, never its message.
        assert.notInclude(String(error.cause), ENV_SECRET);
      }
    }),
  );
});

describe("extendAutoStop", () => {
  it.effect("moves the deadline and never turns auto-stop off", () =>
    Effect.gen(function* () {
      const fake = makeFakeBoat();
      const provider = makeBoatSandboxProviderFromClient(fake.client);
      const sandbox = fake.addSandbox();

      yield* provider.extendAutoStop!(refOf(sandbox), 30);
      const off = yield* Effect.flip(provider.extendAutoStop!(refOf(sandbox), 0));

      assert.equal(sandbox.ttlSeconds, 1800);
      assert.equal(off.failure, "unsupported");
      assert.equal(fake.callsOf("setTtl").length, 1);
    }),
  );
});
