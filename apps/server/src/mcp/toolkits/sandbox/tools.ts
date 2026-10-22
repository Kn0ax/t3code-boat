import {
  OrchestratorMcpFailure,
  SandboxJob,
  SandboxJobCompleteInput,
  SandboxJobListInput,
  SandboxJobListResult,
  SandboxJobReadInput,
  SandboxJobReadResult,
  SandboxJobRefInput,
  SandboxJobResult,
  SandboxJobSendInput,
  SandboxJobStartInput,
  SandboxJobStatusInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as SandboxJobService from "../../../sandbox/SandboxJobService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  SandboxJobService.SandboxJobService,
];

const SandboxJobStartTool = Tool.make("sandbox_job_start", {
  description:
    "Start a sandbox job: a cloud sandbox node that gets a copy of this thread's workspace (uncommitted work included) and runs an agent on `task` there, in full-access mode. The node keeps its disk across runs: when a run ends it goes idle (and is stopped after a while), and sandbox_job_send continues it. The job lasts until sandbox_job_complete brings the work back as a git ref and destroys the node, or sandbox_job_discard destroys it without collecting. When a run ends, the starting thread gets a message with its result. Costs money while the node exists; complete or discard jobs you no longer need.",
  parameters: SandboxJobStartInput,
  success: SandboxJobResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [...dependencies, ProjectService.ProjectService],
})
  .annotate(Tool.Title, "Start a sandbox job")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const SandboxJobStatusTool = Tool.make("sandbox_job_status", {
  description:
    "Report a sandbox job's node state, threads and latest run result. With wait, waits for the active run to end (up to timeoutMs).",
  parameters: SandboxJobStatusInput,
  success: SandboxJobResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get sandbox job status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SandboxJobSendTool = Tool.make("sandbox_job_send", {
  description:
    "Send a follow-up to a sandbox job's node, resuming it first if it was stopped. By default the message continues the node's latest thread; newThread starts another thread on the same disk, optionally with another agent.",
  parameters: SandboxJobSendInput,
  success: SandboxJobResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Send to a sandbox job")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const SandboxJobCancelTool = Tool.make("sandbox_job_cancel", {
  description:
    "Interrupt the active run on a sandbox job's node. The node and its disk stay; use sandbox_job_discard to end the job.",
  parameters: SandboxJobRefInput,
  success: SandboxJob,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel a sandbox job's run")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const SandboxJobCompleteTool = Tool.make("sandbox_job_complete", {
  description:
    "Declare a sandbox job done: commit the node's work, bring it back to the local repository under refs/t3/sandbox/<jobId> (and an optional local branch, optionally pushed), then destroy the node. Wait for or cancel an active run first. If collecting fails, the node is kept so nothing is lost.",
  parameters: SandboxJobCompleteInput,
  success: SandboxJob,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Complete a sandbox job")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const SandboxJobDiscardTool = Tool.make("sandbox_job_discard", {
  description:
    "Destroy a sandbox job's node without bringing its work back. Anything not already collected is lost.",
  parameters: SandboxJobRefInput,
  success: SandboxJob,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Discard a sandbox job")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const SandboxJobListTool = Tool.make("sandbox_job_list", {
  description:
    "List this environment's sandbox jobs, newest first. Open jobs only unless includeFinished.",
  parameters: SandboxJobListInput,
  success: SandboxJobListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List sandbox jobs")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SandboxJobReadTool = Tool.make("sandbox_job_read", {
  description:
    "Read a thread on a sandbox job's node (its latest thread by default), with the same views and paging as t3_thread_read. Resumes a stopped node.",
  parameters: SandboxJobReadInput,
  success: SandboxJobReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a sandbox job's thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const SandboxToolkit = Toolkit.make(
  SandboxJobStartTool,
  SandboxJobStatusTool,
  SandboxJobSendTool,
  SandboxJobCancelTool,
  SandboxJobCompleteTool,
  SandboxJobDiscardTool,
  SandboxJobListTool,
  SandboxJobReadTool,
);
