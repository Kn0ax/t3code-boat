import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SandboxJobProviderId, SandboxJobSize } from "./sandboxJobSettings.ts";
import {
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
} from "./orchestratorMcp.ts";

/**
 * A sandbox job is an ephemeral node: one cloud sandbox and its disk, holding
 * one job until an agent or the user says the job is done. Runs come and go on
 * it; the node stops when idle and resumes on the next run.
 */
export const SandboxJobId = TrimmedNonEmptyString.pipe(Schema.brand("SandboxJobId"));
export type SandboxJobId = typeof SandboxJobId.Type;

/**
 * - `provisioning` / `preparing`: the sandbox and its workspace are being made.
 * - `running`: a run is active on the node.
 * - `idle`: no run is active; the node is up.
 * - `stopped`: idle long enough to be stopped; its disk is kept.
 * - `collecting`: the job was declared done and its work is coming back.
 * - `completed` / `discarded` / `failed`: the node is gone (or failed to come up).
 */
export const SandboxJobState = Schema.Literals([
  "provisioning",
  "preparing",
  "running",
  "idle",
  "stopped",
  "collecting",
  "completed",
  "discarded",
  "failed",
]);
export type SandboxJobState = typeof SandboxJobState.Type;

export const isSandboxJobFinished = (state: SandboxJobState): boolean =>
  state === "completed" || state === "discarded" || state === "failed";

/** Agents a node can run. Each needs an agent key saved for sandboxes. */
export const SandboxJobAgent = Schema.Literals(["claude", "codex"]);
export type SandboxJobAgent = typeof SandboxJobAgent.Type;

/** A thread on the node's own T3 server. Its id belongs to that server, not this one. */
export const SandboxJobThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  agent: SandboxJobAgent,
});
export type SandboxJobThread = typeof SandboxJobThread.Type;

export const SandboxJob = Schema.Struct({
  jobId: SandboxJobId,
  title: Schema.String,
  /** The local thread that started the job, when an agent in one did. */
  parentThreadId: Schema.NullOr(ThreadId),
  providerId: SandboxJobProviderId,
  size: SandboxJobSize,
  state: SandboxJobState,
  sandboxId: Schema.NullOr(Schema.String),
  threads: Schema.Array(SandboxJobThread),
  /** The node thread whose run is active, while `running`. */
  activeThreadId: Schema.NullOr(ThreadId),
  /** The latest finished run's status and final answer. */
  lastRunStatus: Schema.NullOr(Schema.String),
  lastSummary: Schema.NullOr(Schema.String),
  /** Where the collected work is in the local repository, once the job is done. */
  resultRef: Schema.NullOr(Schema.String),
  resultBranch: Schema.NullOr(Schema.String),
  pushed: Schema.Boolean,
  /** What went wrong (a node that failed, a branch or push that did not happen), in fixed wording. */
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  expiresAt: Schema.String,
});
export type SandboxJob = typeof SandboxJob.Type;

const Prompt = TrimmedNonEmptyString.check(Schema.isMaxLength(120_000));
const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const ClientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
  description: "Stable idempotency key to reuse when retrying this call.",
});
const WaitTimeoutMs = PositiveInt.check(Schema.isLessThanOrEqualTo(30 * 60_000)).annotate({
  description: "How long to wait for the active run, in ms. Defaults to 10 minutes.",
});
const LocalBranchName = TrimmedNonEmptyString.check(Schema.isMaxLength(200));

export const SandboxJobStartInput = Schema.Struct({
  task: Prompt.annotate({
    description:
      "The complete task for the node's agent. It sees only this text and a copy of the workspace, not this conversation.",
  }),
  title: Schema.optional(Title),
  projectId: Schema.optional(
    ProjectId.annotate({
      description:
        "Only for callers outside a T3 thread: the project whose workspace the node copies. A thread's own workspace is used otherwise.",
    }),
  ),
  provider: Schema.optional(SandboxJobProviderId),
  size: Schema.optional(SandboxJobSize),
  agent: Schema.optional(SandboxJobAgent),
  model: Schema.optional(TrimmedNonEmptyString),
  wait: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Wait for the first run to finish (up to timeoutMs) instead of returning at once.",
    }),
  ),
  timeoutMs: Schema.optional(WaitTimeoutMs),
  clientRequestId: Schema.optional(ClientRequestId),
});
export type SandboxJobStartInput = typeof SandboxJobStartInput.Type;

export const SandboxJobStatusInput = Schema.Struct({
  jobId: SandboxJobId,
  wait: Schema.optional(Schema.Boolean),
  timeoutMs: Schema.optional(WaitTimeoutMs),
});
export type SandboxJobStatusInput = typeof SandboxJobStatusInput.Type;

export const SandboxJobSendInput = Schema.Struct({
  jobId: SandboxJobId,
  message: Prompt,
  /** Omit to continue the node's latest thread. */
  newThread: Schema.optional(
    Schema.Struct({
      agent: Schema.optional(SandboxJobAgent),
      model: Schema.optional(TrimmedNonEmptyString),
      title: Schema.optional(Title),
    }),
  ),
  wait: Schema.optional(Schema.Boolean),
  timeoutMs: Schema.optional(WaitTimeoutMs),
});
export type SandboxJobSendInput = typeof SandboxJobSendInput.Type;

export const SandboxJobRefInput = Schema.Struct({ jobId: SandboxJobId });
export type SandboxJobRefInput = typeof SandboxJobRefInput.Type;

export const SandboxJobCompleteInput = Schema.Struct({
  jobId: SandboxJobId,
  branch: Schema.optional(
    LocalBranchName.annotate({
      description:
        "Also create this local branch at the collected work. The work is always kept under refs/t3/sandbox/<jobId>.",
    }),
  ),
  push: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Push that branch to the repository's origin with this machine's git credentials.",
    }),
  ),
});
export type SandboxJobCompleteInput = typeof SandboxJobCompleteInput.Type;

export const SandboxJobListInput = Schema.Struct({
  includeFinished: Schema.optional(Schema.Boolean),
});
export type SandboxJobListInput = typeof SandboxJobListInput.Type;

export const SandboxJobReadInput = Schema.Struct({
  jobId: SandboxJobId,
  /** A node thread; defaults to its latest. */
  threadId: Schema.optional(ThreadId),
  view: OrchestratorMcpThreadReadInput.fields.view,
  afterPosition: Schema.optional(NonNegativeInt),
});
export type SandboxJobReadInput = typeof SandboxJobReadInput.Type;

export const SandboxJobResult = Schema.Struct({
  job: SandboxJob,
  waitTimedOut: Schema.Boolean,
});
export type SandboxJobResult = typeof SandboxJobResult.Type;

export const SandboxJobListResult = Schema.Struct({ jobs: Schema.Array(SandboxJob) });
export const SandboxJobReadResult = OrchestratorMcpThreadReadResult;
