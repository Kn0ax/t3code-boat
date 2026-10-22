import { ResponseError } from "@boatdev/sdk";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeBoatCatalogFromClient, type BoatCatalogClient } from "./catalog.ts";

const unused = () => Promise.reject(new Error("not called"));

describe("boat catalog", () => {
  it.effect("classifies a refused save without copying boat's message", () =>
    Effect.gen(function* () {
      const client: BoatCatalogClient = {
        listNamedSnapshots: unused,
        getNamedSnapshot: unused,
        environments: unused,
        desktop: unused,
        saveNamedSnapshot: () =>
          Promise.reject(
            new ResponseError(
              new Response(JSON.stringify({ code: "forbidden", message: "key boat_secret" }), {
                status: 403,
                headers: { "content-type": "application/json" },
              }),
            ),
          ),
      };
      const error = yield* Effect.flip(
        makeBoatCatalogFromClient(client).saveSnapshot({ sandboxId: "bx_1", name: "t3-app" }),
      );
      assert.equal(error.operation, "saveSnapshot");
      assert.equal(error.failure, "unauthorized");
      assert.notInclude(error.message, "boat_secret");
    }),
  );

  it.effect("reports a desktop still provisioning, then its URL and mode as boat gave them", () =>
    Effect.gen(function* () {
      const answers = [
        { provisioning: true, desktopUrl: null },
        { desktopUrl: "https://desktop.example/s?token=secret", mode: "stream" },
      ];
      const asked: Array<string> = [];
      const client: BoatCatalogClient = {
        listNamedSnapshots: unused,
        getNamedSnapshot: unused,
        environments: unused,
        saveNamedSnapshot: unused,
        desktop: (sandboxId) => {
          asked.push(sandboxId);
          return Promise.resolve(answers.shift()!);
        },
      };
      const catalog = makeBoatCatalogFromClient(client);
      assert.deepStrictEqual(yield* catalog.desktop("bx_1"), { status: "provisioning" });
      assert.deepStrictEqual(yield* catalog.desktop("bx_1"), {
        status: "ready",
        url: "https://desktop.example/s?token=secret",
        mode: "stream",
      });
      assert.deepStrictEqual(asked, ["bx_1", "bx_1"]);
    }),
  );

  it.effect("fails a desktop answer with no URL", () =>
    Effect.gen(function* () {
      const client: BoatCatalogClient = {
        listNamedSnapshots: unused,
        getNamedSnapshot: unused,
        environments: unused,
        saveNamedSnapshot: unused,
        desktop: () => Promise.resolve({ desktopUrl: null }),
      };
      const error = yield* Effect.flip(makeBoatCatalogFromClient(client).desktop("bx_1"));
      assert.equal(error.operation, "desktop");
      assert.equal(error.failure, "provider-error");
    }),
  );
});
