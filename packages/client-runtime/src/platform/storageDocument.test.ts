import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as TokenStore from "../authorization/tokenStore.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  RelayConnectionRegistration,
  SandboxConnectionProfile,
  SandboxConnectionRegistration,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "../connection/catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SandboxConnectionTarget,
  SshConnectionTarget,
} from "../connection/model.ts";
import {
  GitHubRoutingPermissions,
  makeGitHubRoutingPermissions,
} from "../connection/githubRoutingPermissions.ts";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  catalogRoutes,
  setRoutesInCatalog,
  putRemoteDpopTokenInCatalog,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
  setConnectionEnabledInCatalog,
} from "./storageDocument.ts";

const decodeConnectionCatalogDocument = Schema.decodeUnknownEffect(ConnectionCatalogDocument);

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const decodeCatalogDocument = Schema.decodeUnknownSync(ConnectionCatalogDocument);
const decodeStoredCatalogDocument = Schema.decodeUnknownSync(
  Schema.fromJsonString(ConnectionCatalogDocument),
);

const RELAY_TARGET = new RelayConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
});
const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "bearer-1",
});
const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: BEARER_TARGET.label,
  httpBaseUrl: "https://remote.example.test",
  wsBaseUrl: "wss://remote.example.test",
});
const BEARER_CREDENTIAL = new BearerConnectionCredential({
  token: "bearer-token",
});
const REMOTE_TOKEN = new TokenStore.RemoteDpopAccessToken({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  endpoint: {
    httpBaseUrl: "https://remote.example.test",
    wsBaseUrl: "wss://remote.example.test",
    providerKind: "cloudflare_tunnel",
  },
  accessToken: "dpop-token",
  expiresAtEpochMs: 1_000_000,
  dpopThumbprint: "thumbprint",
});

