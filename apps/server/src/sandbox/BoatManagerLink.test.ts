// @effect-diagnostics nodeBuiltinImport:off - a plain local server stands in for the boat manager's T3.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  BoatVmListResult,
  BoatVmSaveSnapshotInput,
  BoatVmSnapshotState,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as SandboxHandlers from "../mcp/toolkits/sandbox/handlers.ts";
import { SandboxToolkit } from "../mcp/toolkits/sandbox/tools.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Settings from "../serverSettings.ts";
import * as BoatManagerLink from "./BoatManagerLink.ts";
import * as BoatVmService from "./BoatVmService.ts";
import * as SandboxJobService from "./SandboxJobService.ts";

const MANAGER_TOKEN = "manager-session";
const NoInput = Schema.Struct({});

interface FakeManager {
  origin: string;
  readonly signIns: Array<{ readonly clientName: unknown; readonly decision: unknown }>;
  readonly calls: Array<{ readonly name: string; readonly arguments: unknown }>;
  /** Set to make /mcp refuse the session, as an expired or revoked one is. */
  revoked: boolean;
}

/** The manager's T3: MCP sign-in with a pairing code, then its boat VM tools over /mcp. */
const startFakeManager = Effect.acquireRelease(
  Effect.callback<{ readonly server: NodeHttp.Server; readonly manager: FakeManager }>((resume) => {
    const manager: FakeManager = { origin: "", signIns: [], calls: [], revoked: false };
    let clientName: unknown;
    const server = NodeHttp.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const json = (status: number, value: unknown, headers = {}) => {
          response.writeHead(status, { "content-type": "application/json", ...headers });
          response.end(JSON.stringify(value));
        };
        switch (request.url) {
          case "/.well-known/oauth-protected-resource/mcp":
            return json(200, {
              resource: `${manager.origin}/mcp`,
              authorization_servers: [manager.origin],
              scopes_supported: [],
              bearer_methods_supported: ["header"],
              resource_name: "T3 Code",
            });
          case "/oauth/mcp/register":
            clientName = JSON.parse(body).client_name;
            return json(201, {
              client_id: "client",
              client_name: clientName,
              redirect_uris: JSON.parse(body).redirect_uris,
              grant_types: ["authorization_code"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            });
          case "/oauth/mcp/decision": {
            const { decision } = JSON.parse(body);
            manager.signIns.push({ clientName, decision });
            return decision.code === "123456"
              ? json(200, { redirectTo: "http://127.0.0.1/callback?code=granted" })
              : json(400, { _tag: "AuthMcpApprovalError", message: "Invalid pairing code." });
          }
          case "/oauth/mcp/token":
            return json(200, {
              access_token: MANAGER_TOKEN,
              token_type: "Bearer",
              expires_in: 30 * 24 * 60 * 60,
              scope: "",
            });
        }
        if (manager.revoked || request.headers.authorization !== `Bearer ${MANAGER_TOKEN}`) {
          return json(401, {});
        }
        // The MCP client ends its session with a bodiless DELETE.
        if (request.method === "DELETE") {
          response.writeHead(204).end();
          return;
        }
        const message = JSON.parse(body);
        if (message.method === "initialize") {
          return json(
            200,
            { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } },
            { "mcp-session-id": "session" },
          );
        }
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const { name, arguments: args } = message.params;
        manager.calls.push({ name, arguments: args });
        const result =
          name === "boat_vm_list"
            ? { structuredContent: { available: true, vms: [] } }
            : name === "boat_vm_thread_launch"
              ? {
                  structuredContent: {
                    sandboxId: "vm1",
                    label: "Acme/app",
                    threadId: "vm-thread",
                    projectId: "vm-project",
                  },
                }
              : {
                  isError: true,
                  structuredContent: {
                    _tag: "OrchestratorMcpFailure",
                    code: "invalid_request",
                    message: "No such VM.",
                  },
                };
        json(200, { jsonrpc: "2.0", id: message.id, result });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      manager.origin = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
      resume(Effect.succeed({ server, manager }));
    });
  }),
  ({ server }) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
).pipe(Effect.map(({ manager }) => manager));

