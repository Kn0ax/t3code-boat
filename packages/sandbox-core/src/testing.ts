/**
 * Test doubles for code built on `@t3tools/sandbox-core`: an in-memory
 * `SandboxProviderShape` and an `HttpClient` that plays `t3 serve` behind a
 * provider's preview proxy.
 *
 * The fake provider behaves like a well-mannered real one: `create` honours
 * idempotency keys, `exec` only works on a running sandbox, a stopped sandbox
 * loses its server, and a destroyed one answers `not-found`. An `exec` of the
 * serve script never returns (the server it starts
 * keeps the exec waiting); only `startBackground` starts a server. It records
 * every call, answers the bootstrap scripts (recognised by their kind marker)
 * with plausible output, and lets a test script answers or queue failures.
 *
 * @module sandbox-core/testing
 */
import * as Effect from "effect/Effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { sandboxScriptKind, type SandboxScriptKind } from "./bootstrapScripts.ts";
import {
  SandboxProviderError,
  type SandboxBackgroundInput,
  type SandboxCreateInput,
  type SandboxExecInput,
  type SandboxExecResult,
  type SandboxExposedPort,
  type SandboxInfo,
  type SandboxProviderFailure,
  type SandboxProviderId,
  type SandboxProviderOperation,
  type SandboxProviderShape,
  type SandboxRef,
  type SandboxStatus,
} from "./SandboxProvider.ts";

/** Pairing credentials the fake mints are this prefix plus a counter, so each one differs. */
export const FAKE_PAIRING_CREDENTIAL_PREFIX = "fake-pairing-credential-";

/** The home directory the fake's launch step reports, so its log path is absolute. */
const FAKE_SANDBOX_HOME = "/home/sandbox";
export const FAKE_SANDBOX_SERVER_LOG_PATH = `${FAKE_SANDBOX_HOME}/.t3/ssh-launch/sandbox/server.log`;

