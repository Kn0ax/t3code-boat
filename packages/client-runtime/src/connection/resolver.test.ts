import {
  AuthStandardClientScopes,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type DesktopSandboxEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ConnectionResolver from "./resolver.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  SandboxConnectionProfile,
  SshConnectionProfile,
  type ConnectionCredential,
  type ConnectionProfile,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  SandboxConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
} from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as RpcHttp from "../rpc/http.ts";
import {
  GitHubRoutingPermissions,
  gitHubRoutingConnectionKey,
  makeGitHubRoutingPermissions,
} from "./githubRoutingPermissions.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const ENDPOINT = {
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
};
const SSH_TARGET: DesktopSshEnvironmentTarget = {
  alias: "development",
  hostname: "development.example.test",
  username: "developer",
  port: 22,
};

const SANDBOX_BOOTSTRAP: DesktopSandboxEnvironmentBootstrap = {
  target: {
    providerId: "boat",
    label: "Sandbox",
    size: "small",
    idleTimeoutMinutes: 30,
    installAgentClis: false,
    forwardGithubToken: false,
  },
  sandbox: { providerId: "boat", sandboxId: "sandboxes/sbx-1" },
  httpBaseUrl: "http://127.0.0.1:4100/",
  wsBaseUrl: "ws://127.0.0.1:4100/",
  providerUrl: "https://3773-sbx-1.sandboxes.example.test",
  pairingToken: "sandbox-pairing-token",
};
const SANDBOX_TARGET = new SandboxConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Sandbox",
  connectionId: "sandbox-1",
});
const SANDBOX_PROFILE = new SandboxConnectionProfile({
  connectionId: "sandbox-1",
  environmentId: ENVIRONMENT_ID,
  label: "Sandbox",
  target: SANDBOX_BOOTSTRAP.target,
  sandbox: SANDBOX_BOOTSTRAP.sandbox,
  providerUrl: "https://3773-old.sandboxes.example.test",
});

function sandboxGateway(options: {
  readonly prepared: Array<string>;
  readonly bootstrap?: DesktopSandboxEnvironmentBootstrap;
}): ClientCapabilities.SandboxEnvironmentGateway["Service"] {
  return ClientCapabilities.SandboxEnvironmentGateway.of({
    provision: () => Effect.die("unused"),
    prepare: (input) =>
      Effect.sync(() => {
        options.prepared.push(input.sandbox.sandboxId);
        return options.bootstrap ?? SANDBOX_BOOTSTRAP;
      }),
    resume: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    destroy: () => Effect.die("unused"),
  });
}

/** Answers the descriptor anywhere and redeems pairing tokens for "sandbox-bearer". */
function sandboxFetch(urls: Array<string>): typeof fetch {
  return ((input) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/oauth/token")) {
      return Promise.resolve(
        Response.json({
          access_token: "sandbox-bearer",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: AuthStandardClientScopes.join(" "),
        }),
      );
    }
    return Promise.resolve(
      Response.json({
        environmentId: ENVIRONMENT_ID,
        label: "Sandbox environment",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
        capabilities: { repositoryIdentity: true },
      }),
    );
  }) satisfies typeof fetch;
}

function catalogEntry(
  target: ConnectionTarget,
  profile: Option.Option<ConnectionProfile> = Option.none(),
): ConnectionCatalogEntry {
  return { target, profile, enabled: true };
}

