import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as DesktopSandboxCredentials from "../../sandbox/DesktopSandboxCredentials.ts";
import * as DesktopSandboxEnvironment from "../../sandbox/DesktopSandboxEnvironment.ts";
import {
  ensureSandboxEnvironment,
  hasSandboxProviderCredential,
  reconnectSandboxEnvironment,
  setSandboxProviderCredential,
} from "./sandboxEnvironment.ts";

function layerCredentials(saved: Map<string, { secret: string }>) {
  return Layer.succeed(
    DesktopSandboxCredentials.DesktopSandboxCredentials,
    DesktopSandboxCredentials.DesktopSandboxCredentials.of({
      get: () => Effect.succeed(Option.none()),
      has: (providerId) => Effect.succeed(saved.has(providerId)),
      set: (input) =>
        Effect.sync(() => {
          saved.set(input.providerId, { secret: Redacted.value(input.secret) });
        }),
      clear: (providerId) => Effect.sync(() => void saved.delete(providerId)),
    }),
  );
}

const TARGET = {
  providerId: "boat",
  label: "Agent box",
  size: "small",
  idleTimeoutMinutes: 15,
  installAgentClis: false,
} as const;

const layerSandboxes = Layer.succeed(
  DesktopSandboxEnvironment.DesktopSandboxEnvironment,
  DesktopSandboxEnvironment.DesktopSandboxEnvironment.of({
    ensure: (input) =>
      Effect.succeed({
        target: input.target,
        sandbox: { providerId: input.target.providerId, sandboxId: "box-1" },
        httpBaseUrl: "http://127.0.0.1:4100/",
        wsBaseUrl: "ws://127.0.0.1:4100/",
        providerUrl: "https://box-1.boat.example.test",
        pairingToken: "pairing-secret",
      }),
    reconnect: (input) =>
      Effect.succeed({ type: "sandbox-environment-stopped", sandbox: input.sandbox }),
    stop: () => Effect.die("unused"),
    destroy: () => Effect.die("unused"),
  }),
);

describe("sandbox environment IPC", () => {
  it.effect("stores a provider key without ever returning it", () => {
    const saved = new Map<string, { secret: string }>();
    return Effect.gen(function* () {
      const result = yield* setSandboxProviderCredential.handler({
        providerId: "boat",
        secret: "  boat_secret  ",
      });

      assert.isUndefined(result);
      assert.deepStrictEqual(saved.get("boat"), { secret: "boat_secret" });
      assert.isTrue(yield* hasSandboxProviderCredential.handler("boat"));
    }).pipe(Effect.provide(layerCredentials(saved)));
  });

  it.effect("rejects an unknown provider or an empty key before storing anything", () => {
    const saved = new Map<string, { secret: string }>();
    return Effect.gen(function* () {
      const unknown = yield* Effect.exit(
        setSandboxProviderCredential.handler({ providerId: "elsewhere", secret: "key" }),
      );
      const empty = yield* Effect.exit(
        setSandboxProviderCredential.handler({ providerId: "boat", secret: "   " }),
      );

      assert.isTrue(Exit.isFailure(unknown));
      assert.isTrue(Exit.isFailure(empty));
      assert.strictEqual(saved.size, 0);
    }).pipe(Effect.provide(layerCredentials(saved)));
  });

  it.effect("decodes a target without the forwarding flag as not forwarding", () =>
    Effect.gen(function* () {
      const result = yield* ensureSandboxEnvironment.handler({
        target: TARGET,
        idempotencyKey: "attempt-1",
      });

      assert.deepInclude(result as object, {
        target: { ...TARGET, forwardGithubToken: false },
        pairingToken: "pairing-secret",
      });
    }).pipe(Effect.provide(layerSandboxes)),
  );

  it.effect("passes a stopped reconnect back as a value", () =>
    Effect.gen(function* () {
      const sandbox = { providerId: "boat", sandboxId: "box-1" };
      const result = yield* reconnectSandboxEnvironment.handler({
        target: TARGET,
        sandbox,
        resume: false,
      });

      assert.deepStrictEqual(result, { type: "sandbox-environment-stopped", sandbox });
    }).pipe(Effect.provide(layerSandboxes)),
  );
});
