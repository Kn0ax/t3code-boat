/**
 * Maps whatever a boat SDK call rejects with onto the provider contract's
 * failure labels.
 *
 * The SDK rejects with a `ResponseError` carrying the HTTP response for any
 * non-2xx answer, and a `FetchError` wrapping the transport error when no
 * answer arrived. boat's error body is an envelope with a stable `code`
 * (`idempotency_in_progress`, `no_ready_machine`, ...) and, on refusals that
 * provably did nothing, `retryable: true`. Classification reads status codes,
 * those two envelope fields, error classes and socket error codes only: boat's
 * messages can quote request details, so nothing else from the raw error is
 * copied anywhere; the raw error is kept whole as the cause, for logs.
 */
import { FetchError, ResponseError } from "@boatdev/sdk";
import {
  SandboxProviderError,
  type SandboxProviderFailure,
  type SandboxProviderOperation,
} from "@t3tools/sandbox-core";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { BoatMissingApiKeyError } from "./client.ts";

// Node and undici socket failures that mean "could not reach boat".
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "ERR_NETWORK",
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_HTTP2_SESSION_ERROR",
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_STREAM_CANCEL",
  "UND_ERR_SOCKET",
]);

const TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * Envelope codes whose meaning differs from their HTTP status's. Anything
 * else is classified by status.
 */
const CODE_FAILURES: Readonly<Record<string, SandboxProviderFailure>> = {
  // 409 after boat already held the command 60 s for a starting sandbox.
  boat_starting: "timeout",
  // 403: the plan does not allow the machine size, not a credential problem.
  machine_class_plan_required: "unsupported",
  // 409: `monitoring: true` on an account whose default is off.
  monitoring_off_for_account: "unsupported",
  // 400: env boat refuses (the adapter checks names and size first).
  invalid_env: "unsupported",
  // 400: a fork or resume onto a disk too small for the data.
  type_too_small: "unsupported",
  // 400: a file path outside /home/user and /tmp, or through a symlink.
  invalid_path: "unsupported",
  is_symlink: "unsupported",
};

/** Only codes shaped like boat's identifiers are kept; anything else is dropped unread. */
const ERROR_CODE_SHAPE = /^[a-z][a-z0-9_]{0,63}$/u;

// Reading an error body is a nicety: it never holds a failure up for long.
const ENVELOPE_READ_TIMEOUT = Duration.seconds(2);

