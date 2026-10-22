import { FetchError, RequiredError, ResponseError } from "@boatdev/sdk";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BoatMissingApiKeyError } from "./client.ts";
import {
  boatErrorEnvelope,
  BoatCallFailure,
  boatProviderError,
  classifyBoatFailure,
  fromBoatCallFailure,
  isBoatRetryableRefusal,
  isBoatTransientFailure,
  readBoatErrorEnvelope,
  toBoatCallFailure,
} from "./errors.ts";

const API_KEY = "boat_live_key_secret_value";

/** What the SDK throws for a non-2xx answer; the body echoes the credential, as a careless server might. */
function responseError(status: number, extra: Record<string, unknown> = {}): ResponseError {
  const body = JSON.stringify({
    ok: false,
    status,
    code: "some_code",
    message: `Rejected Authorization: Bearer ${API_KEY}`,
    ...extra,
  });
  return new ResponseError(
    new Response(body, { status, headers: { "content-type": "application/json" } }),
    `Response returned an error code (Bearer ${API_KEY})`,
  );
}

/** What fetch rejects with for a socket failure, as the SDK wraps it. */
function fetchError(code: string): FetchError {
  const socket = Object.assign(new Error(`connect ${code} boat.dev`), { code });
  return new FetchError(
    Object.assign(new TypeError("fetch failed"), { cause: socket }),
    "The request failed and the interceptors did not return an alternative response",
  );
}

describe("classifyBoatFailure", () => {
  it.effect.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not-found"],
    [410, "not-found"],
    [402, "quota-exceeded"],
    [429, "quota-exceeded"],
    [408, "timeout"],
    [504, "timeout"],
    [413, "unsupported"],
    [501, "unsupported"],
    [400, "provider-error"],
    [409, "provider-error"],
    [500, "provider-error"],
    [502, "provider-error"],
    [503, "provider-error"],
  ] as const)("maps HTTP %i to %s", ([status, failure]) =>
    Effect.sync(() => {
      assert.equal(classifyBoatFailure(responseError(status)), failure);
    }),
  );

  it.effect("lets the envelope code refine what the status alone says", () =>
    Effect.sync(() => {
      assert.equal(
        classifyBoatFailure(responseError(403), "machine_class_plan_required"),
        "unsupported",
      );
      assert.equal(classifyBoatFailure(responseError(409), "boat_starting"), "timeout");
      assert.equal(classifyBoatFailure(responseError(400), "invalid_env"), "unsupported");
      assert.equal(classifyBoatFailure(responseError(400), "invalid_path"), "unsupported");
      assert.equal(
        classifyBoatFailure(responseError(409), "monitoring_off_for_account"),
        "unsupported",
      );
      // Codes without a mapping of their own fall back to the status.
      assert.equal(classifyBoatFailure(responseError(503), "no_ready_machine"), "provider-error");
      assert.equal(classifyBoatFailure(responseError(429), "rate_limited"), "quota-exceeded");
    }),
  );

  it.effect("tells transport timeouts from other connection failures", () =>
    Effect.sync(() => {
      assert.equal(classifyBoatFailure(fetchError("ECONNREFUSED")), "network");
      assert.equal(classifyBoatFailure(fetchError("ENOTFOUND")), "network");
      assert.equal(classifyBoatFailure(fetchError("ETIMEDOUT")), "timeout");
      assert.equal(classifyBoatFailure(fetchError("UND_ERR_CONNECT_TIMEOUT")), "timeout");
      assert.equal(classifyBoatFailure(fetchError("SOMETHING_ELSE")), "network");
      assert.equal(
        classifyBoatFailure(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" })),
        "network",
      );
      assert.equal(
        classifyBoatFailure(
          Object.assign(new Error("stream error"), { code: "ERR_HTTP2_STREAM_ERROR" }),
        ),
        "network",
      );
      assert.equal(classifyBoatFailure(new TypeError("fetch failed")), "network");
      assert.equal(
        classifyBoatFailure(new DOMException("The operation timed out.", "TimeoutError")),
        "timeout",
      );
    }),
  );

  it.effect("reads a missing API key as unauthorized and anything else as a provider error", () =>
    Effect.sync(() => {
      assert.equal(classifyBoatFailure(new BoatMissingApiKeyError()), "unauthorized");
      assert.equal(classifyBoatFailure(new RequiredError("sandboxId")), "provider-error");
      assert.equal(classifyBoatFailure(new Error("boom")), "provider-error");
      assert.equal(classifyBoatFailure("a string"), "provider-error");
      assert.equal(classifyBoatFailure(undefined), "provider-error");
    }),
  );
});

