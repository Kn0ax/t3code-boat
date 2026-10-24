import {
  updateBoatVmLaunchEntries,
  type BoatVmLaunchEntry,
} from "@t3tools/client-runtime/boat-vms";
import { create } from "zustand";

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
    const entries = updateBoatVmLaunchEntries(state.entries, key, launchId, update);
    return entries === state.entries ? state : { entries };
  });
}

export function readBoatVmLaunch(key: string): BoatVmLaunchEntry | undefined {
  return useBoatVmLaunchStore.getState().entries[key];
}
