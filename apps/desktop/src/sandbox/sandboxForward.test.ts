// @effect-diagnostics nodeBuiltinImport:off - Stands in for the provider's proxy with a real loopback server.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { afterEach, assert, describe, it } from "@effect/vitest";

import { startSandboxForward, type SandboxForward } from "./sandboxForward.ts";

interface Seen {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A stand-in for the provider's proxy in front of `t3 serve`. */
async function startUpstream() {
  const seen: Array<Seen> = [];
  const server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(201, { "content-type": "application/json", "x-upstream": "yes" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  const sockets = new Set<NodeNet.Socket>();
  server.on("upgrade", (request: NodeHttp.IncomingMessage, socket: NodeNet.Socket) => {
    sockets.add(socket);
    seen.push({ method: request.method, url: request.url, headers: request.headers, body: "" });
    if (request.url === "/refuse") {
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 14\r\n\r\n{"error":"no"}',
      );
      return;
    }
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Seen-Token: ${String(
        request.headers["x-daytona-preview-token"],
      )}\r\n\r\n`,
    );
    socket.on("data", (data) => socket.write(data));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as NodeNet.AddressInfo;
  return { seen, httpBaseUrl: `http://127.0.0.1:${port}` };
}

async function startForward(httpBaseUrl: string, headers: Record<string, string>) {
  const forward = await startSandboxForward({ httpBaseUrl, headers });
  cleanups.push(() => forward.close());
  return forward;
}

function send(
  forward: SandboxForward,
  options: { path: string; method?: string; headers?: NodeHttp.OutgoingHttpHeaders; body?: string },
) {
  return new Promise<{ status: number; headers: NodeHttp.IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const request = NodeHttp.request(
        {
          host: "127.0.0.1",
          port: forward.port,
          path: options.path,
          method: options.method ?? "GET",
          headers: options.headers,
          agent: false,
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (body += chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
          );
          response.on("close", () => {
            if (!response.complete) reject(new Error("response cut off"));
          });
        },
      );
      request.on("error", reject);
      request.end(options.body);
    },
  );
}

function upgrade(forward: SandboxForward, path: string) {
  return new Promise<
    | { kind: "upgraded"; headers: NodeHttp.IncomingHttpHeaders; socket: NodeNet.Socket }
    | { kind: "refused"; status: number; body: string }
  >((resolve, reject) => {
    const request = NodeHttp.request({
      host: "127.0.0.1",
      port: forward.port,
      path,
      agent: false,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "user-agent": "Mozilla/5.0 Chrome/140.0.0.0",
      },
    });
    request.on("upgrade", (response, socket) => {
      cleanups.push(async () => void socket.destroy());
      resolve({ kind: "upgraded", headers: response.headers, socket });
    });
    request.on("response", (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () =>
        resolve({ kind: "refused", status: response.statusCode ?? 0, body }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

/** Sends a request line the HTTP client would not, and returns the status line. */
function sendRaw(forward: SandboxForward, requestLine: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = NodeNet.connect(forward.port, "127.0.0.1", () => {
      socket.write(
        `${requestLine}\r\nHost: 127.0.0.1:${forward.port}\r\nConnection: close\r\n\r\n`,
      );
    });
    let answer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (answer += chunk));
    socket.on("end", () => resolve(answer.split("\r\n")[0] ?? ""));
    socket.on("error", reject);
  });
}

describe("startSandboxForward", () => {
  it("sends requests to the provider's URL with its headers and the upstream host", async () => {
    const upstream = await startUpstream();
    const forward = await startForward(upstream.httpBaseUrl, {
      "X-Daytona-Skip-Preview-Warning": "true",
    });

    const response = await send(forward, {
      path: "/oauth/token?x=1",
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "Mozilla/5.0 Chrome/140.0.0.0",
      },
      body: "grant_type=pairing",
    });

    assert.strictEqual(response.status, 201);
    assert.strictEqual(response.body, '{"ok":true}');
    assert.strictEqual(response.headers["x-upstream"], "yes");
    const [request] = upstream.seen;
    assert.strictEqual(request?.method, "POST");
    assert.strictEqual(request?.url, "/oauth/token?x=1");
    assert.strictEqual(request?.body, "grant_type=pairing");
    assert.strictEqual(request?.headers.host, new URL(upstream.httpBaseUrl).host);
    assert.strictEqual(request?.headers["x-daytona-skip-preview-warning"], "true");
    assert.strictEqual(request?.headers["user-agent"], "Mozilla/5.0 Chrome/140.0.0.0");
  });

  it("refuses a request addressed to any host but loopback", async () => {
    const upstream = await startUpstream();
    const forward = await startForward(upstream.httpBaseUrl, {});

    const response = await send(forward, {
      path: "/.well-known/t3/environment",
      headers: { host: `rebound.example:${forward.port}` },
    });

    assert.strictEqual(response.status, 403);
    assert.deepStrictEqual(upstream.seen, []);
  });

  it("keeps every request target on the provider's host", async () => {
    const upstream = await startUpstream();
    const other = await startUpstream();
    const otherHost = new URL(other.httpBaseUrl).host;
    const forward = await startForward(upstream.httpBaseUrl, {
      "x-daytona-preview-token": "preview-secret",
    });

    await send(forward, { path: `//${otherHost}/leak` });
    await send(forward, { path: `/\\${otherHost}/leak` });
    await upgrade(forward, `//${otherHost}/ws`);
    const absolute = await sendRaw(forward, `GET ${other.httpBaseUrl}/leak HTTP/1.1`);

    assert.deepStrictEqual(other.seen, []);
    assert.strictEqual(absolute, "HTTP/1.1 403 Forbidden");
    assert.deepStrictEqual(
      upstream.seen.map((request) => [request.headers.host, request.url]),
      [
        [new URL(upstream.httpBaseUrl).host, `//${otherHost}/leak`],
        [new URL(upstream.httpBaseUrl).host, `//${otherHost}/leak`],
        [new URL(upstream.httpBaseUrl).host, `//${otherHost}/ws`],
      ],
    );
  });

  it("ends a response the upstream drops partway through", async () => {
    const server = NodeHttp.createServer((_request, response) => {
      response.writeHead(200, { "content-length": "100" });
      response.write("partial");
      setImmediate(() => response.socket?.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const { port } = server.address() as NodeNet.AddressInfo;
    const forward = await startForward(`http://127.0.0.1:${port}`, {});

    const outcome = await send(forward, { path: "/download" }).then(
      () => "completed",
      () => "failed",
    );

    assert.strictEqual(outcome, "failed");
  });

  it("carries a WebSocket upgrade through with the provider's headers", async () => {
    const upstream = await startUpstream();
    const forward = await startForward(upstream.httpBaseUrl, {
      "x-daytona-preview-token": "preview-secret",
    });

    const result = await upgrade(forward, "/ws?wsTicket=ticket");

    assert.strictEqual(result.kind, "upgraded");
    if (result.kind !== "upgraded") return;
    assert.strictEqual(result.headers["x-seen-token"], "preview-secret");
    assert.strictEqual(upstream.seen[0]?.url, "/ws?wsTicket=ticket");
    const echoed = await new Promise<string>((resolve) => {
      result.socket.once("data", (data) => resolve(data.toString("utf8")));
      result.socket.write("ping");
    });
    assert.strictEqual(echoed, "ping");
  });

  it("passes on an upgrade the upstream refuses", async () => {
    const upstream = await startUpstream();
    const forward = await startForward(upstream.httpBaseUrl, {});

    const result = await upgrade(forward, "/refuse");

    assert.deepStrictEqual(result, { kind: "refused", status: 401, body: '{"error":"no"}' });
  });

  it("sends later requests to a new upstream on the same port", async () => {
    const first = await startUpstream();
    const second = await startUpstream();
    const forward = await startForward(first.httpBaseUrl, { "x-daytona-preview-token": "old" });

    forward.retarget({
      httpBaseUrl: second.httpBaseUrl,
      headers: { "x-daytona-preview-token": "new" },
    });
    await send(forward, { path: "/.well-known/t3/environment" });

    assert.deepStrictEqual(first.seen, []);
    assert.strictEqual(second.seen[0]?.headers["x-daytona-preview-token"], "new");
  });

  it("stops listening when closed", async () => {
    const upstream = await startUpstream();
    const forward = await startSandboxForward({ httpBaseUrl: upstream.httpBaseUrl, headers: {} });

    await forward.close();

    const error = await send(forward, { path: "/" }).then(
      () => null,
      (cause: NodeJS.ErrnoException) => cause.code,
    );
    assert.strictEqual(error, "ECONNREFUSED");
  });
});
