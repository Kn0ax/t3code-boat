import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { boatSnapshotEnvironment, watchBoatSnapshotSave } from "../../state/boatSnapshots";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

/**
 * Builds snapshot `name` on a fresh VM with T3 and the agents installed, and
 * reports in a toast until boat has saved it, which takes several minutes.
 */
export function useCreateBaseSnapshot(environmentId: EnvironmentId | null) {
  const create = useAtomCommand(boatSnapshotEnvironment.createBaseSnapshot, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const run = async (name: string) => {
    if (environmentId === null || pending) return;
    setPending(true);
    const toastId = toastManager.add({
      type: "loading",
      title: `Creating snapshot ${name}…`,
      description:
        "A small boat VM installs T3, Claude Code, Codex and Tailscale, then boat saves it. This takes several minutes.",
    });
    const started = await create({ environmentId, input: { name } });
    if (started._tag === "Failure") {
      setPending(false);
      const failure = squashAtomCommandFailure(started);
      toastManager.update(toastId, {
        type: "error",
        title: `Could not create snapshot ${name}`,
        description: failure instanceof Error ? failure.message : "boat could not start it.",
      });
      return;
    }
    const outcome = await watchBoatSnapshotSave({ environmentId, name });
    setPending(false);
    toastManager.update(
      toastId,
      outcome === "ready"
        ? {
            type: "success",
            title: `Snapshot ${name} is ready`,
            description: "New VMs start from it.",
          }
        : outcome === "failed"
          ? {
              type: "error",
              title: `Could not save snapshot ${name}`,
              description: "boat could not save it. Try again from Settings.",
            }
          : {
              type: "warning",
              title: `Snapshot ${name} is still saving`,
              description: "boat has not finished after 20 minutes. Check it in Settings later.",
            },
    );
  };
  return { run, pending };
}