/** Real settings with a real secret store, so the session's storage is what is tested. */
const layerLink = BoatManagerLink.layer.pipe(
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-boat-manager-link-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

/** Spends the pairing code the way a settings save does. */
const link = (
  patch: Parameters<BoatManagerLink.BoatManagerLink["Service"]["prepareSettingsPatch"]>[0],
) =>
  Effect.gen(function* () {
    const boatManagerLink = yield* BoatManagerLink.BoatManagerLink;
    const settings = yield* Settings.ServerSettingsService;
    const prepared = yield* boatManagerLink.prepareSettingsPatch(patch);
    return yield* settings.updateSettings({ sandboxJobs: prepared });
  });

describe("BoatManagerLink", () => {
  it.effect("links with a pairing code, keeps only the session as a secret, and unlinks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* startFakeManager;
        const fileSystem = yield* FileSystem.FileSystem;
        const { settingsPath } = yield* ServerConfig.ServerConfig;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const readToken = secrets
          .get("sandbox-boat-manager-token")
          .pipe(Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))));

        const linked = yield* link({
          boatManager: { url: `${manager.origin}/settings`, pairingCode: " 123456 " },
        });
        assert.deepEqual(manager.signIns, [
          {
            clientName: "T3 Code boat manager link",
            decision: { _tag: "pairing-code", access: "full-access", code: "123456" },
          },
        ]);
        assert.equal(linked.sandboxJobs.boatManager.url, manager.origin);
        assert.equal(linked.sandboxJobs.boatManager.token, MANAGER_TOKEN);
        assert.equal(linked.sandboxJobs.boatManager.expiresAt, "1970-01-31T00:00:00.000Z");
        assert.deepEqual(yield* readToken, Option.some(MANAGER_TOKEN));
        const onDisk = yield* fileSystem.readFileString(settingsPath);
        assert.notInclude(onDisk, MANAGER_TOKEN);
        assert.notInclude(onDisk, "123456");
        const forClient = Settings.redactServerSettingsForClient(linked).sandboxJobs.boatManager;
        assert.notEqual(forClient.token, MANAGER_TOKEN);
        assert.notEqual(forClient.token, "");

        // The session is never handed to another server, and a refused code changes nothing.
        const moved = yield* link({ boatManager: { url: "http://127.0.0.1:1" } }).pipe(Effect.flip);
        assert.equal(moved.operation, "link-boat-manager");
        const refused = yield* link({ boatManager: { pairingCode: "000000" } }).pipe(Effect.flip);
        assert.equal(refused.operation, "link-boat-manager");
        assert.deepEqual(yield* readToken, Option.some(MANAGER_TOKEN));

        const unlinked = yield* link({ boatManager: { url: "" } });
        assert.deepEqual(unlinked.sandboxJobs.boatManager, { url: "", token: "", expiresAt: "" });
        assert.isTrue(Option.isNone(yield* readToken));
      }),
    ).pipe(Effect.provide(layerLink)),
  );

  it.effect("calls the manager's tools only without a boat key, and asks for a relink on 401", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* startFakeManager;
        const boatManagerLink = yield* BoatManagerLink.BoatManagerLink;
        yield* link({ boatManager: { url: manager.origin, pairingCode: "123456" } });

        assert.deepEqual(yield* boatManagerLink.manager, Option.some(manager.origin));
        const listed = yield* boatManagerLink.call({
          tool: "boat_vm_list",
          parameters: NoInput,
          arguments: {},
          result: BoatVmListResult,
        });
        assert.deepEqual(listed, { available: true, vms: [] });

        const toolFailure = yield* boatManagerLink
          .call({
            tool: "boat_vm_save_snapshot",
            parameters: BoatVmSaveSnapshotInput,
            arguments: { sandboxId: "gone", name: "t3-acme-app" },
            result: BoatVmSnapshotState,
          })
          .pipe(Effect.flip);
        assert.deepInclude(toolFailure, { code: "invalid_request", detail: "No such VM." });

        manager.revoked = true;
        const expired = yield* boatManagerLink
          .call({
            tool: "boat_vm_list",
            parameters: NoInput,
            arguments: {},
            result: BoatVmListResult,
          })
          .pipe(Effect.flip);
        assert.include(expired.message, "Pair it again with a new code");

        const settings = yield* Settings.ServerSettingsService;
        yield* settings.updateSettings({ sandboxJobs: { providerKeys: { boat: "own-key" } } });
        assert.isTrue(Option.isNone(yield* boatManagerLink.manager));
      }),
    ).pipe(Effect.provide(layerLink)),
  );

  it.effect("forwards a thread launch with the calling thread's repository, not its project", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* startFakeManager;
        yield* link({ boatManager: { url: manager.origin, pairingCode: "123456" } });
        const toolkit = yield* SandboxToolkit;
        const lastResult = <E, R>(
          handled: Effect.Effect<Stream.Stream<{ readonly result: unknown }, E, R>, E, R>,
        ) =>
          handled.pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.map((results) => results.at(-1)?.result),
          );

        const launched = yield* lastResult(
          toolkit.handle("boat_vm_thread_launch", {
            title: "Fix the build",
            message: "Make the tests pass",
          }),
        );
        assert.deepEqual(launched, {
          sandboxId: "vm1",
          label: "Acme/app",
          threadId: "vm-thread",
          projectId: "vm-project",
        });
        assert.deepEqual(manager.calls, [
          {
            name: "boat_vm_thread_launch",
            arguments: {
              title: "Fix the build",
              message: "Make the tests pass",
              repository: { remoteUrl: "git@github.com:acme/app.git", owner: "acme", name: "app" },
            },
          },
        ]);

        const broughtHome = yield* lastResult(
          toolkit.handle("boat_vm_bring_home", { sandboxId: "vm1" }),
        );
        assert.deepInclude(broughtHome, { code: "invalid_request" });
        assert.equal(manager.calls.length, 1);
      }),
    ).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(SandboxHandlers.layer).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(McpInvocationContext.McpInvocationContext, {
                environmentId: EnvironmentId.make("environment:boat"),
                requestNamespace: "provider:boat",
                thread: {
                  threadId: ThreadId.make("thread:boat"),
                  providerSessionId: "provider:boat",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                },
                client: undefined,
                capabilities: new Set(["orchestration" as const]),
                issuedAt: 0,
              }),
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
              }),
              Layer.mock(BoatVmService.BoatVmService)({
                projectRepository: (projectId) =>
                  projectId === ProjectId.make("project:mcp-test")
                    ? Effect.succeed({
                        remoteUrl: "git@github.com:acme/app.git",
                        owner: "acme",
                        name: "app",
                      })
                    : Effect.die("unexpected project"),
              }),
              Layer.mock(SandboxJobService.SandboxJobService)({}),
              Layer.mock(ProjectService.ProjectService)({}),
            ),
          ),
          Layer.provideMerge(layerLink),
        ),
      ),
    ),
  );
});
