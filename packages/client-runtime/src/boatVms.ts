import {
  BOAT_VM_SCRATCH_LABEL,
  boatVmLaunchProgressSummary,
  boatVmMatchesTailnetHostname,
  boatVmThreadCopyOrigin,
  boatVmThreadOriginKey,
  isBoatVmTailnetHostname,
  ThreadId,
  type BoatVm,
  type BoatVmLaunchResult,
  type BoatVmLaunchSnapshot,
  type BoatVmRepository,
  type EnvironmentId,
  type OrchestrationV2RunStatus,
  type RepositoryIdentity,
  type ScopedThreadRef,
  type ServerConfig,
} from "@t3tools/contracts";
import { boatProxyBaseUrl } from "@t3tools/shared/boatProxy";
import * as Option from "effect/Option";

import type { ConnectionCatalogEntry } from "./connection/catalog.ts";
import type { PairingConnectionInput } from "./connection/onboarding.ts";
import { scopeThreadRef } from "./environment/scoped.ts";
import { inferProjectTitleFromPath } from "./state/projects.ts";

export const boatVmInitialTransport = (pageProtocol: string, desktop: boolean): "http" | "https" =>
  desktop || pageProtocol === "http:" ? "http" : "https";

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

/** What a boat VM is called: its repository, or "No project" for one launched without. */
const boatVmTitle = (vmLabel: string): string =>
  vmLabel === BOAT_VM_SCRATCH_LABEL ? "No project" : vmLabel;

/** How a paired boat VM is named wherever its environment shows. */
export const boatVmEnvironmentLabel = (vmLabel: string): string => `boat: ${boatVmTitle(vmLabel)}`;

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
 * this client paired it, else start or pair the VM first. Once the VM is gone
 * it goes on in a new VM (`vm` null). A copy that was continued here, or whose
 * VMs have not loaded, is an ordinary thread (null).
 */
export function boatVmCopyRoute(input: {
  readonly copyThreadId: string;
  readonly continuedHere: boolean;
  /** The VMs of the environment holding the copy; undefined until they load. */
  readonly vms: ReadonlyArray<BoatVm> | undefined;
  readonly pairings: ReadonlyArray<BoatVmPairing>;
}):
  | {
      readonly vm: BoatVm;
      readonly threadId: ThreadId;
      /** The VM's environment to open the thread in; null when the VM must start or pair first. */
      readonly environmentId: EnvironmentId | null;
    }
  | { readonly vm: null; readonly threadId: ThreadId; readonly environmentId: null }
  | null {
  const origin = boatVmThreadCopyOrigin(input.copyThreadId);
  if (origin === null || input.continuedHere || input.vms === undefined) return null;
  const vm = input.vms.find(
    (candidate) => candidate.sandboxId === origin.sandboxId && candidate.status !== "destroyed",
  );
  if (vm === undefined) {
    return { vm: null, threadId: ThreadId.make(origin.threadId), environmentId: null };
  }
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
 * "Run on" with the boat VMs folded in, for a client to turn into its own
 * entries. A paired machine that is one of the VMs shows as that VM while it
 * runs (`machines`, relabeled); a stopped VM shows as its boat entry
 * (`vms`), which resumes it; a VM boat no longer has is left out.
 * `hostnameOf` is a paired machine's tailnet name, when it has one.
 * `pairedVmOf` is the VM a machine was paired as, and whether this
 * environment, whose boat account `sandboxIds` lists, launched it.
 */
export function boatVmRunOnChoices<
  T extends { readonly environmentId: EnvironmentId; readonly label: string },
>(
  environments: ReadonlyArray<T>,
  vms: ReadonlyArray<BoatVm>,
  hostnameOf: (environmentId: EnvironmentId) => string | null,
  inventory?: {
    readonly sandboxIds: readonly string[];
    readonly pairedVmOf: (
      environmentId: EnvironmentId,
    ) => { readonly sandboxId: string; readonly owned: boolean } | null;
  },
): {
  readonly machines: Array<T & { readonly pairedBoatVm?: BoatVm }>;
  readonly vms: BoatVm[];
} {
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
    return [{ ...environment, label: boatVmEnvironmentLabel(vm.label), pairedBoatVm: vm }];
  });
  return { machines, vms: live.filter((vm) => !paired.has(vm.sandboxId)) };
}

/** A boat VM row in "Run on": what it is called, and a line on what it is and what picking it does. */
export interface BoatVmRunOnRow {
  readonly title: string;
  readonly note: string;
}

const BOAT_VM_STATE_NOTES: Record<BoatVm["status"], string> = {
  creating: "starting",
  running: "running",
  stopping: "stopped, starts when picked",
  stopped: "stopped, starts when picked",
  error: "unavailable",
  destroyed: "deleted",
};

/**
 * How "Run on" shows boat VM `vm`, or "New boat VM" when `vm` is null,
 * which makes a VM for the draft's repository or, for a `scratch` draft,
 * none.
 */
