import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

import { updateClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironments, usePrimaryEnvironmentId } from "./environments";

interface HostCandidate {
  readonly environmentId: EnvironmentId;
  readonly serverConfig?: Pick<ServerConfig, "environment"> | null | undefined;
}

/** Environments whose server can keep a boat key and start boat VMs and sandbox jobs. */
export const boatVmCapableEnvironmentIds = (
  environments: ReadonlyArray<HostCandidate>,
): EnvironmentId[] =>
  environments
    .filter((entry) => entry.serverConfig?.environment.capabilities.sandboxJobs === true)
    .map((entry) => entry.environmentId);

/**
 * The environment this device starts boat VMs and sandbox jobs through. A
 * choice that is no longer connected or capable falls back to the primary,
 * which is also the default.
 */
export const resolveBoatVmHostEnvironmentId = (
  chosen: EnvironmentId | null,
  primaryEnvironmentId: EnvironmentId | null,
  environments: ReadonlyArray<HostCandidate>,
): EnvironmentId | null =>
  chosen !== null && boatVmCapableEnvironmentIds(environments).includes(chosen)
    ? chosen
    : primaryEnvironmentId;

export function useBoatVmHostEnvironmentId(): EnvironmentId | null {
  const chosen = useClientSettings((settings) => settings.boatVmHostEnvironmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  return resolveBoatVmHostEnvironmentId(chosen, primaryEnvironmentId, environments);
}

export const setBoatVmHostEnvironmentId = (environmentId: EnvironmentId) =>
  updateClientSettings({ boatVmHostEnvironmentId: environmentId });