const makeDependencies = Effect.fn("TestConnectionResolver.makeDependencies")((options?: {
  readonly profiles?: ReadonlyArray<ConnectionProfile>;
  readonly profileStore?: ConnectionProfileStore.ConnectionProfileStore["Service"];
  readonly credentials?: ReadonlyArray<readonly [string, ConnectionCredential]>;
  readonly authorizeBearer?: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeBearer"];
  readonly authorizeDpop?: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeDpop"];
  readonly primaryBearerToken?: string;
  readonly prepareSsh?: ClientCapabilities.SshEnvironmentGateway["Service"]["prepare"];
  readonly descriptorProtocolVersion?: number | null | undefined;
  readonly sandboxGateway?: ClientCapabilities.SandboxEnvironmentGateway["Service"];
  readonly fetch?: typeof fetch;
}) => {
  const profiles = new Map(
    (options?.profiles ?? []).map((profile) => [profile.connectionId, profile]),
  );
  const credentials = new Map(options?.credentials ?? []);

  const profileStore = ConnectionProfileStore.ConnectionProfileStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(profiles.get(connectionId))),
    put: (profile) => Effect.sync(() => void profiles.set(profile.connectionId, profile)),
    remove: (connectionId) => Effect.sync(() => void profiles.delete(connectionId)),
  });
  const credentialStore = ConnectionCredentialStore.ConnectionCredentialStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(credentials.get(connectionId))),
    put: (connectionId, credential) =>
      Effect.sync(() => void credentials.set(connectionId, credential)),
    remove: (connectionId) => Effect.sync(() => void credentials.delete(connectionId)),
  });
  const remote = RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
    authorizeBearer:
      options?.authorizeBearer ??
      ((input) =>
        Effect.succeed({
          environmentId: input.expectedEnvironmentId,
          label: "Authorized bearer environment",
          httpBaseUrl: input.httpBaseUrl,
          socketUrl: "wss://authorized.example.test/ws?wsTicket=bearer",
          httpAuthorization: {
            _tag: "Bearer" as const,
            token: input.bearerToken,
          },
        })),
    authorizeDpop:
      options?.authorizeDpop ??
      ((input) =>
        Effect.succeed({
          environmentId: input.expectedEnvironmentId,
          label: "Authorized relay environment",
          httpBaseUrl: ENDPOINT.httpBaseUrl,
          socketUrl: "wss://authorized.example.test/ws?wsTicket=dpop",
          httpAuthorization: {
            _tag: "Dpop" as const,
            accessToken: "dpop-access-token",
            expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
          },
        })),
    authorizeDpopHttp: () => Effect.die("unused"),
  });
  const ssh = ClientCapabilities.SshEnvironmentGateway.of({
    provision: () => Effect.die("unused"),
    prepare:
      options?.prepareSsh ??
      (() =>
        Effect.succeed({
          bootstrap: {
            target: SSH_TARGET,
            httpBaseUrl: "http://127.0.0.1:4010",
            wsBaseUrl: "ws://127.0.0.1:4010",
            pairingToken: null,
          },
          bearerToken: "ssh-bearer",
        })),
    disconnect: () => Effect.void,
  });

  const layerDependencies = Layer.mergeAll(
    RpcHttp.layerRemoteHttpClient(
      options?.fetch ??
        ((() =>
          Promise.resolve(
            Response.json({
              environmentId: ENVIRONMENT_ID,
              label: "Compatible environment",
              platform: { os: "linux", arch: "x64" },
              serverVersion: "0.0.0-test",
              ...(options?.descriptorProtocolVersion === undefined
                ? { orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION }
                : options.descriptorProtocolVersion === null
                  ? {}
                  : { orchestrationProtocolVersion: options.descriptorProtocolVersion }),
              capabilities: { repositoryIdentity: true },
            }),
          )) satisfies typeof fetch),
    ),
    Layer.succeed(
      ConnectionProfileStore.ConnectionProfileStore,
      options?.profileStore ?? profileStore,
    ),
    Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, credentialStore),
    Layer.succeed(
      ClientCapabilities.PrimaryEnvironmentAuth,
      ClientCapabilities.PrimaryEnvironmentAuth.of({
        bearerToken: Effect.succeed(Option.fromNullishOr(options?.primaryBearerToken)),
      }),
    ),
    Layer.succeed(
      ClientCapabilities.ClientPresentation,
      ClientCapabilities.ClientPresentation.of({
        metadata: { label: "Test Client", deviceType: "desktop", surface: "web" },
      }),
    ),
    Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, remote),
    Layer.succeed(ClientCapabilities.SshEnvironmentGateway, ssh),
    options?.sandboxGateway === undefined
      ? Layer.empty
      : Layer.succeed(ClientCapabilities.SandboxEnvironmentGateway, options.sandboxGateway),
  );

  return Effect.succeed(ConnectionResolver.layer.pipe(Layer.provide(layerDependencies)));
});

