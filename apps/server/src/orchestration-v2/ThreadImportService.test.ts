import { expect, it } from "@effect/vitest";
import {
  EventId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2TurnItem,
  ProjectId,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadImportService from "./ThreadImportService.ts";

const now = DateTime.makeUnsafe("2026-10-20T00:00:00.000Z");
const homeProjectId = ProjectId.make("home-project");
const remoteUrl = "https://github.com/acme/app.git";

const vmThread = Schema.decodeUnknownSync(OrchestrationV2AppThread)({
  id: "vm-thread",
  projectId: "vm-project",
  title: "Fix the login",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: "vm-thread", parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
  archivedAt: now,
  settledOverride: "settled",
  settledAt: now,
  lastVisitedAt: null,
  deletedAt: null,
});
const common = {
  threadId: "vm-thread",
  runId: "vm-run",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  status: "completed",
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
};
const vmItems = Schema.decodeUnknownSync(Schema.Array(OrchestrationV2TurnItem))([
  {
    ...common,
    id: "item-user",
    ordinal: 1,
    type: "user_message",
    createdBy: "user",
    creationSource: "web",
    messageId: "message-user",
    inputIntent: "turn_start",
    text: "Fix the login",
    attachments: [],
  },
  {
    ...common,
    id: "item-command",
    ordinal: 2,
    type: "command_execution",
    input: "bun test",
    output: "1 failed",
  },
  {
    ...common,
    id: "item-checkpoint",
    ordinal: 3,
    type: "checkpoint",
    checkpointId: "checkpoint-1",
    scopeId: "scope-1",
    files: [],
  },
  {
    ...common,
    id: "item-assistant",
    ordinal: 4,
    type: "assistant_message",
    messageId: "message-assistant",
    text: "Fixed it.",
    streaming: false,
  },
]);
const vmMessages = Schema.decodeUnknownSync(Schema.Array(OrchestrationV2ConversationMessage))(
  [
    ["message-user", "user", "Fix the login"],
    ["message-assistant", "assistant", "Fixed it."],
  ].map(([id, role, text]) => ({
    id,
    threadId: "vm-thread",
    runId: "vm-run",
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: false,
    createdBy: role === "user" ? "user" : "agent",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
  })),
);

it.effect("copies a thread's conversation and activity into the matching project, once", () =>
  Effect.gen(function* () {
    const runtime = ProviderReplayHarness.layerWithRegistry(
      { name: "thread-import" },
      ProviderAdapterRegistry.layerFromAdapters([]),
      { runEffectWorker: false },
    );
    const home: Pick<OrchestrationProjectShell, "id" | "repositoryIdentity"> = {
      id: homeProjectId,
      repositoryIdentity: {
        canonicalKey: "github.com/acme/app",
        locator: { source: "git-remote", remoteName: "origin", remoteUrl },
      } as never,
    };
    const services = yield* Layer.build(
      Layer.mergeAll(
        runtime,
        ThreadImportService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              runtime,
              Layer.mock(ProjectService.ProjectService)({
                listShells: () => Effect.succeed([home as OrchestrationProjectShell]),
              }),
            ),
          ),
        ),
      ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    );
    const orchestrator = Context.get(services, Orchestrator.OrchestratorV2);
    const importer = Context.get(services, ThreadImportService.ThreadImportService);
    yield* Context.get(services, EventSinkV2).write({
      events: [
        {
          id: EventId.make("vm-created"),
          type: "thread.created",
          threadId: vmThread.id,
          occurredAt: now,
          payload: vmThread,
        },
        ...vmMessages.map((message) => ({
          id: EventId.make(`vm-${message.id}`),
          type: "message.updated" as const,
          threadId: vmThread.id,
          occurredAt: now,
          payload: message,
        })),
        ...vmItems.map((item) => ({
          id: EventId.make(`vm-${item.id}`),
          type: "turn-item.updated" as const,
          threadId: vmThread.id,
          occurredAt: now,
          payload: item,
        })),
      ],
    });
    const source = yield* orchestrator.getThreadSnapshot(vmThread.id);
    // The VM's own thread stands in for the snapshot a boat VM would send.
    const snapshot = {
      snapshotSequence: source.snapshotSequence,
      projection: {
        ...source.projection,
        visibleTurnItems: vmItems.map((item, position) => ({
          visibility: "local" as const,
          sourceThreadId: vmThread.id,
          sourceItemId: item.id,
          position,
          item,
        })),
      },
    };
    const input = {
      originKey: "boat-vm:bx_1:vm-thread",
      repositoryRemoteUrl: "git@github.com:acme/app.git",
      snapshot,
    };

    const first = yield* importer.importThread(input);
    const again = yield* importer.importThread(input);

    expect(first).toEqual({
      threadId: "import:boat-vm:bx_1:vm-thread",
      projectId: homeProjectId,
      created: true,
    });
    expect(again).toEqual({ ...first, created: false });
    const copy = yield* orchestrator.getThreadSnapshot(first.threadId);
    expect(copy.projection.thread).toMatchObject({
      projectId: homeProjectId,
      title: "Fix the login",
      historyOrigin: "v1_import",
      archivedAt: now,
    });
    expect(copy.projection.visibleTurnItems.map((row) => [row.item.type, row.item.runId])).toEqual([
      ["user_message", null],
      ["command_execution", null],
      ["assistant_message", null],
    ]);
    expect(copy.projection.messages.map((message) => message.text)).toEqual([
      "Fix the login",
      "Fixed it.",
    ]);
  }),
);

it.effect("refuses a thread whose repository has no project here", () =>
  Effect.gen(function* () {
    const importer = yield* ThreadImportService.ThreadImportService;
    const error = yield* Effect.flip(
      importer.importThread({
        originKey: "boat-vm:bx_1:vm-thread",
        repositoryRemoteUrl: remoteUrl,
        snapshot: { snapshotSequence: 0, projection: {} as never },
      }),
    );
    expect(error._tag).toBe("ThreadImportProjectNotFoundError");
  }).pipe(
    Effect.provide(
      ThreadImportService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectService.ProjectService)({ listShells: () => Effect.succeed([]) }),
            Layer.mock(Orchestrator.OrchestratorV2)({}),
            Layer.mock(EventSinkV2)({}),
          ),
        ),
      ),
    ),
  ),
);
