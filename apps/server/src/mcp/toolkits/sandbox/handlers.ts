import {
  BoatVmListResult,
  BoatVmSaveSnapshotInput,
  BoatVmSnapshotState,
  BoatVmThreadLaunchInput,
  BoatVmThreadLaunchResult,
  OrchestratorMcpFailure,
  type BoatVmError,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Project from "../../../project/ProjectService.ts";
import * as BoatManagerLink from "../../../sandbox/BoatManagerLink.ts";
import * as BoatVmService from "../../../sandbox/BoatVmService.ts";
import type { SandboxNodeToolError } from "../../../sandbox/SandboxNodeMcp.ts";
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
const boatVms = BoatVmService.BoatVmService;
const boatVmFailure = (error: BoatVmError) =>
  new OrchestratorMcpFailure({ code: "sandbox_failed", message: error.message });
const isFailureCode = Schema.is(OrchestratorMcpFailure.fields.code);
/** The boat manager's own failure, as its tool reported it. */
const managerToolFailure = (error: SandboxNodeToolError) =>
  new OrchestratorMcpFailure({
    code: isFailureCode(error.code) ? error.code : "sandbox_failed",
    message: error.detail,
  });
const boatFailures = {
  BoatVmError: (error: BoatVmError) => Effect.fail(boatVmFailure(error)),
  SandboxNodeToolError: (error: SandboxNodeToolError) => Effect.fail(managerToolFailure(error)),
};
const NoParameters = Schema.Struct({});

/** Runs a boat VM tool on the linked boat manager when this server has one, else `here`. */
const onManagerOr = Effect.fn("mcp.sandbox.onManagerOr")(function* <
  P extends Schema.Top,
  S extends Schema.Top,
  A,
  E,
  R,
>(
  forward: {
    readonly tool: string;
    readonly parameters: P;
    readonly arguments: P["Type"];
    readonly result: S;
  },
  here: Effect.Effect<A, E, R>,
) {
  const link = yield* BoatManagerLink.BoatManagerLink;
  if (Option.isNone(yield* link.manager)) return yield* here;
  return yield* link.call(forward);
});

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
  // A boat VM this server launched calls these three back; see McpToolAccess.boatVmTool.
  boat_vm_list: McpToolAccess.boatVmTool("reads", () =>
    onManagerOr(
      {
        tool: "boat_vm_list",
        parameters: NoParameters,
        arguments: {},
        result: BoatVmListResult,
      },
      Effect.flatMap(boatVms, (vms) => vms.list),
    ).pipe(Effect.catchTags(boatFailures)),
  ),
  // Spends money and runs an agent on the VM, so only a full-access caller may.
  boat_vm_thread_launch: McpToolAccess.boatVmTool(
    "writesEnvironment",
    ({ projectId, scratch, repository, ...input }, caller) =>
      Effect.gen(function* () {
        const targets = [projectId !== undefined, scratch === true, repository !== undefined];
        if (targets.filter(Boolean).length > 1) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Pass only one of projectId, repository, or scratch:true.",
          });
        }
        // A boat VM's client reaches no projects here.
        if (caller === undefined && projectId !== undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "This MCP client launches by repository or scratch:true, not projectId.",
          });
        }
        const vms = yield* boatVms;
        const link = yield* BoatManagerLink.BoatManagerLink;
        const forward = (target: Pick<BoatVmThreadLaunchInput, "repository" | "scratch">) =>
          link.call({
            tool: "boat_vm_thread_launch",
            parameters: BoatVmThreadLaunchInput,
            arguments: { ...input, ...target },
            result: BoatVmThreadLaunchResult,
          });
        const linked = Option.isSome(yield* link.manager);
        if (repository !== undefined) {
          return yield* linked
            ? forward({ repository })
            : vms.launchThread({ ...input, projectId: null, repository });
        }
        const targetProjectId = scratch === true ? null : (projectId ?? caller?.caller?.projectId);
        if (targetProjectId === undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "target_required",
            message: "Pass projectId, or scratch:true for a thread without a project.",
          });
        }
        if (!linked) return yield* vms.launchThread({ ...input, projectId: targetProjectId });
        // The project is this server's; the manager checks out its repository instead.
        return yield* targetProjectId === null
          ? forward({ scratch: true })
          : vms
              .projectRepository(targetProjectId)
              .pipe(
                Effect.flatMap((projectRepository) => forward({ repository: projectRepository })),
              );
      }).pipe(Effect.catchTags(boatFailures)),
  ),
  // Both write into this environment's repositories or the boat account.
  boat_vm_bring_home: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const manager = yield* Effect.flatMap(
        BoatManagerLink.BoatManagerLink,
        (link) => link.manager,
      );
      if (Option.isSome(manager)) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `Bring home fetches into the boat manager's own checkout, so it runs there: use boat_vm_bring_home on ${new URL(manager.value).host}.`,
        });
      }
      return yield* Effect.flatMap(boatVms, (vms) => vms.bringHome(input));
    }).pipe(Effect.catchTags({ BoatVmError: boatFailures.BoatVmError })),
  ),
  boat_vm_save_snapshot: McpToolAccess.boatVmTool("writesEnvironment", (input) =>
    onManagerOr(
      {
        tool: "boat_vm_save_snapshot",
        parameters: BoatVmSaveSnapshotInput,
        arguments: input,
        result: BoatVmSnapshotState,
      },
      Effect.flatMap(boatVms, (vms) => vms.saveSnapshot(input)),
    ).pipe(Effect.catchTags(boatFailures)),
  ),
} satisfies McpToolAccess.Handlers<typeof SandboxToolkit.tools>;

export const layer = McpToolAccess.toLayer(SandboxToolkit, handlers);