describe("ConnectionResolver", () => {
  it.effect("blocks an old host during discovery before opening orchestration RPC", () =>
    Effect.gen(function* () {
      const layerBroker = yield* makeDependencies({ descriptorProtocolVersion: null });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });

      const error = yield* Effect.flip(broker.prepare(catalogEntry(target)));

      expect(error).toMatchObject({ reason: "unsupported" });
      expect(error.message).toContain("Update T3 Code on Compatible environment");
    }),
  );

  it.effect("prepares a primary environment without remote capabilities", () =>
    Effect.gen(function* () {
      const layerBroker = yield* makeDependencies();
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });

      expect(yield* broker.prepare(catalogEntry(target))).toEqual({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        socketUrl:
          "ws://127.0.0.1:3777/ws?clientSurface=web&clientDeviceType=desktop&connectionMethod=direct&orchestrationProtocol=2",
        httpAuthorization: null,
        target,
      });
    }),
  );

  it.effect("offers the saved SSH token on each connect and saves the one it gets back", () =>
    Effect.gen(function* () {
      const offeredTokens = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
      const target = new SshConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        connectionId: "ssh-1",
      });
      const profile = new SshConnectionProfile({
        connectionId: "ssh-1",
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        target: SSH_TARGET,
      });
      const layerBroker = yield* makeDependencies({
        credentials: [["ssh-1", new BearerConnectionCredential({ token: "revoked-token" })]],
        // The host accepts only the token it paired last; anything else pairs again.
        prepareSsh: (input) =>
          Ref.update(offeredTokens, (tokens) => [...tokens, input.bearerToken]).pipe(
            Effect.as({
              bootstrap: {
                target: input.target,
                httpBaseUrl: "http://127.0.0.1:4010",
                wsBaseUrl: "ws://127.0.0.1:4010",
                pairingToken: null,
              },
              bearerToken: "paired-token",
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const entry = catalogEntry(target, Option.some(profile));

      const first = yield* broker.prepare(entry);
      const second = yield* broker.prepare(entry);

      expect(yield* Ref.get(offeredTokens)).toEqual(["revoked-token", "paired-token"]);
      expect(first.httpAuthorization).toMatchObject({ token: "paired-token" });
      expect(second.httpAuthorization).toMatchObject({ token: "paired-token" });
    }),
  );

  it.effect.each(["unchanged", "changed", "revocation-failed"] as const)(
    "handles %s SSH routing consent before saving or authorizing",
    (scenario) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const target = new SshConnectionTarget({
          environmentId: ENVIRONMENT_ID,
          label: "SSH",
          connectionId: "ssh-1",
        });
        const profile = new SshConnectionProfile({
          connectionId: target.connectionId,
          environmentId: ENVIRONMENT_ID,
          label: "SSH",
          target: SSH_TARGET,
        });
        const entry = catalogEntry(target, Option.some(profile));
        const preparedTarget =
          scenario === "unchanged"
            ? SSH_TARGET
            : { ...SSH_TARGET, hostname: "replacement.example.test" };
        const failure = new ConnectionTransientError({
          reason: "remote-unavailable",
          detail: "Could not persist routing consent.",
        });
        const permissions = yield* makeGitHubRoutingPermissions({
          read: Effect.succeed([
            {
              environmentId: ENVIRONMENT_ID,
              connectionKey: gitHubRoutingConnectionKey(entry)!,
              permission: "read-write",
            },
          ]),
          write: () =>
            Effect.sync(() => {
              calls.push("revoke");
            }).pipe(
              Effect.andThen(scenario === "revocation-failed" ? Effect.fail(failure) : Effect.void),
            ),
        });
        let savedProfile: ConnectionProfile = profile;
        const layerBroker = yield* makeDependencies({
          profileStore: {
            get: () => Effect.sync(() => Option.some(savedProfile)),
            put: (value) =>
              Effect.sync(() => {
                calls.push("profile");
                savedProfile = value;
              }),
            remove: () => Effect.die("unused"),
          },
          prepareSsh: () =>
            Effect.succeed({
              bootstrap: {
                target: preparedTarget,
                httpBaseUrl: "http://127.0.0.1:4010",
                wsBaseUrl: "ws://127.0.0.1:4010",
                pairingToken: null,
              },
              bearerToken: "ssh-bearer",
            }),
          authorizeBearer: (input) =>
            Effect.sync(() => {
              calls.push("authorize");
              return {
                environmentId: input.expectedEnvironmentId,
                label: "SSH",
                httpBaseUrl: input.httpBaseUrl,
                socketUrl: "ws://127.0.0.1:4010/ws?wsTicket=ssh",
                httpAuthorization: { _tag: "Bearer" as const, token: input.bearerToken },
              };
            }),
        });
        const broker = yield* ConnectionResolver.ConnectionResolver.pipe(
          Effect.provide(layerBroker),
        );
        const prepare = broker
          .prepare(entry)
          .pipe(Effect.provideService(GitHubRoutingPermissions, permissions));
        if (scenario === "revocation-failed") {
          expect(yield* Effect.flip(prepare)).toBe(failure);
          expect(savedProfile).toBe(profile);
          expect(calls).toEqual(["revoke"]);
        } else {
          expect((yield* prepare).socketUrl).toContain("wsTicket=ssh");
          expect(savedProfile).toMatchObject({ target: preparedTarget });
          expect(calls).toEqual(
            scenario === "unchanged"
              ? ["profile", "authorize"]
              : ["revoke", "profile", "authorize"],
          );
        }
        expect(yield* permissions.get(entry)).toBe(scenario === "changed" ? "off" : "read-write");
      }),
  );

  it.effect("pairs a sandbox through the desktop's forward on every connect", () =>
    Effect.gen(function* () {
      const prepared: Array<string> = [];
      const urls: Array<string> = [];
      const tokens: Array<string> = [];
      let savedProfile: ConnectionProfile = SANDBOX_PROFILE;
      const layerBroker = yield* makeDependencies({
        // A bearer from an earlier pairing is not tried: the forward it was
        // redeemed through may be gone, and its port taken by another process.
        credentials: [["sandbox-1", new BearerConnectionCredential({ token: "saved-bearer" })]],
        profileStore: {
          get: () => Effect.sync(() => Option.some(savedProfile)),
          put: (value) =>
            Effect.sync(() => {
              savedProfile = value;
            }),
          remove: () => Effect.die("unused"),
        },
        sandboxGateway: sandboxGateway({ prepared }),
        fetch: sandboxFetch(urls),
        authorizeBearer: (input) =>
          Effect.sync(() => {
            tokens.push(`${input.bearerToken}@${input.httpBaseUrl}`);
            return {
              environmentId: input.expectedEnvironmentId,
              label: "Sandbox",
              httpBaseUrl: input.httpBaseUrl,
              socketUrl: "ws://127.0.0.1:4100/ws?wsTicket=fresh",
              httpAuthorization: { _tag: "Bearer" as const, token: input.bearerToken },
            };
          }),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));

      const result = yield* broker.prepare(
        catalogEntry(SANDBOX_TARGET, Option.some(SANDBOX_PROFILE)),
      );

      expect(result.socketUrl).toContain("wsTicket=fresh");
      expect(result.target).toBe(SANDBOX_TARGET);
      expect(prepared).toEqual(["sandboxes/sbx-1"]);
      expect(urls.some((url) => url.startsWith("http://127.0.0.1:4100/"))).toBe(true);
      expect(urls.every((url) => url.startsWith("http://127.0.0.1:4100/"))).toBe(true);
      expect(tokens).toEqual(["sandbox-bearer@http://127.0.0.1:4100/"]);
      expect(savedProfile).toMatchObject({
        _tag: "SandboxConnectionProfile",
        providerUrl: SANDBOX_BOOTSTRAP.providerUrl,
        sandbox: SANDBOX_BOOTSTRAP.sandbox,
      });
    }),
  );

  it.effect("blocks a sandbox route when the platform cannot manage sandboxes", () =>
    Effect.gen(function* () {
      const layerBroker = yield* makeDependencies();
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));

      const error = yield* Effect.flip(
        broker.prepare(catalogEntry(SANDBOX_TARGET, Option.some(SANDBOX_PROFILE))),
      );

      expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "unsupported" });
    }),
  );
});

