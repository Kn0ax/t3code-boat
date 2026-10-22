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
});
