import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { BoatVmLaunchSnapshot, EnvironmentId } from "@t3tools/contracts";
import { CloudIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  boatVmLaunchBanner,
  updateBoatVmLaunch,
  useBoatVmLaunchStore,
} from "~/state/boatVmLaunches";
import { boatVmEnvironment } from "~/state/boatVms";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

const NO_LAUNCHES: ReadonlyArray<BoatVmLaunchSnapshot> = [];
const NO_LAUNCHES_ATOM = Atom.make(NO_LAUNCHES).pipe(Atom.withLabel("web-boat-vm-launches:none"));

const environmentBoatVmLaunchesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<BoatVmLaunchSnapshot> =>
    Option.getOrElse(
      AsyncResult.value(get(boatVmEnvironment.launches({ environmentId, input: {} }))),
      () => NO_LAUNCHES,
    ),
  ).pipe(Atom.withLabel(`web-boat-vm-launches:${environmentId}`)),
);

/** The banner for a boat VM launch started from the composer `key` names. */
export function useBoatVmLaunchBanner(key: string | null): ComposerBannerStackItem | null {
  const entry = useBoatVmLaunchStore((state) => (key === null ? undefined : state.entries[key]));
  // Subscribed only while the server still has stages to report.
  const launches = useAtomValue(
    entry !== undefined && (entry.phase === "launching" || entry.phase === "cancelling")
      ? environmentBoatVmLaunchesAtom(entry.hostEnvironmentId)
      : NO_LAUNCHES_ATOM,
  );
  const canCancel = useAtomValue(
    boatVmEnvironment.cancelLaunch.permissionAtom(entry?.hostEnvironmentId ?? null),
  );
  const cancelLaunch = useAtomCommand(boatVmEnvironment.cancelLaunch, { reportFailure: false });
  if (key === null || entry === undefined) return null;

  const banner = boatVmLaunchBanner(entry, launches);
  const { launchId, hostEnvironmentId } = entry;
  const cancel = async () => {
    updateBoatVmLaunch(key, launchId, { phase: "cancelling" });
    const result = await cancelLaunch({ environmentId: hostEnvironmentId, input: { launchId } });
    if (result._tag === "Success" && result.value.applied) return;
    // The launch finished first, or the cancel did not reach the server.
    if (useBoatVmLaunchStore.getState().entries[key]?.phase === "cancelling") {
      updateBoatVmLaunch(key, launchId, { phase: "launching" });
    }
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({ type: "error", title: "Could not cancel the boat VM launch" });
    }
  };
  return {
    id: `boat-vm-launch:${launchId}`,
    variant: banner.failed ? "error" : "info",
    ...(banner.failed ? {} : { priority: "activity" as const }),
    icon: <CloudIcon />,
    title: banner.title,
    description: banner.description,
    ...(banner.cancellable
      ? {
          actions: (
            <Button size="xs" variant="ghost" disabled={!canCancel} onClick={() => void cancel()}>
              Cancel
            </Button>
          ),
        }
      : {}),
    ...(banner.failed
      ? {
          dismissLabel: "Dismiss boat VM error",
          onDismiss: () => updateBoatVmLaunch(key, launchId, null),
        }
      : {}),
  };
}
