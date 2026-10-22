import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  executeAtomQuery,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentQuery } from "./query";

export const boatSnapshotEnvironment = {
  /** The boat account's named snapshots and environments, for pickers. */
  catalog: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:boat-vms:catalog",
    tag: WS_METHODS.boatVmsCatalog,
    staleTimeMs: 30_000,
  }),
  saveSnapshot: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:boat-vms:save-snapshot",
    tag: WS_METHODS.boatVmsSaveSnapshot,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.name}`,
    },
  }),
};

export type BoatCatalogView =
  | { readonly state: "no-key" | "loading" }
  | { readonly state: "error"; readonly error: string }
  | {
      readonly state: "ready";
      readonly snapshots: ReadonlyArray<{
        readonly name: string;
        readonly status: string;
        readonly sizeBytes?: number;
      }>;
      readonly environments: ReadonlyArray<{ readonly name: string; readonly isDefault: boolean }>;
      /** Reloads the lists, for a picker that opens. */
      readonly refresh: () => void;
    };

/**
 * The catalog of the environment holding the boat key. Nothing loads until a
 * key is saved, and saving one loads it afresh.
 */
export function useBoatCatalog(
  environmentId: EnvironmentId | null,
  keySaved: boolean,
): BoatCatalogView {
  const query = useEnvironmentQuery(
    environmentId === null || !keySaved
      ? null
      : boatSnapshotEnvironment.catalog({ environmentId, input: {} }),
  );
  // A cached answer from before the key was saved or replaced says nothing about the new one.
  const wasSaved = useRef(keySaved);
  const { refresh } = query;
  const cached = query.data !== null;
  useEffect(() => {
    if (keySaved && !wasSaved.current && cached) refresh();
    wasSaved.current = keySaved;
  }, [keySaved, cached, refresh]);

  if (environmentId === null || !keySaved) return { state: "no-key" };
  if (query.data !== null) {
    return query.data.available
      ? {
          state: "ready",
          snapshots: query.data.snapshots,
          environments: query.data.environments,
          refresh,
        }
      : { state: "no-key" };
  }
  if (query.error !== null) return { state: "error", error: query.error };
  return { state: "loading" };
}

export type BoatSnapshotOutcome = "ready" | "failed" | "timed-out" | "cancelled";

/**
 * Polls a snapshot save until boat reports it ready or failed. A status that
 * could not be read counts as still saving: one dropped request must not end
 * the wait.
 */
export async function waitForBoatSnapshot(options: {
  readonly readStatus: () => Promise<string | null>;
  readonly wait: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<BoatSnapshotOutcome> {
  const deadline = options.now() + options.timeoutMs;
  while (options.now() < deadline) {
    await options.wait(options.intervalMs);
    if (options.signal?.aborted) return "cancelled";
    const status = await options.readStatus();
    if (options.signal?.aborted) return "cancelled";
    if (status === "ready" || status === "failed") return status;
  }
  return "timed-out";
}

const POLL_INTERVAL_MS = 10_000;
// A running VM takes a fresh capture before boat freezes it, which can run many minutes.
const POLL_TIMEOUT_MS = 20 * 60_000;

/** Waits on a save started through `environmentId`, reading its status from the catalog. */
export function watchBoatSnapshotSave(input: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly signal?: AbortSignal;
}): Promise<BoatSnapshotOutcome> {
  return waitForBoatSnapshot({
    readStatus: async () => {
      const result = await executeAtomQuery(
        appAtomRegistry,
        boatSnapshotEnvironment.catalog({ environmentId: input.environmentId, input: {} }),
        { refresh: true, reportFailure: false, reportDefect: false },
      );
      if (result._tag !== "Success") return null;
      // boat may not list a save it only just started; that still counts as saving.
      return (
        result.value.snapshots.find((snapshot) => snapshot.name === input.name)?.status ?? null
      );
    },
    wait: (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        input.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }),
    now: Date.now,
    intervalMs: POLL_INTERVAL_MS,
    timeoutMs: POLL_TIMEOUT_MS,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}
