import { expect, it } from "@effect/vitest";
import {
  EventId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
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
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                ensureScratchProject: Effect.succeed({ projectId: ProjectId.make("scratch") }),
                namedProjectsRoot: "/unused",
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

    // The copy reads back in the shape another environment imports.
    const readBack = yield* importer.copySnapshot(input.originKey);
    expect(readBack?.continuedHere).toBe(false);
    expect(readBack?.snapshot.projection.thread.id).toBe(first.threadId);
    expect(yield* importer.copySnapshot("boat-vm:bx_1:other")).toBeNull();

    const scratch = yield* importer.importThread({
      originKey: "boat-vm:bx_2:vm-thread",
      snapshot,
    });
    expect(scratch).toEqual({
      threadId: "import:boat-vm:bx_2:vm-thread",
      projectId: "scratch",
      created: true,
    });
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

const decodeRun = Schema.decodeUnknownSync(OrchestrationV2Run);

/** A run someone started on a copy here. */
const homeRunCreated = (
  threadId: ThreadId,
  id: string,
  ordinal: number,
  status: "failed" | "completed",
) => ({
  id: EventId.make(id),
  type: "run.created" as const,
  threadId,
  runId: RunId.make(id),
  occurredAt: now,
  payload: decodeRun({
    id,
    threadId,
    ordinal,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    providerThreadId: null,
    userMessageId: "home-message",
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    checkpointId: null,
    contextHandoffId: null,
  }),
});

it.effect("mirrors a thread: creates the copy, then adds only what is new", () =>
  Effect.gen(function* () {
    const runtime = ProviderReplayHarness.layerWithRegistry(
      { name: "thread-mirror" },
      ProviderAdapterRegistry.layerFromAdapters([]),
      { runEffectWorker: false },
    );
    const services = yield* Layer.build(
      Layer.mergeAll(
        runtime,
        ThreadImportService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              runtime,
              Layer.mock(ProjectService.ProjectService)({ listShells: () => Effect.succeed([]) }),
            ),
          ),
        ),
      ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    );
    const orchestrator = Context.get(services, Orchestrator.OrchestratorV2);
    const importer = Context.get(services, ThreadImportService.ThreadImportService);
    const sql = Context.get(services, SqlClient.SqlClient);
    const copyId = ThreadId.make("import:boat-vm:bx_1:vm-thread");
    const storedEvents = () =>
      sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id = ${copyId}
      `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));
    const snapshotWith = (sequence: number, count: number) => {
      const items = vmItems.filter((item) => item.type !== "checkpoint").slice(0, count);
      return {
        snapshotSequence: sequence,
        projection: {
          ...({} as OrchestrationV2ThreadProjection),
          thread: { ...vmThread, archivedAt: null, settledOverride: null, settledAt: null },
          messages: vmMessages.filter((message) =>
            items.some((item) => "messageId" in item && item.messageId === message.id),
          ),
          visibleTurnItems: items.map((item, position) => ({
            visibility: "local" as const,
            sourceThreadId: vmThread.id,
            sourceItemId: item.id,
            position,
            item,
          })),
        },
      };
    };
    const mirror = (snapshot: ReturnType<typeof snapshotWith>) =>
      importer.mirrorThread({
        originKey: "boat-vm:bx_1:vm-thread",
        projectId: homeProjectId,
        snapshot,
      });

    expect(yield* mirror(snapshotWith(5, 2))).toEqual({ threadId: copyId, outcome: "created" });
    // thread.created, then the user message and its item, then the command item.
    expect(yield* storedEvents()).toBe(4);
    expect((yield* mirror(snapshotWith(5, 2))).outcome).toBe("unchanged");
    expect(yield* storedEvents()).toBe(4);

    expect((yield* mirror(snapshotWith(9, 3))).outcome).toBe("updated");
    expect(yield* storedEvents()).toBe(6);
    const copy = yield* orchestrator.getThreadSnapshot(copyId);
    expect(copy.projection.thread.archivedAt).toBeNull();
    expect(copy.projection.messages.map((message) => message.text)).toEqual([
      "Fix the login",
      "Fixed it.",
    ]);

    // Settled here, the copy stays settled through a later update.
    const originKey = "boat-vm:bx_1:vm-thread";
    expect(yield* importer.copyState(originKey)).toEqual({ doneAtMs: null, reopenedAtMs: null });
    yield* importer.settleCopy(originKey, 1);
    const renamed = snapshotWith(10, 3);
    const update = yield* mirror({
      ...renamed,
      projection: {
        ...renamed.projection,
        thread: { ...renamed.projection.thread, title: "Fix the login flow" },
      },
    });
    expect(update.outcome).toBe("updated");
    expect(yield* importer.copyState(originKey)).toMatchObject({ doneAtMs: expect.any(Number) });

    const eventSink = Context.get(services, EventSinkV2);
    // A send here that only failed leaves it a copy, still mirrored.
    yield* eventSink.write({ events: [homeRunCreated(copyId, "home-run-failed", 1, "failed")] });
    expect((yield* mirror(snapshotWith(12, 3))).outcome).toBe("updated");

    // Someone continued the copy here: it carries a run of its own now.
    yield* eventSink.write({ events: [homeRunCreated(copyId, "home-run", 2, "completed")] });
    const before = yield* storedEvents();
    expect((yield* mirror(snapshotWith(12, 3))).outcome).toBe("continued");
    yield* importer.deleteCopy("boat-vm:bx_1:vm-thread");
    expect(yield* storedEvents()).toBe(before);
    expect((yield* orchestrator.getThreadRecords(copyId, [])).thread.deletedAt).toBeNull();
  }),
);

it.effect("deletes a mirrored copy and never brings it back", () =>
  Effect.gen(function* () {
    const runtime = ProviderReplayHarness.layerWithRegistry(
      { name: "thread-mirror-delete" },
      ProviderAdapterRegistry.layerFromAdapters([]),
      { runEffectWorker: false },
    );
    const services = yield* Layer.build(
      Layer.mergeAll(
        runtime,
        ThreadImportService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              runtime,
              Layer.mock(ProjectService.ProjectService)({ listShells: () => Effect.succeed([]) }),
            ),
          ),
        ),
      ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    );
    const orchestrator = Context.get(services, Orchestrator.OrchestratorV2);
    const importer = Context.get(services, ThreadImportService.ThreadImportService);
    const input = {
      originKey: "boat-vm:bx_1:vm-thread",
      projectId: homeProjectId,
      snapshot: {
        snapshotSequence: 3,
        projection: {
          ...({} as OrchestrationV2ThreadProjection),
          thread: vmThread,
          messages: [],
          visibleTurnItems: [],
        },
      },
    };
    const { threadId } = yield* importer.mirrorThread(input);
    // A send here that only failed does not keep the copy.
    yield* Context.get(services, EventSinkV2).write({
      events: [homeRunCreated(threadId, "home-run-failed", 1, "failed")],
    });

    yield* importer.deleteCopy(input.originKey);

    expect((yield* orchestrator.getThreadRecords(threadId, [])).thread.deletedAt).not.toBeNull();
    expect(yield* importer.copyState(input.originKey)).toBe("deleted");
    expect((yield* importer.mirrorThread(input)).outcome).toBe("deleted");
  }),
);
