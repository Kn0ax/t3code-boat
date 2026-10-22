// @effect-diagnostics nodeBuiltinImport:off - A loopback HTTP server stands in for the boat API.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as NodeHttp from "node:http";

import { makeBoatSandboxProvider } from "./provider.ts";

const API_KEY = "boat_test_key_secret_value";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: unknown;
}

const sandboxJson = (id: string, name = "") => ({
  id,
  name,
  state: "provisioning",
  desktopAvailable: false,
  snapshotAvailable: false,
});

/** Answers the routes the adapter uses the way boat's v1 API documents them. */
function answer(request: RecordedRequest): { readonly status: number; readonly body: unknown } {
  const { method, url } = request;
  const path = url.split("?")[0] ?? "";
  if (path === "/api/v1/sandboxes/unauthorized") {
    return {
      status: 401,
      body: { ok: false, code: "invalid_token", message: `Bearer ${API_KEY} is not valid` },
    };
  }
  if (path === "/api/v1/sandboxes/missing") {
    return { status: 404, body: { ok: false, code: "sandbox_not_found", message: "no sandbox" } };
  }
  switch (`${method} ${path}`) {
    case "POST /api/v1/sandboxes":
      return { status: 202, body: { ok: true, type: "sandbox", sandbox: sandboxJson("sb-1") } };
    case "PATCH /api/v1/sandboxes/sb-1":
    case "PATCH /api/v1/sandboxes/sb-2":
      return {
        status: 200,
        body: {
          ok: true,
          type: "sandbox",
          sandbox: sandboxJson(path.split("/").at(-1)!, (request.body as { name: string }).name),
        },
      };
    case "POST /api/v1/sandboxes/sb-1/commands":
      return {
        status: 200,
        body: {
          ok: true,
          type: "command.finished",
          success: true,
          exitCode: 0,
          stdout: "hi\n",
          stderr: "",
          timedOut: false,
        },
      };
    case "POST /api/v1/sandboxes/sb-1/host":
      return {
        status: 200,
        body: {
          ok: true,
          type: "hosted_port",
          port: 3773,
          url: "https://frazil-pneuma-rallye-3773.on.boat.dev?_token=port-token",
          isProtected: true,
          access: "private",
        },
      };
    case "PUT /api/v1/sandboxes/sb-1/files":
      return {
        status: 200,
        body: { ok: true, type: "file", success: true, path: "x", encoding: "base64", size: 2 },
      };
    case "GET /api/v1/sandboxes/sb-1/files":
      return {
        status: 200,
        body: {
          ok: true,
          type: "file",
          success: true,
          path: "x",
          encoding: "base64",
          size: 2,
          content: "AP8=",
        },
      };
    case "POST /api/v1/sandboxes/sb-1/fork":
      return {
        status: 202,
        body: {
          ok: true,
          type: "sandbox",
          id: "sb-2",
          status: "accepted",
          sandbox: sandboxJson("sb-2"),
        },
      };
    case "DELETE /api/v1/sandboxes/sb-1":
      return { status: 202, body: { ok: true, type: "deletion" } };
    default:
      return { status: 500, body: { ok: false, code: "unexpected_route" } };
  }
}

const withFakeBoatApi = <A, E>(
  use: (baseUrl: string, requests: ReadonlyArray<RecordedRequest>) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.callback<{ server: NodeHttp.Server; requests: Array<RecordedRequest>; baseUrl: string }>(
      (resume) => {
        const requests: Array<RecordedRequest> = [];
        const server = NodeHttp.createServer((incoming, response) => {
          const chunks: Array<Buffer> = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const request: RecordedRequest = {
              method: incoming.method ?? "",
              url: incoming.url ?? "",
              headers: incoming.headers,
              body: text.length === 0 ? undefined : JSON.parse(text),
            };
            requests.push(request);
            const { status, body } = answer(request);
            response.writeHead(status, { "content-type": "application/json" });
            response.end(JSON.stringify(body));
          });
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : 0;
          resume(Effect.succeed({ server, requests, baseUrl: `http://127.0.0.1:${port}/api/v1/` }));
        });
      },
    ),
    ({ baseUrl, requests }) => use(baseUrl, requests),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );

describe("makeBoatSandboxProvider", () => {
  it.effect("refuses an empty API key without sending anything", () =>
    Effect.gen(function* () {
      const provider = makeBoatSandboxProvider({ apiKey: Redacted.make("  ") });

      const error = yield* provider
        .get({ providerId: "boat", sandboxId: "sb-1" })
        .pipe(Effect.flip);

      assert.equal(provider.id, "boat");
      assert.isFunction(provider.fork);
      assert.isFunction(provider.startBackground);
      assert.equal(error.failure, "unauthorized");
    }),
  );

  it.live("speaks boat's v1 API through the real SDK, with the key only in the bearer header", () =>
    withFakeBoatApi((baseUrl, requests) =>
      Effect.gen(function* () {
        const provider = makeBoatSandboxProvider({
          apiKey: Redacted.make(API_KEY),
          baseUrl,
          org: "acme",
        });
        const ref = { providerId: "boat", sandboxId: "sb-1" } as const;

        const created = yield* provider.create({
          label: "task",
          env: { GH_TOKEN: "ghp_x" },
          size: "large",
          idleTimeoutMinutes: 60,
          idempotencyKey: "key-1",
        });
        const result = yield* provider.exec(ref, { script: "echo hi", timeoutMs: 30_000 });
        const exposed = yield* provider.exposePort(ref, 3773);
        yield* provider.writeFile(ref, "~/x", new Uint8Array([0, 255]));
        const read = yield* provider.readFile(ref, "~/x");
        const forked = yield* provider.fork!(ref, "attempt");
        yield* provider.destroy(ref);
        const unauthorized = yield* provider
          .get({ providerId: "boat", sandboxId: "unauthorized" })
          .pipe(Effect.flip);
        const missing = yield* provider
          .destroy({ providerId: "boat", sandboxId: "missing" })
          .pipe(Effect.as("destroyed"));

        assert.deepEqual(
          requests.map((request) => `${request.method} ${request.url}`),
          [
            "POST /api/v1/sandboxes",
            "PATCH /api/v1/sandboxes/sb-1",
            "POST /api/v1/sandboxes/sb-1/commands",
            "POST /api/v1/sandboxes/sb-1/host",
            "PUT /api/v1/sandboxes/sb-1/files",
            "GET /api/v1/sandboxes/sb-1/files?path=x&encoding=base64",
            "POST /api/v1/sandboxes/sb-1/fork",
            "PATCH /api/v1/sandboxes/sb-2",
            "DELETE /api/v1/sandboxes/sb-1",
            "GET /api/v1/sandboxes/unauthorized",
            "DELETE /api/v1/sandboxes/missing",
          ],
        );
        for (const request of requests) {
          assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
          assert.notInclude(JSON.stringify(request.body ?? null), API_KEY);
          assert.notInclude(request.url, API_KEY);
        }
        const [create, rename, command, host, write, , fork, , destroy] = requests;
        assert.match(String(create!.headers["idempotency-key"]), /^t3code-[0-9a-f]{40}$/);
        assert.deepEqual(create!.body, {
          type: "large",
          ttlSeconds: 3600,
          env: { GH_TOKEN: "ghp_x" },
          noEnv: true,
          org: "acme",
        });
        assert.deepEqual(rename!.body, { name: "t3code: task" });
        assert.equal((command!.body as { timeoutSeconds: number }).timeoutSeconds, 30);
        assert.deepEqual(host!.body, { port: 3773, public: false, title: "T3 Code" });
        assert.deepEqual(write!.body, { path: "x", content: "AP8=", encoding: "base64" });
        assert.match(String(fork!.headers["idempotency-key"]), /^t3code-fork-/);
        assert.equal(destroy!.headers["x-ascii-confirm-delete"], "sb-1");

        assert.deepEqual(created, {
          ref: { providerId: "boat", sandboxId: "sb-1" },
          status: "creating",
          label: "task",
        });
        assert.deepEqual(result, { exitCode: 0, stdout: "hi\n", stderr: "" });
        assert.deepEqual(exposed, {
          httpBaseUrl: "https://frazil-pneuma-rallye-3773.on.boat.dev",
          headers: { Cookie: "_port_auth=port-token" },
        });
        assert.deepEqual([...read], [0, 255]);
        assert.equal(forked.ref.sandboxId, "sb-2");
        assert.equal(unauthorized.failure, "unauthorized");
        assert.notInclude(String(unauthorized), API_KEY);
        assert.notInclude(String(unauthorized.cause), API_KEY);
        assert.equal(missing, "destroyed");
      }),
    ),
  );
});
