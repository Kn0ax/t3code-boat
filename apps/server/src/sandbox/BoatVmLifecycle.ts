/**
 * What happens to a running boat VM's threads, and to the VM once they are
 * done with it. Threads live in the VM's own T3, so each pass first mirrors
 * every thread on the VM that changed since the last pass to this server: a
 * copy here that follows the VM's thread as it grows and is deleted when the
 * VM's thread is. Deleted threads are never copied. A thread of a project with
 * no repository remote, such as a scratch VM's "No project", or of a repository
 * no project here checks out, is mirrored into this server's own scratch
 * project. Subagent threads are not copied on their own: their work is in the
 * parent's items, and a copy each would add a top-level thread here.
 *
 * While the VM exists, running or stopped, its copies are followed copies
 * (FollowedThreadCopies): a message sent to one is refused, because the
 * conversation goes on in the VM's thread. Once the VM is gone they become
 * ordinary threads.
 *
 * A VM holds the threads of one repository, so a rule applies once it holds
 * for every top-level thread on the VM, and while no subagent is at work:
 *
 * - every thread deleted: delete the VM;
 * - every thread archived, settled or deleted: once every copy is up to date,
 *   settle the copies and stop the VM, then delete it once it has stayed that
 *   way for BOAT_VM_SETTLED_DELETE_AFTER_MS. A thread counts as settled when
 *   its copy here was settled or archived after the thread's last activity.
 *   While the VM is stopped its threads cannot change, so its copies decide:
 *   reopening one keeps the VM;
 * - every other thread snoozed or quiet for the idle window: stop the VM, even
 *   when a copy is behind, since the stopped VM keeps its disk.
 *
 * The checks run inside the VM over loopback with a short-lived token its `t3`
 * issues there; no credential for the VM is kept here. The VM's shell lists
 * only unarchived threads, so the threads seen on each VM and the version of
 * each one last mirrored are remembered in a file under the state directory,
 * and one that left the list is looked up by id to tell archived from deleted.
 *
 * @module BoatVmLifecycle
 */
import {
  boatVmThreadOriginKey,
  OrchestrationV2ThreadDetailSnapshot,
  type ProjectId,
} from "@t3tools/contracts";
import {
  SANDBOX_STATE_KEY,
  type SandboxEnvironmentManager,
  type SandboxProviderShape,
  type SandboxRef,
} from "@t3tools/sandbox-core";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as FollowedThreadCopies from "../orchestration-v2/FollowedThreadCopies.ts";
import type * as ThreadImportService from "../orchestration-v2/ThreadImportService.ts";

const SCRIPT_TIMEOUT_MS = 2 * 60_000;
/** How long a VM whose threads are all settled stays stopped before it is deleted. */
export const BOAT_VM_SETTLED_DELETE_AFTER_MS = 3 * 24 * 60 * 60_000;

const LOCAL_T3 = `set -eu
STATE_DIR="$HOME/.t3/ssh-launch/${SANDBOX_STATE_KEY}"
[ -x "$STATE_DIR/run-t3.sh" ] || { printf 'No T3 runner on this VM.\\n' >&2; exit 3; }
T3_PORT="$(cat "$STATE_DIR/port" 2>/dev/null || printf 3773)"
T3_TOKEN="$("$STATE_DIR/run-t3.sh" auth session issue --base-dir "$HOME/.t3" --scope orchestration:read --ttl 5m --token-only)"
export T3_PORT T3_TOKEN
`;

const FETCH_JS = `const get = async (path) => {
  const response = await fetch("http://127.0.0.1:" + process.env.T3_PORT + path, {
    headers: {
      authorization: "Bearer " + process.env.T3_TOKEN,
      "x-t3-orchestration-protocol": "2",
    },
  });
  if (!response.ok && response.status !== 404) throw new Error(path + " answered " + response.status);
  return response;
};`;

/**
 * Prints one JSON line: the VM's unarchived threads with the fields the rules
 * read, what became of each remembered thread id (the arguments) that left that
 * list, and each project's repository remote. A thread's version changes
 * whenever its shell shows new content, so an unchanged thread is not fetched.
 */
