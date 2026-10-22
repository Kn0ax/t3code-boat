import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  DesktopBridge,
  DesktopSandboxEnvironmentTarget,
  DesktopSandboxProviderId,
  DesktopSandboxSize,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { connectSandboxEnvironment as connectSandboxEnvironmentAtom } from "~/connection/onboarding";
import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  completeSandboxAttempt,
  DEFAULT_SANDBOX_IDLE_TIMEOUT_MINUTES,
  formatSandboxError,
  parseSandboxTargetFields,
  SANDBOX_SIZE_OPTIONS,
  sandboxAttemptKey,
  sandboxProviderOption,
} from "./CloudSandboxSettings.logic";

type SandboxBridge = Required<
  Pick<
    DesktopBridge,
    | "ensureSandboxEnvironment"
    | "setSandboxProviderCredential"
    | "clearSandboxProviderCredential"
    | "hasSandboxProviderCredential"
  >
>;

/** The desktop bridge when it can run cloud sandboxes; older desktop builds cannot. */
export function readSandboxBridge(bridge: DesktopBridge | undefined): SandboxBridge | null {
  if (
    bridge?.ensureSandboxEnvironment === undefined ||
    bridge.setSandboxProviderCredential === undefined ||
    bridge.clearSandboxProviderCredential === undefined ||
    bridge.hasSandboxProviderCredential === undefined
  ) {
    return null;
  }
  return {
    ensureSandboxEnvironment: bridge.ensureSandboxEnvironment,
    setSandboxProviderCredential: bridge.setSandboxProviderCredential,
    clearSandboxProviderCredential: bridge.clearSandboxProviderCredential,
    hasSandboxProviderCredential: bridge.hasSandboxProviderCredential,
  };
}

const REGION_DEFAULT = "__provider-default__";

/**
 * The "Cloud sandbox" mode of Add Environment. The API key goes straight to
 * the desktop's secure storage; this form never reads one back. An attempt
 * key outlives the form until the add succeeds, so retrying the same request
 * after a failure, even from a reopened dialog, adopts the sandbox the failed
 * attempt created instead of paying for another.
 */
