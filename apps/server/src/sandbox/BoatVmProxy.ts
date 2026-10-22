import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { BOAT_PROXY_PATH_PREFIX, BOAT_PROXY_TOKEN_QUERY_PARAM } from "@t3tools/shared/boatProxy";
import type { SandboxExposedPort, SandboxProviderShape } from "@t3tools/sandbox-core";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";

import { signPayload, timingSafeEqualBase64Url } from "../auth/utils.ts";
import * as Settings from "../serverSettings.ts";

class BoatVmProxyError extends Schema.TaggedError<BoatVmProxyError>()("BoatVmProxyError", {
  status: Schema.Literals([401, 404, 502, 503]),
}) {
  override get message() {
    return "The Boat VM connection is unavailable.";
  }
}

export class BoatVmProxy extends Context.Service<
  BoatVmProxy,
  {
    readonly register: (
      sandboxId: string,
      endpoint: SandboxExposedPort,
    ) => Effect.Effect<string, BoatVmProxyError>;
    readonly forward: (
      sandboxId: string,
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      BoatVmProxyError,
      HttpClient.HttpClient | Scope.Scope
    >;
  }
>()("t3/sandbox/BoatVmProxy") {}

// The host's own policy for HTML it serves: scripts run in an opaque origin.
const RELAY_CONTENT_SECURITY_POLICY =
  "sandbox allow-scripts allow-forms allow-popups allow-downloads";

const droppedRequestHeaders = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "expect",
  "upgrade",
  "cookie",
  // The page's origin is this environment's, not the VM's; boat's edge refuses
  // a socket from a foreign origin.
  "origin",
  "content-length",
  "accept-encoding",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
  "proxy-authorization",
  "proxy-connection",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

const pump = /* One tracing span per frame would continuously allocate. */ Effect.fnUntraced(
  function* (source: Socket.Socket, sink: Socket.Writer) {
    const { pull } = yield* source.reader;
    while (true) yield* sink.writeAll(yield* pull);
  },
);

const proxySocket = Effect.fn("BoatVmProxy.proxySocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  target: string,
  headers: Readonly<Record<string, string>>,
) {
  const protocols = request.headers["sec-websocket-protocol"]
    ?.split(",")
    .map((value) => value.trim());
  const upstream = yield* Socket.makeWebSocket(target.replace(/^http/, "ws"), {
    openTimeout: "10 seconds",
    headers,
    ...(protocols === undefined ? {} : { protocols }),
  }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
  const client = yield* request.upgrade;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const downstreamWriter = yield* client.writer;
      const upstreamWriter = yield* upstream.writer;
      return yield* Effect.raceFirst(
        pump(upstream, downstreamWriter),
        pump(client, upstreamWriter),
      );
    }),
  ).pipe(
    Effect.tapCause((cause) =>
      Effect.logDebug("boat.proxy.socket.closed", { cause: Cause.pretty(cause).slice(0, 500) }),
    ),
    Effect.ignoreCause,
  );
  return HttpServerResponse.empty();
});

const proxyHttp = Effect.fn("BoatVmProxy.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  target: string,
  headers: Readonly<Record<string, string>>,
) {
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const outgoing = HttpClientRequest.make(request.method)(target).pipe(
    HttpClientRequest.setHeaders(headers),
    request.method === "GET" || request.method === "HEAD"
      ? (self) => self
      : HttpClientRequest.bodyStream(request.stream, {
          contentType: request.headers["content-type"],
        }),
  );
  const response = yield* client.execute(outgoing);
  const responseHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (
      value !== undefined &&
      // The HTTP client decompresses the stream, so its original length no longer applies.
      ![
        "set-cookie",
        "connection",
        "content-encoding",
        "content-length",
        "transfer-encoding",
      ].includes(name)
    ) {
      responseHeaders[name] = value;
    }
  }
  // The relay serves the VM on this environment's origin, and an agent on the VM
  // controls its responses, so no document from it may reach this origin's
  // storage or APIs. Chrome will not render a PDF in a sandboxed document.
  const contentType = responseHeaders["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/pdf") {
    const upstreamPolicy = responseHeaders["content-security-policy"];
    responseHeaders["content-security-policy"] =
      upstreamPolicy === undefined
        ? RELAY_CONTENT_SECURITY_POLICY
        : `${upstreamPolicy}, ${RELAY_CONTENT_SECURITY_POLICY}`;
  }
  responseHeaders["x-content-type-options"] = "nosniff";
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers: responseHeaders,
    ...(responseHeaders["content-type"] ? { contentType: responseHeaders["content-type"] } : {}),
  });
});

