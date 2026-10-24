import { useAtomValue } from "@effect/atom-react";
import {
  boatVmCopyTarget,
  boatVmInitialTransport,
  boatVmLabelUpdates,
  boatVmPairingInput,
  boatVmPairingOf,
  boatVmRunOnChoices,
  boatVmRunOnLabel,
  type BoatVmPairing,
} from "@t3tools/client-runtime/boat-vms";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createBoatVmEnvironmentAtoms } from "@t3tools/client-runtime/state/boat-vms";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  type BoatVm,
  type BoatVmBringHomeResult,
  type BoatVmLaunchInput,
  type BoatVmRepository,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useEffect } from "react";

import type { EnvironmentOption } from "../components/BranchToolbar.logic";
import { environmentCatalog } from "../connection/catalog";
import { connectPairing } from "../connection/onboarding";
import { connectionAtomRuntime } from "../connection/runtime";
import { inferProjectTitleFromPath } from "../lib/projectPaths";
import { isElectron } from "../env";
import { newProjectId, randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readBoatVmLaunch, startBoatVmLaunch, updateBoatVmLaunch } from "./boatVmLaunches";
import { readProjects, readThreadShell, waitForProject } from "./entities";
import { environmentPresentations } from "./presentation";
import { projectEnvironment } from "./projects";
import { useAtomCommand } from "./use-atom-command";
import { readEnvironmentScope, readPreparedConnection } from "./session";
import { waitForAtomValue } from "./waitForAtomValue";

export const boatVmEnvironment = createBoatVmEnvironmentAtoms(connectionAtomRuntime);

/** The toast text for work a VM brought home. */
export function describeBroughtHome(result: BoatVmBringHomeResult): string {
  const lines = result.checkouts.map(
    (checkout) =>
      `${checkout.refs.join(", ")} in ${checkout.repositoryRoot}${
        checkout.uncommitted ? ". Uncommitted changes stayed on the VM" : ""
      }.`,
  );
  if (result.unmatched.length > 0) {
    lines.push(`No local project for ${result.unmatched.join(", ")}.`);
  }
  return lines.join(" ");
}

/** Every saved environment's pairing, read from the saved connections alone. */
export function useBoatVmPairings(): ReadonlyArray<BoatVmPairing> {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  return [...catalog.entries.values()].map(boatVmPairingOf);
}

/** boatVmCopyTarget for a thread action, read from the current state. */
export const readBoatVmCopyTarget = (target: ScopedThreadRef): ScopedThreadRef =>
  boatVmCopyTarget({
    target,
    canOperate: readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope),
    pairings: [...appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.values()].map(
      boatVmPairingOf,
    ),
    hasThread: (ref) => readThreadShell(ref) !== null,
  });

/**
 * Names saved VM environments after their VM once the managing host's VM list
 * has loaded; it fetches nothing itself.
 */
export function useBoatVmEnvironmentLabels(vms: ReadonlyArray<BoatVm> | undefined): void {
  useEffect(() => {
    if (vms === undefined) return;
    const { entries } = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    for (const update of boatVmLabelUpdates(entries.values(), vms)) {
      void runAtomCommand(appAtomRegistry, environmentCatalog.setLabel, update, {
        reportFailure: false,
      });
    }
  }, [vms]);
}

/** "Run on" with the boat VMs folded in, as boatVmRunOnChoices picks them, and "New boat VM". */
export function boatVmRunOnOptions(
  environments: ReadonlyArray<EnvironmentOption>,
  vms: ReadonlyArray<BoatVm>,
  hostnameOf: (environmentId: EnvironmentId) => string | null,
  newVmDisabledReason?: string,
  inventory?: Parameters<typeof boatVmRunOnChoices>[3],
): EnvironmentOption[] {
  const choices = boatVmRunOnChoices(environments, vms, hostnameOf, inventory);
  return [
    ...choices.machines,
    ...choices.vms.map((vm) => entry(vm.sandboxId, boatVmRunOnLabel(vm))),
    newBoatVmEntry(newVmDisabledReason),
  ];
}

