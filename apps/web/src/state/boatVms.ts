import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  boatVmMatchesTailnetHostname,
  EnvironmentId,
  isBoatVmTailnetHostname,
  WS_METHODS,
  type BoatVm,
  type BoatVmBringHomeResult,
  type BoatVmRepository,
  type ScopedProjectRef,
} from "@t3tools/contracts";

import type { EnvironmentOption } from "../components/BranchToolbar.logic";
import { connectPairing } from "../connection/onboarding";
import { connectionAtomRuntime } from "../connection/runtime";
import { inferProjectTitleFromPath } from "../lib/projectPaths";
import { isElectron } from "../env";
import { boatProxyBaseUrl } from "@t3tools/shared/boatProxy";
import { newProjectId, randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readBoatVmLaunch, startBoatVmLaunch, updateBoatVmLaunch } from "./boatVmLaunches";
import { readProjects, waitForProject } from "./entities";
import { environmentPresentations } from "./presentation";
import { projectEnvironment } from "./projects";
import { useAtomCommand } from "./use-atom-command";
import { readPreparedConnection } from "./session";
import { waitForAtomValue } from "./waitForAtomValue";

const launchScheduler = createAtomCommandScheduler();

export const boatVmInitialTransport = (pageProtocol: string, desktop: boolean): "http" | "https" =>
  desktop || pageProtocol === "http:" ? "http" : "https";

