/**
 * boat (https://boat.dev) as a `SandboxProviderShape`.
 *
 * boat sandboxes are persistent Ubuntu VMs with Docker inside, billed per
 * second, snapshotted on stop and resumable or forkable at the disk level.
 * The API maps closely onto the contract, with these differences:
 *
 * - `create` takes no name, so the adapter renames the new sandbox to
 *   `BOAT_SANDBOX_NAME_PREFIX` + label, or to a label that is already a T3
 *   name (`t3:…`, as boat VMs' are); `list` returns only sandboxes named
 *   either way that the caller owns, so the account's other sandboxes (and, in
 *   an organization's scope, teammates' ones) stay out of T3. Idempotency is
 *   boat's own `Idempotency-Key`, so a retried create (lost response, 5xx,
 *   or a click while the first is still minting) answers with the same
 *   sandbox; forks get a fresh key per call for the same protection.
 * - boat places every sandbox in the EU (Germany, Finland or France) and has
 *   no region choice: the only region the adapter accepts is `BOAT_REGION`,
 *   and it reports no architecture.
 * - Auto-stop is a deadline (`ttlSeconds` from the last start), not idle
 *   time: a sandbox stops `idleTimeoutMinutes` after it started, busy or not,
 *   unless `extendAutoStop` moves the deadline. A fork gets boat's own
 *   default of 1 hour rather than the source's.
 * - `snapshot` is boat's named snapshot (`from`). A missing name answers
 *   `not-found` before anything is created or billed.
 * - Secrets: boat holds env in plaintext and, by default, would also attach
 *   the account's environment (GitHub token, agent logins, secret files and
 *   its own CLI token) to every sandbox. New sandboxes are therefore created
 *   `noEnv` unless the caller names an `environment` or opts in, so only the
 *   contract's `env` reaches them. That env is boat's per-sandbox env: kept
 *   across stop and resume, and inherited by forks.
 * - A synchronous command may run at most 600 s, so a longer exec runs
 *   detached and is polled; the adapter stops it when its budget runs out.
 *   `startBackground` uses the same detached commands, boat's own primitive
 *   for a process that outlives the call.
 * - The file API stops at 5 MiB, so a larger file moves in parts the
 *   sandbox splits or joins (see `transfer.ts`).
 * - Ports stay private. Boat's access token is carried as a proxy cookie header
 *   for HTTP and WebSocket forwarding, separately from the bare base URL.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto is a service; a provider shape has no requirements to carry it.
import * as NodeCrypto from "node:crypto";

import type { CreateSandboxRequest } from "@boatdev/sdk";
import type {
  SandboxBackgroundInput,
  SandboxCreateInput,
  SandboxExecInput,
  SandboxExecResult,
  SandboxInfo,
  SandboxProviderError,
  SandboxProviderOperation,
  SandboxProviderShape,
  SandboxRef,
} from "@t3tools/sandbox-core";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Exit from "effect/Exit";
import type * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

import {
  makeBoatSdkClient,
  type BoatCallOptions,
  type BoatClient,
  type BoatCommandStatus,
  type BoatSandbox,
} from "./client.ts";
import {
  boatErrorCode,
  boatProviderError,
  boatResponseStatus,
  fromBoatCallFailure,
  isBoatRetryableRefusal,
  isBoatTransientFailure,
  toBoatCallFailure,
} from "./errors.ts";
import {
  boatExecPlan,
  boatExitCode,
  buildBoatBackgroundCommand,
  buildBoatExecCommand,
  MAX_BOAT_EXEC_COMMAND_LENGTH,
} from "./exec.ts";
import {
  BOAT_SIZE_TYPES,
  boatEnvProblem,
  boatFilePath,
  boatHostedPort,
  boatIdempotencyKey,
  boatSandboxLabel,
  boatSandboxName,
  boatSandboxStatus,
  boatTtlSeconds,
  isBoatRegion,
  isT3Sandbox,
} from "./mapping.ts";
import {
  BOAT_TRANSFER_CLEANUP_SCRIPT,
  BOAT_TRANSFER_JOIN_SCRIPT,
  BOAT_TRANSFER_MKDIR_SCRIPT,
  BOAT_TRANSFER_NOT_FOUND_EXIT_CODE,
  BOAT_TRANSFER_PART_BYTES,
  BOAT_TRANSFER_SPLIT_SCRIPT,
  boatTransferPartNames,
  MAX_BOAT_FILE_BYTES,
  parseBoatSplitAnswer,
  parseBoatTransferDir,
} from "./transfer.ts";

/** Title boat shows for the exposed T3 port. */
export const BOAT_HOSTED_PORT_TITLE = "T3 Code";