export const VM_THREADS_SCRIPT = `${LOCAL_T3}node --input-type=module -e '
${FETCH_JS}
const shell = await (await get("/api/orchestration/shell")).json();
const listed = new Set(shell.threads.map((thread) => thread.id));
const departed = [];
for (const id of process.argv.slice(1)) {
  if (listed.has(id)) continue;
  const response = await get("/api/orchestration/threads/" + encodeURIComponent(id));
  if (response.status === 404) {
    departed.push({ id, state: "deleted", version: null, parentThreadId: null });
    continue;
  }
  const { projection } = await response.json();
  const { thread } = projection;
  const state = thread.deletedAt != null ? "deleted" : thread.archivedAt != null ? "archived" : "unknown";
  departed.push({
    id,
    state,
    version: state === "archived" ? [thread.updatedAt, projection.updatedAt].join("|") : null,
    parentThreadId: thread.lineage?.parentThreadId ?? null,
  });
}
process.stdout.write(JSON.stringify({
  threads: shell.threads.map((thread) => ({
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.lineage?.parentThreadId ?? null,
    status: thread.status,
    settled: thread.settledOverride === "settled",
    settledAt: thread.settledAt ?? null,
    unsettledAt: thread.unsettledAt ?? null,
    snoozedUntil: thread.snoozedUntil ?? null,
    latestUserMessageAt: thread.latestUserMessageAt ?? null,
    createdAt: thread.createdAt,
    version: [
      thread.updatedAt,
      thread.title,
      thread.status,
      thread.itemCount,
      thread.latestVisibleMessage?.id ?? "",
      thread.latestVisibleMessage?.updatedAt ?? "",
      thread.latestRunCompletedAt ?? "",
    ].join("|"),
  })),
  departed,
  projects: shell.projects.map((project) => ({
    id: project.id,
    remoteUrl: project.repositoryIdentity?.locator?.remoteUrl ?? null,
  })),
}));
' "$@"
`;

/**
 * Writes thread "$1"'s full snapshot to a file and prints the file's path, or
 * prints "missing" when the thread no longer exists. A file, because a long
 * thread is more than exec output carries.
 */
export const THREAD_SNAPSHOT_SCRIPT = `${LOCAL_T3}OUT="$HOME/.t3/boat-lifecycle-thread.json"
node --input-type=module -e '
${FETCH_JS}
const { writeFile } = await import("node:fs/promises");
const response = await get("/api/orchestration/threads/" + encodeURIComponent(process.argv[1]));
if (response.status === 404) {
  process.stdout.write("missing");
} else {
  await writeFile(process.argv[2], await response.text());
  process.stdout.write(process.argv[2]);
}
' "$1" "$OUT"
`;

const REMOVE_SNAPSHOT_SCRIPT = `rm -f "$HOME/.t3/boat-lifecycle-thread.json"`;

export const VmThread = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  /** Set on a subagent thread. */
  parentThreadId: Schema.NullOr(Schema.String),
  status: Schema.String,
  settled: Schema.Boolean,
  settledAt: Schema.NullOr(Schema.String),
  unsettledAt: Schema.NullOr(Schema.String),
  snoozedUntil: Schema.NullOr(Schema.String),
  latestUserMessageAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  version: Schema.String,
});
export type VmThread = typeof VmThread.Type;

const epochMs = (iso: string | null) => (iso === null ? 0 : Date.parse(iso));

/**
 * Whether a VM thread is settled, on the VM or through its copy here: the
 * latest of settling it on the VM, settling or archiving its copy, reopening
 * its copy, and activity on the VM wins.
 */
export function vmThreadSettled(
  thread: VmThread,
  copy: ThreadImportService.CopyState | null,
): boolean {
  const reopenedAt = copy?.reopenedAtMs ?? null;
  if (thread.settled && (reopenedAt === null || reopenedAt <= epochMs(thread.settledAt))) {
    return true;
  }
  const doneAt = copy?.doneAtMs ?? null;
  return (
    doneAt !== null &&
    doneAt >= Math.max(epochMs(thread.latestUserMessageAt), epochMs(thread.unsettledAt))
  );
}

