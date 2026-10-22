import {
  boatVmLaunchProgressSummary,
  type BoatVmLaunchSnapshot,
  type EnvironmentId,
} from "@t3tools/contracts";
import { create } from "zustand";

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

interface BoatVmLaunchStore {
  /** By composer: a draft id or a scoped thread key. */
  readonly entries: Readonly<Record<string, BoatVmLaunchEntry>>;
}

export const useBoatVmLaunchStore = create<BoatVmLaunchStore>(() => ({ entries: {} }));

export function startBoatVmLaunch(key: string, entry: BoatVmLaunchEntry) {
  useBoatVmLaunchStore.setState((state) => ({ entries: { ...state.entries, [key]: entry } }));
}

/** Only touches the launch named; a newer launch from the same composer replaced an older one. */
export function updateBoatVmLaunch(
  key: string,
  launchId: string,
  update: Pick<BoatVmLaunchEntry, "phase" | "error"> | null,
) {
  useBoatVmLaunchStore.setState((state) => {
    const current = state.entries[key];
    if (current?.launchId !== launchId) return state;
    const { [key]: _removed, ...rest } = state.entries;
    if (update === null) return { entries: rest };
    const { error: _error, ...base } = current;
    return {
      entries: {
        ...rest,
        [key]: {
          ...base,
          phase: update.phase,
          ...(update.error === undefined ? {} : { error: update.error }),
        },
      },
    };
  });
}

export function readBoatVmLaunch(key: string): BoatVmLaunchEntry | undefined {
  return useBoatVmLaunchStore.getState().entries[key];
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
