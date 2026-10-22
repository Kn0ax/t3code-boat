import type { ConnectionProfile } from "@t3tools/client-runtime/connection";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type BoatVmDesktop } from "@t3tools/contracts";
import type * as Option from "effect/Option";

import { connectionAtomRuntime } from "../connection/runtime";

export const boatDesktopEnvironment = {
  desktop: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:boat-vms:desktop",
    tag: WS_METHODS.boatVmsDesktop,
  }),
};

/** The boat VM a saved connection reaches, from either way T3 pairs with one. */
export const boatVmSandboxIdOf = (
  profile: Option.Option<ConnectionProfile> | undefined,
): string | null => {
  if (profile?._tag !== "Some" || profile.value._tag !== "BearerConnectionProfile") return null;
  return profile.value.boatVm?.sandboxId ?? profile.value.boatProxy?.sandboxId ?? null;
};

/**
 * The Browser panel renders web pages only; any other scheme boat may hand
 * out goes to the system's handler for it.
 */
export const boatDesktopOpensInBrowserPanel = (url: string, browserPanelAvailable: boolean) =>
  browserPanelAvailable && /^https?:$/.test(URL.parse(url)?.protocol ?? "");

/** Asks until boat has the desktop ready; null when it was still provisioning at the deadline. */
export async function waitForBoatDesktop(options: {
  readonly request: () => Promise<BoatVmDesktop>;
  readonly wait: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly intervalMs: number;
  readonly timeoutMs: number;
}): Promise<string | null> {
  const deadline = options.now() + options.timeoutMs;
  for (;;) {
    const desktop = await options.request();
    if (desktop.status === "ready") return desktop.url;
    if (options.now() + options.intervalMs > deadline) return null;
    await options.wait(options.intervalMs);
  }
}
