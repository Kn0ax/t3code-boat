import { useAtomValue } from "@effect/atom-react";
import {
  boatVmCapableEnvironmentIds,
  boatVmCopyTarget,
  boatVmLabelUpdates,
  boatVmPairingInput,
  boatVmPairingOf,
  resolveBoatVmHostEnvironmentId,
  updateBoatVmLaunchEntries,
  withoutShadowedBoatVmCopies,
  type BoatVmLaunchEntry,
  type BoatVmPairing,
} from "@t3tools/client-runtime/boat-vms";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createBoatVmEnvironmentAtoms } from "@t3tools/client-runtime/state/boat-vms";
import { inferProjectTitleFromPath } from "@t3tools/client-runtime/state/projects";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  isBoatVmTailnetHostname,
  ProjectId,
  type BoatVm,
  type BoatVmLaunchInput,
  type BoatVmRepository,
  type EnvironmentId,
  type SandboxJobSize,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { connectPairing } from "../connection/onboarding";
import { connectionAtomRuntime } from "../connection/runtime";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { useServerConfigs, waitForProject } from "./entities";
import { environmentPresentations } from "./presentation";
import { environmentProjects, projectEnvironment } from "./projects";
import { environmentSession, readEnvironmentScope, useEnvironmentsWithScope } from "./session";
import { environmentThreadShells } from "./threads";
import { useRemoteConnectionStatus } from "./use-remote-environment-registry";

export const boatVmEnvironment = createBoatVmEnvironmentAtoms(connectionAtomRuntime);

/** Every saved environment's pairing, read from the saved connections alone. */
export function useBoatVmPairings(): ReadonlyArray<BoatVmPairing> {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  return useMemo(() => [...catalog.entries.values()].map(boatVmPairingOf), [catalog]);
}

const readBoatVmPairings = () =>
  [...appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.values()].map(
    boatVmPairingOf,
  );

/**
 * The connected environment this device starts boat VMs through. Mobile has
 * no "Managed by" choice: it is `preferred` while that can hold a boat key,
 * else the first connected one that can. A paired VM is never the manager.
 */
export function useBoatVmHostEnvironmentId(preferred: EnvironmentId | null): EnvironmentId | null {
  const serverConfigs = useServerConfigs();
  const pairings = useBoatVmPairings();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const vmEnvironmentIds = new Set(
    pairings
      .filter(
        (pairing) =>
          pairing.recorded !== null ||
          (pairing.hostname !== null && isBoatVmTailnetHostname(pairing.hostname)),
      )
      .map((pairing) => pairing.environmentId),
  );
  const candidates = connectedEnvironments
    .filter(
      (environment) =>
        environment.connectionState === "connected" &&
        !vmEnvironmentIds.has(environment.environmentId),
    )
    .map((environment) => ({
      environmentId: environment.environmentId,
      serverConfig: serverConfigs.get(environment.environmentId) ?? null,
    }));
  return resolveBoatVmHostEnvironmentId(
    preferred,
    boatVmCapableEnvironmentIds(candidates)[0] ?? null,
    candidates,
  );
}

/** One row for a VM thread listed along with its copy; see withoutShadowedBoatVmCopies. */
export function useWithoutShadowedBoatVmCopies(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  const pairings = useBoatVmPairings();
  const operable = useEnvironmentsWithScope(pairings, AuthOrchestrationOperateScope);
  return withoutShadowedBoatVmCopies(threads, pairings, operable);
}

/**
 * The thread a settle, archive or delete of `thread` goes to: its copy on the
 * VM's host while this client cannot change threads on the VM.
 */
export function readBoatVmCopyThread(thread: EnvironmentThreadShell): EnvironmentThreadShell {
  const target = boatVmCopyTarget({
    target: scopeThreadRef(thread.environmentId, thread.id),
    canOperate: readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
    pairings: readBoatVmPairings(),
    hasThread: (ref) => appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref)) !== null,
  });
  return target.environmentId === thread.environmentId && target.threadId === thread.id
    ? thread
    : (appAtomRegistry.get(environmentThreadShells.threadShellAtom(target)) ?? thread);
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

/** Launches by composer: a new-task draft key or a scoped thread key. */
const boatVmLaunchesAtom = Atom.make<Readonly<Record<string, BoatVmLaunchEntry>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:boat-vm-launches"),
);

export function useBoatVmLaunch(key: string | null): BoatVmLaunchEntry | undefined {
  const entries = useAtomValue(boatVmLaunchesAtom);
  return key === null ? undefined : entries[key];
}

export const readBoatVmLaunch = (key: string): BoatVmLaunchEntry | undefined =>
  appAtomRegistry.get(boatVmLaunchesAtom)[key];

/** Only touches the launch named; a newer launch from the same composer replaced an older one. */
export function updateBoatVmLaunch(
  key: string,
  launchId: string,
  update: Pick<BoatVmLaunchEntry, "phase" | "error"> | null,
) {
  appAtomRegistry.set(
    boatVmLaunchesAtom,
    updateBoatVmLaunchEntries(appAtomRegistry.get(boatVmLaunchesAtom), key, launchId, update),
  );
}

// Covers the VM's first connect over the tailnet and the initial sync.
const CONNECT_TIMEOUT_MS = 60_000;