const entry = (sandboxId: string | null, label: string): EnvironmentOption => ({
  environmentId: EnvironmentId.make(`boat-vm:${sandboxId ?? "new"}`),
  projectId: null,
  label,
  isPrimary: false,
  machine: "cloud",
  boatVm: { sandboxId },
});

/** The "New boat VM" entry, shown with the reason when it cannot be used. */
export const newBoatVmEntry = (disabledReason?: string): EnvironmentOption => ({
  ...entry(null, "New boat VM"),
  ...(disabledReason === undefined ? {} : { disabledReason }),
});

// Covers the VM's first TLS certificate from Tailscale and the initial sync.
const CONNECT_TIMEOUT_MS = 60_000;

const toError = (failure: unknown, fallback: string) =>
  failure instanceof Error ? failure : new Error(fallback);

type LaunchInput = {
  readonly hostEnvironmentId: EnvironmentId;
  readonly sandboxId: string | null;
  readonly repository: BoatVmRepository | null;
  readonly bannerKey: string;
};

/**
 * Starts a boat VM through `hostEnvironmentId` and pairs with it once it is
 * connected; `extra` adds to the launch request. Throws with the reason.
 */
function useLaunchAndPairBoatVm() {
  const launch = useAtomCommand(boatVmEnvironment.launch, { reportFailure: false });
  const pair = useAtomCommand(connectPairing, { reportFailure: false });
  return async (
    input: LaunchInput,
    launchId: string,
    extra: Pick<BoatVmLaunchInput, "continueThreadId" | "message"> = {},
  ) => {
    const launched = await launch({
      environmentId: input.hostEnvironmentId,
      input: {
        transport: boatVmInitialTransport(window.location.protocol, isElectron),
        ...(input.sandboxId === null ? {} : { sandboxId: input.sandboxId }),
        ...(input.repository === null ? {} : { repository: input.repository }),
        launchId,
        ...extra,
      },
    });
    // A new VM exists even when its launch failed, and a resume changes the status.
    appAtomRegistry.refresh(
      boatVmEnvironment.list({ environmentId: input.hostEnvironmentId, input: {} }),
    );
    if (launched._tag === "Failure") {
      throw toError(squashAtomCommandFailure(launched), "Could not start the boat VM.");
    }
    const vm = launched.value;
    updateBoatVmLaunch(input.bannerKey, launchId, { phase: "connecting" });

    const paired = await pair(
      boatVmPairingInput(
        vm,
        input.hostEnvironmentId,
        readPreparedConnection(input.hostEnvironmentId)?.httpBaseUrl ?? null,
      ),
    );
    if (paired._tag === "Failure") {
      throw toError(squashAtomCommandFailure(paired), "Could not pair with the boat VM.");
    }
    const environmentId = paired.value;
    const connected = await waitForAtomValue({
      registry: appAtomRegistry,
      atom: environmentPresentations.presentationsAtom,
      predicate: (presentations) =>
        presentations.get(environmentId)?.connection.phase === "connected",
      timeoutMs: CONNECT_TIMEOUT_MS,
    });
    if (!connected) throw new Error(`${vm.label} did not connect.`);
    return { vm, environmentId };
  };
}

/**
 * Runs a launch with its progress and failure in the banner of the composer
 * `input.bannerKey` names; a failed or cancelled launch resolves to null.
 */
async function withLaunchBanner<A>(
  input: LaunchInput,
  run: (launchId: string) => Promise<A>,
): Promise<A | null> {
  const launchId = randomUUID();
  startBoatVmLaunch(input.bannerKey, {
    launchId,
    hostEnvironmentId: input.hostEnvironmentId,
    repositoryName: input.repository?.name ?? null,
    newVm: input.sandboxId === null,
    phase: "launching",
  });
  try {
    const launched = await run(launchId);
    updateBoatVmLaunch(input.bannerKey, launchId, null);
    return launched;
  } catch (error) {
    const current = readBoatVmLaunch(input.bannerKey);
    const cancelled = current?.launchId === launchId && current.phase === "cancelling";
    updateBoatVmLaunch(
      input.bannerKey,
      launchId,
      cancelled
        ? null
        : {
            phase: "failed",
            error: error instanceof Error ? error.message : "An error occurred.",
          },
    );
    return null;
  }
}