describe("Boat relay credentials", () => {
  it.effect(
    "restores the relay token from the credential store for HTTP and WebSocket authorization",
    () =>
      Effect.gen(function* () {
        const profile = new BearerConnectionProfile({
          connectionId: "boat-route",
          environmentId: ENVIRONMENT_ID,
          label: "Boat",
          httpBaseUrl: "https://host.example.test/api/boat-proxy/bx_test/",
          wsBaseUrl: "wss://host.example.test/api/boat-proxy/bx_test/",
          boatProxy: { sandboxId: "bx_test", tailnetHttpBaseUrl: "http://vm.tail.ts.net" },
        });
        const observed: Array<{ http: string; ws: string }> = [];
        const layerBroker = yield* makeDependencies({
          credentials: [
            [
              "boat-route",
              new BearerConnectionCredential({ token: "session-token", proxyToken: "relay-token" }),
            ],
          ],
          authorizeBearer: (input) => {
            observed.push({ http: input.httpBaseUrl, ws: input.wsBaseUrl });
            return Effect.succeed({
              environmentId: ENVIRONMENT_ID,
              label: "Boat",
              httpBaseUrl: input.httpBaseUrl,
              socketUrl: "wss://host.example.test/ws",
              httpAuthorization: { _tag: "Bearer", token: input.bearerToken },
            });
          },
        });
        const broker = yield* ConnectionResolver.ConnectionResolver.pipe(
          Effect.provide(layerBroker),
        );
        const prepared = yield* broker.prepare(
          catalogEntry(
            new BearerConnectionTarget({
              connectionId: "boat-route",
              environmentId: ENVIRONMENT_ID,
              label: "Boat",
            }),
            Option.some(profile),
          ),
        );
        expect(observed).toEqual([
          {
            http: profile.httpBaseUrl + "?boatProxyToken=relay-token",
            ws: profile.wsBaseUrl + "?boatProxyToken=relay-token",
          },
        ]);
        expect(prepared.httpBaseUrl).toBe(profile.httpBaseUrl + "?boatProxyToken=relay-token");
        expect(prepared.directHttpBaseUrl).toBe("http://vm.tail.ts.net");
        expect(profile.httpBaseUrl).not.toContain("relay-token");
      }),
  );

  it.effect("rejects a Boat route when its credential is unavailable", () =>
    Effect.gen(function* () {
      const profile = new BearerConnectionProfile({
        connectionId: "boat-route",
        environmentId: ENVIRONMENT_ID,
        label: "Boat",
        httpBaseUrl: "https://host.example.test/api/boat-proxy/bx_test/",
        wsBaseUrl: "wss://host.example.test/api/boat-proxy/bx_test/",
        boatProxy: { sandboxId: "bx_test" },
      });
      const layerBroker = yield* makeDependencies({
        credentials: [["boat-route", new BearerConnectionCredential({ token: "session-token" })]],
        authorizeBearer: () => Effect.die("Must not send a request without the relay credential"),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const error = yield* broker
        .prepare(
          catalogEntry(
            new BearerConnectionTarget({
              connectionId: "boat-route",
              environmentId: ENVIRONMENT_ID,
              label: "Boat",
            }),
            Option.some(profile),
          ),
        )
        .pipe(Effect.flip);
      expect(error).toMatchObject({ reason: "authentication" });
    }),
  );
});