export interface FakeSandbox {
  readonly ref: SandboxRef;
  readonly label: string;
  readonly env: Readonly<Record<string, string>>;
  readonly status: SandboxStatus;
  /** Whether a `t3 serve` started through `startBackground` (or found running) is up. */
  readonly serverRunning: boolean;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export interface FakeSandboxCall {
  readonly operation: SandboxProviderOperation;
  readonly sandboxId?: string;
  /** The input of a `create`. */
  readonly create?: SandboxCreateInput;
  /** The input of an `exec`, with the bootstrap script kind it carried. */
  readonly exec?: SandboxExecInput & { readonly kind: SandboxScriptKind | undefined };
  /** The input of a `startBackground`, with the bootstrap script kind it carried. */
  readonly background?: SandboxBackgroundInput & { readonly kind: SandboxScriptKind | undefined };
  readonly path?: string;
  readonly port?: number;
}

export interface FakeExecContext {
  readonly sandbox: FakeSandbox;
  readonly kind: SandboxScriptKind | undefined;
  readonly input: SandboxExecInput;
  /** Earlier execs of the same kind in this sandbox. */
  readonly attempt: number;
}

/**
 * Scripted exec results. Return `undefined` to fall through to the default
 * answer for the script's kind (which also updates the fake's server state).
 */
export type FakeExecHandler = (
  context: FakeExecContext,
) => SandboxExecResult | Effect.Effect<SandboxExecResult, SandboxProviderError> | undefined;

export interface FakeBackgroundContext {
  readonly sandbox: FakeSandbox;
  readonly kind: SandboxScriptKind | undefined;
  readonly input: SandboxBackgroundInput;
  /** Earlier background starts of the same kind in this sandbox. */
  readonly attempt: number;
}

/**
 * Scripted background starts. Return `undefined` for the default (a serve
 * script brings the server up), or an effect that replaces it: `Effect.void`
 * models a process that started and died at once, a failure a provider error.
 */
export type FakeBackgroundHandler = (
  context: FakeBackgroundContext,
) => Effect.Effect<void, SandboxProviderError> | undefined;

export interface FakeSandboxProviderOptions {
  readonly id?: SandboxProviderId;
  /** Status `create` reports for a new sandbox. Defaults to `running`. */
  readonly createStatus?: SandboxStatus;
  /**
   * Statuses successive `get` calls report for a new sandbox, each one stored
   * as it is reported; once used up, `get` reports the stored status.
   */
  readonly getStatuses?: ReadonlyArray<SandboxStatus>;
  readonly exec?: FakeExecHandler;
  readonly startBackground?: FakeBackgroundHandler;
  /** Defaults to `https://<port>-<sandboxId>.sandbox.test` with no headers. */
  readonly exposePort?: (sandbox: FakeSandbox, port: number) => SandboxExposedPort;
  /** Whether the fake implements `fork`. Defaults to true. */
  readonly fork?: boolean;
  readonly arch?: "x64" | "arm64";
}

export interface FakeSandboxProvider extends SandboxProviderShape {
  readonly calls: ReadonlyArray<FakeSandboxCall>;
  readonly callsOf: (operation: SandboxProviderOperation) => ReadonlyArray<FakeSandboxCall>;
  /** Kinds of the scripts exec'd so far, in order. */
  readonly execKinds: () => ReadonlyArray<SandboxScriptKind | undefined>;
  /** Kinds of the scripts started in the background so far, in order. */
  readonly backgroundKinds: () => ReadonlyArray<SandboxScriptKind | undefined>;
  readonly sandbox: (sandboxId: string) => FakeSandbox | undefined;
  readonly sandboxes: () => ReadonlyArray<FakeSandbox>;
  /** Puts a sandbox in place as if an earlier session had created it. */
  readonly seed: (input?: {
    readonly label?: string;
    readonly status?: SandboxStatus;
    readonly serverRunning?: boolean;
  }) => FakeSandbox;
  readonly setStatus: (sandboxId: string, status: SandboxStatus) => void;
  readonly queueStatuses: (sandboxId: string, statuses: ReadonlyArray<SandboxStatus>) => void;
  /** Makes the next `times` (default 1) calls of `operation` fail with `failure`. */
  readonly failNext: (
    operation: SandboxProviderOperation,
    failure: SandboxProviderFailure,
    options?: { readonly times?: number; readonly cause?: unknown },
  ) => void;
}

interface MutableFakeSandbox {
  ref: SandboxRef;
  label: string;
  env: Readonly<Record<string, string>>;
  status: SandboxStatus;
  serverRunning: boolean;
  files: Map<string, Uint8Array>;
  pendingStatuses: Array<SandboxStatus>;
  execAttempts: Map<string, number>;
  backgroundAttempts: Map<string, number>;
}

interface QueuedFailure {
  readonly failure: SandboxProviderFailure;
  readonly cause: unknown;
  remaining: number;
}

const ok = (stdout: string): SandboxExecResult => ({ exitCode: 0, stdout, stderr: "" });

export function makeFakeSandboxProvider(
  options: FakeSandboxProviderOptions = {},
): FakeSandboxProvider {
  const id = options.id ?? "boat";
  const calls: Array<FakeSandboxCall> = [];
  const sandboxes = new Map<string, MutableFakeSandbox>();
  const byIdempotencyKey = new Map<string, string>();
  const failures = new Map<SandboxProviderOperation, QueuedFailure>();
  let nextSandbox = 1;
  let nextCredential = 1;

  const snapshot = (sandbox: MutableFakeSandbox): FakeSandbox => ({
    ref: sandbox.ref,
    label: sandbox.label,
    env: sandbox.env,
    status: sandbox.status,
    serverRunning: sandbox.serverRunning,
    files: new Map(sandbox.files),
  });

  const info = (sandbox: MutableFakeSandbox): SandboxInfo => ({
    ref: sandbox.ref,
    status: sandbox.status,
    label: sandbox.label,
    ...(options.arch === undefined ? {} : { arch: options.arch }),
  });

  const providerError = (operation: SandboxProviderOperation, failure: SandboxProviderFailure) =>
    new SandboxProviderError({ providerId: id, operation, failure });

  const addSandbox = (input: {
    readonly label: string;
    readonly env: Readonly<Record<string, string>>;
    readonly status: SandboxStatus;
    readonly serverRunning: boolean;
    readonly pendingStatuses: ReadonlyArray<SandboxStatus>;
    readonly files?: ReadonlyMap<string, Uint8Array>;
  }): MutableFakeSandbox => {
    const sandbox: MutableFakeSandbox = {
      ref: { providerId: id, sandboxId: `fake-sandbox-${nextSandbox++}` },
      label: input.label,
      env: input.env,
      status: input.status,
      serverRunning: input.serverRunning,
      files: new Map(input.files),
      pendingStatuses: [...input.pendingStatuses],
      execAttempts: new Map(),
      backgroundAttempts: new Map(),
    };
    sandboxes.set(sandbox.ref.sandboxId, sandbox);
    return sandbox;
  };

  // Records the call, then applies a failure the test queued for it.
  const enter = (call: FakeSandboxCall): Effect.Effect<void, SandboxProviderError> =>
    Effect.suspend(() => {
      calls.push(call);
      const queued = failures.get(call.operation);
      if (queued === undefined) {
        return Effect.void;
      }
      queued.remaining -= 1;
      if (queued.remaining <= 0) {
        failures.delete(call.operation);
      }
      return Effect.fail(
        new SandboxProviderError({
          providerId: id,
          operation: call.operation,
          failure: queued.failure,
          cause: queued.cause,
        }),
      );
    });

  const enterSandbox = (
    call: FakeSandboxCall & { readonly sandboxId: string },
  ): Effect.Effect<MutableFakeSandbox, SandboxProviderError> =>
    enter(call).pipe(
      Effect.flatMap(() => {
        const sandbox = sandboxes.get(call.sandboxId);
        return sandbox === undefined || sandbox.status === "destroyed"
          ? Effect.fail(providerError(call.operation, "not-found"))
          : Effect.succeed(sandbox);
      }),
    );

  const requireRunning = (operation: SandboxProviderOperation, sandbox: MutableFakeSandbox) =>
    sandbox.status === "running"
      ? Effect.succeed(sandbox)
      : Effect.fail(providerError(operation, "provider-error"));

  const defaultExec = (
    sandbox: MutableFakeSandbox,
    kind: Exclude<SandboxScriptKind, "serve"> | undefined,
  ): SandboxExecResult => {
    switch (kind) {
      case "install":
        return ok('{"installed":true}\n');
      case "agent-clis":
        return ok('{"npm":true,"failed":""}\n');
      case "launch":
        return ok(
          sandbox.serverRunning
            ? '{"remotePort":3773,"serverKind":"managed","reused":true}\n'
            : `{"remotePort":3773,"serverKind":"managed","reused":false,"logPath":"${FAKE_SANDBOX_SERVER_LOG_PATH}"}\n`,
        );
      case "ready":
        return sandbox.serverRunning
          ? ok('{"remotePort":3773,"ready":true}\n')
          : {
              exitCode: 1,
              stdout: "",
              stderr: `T3 server exited before becoming ready; see ${FAKE_SANDBOX_SERVER_LOG_PATH}.\n`,
            };
      case "pair":
        return ok(`{\n  "credential": "${FAKE_PAIRING_CREDENTIAL_PREFIX}${nextCredential++}"\n}\n`);
      case "stop":
        sandbox.serverRunning = false;
        return ok('{"stopped":true}\n');
      case undefined:
        return ok("");
    }
  };

  const nextAttempt = (attempts: Map<string, number>, kind: SandboxScriptKind | undefined) => {
    const key = kind ?? "other";
    const attempt = attempts.get(key) ?? 0;
    attempts.set(key, attempt + 1);
    return attempt;
  };

  const provider: SandboxProviderShape = {
    id,
    create: (input) =>
      enter({ operation: "create", create: input }).pipe(
        Effect.map(() => {
          const existingId = byIdempotencyKey.get(input.idempotencyKey);
          const existing = existingId === undefined ? undefined : sandboxes.get(existingId);
          if (existing !== undefined && existing.status !== "destroyed") {
            return info(existing);
          }
          const sandbox = addSandbox({
            label: input.label,
            env: { ...input.env },
            status: options.createStatus ?? "running",
            serverRunning: false,
            pendingStatuses: options.getStatuses ?? [],
          });
          byIdempotencyKey.set(input.idempotencyKey, sandbox.ref.sandboxId);
          return info(sandbox);
        }),
      ),
    get: (ref) =>
      enterSandbox({ operation: "get", sandboxId: ref.sandboxId }).pipe(
        Effect.map((sandbox) => {
          const next = sandbox.pendingStatuses.shift();
          if (next !== undefined) {
            sandbox.status = next;
          }
          return info(sandbox);
        }),
      ),
    list: () =>
      enter({ operation: "list" }).pipe(
        Effect.map(() =>
          [...sandboxes.values()]
            .filter((sandbox) => sandbox.status !== "destroyed")
            .map((sandbox) => info(sandbox)),
        ),
      ),
    exec: (ref, input) => {
      const kind = sandboxScriptKind(input.script);
      return enterSandbox({
        operation: "exec",
        sandboxId: ref.sandboxId,
        exec: { ...input, kind },
      }).pipe(
        Effect.flatMap((sandbox) => requireRunning("exec", sandbox)),
        Effect.flatMap((sandbox): Effect.Effect<SandboxExecResult, SandboxProviderError> => {
          const attempt = nextAttempt(sandbox.execAttempts, kind);
          const scripted = options.exec?.({ sandbox: snapshot(sandbox), kind, input, attempt });
          if (scripted !== undefined) {
            return Effect.isEffect(scripted) ? scripted : Effect.succeed(scripted);
          }
          if (kind === "serve") {
            // The server starts, and the
            // exec waits on it for as long as it runs.
            sandbox.serverRunning = true;
            return Effect.never;
          }
          return Effect.sync(() => defaultExec(sandbox, kind));
        }),
      );
    },
    startBackground: (ref, input) => {
      const kind = sandboxScriptKind(input.script);
      return enterSandbox({
        operation: "startBackground",
        sandboxId: ref.sandboxId,
        background: { ...input, kind },
      }).pipe(
        Effect.flatMap((sandbox) => requireRunning("startBackground", sandbox)),
        Effect.flatMap((sandbox) => {
          const attempt = nextAttempt(sandbox.backgroundAttempts, kind);
          const scripted = options.startBackground?.({
            sandbox: snapshot(sandbox),
            kind,
            input,
            attempt,
          });
          if (scripted !== undefined) {
            return scripted;
          }
          return Effect.sync(() => {
            if (kind === "serve") {
              sandbox.serverRunning = true;
            }
          });
        }),
      );
    },
    writeFile: (ref, path, content) =>
      enterSandbox({ operation: "writeFile", sandboxId: ref.sandboxId, path }).pipe(
        Effect.flatMap((sandbox) => requireRunning("writeFile", sandbox)),
        Effect.map((sandbox) => {
          sandbox.files.set(path, new Uint8Array(content));
        }),
      ),
    readFile: (ref, path) =>
      enterSandbox({ operation: "readFile", sandboxId: ref.sandboxId, path }).pipe(
        Effect.flatMap((sandbox) => requireRunning("readFile", sandbox)),
        Effect.flatMap((sandbox) => {
          const content = sandbox.files.get(path);
          return content === undefined
            ? Effect.fail(providerError("readFile", "not-found"))
            : Effect.succeed(new Uint8Array(content));
        }),
      ),
    exposePort: (ref, port) =>
      enterSandbox({ operation: "exposePort", sandboxId: ref.sandboxId, port }).pipe(
        Effect.flatMap((sandbox) => requireRunning("exposePort", sandbox)),
        Effect.map(
          (sandbox) =>
            options.exposePort?.(snapshot(sandbox), port) ?? {
              httpBaseUrl: `https://${port}-${sandbox.ref.sandboxId}.sandbox.test`,
              headers: {},
            },
        ),
      ),
    stop: (ref) =>
      enterSandbox({ operation: "stop", sandboxId: ref.sandboxId }).pipe(
        Effect.map((sandbox) => {
          sandbox.status = "stopped";
          sandbox.serverRunning = false;
        }),
      ),
    resume: (ref) =>
      enterSandbox({ operation: "resume", sandboxId: ref.sandboxId }).pipe(
        Effect.map((sandbox) => {
          sandbox.status = "running";
          return info(sandbox);
        }),
      ),
    destroy: (ref) =>
      enterSandbox({ operation: "destroy", sandboxId: ref.sandboxId }).pipe(
        Effect.map((sandbox) => {
          sandbox.status = "destroyed";
          sandbox.serverRunning = false;
        }),
      ),
    ...(options.fork === false
      ? {}
      : {
          fork: (ref: SandboxRef, label: string) =>
            enterSandbox({ operation: "fork", sandboxId: ref.sandboxId }).pipe(
              Effect.map((source) =>
                info(
                  addSandbox({
                    label,
                    env: source.env,
                    status: "running",
                    serverRunning: false,
                    pendingStatuses: [],
                    files: source.files,
                  }),
                ),
              ),
            ),
        }),
  };

  return {
    ...provider,
    calls,
    callsOf: (operation) => calls.filter((call) => call.operation === operation),
    execKinds: () => calls.flatMap((call) => (call.exec === undefined ? [] : [call.exec.kind])),
    backgroundKinds: () =>
      calls.flatMap((call) => (call.background === undefined ? [] : [call.background.kind])),
    sandbox: (sandboxId) => {
      const sandbox = sandboxes.get(sandboxId);
      return sandbox === undefined ? undefined : snapshot(sandbox);
    },
    sandboxes: () => [...sandboxes.values()].map(snapshot),
    seed: (input = {}) =>
      snapshot(
        addSandbox({
          label: input.label ?? "Seeded sandbox",
          env: {},
          status: input.status ?? "running",
          serverRunning: input.serverRunning ?? false,
          pendingStatuses: [],
        }),
      ),
    setStatus: (sandboxId, status) => {
      const sandbox = sandboxes.get(sandboxId);
      if (sandbox !== undefined) {
        sandbox.status = status;
        if (status !== "running") {
          sandbox.serverRunning = false;
        }
      }
    },
    queueStatuses: (sandboxId, statuses) => {
      sandboxes.get(sandboxId)?.pendingStatuses.push(...statuses);
    },
    failNext: (operation, failure, failOptions) => {
      failures.set(operation, {
        failure,
        cause: failOptions?.cause,
        remaining: failOptions?.times ?? 1,
      });
    },
  };
}

/** A minimal `/.well-known/t3/environment` body, as `t3 serve` answers it. */
export function fakeEnvironmentDescriptorBody(serverVersion = "0.0.0-test"): string {
  return `{"environmentId":"fake-environment","label":"Fake sandbox","platform":{"os":"linux","arch":"x64"},"serverVersion":"${serverVersion}","capabilities":{}}`;
}

/**
 * One scripted answer: a status and body, a request that never answers, or a
 * transport failure (connection refused, DNS, ...).
 */
export type FakeHttpAnswer =
  | { readonly status: number; readonly body?: string }
  | "hang"
  | "transport-error";

export interface FakeHttpRequestRecord {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface FakeEnvironmentHttpClient {
  readonly client: HttpClient.HttpClient;
  readonly requests: ReadonlyArray<FakeHttpRequestRecord>;
}

/**
 * An `HttpClient` that answers in order from `answers`, repeating the last one;
 * by default every request gets a 200 environment descriptor.
 */
export function makeFakeEnvironmentHttpClient(
  answers: ReadonlyArray<FakeHttpAnswer> = [{ status: 200, body: fakeEnvironmentDescriptorBody() }],
): FakeEnvironmentHttpClient {
  const requests: Array<FakeHttpRequestRecord> = [];
  const respond = (request: HttpClientRequest.HttpClientRequest) => {
    const answer = answers[Math.min(requests.length, answers.length - 1)] ?? "transport-error";
    requests.push({
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(Object.entries(request.headers)),
    });
    if (answer === "hang") {
      return Effect.never;
    }
    if (answer === "transport-error") {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: "connection refused",
          }),
        }),
      );
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(answer.body ?? "", {
          status: answer.status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  };
  return { client: HttpClient.make(respond), requests };
}
