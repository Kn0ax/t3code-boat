import type { DesktopT3DataImportState } from "@t3tools/contracts";
import { useEffect, useState } from "react";

/** `undefined` while loading, `null` when this client cannot copy data. */
export type T3DataImportStatus = DesktopT3DataImportState | null | undefined;

// One read per renderer: the state only changes across the relaunch that runs the copy.
let pendingState: Promise<DesktopT3DataImportState | null> | null = null;

function canImportT3Data(): boolean {
  return typeof window !== "undefined" && window.desktopBridge?.getT3DataImport !== undefined;
}

function loadT3DataImport(): Promise<DesktopT3DataImportState | null> {
  const getState = window.desktopBridge?.getT3DataImport;
  if (getState === undefined) return Promise.resolve(null);
  pendingState ??= getState().catch(() => null);
  return pendingState;
}

export function useT3DataImport(): T3DataImportStatus {
  const supported = canImportT3Data();
  const [state, setState] = useState<T3DataImportStatus>(supported ? undefined : null);
  useEffect(() => {
    if (!supported) return;
    let current = true;
    void loadT3DataImport().then((next) => {
      if (current) setState(next);
    });
    return () => {
      current = false;
    };
  }, [supported]);
  return state;
}
