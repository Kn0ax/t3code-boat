import { OrchestratorMcpFailure, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Project from "../../../project/ProjectService.ts";
import * as SandboxJobService from "../../../sandbox/SandboxJobService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable, type Caller } from "../../threadAccess.ts";
import { SandboxToolkit } from "./tools.ts";

/** The checkout a job copies: the calling thread's worktree or project, else the named project. */
const workspaceRootFor = Effect.fn("mcp.sandbox.workspaceRoot")(function* (
  caller: Caller,
  projectId: ProjectId | undefined,
) {
  if (caller.caller?.worktreePath != null) return caller.caller.worktreePath;
  const targetProjectId = caller.caller?.projectId ?? projectId;
  if (targetProjectId === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "target_required",
      message: "Pass projectId: the project whose workspace the sandbox node should copy.",
    });
  }
  const projects = yield* Project.ProjectService;
  const project = yield* projects.getById(targetProjectId).pipe(Effect.mapError(unavailable));
  if (Option.isNone(project)) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The project was not found.",
    });
  }
  return project.value.workspaceRoot;
});

const service = SandboxJobService.SandboxJobService;

const handlers = {
  // Spends money and runs a full-access agent, so only a full-access caller may.
  sandbox_job_start: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const caller = yield* check;
      const workspaceRoot = yield* workspaceRootFor(caller, input.projectId);
      const jobs = yield* service;
      return yield* jobs.start(input, {
        parentThreadId: caller.caller?.id ?? null,
        workspaceRoot,
        requestKey:
          input.clientRequestId === undefined
            ? null
            : `${caller.scope.requestNamespace}:${input.clientRequestId}`,
      });
    }),
  ),
  sandbox_job_status: McpToolAccess.reads((input) =>
    readCaller().pipe(
      Effect.andThen(service),
      Effect.flatMap((jobs) => jobs.status(input)),
    ),
  ),
  sandbox_job_send: McpToolAccess.writesEnvironment((input) =>
    Effect.flatMap(service, (jobs) => jobs.send(input)),
  ),
  sandbox_job_cancel: McpToolAccess.writes((input) =>
    Effect.flatMap(service, (jobs) => jobs.cancel(input.jobId)),
  ),
  sandbox_job_complete: McpToolAccess.writesEnvironment((input) =>
    Effect.flatMap(service, (jobs) => jobs.complete(input)),
  ),
  sandbox_job_discard: McpToolAccess.writesEnvironment((input) =>
    Effect.flatMap(service, (jobs) => jobs.discard(input.jobId)),
  ),
  sandbox_job_list: McpToolAccess.reads((input) =>
    readCaller().pipe(
      Effect.andThen(service),
      Effect.flatMap((jobs) => jobs.list({ includeFinished: input.includeFinished ?? false })),
      Effect.map((jobs) => ({ jobs })),
    ),
  ),
  sandbox_job_read: McpToolAccess.reads((input) =>
    readCaller().pipe(
      Effect.andThen(service),
      Effect.flatMap((jobs) => jobs.read(input)),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof SandboxToolkit.tools>;

export const layer = McpToolAccess.toLayer(SandboxToolkit, handlers);
