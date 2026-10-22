import type { DesktopSandboxProviderId } from "@t3tools/contracts";
import { boatSandboxProvider } from "@t3tools/sandbox-boat";
import type { SandboxProviderId, SandboxProviderShape } from "@t3tools/sandbox-core";
import type * as Effect from "effect/Effect";

import type { DesktopSandboxProviderCredential } from "./DesktopSandboxCredentials.ts";

/** A provider that failed to start, before any sandbox exists. `detail` is shown in the UI. */
export type DesktopSandboxProviderFactory = (
  credential: DesktopSandboxProviderCredential,
) => Effect.Effect<SandboxProviderShape, { readonly detail: string }>;

export const DESKTOP_SANDBOX_PROVIDER_FACTORIES: Record<
  DesktopSandboxProviderId,
  DesktopSandboxProviderFactory
> = {
  boat: (credential) => boatSandboxProvider(credential.secret),
};

export function sandboxProviderName(providerId: DesktopSandboxProviderId): string {
  return providerId;
}

// The IPC contract restates the provider id so the renderer need not depend
// on sandbox-core. This fails to compile if the two lists drift apart.
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const providerIdsMatch: Exactly<DesktopSandboxProviderId, SandboxProviderId> = true;
void providerIdsMatch;
