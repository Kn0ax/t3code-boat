import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  boatVmSnapshotNameForLabel,
  isBoatSnapshotName,
  type BoatVm,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { boatSnapshotEnvironment, watchBoatSnapshotSave } from "../state/boatSnapshots";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { toastManager } from "./ui/toast";

interface SaveTarget {
  readonly hostEnvironmentId: EnvironmentId;
  readonly vm: Pick<BoatVm, "sandboxId" | "label">;
  /** The name to offer; the VM's repository snapshot name when omitted. */
  readonly name?: string;
}

// Set by the command palette, which closes as its command runs, and rendered beside it.
const saveBoatSnapshotTargetAtom = Atom.make<SaveTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("boat-vms:save-snapshot-dialog"),
);

export function openSaveBoatSnapshotDialog(target: SaveTarget): void {
  appAtomRegistry.set(saveBoatSnapshotTargetAtom, target);
}

export function SaveBoatSnapshotDialogHost() {
  const target = useAtomValue(saveBoatSnapshotTargetAtom);
  if (target === null) return null;
  return (
    <SaveBoatSnapshotDialog
      key={`${target.hostEnvironmentId}:${target.vm.sandboxId}`}
      target={target}
      onClose={() => appAtomRegistry.set(saveBoatSnapshotTargetAtom, null)}
    />
  );
}

function SaveBoatSnapshotDialog({
  target,
  onClose,
}: {
  readonly target: SaveTarget;
  readonly onClose: () => void;
}) {
  const { vm, hostEnvironmentId } = target;
  const repositoryName = boatVmSnapshotNameForLabel(vm.label);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(target.name ?? repositoryName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveSnapshot = useAtomCommand(boatSnapshotEnvironment.saveSnapshot, {
    reportFailure: false,
  });
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.select());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const trimmed = name.trim();
  const valid = isBoatSnapshotName(trimmed);

  const submit = async () => {
    if (!valid || pending) return;
    setPending(true);
    setError(null);
    const started = await saveSnapshot({
      environmentId: hostEnvironmentId,
      input: { sandboxId: vm.sandboxId, name: trimmed },
    });
    setPending(false);
    if (started._tag === "Failure") {
      const failure = squashAtomCommandFailure(started);
      setError(failure instanceof Error ? failure.message : "Could not save the snapshot.");
      return;
    }
    onClose();
    const usage =
      trimmed === repositoryName
        ? `New VMs for ${vm.label} start from it.`
        : "Choose it as the base snapshot in Settings to start new VMs from it.";
    const toastId = toastManager.add({
      type: "loading",
      title: `Saving snapshot ${trimmed}…`,
      description: `boat is capturing ${vm.label}, which can take several minutes. ${usage}`,
    });
    const outcome = await watchBoatSnapshotSave({
      environmentId: hostEnvironmentId,
      name: trimmed,
    });
    toastManager.update(
      toastId,
      outcome === "ready"
        ? { type: "success", title: `Snapshot ${trimmed} is ready`, description: usage }
        : outcome === "failed"
          ? {
              type: "error",
              title: `Could not save snapshot ${trimmed}`,
              description: "boat could not save it. Try again from the command palette.",
            }
          : {
              type: "warning",
              title: `Snapshot ${trimmed} is still saving`,
              description: "boat has not finished after 20 minutes. Check it in Settings later.",
            },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => (open || pending ? undefined : onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Save {vm.label} as a snapshot</DialogTitle>
          <DialogDescription>
            boat freezes the VM's disk under this name. Saving under an existing name replaces that
            snapshot once the new one is ready.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            ref={inputRef}
            aria-label="Snapshot name"
            autoComplete="off"
            spellCheck={false}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void submit();
            }}
          />
          {!valid ? (
            <p className="text-destructive text-xs">
              Use up to 63 lowercase letters, digits, or dashes, starting with a letter or digit.
            </p>
          ) : error !== null ? (
            <p className="text-destructive text-xs">{error}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={pending || !valid}
          >
            {pending ? "Saving…" : "Save snapshot"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
