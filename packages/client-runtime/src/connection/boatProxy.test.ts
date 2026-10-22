import { describe, expect, it } from "@effect/vitest";
import {
  AuthStandardClientScopes,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import { boatProxyBaseUrl, withBoatProxyToken } from "@t3tools/shared/boatProxy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Tracer from "effect/Tracer";

import { preparePairingRegistration } from "./onboarding.ts";
import { resolveRemoteWebSocketConnectionUrl } from "../authorization/remote.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  executeEnvironmentHttpRequest,
  layerRemoteHttpClient,
  makeEnvironmentHttpApiClient,
  makeEnvironmentHttpApiUrlBuilder,
} from "../rpc/http.ts";
import { resolveAssetUrl } from "../state/assets.ts";
import { resolveDeviceHubAccess, withDeviceHubQuery } from "../state/deviceHubAccess.ts";
import { PrimaryConnectionTarget, preparedDirectHttpBaseUrl } from "./model.ts";
import { environmentEndpointUrl, normalizeHttpBaseUrl } from "../environment/endpoint.ts";

const BASE = boatProxyBaseUrl("https://controller.example.test/", "bx_test");
const TOKEN = "relay-credential-with-special+characters/=";
const REQUEST_BASE = withBoatProxyToken(BASE, TOKEN);
const descriptor = {
  environmentId: "environment-paired",
  label: "Cloud environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
  capabilities: { repositoryIdentity: true },
};

const presentation = Layer.succeed(ClientCapabilities.ClientPresentation, {
  metadata: { label: "Test client", deviceType: "desktop", os: "Test OS" },
});

