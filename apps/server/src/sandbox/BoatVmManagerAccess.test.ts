import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ServerDirectEndpoint } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as BoatVmManagerAccess from "./BoatVmManagerAccess.ts";

const layerFor = (endpoints: ReadonlyArray<ServerDirectEndpoint>) => {
  const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-boat-access-test-" });
  return BoatVmManagerAccess.layer.pipe(
    Layer.provideMerge(
      EnvironmentAuth.layer.pipe(
        Layer.provide(Sqlite.layerMemory),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ServerEnvironment.layerIdentity),
        Layer.provide(layerConfig),
      ),
    ),
    Layer.provide(
      Layer.succeed(DirectEndpoints.DirectEndpoints, {
        resolve: () => Effect.succeed(endpoints),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
};

const boatLinks = (auth: EnvironmentAuth.EnvironmentAuth["Service"]) =>
  auth
    .listPairingLinks()
    .pipe(Effect.map((links) => links.filter((link) => link.label?.startsWith("Boat VM "))));

it.effect("hands a VM this server's tailnet HTTPS origin and ends its old codes and sessions", () =>
  Effect.gen(function* () {
    const access = yield* BoatVmManagerAccess.BoatVmManagerAccess;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;

    const first = yield* access.grant("vm-1");
    assert.equal(Option.getOrThrow(first).managerUrl, "https://manager.example.test");
    const hasSession = auth
      .listSessions()
      .pipe(Effect.map((all) => all.some((listed) => listed.client.label === "Boat VM vm-1")));
    yield* auth.issueMcpClientSession({
      label: BoatVmManagerAccess.labelFor("vm-1"),
      access: "boat-vms",
      client: { deviceType: "bot" },
    });
    assert.isTrue(yield* hasSession);
    yield* access.grant("vm-1");
    assert.equal((yield* boatLinks(auth)).length, 1);
    assert.isFalse(yield* hasSession);

    yield* access.revoke("vm-1");
    assert.deepEqual(yield* boatLinks(auth), []);
  }).pipe(
    Effect.provide(
      layerFor([
        { kind: "lan", httpBaseUrl: "http://192.0.2.10:3773/" },
        { kind: "tailnet", httpBaseUrl: "http://100.64.0.10:3773/" },
        { kind: "tailnet", httpBaseUrl: "https://manager.example.test/" },
      ]),
    ),
  ),
);

it.effect("mints nothing without a tailnet origin", () =>
  Effect.gen(function* () {
    const access = yield* BoatVmManagerAccess.BoatVmManagerAccess;
    assert.isTrue(Option.isNone(yield* access.grant("vm-1")));
    assert.deepEqual(yield* boatLinks(yield* EnvironmentAuth.EnvironmentAuth), []);
  }).pipe(Effect.provide(layerFor([{ kind: "lan", httpBaseUrl: "http://192.0.2.10:3773/" }]))),
);
