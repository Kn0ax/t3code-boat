import { assert, describe, it } from "@effect/vitest";
import { BoatVmError, type SandboxJobSettings } from "@t3tools/contracts";
import { BoatCatalogError, type BoatCatalogShape } from "@t3tools/sandbox-boat";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";

import * as BoatCatalog from "./BoatCatalog.ts";

const settings = (boat: string) => ({ providerKeys: { boat } }) as unknown as SandboxJobSettings;

const DESKTOP_URL = "https://desktop.example/bx_1?token=desktop_secret";

interface Calls {
  readonly saved: Array<{ readonly sandboxId: string; readonly name: string }>;
  readonly polled: Array<string>;
}

const makeCatalog = (calls: Calls, overrides: Partial<BoatCatalogShape> = {}): BoatCatalogShape => {
  // boat sends an environment's env contents with it; the catalog must not pass them on.
  const environment = { name: "work", isDefault: true, envContents: "TOKEN=secret" };
  return {
    snapshots: Effect.succeed([
      {
        name: "t3-acme-app",
        status: "ready",
        sizeBytes: 2048,
        createdAt: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
      },
      { name: "t3-base", status: "saving", sizeBytes: 1.5 },
    ]),
    environments: Effect.succeed([environment, { name: "public", isDefault: false }]),
    saveSnapshot: (input) =>
      Effect.sync(() => {
        calls.saved.push(input);
        return { name: input.name, status: "saving" };
      }),
    snapshotStatus: (name) =>
      Effect.sync(() => {
        calls.polled.push(name);
        return { name, status: "ready" };
      }),
    desktop: () => Effect.succeed({ status: "ready", url: DESKTOP_URL }),
    ...overrides,
  };
};

const operations = (key: string, catalog: BoatCatalogShape) =>
  BoatCatalog.makeOperations(Effect.succeed(settings(key)), (current) =>
    Effect.succeed(current.providerKeys.boat === "" ? undefined : catalog),
  );

describe("boat VM catalog", () => {
  it.effect("lists snapshots and environment names from the boat account", () =>
    Effect.gen(function* () {
      const calls: Calls = { saved: [], polled: [] };
      const result = yield* operations("boat-key", makeCatalog(calls)).catalog;
      assert.deepStrictEqual(result, {
        available: true,
        snapshots: [
          {
            name: "t3-acme-app",
            status: "ready",
            sizeBytes: 2048,
            createdAt: "1970-01-01T00:00:00.000Z",
          },
          { name: "t3-base", status: "saving" },
        ],
        environments: [
          { name: "work", isDefault: true },
          { name: "public", isDefault: false },
        ],
      });
    }),
  );

  it.effect("is unavailable without a boat key and refuses to save", () =>
    Effect.gen(function* () {
      const calls: Calls = { saved: [], polled: [] };
      const ops = operations("", makeCatalog(calls));
      assert.deepStrictEqual(yield* ops.catalog, {
        available: false,
        snapshots: [],
        environments: [],
      });
      const error = yield* Effect.flip(ops.saveSnapshot({ sandboxId: "bx_1", name: "t3-acme" }));
      assert.instanceOf(error, BoatVmError);
      assert.include(error.message, "boat key");
      assert.deepStrictEqual(calls.saved, []);
    }),
  );

  it.effect("starts a save under the given name", () =>
    Effect.gen(function* () {
      const calls: Calls = { saved: [], polled: [] };
      const ops = operations("boat-key", makeCatalog(calls));
      const started = yield* ops.saveSnapshot({ sandboxId: "bx_1", name: "t3-acme-app" });
      assert.deepStrictEqual(started, { name: "t3-acme-app", status: "saving" });
      assert.deepStrictEqual(calls.saved, [{ sandboxId: "bx_1", name: "t3-acme-app" }]);
    }),
  );

  it.effect("turns a boat failure into a VM error naming what failed", () =>
    Effect.gen(function* () {
      const calls: Calls = { saved: [], polled: [] };
      const ops = operations(
        "boat-key",
        makeCatalog(calls, {
          environments: Effect.fail(
            new BoatCatalogError({ operation: "listEnvironments", failure: "unauthorized" }),
          ),
        }),
      );
      const error = yield* Effect.flip(ops.catalog);
      assert.equal(error.message, "boat could not list the environments (unauthorized).");
    }),
  );

  it.effect("hands out the desktop URL without logging it or putting it on a span", () =>
    Effect.gen(function* () {
      const calls: Calls = { saved: [], polled: [] };
      const logs: Array<unknown> = [];
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const logger = Logger.make(({ fiber, message }) => {
        logs.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) });
      });
      const run = (catalog: BoatCatalogShape) =>
        operations("boat-key", catalog)
          .desktop({ sandboxId: "bx_1" })
          .pipe(
            Effect.withTracer(tracer),
            Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
            Effect.provideService(References.MinimumLogLevel, "Debug"),
          );

      assert.deepStrictEqual(yield* run(makeCatalog(calls)), {
        status: "ready",
        url: DESKTOP_URL,
      });
      const failed = yield* Effect.flip(
        run(
          makeCatalog(calls, {
            desktop: () =>
              Effect.fail(new BoatCatalogError({ operation: "desktop", failure: "not-found" })),
          }),
        ),
      );
      assert.equal(failed.message, "boat could not open the desktop (not-found).");
      assert.isAbove(spans.length, 0);
      assert.isAbove(logs.length, 0);
      const recorded = JSON.stringify([
        logs,
        spans.map((span) => [span.name, [...span.attributes], span.events]),
      ]);
      assert.notInclude(recorded, "desktop_secret");
    }),
  );

  it.effect("refuses a desktop without a boat key", () =>
    Effect.gen(function* () {
      const calls: Calls = { saved: [], polled: [] };
      const error = yield* Effect.flip(
        operations("", makeCatalog(calls)).desktop({ sandboxId: "bx_1" }),
      );
      assert.include(error.message, "boat key");
    }),
  );
});
