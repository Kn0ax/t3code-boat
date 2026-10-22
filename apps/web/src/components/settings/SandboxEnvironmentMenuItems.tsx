import { sandboxProviderLabel } from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { PlayIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import {
  destroySandboxEnvironment as destroySandboxEnvironmentAtom,
  resumeSandboxEnvironment as resumeSandboxEnvironmentAtom,
  stopSandboxEnvironment as stopSandboxEnvironmentAtom,
} from "~/connection/onboarding";
import type { EnvironmentPresentation } from "~/state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { MenuItem } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { formatSandboxError, savedSandboxProfile } from "./CloudSandboxSettings.logic";

type SandboxAction = "resume" | "stop" | "destroy";

const ACTION_FAILURE_TITLES: Readonly<Record<SandboxAction, string>> = {
  resume: "Could not start the sandbox",
  stop: "Could not stop the sandbox",
  destroy: "Could not delete the sandbox",
};

// The menu unmounts when it closes, and a start can take minutes, so the
// running action lives outside it: a reopened menu still shows it and cannot
// start it twice.
const pendingActions = new Map<EnvironmentId, SandboxAction>();
const pendingListeners = new Set<() => void>();

function setPendingAction(environmentId: EnvironmentId, action: SandboxAction | null): void {
  if (action === null) pendingActions.delete(environmentId);
  else pendingActions.set(environmentId, action);
  for (const listener of pendingListeners) listener();
}

function subscribePendingActions(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
}

/**
 * Start, stop and delete for a saved cloud sandbox, in its row's menu.
 * Renders nothing for any other environment. Stopping keeps the disk; only
 * Delete removes the sandbox, after a confirmation.
 */
export function SandboxEnvironmentMenuItems({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const resume = useAtomCommand(resumeSandboxEnvironmentAtom, { reportFailure: false });
  const stop = useAtomCommand(stopSandboxEnvironmentAtom, { reportFailure: false });
  const destroy = useAtomCommand(destroySandboxEnvironmentAtom, { reportFailure: false });
  const environmentId = environment.environmentId;
  const pending = useSyncExternalStore(
    subscribePendingActions,
    () => pendingActions.get(environmentId) ?? null,
  );
  const profile = savedSandboxProfile(environment.entry);
  if (profile === null) {
    return null;
  }
  const provider = sandboxProviderLabel(profile.sandbox.providerId);
  const connected = environment.connection.phase === "connected";

  const run = async (action: SandboxAction) => {
    if (action === "destroy") {
      const confirmed = await requestConfirmDialog(
        `Delete the ${provider} sandbox behind ${environment.label}?\nThis deletes the sandbox and everything on its disk, including work that was not pushed, and removes it from this device. It cannot be undone.`,
        { variant: "destructive" },
      );
      if (confirmed !== true || pendingActions.has(environmentId)) return;
    }
    setPendingAction(environmentId, action);
    const command = action === "resume" ? resume : action === "stop" ? stop : destroy;
    const result = await command(environmentId);
    setPendingAction(environmentId, null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: ACTION_FAILURE_TITLES[action],
            description: formatSandboxError(
              squashAtomCommandFailure(result),
              `${provider} did not respond.`,
            ),
          }),
        );
      }
      return;
    }
    toastManager.add({
      type: "success",
      title:
        action === "resume"
          ? "Sandbox started"
          : action === "stop"
            ? "Sandbox stopped"
            : "Sandbox deleted",
      description:
        action === "resume"
          ? `${environment.label} is reconnecting.`
          : action === "stop"
            ? `${environment.label} is switched off and its ${provider} sandbox stopped. Its disk is kept.`
            : `${environment.label} and its ${provider} sandbox are gone.`,
    });
  };

  return (
    <>
      {connected ? null : (
        <MenuItem
          closeOnClick={false}
          disabled={pending !== null}
          onClick={() => void run("resume")}
        >
          <PlayIcon />
          {pending === "resume" ? "Starting sandbox…" : "Start sandbox"}
        </MenuItem>
      )}
      <MenuItem closeOnClick={false} disabled={pending !== null} onClick={() => void run("stop")}>
        <SquareIcon />
        {pending === "stop" ? "Stopping sandbox…" : "Stop sandbox"}
      </MenuItem>
      {/* Closes the menu, which would otherwise stay above the confirmation. */}
      <MenuItem
        variant="destructive"
        disabled={pending !== null}
        onClick={() => void run("destroy")}
      >
        <Trash2Icon />
        {pending === "destroy" ? "Deleting sandbox…" : "Delete sandbox…"}
      </MenuItem>
    </>
  );
}