export function boatVmRunOnRow(
  vm: Pick<BoatVm, "label" | "status" | "task"> | null,
  options: { readonly scratch?: boolean } = {},
): BoatVmRunOnRow {
  if (vm === null) {
    return {
      title: "New boat VM",
      note: options.scratch
        ? "Creates a cloud VM with no project"
        : "Creates a cloud VM for this repo",
    };
  }
  const note = `Boat VM · ${BOAT_VM_STATE_NOTES[vm.status]}`;
  return {
    title: boatVmTitle(vm.label),
    note: vm.task === undefined ? note : `${note} · ${vm.task}`,
  };
}

interface HostCandidate {
  readonly environmentId: EnvironmentId;
  readonly serverConfig?: Pick<ServerConfig, "environment"> | null | undefined;
}

/** Environments whose server can keep a boat key and start boat VMs and sandbox jobs. */
export const boatVmCapableEnvironmentIds = (
  environments: ReadonlyArray<HostCandidate>,
): EnvironmentId[] =>
  environments
    .filter((entry) => entry.serverConfig?.environment.capabilities.sandboxJobs === true)
    .map((entry) => entry.environmentId);

/**
 * The environment this device starts boat VMs and sandbox jobs through. A
 * choice that is no longer connected or capable falls back to `fallback`
 * (the primary connection where a client has one), which is also the default.
 */
export const resolveBoatVmHostEnvironmentId = (
  chosen: EnvironmentId | null,
  fallback: EnvironmentId | null,
  environments: ReadonlyArray<HostCandidate>,
): EnvironmentId | null =>
  chosen !== null && boatVmCapableEnvironmentIds(environments).includes(chosen) ? chosen : fallback;

/**
 * How a client pairs with a VM a launch through `hostEnvironmentId` returned:
 * directly at its tailnet origin, or through the host's boat relay, which
 * needs the host's current address. Throws when that address is unknown.
 */
export function boatVmPairingInput(
  vm: BoatVmLaunchResult,
  hostEnvironmentId: EnvironmentId,
  hostHttpBaseUrl: string | null,
): PairingConnectionInput {
  if (vm.boatProxy !== undefined && hostHttpBaseUrl === null) {
    throw new Error("Reconnect the environment that started this Boat VM.");
  }
  return {
    boatVm: { sandboxId: vm.sandboxId, hostEnvironmentId },
    // The VM's own name is its tailnet host name.
    label: boatVmEnvironmentLabel(vm.label),
    host:
      vm.boatProxy === undefined
        ? vm.httpBaseUrl
        : boatProxyBaseUrl(hostHttpBaseUrl!, vm.sandboxId),
    pairingCode: vm.pairingCode,
    ...(vm.boatProxy === undefined
      ? {}
      : { boatProxy: { sandboxId: vm.sandboxId, ...vm.boatProxy } }),
  };
}

/**
 * A boat VM launch as the composer that started it sees it. The server
 * reports its stages while the launch call runs; pairing with the VM after
 * the call returns is the client's own last step.
 */
export interface BoatVmLaunchEntry {
  readonly launchId: string;
  readonly hostEnvironmentId: EnvironmentId;
  /** Null for a "No project" launch. */
  readonly repositoryName: string | null;
  readonly newVm: boolean;
  readonly phase: "launching" | "cancelling" | "connecting" | "failed";
  readonly error?: string;
}

/**
 * The launches by composer (a draft id or a scoped thread key) after an
 * update to launch `launchId`; the same object when a newer launch from that
 * composer replaced it. A null update removes the launch.
 */
export function updateBoatVmLaunchEntries(
  entries: Readonly<Record<string, BoatVmLaunchEntry>>,
  key: string,
  launchId: string,
  update: Pick<BoatVmLaunchEntry, "phase" | "error"> | null,
): Readonly<Record<string, BoatVmLaunchEntry>> {
  const current = entries[key];
  if (current?.launchId !== launchId) return entries;
  const { [key]: _removed, ...rest } = entries;
  if (update === null) return rest;
  const { error: _error, ...base } = current;
  return {
    ...rest,
    [key]: {
      ...base,
      phase: update.phase,
      ...(update.error === undefined ? {} : { error: update.error }),
    },
  };
}

export interface BoatVmLaunchBanner {
  readonly title: string;
  readonly description: string;
  readonly failed: boolean;
  readonly cancellable: boolean;
}

const forRepository = (entry: BoatVmLaunchEntry) =>
  entry.repositoryName === null ? "" : ` for ${entry.repositoryName}`;

export function boatVmLaunchBanner(
  entry: BoatVmLaunchEntry,
  launches: ReadonlyArray<BoatVmLaunchSnapshot>,
): BoatVmLaunchBanner {
  if (entry.phase === "failed") {
    return {
      title: `Could not start the boat VM${forRepository(entry)}`,
      description: entry.error ?? "An error occurred.",
      failed: true,
      cancellable: false,
    };
  }
  const snapshot = launches.find((launch) => launch.launchId === entry.launchId);
  return {
    title: `${entry.newVm ? "Starting a new boat VM" : "Starting the boat VM"}${forRepository(entry)}`,
    description:
      entry.phase === "connecting"
        ? "Connecting to the VM"
        : entry.phase === "cancelling"
          ? "Cancelling"
          : boatVmLaunchProgressSummary(
              // Until the first report arrives, or from a server that sends none.
              snapshot ?? { stage: entry.newVm ? "creating" : "resuming" },
            ),
    failed: false,
    cancellable: entry.phase === "launching",
  };
}