export const boatVmEnvironment = {
  /** The boat VMs the environment holding the boat key can start. */
  list: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:boat-vms:list",
    tag: WS_METHODS.boatVmsList,
    staleTimeMs: 30_000,
  }),
  launch: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:boat-vms:launch",
    tag: WS_METHODS.boatVmsLaunch,
    scheduler: launchScheduler,
    // One launch per VM at a time; a second click joins nothing new.
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.sandboxId ?? "new"}`,
    },
  }),
  // Removes a new VM the launch made; a resumed one is kept.
  cancelLaunch: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:boat-vms:cancel-launch",
    tag: WS_METHODS.boatVmsCancelLaunch,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.launchId}`,
    },
  }),
  launches: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:boat-vms:launches",
    tag: WS_METHODS.subscribeBoatVmLaunches,
  }),
  /** Fetches a VM's branches into the host's checkout under refs/t3/boat/; never pushes. */
  bringHome: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:boat-vms:bring-home",
    tag: WS_METHODS.boatVmsBringHome,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.sandboxId}`,
    },
  }),
};

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

/** The VM a paired machine runs on: the one recorded at pairing, else the one its tailnet name names. */
export const pairedBoatVm = <Vm extends { readonly sandboxId: string }>(
  vms: ReadonlyArray<Vm>,
  recordedSandboxId: string | null,
  hostname: string | null,
): Vm | undefined =>
  recordedSandboxId !== null
    ? vms.find((vm) => vm.sandboxId === recordedSandboxId)
    : hostname === null
      ? undefined
      : vms.find((vm) => boatVmMatchesTailnetHostname(vm.sandboxId, hostname));

/**
 * "Run on" with the boat VMs folded in. A paired machine that is one of the
 * VMs shows as that VM while it runs; a stopped VM shows as its boat entry,
 * which resumes it; a VM boat no longer has is left out.
 * `hostnameOf` is a paired machine's tailnet name, when it has one.
 * `pairedVmOf` is the VM a machine was paired as, and whether this
 * environment, whose boat account `sandboxIds` lists, launched it.
 */
export function boatVmRunOnOptions(
  environments: ReadonlyArray<EnvironmentOption>,
  vms: ReadonlyArray<BoatVm>,
  hostnameOf: (environmentId: EnvironmentId) => string | null,
  newVmDisabledReason?: string,
  inventory?: {
    readonly sandboxIds: readonly string[];
    readonly pairedVmOf: (
      environmentId: EnvironmentId,
    ) => { readonly sandboxId: string; readonly owned: boolean } | null;
  },
): EnvironmentOption[] {
  const live = vms.filter((vm) => vm.status !== "destroyed" && vm.status !== "error");
  const sandboxIds = new Set(inventory?.sandboxIds);
  const paired = new Set<string>();
  const machines = environments.flatMap((environment) => {
    const recorded = inventory?.pairedVmOf(environment.environmentId) ?? null;
    if (recorded?.owned === true && !sandboxIds.has(recorded.sandboxId)) return [];
    const hostname = hostnameOf(environment.environmentId);
    const vm = pairedBoatVm(live, recorded?.sandboxId ?? null, hostname);
    if (vm === undefined) {
      // A VM paired before its sandbox ID was recorded is known only by its
      // tailnet name; once boat no longer has that sandbox, it is gone.
      const deleted =
        inventory !== undefined &&
        recorded === null &&
        hostname !== null &&
        isBoatVmTailnetHostname(hostname) &&
        !inventory.sandboxIds.some((id) => boatVmMatchesTailnetHostname(id, hostname));
      return deleted ? [] : [environment];
    }
    if (vm.status !== "running") return [];
    paired.add(vm.sandboxId);
    return [{ ...environment, label: `boat: ${vm.label}` }];
  });
  return [
    ...machines,
    ...live
      .filter((vm) => !paired.has(vm.sandboxId))
      .map((vm) =>
        entry(vm.sandboxId, `boat: ${vm.label}${vm.status === "running" ? "" : " (stopped)"}`),
      ),
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

/**
 * Starts (or resumes) a boat VM through `hostEnvironmentId`, pairs with it,
 * and returns the VM's project for the repository, creating it the first time,
 * with the launch's warning about the checkout, if any. Progress and failure
 * show in the banner of the composer `bannerKey` names; a failed or cancelled
 * launch resolves to null.
 */
export function useLaunchBoatVm() {
  const launch = useAtomCommand(boatVmEnvironment.launch, { reportFailure: false });
  const pair = useAtomCommand(connectPairing, { reportFailure: false });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });

  type LaunchInput = {
    readonly hostEnvironmentId: EnvironmentId;
    readonly sandboxId: string | null;
    readonly repository: BoatVmRepository;
    readonly bannerKey: string;
  };
  type Launched = { readonly projectRef: ScopedProjectRef; readonly warning: string | undefined };

  const run = async (input: LaunchInput, launchId: string): Promise<Launched> => {
    const launched = await launch({
      environmentId: input.hostEnvironmentId,
      input: {
        transport: boatVmInitialTransport(window.location.protocol, isElectron),
        ...(input.sandboxId === null ? {} : { sandboxId: input.sandboxId }),
        repository: input.repository,
        launchId,
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

    const host = readPreparedConnection(input.hostEnvironmentId);
    if (vm.boatProxy !== undefined && host === null) {
      throw new Error("Reconnect the environment that started this Boat VM.");
    }
    const paired = await pair({
      boatVm: { sandboxId: vm.sandboxId, hostEnvironmentId: input.hostEnvironmentId },
      host:
        vm.boatProxy === undefined
          ? vm.httpBaseUrl
          : boatProxyBaseUrl(host!.httpBaseUrl, vm.sandboxId),
      pairingCode: vm.pairingCode,
      ...(vm.boatProxy === undefined
        ? {}
        : { boatProxy: { sandboxId: vm.sandboxId, ...vm.boatProxy } }),
    });
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

    const existing = readProjects().find(
      (project) =>
        project.environmentId === environmentId && project.workspaceRoot === vm.workspaceRoot,
    );
    if (existing !== undefined) {
      return { projectRef: scopeProjectRef(environmentId, existing.id), warning: vm.warning };
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
    await waitForProject(projectRef);
    return { projectRef, warning: vm.warning };
  };

  return async (input: LaunchInput): Promise<Launched | null> => {
    const launchId = randomUUID();
    startBoatVmLaunch(input.bannerKey, {
      launchId,
      hostEnvironmentId: input.hostEnvironmentId,
      repositoryName: input.repository.name,
      newVm: input.sandboxId === null,
      phase: "launching",
    });
    try {
      const launched = await run(input, launchId);
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
  };
}
