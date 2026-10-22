import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  BOAT_SANDBOX_NAME_PREFIX,
  boatEnvProblem,
  boatFilePath,
  boatHostedPort,
  boatIdempotencyKey,
  boatSandboxLabel,
  boatSandboxName,
  boatSandboxStatus,
  boatTtlSeconds,
  isBoatRegion,
  MAX_BOAT_ENV_BYTES,
} from "./mapping.ts";

describe("isBoatRegion", () => {
  it.effect("accepts no region or boat's single EU region, and nothing it cannot honor", () =>
    Effect.sync(() => {
      assert.isTrue(isBoatRegion(undefined));
      assert.isTrue(isBoatRegion(""));
      assert.isTrue(isBoatRegion("eu"));
      assert.isTrue(isBoatRegion(" EU "));
      assert.isFalse(isBoatRegion("us"));
      assert.isFalse(isBoatRegion("eu-central-1"));
      assert.isFalse(isBoatRegion("de"));
    }),
  );
});

describe("boatTtlSeconds", () => {
  it.effect("maps idle minutes onto boat's deadline without ever disabling it by accident", () =>
    Effect.sync(() => {
      assert.equal(boatTtlSeconds(30), 1800);
      assert.equal(boatTtlSeconds(1.5), 90);
      // boat counts whole seconds and the adapter asks for at least a minute.
      assert.equal(boatTtlSeconds(0.01), 60);
      assert.isNull(boatTtlSeconds(0));
      assert.isNull(boatTtlSeconds(Number.POSITIVE_INFINITY));
      // Malformed input leaves boat's own 1 hour default in place.
      assert.isUndefined(boatTtlSeconds(Number.NaN));
      assert.isUndefined(boatTtlSeconds(-5));
    }),
  );
});

describe("boatEnvProblem", () => {
  it.effect("accepts what boat accepts and names only the kind of problem", () =>
    Effect.sync(() => {
      assert.isUndefined(boatEnvProblem({}));
      assert.isUndefined(boatEnvProblem({ GH_TOKEN: "ghp_x", _UNDERSCORE: "", a1: "v" }));
      assert.equal(boatEnvProblem({ "1BAD": "v" }), "invalid-name");
      assert.equal(boatEnvProblem({ "WITH-DASH": "v" }), "invalid-name");
      assert.equal(boatEnvProblem({ ["A".repeat(129)]: "v" }), "invalid-name");
      assert.equal(boatEnvProblem({ BOAT_CLI_TOKEN: "v" }), "reserved-name");
      assert.equal(boatEnvProblem({ ASCII_TOKEN: "v" }), "reserved-name");
      const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`V${i}`, "v"]));
      assert.equal(boatEnvProblem(many), "too-many");
      assert.equal(boatEnvProblem({ BIG: "x".repeat(MAX_BOAT_ENV_BYTES) }), "too-large");
      assert.isUndefined(boatEnvProblem({ BIG: "x".repeat(MAX_BOAT_ENV_BYTES - 3) }));
    }),
  );
});

describe("boatSandboxName / boatSandboxLabel", () => {
  it.effect("prefixes, collapses whitespace and cuts at 120 code points", () =>
    Effect.sync(() => {
      assert.equal(boatSandboxName("  my\n task\tone "), `${BOAT_SANDBOX_NAME_PREFIX}my task one`);
      const long = boatSandboxName("🚀".repeat(200));
      assert.equal(Array.from(long).length, 120);
      // The cut never leaves half a surrogate pair behind.
      assert.isTrue(long.endsWith("🚀"));
      assert.equal(boatSandboxLabel({ id: "sb-1", name: boatSandboxName("task") }), "task");
      assert.equal(boatSandboxLabel({ id: "sb-1", name: "someone else's" }), "someone else's");
      assert.equal(boatSandboxLabel({ id: "sb-1", name: "" }), "sb-1");
      assert.equal(boatSandboxLabel({ id: "sb-1" }), "sb-1");
      // A blank label still yields a name boat keeps and `list` recognizes.
      assert.equal(boatSandboxName("  "), `${BOAT_SANDBOX_NAME_PREFIX}sandbox`);
      assert.equal(boatSandboxLabel({ id: "sb-1", name: "t3code:" }), "sb-1");
      assert.equal(boatSandboxLabel({ id: "sb-1", name: "t3code:trimmed" }), "trimmed");
    }),
  );
});

