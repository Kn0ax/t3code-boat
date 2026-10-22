/**
 * The lifecycle rules for one running boat VM, from the threads on it. A VM
 * holds every thread of one repository, so a rule about "the thread" applies
 * to the VM once it holds for all of its threads:
 *
 * - every thread deleted: delete the VM;
 * - every thread archived: copy them home, then delete the VM;
 * - every thread snoozed or quiet for `idleMinutes`: stop the VM.
 *
 * Archived threads are copied home as soon as they are seen, whatever the
 * others do, so the copy exists before anything deletes the VM.
 */
import * as Schema from "effect/Schema";

export const VmThread = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  status: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
  snoozedUntil: Schema.NullOr(Schema.String),
  latestUserMessageAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type VmThread = typeof VmThread.Type;

export const VmThreads = Schema.Struct({
  threads: Schema.Array(VmThread),
  projects: Schema.Array(
    Schema.Struct({ id: Schema.String, remoteUrl: Schema.NullOr(Schema.String) }),
  ),
});
export type VmThreads = typeof VmThreads.Type;

/** Thread statuses with a run in flight; "waiting" is a run waiting on the user's answer. */
const BUSY_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

export interface VmDecision {
  readonly action: "none" | "stop" | "delete";
  /** Archived threads to copy home first; a delete waits until every copy succeeded. */
  readonly copy: ReadonlyArray<VmThread>;
}

export function decide(input: {
  readonly threads: ReadonlyArray<VmThread>;
  /** True once a thread was ever seen on this VM, so a fresh VM is not taken for an emptied one. */
  readonly hadThreads: boolean;
  readonly copied: ReadonlySet<string>;
  readonly nowMs: number;
  readonly idleMinutes: number;
}): VmDecision {
  const archived = input.threads.filter((thread) => thread.archivedAt !== null);
  const copy = archived.filter((thread) => !input.copied.has(thread.id));
  if (input.threads.length === 0) {
    return { action: input.hadThreads ? "delete" : "none", copy };
  }
  const active = input.threads.filter((thread) => thread.archivedAt === null);
  if (active.length === 0) return { action: "delete", copy };

  const now = input.nowMs;
  const quietSince = now - input.idleMinutes * 60_000;
  const resting = (thread: VmThread) =>
    (thread.snoozedUntil !== null && Date.parse(thread.snoozedUntil) > now) ||
    (!BUSY_STATUSES.has(thread.status) &&
      Date.parse(thread.latestUserMessageAt ?? thread.createdAt) <= quietSince);
  return { action: active.every(resting) ? "stop" : "none", copy };
}
