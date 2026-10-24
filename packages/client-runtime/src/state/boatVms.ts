import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createBoatVmEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** The boat VMs the environment holding the boat key can start. */
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:boat-vms:list",
      tag: WS_METHODS.boatVmsList,
      staleTimeMs: 30_000,
    }),
    launch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:boat-vms:launch",
      tag: WS_METHODS.boatVmsLaunch,
      scheduler: createAtomCommandScheduler(),
      // One launch per VM at a time; a second click joins nothing new.
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.sandboxId ?? "new"}`,
      },
    }),
    // Removes a new VM the launch made; a resumed one is kept.
    cancelLaunch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:boat-vms:cancel-launch",
      tag: WS_METHODS.boatVmsCancelLaunch,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.launchId}`,
      },
    }),
    launches: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:boat-vms:launches",
      tag: WS_METHODS.subscribeBoatVmLaunches,
    }),
    /** Fetches a VM's branches into the host's checkout under refs/t3/boat/; never pushes. */
    bringHome: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:boat-vms:bring-home",
      tag: WS_METHODS.boatVmsBringHome,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.sandboxId}`,
      },
    }),
  };
}