/**
 * Starts (or resumes) a boat VM through `hostEnvironmentId`, pairs with it,
 * and returns the VM's project for the repository, creating it the first time,
 * with the launch's warning about the checkout, if any. Without a repository
 * the project is the VM's Scratch project, as for a "No project" thread. Progress and failure
 * show in the banner of the composer `bannerKey` names; a failed or cancelled
 * launch resolves to null.
 */
export function useLaunchBoatVm() {
  const launchAndPair = useLaunchAndPairBoatVm();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });

  type Launched = {
    readonly project: EnvironmentProject;
    readonly projectRef: ScopedProjectRef;
    readonly warning: string | undefined;
  };

  const run = async (input: LaunchInput, launchId: string): Promise<Launched> => {
    const { vm, environmentId } = await launchAndPair(input, launchId);
    if (input.repository === null) {
      const scratch = await openScratch({ environmentId, input: {} });
      if (scratch._tag === "Failure") {
        throw toError(
          squashAtomCommandFailure(scratch),
          "Could not start without a project on the VM.",
        );
      }
      return {
        project: scratch.value,
        projectRef: scopeProjectRef(environmentId, scratch.value.id),
        warning: vm.warning,
      };
    }

    const existing = readProjects().find(
      (project) =>
        project.environmentId === environmentId && project.workspaceRoot === vm.workspaceRoot,
    );
    if (existing !== undefined) {
      return {
        project: existing,
        projectRef: scopeProjectRef(environmentId, existing.id),
        warning: vm.warning,
      };
    }

    const projectId = newProjectId();
    const created = await createProject({
      environmentId,
      input: {
        projectId,
        title: inferProjectTitleFromPath(vm.workspaceRoot),
        workspaceRoot: vm.workspaceRoot,
        createWorkspaceRootIfMissing: false,
        defaultModelSelection: null,
      },
    });
    if (created._tag === "Failure") {
      throw toError(squashAtomCommandFailure(created), "Could not open the repository on the VM.");
    }
    const projectRef = scopeProjectRef(environmentId, projectId);
    const project = await waitForProject(projectRef);
    return { project, projectRef, warning: vm.warning };
  };

  return (input: LaunchInput): Promise<Launched | null> =>
    withLaunchBanner(input, (launchId) => run(input, launchId));
}

/**
 * Continues a copy whose boat VM was deleted on a new VM, sending `message`
 * there, and returns the thread on that VM once this client paired with it.
 * The host picks the repository from the copy; `repository` only names the
 * launch in the banner. A failed or cancelled launch resolves to null.
 */
export function useContinueBoatVmCopy() {
  const launchAndPair = useLaunchAndPairBoatVm();
  return (
    input: Omit<LaunchInput, "sandboxId"> & {
      readonly copyThreadId: ThreadId;
      readonly message: string | null;
    },
  ): Promise<{
    readonly threadRef: ScopedThreadRef;
    readonly warning: string | undefined;
  } | null> =>
    withLaunchBanner({ ...input, sandboxId: null }, async (launchId) => {
      // The host picks the repository from the copy.
      const target = { ...input, sandboxId: null, repository: null };
      const { vm, environmentId } = await launchAndPair(target, launchId, {
        continueThreadId: input.copyThreadId,
        ...(input.message === null ? {} : { message: input.message }),
      });
      if (vm.threadId === undefined) {
        throw new Error("The environment that holds the boat key cannot continue threads yet.");
      }
      return { threadRef: scopeThreadRef(environmentId, vm.threadId), warning: vm.warning };
    });
}
