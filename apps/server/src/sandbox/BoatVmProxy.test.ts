// @effect-diagnostics-next-line nodeBuiltinImport:off -- A real upstream HTTP server verifies forwarding on the wire.
import * as NodeHttp from "node:http";
import * as NodeZlib from "node:zlib";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { expect, it } from "@effect/vitest";
import { SandboxProviderError } from "@t3tools/sandbox-core";
import { makeFakeSandboxProvider } from "@t3tools/sandbox-core/testing";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { signPayload } from "../auth/utils.ts";
import * as Settings from "../serverSettings.ts";
import * as BoatVmProxy from "./BoatVmProxy.ts";

const fixture = Effect.fn("BoatVmProxy.test.fixture")(function* () {
  const requests: Array<{
    method: string | undefined;
    url: string | undefined;
    headers: NodeHttp.IncomingHttpHeaders;
    body: string;
  }> = [];
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeHttp.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          requests.push({
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: Buffer.concat(chunks).toString(),
          });
          if (request.url?.includes("compressed")) {
            const body = NodeZlib.gzipSync(
              JSON.stringify({ message: "Complete response ".repeat(100) }),
            );
            response.writeHead(200, {
              "content-type": "application/json",
              "content-encoding": "gzip",
              "content-length": body.length,
            });
            response.end(body);
            return;
          }
          response.writeHead(201, {
            "content-type": "application/json",
            "set-cookie": "upstream-session=private",
          });
          response.end('{"forwarded":true}');
        });
      }),
    ),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );
  yield* Effect.promise(
    () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
  );
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("Missing upstream port");
  const upstreamOrigin = `http://127.0.0.1:${address.port}`;
  const services = yield* Layer.build(
    HttpRouter.serve(BoatVmProxy.routeLayer, { disableListenLog: true }).pipe(
      Layer.provideMerge(
        BoatVmProxy.layer.pipe(
          Layer.provide(Settings.layerTest({ sandboxJobs: { providerKeys: { boat: "api-key" } } })),
        ),
      ),
      Layer.provideMerge(NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0 })),
      Layer.provideMerge(FetchHttpClient.layer),
    ),
  );
  const proxy = Context.get(services, BoatVmProxy.BoatVmProxy);
  const client = Context.get(services, HttpClient.HttpClient);
  const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
  const token = yield* proxy.register("vm-1", {
    httpBaseUrl: upstreamOrigin,
    headers: { Cookie: "_port_auth=port-secret" },
  });
  return { server, requests, origin, token, client };
});

it.effect("forwards the entire decompressed response without the compressed content length", () =>
  Effect.gen(function* () {
    const { origin, token, client } = yield* fixture();
    const response = yield* client.get(
      `${origin}/api/boat-proxy/vm-1/compressed?boatProxyToken=${token}`,
    );
    expect(yield* response.json).toEqual({ message: "Complete response ".repeat(100) });
  }),
);

it.effect("forwards HTTP credentials, method and body without leaking provider cookies", () =>
  Effect.gen(function* () {
    const { requests, origin, token, client } = yield* fixture();
    const response = yield* client.post(
      `${origin}/api/boat-proxy/vm-1/api/session?boatProxyToken=${token}&mode=pair`,
      {
        headers: {
          authorization: "Bearer vm-access-token",
          cookie: "host-session=host-secret",
          "content-type": "application/json",
        },
        body: HttpBody.text('{"pairingCode":"123456"}', "application/json"),
      },
    );
    expect(response.status).toBe(201);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["content-security-policy"]).toBe(
      "sandbox allow-scripts allow-forms allow-popups allow-downloads",
    );
    expect(yield* response.text).toBe('{"forwarded":true}');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/api/session?mode=pair",
      body: '{"pairingCode":"123456"}',
      headers: {
        authorization: "Bearer vm-access-token",
        cookie: "_port_auth=port-secret",
        "content-type": "application/json",
      },
    });
  }),
);

