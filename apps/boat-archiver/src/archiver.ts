/**
 * One archiver pass over the account's boat VMs. Only running VMs are read:
 * a stopped VM's threads cannot change, and every rule needs the VM's own T3
 * to answer.
 *
 * The VM's HTTP shell lists only active threads, so the archiver remembers
 * the threads it has seen on each VM and asks for any that left the list by
 * id: an archived one is copied home, a deleted one is forgotten.
 */
import { BOAT_VM_LABEL_PREFIX } from "@t3tools/contracts";
import {
  buildSandboxStopScript,
  type SandboxProviderShape,
  type SandboxRef,
} from "@t3tools/sandbox-core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decide, VmThreads, type VmThread } from "./decide.ts";
import { REMOVE_FILE_SCRIPT, THREAD_SNAPSHOT_SCRIPT, THREADS_SCRIPT } from "./scripts.ts";

const SCRIPT_TIMEOUT_MS = 2 * 60_000;
const decodeVmThreads = Schema.decodeUnknownEffect(Schema.fromJsonString(VmThreads));
/** The fields of a thread snapshot the rules read; the rest goes home untouched. */
const SnapshotThread = Schema.Struct({
  projection: Schema.Struct({
    thread: Schema.Struct({
      id: Schema.String,
      projectId: Schema.String,
      archivedAt: Schema.NullOr(Schema.String),
      deletedAt: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
    }),
  }),
});
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSnapshotThread = Schema.decodeUnknownEffect(SnapshotThread);

export const ArchiverState = Schema.Struct({
  /** Threads seen on each VM, by sandbox id. */
  threadsByVm: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  /** Origin keys of threads already copied home. */
  copied: Schema.Array(Schema.String),
});
export type ArchiverState = typeof ArchiverState.Type;

export const emptyState: ArchiverState = { threadsByVm: {}, copied: [] };

export const originKeyOf = (sandboxId: string, threadId: string) =>
  `boat-vm:${sandboxId}:${threadId}`;

export class ArchiverError extends Schema.TaggedError<ArchiverError>()("ArchiverError", {
  message: Schema.String,
}) {}

/** The home T3 server's thread import endpoint. */
export interface HomeServer {
  readonly importThread: (input: {
    readonly originKey: string;
    readonly repositoryRemoteUrl: string;
    readonly snapshot: unknown;
  }) => Effect.Effect<void, ArchiverError>;
}

export interface VmReport {
  readonly sandboxId: string;
  readonly action: "none" | "stop" | "delete" | "kept" | "unreadable";
  readonly copied: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<string>;
}

const failure = (message: string) => new ArchiverError({ message });

