import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import {
  AuthOrchestrationOperateScope,
  boatVmMatchesTailnetHostname,
  boatVmThreadCopyOrigin,
  boatVmThreadOriginKey,
  EnvironmentId,
  isBoatVmTailnetHostname,
  ThreadId,
  WS_METHODS,
  type BoatVm,
  type BoatVmBringHomeResult,
  type BoatVmRepository,
  type OrchestrationV2RunStatus,
  type RepositoryIdentity,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import * as Option from "effect/Option";
import { useEffect } from "react";

import type { EnvironmentOption } from "../components/BranchToolbar.logic";
import { environmentCatalog } from "../connection/catalog";
import { connectPairing } from "../connection/onboarding";
import { connectionAtomRuntime } from "../connection/runtime";
import { inferProjectTitleFromPath } from "../lib/projectPaths";
import { isElectron } from "../env";
import { boatProxyBaseUrl } from "@t3tools/shared/boatProxy";
import { newProjectId, randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readBoatVmLaunch, startBoatVmLaunch, updateBoatVmLaunch } from "./boatVmLaunches";
import { readProjects, readThreadShell, waitForProject } from "./entities";
import { environmentPresentations } from "./presentation";
import { projectEnvironment } from "./projects";
import { useAtomCommand } from "./use-atom-command";
import { readEnvironmentScope, readPreparedConnection } from "./session";
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

/** The repository a boat VM checks out for a project; null without a remote T3 recognizes. */
export const boatVmRepositoryOf = (
  identity: RepositoryIdentity | null | undefined,
): BoatVmRepository | null =>
  identity
    ? {
        remoteUrl: identity.locator.remoteUrl,
        ...(identity.owner === undefined ? {} : { owner: identity.owner }),
        name:
          identity.name ?? inferProjectTitleFromPath(identity.rootPath ?? identity.canonicalKey),
      }
    : null;

/**
 * What a draft starts a boat VM with: its project's repository, `"scratch"`
 * for a "No project" draft, or null when it cannot start one (not a draft,
 * or a project without a remote).
 */
export function boatVmDraftLaunch(input: {
  readonly isDraft: boolean;
  readonly project: { readonly repositoryIdentity?: RepositoryIdentity | null | undefined } | null;
  readonly isScratch: boolean;
}): BoatVmRepository | "scratch" | null {
  if (!input.isDraft || input.project === null) return null;
  return input.isScratch ? "scratch" : boatVmRepositoryOf(input.project.repositoryIdentity);
}

/** How a paired boat VM is named wherever its environment shows. */
export const boatVmEnvironmentLabel = (vmLabel: string): string => `boat: ${vmLabel}`;

/**
 * What a saved environment says about being a boat VM: the VM recorded when it
 * was paired, and its tailnet name, which names the VM for pairings older
 * than that record.
 */
export interface BoatVmPairing {
  readonly environmentId: EnvironmentId;
  readonly recorded: {
    readonly sandboxId: string;
    readonly hostEnvironmentId: EnvironmentId;
  } | null;
  readonly hostname: string | null;
}

export function boatVmPairingOf(entry: ConnectionCatalogEntry): BoatVmPairing {
  const profile = Option.getOrNull(entry.profile);
  const bearer = profile?._tag === "BearerConnectionProfile" ? profile : null;
  return {
    environmentId: entry.target.environmentId,
    recorded: bearer?.boatVm ?? null,
    hostname:
      bearer === null ? null : (URL.parse(bearer.httpBaseUrl)?.hostname.split(".")[0] ?? null),
  };
}

/** Every saved environment's pairing, read from the saved connections alone. */
export function useBoatVmPairings(): ReadonlyArray<BoatVmPairing> {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  return [...catalog.entries.values()].map(boatVmPairingOf);
}

/**
 * Where settling or archiving a boat VM's thread goes while this client cannot
 * change threads on the VM, as while it is stopped: the thread's copy on the
 * environment that holds the boat key, when that copy is listed here. The
 * lifecycle there counts the copy's state as the VM thread's.
 */
export function boatVmCopyTarget(input: {
  readonly target: ScopedThreadRef;
  readonly canOperate: boolean;
  readonly pairings: ReadonlyArray<BoatVmPairing>;
  readonly hasThread: (ref: ScopedThreadRef) => boolean;
}): ScopedThreadRef {
  if (input.canOperate) return input.target;
  const vm = input.pairings.find(
    (pairing) => pairing.environmentId === input.target.environmentId,
  )?.recorded;
  if (vm === null || vm === undefined) return input.target;
  const copy = scopeThreadRef(
    vm.hostEnvironmentId,
    ThreadId.make(`import:${boatVmThreadOriginKey(vm.sandboxId, input.target.threadId)}`),
  );
  return input.hasThread(copy) ? copy : input.target;
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

const pairingRunsVm = (pairing: BoatVmPairing, sandboxId: string) =>
  pairing.recorded !== null
    ? pairing.recorded.sandboxId === sandboxId
    : pairing.hostname !== null && boatVmMatchesTailnetHostname(sandboxId, pairing.hostname);

/** The saved environment that runs boat VM `sandboxId`, if this client paired it. */
const boatVmEnvironmentOf = (
  pairings: ReadonlyArray<BoatVmPairing>,
  sandboxId: string,
): EnvironmentId | null =>
  pairings.find((pairing) => pairingRunsVm(pairing, sandboxId))?.environmentId ?? null;

/**
 * A copy carries no runs, so one with a run that did not fail was continued
 * here and is a conversation of its own. The server checks every run; a client
 * only has the latest, so a good run followed by a failed one reads as not
 * continued here.
 */
export const boatVmCopyContinuedHere = (
  latestRun: { readonly status: OrchestrationV2RunStatus } | null,
): boolean => latestRun !== null && latestRun.status !== "failed";

/**
 * Shows one row for a VM thread that this client lists along with the
 * manager's copy of it: the VM's thread while this client can change threads
 * on the VM, else the copy, which stays usable while the VM is stopped. Both
 * show once the copy was continued here.
 */
export function withoutShadowedBoatVmCopies<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly id: string;
    readonly latestRun: { readonly status: OrchestrationV2RunStatus } | null;
  },
>(
  threads: ReadonlyArray<T>,
  pairings: ReadonlyArray<BoatVmPairing>,
  operable: ReadonlySet<EnvironmentId>,
): ReadonlyArray<T> {
  if (!threads.some((thread) => boatVmThreadCopyOrigin(thread.id) !== null)) return threads;
  const keyOf = (environmentId: EnvironmentId, threadId: string) => `${environmentId} ${threadId}`;
  const listed = new Set(threads.map((thread) => keyOf(thread.environmentId, thread.id)));
  const hidden = new Set<string>();
  for (const thread of threads) {
    const origin = boatVmThreadCopyOrigin(thread.id);
    if (origin === null || boatVmCopyContinuedHere(thread.latestRun)) continue;
    const environmentId = boatVmEnvironmentOf(pairings, origin.sandboxId);
    if (environmentId === null || !listed.has(keyOf(environmentId, origin.threadId))) continue;
    hidden.add(
      operable.has(environmentId)
        ? keyOf(thread.environmentId, thread.id)
        : keyOf(environmentId, origin.threadId),
    );
  }
  return hidden.size === 0
    ? threads
    : threads.filter((thread) => !hidden.has(keyOf(thread.environmentId, thread.id)));
}

/**
 * Where a send on a boat VM thread's copy goes. While boat still has the VM,
 * the conversation goes on in the VM's thread: open it when the VM runs and
 * this client paired it, else start or pair the VM first. A copy whose VM is
 * gone, or that was continued here, is an ordinary thread (null).
 */
export function boatVmCopyRoute(input: {
  readonly copyThreadId: string;
  readonly continuedHere: boolean;
  /** The VMs of the environment holding the copy; undefined until they load. */
  readonly vms: ReadonlyArray<BoatVm> | undefined;
  readonly pairings: ReadonlyArray<BoatVmPairing>;
}): {
  readonly vm: BoatVm;
  readonly threadId: ThreadId;
  /** The VM's environment to open the thread in; null when the VM must start or pair first. */
  readonly environmentId: EnvironmentId | null;
} | null {
  const origin = boatVmThreadCopyOrigin(input.copyThreadId);
  if (origin === null || input.continuedHere) return null;
  const vm = input.vms?.find(
    (candidate) => candidate.sandboxId === origin.sandboxId && candidate.status !== "destroyed",
  );
  if (vm === undefined) return null;
  const environmentId = boatVmEnvironmentOf(input.pairings, origin.sandboxId);
  return {
    vm,
    threadId: ThreadId.make(origin.threadId),
    environmentId: vm.status === "running" ? environmentId : null,
  };
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
 * The saved environments that are one of `vms` but not yet named after it,
 * such as a VM paired before pairing named it, with the label each should have.
 */
export function boatVmLabelUpdates(
  entries: Iterable<ConnectionCatalogEntry>,
  vms: ReadonlyArray<BoatVm>,
): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }> {
  const live = vms.filter((vm) => vm.status !== "destroyed");
  return [...entries].flatMap((entry) => {
    const pairing = boatVmPairingOf(entry);
    const vm = pairedBoatVm(live, pairing.recorded?.sandboxId ?? null, pairing.hostname);
    if (vm === undefined) return [];
    const label = boatVmEnvironmentLabel(vm.label);
    return entry.target.label === label ? [] : [{ environmentId: pairing.environmentId, label }];
  });
}

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
    return [{ ...environment, label: boatVmEnvironmentLabel(vm.label) }];
  });
  return [
    ...machines,
    ...live
      .filter((vm) => !paired.has(vm.sandboxId))
      .map((vm) =>
        entry(
          vm.sandboxId,
          `${boatVmEnvironmentLabel(vm.label)}${vm.status === "running" ? "" : " (stopped)"}`,
        ),
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
 * with the launch's warning about the checkout, if any. Without a repository
 * the project is the VM's Scratch project, as for a "No project" thread. Progress and failure
 * show in the banner of the composer `bannerKey` names; a failed or cancelled
 * launch resolves to null.
 */
export function useLaunchBoatVm() {
  const launch = useAtomCommand(boatVmEnvironment.launch, { reportFailure: false });
  const pair = useAtomCommand(connectPairing, { reportFailure: false });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });

  type LaunchInput = {
    readonly hostEnvironmentId: EnvironmentId;
    readonly sandboxId: string | null;
    readonly repository: BoatVmRepository | null;
    readonly bannerKey: string;
  };
  type Launched = {
    readonly project: EnvironmentProject;
    readonly projectRef: ScopedProjectRef;
    readonly warning: string | undefined;
  };

  const run = async (input: LaunchInput, launchId: string): Promise<Launched> => {
    const launched = await launch({
      environmentId: input.hostEnvironmentId,
      input: {
        transport: boatVmInitialTransport(window.location.protocol, isElectron),
        ...(input.sandboxId === null ? {} : { sandboxId: input.sandboxId }),
        ...(input.repository === null ? {} : { repository: input.repository }),
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
      // The VM's own name is its tailnet host name.
      label: boatVmEnvironmentLabel(vm.label),
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

  return async (input: LaunchInput): Promise<Launched | null> => {
    const launchId = randomUUID();
    startBoatVmLaunch(input.bannerKey, {
      launchId,
      hostEnvironmentId: input.hostEnvironmentId,
      repositoryName: input.repository?.name ?? null,
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
