import { resolveBoatVmHostEnvironmentId } from "@t3tools/client-runtime/boat-vms";
import type { EnvironmentId } from "@t3tools/contracts";

import { updateClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironments, usePrimaryEnvironmentId } from "./environments";

/**
 * The environment this device starts boat VMs and sandbox jobs through. A
 * choice that is no longer connected or capable falls back to the primary,
 * which is also the default.
 */
export function useBoatVmHostEnvironmentId(): EnvironmentId | null {
  const chosen = useClientSettings((settings) => settings.boatVmHostEnvironmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  return resolveBoatVmHostEnvironmentId(chosen, primaryEnvironmentId, environments);
}

export const setBoatVmHostEnvironmentId = (environmentId: EnvironmentId) =>
  updateClientSettings({ boatVmHostEnvironmentId: environmentId });