const VmThreads = Schema.Struct({
  threads: Schema.Array(VmThread),
  departed: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      state: Schema.Literals(["archived", "deleted", "unknown"]),
      version: Schema.NullOr(Schema.String),
      parentThreadId: Schema.NullOr(Schema.String),
    }),
  ),
  projects: Schema.Array(
    Schema.Struct({ id: Schema.String, remoteUrl: Schema.NullOr(Schema.String) }),
  ),
});
type VmThreads = typeof VmThreads.Type;

const decodeVmThreads = Schema.decodeUnknownEffect(Schema.fromJsonString(VmThreads));
const decodeSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot)),
);

const LifecycleState = Schema.fromJsonString(
  Schema.Struct({
    /** Threads seen on each VM, by sandbox id. */
    threadsByVm: Schema.Record(Schema.String, Schema.Array(Schema.String)),
    /**
     * Mirrored threads on each VM, by sandbox id then thread id: the version
     * last mirrored, or null once the copy here is left alone.
     */
    mirrorsByVm: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
    ),
    /** When each VM was stopped with every thread settled, by sandbox id, in epoch ms. */
    settledSince: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
  }),
);
const decodeState = Schema.decodeUnknownEffect(LifecycleState);
const encodeState = Schema.encodeEffect(LifecycleState);

/** Thread statuses with a run in flight; "waiting" is a run waiting on the user's answer. */
const BUSY_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

function decide(input: {
  /** The VM's unarchived top-level threads, `settled` as vmThreadSettled tells. */
  readonly threads: ReadonlyArray<VmThread>;
  /** The VM's unarchived subagent threads; one with a run in flight is work on the VM. */
  readonly subagents: ReadonlyArray<VmThread>;
  /** Remembered threads that are archived now. */
  readonly archived: ReadonlyArray<string>;
  /** Remembered threads that left the list without being archived or deleted. */
  readonly unknown: ReadonlyArray<string>;
  /** True once a thread was ever seen on this VM, so a fresh VM is not taken for an emptied one. */
  readonly hadThreads: boolean;
  readonly nowMs: number;
  readonly idleMinutes: number;
  /** When this server last launched or resumed the VM, if it did. */
  readonly launchedAtMs: number | undefined;
}): "none" | "stop" | "settle" | "delete" {
  const quietSince = input.nowMs - input.idleMinutes * 60_000;
  if (input.unknown.length > 0) return "none";
  // A delegated task can run on while its parent waits idle.
  if (input.subagents.some((thread) => BUSY_STATUSES.has(thread.status))) return "none";
  // A VM the user just started or resumed gets the idle window before any rule
  // applies, so resuming a snoozed or done thread's VM does not undo itself.
  if (input.launchedAtMs !== undefined && input.launchedAtMs > quietSince) return "none";
  if (input.threads.length === 0 && input.archived.length === 0) {
    return input.hadThreads ? "delete" : "none";
  }
  const open = input.threads.filter((thread) => !thread.settled);
  if (open.length === 0) return "settle";
  const resting = (thread: VmThread) =>
    (thread.snoozedUntil !== null && Date.parse(thread.snoozedUntil) > input.nowMs) ||
    (!BUSY_STATUSES.has(thread.status) &&
      Date.parse(thread.latestUserMessageAt ?? thread.createdAt) <= quietSince);
  return open.every(resting) ? "stop" : "none";
}

type LifecycleOutcome = "stopped" | "deleted" | "kept";

class LifecycleProblem extends Schema.TaggedError<LifecycleProblem>()("LifecycleProblem", {
  message: Schema.String,
}) {}
const problem = (message: string) => new LifecycleProblem({ message });

