/**
 * Read-only copies of threads from another environment, such as a boat VM
 * that is about to be deleted. A thread belongs to one environment, so the
 * copy is a new thread here that keeps the conversation and tool activity;
 * runs, checkpoints and attachments stay behind with the other workspace.
 * Like imported agent sessions, the copy is a `v1_import` thread whose items
 * carry no run, so a later message continues it through a context handoff.
 *
 * @module ThreadImportService
 */
import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadImportInput,
  type OrchestrationV2ThreadImportResult,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { projectShellForRemote } from "../project/repositoryRemote.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

/** Item types whose content stands on its own, without the other environment's runs or files. */
const COPIED_ITEM_TYPES: ReadonlySet<string> = new Set([
  "user_message",
  "assistant_message",
  "reasoning",
  "proposed_plan",
  "todo_list",
  "file_change",
  "command_execution",
  "file_search",
  "web_search",
  "system_notice",
  "error",
]);

const importedThreadId = (originKey: string): ThreadId => ThreadId.make(`import:${originKey}`);

/** The events that create the copy of `snapshot` as thread `threadId` in `projectId`. */
function importedThreadEvents(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly snapshot: OrchestrationV2ThreadImportInput["snapshot"];
  /** Set when updating a copy, since event ids must stay unique across updates. */
  readonly revision?: number;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { threadId, projectId } = input;
  const source = input.snapshot.projection;
  const messagesById = new Map(source.messages.map((message) => [message.id, message]));
  const prefix =
    input.revision === undefined
      ? `thread-import:${threadId}`
      : `thread-import:${threadId}:${input.revision}`;
  const itemId = (id: string) => TurnItemId.make(`${threadId}:${id}`);
  const messageId = (id: string) => MessageId.make(`${threadId}:${id}`);

  const copied = source.visibleTurnItems
    .map((row) => row.item as OrchestrationV2TurnItem)
    .filter((item) => COPIED_ITEM_TYPES.has(item.type));
  const events: Array<OrchestrationV2DomainEvent> = [
    {
      id: EventId.make(`${prefix}:created`),
      type: "thread.created",
      threadId,
      occurredAt: source.thread.createdAt,
      payload: {
        ...source.thread,
        id: threadId,
        projectId,
        worktreePath: null,
        linkedPullRequest: null,
        branchPullRequest: null,
        activeProviderThreadId: null,
        historyOrigin: "v1_import",
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        pinnedAt: null,
        pinOrderKey: null,
        activeOrderKey: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    },
  ];
  copied.forEach((item, index) => {
    const base = {
      id: itemId(item.id),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: item.parentItemId === null ? null : itemId(item.parentItemId),
      ordinal: index + 1,
    };
    if (item.type === "user_message" || item.type === "assistant_message") {
      const message = messagesById.get(item.messageId);
      if (message !== undefined) {
        const copy: OrchestrationV2ConversationMessage = {
          ...message,
          id: messageId(message.id),
          threadId,
          runId: null,
          nodeId: null,
          attachments: [],
        };
        events.push({
          id: EventId.make(`${prefix}:message:${message.id}`),
          type: "message.updated",
          threadId,
          occurredAt: message.updatedAt,
          payload: copy,
        });
      }
      events.push({
        id: EventId.make(`${prefix}:item:${item.id}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: item.updatedAt,
        payload: { ...item, ...base, messageId: messageId(item.messageId), attachments: [] },
      });
      return;
    }
    events.push({
      id: EventId.make(`${prefix}:item:${item.id}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: item.updatedAt,
      // Spreading a union widens it; `base` only replaces fields every member has.
      payload: { ...item, ...base } as OrchestrationV2TurnItem,
    });
  });
  return events;
}

/**
 * The events that bring an earlier copy up to `snapshot`: only new or changed
 * messages and items, and the title when it changed.
 */
function mirrorUpdateEvents(input: {
  readonly home: Pick<OrchestrationV2ThreadProjection, "thread" | "messages" | "turnItems">;
  readonly snapshot: OrchestrationV2ThreadImportInput["snapshot"];
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { home, snapshot } = input;
  const messages = new Map(home.messages.map((message) => [message.id, message]));
  const items = new Map(home.turnItems.map((item) => [item.id, item]));
  const sameTime = (a: DateTime.Utc, b: DateTime.Utc) =>
    DateTime.toEpochMillis(a) === DateTime.toEpochMillis(b);
  const changed = importedThreadEvents({
    threadId: home.thread.id,
    projectId: home.thread.projectId,
    snapshot,
    revision: snapshot.snapshotSequence,
  }).filter((event) => {
    if (event.type === "message.updated") {
      const current = messages.get(event.payload.id);
      return (
        current === undefined ||
        current.text !== event.payload.text ||
        !sameTime(current.updatedAt, event.payload.updatedAt)
      );
    }
    if (event.type === "turn-item.updated") {
      const current = items.get(event.payload.id);
      return (
        current === undefined ||
        current.ordinal !== event.payload.ordinal ||
        !sameTime(current.updatedAt, event.payload.updatedAt)
      );
    }
    return false;
  });
  const title = snapshot.projection.thread.title;
  if (title === home.thread.title) return changed;
  return [
    {
      id: EventId.make(`thread-import:${home.thread.id}:${snapshot.snapshotSequence}:title`),
      type: "thread.metadata-updated",
      threadId: home.thread.id,
      occurredAt: snapshot.projection.thread.updatedAt,
      payload: { ...home.thread, title },
    },
    ...changed,
  ];
}

export interface CopyState {
  /** When the copy was settled or archived; null while it is open. */
  readonly doneAtMs: number | null;
  /** When someone reopened the copy here; null unless it was. */
  readonly reopenedAtMs: number | null;
}

export class ThreadImportProjectNotFoundError extends Schema.TaggedError<ThreadImportProjectNotFoundError>()(
  "ThreadImportProjectNotFoundError",
  /** Empty for an import into Scratch, which this environment does not have. */
  { repositoryRemoteUrl: Schema.String },
) {
  override get message(): string {
    return this.repositoryRemoteUrl === ""
      ? "This environment has no Scratch project for the thread."
      : `No project here is a checkout of ${this.repositoryRemoteUrl}.`;
  }
}

export class ThreadImportService extends Context.Service<
  ThreadImportService,
  {
    readonly importThread: (
      input: OrchestrationV2ThreadImportInput,
    ) => Effect.Effect<
      OrchestrationV2ThreadImportResult,
      | ThreadImportProjectNotFoundError
      | ProjectService.ProjectOperationError
      | EventSink.EventSinkV2Error
    >;
    /**
     * Creates the copy of `originKey` in `projectId`, or brings an existing copy
     * up to `snapshot`. A copy someone deleted, or continued here, is left alone.
     */
    readonly mirrorThread: (input: {
      readonly originKey: string;
      readonly projectId: ProjectId;
      readonly snapshot: OrchestrationV2ThreadImportInput["snapshot"];
    }) => Effect.Effect<
      {
        readonly threadId: ThreadId;
        readonly outcome: "created" | "updated" | "unchanged" | "deleted" | "continued";
      },
      EventSink.EventSinkV2Error | Orchestrator.OrchestratorV2Error
    >;
    /** Deletes the copy of `originKey`, if there is one and it was not continued here. */
    readonly deleteCopy: (
      originKey: string,
    ) => Effect.Effect<void, Orchestrator.OrchestratorV2Error>;
    /**
     * Whether the copy of `originKey` is settled or archived here; "deleted" once
     * someone deleted it, null when there is none.
     */
    readonly copyState: (originKey: string) => Effect.Effect<CopyState | "deleted" | null>;
    /**
     * Settles the copy of `originKey`. `episode` keeps the command id apart
     * from an earlier settle of the same copy.
     */
    readonly settleCopy: (
      originKey: string,
      episode: number,
    ) => Effect.Effect<void, Orchestrator.OrchestratorV2Error>;
    /**
     * The copy of `originKey` as another environment's import takes it, and
     * whether it was continued here; null when there is no copy or it was deleted.
     */
    readonly copySnapshot: (originKey: string) => Effect.Effect<{
      readonly snapshot: OrchestrationV2ThreadImportInput["snapshot"];
      readonly continuedHere: boolean;
    } | null>;
  }
>()("t3/orchestration-v2/ThreadImportService") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  // Provided where an import may land in Scratch; without it such an import is refused.
  const managedFolders = yield* Effect.serviceOption(ManagedProjectFolders.ManagedProjectFolders);

  const projectForImport = Effect.fn("ThreadImportService.projectForImport")(function* (
    repositoryRemoteUrl: string | undefined,
  ) {
    if (repositoryRemoteUrl === undefined) {
      if (Option.isNone(managedFolders)) {
        return yield* new ThreadImportProjectNotFoundError({ repositoryRemoteUrl: "" });
      }
      return (yield* managedFolders.value.ensureScratchProject.pipe(
        Effect.mapError(() => new ThreadImportProjectNotFoundError({ repositoryRemoteUrl: "" })),
      )).projectId;
    }
    const project = projectShellForRemote(yield* projects.listShells(), repositoryRemoteUrl);
    if (project === undefined) {
      return yield* new ThreadImportProjectNotFoundError({ repositoryRemoteUrl });
    }
    return project.id;
  });

  const importThread: ThreadImportService["Service"]["importThread"] = Effect.fn(
    "ThreadImportService.importThread",
  )(function* (input) {
    const projectId = yield* projectForImport(input.repositoryRemoteUrl);
    const threadId = importedThreadId(input.originKey);
    const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
    if (Option.isSome(existing)) {
      return { threadId, projectId: existing.value.thread.projectId, created: false };
    }
    yield* eventSink.write({
      events: importedThreadEvents({ threadId, projectId, snapshot: input.snapshot }),
    });
    return { threadId, projectId, created: true };
  });

  const readCopy = (threadId: ThreadId) =>
    Effect.option(orchestrator.getThreadRecords(threadId, ["runs", "messages", "turnItems"]));
  // A copy carries no runs, so a run on it that did not fail means someone
  // continued it here. Sends that only failed, such as at provider startup,
  // leave it a copy.
  const continuedHere = (copy: { readonly runs: ReadonlyArray<{ readonly status: string }> }) =>
    copy.runs.some((run) => run.status !== "failed");

  const mirrorThread: ThreadImportService["Service"]["mirrorThread"] = Effect.fn(
    "ThreadImportService.mirrorThread",
  )(function* (input) {
    const threadId = importedThreadId(input.originKey);
    const existing = yield* readCopy(threadId);
    if (Option.isNone(existing)) {
      yield* eventSink.write({
        events: importedThreadEvents({
          threadId,
          projectId: input.projectId,
          snapshot: input.snapshot,
        }),
      });
      return { threadId, outcome: "created" as const };
    }
    const home = existing.value;
    if (home.thread.deletedAt !== null) return { threadId, outcome: "deleted" as const };
    if (continuedHere(home)) return { threadId, outcome: "continued" as const };
    const events = mirrorUpdateEvents({ home, snapshot: input.snapshot });
    if (events.length === 0) return { threadId, outcome: "unchanged" as const };
    yield* eventSink.write({ events });
    return { threadId, outcome: "updated" as const };
  });

  const deleteCopy: ThreadImportService["Service"]["deleteCopy"] = Effect.fn(
    "ThreadImportService.deleteCopy",
  )(function* (originKey) {
    const threadId = importedThreadId(originKey);
    const existing = yield* readCopy(threadId);
    if (Option.isNone(existing) || existing.value.thread.deletedAt !== null) return;
    if (continuedHere(existing.value)) return;
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make(`thread-import-delete:${threadId}`),
      threadId,
    });
  });

  const copyState: ThreadImportService["Service"]["copyState"] = Effect.fn(
    "ThreadImportService.copyState",
  )(function* (originKey) {
    const existing = yield* Effect.option(
      orchestrator.getThreadRecords(importedThreadId(originKey), []),
    );
    if (Option.isNone(existing)) return null;
    const { thread } = existing.value;
    if (thread.deletedAt !== null) return "deleted" as const;
    const ms = (at: DateTime.Utc | null | undefined) =>
      at == null ? null : DateTime.toEpochMillis(at);
    if (thread.archivedAt !== null) return { doneAtMs: ms(thread.archivedAt), reopenedAtMs: null };
    return {
      doneAtMs: thread.settledOverride === "settled" ? (ms(thread.settledAt) ?? 0) : null,
      reopenedAtMs: thread.settledOverride === "active" ? ms(thread.unsettledAt) : null,
    };
  });

  const settleCopy: ThreadImportService["Service"]["settleCopy"] = Effect.fn(
    "ThreadImportService.settleCopy",
  )(function* (originKey, episode) {
    const threadId = importedThreadId(originKey);
    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make(`thread-import-settle:${threadId}:${episode}`),
      threadId,
    });
  });

  const copySnapshot: ThreadImportService["Service"]["copySnapshot"] = Effect.fn(
    "ThreadImportService.copySnapshot",
  )(function* (originKey) {
    const threadId = importedThreadId(originKey);
    const copy = yield* readCopy(threadId);
    if (Option.isNone(copy) || copy.value.thread.deletedAt !== null) return null;
    const snapshot = yield* Effect.option(orchestrator.getThreadSnapshot(threadId));
    if (Option.isNone(snapshot)) return null;
    return {
      snapshot: {
        snapshotSequence: snapshot.value.snapshotSequence,
        projection: projectThreadProjectionForWire(snapshot.value.projection),
      },
      continuedHere: continuedHere(copy.value),
    };
  });

  return ThreadImportService.of({
    importThread,
    mirrorThread,
    deleteCopy,
    copyState,
    settleCopy,
    copySnapshot,
  });
});

export const layer = Layer.effect(ThreadImportService, make);
