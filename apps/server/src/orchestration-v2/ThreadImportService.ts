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
  EventId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadImportInput,
  type OrchestrationV2ThreadImportResult,
  type OrchestrationV2TurnItem,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectService from "../project/ProjectService.ts";
import { projectShellForRemote } from "../project/repositoryRemote.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";

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
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { threadId, projectId } = input;
  const source = input.snapshot.projection;
  const messagesById = new Map(source.messages.map((message) => [message.id, message]));
  const prefix = `thread-import:${threadId}`;
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

export class ThreadImportProjectNotFoundError extends Schema.TaggedError<ThreadImportProjectNotFoundError>()(
  "ThreadImportProjectNotFoundError",
  { repositoryRemoteUrl: Schema.String },
) {
  override get message(): string {
    return `No project here is a checkout of ${this.repositoryRemoteUrl}.`;
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
  }
>()("t3/orchestration-v2/ThreadImportService") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;

  const importThread: ThreadImportService["Service"]["importThread"] = Effect.fn(
    "ThreadImportService.importThread",
  )(function* (input) {
    const project = projectShellForRemote(yield* projects.listShells(), input.repositoryRemoteUrl);
    if (project === undefined) {
      return yield* new ThreadImportProjectNotFoundError({
        repositoryRemoteUrl: input.repositoryRemoteUrl,
      });
    }
    const threadId = importedThreadId(input.originKey);
    const existing = yield* Effect.option(orchestrator.getThreadRecords(threadId, []));
    if (Option.isSome(existing)) {
      return { threadId, projectId: existing.value.thread.projectId, created: false };
    }
    yield* eventSink.write({
      events: importedThreadEvents({ threadId, projectId: project.id, snapshot: input.snapshot }),
    });
    return { threadId, projectId: project.id, created: true };
  });

  return ThreadImportService.of({ importThread });
});

export const layer = Layer.effect(ThreadImportService, make);