export const make = Effect.fn("BoatVmProxy.make")(function* (
  options: {
    readonly resolveProvider?: (
      key: string,
    ) => Effect.Effect<SandboxProviderShape, BoatVmProxyError, Scope.Scope>;
  } = {},
) {
  const settings = yield* Settings.ServerSettingsService;
  const key = settings.getSettings.pipe(
    Effect.map((value) => value.sandboxJobs.providerKeys.boat.trim()),
    Effect.mapError(() => new BoatVmProxyError({ status: 503 })),
  );
  const tokenFor = (sandboxId: string, secret: string) =>
    signPayload(`boat-vm-proxy:v1:${sandboxId}`, new TextEncoder().encode(secret));
  const endpoints = yield* Cache.makeWith(
    Effect.fn("BoatVmProxy.resolveEndpoint")(function* (sandboxId: string) {
      const secret = yield* key;
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const provider =
            options.resolveProvider === undefined
              ? yield* Effect.promise(() => import("@t3tools/sandbox-boat")).pipe(
                  Effect.flatMap((boat) => boat.boatSandboxProvider(Redacted.make(secret))),
                )
              : yield* options.resolveProvider(secret);
          return yield* provider.exposePort({ providerId: "boat", sandboxId }, 3773);
        }),
      ).pipe(Effect.mapError(() => new BoatVmProxyError({ status: 502 })));
    }),
    {
      capacity: 128,
      // A VM that was stopped or archived is retried on the next request.
      timeToLive: (exit) => (Exit.isSuccess(exit) ? "5 minutes" : 0),
    },
  );
  const register = Effect.fn("BoatVmProxy.register")(function* (
    sandboxId: string,
    endpoint: SandboxExposedPort,
  ) {
    const secret = yield* key;
    if (secret === "") return yield* new BoatVmProxyError({ status: 503 });
    yield* Cache.set(endpoints, sandboxId, endpoint);
    return tokenFor(sandboxId, secret);
  });
  const forward = Effect.fn("BoatVmProxy.forward")(function* (
    sandboxId: string,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sandboxId)) return yield* new BoatVmProxyError({ status: 404 });
    const parsed = HttpServerRequest.toURL(request);
    if (Option.isNone(parsed)) return yield* new BoatVmProxyError({ status: 404 });
    const url = parsed.value;
    const token = url.searchParams.get(BOAT_PROXY_TOKEN_QUERY_PARAM);
    const secret = yield* key;
    if (
      secret === "" ||
      token === null ||
      !timingSafeEqualBase64Url(token, tokenFor(sandboxId, secret))
    ) {
      return yield* new BoatVmProxyError({ status: 401 });
    }
    const prefix = `${BOAT_PROXY_PATH_PREFIX}${sandboxId}/`;
    if (!url.pathname.startsWith(prefix)) return yield* new BoatVmProxyError({ status: 404 });
    const endpoint = yield* Cache.get(endpoints, sandboxId);
    // Destination and provider credentials come only from Boat, never from the request.
    const target = new URL(endpoint.httpBaseUrl);
    target.pathname = `/${url.pathname.slice(prefix.length)}`;
    target.search = url.search;
    target.searchParams.delete(BOAT_PROXY_TOKEN_QUERY_PARAM);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined && !droppedRequestHeaders.has(name)) headers[name] = value;
    }
    Object.assign(headers, endpoint.headers);
    if (request.headers.upgrade?.toLowerCase() === "websocket") {
      return yield* proxySocket(request, target.toString(), headers).pipe(
        Effect.mapError(() => new BoatVmProxyError({ status: 502 })),
      );
    }
    return yield* proxyHttp(request, target.toString(), headers).pipe(
      Effect.mapError(() => new BoatVmProxyError({ status: 502 })),
    );
  });
  return BoatVmProxy.of({ register, forward });
});

export const layer = Layer.effect(BoatVmProxy, make());
export const routeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const proxy = yield* BoatVmProxy;
    return HttpRouter.add(
      "*",
      `${BOAT_PROXY_PATH_PREFIX}:sandboxId/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const params = yield* HttpRouter.params;
        return yield* proxy.forward(params.sandboxId ?? "", request);
      }).pipe(
        Effect.catchTags({
          BoatVmProxyError: (error) =>
            Effect.succeed(HttpServerResponse.text(error.message, { status: error.status })),
        }),
      ),
    );
  }),
);