export function CloudSandboxEnvironmentForm({
  bridge,
  onBusyChange,
  onConnected,
}: {
  readonly bridge: SandboxBridge;
  readonly onBusyChange: (busy: boolean) => void;
  /** Called only while the form is still open; the form reports the outcome itself. */
  readonly onConnected: () => void;
}) {
  const connectSandboxEnvironment = useAtomCommand(connectSandboxEnvironmentAtom, {
    reportFailure: false,
  });
  const providerId: DesktopSandboxProviderId = "boat";
  const [secret, setSecret] = useState("");
  const [label, setLabel] = useState("");
  const [size, setSize] = useState<DesktopSandboxSize>("small");
  const [region, setRegion] = useState("");
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState(
    String(DEFAULT_SANDBOX_IDLE_TIMEOUT_MINUTES),
  );
  const [installAgentClis, setInstallAgentClis] = useState(true);
  const [forwardGithubToken, setForwardGithubToken] = useState(false);
  // Whether each provider has a key in secure storage; unset until the desktop answers.
  const [savedCredentials, setSavedCredentials] = useState<
    Partial<Record<DesktopSandboxProviderId, boolean>>
  >({});
  const savedCredential = savedCredentials[providerId] ?? null;
  const setSavedCredential = (saved: boolean) =>
    setSavedCredentials((current) => ({ ...current, [providerId]: saved }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The dialog can close while a sandbox is still being created; the attempt
  // carries on, and its outcome then arrives as a toast instead.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onBusyChange(false);
    };
  }, [onBusyChange]);
  const provider = sandboxProviderOption(providerId);

  useEffect(() => {
    let cancelled = false;
    const record = (saved: boolean) => {
      if (!cancelled) setSavedCredentials((current) => ({ ...current, [providerId]: saved }));
    };
    bridge.hasSandboxProviderCredential(providerId).then(record, () => record(false));
    return () => {
      cancelled = true;
    };
  }, [bridge, providerId]);

  // Once unmounted, the dialog may be on another add whose busy state this must not touch.
  const updateBusy = (next: boolean) => {
    if (!mounted.current) return;
    setBusy(next);
    onBusyChange(next);
  };

  /** Saves the typed key, or shows why it could not; the form never holds it after this. */
  const storeCredential = async (typedSecret: string): Promise<boolean> => {
    try {
      await bridge.setSandboxProviderCredential({
        providerId,
        secret: typedSecret,
      });
    } catch (cause) {
      setError(formatSandboxError(cause, "Could not save the key in secure storage."));
      return false;
    }
    setSecret("");
    setSavedCredential(true);
    return true;
  };

  // Replacing a rejected key must not cost a new sandbox.
  const saveKeyOnly = async () => {
    setError(null);
    const typedSecret = secret.trim();
    if (await storeCredential(typedSecret)) {
      toastManager.add({
        type: "success",
        title: `${provider.label} key saved`,
        description: "Your saved sandboxes use it the next time they connect.",
      });
    }
  };

  const forgetCredential = async () => {
    setError(null);
    try {
      await bridge.clearSandboxProviderCredential(providerId);
      setSavedCredential(false);
    } catch (cause) {
      setError(formatSandboxError(cause, "Could not forget the saved key."));
    }
  };

  const connect = async () => {
    setError(null);
    let target: DesktopSandboxEnvironmentTarget;
    try {
      target = parseSandboxTargetFields({
        providerId,
        label,
        size,
        region,
        idleTimeoutMinutes,
        installAgentClis,
        forwardGithubToken,
      });
    } catch (cause) {
      setError(formatSandboxError(cause, "Check the sandbox settings."));
      return;
    }
    const typedSecret = secret.trim();
    if (typedSecret === "" && savedCredential !== true) {
      setError(`Enter your ${provider.label} ${provider.secretLabel.toLowerCase()}.`);
      return;
    }
    updateBusy(true);
    if (typedSecret !== "" && !(await storeCredential(typedSecret))) {
      updateBusy(false);
      return;
    }

    const idempotencyKey = sandboxAttemptKey(target, randomUUID);
    const result = await connectSandboxEnvironment({ target, idempotencyKey });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const message = formatSandboxError(
          squashAtomCommandFailure(result),
          `Could not create the ${provider.label} sandbox.`,
        );
        if (mounted.current) {
          setError(message);
        } else {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Could not create the ${provider.label} sandbox`,
              description: message,
            }),
          );
        }
      }
      updateBusy(false);
      return;
    }
    completeSandboxAttempt(target, idempotencyKey);
    toastManager.add({
      type: "success",
      title: "Sandbox ready",
      description: `${target.label || `${provider.label} sandbox`} is running T3 Code and will reconnect while it runs.`,
    });
    updateBusy(false);
    if (mounted.current) onConnected();
  };

  const idleMinutes = Number.parseInt(idleTimeoutMinutes.trim(), 10);
  const fieldLabel = "mb-1.5 block text-xs font-medium text-foreground";
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Create a remote machine running T3 Code with your boat account. Once connected, sign in to
        Claude Code or Codex on the sandbox. This key is separate from the server key for sandbox
        jobs and boat VMs in Integrations.
      </p>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={fieldLabel}>Name</span>
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="boat sandbox"
              disabled={busy}
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className={fieldLabel}>{provider.secretLabel}</span>
            <Input
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder={
                savedCredential === true
                  ? "Saved on this computer. Paste a new one to replace it."
                  : provider.secretPlaceholder
              }
              disabled={busy}
              spellCheck={false}
            />
          </label>
        </div>
        <p className="text-2xs text-muted-foreground">
          {savedCredential === true ? (
            <>
              A {provider.label} key is saved in this computer's secure storage.{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                disabled={busy}
                onClick={() => void forgetCredential()}
              >
                Forget it
              </button>
            </>
          ) : (
            "Allow creating, resuming, and deleting sandboxes when you create the key. It is kept in this computer's secure storage and never shown again."
          )}
          {secret.trim() === "" ? null : (
            <>
              {" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                disabled={busy}
                onClick={() => void saveKeyOnly()}
              >
                Save the key without creating a sandbox
              </button>
            </>
          )}
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="block">
            <span className={fieldLabel}>Size</span>
            <Select
              value={size}
              onValueChange={(value) => {
                if (typeof value === "string") setSize(value as DesktopSandboxSize);
              }}
            >
              <SelectTrigger size="sm" className="w-full" aria-label="Size" disabled={busy}>
                <SelectValue>
                  {SANDBOX_SIZE_OPTIONS.find((option) => option.id === size)?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {SANDBOX_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="block">
            <span className={fieldLabel}>Region</span>
            {provider.regions.length === 0 ? (
              <p className="flex h-8 items-center text-xs text-muted-foreground">
                {provider.regionNote}
              </p>
            ) : (
              <Select
                value={region === "" ? REGION_DEFAULT : region}
                onValueChange={(value) => {
                  if (typeof value === "string") setRegion(value === REGION_DEFAULT ? "" : value);
                }}
              >
                <SelectTrigger size="sm" className="w-full" aria-label="Region" disabled={busy}>
                  <SelectValue>
                    {provider.regions.find((option) => option.id === region)?.label ??
                      "Provider default"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value={REGION_DEFAULT}>
                    Provider default
                  </SelectItem>
                  {provider.regions.map((option) => (
                    <SelectItem hideIndicator key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          </div>
          <label className="block">
            <span className={fieldLabel}>Auto-stop after (minutes)</span>
            <Input
              value={idleTimeoutMinutes}
              onChange={(event) => setIdleTimeoutMinutes(event.target.value)}
              inputMode="numeric"
              disabled={busy}
              spellCheck={false}
            />
          </label>
        </div>
        {idleMinutes === 0 ? (
          <p className="text-2xs text-muted-foreground">
            0 keeps the sandbox running, and billing, until you stop it.
          </p>
        ) : provider.idleNote !== null ? (
          <p className="text-2xs text-muted-foreground">{provider.idleNote}</p>
        ) : null}
        <label className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-xs font-medium text-foreground">Install coding agents</span>
            <span className="block text-2xs text-muted-foreground">
              Install the Claude Code and Codex CLIs when the sandbox lacks them.
            </span>
          </span>
          <Switch
            size="sm"
            checked={installAgentClis}
            disabled={busy}
            aria-label="Install coding agents"
            onCheckedChange={setInstallAgentClis}
          />
        </label>
        <label className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-xs font-medium text-foreground">
              Forward my GitHub token
            </span>
            <span className="block text-2xs text-muted-foreground">
              Give the sandbox this computer's GitHub CLI login as GH_TOKEN.
            </span>
          </span>
          <Switch
            size="sm"
            checked={forwardGithubToken}
            disabled={busy}
            aria-label="Forward my GitHub token"
            onCheckedChange={setForwardGithubToken}
          />
        </label>
        {forwardGithubToken ? (
          <Alert variant="warning">
            <AlertDescription>
              The token reaches every repository and organization your GitHub account can, and
              anything running in the sandbox, including the agents, can use it as you.{" "}
              {provider.label} can read it too. Turn this on only for a sandbox you trust.
            </AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      <Button variant="outline" className="w-full" disabled={busy} onClick={() => void connect()}>
        {busy ? <Spinner className="size-3.5" /> : <PlusIcon className="size-3.5" />}
        {busy ? "Creating sandbox… this can take a minute" : "Create sandbox"}
      </Button>
      <p className="text-2xs text-muted-foreground">
        The sandbox bills your {provider.label} account while it runs. Stop or delete it from its
        row's menu.
      </p>
    </div>
  );
}