export const runPass = Effect.fn("boatArchiver.runPass")(function* (input: {
  readonly provider: SandboxProviderShape;
  readonly home: HomeServer;
  readonly state: ArchiverState;
  readonly nowMs: number;
  readonly idleMinutes: number;
}) {
  const { provider, home } = input;
  const vms = (yield* provider.list()).filter((vm) => vm.label.startsWith(BOAT_VM_LABEL_PREFIX));
  const threadsByVm: Record<string, ReadonlyArray<string>> = { ...input.state.threadsByVm };
  const copied = new Set(input.state.copied);
  const reports: Array<VmReport> = [];

  const exec = (ref: SandboxRef, script: string, args: ReadonlyArray<string> = []) =>
    provider.exec(ref, { script, args, timeoutMs: SCRIPT_TIMEOUT_MS }).pipe(
      Effect.mapError((error) => failure(error.message)),
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(failure(result.stderr.trim().slice(-300) || `exit ${result.exitCode}`)),
      ),
    );

  /** The thread's full snapshot as JSON text, or undefined once it no longer exists. */
  const readSnapshot = Effect.fn("boatArchiver.readSnapshot")(function* (
    ref: SandboxRef,
    threadId: string,
  ) {
    const answer = (yield* exec(ref, THREAD_SNAPSHOT_SCRIPT, [threadId])).trim();
    if (answer === "missing") return undefined;
    return yield* provider.readFile(ref, answer).pipe(
      Effect.map((bytes) => new TextDecoder().decode(bytes)),
      Effect.mapError((error) => failure(error.message)),
      Effect.ensuring(exec(ref, REMOVE_FILE_SCRIPT, [answer]).pipe(Effect.ignore)),
    );
  });

  for (const vm of vms) {
    if (vm.status !== "running") continue;
    const ref = vm.ref;
    const listed = yield* exec(ref, THREADS_SCRIPT).pipe(
      Effect.flatMap((stdout) =>
        decodeVmThreads(stdout).pipe(Effect.mapError(() => failure("unexpected thread list"))),
      ),
      Effect.result,
    );
    if (listed._tag === "Failure") {
      reports.push({
        sandboxId: ref.sandboxId,
        action: "unreadable",
        copied: [],
        problems: [listed.failure.message],
      });
      continue;
    }
    const { projects } = listed.success;
    const known = threadsByVm[ref.sandboxId] ?? [];
    const activeIds = new Set(listed.success.threads.map((thread) => thread.id));
    const problems: Array<string> = [];

    // Threads that left the active list: archived (kept, with their snapshot) or deleted.
    const archived: Array<{ readonly thread: VmThread; readonly snapshot: string }> = [];
    let unresolved = false;
    for (const threadId of known.filter((id) => !activeIds.has(id))) {
      const read = yield* Effect.result(
        readSnapshot(ref, threadId).pipe(
          Effect.flatMap((text) =>
            text === undefined
              ? Effect.succeed(undefined)
              : decodeSnapshot(text).pipe(
                  Effect.flatMap(decodeSnapshotThread),
                  Effect.map(({ projection: { thread } }) => ({ thread, text })),
                  Effect.mapError(() => failure(`thread ${threadId} snapshot is unreadable`)),
                ),
          ),
        ),
      );
      if (read._tag === "Failure") {
        problems.push(read.failure.message);
        unresolved = true;
        continue;
      }
      const found = read.success;
      if (found === undefined || found.thread.deletedAt !== null) continue;
      if (found.thread.archivedAt === null) continue;
      archived.push({
        thread: {
          id: found.thread.id,
          projectId: found.thread.projectId,
          status: "idle",
          archivedAt: found.thread.archivedAt,
          snoozedUntil: null,
          latestUserMessageAt: null,
          createdAt: found.thread.createdAt,
        },
        snapshot: found.text,
      });
    }

    const threads = [...listed.success.threads, ...archived.map(({ thread }) => thread)];
    const decision = decide({
      threads,
      hadThreads: known.length > 0,
      copied: new Set(
        threads
          .map((thread) => thread.id)
          .filter((id) => copied.has(originKeyOf(ref.sandboxId, id))),
      ),
      nowMs: input.nowMs,
      idleMinutes: input.idleMinutes,
    });

    const copiedNow: Array<string> = [];
    for (const thread of decision.copy) {
      const snapshot = archived.find((entry) => entry.thread.id === thread.id)?.snapshot;
      const remoteUrl = projects.find((project) => project.id === thread.projectId)?.remoteUrl;
      const result = yield* Effect.result(
        Effect.gen(function* () {
          if (snapshot === undefined) return yield* failure(`thread ${thread.id} has no snapshot`);
          if (!remoteUrl) return yield* failure(`thread ${thread.id} has no repository remote`);
          yield* home.importThread({
            originKey: originKeyOf(ref.sandboxId, thread.id),
            repositoryRemoteUrl: remoteUrl,
            snapshot: yield* decodeSnapshot(snapshot).pipe(
              Effect.mapError(() => failure(`thread ${thread.id} snapshot is unreadable`)),
            ),
          });
        }),
      );
      if (result._tag === "Failure") {
        problems.push(result.failure.message);
      } else {
        copied.add(originKeyOf(ref.sandboxId, thread.id));
        copiedNow.push(thread.id);
      }
    }

    threadsByVm[ref.sandboxId] = threads.map((thread) => thread.id);
    let action: VmReport["action"] = decision.action;
    if (decision.action === "delete") {
      if (problems.length > 0 || unresolved) {
        action = "kept";
      } else {
        const destroyed = yield* Effect.result(provider.destroy(ref));
        if (destroyed._tag === "Failure") {
          problems.push(destroyed.failure.message);
          action = "kept";
        } else {
          delete threadsByVm[ref.sandboxId];
        }
      }
    } else if (decision.action === "stop") {
      // Let `t3 serve` flush its database before the disk is snapshotted.
      yield* exec(ref, buildSandboxStopScript()).pipe(Effect.ignore);
      const stopped = yield* Effect.result(provider.stop(ref));
      if (stopped._tag === "Failure") problems.push(stopped.failure.message);
    }
    reports.push({ sandboxId: ref.sandboxId, action, copied: copiedNow, problems });
  }

  const listedIds = new Set(vms.map((vm) => vm.ref.sandboxId));
  const state: ArchiverState = {
    threadsByVm: Object.fromEntries(
      Object.entries(threadsByVm).filter(([sandboxId]) => listedIds.has(sandboxId)),
    ),
    copied: [...copied],
  };
  return { state, reports };
});