export const make = Effect.fn("BoatVmLifecycle.make")(function* (input: {
  readonly statePath: string;
  readonly manager: SandboxEnvironmentManager["Service"];
  readonly threadImport: ThreadImportService.ThreadImportService["Service"];
  readonly followedCopies: FollowedThreadCopies.FollowedThreadCopies["Service"];
  /**
   * This server's project for a VM project's repository remote, or its scratch
   * project when there is none; fails with why it cannot tell.
   */
  readonly homeProjectFor: (remoteUrl: string | null) => Effect.Effect<ProjectId, string>;
  /**
   * Run before deleting a VM, such as releasing its tailnet node; failures are
   * ignored. A stopped VM must not be reached, since that may start it.
   */
  readonly beforeDelete: (
    provider: SandboxProviderShape,
    ref: SandboxRef,
    vm: { readonly running: boolean },
  ) => Effect.Effect<void>;
}) {
  const { manager, threadImport } = input;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const stored = yield* fileSystem.readFileString(input.statePath).pipe(
    Effect.flatMap(decodeState),
    Effect.orElseSucceed(() => ({
      threadsByVm: {},
      mirrorsByVm: undefined,
      settledSince: undefined,
    })),
  );
  const threadsByVm = new Map<string, ReadonlyArray<string>>(Object.entries(stored.threadsByVm));
  const mirrorsByVm = new Map<string, Map<string, string | null>>(
    Object.entries(stored.mirrorsByVm ?? {}).map(([sandboxId, mirrors]) => [
      sandboxId,
      new Map(Object.entries(mirrors)),
    ]),
  );
  const settledSince = new Map<string, number>(Object.entries(stored.settledSince ?? {}));
  const launchedAt = new Map<string, number>();
  // A copy left alone (null) by an earlier start is checked once more, since
  // what counts as continued here can differ between versions; ThreadImportService
  // leaves alone again any copy that still is. Keys are "<sandboxId> <threadId>".
  const leftAloneChecked = new Set<string>();
  const encodeCurrent = () =>
    encodeState({
      threadsByVm: Object.fromEntries(threadsByVm),
      mirrorsByVm: Object.fromEntries(
        [...mirrorsByVm].map(([sandboxId, mirrors]) => [sandboxId, Object.fromEntries(mirrors)]),
      ),
      settledSince: Object.fromEntries(settledSince),
    });
  let persisted = yield* encodeCurrent().pipe(Effect.orElseSucceed(() => ""));

  /** Every copy of a thread on a VM boat still has, except one left alone here. */
  const publishFollowed = () =>
    input.followedCopies.replace(
      new Set(
        [...mirrorsByVm].flatMap(([sandboxId, mirrors]) =>
          [...mirrors]
            .filter(([, version]) => version !== null)
            .map(([threadId]) => `import:${boatVmThreadOriginKey(sandboxId, threadId)}`),
        ),
      ),
    );
  yield* publishFollowed();

  const markLaunched = (sandboxId: string) =>
    Clock.currentTimeMillis.pipe(Effect.map((now) => void launchedAt.set(sandboxId, now)));

  const exec = (
    provider: SandboxProviderShape,
    ref: SandboxRef,
    script: string,
    args: ReadonlyArray<string> = [],
  ) =>
    provider.exec(ref, { script, args, timeoutMs: SCRIPT_TIMEOUT_MS }).pipe(
      Effect.mapError((error) => problem(error.message)),
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(problem(result.stderr.trim().slice(-300) || `exit ${result.exitCode}`)),
      ),
    );

  /** The thread's snapshot, or undefined once it no longer exists. */
  const readSnapshot = Effect.fn("BoatVmLifecycle.readSnapshot")(function* (
    provider: SandboxProviderShape,
    ref: SandboxRef,
    threadId: string,
  ) {
    const answer = (yield* exec(provider, ref, THREAD_SNAPSHOT_SCRIPT, [threadId])).trim();
    if (answer === "missing") return undefined;
    const text = yield* provider.readFile(ref, answer).pipe(
      Effect.map((bytes) => new TextDecoder().decode(bytes)),
      Effect.mapError((error) => problem(error.message)),
      Effect.ensuring(exec(provider, ref, REMOVE_SNAPSHOT_SCRIPT).pipe(Effect.ignore)),
    );
    return yield* decodeSnapshot(text).pipe(
      Effect.mapError(() => problem(`thread ${threadId} snapshot is unreadable`)),
    );
  });

  /** Creates or updates the copy of one VM thread; "missing" once the thread is gone. */
  const mirrorThread = Effect.fn("BoatVmLifecycle.mirrorThread")(function* (
    provider: SandboxProviderShape,
    ref: SandboxRef,
    threadId: string,
    projects: VmThreads["projects"],
  ) {
    const snapshot = yield* readSnapshot(provider, ref, threadId);
    if (snapshot === undefined || snapshot.projection.thread.deletedAt !== null) {
      return "missing" as const;
    }
    const remoteUrl =
      projects.find((project) => project.id === snapshot.projection.thread.projectId)?.remoteUrl ??
      null;
    const projectId = yield* input
      .homeProjectFor(remoteUrl)
      .pipe(Effect.mapError((reason) => problem(`thread ${threadId}: ${reason}`)));
    const mirrored = yield* threadImport
      .mirrorThread({
        originKey: boatVmThreadOriginKey(ref.sandboxId, threadId),
        projectId,
        snapshot,
      })
      .pipe(Effect.mapError((error) => problem(error.message)));
    return mirrored.outcome;
  });

  /**
   * Brings the copies of a VM's threads up to date and deletes the copies of
   * its deleted threads; returns what could not be done, to retry next pass.
   */
  const mirror = Effect.fn("BoatVmLifecycle.mirror")(function* (
    provider: SandboxProviderShape,
    ref: SandboxRef,
    present: ReadonlyArray<{ readonly id: string; readonly version: string }>,
    deleted: ReadonlyArray<string>,
    projects: VmThreads["projects"],
  ) {
    const sandboxId = ref.sandboxId;
    const mirrors = mirrorsByVm.get(sandboxId) ?? new Map<string, string | null>();
    mirrorsByVm.set(sandboxId, mirrors);
    const problems: Array<string> = [];
    for (const threadId of deleted) {
      if (!mirrors.has(threadId)) continue;
      if (mirrors.get(threadId) === null && leftAloneChecked.has(`${sandboxId} ${threadId}`)) {
        mirrors.delete(threadId);
        continue;
      }
      const removed = yield* Effect.result(
        threadImport.deleteCopy(boatVmThreadOriginKey(sandboxId, threadId)),
      );
      if (removed._tag === "Failure") {
        problems.push(`thread ${threadId}: ${removed.failure.message}`);
        continue;
      }
      mirrors.delete(threadId);
    }
    for (const { id: threadId, version } of present) {
      const previous = mirrors.get(threadId);
      const key = `${sandboxId} ${threadId}`;
      if (previous === version || (previous === null && leftAloneChecked.has(key))) continue;
      const mirrored = yield* Effect.result(mirrorThread(provider, ref, threadId, projects));
      if (mirrored._tag === "Failure") {
        problems.push(mirrored.failure.message);
        continue;
      }
      const outcome = mirrored.success;
      if (previous === null) leftAloneChecked.add(key);
      if (outcome === "missing") continue;
      if (outcome === "continued" || outcome === "deleted") {
        // Overwriting a copy someone continued here, or bringing back one they
        // deleted, would lose their choice; the copy is left alone from now on.
        leftAloneChecked.add(key);
        mirrors.set(threadId, null);
        yield* Effect.logInfo("boat.vm.lifecycle.mirrorLeftAlone", {
          sandboxId,
          threadId,
          reason: outcome,
        });
        continue;
      }
      mirrors.set(threadId, version);
    }
    return problems;
  });

  /** The state of a VM thread's followed copy; null for none, or one left alone here. */
  const copyStateOf = (sandboxId: string, threadId: string) =>
    typeof mirrorsByVm.get(sandboxId)?.get(threadId) === "string"
      ? threadImport.copyState(boatVmThreadOriginKey(sandboxId, threadId))
      : Effect.succeed(null);

  const stop = Effect.fn("BoatVmLifecycle.stop")(function* (
    provider: SandboxProviderShape,
    ref: SandboxRef,
  ) {
    // The manager lets `t3 serve` flush its database before the disk is kept.
    const stopped = yield* Effect.result(manager.stop({ provider, ref }));
    if (stopped._tag === "Failure") {
      yield* Effect.logWarning("boat.vm.lifecycle.stopFailed", {
        sandboxId: ref.sandboxId,
        error: stopped.failure.message,
      });
      return "kept" satisfies LifecycleOutcome;
    }
    yield* Effect.logInfo("boat.vm.lifecycle.stopped", { sandboxId: ref.sandboxId });
    return "stopped" satisfies LifecycleOutcome;
  });

  const remove = Effect.fn("BoatVmLifecycle.remove")(function* (
    provider: SandboxProviderShape,
    ref: SandboxRef,
    vm: { readonly running: boolean },
  ) {
    const sandboxId = ref.sandboxId;
    yield* input.beforeDelete(provider, ref, vm);
    const destroyed = yield* Effect.result(manager.destroy({ provider, ref }));
    if (destroyed._tag === "Failure") {
      yield* Effect.logWarning("boat.vm.lifecycle.deleteFailed", {
        sandboxId,
        error: destroyed.failure.message,
      });
      return "kept" satisfies LifecycleOutcome;
    }
    threadsByVm.delete(sandboxId);
    mirrorsByVm.delete(sandboxId);
    settledSince.delete(sandboxId);
    launchedAt.delete(sandboxId);
    yield* Effect.logInfo("boat.vm.lifecycle.deleted", { sandboxId });
    return "deleted" satisfies LifecycleOutcome;
  });

  /** Mirrors one running VM's threads, then applies the rules; a VM that cannot be read is kept. */
  const apply = Effect.fn("BoatVmLifecycle.apply")(function* (
    provider: SandboxProviderShape,
    ref: SandboxRef,
    idleMinutes: number,
  ) {
    const sandboxId = ref.sandboxId;
    const known = threadsByVm.get(sandboxId) ?? [];
    // Mirrored threads stay asked about until their copy is gone, so a failed
    // delete of a copy is retried.
    const asked = [...new Set([...known, ...(mirrorsByVm.get(sandboxId)?.keys() ?? [])])];
    const listed = yield* exec(provider, ref, VM_THREADS_SCRIPT, asked).pipe(
      Effect.flatMap((stdout) =>
        decodeVmThreads(stdout).pipe(Effect.mapError(() => problem("unexpected thread list"))),
      ),
      Effect.result,
    );
    if (listed._tag === "Failure") {
      yield* Effect.logDebug("boat.vm.lifecycle.unreadable", {
        sandboxId,
        problem: listed.failure.message,
      });
      return "kept" satisfies LifecycleOutcome;
    }
    const { departed, projects } = listed.success;
    const threads = listed.success.threads.filter((thread) => thread.parentThreadId === null);
    const subagents = listed.success.threads.filter((thread) => thread.parentThreadId !== null);
    const archived = departed.filter(
      (entry) => entry.state === "archived" && entry.parentThreadId === null,
    );
    const unknown = departed
      .filter((entry) => entry.state === "unknown" && entry.parentThreadId === null)
      .map(({ id }) => id);
    const deleted = departed.filter((entry) => entry.state === "deleted").map(({ id }) => id);
    // Copies of subagents made before they were skipped go like deleted threads' copies.
    const subagentCopies = [
      ...subagents,
      ...departed.filter((entry) => entry.parentThreadId !== null),
    ]
      .map(({ id }) => id)
      .filter((id) => mirrorsByVm.get(sandboxId)?.has(id) === true);
    threadsByVm.set(sandboxId, [
      ...threads.map((thread) => thread.id),
      ...archived.map(({ id }) => id),
      ...unknown,
    ]);

    // Also the final sync before a stop or delete, which follow in this pass.
    const problems = yield* mirror(
      provider,
      ref,
      [...threads, ...archived.map(({ id, version }) => ({ id, version: version ?? "" }))],
      [...deleted, ...subagentCopies],
      projects,
    );

    const settledThreads: Array<VmThread> = [];
    for (const thread of threads) {
      const copy = yield* copyStateOf(sandboxId, thread.id);
      settledThreads.push({ ...thread, settled: vmThreadSettled(thread, copy) });
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const action = decide({
      threads: settledThreads,
      subagents,
      archived: archived.map(({ id }) => id),
      unknown,
      hadThreads: asked.length > 0,
      nowMs,
      idleMinutes,
      launchedAtMs: launchedAt.get(sandboxId),
    });
    const allSettled =
      unknown.length === 0 &&
      settledThreads.length + archived.length > 0 &&
      settledThreads.every((thread) => thread.settled);
    if (!allSettled) settledSince.delete(sandboxId);

    if (action === "none") {
      if (problems.length > 0) {
        yield* Effect.logDebug("boat.vm.lifecycle.mirrorBehind", { sandboxId, problems });
      }
      return "kept" satisfies LifecycleOutcome;
    }
    if (action === "stop") {
      if (problems.length > 0) {
        yield* Effect.logWarning("boat.vm.lifecycle.stoppingBehind", { sandboxId, problems });
      }
      return yield* stop(provider, ref);
    }
    if (problems.length > 0) {
      yield* Effect.logWarning("boat.vm.lifecycle.kept", { sandboxId, problems });
      return "kept" satisfies LifecycleOutcome;
    }
    if (action === "delete") return yield* remove(provider, ref, { running: true });

    const since = settledSince.get(sandboxId) ?? nowMs;
    if (nowMs - since >= BOAT_VM_SETTLED_DELETE_AFTER_MS) {
      return yield* remove(provider, ref, { running: true });
    }
    // While the VM is stopped only its copies can change, so they must say
    // settled too; a copy someone reopens then keeps the VM.
    for (const threadId of [...threads.map(({ id }) => id), ...archived.map(({ id }) => id)]) {
      const copy = yield* copyStateOf(sandboxId, threadId);
      if (copy === null || copy.doneAtMs !== null) continue;
      const settled = yield* Effect.result(
        threadImport.settleCopy(boatVmThreadOriginKey(sandboxId, threadId), since),
      );
      if (settled._tag === "Failure") {
        yield* Effect.logWarning("boat.vm.lifecycle.settleCopyFailed", {
          sandboxId,
          threadId,
          error: settled.failure.message,
        });
        return "kept" satisfies LifecycleOutcome;
      }
    }
    settledSince.set(sandboxId, since);
    return yield* stop(provider, ref);
  });

  /**
   * Deletes a stopped VM once its copies stayed settled for the grace period;
   * a reopened copy keeps it. A VM stopped for being idle starts that period
   * once every thread it holds has a copy settled here.
   */
  const applyStopped = Effect.fn("BoatVmLifecycle.applyStopped")(function* (
    provider: SandboxProviderShape,
    ref: SandboxRef,
  ) {
    const sandboxId = ref.sandboxId;
    const since = settledSince.get(sandboxId);
    const known = threadsByVm.get(sandboxId) ?? [];
    let everyCopySettled = known.length > 0;
    for (const threadId of known) {
      const copy = yield* copyStateOf(sandboxId, threadId);
      if (copy === null) {
        everyCopySettled = false;
      } else if (copy.doneAtMs === null) {
        if (since !== undefined) {
          settledSince.delete(sandboxId);
          yield* Effect.logInfo("boat.vm.lifecycle.reopened", { sandboxId, threadId });
        }
        return "kept" satisfies LifecycleOutcome;
      }
    }
    const nowMs = yield* Clock.currentTimeMillis;
    if (since === undefined) {
      if (everyCopySettled) settledSince.set(sandboxId, nowMs);
      return "kept" satisfies LifecycleOutcome;
    }
    if (nowMs - since < BOAT_VM_SETTLED_DELETE_AFTER_MS) return "kept" satisfies LifecycleOutcome;
    return yield* remove(provider, ref, { running: false });
  });

  /** Forgets VMs that are gone and saves what changed. */
  const save = Effect.fn("BoatVmLifecycle.save")(function* (liveSandboxIds: ReadonlySet<string>) {
    for (const sandboxId of threadsByVm.keys()) {
      if (!liveSandboxIds.has(sandboxId)) threadsByVm.delete(sandboxId);
    }
    for (const sandboxId of mirrorsByVm.keys()) {
      if (!liveSandboxIds.has(sandboxId)) mirrorsByVm.delete(sandboxId);
    }
    for (const sandboxId of settledSince.keys()) {
      if (!liveSandboxIds.has(sandboxId)) settledSince.delete(sandboxId);
    }
    yield* publishFollowed();
    const contents = yield* encodeCurrent();
    if (contents === persisted) return;
    yield* writeFileStringAtomically({ filePath: input.statePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    persisted = contents;
  });

  return { apply, applyStopped, save, markLaunched };
});