describe("ConnectionCatalogDocument", () => {
  it.each(["daytona", "docker"])(
    "drops retired %s routes without losing other connections or metadata",
    (providerId) => {
      const retiredId = `sandbox:retired:${providerId}:box`;
      const expected = {
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        targets: [RELAY_TARGET, BEARER_TARGET],
        profiles: [BEARER_PROFILE],
        credentials: [{ connectionId: BEARER_TARGET.connectionId, credential: BEARER_CREDENTIAL }],
        remoteDpopTokens: [REMOTE_TOKEN],
        disabledEnvironmentIds: [ENVIRONMENT_ID],
        githubRoutingPermissions: [
          { environmentId: ENVIRONMENT_ID, connectionKey: "key", permission: "read" },
        ],
      };
      const stored = JSON.stringify({
        ...expected,
        targets: [
          ...expected.targets,
          {
            _tag: "SandboxConnectionTarget",
            environmentId: ENVIRONMENT_ID,
            label: "Retired box",
            connectionId: retiredId,
          },
        ],
        profiles: [
          ...expected.profiles,
          {
            _tag: "SandboxConnectionProfile",
            connectionId: retiredId,
            environmentId: ENVIRONMENT_ID,
            label: "Retired box",
            target: { providerId },
            sandbox: { providerId, sandboxId: "box" },
            providerUrl: "https://box.example.test",
          },
        ],
        credentials: [
          ...expected.credentials,
          { connectionId: retiredId, credential: BEARER_CREDENTIAL },
        ],
      });

      const restored = decodeStoredCatalogDocument(stored);
      expect(restored).toEqual(expected);
      const schema = Schema.fromJsonString(ConnectionCatalogDocument);
      expect(Schema.decodeSync(schema)(Schema.encodeSync(schema)(restored))).toEqual(expected);
    },
  );

  it("still rejects invalid supported profiles", () => {
    expect(() =>
      decodeCatalogDocument({
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        profiles: [{ ...BEARER_PROFILE, httpBaseUrl: 42 }],
      }),
    ).toThrow();
  });

  it.effect("persists explicit GitHub trust and forgets it when a connection is removed", () =>
    Effect.gen(function* () {
      let document = EMPTY_CONNECTION_CATALOG_DOCUMENT;
      const entry = { target: BEARER_TARGET, profile: Option.some(BEARER_PROFILE), enabled: true };
      const storage = {
        read: Effect.sync(() => document.githubRoutingPermissions ?? []),
        write: (githubRoutingPermissions: NonNullable<typeof document.githubRoutingPermissions>) =>
          Effect.gen(function* () {
            document = yield* decodeConnectionCatalogDocument({
              ...document,
              githubRoutingPermissions,
            }).pipe(Effect.orDie);
          }),
      };
      const permissions = yield* makeGitHubRoutingPermissions(storage);
      expect(yield* permissions.get(entry)).toBe("off");
      yield* permissions.set(entry, "read");
      const restarted = yield* makeGitHubRoutingPermissions(storage);
      expect(yield* restarted.get(entry)).toBe("read");

      const changedEndpoint = {
        ...entry,
        profile: Option.some(
          new BearerConnectionProfile({
            ...BEARER_PROFILE,
            httpBaseUrl: "https://different.example.test",
          }),
        ),
      };
      expect(yield* restarted.get(changedEndpoint)).toBe("off");
      expect(
        yield* restarted.get({
          ...entry,
          profile: Option.some(
            new BearerConnectionProfile({
              ...BEARER_PROFILE,
              wsBaseUrl: "wss://different.example.test",
            }),
          ),
        }),
      ).toBe("off");
      expect(
        yield* restarted.get({ target: RELAY_TARGET, profile: Option.none(), enabled: true }),
      ).toBe("off");
      yield* restarted.set(entry, "read-write");
      expect(yield* restarted.get(entry)).toBe("read-write");
      yield* restarted.forget(ENVIRONMENT_ID);
      expect(yield* restarted.get(entry)).toBe("off");
      const afterRemoval = yield* makeGitHubRoutingPermissions(storage);
      expect(yield* afterRemoval.get(entry)).toBe("off");

      yield* permissions.set(entry, "read");
      document = removeConnectionFromCatalog(document, ENVIRONMENT_ID);
      const afterCatalogRemoval = yield* makeGitHubRoutingPermissions(storage);
      expect(yield* afterCatalogRemoval.get(entry)).toBe("off");
    }),
  );

  it.effect("requires explicit trust for primary, relay, and SSH connections independently", () =>
    Effect.gen(function* () {
      const permissions = yield* makeGitHubRoutingPermissions({
        read: Effect.succeed([]),
        write: () => Effect.void,
      });
      const entries = [
        {
          target: new PrimaryConnectionTarget({
            environmentId: ENVIRONMENT_ID,
            label: "Local",
            httpBaseUrl: "http://localhost:3000",
            wsBaseUrl: "ws://localhost:3000",
          }),
          profile: Option.none(),
          enabled: true,
        },
        { target: RELAY_TARGET, profile: Option.none(), enabled: true },
        {
          enabled: true,
          target: new SshConnectionTarget({
            environmentId: ENVIRONMENT_ID,
            label: "SSH",
            connectionId: "ssh-1",
          }),
          profile: Option.some(
            new SshConnectionProfile({
              environmentId: ENVIRONMENT_ID,
              label: "SSH",
              connectionId: "ssh-1",
              target: { alias: "work", hostname: "work.example.test", username: "maria", port: 22 },
            }),
          ),
        },
      ];
      for (const entry of entries) {
        expect(yield* permissions.get(entry)).toBe("off");
        yield* permissions.set(entry, "read");
        expect(yield* permissions.get(entry)).toBe("read");
        yield* permissions.set(entry, "off");
        expect(yield* permissions.get(entry)).toBe("off");
      }
    }),
  );

  it.effect("does not enable GitHub routing when permission persistence fails", () =>
    Effect.gen(function* () {
      const entry = { target: BEARER_TARGET, profile: Option.some(BEARER_PROFILE), enabled: true };
      expect(yield* (yield* GitHubRoutingPermissions).get(entry)).toBe("off");
      const permissions = yield* makeGitHubRoutingPermissions({
        read: Effect.succeed([]),
        write: () =>
          Effect.fail(
            new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: "storage unavailable",
            }),
          ),
      });
      yield* permissions.set(entry, "read-write").pipe(Effect.flip);
      expect(yield* permissions.get(entry)).toBe("off");
    }),
  );

  it("replaces obsolete connection metadata without discarding a reusable DPoP token", () => {
    const bearer = registerConnectionInCatalog(
      {
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        remoteDpopTokens: [REMOTE_TOKEN],
      },
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const relayTarget = new RelayConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Remote",
    });
    const relay = registerConnectionInCatalog(
      bearer,
      new RelayConnectionRegistration({ target: relayTarget }),
    );

    expect(relay.targets).toEqual([relayTarget]);
    expect(relay.profiles).toEqual([]);
    expect(relay.credentials).toEqual([]);
    expect(relay.remoteDpopTokens).toEqual([REMOTE_TOKEN]);
  });

  it("removes every catalog record owned by an explicit disconnect", () => {
    const registered = registerConnectionInCatalog(
      {
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        remoteDpopTokens: [REMOTE_TOKEN],
      },
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    expect(removeConnectionFromCatalog(registered, ENVIRONMENT_ID)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("stores a DPoP token for a registered relay environment", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new RelayConnectionRegistration({ target: RELAY_TARGET }),
    );

    expect(putRemoteDpopTokenInCatalog(registered, REMOTE_TOKEN)).toEqual({
      ...registered,
      remoteDpopTokens: [REMOTE_TOKEN],
    });
  });

  it("ignores a late DPoP token after the environment is removed", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new RelayConnectionRegistration({ target: RELAY_TARGET }),
    );
    const removed = removeConnectionFromCatalog(registered, ENVIRONMENT_ID);

    expect(putRemoteDpopTokenInCatalog(removed, REMOTE_TOKEN)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("does not store DPoP tokens for a different environment or connection kind", () => {
    const bearer = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const otherRelay = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new RelayConnectionRegistration({
        target: new RelayConnectionTarget({
          environmentId: EnvironmentId.make("environment-2"),
          label: "Other relay",
        }),
      }),
    );

    expect(putRemoteDpopTokenInCatalog(bearer, REMOTE_TOKEN)).toBe(bearer);
    expect(putRemoteDpopTokenInCatalog(otherRelay, REMOTE_TOKEN)).toBe(otherRelay);
  });

  it("decodes a document written before the disabled list existed", () => {
    const decoded = decodeCatalogDocument({
      schemaVersion: 1,
      targets: [],
      profiles: [],
      credentials: [],
      remoteDpopTokens: [],
    });

    expect(decoded.disabledEnvironmentIds).toEqual([]);
  });

  it("switches a saved environment off and back on without touching its records", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    const disabled = setConnectionEnabledInCatalog(registered, ENVIRONMENT_ID, false);
    expect(disabled.disabledEnvironmentIds).toEqual([ENVIRONMENT_ID]);
    expect(disabled.targets).toEqual(registered.targets);
    expect(disabled.credentials).toEqual(registered.credentials);
    expect(
      setConnectionEnabledInCatalog(disabled, ENVIRONMENT_ID, false).disabledEnvironmentIds,
    ).toEqual([ENVIRONMENT_ID]);

    expect(
      setConnectionEnabledInCatalog(disabled, ENVIRONMENT_ID, true).disabledEnvironmentIds,
    ).toEqual([]);
    expect(
      registerConnectionInCatalog(
        disabled,
        new BearerConnectionRegistration({
          target: BEARER_TARGET,
          profile: BEARER_PROFILE,
          credential: BEARER_CREDENTIAL,
        }),
      ).disabledEnvironmentIds,
    ).toEqual([ENVIRONMENT_ID]);
    expect(removeConnectionFromCatalog(disabled, ENVIRONMENT_ID).disabledEnvironmentIds).toEqual(
      [],
    );
  });

  it("persists the normalized SSH profile and its paired token beside its target", () => {
    const target = new SshConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "SSH",
      connectionId: "ssh-1",
    });
    const profile = new SshConnectionProfile({
      connectionId: target.connectionId,
      environmentId: target.environmentId,
      label: target.label,
      target: {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      },
    });
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new SshConnectionRegistration({ target, profile, credential: BEARER_CREDENTIAL }),
    );

    expect(document.targets).toEqual([target]);
    expect(document.profiles).toEqual([profile]);
    expect(document.credentials).toEqual([
      { connectionId: target.connectionId, credential: BEARER_CREDENTIAL },
    ]);
    // Removing the route forgets its token too.
    expect(removeConnectionFromCatalog(document, ENVIRONMENT_ID).credentials).toEqual([]);
  });

  it("loads a catalog that a release without cloud sandboxes wrote", () => {
    // The stored JSON as an earlier release encodes it: no sandbox kinds.
    const stored = JSON.stringify({
      schemaVersion: 1,
      targets: [
        { _tag: "RelayConnectionTarget", environmentId: "environment-relay", label: "Relay" },
        {
          _tag: "BearerConnectionTarget",
          environmentId: "environment-1",
          label: "Desk",
          connectionId: "bearer:environment-1:https://desk.example.test",
        },
        {
          _tag: "BearerConnectionTarget",
          environmentId: "environment-1",
          label: "Desk",
          connectionId: "learned:environment-1:http://100.101.102.103:3773",
        },
        {
          _tag: "SshConnectionTarget",
          environmentId: "environment-ssh",
          label: "Devbox",
          connectionId: "ssh:environment-ssh:devbox",
        },
      ],
      profiles: [
        {
          _tag: "BearerConnectionProfile",
          connectionId: "bearer:environment-1:https://desk.example.test",
          environmentId: "environment-1",
          label: "Desk",
          httpBaseUrl: "https://desk.example.test",
          wsBaseUrl: "wss://desk.example.test",
        },
        {
          _tag: "BearerConnectionProfile",
          connectionId: "learned:environment-1:http://100.101.102.103:3773",
          environmentId: "environment-1",
          label: "Desk",
          httpBaseUrl: "http://100.101.102.103:3773",
          wsBaseUrl: "ws://100.101.102.103:3773",
          learned: true,
          network: "tailscale",
        },
        {
          _tag: "SshConnectionProfile",
          connectionId: "ssh:environment-ssh:devbox",
          environmentId: "environment-ssh",
          label: "Devbox",
          target: { alias: "devbox", hostname: "devbox.example.test", username: null, port: null },
        },
      ],
      credentials: [
        {
          connectionId: "bearer:environment-1:https://desk.example.test",
          credential: { _tag: "BearerConnectionCredential", token: "bearer-token" },
        },
      ],
      remoteDpopTokens: [],
      githubRoutingPermissions: [
        { environmentId: "environment-ssh", connectionKey: "key", permission: "read" },
      ],
      disabledEnvironmentIds: ["environment-ssh"],
    });

    const document = decodeStoredCatalogDocument(stored);

    expect(document.targets.map((target) => target._tag)).toEqual([
      "RelayConnectionTarget",
      "BearerConnectionTarget",
      "BearerConnectionTarget",
      "SshConnectionTarget",
    ]);
    expect(document.profiles.map((profile) => profile._tag)).toEqual([
      "BearerConnectionProfile",
      "BearerConnectionProfile",
      "SshConnectionProfile",
    ]);
    expect(document.profiles[1]).toBeInstanceOf(BearerConnectionProfile);
    expect(document.profiles[2]).toBeInstanceOf(SshConnectionProfile);
    expect(document.credentials).toHaveLength(1);
    expect(document.disabledEnvironmentIds).toEqual(["environment-ssh"]);
  });

  it("persists a cloud sandbox's profile and session token, and drops both on removal", () => {
    const target = new SandboxConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Agent box",
      connectionId: "sandbox:environment-1:boat:box-1",
    });
    const profile = new SandboxConnectionProfile({
      connectionId: target.connectionId,
      environmentId: target.environmentId,
      label: target.label,
      target: {
        providerId: "boat",
        label: "Agent box",
        size: "large",
        region: "eu",
        idleTimeoutMinutes: 0,
        installAgentClis: false,
        forwardGithubToken: true,
      },
      sandbox: { providerId: "boat", sandboxId: "box-1" },
      providerUrl: "https://box-1.boat.example.test",
    });
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new SandboxConnectionRegistration({ target, profile }),
    );

    expect(document.targets).toEqual([target]);
    expect(document.profiles).toEqual([profile]);
    // Every connect pairs afresh through the desktop, so no bearer is kept.
    expect(document.credentials).toEqual([]);
    const schema = Schema.fromJsonString(ConnectionCatalogDocument);
    expect(Schema.decodeSync(schema)(Schema.encodeSync(schema)(document))).toEqual(document);
    expect(removeConnectionFromCatalog(document, ENVIRONMENT_ID)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("keeps every route of an environment and drops only a removed route's records", () => {
    const withBearer = registerConnectionInCatalog(
      { ...EMPTY_CONNECTION_CATALOG_DOCUMENT, remoteDpopTokens: [REMOTE_TOKEN] },
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const withRelay = registerConnectionInCatalog(
      withBearer,
      new RelayConnectionRegistration({ target: RELAY_TARGET }),
      [BEARER_TARGET, RELAY_TARGET],
    );
    expect(catalogRoutes(withRelay, ENVIRONMENT_ID)).toEqual([BEARER_TARGET, RELAY_TARGET]);
    expect(withRelay.credentials).toHaveLength(1);

    const relayOnly = setRoutesInCatalog(withRelay, ENVIRONMENT_ID, [RELAY_TARGET]);
    expect(relayOnly.targets).toEqual([RELAY_TARGET]);
    expect(relayOnly.profiles).toEqual([]);
    expect(relayOnly.credentials).toEqual([]);
    expect(relayOnly.remoteDpopTokens).toEqual([REMOTE_TOKEN]);

    const bearerOnly = setRoutesInCatalog(withRelay, ENVIRONMENT_ID, [BEARER_TARGET]);
    expect(bearerOnly.credentials).toHaveLength(1);
    expect(bearerOnly.remoteDpopTokens).toEqual([]);
  });

  it("keeps an environment's position in the catalog when its routes change", () => {
    const other = new RelayConnectionTarget({
      environmentId: EnvironmentId.make("environment-2"),
      label: "Other",
    });
    const document = {
      ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
      targets: [RELAY_TARGET, other],
    };
    expect(
      setRoutesInCatalog(document, ENVIRONMENT_ID, [BEARER_TARGET, RELAY_TARGET]).targets,
    ).toEqual([BEARER_TARGET, RELAY_TARGET, other]);
  });
});