describe("boatErrorEnvelope", () => {
  it.effect("picks the code and retryable flag, top level or nested, and nothing else", () =>
    Effect.sync(() => {
      assert.deepEqual(boatErrorEnvelope({ code: "boat_starting", retryable: true }), {
        code: "boat_starting",
        retryable: true,
      });
      assert.deepEqual(boatErrorEnvelope({ error: { code: "limit_reached", retryable: true } }), {
        code: "limit_reached",
        retryable: true,
      });
      assert.deepEqual(boatErrorEnvelope({ code: 42, retryable: "true" }), {
        code: undefined,
        retryable: false,
      });
      // Anything not shaped like an identifier is dropped rather than kept.
      assert.deepEqual(boatErrorEnvelope({ code: `Bearer ${API_KEY}` }), {
        code: undefined,
        retryable: false,
      });
      assert.deepEqual(boatErrorEnvelope("not an object"), { code: undefined, retryable: false });
    }),
  );
});

describe("readBoatErrorEnvelope", () => {
  it.effect("reads a clone, so the raw error's body stays readable", () =>
    Effect.gen(function* () {
      const raw = responseError(409, { code: "idempotency_in_progress", retryable: true });
      const envelope = yield* readBoatErrorEnvelope(raw);
      assert.deepEqual(envelope, { code: "idempotency_in_progress", retryable: true });
      assert.isFalse(raw.response.bodyUsed);
    }),
  );

  it.effect("reads no envelope from a non-JSON body or an error without a response", () =>
    Effect.gen(function* () {
      const html = new ResponseError(new Response("<html>502</html>", { status: 502 }));
      assert.deepEqual(yield* readBoatErrorEnvelope(html), { code: undefined, retryable: false });
      assert.deepEqual(yield* readBoatErrorEnvelope(fetchError("ECONNRESET")), {
        code: undefined,
        retryable: false,
      });
      assert.deepEqual(yield* readBoatErrorEnvelope(undefined), {
        code: undefined,
        retryable: false,
      });
    }),
  );
});

describe("toBoatCallFailure / fromBoatCallFailure", () => {
  it.effect("keeps the raw error only as the cause and names only status and code", () =>
    Effect.gen(function* () {
      const raw = responseError(401, { code: "invalid_token" });
      const failure = yield* toBoatCallFailure(raw);
      const error = fromBoatCallFailure("create", failure);

      assert.equal(error._tag, "SandboxProviderError");
      assert.equal(error.providerId, "boat");
      assert.equal(error.operation, "create");
      assert.equal(error.failure, "unauthorized");
      assert.instanceOf(error.cause, BoatCallFailure);
      assert.strictEqual(failure.cause, raw);
      assert.equal(failure.status, 401);
      assert.equal(failure.code, "invalid_token");
      assert.equal(failure.message, "boat answered HTTP 401 (invalid_token): unauthorized");
      assert.equal(error.message, "Sandbox provider boat failed to create (unauthorized).");
      for (const text of [error.message, String(error), failure.message, String(failure)]) {
        assert.notInclude(text, API_KEY);
      }
    }),
  );

  it.effect("tells transient failures and retryable refusals apart", () =>
    Effect.gen(function* () {
      const wrap = (raw: unknown) =>
        toBoatCallFailure(raw).pipe(Effect.map((failure) => fromBoatCallFailure("exec", failure)));

      const network = yield* wrap(fetchError("ECONNRESET"));
      const timeout = yield* wrap(fetchError("ETIMEDOUT"));
      const badGateway = yield* wrap(responseError(502));
      const unavailable = yield* wrap(responseError(503, { code: "out_of_capacity" }));
      const starting = yield* wrap(responseError(409, { code: "boat_starting", retryable: true }));
      const notReady = yield* wrap(
        responseError(409, { code: "sandbox_not_ready", retryable: false }),
      );

      assert.isTrue(isBoatTransientFailure(network));
      assert.isTrue(isBoatTransientFailure(badGateway));
      assert.isFalse(isBoatTransientFailure(timeout));
      assert.isFalse(isBoatTransientFailure(unavailable));
      assert.isFalse(isBoatTransientFailure(starting));
      // A failure the adapter raised itself carries no boat answer.
      assert.isFalse(isBoatTransientFailure(boatProviderError("exec", "network")));

      assert.isTrue(isBoatRetryableRefusal(starting));
      assert.equal(starting.failure, "timeout");
      assert.isFalse(isBoatRetryableRefusal(notReady));
      assert.isFalse(isBoatRetryableRefusal(network));
    }),
  );
});
