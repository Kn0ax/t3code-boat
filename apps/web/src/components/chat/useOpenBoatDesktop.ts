import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthPreviewOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useRef } from "react";

import { canOpenLinksInApp } from "~/browser/browserLinkTarget";
import { openUrlInPreview } from "~/browser/openFileInPreview";
import { readLocalApi } from "~/localApi";
import {
  boatDesktopEnvironment,
  boatDesktopOpensInBrowserPanel,
  boatVmSandboxIdOf,
  waitForBoatDesktop,
} from "~/state/boatDesktop";
import { useBoatVmHostEnvironmentId } from "~/state/boatVmHost";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { readEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { toastManager } from "../ui/toast";

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 2 * 60_000;

/**
 * Opens the desktop of the boat VM the thread runs on, through the environment
 * managing boat VMs. Undefined when the thread is not on a boat VM or this
 * client may not ask for the desktop.
 */
export function useOpenBoatDesktop(threadRef: ScopedThreadRef | null): (() => void) | undefined {
  const { environments } = useEnvironments();
  const hostEnvironmentId = useBoatVmHostEnvironmentId();
  const allowed = useAtomValue(boatDesktopEnvironment.desktop.permissionAtom(hostEnvironmentId));
  const requestDesktop = useAtomCommand(boatDesktopEnvironment.desktop, { reportFailure: false });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const opening = useRef(false);

  const environment =
    threadRef === null
      ? undefined
      : environments.find((entry) => entry.environmentId === threadRef.environmentId);
  const sandboxId = boatVmSandboxIdOf(environment?.entry.profile);
  if (threadRef === null || sandboxId === null || hostEnvironmentId === null || !allowed) {
    return undefined;
  }
  const vmLabel = environment?.label ?? sandboxId;

  const run = async () => {
    let toastId: ReturnType<typeof toastManager.add> | undefined;
    const fail = (description: string) => {
      const toast = {
        type: "error" as const,
        title: "Could not open the boat desktop",
        description,
      };
      if (toastId === undefined) toastManager.add(toast);
      else toastManager.update(toastId, toast);
    };
    try {
      const url = await waitForBoatDesktop({
        request: async () => {
          const result = await requestDesktop({
            environmentId: hostEnvironmentId,
            input: { sandboxId },
          });
          if (result._tag === "Failure") {
            const failure = squashAtomCommandFailure(result);
            throw failure instanceof Error ? failure : new Error(String(failure));
          }
          if (result.value.status === "provisioning" && toastId === undefined) {
            toastId = toastManager.add({ type: "loading", title: "Starting the VM desktop…" });
          }
          return result.value;
        },
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: Date.now,
        intervalMs: POLL_INTERVAL_MS,
        timeoutMs: POLL_TIMEOUT_MS,
      });
      if (url === null) {
        fail(`${vmLabel}'s desktop did not start in time. Try again in a moment.`);
        return;
      }
      if (toastId !== undefined) toastManager.close(toastId);
      const inPanel = boatDesktopOpensInBrowserPanel(
        url,
        readEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope) &&
          canOpenLinksInApp(threadRef),
      );
      // Not through the link opener: it records visits, and this URL carries the desktop's token.
      if (inPanel) {
        const opened = await openUrlInPreview({ threadRef, url, openPreview });
        if (opened._tag === "Success" || isAtomCommandInterrupted(opened)) return;
      }
      const api = readLocalApi();
      if (!api) {
        fail("Link opening is unavailable.");
        return;
      }
      await api.shell.openExternal(url);
    } catch (error) {
      fail(error instanceof Error ? error.message : "The request failed.");
    }
  };

  return () => {
    if (opening.current) return;
    opening.current = true;
    void run().finally(() => {
      opening.current = false;
    });
  };
}
