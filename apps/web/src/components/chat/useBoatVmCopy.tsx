import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  boatVmThreadCopyOrigin,
  type BoatVmRepository,
  type EnvironmentId,
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
  type useLaunchBoatVm,
} from "~/state/boatVms";
import { useEnvironmentQuery } from "~/state/query";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * A copy of a boat VM thread points at the VM's thread while boat has the VM:
 * the composer banner opens that thread, starting or pairing the VM first, and
 * sending here is off. The server refuses such a send too.
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
} {
  const { thread } = input;
  const navigate = useNavigate();
  const pairings = useBoatVmPairings();
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
  if (route === null || hostId === null) return { bannerItem: null, sendDisabledReason: null };

  const openThread = (environmentId: EnvironmentId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, route.threadId)),
    });
  const open = () => {
    if (route.environmentId !== null) return openThread(route.environmentId);
    if (input.repository === null) return;
    setOpening(true);
    void input
      .launchBoatVm({
        hostEnvironmentId: hostId,
        sandboxId: route.vm.sandboxId,
        repository: input.repository === "scratch" ? null : input.repository,
        bannerKey: input.bannerKey,
      })
      .then((launched) => {
        if (launched !== null) openThread(launched.projectRef.environmentId);
      })
      .finally(() => setOpening(false));
  };
  const label = boatVmEnvironmentLabel(route.vm.label);
  return {
    bannerItem: {
      id: `boat-vm-copy:${thread?.id}`,
      variant: "info",
      icon: <CloudIcon />,
      title: `This thread continues on ${label}`,
      description: "This is a copy. It becomes yours once the VM is deleted.",
      actions: (
        <Button
          size="xs"
          variant="ghost"
          disabled={opening || (route.environmentId === null && input.repository === null)}
          onClick={open}
        >
          {route.environmentId !== null
            ? "Open on VM"
            : route.vm.status === "running"
              ? "Connect and open"
              : "Start VM and open"}
        </Button>
      ),
    },
    sendDisabledReason: `Continue on ${label}`,
  };
}
