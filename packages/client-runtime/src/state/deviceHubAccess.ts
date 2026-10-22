/**
 * `<img>`, `EventSource`, and `WebSocket` cannot set bearer or DPoP headers, so bearer and DPoP
 * connections mint a short-lived WebSocket ticket and pass it as `wsTicket`, the same way the
 * app's own `/ws` upgrade authenticates. Callers fetch a fresh one each time they (re)connect a
 * stream.
 */
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import type { DeviceHubAccess } from "../device/hubAccess.ts";

export { type DeviceHubAccess, withDeviceHubQuery } from "../device/hubAccess.ts";

const TICKET_TIMEOUT_MS = 8_000;

export const resolveDeviceHubAccess = Effect.fn("clientRuntime.state.resolveDeviceHubAccess")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly hubBasePath: string;
  }): Effect.fn.Return<DeviceHubAccess, RemoteEnvironmentRequestError, HttpClient.HttpClient> {
    const endpoint = new URL(environmentEndpointUrl(input.prepared.httpBaseUrl, input.hubBasePath));
    // A relay capability rides in the base query; callers append paths to the base.
    const baseQuery = Object.fromEntries(endpoint.searchParams);
    endpoint.search = "";
    const httpBase = endpoint.toString();
    const wsBase = httpBase.replace(/^http/, "ws");
    if (input.prepared.httpAuthorization === null) {
      return { httpBase, wsBase, query: baseQuery, credentials: true };
    }
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    const ticket = yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: input.prepared,
      signer,
      remoteAuthorization,
      group: "auth",
      method: "POST",
      url: (urls) => urls.webSocketTicket(),
      timeoutMs: TICKET_TIMEOUT_MS,
      request: ({ client, headers }) => client.webSocketTicket({ headers }),
    });
    return {
      httpBase,
      wsBase,
      query: { ...baseQuery, wsTicket: ticket.ticket },
      credentials: false,
    };
  },
);
