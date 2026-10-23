import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  boatVmThreadCopyOrigin,
  type BoatVmRepository,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CloudIcon } from "lucide-react";
import { useState } from "react";

import {
  boatVmCopyContinuedHere,
  boatVmCopyRoute,
  boatVmEnvironment,
  boatVmEnvironmentLabel,
  useBoatVmEnvironmentLabels,
  useBoatVmPairings,
  useContinueBoatVmCopy,
  type useLaunchBoatVm,
} from "~/state/boatVms";
import { useEnvironmentQuery } from "~/state/query";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * A copy of a boat VM thread points at the VM's thread while boat has the VM:
 * the composer banner opens that thread, starting or pairing the VM first, and
 * sending here is off. Once the VM is deleted, the banner and a send continue
 * the copy on a new VM instead (`continueOnNewVm`). The server refuses a send
 * to such a copy too, until the copy was continued here.
 */
export function useBoatVmCopy(input: {
  /** The open server thread; null for a draft. */
  readonly thread: {
    readonly id: ThreadId;
    readonly environmentId: EnvironmentId;
    readonly latestRun: Parameters<typeof boatVmCopyContinuedHere>[0];
  } | null;
  /** What the VM is resumed with: the copy's repository, or scratch. */
  readonly repository: BoatVmRepository | "scratch" | null;
  readonly launchBoatVm: ReturnType<typeof useLaunchBoatVm>;
  readonly bannerKey: string;
}): {
  readonly bannerItem: ComposerBannerStackItem | null;
  readonly sendDisabledReason: string | null;
  /**
   * Set while a send continues the copy on a new VM: starts it with `message`
   * and opens the thread there. Resolves to whether it did.
   */
  readonly continueOnNewVm: ((message: string | null) => Promise<boolean>) | null;
} {
  const { thread } = input;
  const navigate = useNavigate();
  const pairings = useBoatVmPairings();
  const continueCopy = useContinueBoatVmCopy();
  const [opening, setOpening] = useState(false);
  // The copy lives with the environment that holds the boat key.
  const hostId =
    thread !== null && boatVmThreadCopyOrigin(thread.id) !== null ? thread.environmentId : null;
  const vms = useEnvironmentQuery(
    hostId === null ? null : boatVmEnvironment.list({ environmentId: hostId, input: {} }),
  );
  useBoatVmEnvironmentLabels(vms.data?.available === true ? vms.data.vms : undefined);
  const route =
    thread === null
      ? null
      : boatVmCopyRoute({
          copyThreadId: thread.id,
          continuedHere: boatVmCopyContinuedHere(thread.latestRun),
          vms: vms.data?.available === true ? vms.data.vms : undefined,
          pairings,
        });
  if (route === null || hostId === null || thread === null) {
    return { bannerItem: null, sendDisabledReason: null, continueOnNewVm: null };
  }

  const openThread = (ref: ScopedThreadRef) =>
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });

  if (route.vm === null) {
    const continueOnNewVm = async (message: string | null) => {
      setOpening(true);
      try {
        const continued = await continueCopy({
          hostEnvironmentId: hostId,
          repository: input.repository === "scratch" ? null : input.repository,
          bannerKey: input.bannerKey,
          copyThreadId: thread.id,
          message,
        });
        if (continued === null) return false;
        if (continued.warning !== undefined) {
          toastManager.add({
            type: "warning",
            title: "The thread continues on a new boat VM, but not all of its work came along",
            description: continued.warning,
          });
        }
        openThread(continued.threadRef);
        return true;
      } finally {
        setOpening(false);
      }
    };
    return {
      bannerItem: {
        id: `boat-vm-copy:${thread.id}`,
        variant: "info",
        icon: <CloudIcon />,
        title: "This thread's boat VM was deleted",
        description:
          "Continue on a new VM, with the commits brought home from the old one. Sending a message does the same.",
        actions: (
          <Button
            size="xs"
            variant="ghost"
            disabled={opening}
            onClick={() => void continueOnNewVm(null)}
          >
            Continue on a new VM
          </Button>
        ),
      },
      sendDisabledReason: opening ? "Starting a new boat VM" : null,
      continueOnNewVm,
    };
  }

  const { vm } = route;
  const open = () => {
    if (route.environmentId !== null) {
      return openThread(scopeThreadRef(route.environmentId, route.threadId));
    }
    if (input.repository === null) return;
    setOpening(true);
    void input
      .launchBoatVm({
        hostEnvironmentId: hostId,
        sandboxId: vm.sandboxId,
        repository: input.repository === "scratch" ? null : input.repository,
        bannerKey: input.bannerKey,
      })
      .then((launched) => {
        if (launched !== null) {
          openThread(scopeThreadRef(launched.projectRef.environmentId, route.threadId));
        }
      })
      .finally(() => setOpening(false));
  };
  const label = boatVmEnvironmentLabel(vm.label);
  return {
    bannerItem: {
      id: `boat-vm-copy:${thread.id}`,
      variant: "info",
      icon: <CloudIcon />,
      title: `This thread continues on ${label}`,
      description: "This is a copy. Continue the conversation on the VM.",
      actions: (
        <Button
          size="xs"
          variant="ghost"
          disabled={opening || (route.environmentId === null && input.repository === null)}
          onClick={open}
        >
          {route.environmentId !== null
            ? "Open on VM"
            : vm.status === "running"
              ? "Connect and open"
              : "Start VM and open"}
        </Button>
      ),
    },
    sendDisabledReason: `Continue on ${label}`,
    continueOnNewVm: null,
  };
}