function readProperty(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function readStatusCode(error: unknown): number | undefined {
  const status = readProperty(readProperty(error, "response"), "status");
  return typeof status === "number" ? status : undefined;
}

/** The error and its `cause` chain: fetch wraps socket errors one or two levels down. */
function causeChain(error: unknown): ReadonlyArray<unknown> {
  const chain: Array<unknown> = [];
  let current = error;
  while (current !== undefined && current !== null && chain.length < 4) {
    chain.push(current);
    current = readProperty(current, "cause");
  }
  return chain;
}

function statusFailure(status: number): SandboxProviderFailure {
  switch (status) {
    case 401:
    case 403:
      return "unauthorized";
    case 404:
    case 410:
      return "not-found";
    // 402: the account cannot currently operate sandboxes (credits, plan).
    // 429: a machine-start or concurrent-sandbox limit.
    case 402:
    case 429:
      return "quota-exceeded";
    case 408:
    case 504:
      return "timeout";
    case 413:
    case 501:
      return "unsupported";
    // 503 (`no_ready_machine`, `out_of_capacity`) is boat's capacity, not the account's quota.
    default:
      return "provider-error";
  }
}

/** The contract failure label for a rejected boat SDK call, given its envelope `code` if read. */
export function classifyBoatFailure(error: unknown, code?: string): SandboxProviderFailure {
  if (error instanceof BoatMissingApiKeyError) {
    return "unauthorized";
  }
  const status = readStatusCode(error);
  if (error instanceof ResponseError || status !== undefined) {
    const byCode = code === undefined ? undefined : CODE_FAILURES[code];
    return byCode ?? (status === undefined ? "provider-error" : statusFailure(status));
  }
  const chain = causeChain(error);
  const codes = chain
    .map((entry) => readProperty(entry, "code"))
    .filter((entry): entry is string => typeof entry === "string");
  const names = chain
    .map((entry) => readProperty(entry, "name"))
    .filter((name): name is string => typeof name === "string");
  if (codes.some((entry) => TIMEOUT_ERROR_CODES.has(entry)) || names.includes("TimeoutError")) {
    return "timeout";
  }
  if (error instanceof FetchError || codes.some((entry) => NETWORK_ERROR_CODES.has(entry))) {
    return "network";
  }
  if (error instanceof TypeError && error.message === "fetch failed") {
    return "network";
  }
  return "provider-error";
}

/** The two fields of boat's error envelope the adapter acts on. */
export interface BoatErrorEnvelope {
  readonly code: string | undefined;
  /** boat says the call provably did nothing and may be sent again unchanged. */
  readonly retryable: boolean;
}

const NO_ENVELOPE: BoatErrorEnvelope = { code: undefined, retryable: false };

/** Picks `code` and `retryable` out of a parsed error body, top level or under `error`. */
export function boatErrorEnvelope(body: unknown): BoatErrorEnvelope {
  const nested = readProperty(body, "error");
  const rawCode = readProperty(body, "code") ?? readProperty(nested, "code");
  const code = typeof rawCode === "string" && ERROR_CODE_SHAPE.test(rawCode) ? rawCode : undefined;
  const retryable =
    readProperty(body, "retryable") === true || readProperty(nested, "retryable") === true;
  return { code, retryable };
}

/**
 * Reads the envelope of a `ResponseError` from a clone of its response, so
 * the raw error keeps an unread body for whoever logs it. Never fails: an
 * unreadable, non-JSON or slow body reads as no envelope.
 */
export function readBoatErrorEnvelope(error: unknown): Effect.Effect<BoatErrorEnvelope> {
  const response = readProperty(error, "response");
  if (!(response instanceof Response) || response.bodyUsed) {
    return Effect.succeed(NO_ENVELOPE);
  }
  return Effect.tryPromise(() => response.clone().json() as Promise<unknown>).pipe(
    Effect.map(boatErrorEnvelope),
    Effect.timeoutOption(ENVELOPE_READ_TIMEOUT),
    Effect.map(Option.getOrElse(() => NO_ENVELOPE)),
    Effect.orElseSucceed(() => NO_ENVELOPE),
  );
}

/**
 * A rejected boat call: its classification plus the status and envelope
 * fields it was made from. Kept as the `cause` of a `SandboxProviderError`
 * (which never serializes it), with the raw SDK error as its own `cause`.
 * Its message names only the status and code.
 */
export class BoatCallFailure extends Error {
  override readonly name = "BoatCallFailure";
  readonly failure: SandboxProviderFailure;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly retryable: boolean;

  constructor(input: {
    readonly failure: SandboxProviderFailure;
    readonly status: number | undefined;
    readonly envelope: BoatErrorEnvelope;
    readonly cause: unknown;
  }) {
    const code = input.envelope.code === undefined ? "" : ` (${input.envelope.code})`;
    const answered =
      input.status === undefined ? "boat call failed" : `boat answered HTTP ${input.status}${code}`;
    super(`${answered}: ${input.failure}`, { cause: input.cause });
    this.failure = input.failure;
    this.status = input.status;
    this.code = input.envelope.code;
    this.retryable = input.envelope.retryable;
  }
}

/** Classifies a rejected SDK call, reading boat's error envelope when it answered. */
export function toBoatCallFailure(error: unknown): Effect.Effect<BoatCallFailure> {
  return readBoatErrorEnvelope(error).pipe(
    Effect.map(
      (envelope) =>
        new BoatCallFailure({
          failure: classifyBoatFailure(error, envelope.code),
          status: readStatusCode(error),
          envelope,
          cause: error,
        }),
    ),
  );
}

export function boatProviderError(
  operation: SandboxProviderOperation,
  failure: SandboxProviderFailure,
  cause?: unknown,
): SandboxProviderError {
  return new SandboxProviderError({
    providerId: "boat",
    operation,
    failure,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Wraps a classified call failure: its label, the failure itself kept only as `cause`. */
export function fromBoatCallFailure(
  operation: SandboxProviderOperation,
  failure: BoatCallFailure,
): SandboxProviderError {
  return boatProviderError(operation, failure.failure, failure);
}

/** The classified call failure behind a provider error, when a boat call produced it. */
function boatCallFailureOf(error: SandboxProviderError): BoatCallFailure | undefined {
  return error.cause instanceof BoatCallFailure ? error.cause : undefined;
}

/** The HTTP status boat answered the call with. */
export function boatResponseStatus(error: SandboxProviderError): number | undefined {
  return boatCallFailureOf(error)?.status;
}

/** The envelope code boat answered the call with. */
export function boatErrorCode(error: SandboxProviderError): string | undefined {
  return boatCallFailureOf(error)?.code;
}

/** boat refused the call in a way it marks as safe to resend unchanged. */
export function isBoatRetryableRefusal(error: SandboxProviderError): boolean {
  return boatCallFailureOf(error)?.retryable === true;
}

/**
 * A failure boat documents as safe to retry with the same `Idempotency-Key`:
 * no answer at all, or a 500 / 502 / 504. Not 503: no machine was started,
 * and boat pauses creates while capacity drains, so an immediate retry only
 * adds load. Not a client-side timeout either: the first request may still
 * be minting, and a retry would only wait on it again.
 */
export function isBoatTransientFailure(error: SandboxProviderError): boolean {
  const failure = boatCallFailureOf(error);
  if (failure === undefined) {
    return false;
  }
  if (failure.status === undefined) {
    return failure.failure === "network";
  }
  return failure.status === 500 || failure.status === 502 || failure.status === 504;
}
