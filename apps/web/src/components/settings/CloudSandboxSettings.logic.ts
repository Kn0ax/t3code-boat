import {
  type ConnectionCatalogEntry,
  connectionRoutes,
  type SandboxConnectionProfile,
} from "@t3tools/client-runtime/connection";
import type {
  DesktopSandboxEnvironmentTarget,
  DesktopSandboxProviderId,
  DesktopSandboxSize,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

export interface SandboxProviderOption {
  readonly id: DesktopSandboxProviderId;
  readonly label: string;
  /** What the provider calls the secret the user pastes. */
  readonly secretLabel: string;
  readonly secretPlaceholder: string;
  /** Region ids the provider lets a create pick; empty when it picks itself. */
  readonly regions: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly regionNote: string | null;
  /** What the stop timer means when it is a deadline rather than idle time. */
  readonly idleNote: string | null;
}

export const SANDBOX_PROVIDER_OPTIONS: ReadonlyArray<SandboxProviderOption> = [
  {
    id: "boat",
    label: "boat",
    secretLabel: "API key",
    secretPlaceholder: "boat_…",
    regions: [],
    regionNote: "boat runs every sandbox in the EU.",
    idleNote:
      "boat stops the sandbox this many minutes after it starts, even mid-task, whether or not it is idle. Use 0 to keep it running.",
  },
];

export function sandboxProviderOption(providerId: DesktopSandboxProviderId): SandboxProviderOption {
  return SANDBOX_PROVIDER_OPTIONS.find((option) => option.id === providerId)!;
}

export const SANDBOX_SIZE_OPTIONS: ReadonlyArray<{
  readonly id: DesktopSandboxSize;
  readonly label: string;
}> = [
  { id: "small", label: "Small" },
  { id: "medium", label: "Medium" },
  { id: "large", label: "Large" },
];

/** Long enough to step away from a task, short enough not to bill a forgotten sandbox all day. */
export const DEFAULT_SANDBOX_IDLE_TIMEOUT_MINUTES = 30;
const MAX_SANDBOX_IDLE_TIMEOUT_MINUTES = 7 * 24 * 60;

/** The add-environment form's fields as a sandbox target, or an error a person can act on. */
export function parseSandboxTargetFields(input: {
  readonly providerId: DesktopSandboxProviderId;
  readonly label: string;
  readonly size: DesktopSandboxSize;
  readonly region: string;
  readonly idleTimeoutMinutes: string;
  readonly installAgentClis: boolean;
  readonly forwardGithubToken: boolean;
}): DesktopSandboxEnvironmentTarget {
  const idleText = input.idleTimeoutMinutes.trim();
  const idleTimeoutMinutes =
    idleText === "" ? DEFAULT_SANDBOX_IDLE_TIMEOUT_MINUTES : Number.parseInt(idleText, 10);
  if (
    !/^\d*$/u.test(idleText) ||
    !Number.isSafeInteger(idleTimeoutMinutes) ||
    idleTimeoutMinutes > MAX_SANDBOX_IDLE_TIMEOUT_MINUTES
  ) {
    throw new Error(
      `Idle timeout must be a whole number of minutes from 0 to ${MAX_SANDBOX_IDLE_TIMEOUT_MINUTES}.`,
    );
  }
  const option = sandboxProviderOption(input.providerId);
  const region = input.region.trim();
  if (region !== "" && !option.regions.some((candidate) => candidate.id === region)) {
    throw new Error(`${option.label} has no region "${region}".`);
  }
  return {
    providerId: input.providerId,
    label: input.label.trim(),
    size: input.size,
    ...(region === "" ? {} : { region }),
    idleTimeoutMinutes,
    installAgentClis: input.installAgentClis,
    forwardGithubToken: input.forwardGithubToken,
  };
}

/**
 * Unfinished adds, by what they asked a provider to create. They live outside
 * the form because closing the dialog or switching its mode unmounts it, and
 * a retry from a fresh form must adopt the sandbox the earlier attempt created
 * (or join that attempt while it still runs) instead of paying for a second.
 * Only the same request is a retry: a sandbox's size, region, idle timeout and
 * environment (the forwarded GitHub token) are fixed when it is created, so a
 * changed one gets a new sandbox. Cleared once an add succeeds.
 */
const pendingSandboxAttemptKeys = new Map<string, string>();

function sandboxAttemptShape(target: DesktopSandboxEnvironmentTarget): string {
  return JSON.stringify([
    target.providerId,
    target.size,
    target.region ?? null,
    target.idleTimeoutMinutes,
    target.forwardGithubToken,
  ]);
}

/** The idempotency key for adding this target: an unfinished attempt's, else a new one. */
export function sandboxAttemptKey(
  target: DesktopSandboxEnvironmentTarget,
  mintKey: () => string,
): string {
  const shape = sandboxAttemptShape(target);
  const pending = pendingSandboxAttemptKeys.get(shape);
  if (pending !== undefined) return pending;
  const key = mintKey();
  pendingSandboxAttemptKeys.set(shape, key);
  return key;
}

/** Marks the add with this key as done; adding the same target again creates a new sandbox. */
export function completeSandboxAttempt(target: DesktopSandboxEnvironmentTarget, key: string): void {
  const shape = sandboxAttemptShape(target);
  if (pendingSandboxAttemptKeys.get(shape) === key) {
    pendingSandboxAttemptKeys.delete(shape);
  }
}

/** The saved sandbox behind an environment's routes, if it runs in one. */
export function savedSandboxProfile(
  entry: ConnectionCatalogEntry,
): SandboxConnectionProfile | null {
  for (const route of connectionRoutes(entry)) {
    const profile = Option.getOrNull(route.profile);
    if (profile?._tag === "SandboxConnectionProfile") {
      return profile;
    }
  }
  return null;
}

const REMOTE_METHOD_PREFIX = /^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/u;

/** An error for the form, without Electron's "Error invoking remote method" wrapper. */
export function formatSandboxError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const trimmed = message.replace(REMOTE_METHOD_PREFIX, "").trim();
  return trimmed === "" ? fallback : trimmed;
}
