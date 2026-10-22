// @effect-diagnostics nodeBuiltinImport:off -- A raw HTTP and WebSocket forward needs the Node server and client sockets, which no Effect HTTP API exposes.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import type * as NodeNet from "node:net";
import * as NodeStream from "node:stream";

/** Where a forward sends traffic: the provider's URL for `t3 serve` and the headers its proxy wants. */
export interface SandboxForwardUpstream {
  readonly httpBaseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface SandboxForward {
  readonly port: number;
  /** Sends new requests to another upstream; open sockets keep the old one. */
  readonly retarget: (upstream: SandboxForwardUpstream) => void;
  readonly close: () => Promise<void>;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forwardedHeaders(
  incoming: NodeHttp.IncomingHttpHeaders,
  target: URL,
  upstream: SandboxForwardUpstream,
  upgrade: boolean,
): NodeHttp.OutgoingHttpHeaders {
  const headers: NodeHttp.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    // A WebSocket handshake needs its Connection and Upgrade headers.
    if (HOP_BY_HOP_HEADERS.has(name) && !(upgrade && (name === "connection" || name === "upgrade")))
      continue;
    headers[name] = value;
  }
  headers.host = target.host;
  for (const [name, value] of Object.entries(upstream.headers)) {
    headers[name.toLowerCase()] = value;
  }
  return headers;
}

function responseHeaders(incoming: NodeHttp.IncomingHttpHeaders): NodeHttp.OutgoingHttpHeaders {
  const headers: NodeHttp.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name)) headers[name] = value;
  }
  return headers;
}

// Framing headers of a body Node has already decoded, which a raw socket
// cannot repeat; the socket is closed after the body instead.
const DECODED_BODY_HEADERS = new Set(["connection", "content-length", "transfer-encoding"]);

function writeRawHead(
  socket: NodeNet.Socket,
  response: NodeHttp.IncomingMessage,
  upgraded: boolean,
): void {
  const lines = [`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? ""}`];
  for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index] ?? "";
    if (!upgraded && DECODED_BODY_HEADERS.has(name.toLowerCase())) continue;
    lines.push(`${name}: ${response.rawHeaders[index + 1]}`);
  }
  if (!upgraded) lines.push("Connection: close");
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
}

/**
 * Serves a sandbox's `t3 serve` on a loopback port and forwards every request
 * and WebSocket upgrade to the provider's URL with the provider's headers
 * added. The renderer cannot add them itself, because a browser WebSocket
 * carries no custom headers.
 *
 * Only `127.0.0.1` and `localhost` Host headers are served, so a web page
 * that rebinds its own name to loopback cannot read through the forward.
 */
export function startSandboxForward(initial: SandboxForwardUpstream): Promise<SandboxForward> {
  let upstream = initial;
  const upgraded = new Set<NodeNet.Socket>();
  const agents = {
    "http:": new NodeHttp.Agent({ keepAlive: true }),
    "https:": new NodeHttps.Agent({ keepAlive: true }),
  };
  const server = NodeHttp.createServer();

  const resolve = (request: NodeHttp.IncomingMessage) => {
    const address = server.address() as NodeNet.AddressInfo;
    const host = request.headers.host;
    if (host !== `127.0.0.1:${address.port}` && host !== `localhost:${address.port}`) return null;
    // Only an origin-form target, appended to the provider's origin, so no
    // target (`//host/`, `/\host/`, `http://host/`) can send the provider's
    // headers anywhere else.
    const path = request.url ?? "/";
    if (!path.startsWith("/")) return null;
    const base = new URL(upstream.httpBaseUrl);
    const target = new URL(`${base.origin}${path}`);
    if (target.origin !== base.origin) return null;
    return base.protocol === "http:" || base.protocol === "https:"
      ? {
          target,
          upstream,
          send: base.protocol === "https:" ? NodeHttps.request : NodeHttp.request,
        }
      : null;
  };

  server.on("request", (request, response) => {
    const route = resolve(request);
    if (route === null) {
      response.writeHead(403).end();
      return;
    }
    const outgoing = route.send(
      route.target,
      {
        method: request.method,
        headers: forwardedHeaders(request.headers, route.target, route.upstream, false),
        agent: agents[route.target.protocol as "http:" | "https:"],
      },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, responseHeaders(incoming.headers));
        // Unlike `pipe`, ends the renderer's response when the upstream drops mid-body.
        NodeStream.pipeline(incoming, response, () => {});
      },
    );
    outgoing.on("error", () => {
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end();
    });
    response.on("close", () => {
      if (!response.writableFinished) outgoing.destroy();
    });
    request.pipe(outgoing);
  });

  server.on(
    "upgrade",
    (request: NodeHttp.IncomingMessage, socket: NodeNet.Socket, head: Buffer) => {
      // Node drops its own socket error handler before emitting `upgrade`.
      socket.on("error", () => socket.destroy());
      const route = resolve(request);
      if (route === null) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      upgraded.add(socket);
      socket.on("close", () => upgraded.delete(socket));
      const outgoing = route.send(route.target, {
        method: request.method,
        headers: forwardedHeaders(request.headers, route.target, route.upstream, true),
        agent: false,
      });
      socket.on("close", () => outgoing.destroy());
      outgoing.on("upgrade", (incoming, upstreamSocket, upstreamHead) => {
        upgraded.add(upstreamSocket);
        upstreamSocket.on("close", () => {
          upgraded.delete(upstreamSocket);
          socket.destroy();
        });
        upstreamSocket.on("error", () => upstreamSocket.destroy());
        socket.on("close", () => upstreamSocket.destroy());
        writeRawHead(socket, incoming, true);
        if (upstreamHead.length > 0) socket.write(upstreamHead);
        if (head.length > 0) upstreamSocket.write(head);
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
      });
      // The upstream refused the upgrade: pass its answer on and hang up.
      outgoing.on("response", (incoming) => {
        writeRawHead(socket, incoming, false);
        NodeStream.pipeline(incoming, socket, () => {});
      });
      outgoing.on("error", () => socket.destroy());
      outgoing.end();
    },
  );

  return new Promise((resolveForward, rejectForward) => {
    server.once("error", rejectForward);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectForward);
      const { port } = server.address() as NodeNet.AddressInfo;
      resolveForward({
        port,
        retarget: (next) => {
          upstream = next;
        },
        close: () =>
          new Promise((resolveClose) => {
            for (const socket of upgraded) socket.destroy();
            server.closeAllConnections();
            agents["http:"].destroy();
            agents["https:"].destroy();
            server.close(() => resolveClose());
          }),
      });
    });
  });
}
