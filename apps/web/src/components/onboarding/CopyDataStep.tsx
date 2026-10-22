import type { DesktopT3DataImportInput, DesktopT3DataImportState } from "@t3tools/contracts";
import { useState } from "react";

import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";

const PARTS: ReadonlyArray<{
  readonly key: keyof DesktopT3DataImportInput;
  readonly label: string;
}> = [
  { key: "projects", label: "Projects and threads" },
  { key: "settings", label: "Settings and keybindings" },
  { key: "secrets", label: "Provider logins and secrets" },
];

export function CopyDataStep({
  state,
  onSkip,
}: {
  readonly state: DesktopT3DataImportState;
  readonly onSkip: () => void;
}) {
  const [parts, setParts] = useState<DesktopT3DataImportInput>({
    projects: true,
    settings: true,
    secrets: true,
  });
  const [restarting, setRestarting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const error = requestError ?? state.lastError ?? null;
  const nothingSelected = !parts.projects && !parts.settings && !parts.secrets;

  const copy = async () => {
    const importT3Data = window.desktopBridge?.importT3Data;
    if (importT3Data === undefined) return;
    setRestarting(true);
    setRequestError(null);
    try {
      await importT3Data(parts);
    } catch (cause) {
      setRestarting(false);
      setRequestError(cause instanceof Error ? cause.message : "Could not start the copy.");
    }
  };

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Copy your T3 Code data
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        Copy from the official app at <span className="break-all">{state.sourcePath}</span>. This
        app keeps its own data, so changes here never reach the official app.
      </p>
      <fieldset className="mt-5 space-y-2" disabled={restarting}>
        <legend className="sr-only">Data to copy</legend>
        {PARTS.map((part) => (
          <label
            key={part.key}
            className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-3"
          >
            <Checkbox
              checked={parts[part.key]}
              onCheckedChange={(checked) =>
                setParts((current) => ({ ...current, [part.key]: checked === true }))
              }
            />
            <span className="text-sm font-medium">{part.label}</span>
          </label>
        ))}
      </fieldset>
      <p className="mt-3 text-xs text-muted-foreground">
        This computer’s identity and T3 Connect link are not copied.
      </p>
      {error !== null ? (
        <Alert className="mt-4" variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost-muted" disabled={restarting} onClick={onSkip}>
          Skip
        </Button>
        <Button autoFocus disabled={restarting || nothingSelected} onClick={() => void copy()}>
          {restarting ? "Restarting…" : "Copy and restart"}
        </Button>
      </div>
    </>
  );
}