// A synchronous command answers when it ends or boat's own timeout kills it.
// Sent to a sandbox that is still starting, boat first holds it up to 60 s,
// so the client-side deadline allows for that wait plus transit.
const EXEC_RESPONSE_GRACE_MS = 90_000;
const DEFAULT_EXEC_POLL_INTERVAL_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const STOP_COMMAND_TIMEOUT_MS = 10_000;
// Splitting or joining a large file in the sandbox is local disk work.
const TRANSFER_EXEC_TIMEOUT_MS = 300_000;
// A bound on `list` pagination, so a misbehaving cursor cannot loop forever.
const MAX_LIST_PAGES = 50;

// `idempotency_in_progress`: a retry arrived while the first request was still
// minting its sandbox. boat asks to retry shortly with the same key.
const IN_PROGRESS_RETRY = Schedule.spaced(Duration.seconds(1)).pipe(
  Schedule.upTo({ duration: Duration.seconds(60) }),
);
// A lost answer or a 500/502/504 on a keyed create or fork: boat documents
// these as safe to resend with the same key.
const TRANSIENT_RETRY = Schedule.spaced(Duration.seconds(1)).pipe(Schedule.upTo({ times: 2 }));
// A command boat refused with `retryable: true` (the sandbox was still
// restoring its disk) provably never ran; the SDK's own helper resends it
// for 60 s.
const REFUSAL_RETRY = Schedule.spaced(Duration.seconds(2)).pipe(
  Schedule.upTo({ duration: Duration.seconds(60) }),
);
// A status read of a detached command is safe to repeat, so a blip during a
// long poll does not abandon (and stop) the command.
const POLL_RETRY = Schedule.spaced(Duration.seconds(2)).pipe(Schedule.upTo({ times: 5 }));

const IDEMPOTENCY_IN_PROGRESS = "idempotency_in_progress";

/** Everything about the adapter that is not a credential. */
export interface BoatSandboxProviderOptions {
  /**
   * boat sandbox environment (dashboard-managed repositories, secrets and
   * credential toggles) new sandboxes attach. Omitted: none, see `noEnv`.
   */
  readonly environment?: string;
  /**
   * Create sandboxes with none of the account's secrets attached (boat's
   * `noEnv`): no account env or secret files, no GitHub or agent logins, no
   * boat CLI token, and no way to act on the account or its other
   * sandboxes. Defaults to true unless `environment` is set; the contract's
   * `env` reaches the sandbox either way.
   */
  readonly noEnv?: boolean;
  /**
   * Whether boat keeps command output, process lists and metrics. With it on
   * (the usual account default), boat keeps every command string and its
   * output for 90 days, which includes the one-time pairing credential the
   * bootstrap prints. Omitted: the account's default.
   */
  readonly monitoring?: boolean;
  /** How often a detached (longer than 600 s) exec is polled. Defaults to 1000. */
  readonly execPollIntervalMs?: number;
  /** Bound on every API call except a synchronous command's. Defaults to 120000. */
  readonly requestTimeoutMs?: number;
}

export interface BoatSandboxProviderConfig extends BoatSandboxProviderOptions {
  /** boat API key. Secret. */
  readonly apiKey: Redacted.Redacted<string>;
  /** Defaults to boat's hosted API (`https://boat.dev/api/v1`). */
  readonly baseUrl?: string;
  /** Organization wallet sandboxes bill to and are listed from (id or name). */
  readonly org?: string;
}