describe("Boat relay transport", () => {
  it.effect(
    "pairs and authorizes HTTP and WebSocket routes without publishing relay credentials",
    () =>
      Effect.gen(function* () {
        const calls: Array<{ url: URL; init: RequestInit }> = [];
        const attributes: Array<unknown> = [];
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            const attribute = span.attribute.bind(span);
            span.attribute = (name, value) => {
              attributes.push(value);
              attribute(name, value);
            };
            return span;
          },
        });
        const fetchFn: typeof fetch = (input, init = {}) => {
          const url = new URL(String(input));
          calls.push({ url, init });
          expect(url.searchParams.get("boatProxyToken")).toBe(TOKEN);
          expect(url.pathname.startsWith("/api/boat-proxy/bx_test/")).toBe(true);
          if (url.pathname.endsWith("/oauth/token")) {
            return Promise.resolve(
              Response.json({
                access_token: "session-credential",
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                token_type: "Bearer",
                expires_in: 3600,
                scope: AuthStandardClientScopes.join(" "),
              }),
            );
          }
          if (url.pathname.endsWith("/api/auth/websocket-ticket")) {
            expect(init.headers).toMatchObject({ authorization: "Bearer session-credential" });
            return Promise.resolve(
              Response.json({ ticket: "socket-ticket", expiresAt: "2026-05-01T12:05:00.000Z" }),
            );
          }
          return Promise.resolve(Response.json(descriptor));
        };
        const registration = yield* preparePairingRegistration({
          host: BASE,
          pairingCode: "pairing-code",
          boatProxy: {
            sandboxId: "bx_test",
            token: TOKEN,
            tailnetHttpBaseUrl: "http://vm.tail.ts.net",
          },
          boatVm: { sandboxId: "bx_test", hostEnvironmentId: EnvironmentId.make("controller") },
        }).pipe(
          Effect.provide(Layer.merge(presentation, layerRemoteHttpClient(fetchFn))),
          Effect.withTracer(tracer),
        );
        expect(registration.profile.httpBaseUrl).toBe(BASE);
        expect(registration.profile.wsBaseUrl).toBe(BASE.replace("https:", "wss:"));
        expect(registration.profile.boatProxy).toEqual({
          sandboxId: "bx_test",
          tailnetHttpBaseUrl: "http://vm.tail.ts.net",
        });
        // The host address is not part of the route, so a relaunch from another replaces it.
        expect(registration.target.connectionId).toBe(
          "bearer:environment-paired:boat-proxy:bx_test",
        );
        expect(registration.profile.boatVm).toEqual({
          sandboxId: "bx_test",
          hostEnvironmentId: "controller",
        });
        expect(JSON.stringify(registration.profile)).not.toContain(TOKEN);
        expect(JSON.stringify(registration.target)).not.toContain(TOKEN);
        expect(registration.credential.proxyToken).toBe(TOKEN);

        const socket = new URL(
          yield* resolveRemoteWebSocketConnectionUrl({
            httpBaseUrl: REQUEST_BASE,
            wsBaseUrl: withBoatProxyToken(registration.profile.wsBaseUrl, TOKEN),
            bearerToken: registration.credential.token,
          }).pipe(Effect.provide(layerRemoteHttpClient(fetchFn)), Effect.withTracer(tracer)),
        );
        expect(socket.pathname).toBe("/api/boat-proxy/bx_test/ws");
        expect(socket.protocol).toBe("wss:");
        expect(socket.searchParams.get("boatProxyToken")).toBe(TOKEN);
        expect(socket.searchParams.get("wsTicket")).toBe("socket-ticket");

        const client = yield* makeEnvironmentHttpApiClient(REQUEST_BASE).pipe(
          Effect.provide(layerRemoteHttpClient(fetchFn)),
        );
        yield* client.metadata
          .descriptor()
          .pipe(Effect.provide(layerRemoteHttpClient(fetchFn)), Effect.withTracer(tracer));
        expect(calls.map(({ url }) => url.pathname)).toEqual([
          "/api/boat-proxy/bx_test/.well-known/t3/environment",
          "/api/boat-proxy/bx_test/oauth/token",
          "/api/boat-proxy/bx_test/api/auth/websocket-ticket",
          "/api/boat-proxy/bx_test/.well-known/t3/environment",
        ]);
        expect(JSON.stringify(attributes)).not.toContain(TOKEN);
        expect(JSON.stringify(attributes)).not.toContain(encodeURIComponent(TOKEN));
      }),
  );

  it("retains the route and relay credential in contract and asset URLs", () => {
    const descriptorUrl = new URL(
      makeEnvironmentHttpApiUrlBuilder(REQUEST_BASE).metadata.descriptor(),
    );
    expect(descriptorUrl.pathname).toBe("/api/boat-proxy/bx_test/.well-known/t3/environment");
    expect(descriptorUrl.searchParams.get("boatProxyToken")).toBe(TOKEN);
    const asset = new URL(
      resolveAssetUrl(REQUEST_BASE, "/api/assets/example?assetToken=asset-credential")!,
    );
    expect(asset.pathname).toBe("/api/boat-proxy/bx_test/api/assets/example");
    expect(asset.searchParams.get("assetToken")).toBe("asset-credential");
    expect(asset.searchParams.get("boatProxyToken")).toBe(TOKEN);
    expect(resolveAssetUrl(REQUEST_BASE, "https://cdn.example.test/image.png")).toBe(
      "https://cdn.example.test/image.png",
    );
  });

  it("keeps unrelated URL normalization unchanged", () => {
    expect(normalizeHttpBaseUrl("https://environment.example.test/ignored?secret=1")).toBe(
      "https://environment.example.test/",
    );
    expect(normalizeHttpBaseUrl(REQUEST_BASE)).toBe(BASE);
    expect(() => boatProxyBaseUrl(BASE, "../other")).toThrow("Invalid Boat sandbox ID");
    expect(() => withBoatProxyToken("https://unrelated.example.test/", TOKEN)).toThrow(
      "Invalid Boat proxy base URL",
    );
    expect(
      normalizeHttpBaseUrl("https://controller.example.test/api/boat-proxy/bx_test/other/"),
    ).toBe("https://controller.example.test/");
    expect(
      environmentEndpointUrl("https://environment.example.test/ignored?secret=1", "/oauth/token"),
    ).toBe("https://environment.example.test/oauth/token");
  });

  it.effect("omits relay credentials from request errors", () =>
    Effect.gen(function* () {
      const result = yield* executeEnvironmentHttpRequest(
        environmentEndpointUrl(REQUEST_BASE, "/oauth/token"),
        1000,
        Effect.fail({ _tag: "NetworkUnavailable" }),
      ).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.message).not.toContain(TOKEN);
        expect(result.failure.message).not.toContain("boatProxyToken");
      }
    }),
  );

  it("reaches a relayed VM's ports only over its tailnet origin", () => {
    const target = new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("environment-paired"),
      label: "Cloud environment",
      httpBaseUrl: "https://environment.example.test/",
      wsBaseUrl: "wss://environment.example.test/",
    });
    const prepared = {
      environmentId: target.environmentId,
      label: target.label,
      httpBaseUrl: REQUEST_BASE,
      socketUrl: target.wsBaseUrl,
      httpAuthorization: null,
      target,
    };
    expect(preparedDirectHttpBaseUrl(prepared)).toBe(REQUEST_BASE);
    expect(preparedDirectHttpBaseUrl({ ...prepared, directHttpBaseUrl: null })).toBeNull();
    expect(
      preparedDirectHttpBaseUrl({ ...prepared, directHttpBaseUrl: "http://vm.tail.ts.net" }),
    ).toBe("http://vm.tail.ts.net");
  });

  it.effect("keeps the relay credential after paths device and preview streams append", () =>
    Effect.gen(function* () {
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("environment-paired"),
        label: "Cloud environment",
        httpBaseUrl: REQUEST_BASE,
        wsBaseUrl: REQUEST_BASE.replace(/^http/, "ws"),
      });
      const access = yield* resolveDeviceHubAccess({
        prepared: {
          environmentId: target.environmentId,
          label: target.label,
          httpBaseUrl: REQUEST_BASE,
          socketUrl: target.wsBaseUrl,
          httpAuthorization: null,
          target,
        },
        hubBasePath: "/api/device-hub",
      }).pipe(Effect.provide(FetchHttpClient.layer));
      const url = new URL(withDeviceHubQuery(`${access.httpBase}/vendor/serve-sim`, access));
      expect(url.pathname).toBe("/api/boat-proxy/bx_test/api/device-hub/vendor/serve-sim");
      expect(url.searchParams.get("boatProxyToken")).toBe(TOKEN);
      expect(access.wsBase).toBe(
        "wss://controller.example.test/api/boat-proxy/bx_test/api/device-hub",
      );
    }),
  );
});