it.effect("forwards chunked uploads without hop-by-hop headers fetch rejects", () =>
  Effect.gen(function* () {
    const { requests, origin, token } = yield* fixture();
    const status = yield* Effect.promise(
      () =>
        new Promise<number | undefined>((resolve, reject) => {
          const request = NodeHttp.request(
            `${origin}/api/boat-proxy/vm-1/upload?boatProxyToken=${token}`,
            {
              method: "POST",
              headers: {
                expect: "100-continue",
                "keep-alive": "timeout=5",
                "transfer-encoding": "chunked",
              },
            },
            (response) => {
              response.resume();
              response.on("end", () => resolve(response.statusCode));
            },
          );
          request.on("error", reject);
          request.on("continue", () => {
            request.write("first,");
            request.end("second");
          });
        }),
    );
    expect(status).toBe(201);
    expect(requests[0]).toMatchObject({ url: "/upload", body: "first,second" });
  }),
);

it.effect("rejects absent, invalid and other VM capabilities before contacting upstream", () =>
  Effect.gen(function* () {
    const { requests, origin, token, client } = yield* fixture();
    for (const path of [
      "/vm-1/api/environment",
      "/vm-1/api/environment?boatProxyToken=invalid",
      `/vm-2/api/environment?boatProxyToken=${token}`,
    ]) {
      const response = yield* client.get(`${origin}/api/boat-proxy${path}`);
      expect(response.status).toBe(401);
      expect(yield* response.text).not.toContain("port-secret");
    }
    expect(requests).toEqual([]);
  }),
);

it.effect("preserves text and binary WebSocket frames with Boat auth and VM ticket", () =>
  Effect.gen(function* () {
    const { server, origin, token } = yield* fixture();
    const upstream = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeWS.WebSocketServer({ server })),
      (upstream) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              for (const client of upstream.clients) client.terminate();
              upstream.close(() => resolve());
            }),
        ),
    );
    const accepted = Promise.withResolvers<NodeHttp.IncomingMessage>();
    upstream.on("connection", (socket, request) => {
      accepted.resolve(request);
      socket.on("message", (data, binary) => socket.send(data, { binary }));
      socket.send("ready");
    });
    const frames: Array<string | number[]> = [];
    const received = Promise.withResolvers<void>();
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const client = new NodeWS.WebSocket(
          `${origin.replace(/^http/, "ws")}/api/boat-proxy/vm-1/ws?boatProxyToken=${token}&wsTicket=vm-ticket`,
          { headers: { Cookie: "host-session=host-secret", Authorization: "Bearer vm-token" } },
        );
        client.on("error", received.reject);
        client.on("message", (data, binary) => {
          frames.push(binary ? [...new Uint8Array(data as Buffer)] : data.toString());
          if (frames.length === 1) {
            client.send("hello");
            client.send(Uint8Array.of(0x00, 0xff, 0x03));
          } else if (frames.length === 3) received.resolve();
        });
        return client;
      }),
      (client) => Effect.sync(() => client.terminate()),
    );
    yield* Effect.promise(() => received.promise);
    const request = yield* Effect.promise(() => accepted.promise);
    expect(request.url).toBe("/ws?wsTicket=vm-ticket");
    expect(request.headers.cookie).toBe("_port_auth=port-secret");
    expect(request.headers.authorization).toBe("Bearer vm-token");
    expect(frames).toEqual(["ready", "hello", [0x00, 0xff, 0x03]]);
  }),
);

it.effect("looks a VM up again after a failed lookup instead of caching the failure", () =>
  Effect.gen(function* () {
    let available = false;
    let lookups = 0;
    const proxy = yield* BoatVmProxy.make({
      resolveProvider: () =>
        Effect.succeed({
          ...makeFakeSandboxProvider({ id: "boat" }),
          exposePort: () =>
            Effect.suspend(() => {
              lookups += 1;
              return available
                ? Effect.succeed({ httpBaseUrl: "http://127.0.0.1:9", headers: {} })
                : Effect.fail(
                    new SandboxProviderError({
                      providerId: "boat",
                      operation: "exposePort",
                      failure: "not-found",
                    }),
                  );
            }),
        }),
    }).pipe(
      Effect.provide(Settings.layerTest({ sandboxJobs: { providerKeys: { boat: "api-key" } } })),
    );
    const token = signPayload("boat-vm-proxy:v1:vm-2", new TextEncoder().encode("api-key"));
    const request = HttpServerRequest.fromWeb(
      new Request(`http://host.test/api/boat-proxy/vm-2/api?boatProxyToken=${token}`),
    );
    const forward = proxy
      .forward("vm-2", request)
      .pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.flip);

    yield* forward;
    available = true;
    yield* forward;
    expect(lookups).toBe(2);
  }),
);
