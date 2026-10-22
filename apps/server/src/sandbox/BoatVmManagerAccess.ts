import { AuthBoatVmsOperateScope } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";

/**
 * Lets a boat VM this server launched link back to it as its boat manager, so
 * agents on the VM can use the boat VM tools. The VM gets a one-time pairing
 * code with only the boat VM scope, which signs it in to a session that
 * reaches those tools and nothing else (see EnvironmentAuth.mcpClientScopes).
 * Codes and sessions are found again by their label, one per VM.
 */
export class BoatVmManagerAccess extends Context.Service<
  BoatVmManagerAccess,
  {
    /**
     * Ends the VM's earlier codes and sessions and mints a new code, with this
     * server's tailnet origin for the VM to reach it; none when this server
     * has no tailnet address.
     */
    readonly grant: (
      sandboxId: string,
    ) => Effect.Effect<
      Option.Option<{ readonly managerUrl: string; readonly pairingCode: string }>
    >;
    /** Ends the VM's codes and sessions. */
    readonly revoke: (sandboxId: string) => Effect.Effect<void>;
  }
>()("t3/sandbox/BoatVmManagerAccess") {}

/** Long enough for a launch to reach the step that spends it. */
const PAIRING_CODE_TTL = Duration.minutes(10);

export const labelFor = (sandboxId: string) => `Boat VM ${sandboxId}`;

const make = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const endpoints = yield* DirectEndpoints.DirectEndpoints;
  let reportedNoOrigin = false;

  const revoke = Effect.fn("BoatVmManagerAccess.revoke")(
    function* (sandboxId: string) {
      const label = labelFor(sandboxId);
      const links = yield* auth.listPairingLinks();
      for (const link of links) {
        if (
          link.label === label &&
          (link.permissions ?? link.scopes).includes(AuthBoatVmsOperateScope)
        ) {
          yield* auth.revokePairingLink(link.id);
        }
      }
      const sessions = yield* auth.listSessions();
      for (const session of sessions) {
        if (
          session.client.label === label &&
          (session.permissions ?? session.scopes).includes(AuthBoatVmsOperateScope)
        ) {
          yield* auth.revokeSession(session.sessionId);
        }
      }
    },
    (effect, sandboxId) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("boat.vm.managerAccess.revokeFailed", {
            sandboxId,
            error: error.message,
          }),
        ),
      ),
  );

  const grant = Effect.fn("BoatVmManagerAccess.grant")(
    function* (sandboxId: string) {
      yield* revoke(sandboxId);
      const tailnet = (yield* endpoints.resolve()).filter(
        (endpoint) => endpoint.kind === "tailnet",
      );
      // Tailscale Serve's HTTPS name first; a tailnet address is encrypted by the tailnet too.
      const endpoint =
        tailnet.find((candidate) => candidate.httpBaseUrl.startsWith("https:")) ?? tailnet[0];
      if (endpoint === undefined) {
        if (!reportedNoOrigin) {
          reportedNoOrigin = true;
          yield* Effect.logInfo("boat.vm.managerAccess.noTailnetOrigin", {
            detail:
              "This server has no tailnet address, so boat VMs are not linked back to it. Serve it with Tailscale Serve or on its tailnet address.",
          });
        }
        return Option.none();
      }
      const issued = yield* auth.createPairingLink({
        scopes: [AuthBoatVmsOperateScope],
        label: labelFor(sandboxId),
        ttl: PAIRING_CODE_TTL,
      });
      return Option.some({
        managerUrl: new URL(endpoint.httpBaseUrl).origin,
        pairingCode: issued.credential,
      });
    },
    (effect, sandboxId) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("boat.vm.managerAccess.grantFailed", {
            sandboxId,
            error: error.message,
          }).pipe(Effect.as(Option.none())),
        ),
      ),
  );

  return BoatVmManagerAccess.of({ grant, revoke });
});

export const layer = Layer.effect(BoatVmManagerAccess, make);
