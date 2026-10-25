import { useAtomValue } from "@effect/atom-react";
import {
  boatVmConnectionUpdates,
  boatVmCopyTarget,
  boatVmInitialTransport,
  boatVmLabelUpdates,
  boatVmPairingInput,
  boatVmPairingOf,
  boatVmRunOnChoices,
  boatVmRunOnRow,
  boatVmSizeRows,
  type BoatVmPairing,
  type BoatVmRunOnRow,
} from "@t3tools/client-runtime/boat-vms";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createBoatVmEnvironmentAtoms } from "@t3tools/client-runtime/state/boat-vms";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  isBoatVmTailnetHostname,
  type BoatVm,
  type BoatVmBringHomeResult,
  type BoatVmLaunchInput,
  type BoatVmRepository,
  type SandboxJobSize,
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
import { useBoatVmHostEnvironmentId } from "./boatVmHost";
import { readBoatVmLaunch, startBoatVmLaunch, updateBoatVmLaunch } from "./boatVmLaunches";
import { readProjects, readThreadShell, waitForProject } from "./entities";
import { environmentPresentations } from "./presentation";
import { projectEnvironment } from "./projects";
import { useAtomCommand } from "./use-atom-command";
import { useEnvironmentQuery } from "./query";
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

const reconciledBoatVmStatuses = new Map<EnvironmentId, BoatVm["status"]>();

/**
 * Keeps saved VM environments in step with the managing host's VM list: named
 * after their VM, switched off while it is stopped, and removed once boat
 * deleted it (boatVmConnectionUpdates). It lists the VMs only while a VM is
 * saved here, and again when one stops answering, since boat stops idle VMs on
 * its own.
 */
export function useBoatVmSavedEnvironments(): void {
  const hostId = useBoatVmHostEnvironmentId();
  const pairings = useBoatVmPairings();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const vmIds = pairings
    .filter(
      (pairing) =>
        pairing.recorded !== null ||
        (pairing.hostname !== null && isBoatVmTailnetHostname(pairing.hostname)),
    )
    .map((pairing) => pairing.environmentId);
  const vmsQuery = useEnvironmentQuery(
    hostId === null || vmIds.length === 0
      ? null
      : boatVmEnvironment.list({ environmentId: hostId, input: {} }),
  );
  const vms = vmsQuery.data?.available === true ? vmsQuery.data.vms : undefined;
  const failingKey = vmIds
    .filter((id) => {
      const phase = presentations.get(id)?.connection.phase;
      return phase === "reconnecting" || phase === "error";
    })
    .join(",");

  useEffect(() => {
    if (hostId === null || failingKey === "") return;
    appAtomRegistry.refresh(boatVmEnvironment.list({ environmentId: hostId, input: {} }));
  }, [hostId, failingKey]);

  // Only a new list reconciles: a VM paired since the last one is not on it yet.
  useEffect(() => {
    if (hostId === null || vms === undefined) return;
    const { entries } = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    for (const update of boatVmLabelUpdates(entries.values(), vms)) {
      void runAtomCommand(appAtomRegistry, environmentCatalog.setLabel, update, {
        reportFailure: false,
      });
    }
    for (const { type, environmentId } of boatVmConnectionUpdates(
      entries.values(),
      vms,
      hostId,
      reconciledBoatVmStatuses,
    )) {
      void (type === "remove"
        ? runAtomCommand(appAtomRegistry, environmentCatalog.remove, environmentId, {
            reportFailure: false,
          })
        : runAtomCommand(
            appAtomRegistry,
            environmentCatalog.setEnabled,
            { environmentId, enabled: type === "enable" },
            { reportFailure: false },
          ));
    }
  }, [hostId, vms]);
}

/**
 * Lists the boat VMs again when "Run on" opens on entries for them: views keep
 * the list loaded, and boat stops idle VMs on its own, so it can say a stopped
 * VM still runs.
 */
export function useRefreshBoatVmsOnOpen(
  environments: ReadonlyArray<EnvironmentOption> | undefined,
): (open: boolean) => void {
  const hostId = useBoatVmHostEnvironmentId();
  return (open) => {
    if (!open || hostId === null) return;
    if (!environments?.some((environment) => environment.boatVmNote !== undefined)) return;
    appAtomRegistry.refresh(boatVmEnvironment.list({ environmentId: hostId, input: {} }));
  };
}

/**
 * "Run on" with the boat VMs folded in, as boatVmRunOnChoices picks them, and
 * "New boat VM" for a draft in a repository or, `scratch`, without a project:
 * one entry per size once the host's boat VM size (`defaultSize`) is known.
 */
export function boatVmRunOnOptions(
  environments: ReadonlyArray<EnvironmentOption>,
  vms: ReadonlyArray<BoatVm>,
  hostnameOf: (environmentId: EnvironmentId) => string | null,
  newVm: {
    readonly disabledReason?: string | undefined;
    readonly scratch: boolean;
    readonly defaultSize?: SandboxJobSize | undefined;
  },
  inventory?: Parameters<typeof boatVmRunOnChoices>[3],
): EnvironmentOption[] {
  const choices = boatVmRunOnChoices(environments, vms, hostnameOf, inventory);
  return [
    ...choices.machines.map(({ pairedBoatVm, ...machine }) => {
      if (pairedBoatVm === undefined) return machine;
      const row = boatVmRunOnRow(pairedBoatVm);
      return { ...machine, label: row.title, boatVmNote: row.note, boatVmStatus: row.status };
    }),
    ...choices.vms.map((vm) => entry(vm.sandboxId, boatVmRunOnRow(vm))),
    ...(newVm.disabledReason !== undefined || newVm.defaultSize === undefined
      ? [newBoatVmEntry(newVm.disabledReason, newVm.scratch)]
      : boatVmSizeRows(newVm.defaultSize).map(({ size, label, note }) => ({
          ...entry(null, { title: `New boat VM · ${label}`, note }),
          environmentId: EnvironmentId.make(`boat-vm:new:${size}`),
          boatVm: { sandboxId: null, size },
        }))),
  ];
}

const entry = (sandboxId: string | null, row: BoatVmRunOnRow): EnvironmentOption => ({
  environmentId: EnvironmentId.make(`boat-vm:${sandboxId ?? "new"}`),
  projectId: null,
  label: row.title,
  isPrimary: false,
  machine: "cloud",
  boatVm: { sandboxId },
  boatVmNote: row.note,
  ...(row.status === undefined ? {} : { boatVmStatus: row.status }),
});

/** The "New boat VM" entry, shown with the reason when it cannot be used. */
export const newBoatVmEntry = (
  disabledReason: string | undefined,
  scratch: boolean,
): EnvironmentOption => ({
  ...entry(null, boatVmRunOnRow(null, { scratch })),
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
  /** A new VM's size; omitted uses the host's boat VM size. */
  readonly size?: SandboxJobSize;
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
        ...(input.size === undefined ? {} : { size: input.size }),
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
    // Pairing again keeps a saved VM switched off, as it was while stopped.
    await runAtomCommand(
      appAtomRegistry,
      environmentCatalog.setEnabled,
      { environmentId, enabled: true },
      { reportFailure: false },
    );
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