function waitForConnected(environmentId: EnvironmentId): Promise<boolean> {
  const atom = environmentPresentations.presentationsAtom;
  const connected = () =>
    appAtomRegistry.get(atom).get(environmentId)?.connection.phase === "connected";
  if (connected()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timeout);
      unsubscribe();
      resolve(value);
    };
    const timeout = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
    const unsubscribe = appAtomRegistry.subscribe(atom, () => {
      if (connected()) finish(true);
    });
  });
}

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

/** Starts a boat VM through the host and pairs with it once it is connected. Throws with the reason. */
async function launchAndPair(
  input: LaunchInput,
  launchId: string,
  extra: Pick<BoatVmLaunchInput, "continueThreadId" | "message"> = {},
) {
  const launched = await runAtomCommand(
    appAtomRegistry,
    boatVmEnvironment.launch,
    {
      environmentId: input.hostEnvironmentId,
      input: {
        // The app may load tailnet HTTP, so it never waits for a certificate.
        transport: "http",
        ...(input.sandboxId === null ? {} : { sandboxId: input.sandboxId }),
        ...(input.repository === null ? {} : { repository: input.repository }),
        ...(input.size === undefined ? {} : { size: input.size }),
        launchId,
        ...extra,
      },
    },
    { reportFailure: false },
  );
  // A new VM exists even when its launch failed, and a resume changes the status.
  appAtomRegistry.refresh(
    boatVmEnvironment.list({ environmentId: input.hostEnvironmentId, input: {} }),
  );
  if (launched._tag === "Failure") {
    throw toError(squashAtomCommandFailure(launched), "Could not start the boat VM.");
  }
  const vm = launched.value;
  updateBoatVmLaunch(input.bannerKey, launchId, { phase: "connecting" });

  const host = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(input.hostEnvironmentId)),
  );
  const paired = await runAtomCommand(
    appAtomRegistry,
    connectPairing,
    boatVmPairingInput(vm, input.hostEnvironmentId, host?.httpBaseUrl ?? null),
    { reportFailure: false },
  );
  if (paired._tag === "Failure") {
    throw toError(squashAtomCommandFailure(paired), "Could not pair with the boat VM.");
  }
  const environmentId = paired.value;
  if (!(await waitForConnected(environmentId))) throw new Error(`${vm.label} did not connect.`);
  return { vm, environmentId };
}

/**
 * Runs a launch with its progress and failure in the banner of the composer
 * `input.bannerKey` names; a failed or cancelled launch resolves to null.
 */
async function withLaunchBanner<A>(
  input: LaunchInput,
  run: (launchId: string) => Promise<A>,
): Promise<A | null> {
  const launchId = uuidv4();
  appAtomRegistry.set(boatVmLaunchesAtom, {
    ...appAtomRegistry.get(boatVmLaunchesAtom),
    [input.bannerKey]: {
      launchId,
      hostEnvironmentId: input.hostEnvironmentId,
      repositoryName: input.repository?.name ?? null,
      newVm: input.sandboxId === null,
      phase: "launching",
    },
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
 * Starts (or resumes) a boat VM, pairs with it, and returns the VM's project
 * for the repository, creating it the first time, with the launch's warning
 * about the checkout, if any. Without a repository the project is the VM's
 * Scratch project. A failed or cancelled launch resolves to null.
 */
export function launchBoatVm(input: LaunchInput): Promise<{
  readonly project: EnvironmentProject;
  readonly projectRef: ScopedProjectRef;
  readonly warning: string | undefined;
} | null> {
  return withLaunchBanner(input, async (launchId) => {
    const { vm, environmentId } = await launchAndPair(input, launchId);
    if (input.repository === null) {
      const scratch = await runAtomCommand(
        appAtomRegistry,
        projectEnvironment.openScratch,
        { environmentId, input: {} },
        { reportFailure: false },
      );
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

    const existing = appAtomRegistry
      .get(environmentProjects.projectsAtom)
      .find(
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

    const projectId = ProjectId.make(uuidv4());
    const created = await runAtomCommand(
      appAtomRegistry,
      projectEnvironment.create,
      {
        environmentId,
        input: {
          projectId,
          title: inferProjectTitleFromPath(vm.workspaceRoot),
          workspaceRoot: vm.workspaceRoot,
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: null,
        },
      },
      { reportFailure: false },
    );
    if (created._tag === "Failure") {
      throw toError(squashAtomCommandFailure(created), "Could not open the repository on the VM.");
    }
    const projectRef = scopeProjectRef(environmentId, projectId);
    const project = await waitForProject(projectRef);
    if (project === null) throw new Error("The repository on the VM did not open.");
    return { project, projectRef, warning: vm.warning };
  });
}

/**
 * Continues a copy whose boat VM was deleted on a new VM, sending `message`
 * there, and returns the thread on that VM once this client paired with it.
 * The host picks the repository from the copy; `repository` only names the
 * launch in the banner. A failed or cancelled launch resolves to null.
 */
export function continueBoatVmCopy(
  input: Omit<LaunchInput, "sandboxId"> & {
    readonly copyThreadId: ThreadId;
    readonly message: string | null;
  },
): Promise<{ readonly threadRef: ScopedThreadRef; readonly warning: string | undefined } | null> {
  return withLaunchBanner({ ...input, sandboxId: null }, async (launchId) => {
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