function toSandboxInfo(sandbox: BoatSandbox): SandboxInfo {
  return {
    ref: { providerId: "boat", sandboxId: sandbox.id },
    status: boatSandboxStatus(sandbox),
    label: boatSandboxLabel(sandbox),
    // boat reports no architecture for a sandbox.
  };
}

/** Sorted by name, so a retried create sends the byte-identical body boat's idempotency compares. */
function sortedEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

const utf8 = new TextEncoder();

/** What an SDK call rejected with, before its classification. */
class BoatRejection {
  readonly _tag = "BoatRejection";
  readonly cause: unknown;
  constructor(cause: unknown) {
    this.cause = cause;
  }
}

/**
 * The adapter over any `BoatClient`. Tests pass a fake; production code goes
 * through `makeBoatSandboxProvider`, which binds the real SDK.
 */
export function makeBoatSandboxProviderFromClient(
  client: BoatClient,
  options: BoatSandboxProviderOptions = {},
): SandboxProviderShape {
  const execPollIntervalMs = options.execPollIntervalMs ?? DEFAULT_EXEC_POLL_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const noEnv = options.noEnv ?? options.environment === undefined;

  /**
   * One SDK call, bounded by `timeoutMs`. Interrupting the Effect (or the
   * deadline) aborts its HTTP request. A rejection is classified with boat's
   * error envelope; the raw error survives only as the cause's cause.
   */
  const call = <A>(
    operation: SandboxProviderOperation,
    run: (options: BoatCallOptions) => Promise<A>,
    timeoutMs: number = requestTimeoutMs,
  ): Effect.Effect<A, SandboxProviderError> =>
    Effect.tryPromise({
      try: (signal) => run({ signal }),
      catch: (cause) => new BoatRejection(cause),
    }).pipe(
      Effect.catch((rejection) =>
        toBoatCallFailure(rejection.cause).pipe(
          Effect.flatMap((failure) => Effect.fail(fromBoatCallFailure(operation, failure))),
        ),
      ),
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () => Effect.fail(boatProviderError(operation, "timeout")),
      }),
    );

  /** A create or fork carrying an `Idempotency-Key`: the retries boat documents as safe. */
  const keyed = <A>(
    effect: Effect.Effect<A, SandboxProviderError>,
  ): Effect.Effect<A, SandboxProviderError> =>
    effect.pipe(
      Effect.retry({
        while: (error: SandboxProviderError) => boatErrorCode(error) === IDEMPOTENCY_IN_PROGRESS,
        schedule: IN_PROGRESS_RETRY,
      }),
      Effect.retry({ while: isBoatTransientFailure, schedule: TRANSIENT_RETRY }),
    );

  /** Starting a command: resent while boat says the refusal ran nothing. */
  const startCommand = <A>(
    effect: Effect.Effect<A, SandboxProviderError>,
  ): Effect.Effect<A, SandboxProviderError> =>
    effect.pipe(Effect.retry({ while: isBoatRetryableRefusal, schedule: REFUSAL_RETRY }));

  const sandboxIdOf = (
    operation: SandboxProviderOperation,
    ref: SandboxRef,
  ): Effect.Effect<string, SandboxProviderError> =>
    ref.providerId === "boat"
      ? Effect.succeed(ref.sandboxId)
      : Effect.fail(boatProviderError(operation, "unsupported"));

  const getSandbox = (operation: SandboxProviderOperation, sandboxId: string) =>
    call(operation, (options) => client.get(sandboxId, options)).pipe(
      Effect.map((response) => response.sandbox),
    );

  /**
   * Names a new sandbox or fork. It exists and is billed either way, so a
   * failed rename keeps the sandbox as boat reported it; a retried create
   * renames it again.
   */
  const nameSandbox = (
    operation: SandboxProviderOperation,
    sandbox: BoatSandbox,
    label: string,
  ): Effect.Effect<BoatSandbox> => {
    const name = boatSandboxName(label);
    if (sandbox.name === name) {
      return Effect.succeed(sandbox);
    }
    return call(operation, (options) => client.rename(sandbox.id, name, options)).pipe(
      Effect.map((response) => (response.sandbox.id === sandbox.id ? response.sandbox : sandbox)),
      Effect.orElseSucceed(() => sandbox),
    );
  };

  const create = Effect.fn("sandbox-boat/provider.create")(function* (input: SandboxCreateInput) {
    // Both refusals happen before anything billable, and name nothing: the
    // env holds the user's tokens.
    if (!isBoatRegion(input.region) || boatEnvProblem(input.env) !== undefined) {
      return yield* boatProviderError("create", "unsupported");
    }
    const ttlSeconds = boatTtlSeconds(input.idleTimeoutMinutes);
    const body: CreateSandboxRequest = {
      ...(input.snapshot === undefined ? {} : { from: input.snapshot }),
      type: BOAT_SIZE_TYPES[input.size],
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      env: sortedEnv(input.env),
      noEnv,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.monitoring === undefined ? {} : { monitoring: options.monitoring }),
    };
    const idempotencyKey = boatIdempotencyKey(input.idempotencyKey);
    const created = yield* keyed(
      call("create", (callOptions) => client.create({ idempotencyKey, body }, callOptions)),
    );
    const sandbox = yield* nameSandbox("create", created.sandbox, input.label);
    return { ...toSandboxInfo(sandbox), label: input.label };
  });

  const get = Effect.fn("sandbox-boat/provider.get")(function* (ref: SandboxRef) {
    const sandboxId = yield* sandboxIdOf("get", ref);
    return toSandboxInfo(yield* getSandbox("get", sandboxId));
  });

  const list = Effect.fn("sandbox-boat/provider.list")(function* () {
    const sandboxes: Array<SandboxInfo> = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const request = cursor === undefined ? {} : { cursor };
      const response = yield* call("list", (options) => client.list(request, options));
      for (const sandbox of response.sandboxes) {
        const info = toSandboxInfo(sandbox);
        const owned = sandbox.access === undefined || sandbox.access === "owner";
        if (isT3Sandbox(sandbox) && owned && info.status !== "destroyed") {
          sandboxes.push(info);
        }
      }
      const next = response.pageInfo?.nextCursor ?? null;
      if (response.pageInfo?.hasMore !== true || next === null || next === cursor) {
        break;
      }
      cursor = next;
    }
    return sandboxes;
  });

  const execSync = Effect.fn("sandbox-boat/provider.execSync")(function* (
    sandboxId: string,
    command: string,
    timeoutSeconds: number,
  ) {
    const response = yield* startCommand(
      call(
        "exec",
        (options) => client.command(sandboxId, { command, timeoutSeconds }, options),
        timeoutSeconds * 1000 + EXEC_RESPONSE_GRACE_MS,
      ),
    );
    if (response.type !== "command.finished") {
      return yield* boatProviderError("exec", "provider-error");
    }
    if (response.timedOut) {
      return yield* boatProviderError("exec", "timeout");
    }
    // Partial output is never passed off as the command's: stdout can carry
    // a result the caller parses.
    if (response.stdoutTruncated === true || response.stderrTruncated === true) {
      return yield* boatProviderError("exec", "provider-error");
    }
    const exitCode = boatExitCode(response);
    if (exitCode === undefined) {
      return yield* boatProviderError("exec", "provider-error");
    }
    const result: SandboxExecResult = {
      exitCode,
      stdout: response.stdout,
      stderr: response.stderr,
    };
    return result;
  });

  /** Reads a detached command's output from where the last poll stopped until it exits. */
  const pollDetached = Effect.fn("sandbox-boat/provider.pollDetached")(function* (
    sandboxId: string,
    processId: number,
  ) {
    let stdout = "";
    let stderr = "";
    let stdoutOffset = 0;
    let stderrOffset = 0;
    while (true) {
      const request = { processId, stdoutOffset, stderrOffset };
      const status: BoatCommandStatus = yield* call("exec", (options) =>
        client.commandStatus(sandboxId, request, options),
      ).pipe(Effect.retry({ while: isBoatTransientFailure, schedule: POLL_RETRY }));
      // An offset other than the one asked for means the log was replaced:
      // what was written in between is gone.
      if (
        (status.stdoutOffset !== undefined && status.stdoutOffset !== stdoutOffset) ||
        (status.stderrOffset !== undefined && status.stderrOffset !== stderrOffset)
      ) {
        return yield* boatProviderError("exec", "provider-error");
      }
      stdout += status.stdout;
      stderr += status.stderr;
      stdoutOffset = status.stdoutNextOffset ?? stdoutOffset + utf8.encode(status.stdout).length;
      stderrOffset = status.stderrNextOffset ?? stderrOffset + utf8.encode(status.stderr).length;
      // More output is already waiting: read on at once, as long as reads make progress.
      if (status.more === true && status.stdout.length + status.stderr.length > 0) {
        continue;
      }
      if (!status.running && status.status !== "running") {
        const exitCode = boatExitCode(status);
        if (exitCode === undefined) {
          // `lost` with no exit status: the sandbox forgot the process.
          return yield* boatProviderError("exec", "provider-error");
        }
        const result: SandboxExecResult = { exitCode, stdout, stderr };
        return result;
      }
      yield* Effect.sleep(Duration.millis(execPollIntervalMs));
    }
  });

  const execDetached = Effect.fn("sandbox-boat/provider.execDetached")(function* (
    sandboxId: string,
    command: string,
    timeoutMs: number | undefined,
  ) {
    const started = yield* startCommand(
      call("exec", (options) => client.command(sandboxId, { command, detached: true }, options)),
    );
    if (started.type !== "command.started") {
      return yield* boatProviderError("exec", "provider-error");
    }
    const { processId } = started;
    const poll = pollDetached(sandboxId, processId);
    const bounded =
      timeoutMs === undefined
        ? poll
        : poll.pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(timeoutMs),
              orElse: () => Effect.fail(boatProviderError("exec", "timeout")),
            }),
          );
    // Out of budget, interrupted or failed: the command must not keep running unobserved.
    return yield* bounded.pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : call(
              "exec",
              (options) => client.stopCommand(sandboxId, processId, options),
              STOP_COMMAND_TIMEOUT_MS,
            ).pipe(Effect.ignore),
      ),
    );
  });

  const exec = Effect.fn("sandbox-boat/provider.exec")(function* (
    ref: SandboxRef,
    input: SandboxExecInput,
  ) {
    const sandboxId = yield* sandboxIdOf("exec", ref);
    const command = buildBoatExecCommand({ script: input.script, args: input.args });
    const plan = boatExecPlan(input.timeoutMs);
    if (command.length > MAX_BOAT_EXEC_COMMAND_LENGTH || plan._tag === "Invalid") {
      return yield* boatProviderError("exec", "unsupported");
    }
    return plan._tag === "Sync"
      ? yield* execSync(sandboxId, command, plan.timeoutSeconds)
      : yield* execDetached(sandboxId, command, plan.timeoutMs);
  });

  /**
   * A detached command, boat's own primitive for a process that outlives the
   * request: boat answers with its process id as soon as it has spawned it.
   * The wrapper sends all output to `logPath`, so nothing of it reaches
   * boat's per-process log or command history, and the process is not
   * stopped or tracked further here.
   */
  const startBackground = Effect.fn("sandbox-boat/provider.startBackground")(function* (
    ref: SandboxRef,
    input: SandboxBackgroundInput,
  ) {
    const sandboxId = yield* sandboxIdOf("startBackground", ref);
    const command = buildBoatBackgroundCommand(input);
    if (input.logPath.trim().length === 0 || command.length > MAX_BOAT_EXEC_COMMAND_LENGTH) {
      return yield* boatProviderError("startBackground", "unsupported");
    }
    const started = yield* startCommand(
      call("startBackground", (options) =>
        client.command(sandboxId, { command, detached: true }, options),
      ),
    );
    if (started.type !== "command.started") {
      return yield* boatProviderError("startBackground", "provider-error");
    }
  });

  const writeWhole = (sandboxId: string, path: string, content: Uint8Array) =>
    call("writeFile", (options) =>
      client.writeFile(sandboxId, { path, contentBase64: Base64.encode(content) }, options),
    );

  const readWhole = Effect.fn("sandbox-boat/provider.readWhole")(function* (
    sandboxId: string,
    path: string,
  ) {
    const response = yield* call("readFile", (options) =>
      client.readFile(sandboxId, path, options),
    );
    if (response.encoding === "utf8") {
      return utf8.encode(response.content);
    }
    const bytes = Base64.decode(response.content);
    if (Result.isFailure(bytes)) {
      return yield* boatProviderError("readFile", "provider-error");
    }
    return bytes.success;
  });

  /** A transfer script, its failure reported as `operation`'s. */
  const transferExec = (
    operation: "writeFile" | "readFile",
    ref: SandboxRef,
    script: string,
    args: ReadonlyArray<string>,
  ) =>
    exec(ref, { script, args, timeoutMs: TRANSFER_EXEC_TIMEOUT_MS }).pipe(
      Effect.mapError((error) => boatProviderError(operation, error.failure, error)),
    );

  const cleanupTransfer = (operation: "writeFile" | "readFile", ref: SandboxRef, dir: string) =>
    transferExec(operation, ref, BOAT_TRANSFER_CLEANUP_SCRIPT, ["", dir]).pipe(Effect.ignore);

  const writeInParts = Effect.fn("sandbox-boat/provider.writeInParts")(function* (
    ref: SandboxRef,
    sandboxId: string,
    path: string,
    content: Uint8Array,
  ) {
    const made = yield* transferExec("writeFile", ref, BOAT_TRANSFER_MKDIR_SCRIPT, []);
    const dir = made.exitCode === 0 ? parseBoatTransferDir(made.stdout) : undefined;
    if (dir === undefined) {
      return yield* boatProviderError("writeFile", "provider-error");
    }
    yield* Effect.gen(function* () {
      for (const [index, name] of boatTransferPartNames(content.byteLength).entries()) {
        const start = index * BOAT_TRANSFER_PART_BYTES;
        yield* writeWhole(
          sandboxId,
          `${dir}/${name}`,
          content.subarray(start, start + BOAT_TRANSFER_PART_BYTES),
        );
      }
      const joined = yield* transferExec("writeFile", ref, BOAT_TRANSFER_JOIN_SCRIPT, [
        path,
        dir,
        String(content.byteLength),
      ]);
      if (joined.exitCode !== 0) {
        return yield* boatProviderError("writeFile", "provider-error");
      }
    }).pipe(
      // The join removes the parts itself; anything short of it leaves them behind.
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : cleanupTransfer("writeFile", ref, dir),
      ),
    );
  });

  /**
   * Reads a file the file API refused whole. `refusal` stands when the file
   * turns out small enough after all: its size was then not the reason.
   */
  const readInParts = Effect.fn("sandbox-boat/provider.readInParts")(function* (
    ref: SandboxRef,
    sandboxId: string,
    path: string,
    refusal: SandboxProviderError,
  ) {
    const probe = yield* transferExec("readFile", ref, BOAT_TRANSFER_SPLIT_SCRIPT, [
      path,
      String(MAX_BOAT_FILE_BYTES),
      String(BOAT_TRANSFER_PART_BYTES),
    ]);
    if (probe.exitCode === BOAT_TRANSFER_NOT_FOUND_EXIT_CODE) {
      return yield* boatProviderError("readFile", "not-found");
    }
    const answer = probe.exitCode === 0 ? parseBoatSplitAnswer(probe.stdout) : undefined;
    if (answer?._tag === "Small") {
      return yield* refusal;
    }
    if (answer?._tag !== "Split") {
      return yield* boatProviderError("readFile", "provider-error");
    }
    const { byteCount, dir } = answer;
    return yield* Effect.gen(function* () {
      const content = new Uint8Array(byteCount);
      let offset = 0;
      for (const name of boatTransferPartNames(byteCount)) {
        const part = yield* readWhole(sandboxId, `${dir}/${name}`);
        // A file that changed while it was split no longer adds up.
        if (offset + part.byteLength > byteCount) {
          return yield* boatProviderError("readFile", "provider-error");
        }
        content.set(part, offset);
        offset += part.byteLength;
      }
      if (offset !== byteCount) {
        return yield* boatProviderError("readFile", "provider-error");
      }
      return content;
    }).pipe(Effect.ensuring(cleanupTransfer("readFile", ref, dir)));
  });

  // boat's answer for an oversized read is not documented; a client error
  // could be it, a missing file, a refused path or a server fault cannot.
  const mayBeOversize = (error: SandboxProviderError) => {
    const code = boatErrorCode(error);
    if (code === "invalid_path" || code === "is_symlink") {
      return false;
    }
    const status = boatResponseStatus(error);
    return error.failure === "unsupported" || status === 400 || status === 422;
  };

  const writeFile = Effect.fn("sandbox-boat/provider.writeFile")(function* (
    ref: SandboxRef,
    path: string,
    content: Uint8Array,
  ) {
    const sandboxId = yield* sandboxIdOf("writeFile", ref);
    if (content.byteLength > MAX_BOAT_FILE_BYTES) {
      return yield* writeInParts(ref, sandboxId, path, content);
    }
    yield* writeWhole(sandboxId, boatFilePath(path), content);
  });

  /** One direct call for a small file; the sandbox splits only a file boat refused whole. */
  const readFile = Effect.fn("sandbox-boat/provider.readFile")(function* (
    ref: SandboxRef,
    path: string,
  ) {
    const sandboxId = yield* sandboxIdOf("readFile", ref);
    return yield* readWhole(sandboxId, boatFilePath(path)).pipe(
      Effect.catchIf(mayBeOversize, (refusal) => readInParts(ref, sandboxId, path, refusal)),
    );
  });

  const exposePort = Effect.fn("sandbox-boat/provider.exposePort")(function* (
    ref: SandboxRef,
    port: number,
  ) {
    const sandboxId = yield* sandboxIdOf("exposePort", ref);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return yield* boatProviderError("exposePort", "unsupported");
    }
    // Idempotent on boat's side: the same sandbox and port get the same URL.
    // `localhost` stays unset: `t3 serve` binds 0.0.0.0 in a sandbox.
    const hosted = yield* call("exposePort", (options) =>
      client.hostPort(sandboxId, { port, _public: false, title: BOAT_HOSTED_PORT_TITLE }, options),
    );
    if (hosted.isProtected === false || hosted.access === "public") {
      return yield* boatProviderError("exposePort", "unsupported");
    }
    const exposed = boatHostedPort(hosted.url);
    if (Result.isFailure(exposed)) {
      // Never with the URL as cause: a protected port's URL embeds its access token.
      return yield* boatProviderError("exposePort", exposed.failure);
    }
    if (exposed.success.headers.Cookie === undefined) {
      return yield* boatProviderError("exposePort", "unsupported");
    }
    return exposed.success;
  });

  const extendAutoStop = Effect.fn("sandbox-boat/provider.extendAutoStop")(function* (
    ref: SandboxRef,
    minutes: number,
  ) {
    const sandboxId = yield* sandboxIdOf("extendAutoStop", ref);
    const ttlSeconds = boatTtlSeconds(minutes);
    // Never turns auto-stop off: that would bill a forgotten machine forever.
    if (ttlSeconds === undefined || ttlSeconds === null) {
      return yield* boatProviderError("extendAutoStop", "unsupported");
    }
    yield* call("extendAutoStop", (options) => client.setTtl(sandboxId, ttlSeconds, options));
  });

  const stop = Effect.fn("sandbox-boat/provider.stop")(function* (ref: SandboxRef) {
    const sandboxId = yield* sandboxIdOf("stop", ref);
    const status = boatSandboxStatus(yield* getSandbox("stop", sandboxId));
    if (status === "stopped" || status === "stopping" || status === "destroyed") {
      return;
    }
    // boat saves the disk before archiving; the stop is accepted, not awaited.
    yield* call("stop", (options) => client.stop(sandboxId, options));
  });

  const resume = Effect.fn("sandbox-boat/provider.resume")(function* (ref: SandboxRef) {
    const sandboxId = yield* sandboxIdOf("resume", ref);
    const current = yield* getSandbox("resume", sandboxId);
    const status = boatSandboxStatus(current);
    if (status === "destroyed") {
      return yield* boatProviderError("resume", "not-found");
    }
    // Already up or on its way up; one in `error` is reported as is.
    if (status === "running" || status === "creating" || status === "error") {
      return toSandboxInfo(current);
    }
    // Stopped, or still archiving: a resume supersedes a pending stop.
    const resumed = yield* call("resume", (options) => client.resume(sandboxId, options)).pipe(
      Effect.map((response) => response.sandbox ?? undefined),
      // A conflict usually means another resume got there first.
      Effect.catchIf(
        (error: SandboxProviderError) => boatResponseStatus(error) === 409,
        (error) =>
          getSandbox("resume", sandboxId).pipe(
            Effect.flatMap((sandbox) => {
              const after = boatSandboxStatus(sandbox);
              return after === "running" || after === "creating"
                ? Effect.succeed(sandbox)
                : Effect.fail(error);
            }),
          ),
      ),
    );
    if (resumed !== undefined && resumed.id === sandboxId) {
      return toSandboxInfo(resumed);
    }
    return toSandboxInfo(yield* getSandbox("resume", sandboxId));
  });

  const isNotFound = (error: SandboxProviderError) => error.failure === "not-found";

  // Destroying a sandbox that is already gone succeeds: the caller's goal holds.
  // boat accepts the deletion and finishes it in the background; the sandbox
  // cannot be resumed from then on.
  const destroy = Effect.fn("sandbox-boat/provider.destroy")(
    function* (ref: SandboxRef) {
      const sandboxId = yield* sandboxIdOf("destroy", ref);
      yield* call("destroy", (options) => client.deleteSandbox(sandboxId, options));
    },
    Effect.catchIf(isNotFound, () => Effect.void),
  );

  /**
   * A disk-level fork. It inherits the source's machine type, per-sandbox
   * env, environment (or `noEnv`) and its disk, credential files included:
   * callers that must not share a refresh token between machines scrub them
   * in the fork. boat gives it its own default auto-stop (1 hour).
   */
  const fork = Effect.fn("sandbox-boat/provider.fork")(function* (ref: SandboxRef, label: string) {
    const sandboxId = yield* sandboxIdOf("fork", ref);
    // One key per fork call: the retries in `keyed` then cannot fork twice.
    const idempotencyKey = yield* Effect.sync(() => `t3code-fork-${NodeCrypto.randomUUID()}`);
    const forked = yield* keyed(
      call("fork", (options) => client.fork(sandboxId, { idempotencyKey, body: {} }, options)),
    );
    const reported: BoatSandbox =
      forked.sandbox !== undefined && forked.sandbox !== null && forked.sandbox.id === forked.id
        ? forked.sandbox
        : { id: forked.id, state: "provisioning" };
    const sandbox = yield* nameSandbox("fork", reported, label);
    return { ...toSandboxInfo(sandbox), label };
  });

  return {
    id: "boat",
    create,
    get,
    list,
    exec,
    startBackground,
    writeFile,
    readFile,
    exposePort,
    stop,
    resume,
    destroy,
    fork,
    extendAutoStop,
  };
}

/** The boat provider over the real SDK. `config.apiKey` only ever reaches the SDK client. */
export function makeBoatSandboxProvider(config: BoatSandboxProviderConfig): SandboxProviderShape {
  const { apiKey, baseUrl, org, ...options } = config;
  return makeBoatSandboxProviderFromClient(
    makeBoatSdkClient({
      apiKey,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(org === undefined ? {} : { org }),
    }),
    options,
  );
}
