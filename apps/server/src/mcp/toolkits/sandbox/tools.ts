import {
  BoatVmBringHomeInput,
  BoatVmBringHomeResult,
  BoatVmListResult,
  BoatVmSaveSnapshotInput,
  BoatVmSnapshotState,
  BoatVmThreadContinueInput,
  BoatVmThreadContinueResult,
  BoatVmThreadLaunchInput,
  BoatVmThreadLaunchResult,
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
import * as BoatManagerLink from "../../../sandbox/BoatManagerLink.ts";
import * as BoatVmService from "../../../sandbox/BoatVmService.ts";
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

const boatVmDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  BoatVmService.BoatVmService,
  BoatManagerLink.BoatManagerLink,
];

/** Said by every boat VM tool that a linked server forwards. */
const ON_MANAGER =
  " On a server without a boat key that is linked to a boat manager (Settings, Sandbox jobs), this runs on the manager: its VMs, its boat account, and its copies of VM threads.";

const BoatVmListTool = Tool.make("boat_vm_list", {
  description:
    "List the boat VMs this environment made (label and status: running, stopped, creating or destroyed). available is false until a boat key is saved in Settings. A boat VM is a full T3 environment of its own: threads that run on it live in the VM's T3, not here; a user starts one from Run on in a new thread, and an agent with boat_vm_thread_launch. This server mirrors each running VM's threads about every 3 minutes into this environment's project for the same repository (or its No project when there is none); deleted threads are not copied, and deleting a thread on the VM deletes its copy. It also manages each running VM by its threads, after one last sync: once every thread is snoozed or has had no message for the idle window, the VM stops and keeps its disk (Run on or Start VM resumes it); once every thread is archived, settled or deleted, the VM is deleted, unless a copy failed, in which case it is kept. A copy keeps the conversation, not the VM's files: use boat_vm_bring_home first for commits." +
    ON_MANAGER,
  success: BoatVmListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: boatVmDependencies,
})
  .annotate(Tool.Title, "List boat VMs")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const BoatVmThreadLaunchTool = Tool.make("boat_vm_thread_launch", {
  description:
    "Start a new thread on a boat VM, like Run on in a new thread: creates a VM (or resumes sandboxId), checks out the project's repository there (the calling thread's project unless projectId; scratch:true for none), then starts a thread with message in the VM's own T3. Omitted modelSelection takes the VM project's default model; omitted modes are full-access and default. The thread lives on the VM: threadId and projectId are the VM's, and this environment gets a copy within about 3 minutes (see boat_vm_list). Uncommitted local changes are not copied; the VM pulls the remote. Costs money while the VM runs." +
    ON_MANAGER +
    " The project's repository is sent there, and the manager's copy lands in its own project for that repository, or its No project when it has none.",
  parameters: BoatVmThreadLaunchInput,
  success: BoatVmThreadLaunchResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: boatVmDependencies,
})
  .annotate(Tool.Title, "Start a thread on a boat VM")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const BoatVmThreadContinueTool = Tool.make("boat_vm_thread_continue", {
  description:
    "Continue a copy of a boat VM thread whose VM was deleted (threadId is the copy's import:boat-vm:… id here) on a new boat VM, since such a copy takes no messages here: creates a VM for the copy's repository (or Scratch), restores the commits the old VM brought home, puts the conversation into the VM's own T3, and sends message there. threadId in the result is the VM's; the copy here is removed and comes back as the copy of the new VM's thread within about 3 minutes. A copy that was continued here is an ordinary thread and is refused. Costs money while the VM runs. On a server linked to a boat manager, it refuses: copies live on the manager.",
  parameters: BoatVmThreadContinueInput,
  success: BoatVmThreadContinueResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: boatVmDependencies,
})
  .annotate(Tool.Title, "Continue a boat VM thread on a new VM")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const BoatVmBringHomeTool = Tool.make("boat_vm_bring_home", {
  description:
    "Fetch the branches of every checkout on a boat VM into this environment's checkout of the same repository, as refs/t3/boat/<sandboxId>/<branch>. Resumes a stopped VM. Nothing is pushed, the local checkout is not touched, and uncommitted files stay on the VM. unmatched lists VM checkouts with no project here. On a server linked to a boat manager, it refuses: run it on the manager, whose checkout it fetches into.",
  parameters: BoatVmBringHomeInput,
  success: BoatVmBringHomeResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: boatVmDependencies,
})
  .annotate(Tool.Title, "Bring boat VM work home")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const BoatVmSaveSnapshotTool = Tool.make("boat_vm_save_snapshot", {
  description:
    "Start saving a boat VM's disk as a named boat snapshot. New VMs for a repository start from t3-<owner>-<repo> (lowercase), so saving under that name makes the next launch start from this VM. Reusing a name replaces that snapshot once the new one is ready. Returns while boat is still saving, which can take several minutes." +
    ON_MANAGER,
  parameters: BoatVmSaveSnapshotInput,
  success: BoatVmSnapshotState,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: boatVmDependencies,
})
  .annotate(Tool.Title, "Save a boat VM as a snapshot")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
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
  BoatVmListTool,
  BoatVmThreadLaunchTool,
  BoatVmThreadContinueTool,
  BoatVmBringHomeTool,
  BoatVmSaveSnapshotTool,
);