describe("boatSandboxStatus", () => {
  it.effect("maps every boat state and reads a pending stop as stopping", () =>
    Effect.sync(() => {
      const cases = [
        ["init", "creating"],
        ["provisioning", "creating"],
        ["provisioned", "creating"],
        ["cloning", "creating"],
        ["ready", "running"],
        ["idle", "running"],
        ["running", "running"],
        ["archiving", "stopping"],
        ["archived", "stopped"],
        ["error", "error"],
        ["cancelled", "destroyed"],
        ["something-new", "error"],
      ] as const;
      for (const [state, status] of cases) {
        assert.equal(boatSandboxStatus({ state }), status, state);
      }
      assert.equal(boatSandboxStatus({ state: "ready", stop: { status: "pending" } }), "stopping");
      assert.equal(boatSandboxStatus({ state: "idle", stop: { status: "failing" } }), "stopping");
      assert.equal(
        boatSandboxStatus({ state: "ready", stop: { status: "superseded" } }),
        "running",
      );
      assert.equal(
        boatSandboxStatus({ state: "archived", stop: { status: "completed" } }),
        "stopped",
      );
    }),
  );
});

describe("boatIdempotencyKey", () => {
  it.effect("is stable, header-safe and does not echo the caller's key", () =>
    Effect.sync(() => {
      const key = boatIdempotencyKey("provision:é:42");
      assert.equal(key, boatIdempotencyKey("provision:é:42"));
      assert.notEqual(key, boatIdempotencyKey("provision:é:43"));
      assert.match(key, /^t3code-[0-9a-f]{40}$/);
    }),
  );
});

describe("boatHostedPort", () => {
  it.effect("accepts bare HTTP and HTTPS origins", () =>
    Effect.sync(() => {
      assert.deepEqual(
        boatHostedPort("https://frazil-pneuma-rallye-3773.on.boat.dev/"),
        Result.succeed({
          httpBaseUrl: "https://frazil-pneuma-rallye-3773.on.boat.dev",
          headers: {},
        }),
      );
      assert.deepEqual(
        boatHostedPort("http://localhost:3773"),
        Result.succeed({ httpBaseUrl: "http://localhost:3773", headers: {} }),
      );
    }),
  );

  it.effect("converts the token redirect URL into a cookie for HTTP and WebSocket requests", () =>
    Effect.sync(() => {
      assert.deepEqual(
        boatHostedPort("https://x-3773.on.boat.dev/?_token=secret%3Dvalue"),
        Result.succeed({
          httpBaseUrl: "https://x-3773.on.boat.dev",
          headers: { Cookie: "_port_auth=secret=value" },
        }),
      );
    }),
  );

  it.effect("refuses malformed origins and token URLs without carrying secrets into failures", () =>
    Effect.sync(() => {
      for (const raw of [
        "https://x.on.boat.dev/path",
        "https://user:password@x.on.boat.dev",
        "https://x.on.boat.dev/#fragment",
        "https://x.on.boat.dev/?other=secret",
        "https://x.on.boat.dev/?_token=secret&_token=other",
        "https://x.on.boat.dev/?_token=secret&other=value",
        "https://x.on.boat.dev/?_token=",
        "https://x.on.boat.dev/?_token=secret%3Bother=value",
        "https://x.on.boat.dev/?_token=secret%0D%0AHeader:value",
        "https://x.on.boat.dev/?_token=secret%20value",
        "https://x.on.boat.dev/?_token=secret%22value",
        "https://x.on.boat.dev/?_token=secret%5Cvalue",
        "http://x.on.boat.dev/?_token=secret",
        "https://x.on.boat.dev:3773/?_token=secret",
        "https://x.on.boat.dev.example.com/?_token=secret",
        "https://example.com/?_token=secret",
      ]) {
        assert.deepEqual(boatHostedPort(raw), Result.fail("unsupported"));
      }
      assert.deepEqual(boatHostedPort("ftp://x.on.boat.dev"), Result.fail("provider-error"));
      assert.deepEqual(boatHostedPort("not a url"), Result.fail("provider-error"));
      assert.deepEqual(boatHostedPort(undefined), Result.fail("provider-error"));
    }),
  );
});

describe("boatFilePath", () => {
  it.effect("turns home-relative paths into paths relative to boat's work directory", () =>
    Effect.sync(() => {
      assert.equal(boatFilePath("~"), ".");
      assert.equal(boatFilePath("~/"), ".");
      assert.equal(boatFilePath("~/.config/app.json"), ".config/app.json");
      assert.equal(boatFilePath("/tmp/x"), "/tmp/x");
      assert.equal(boatFilePath("relative/x"), "relative/x");
    }),
  );
});
