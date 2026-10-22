// @effect-diagnostics nodeBuiltinImport:off - a plain local server stands in for an old node.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SandboxNodeMcp from "./SandboxNodeMcp.ts";

const layer = SandboxNodeMcp.layer.pipe(Layer.provide(NodeServices.layer));

/** A server that answers every request with 404, like a t3 release without MCP sign-in. */
const withNotFoundServer = <A, E, R>(use: (httpBaseUrl: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((_request, response) => {
        response.writeHead(404).end();
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => use(`http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

describe("SandboxNodeMcp.signIn", () => {
  it.effect("tells a node too old for MCP sign-in apart from one that is down", () =>
    Effect.gen(function* () {
      const nodeMcp = yield* SandboxNodeMcp.SandboxNodeMcp;

      const tooOld = yield* withNotFoundServer((httpBaseUrl) =>
        nodeMcp.signIn({ httpBaseUrl, headers: {} }, "pairing-code").pipe(Effect.flip),
      );
      assert.strictEqual(tooOld.reason, "unsupported");

      const down = yield* nodeMcp
        .signIn({ httpBaseUrl: "http://127.0.0.1:1", headers: {} }, "pairing-code")
        .pipe(Effect.flip);
      assert.strictEqual(down.reason, "unreachable");
    }).pipe(Effect.provide(layer)),
  );
});
