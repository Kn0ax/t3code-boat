import { BoatVmTailscaleMode, type SandboxJobSettings } from "@t3tools/contracts";

import { formatBytes } from "../../lib/formatBytes";
import type { BoatCatalogView } from "../../state/boatSnapshots";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

type ConnectionMode = SandboxJobSettings["boatVmConnectionMode"];

const CONNECTION_LABELS: Readonly<Record<ConnectionMode, string>> = {
  boat: "Protected Boat URL",
  tailscale: "Tailscale",
};

const TAILSCALE_LABELS: Readonly<Record<BoatVmTailscaleMode, string>> = {
  off: "Off",
  "auth-key": "Auth key",
  snapshot: "Snapshot joins itself",
};

export const TAILSCALE_DESCRIPTIONS: Readonly<Record<BoatVmTailscaleMode, string>> = {
  off: "VMs stay off your tailnet, so a VM's ports cannot be previewed directly.",
  "auth-key": "T3 joins each VM to your tailnet with a reusable, ephemeral auth key.",
  snapshot:
    "The snapshot joins your tailnet itself. T3 waits for its connection and keeps its Tailscale hostname and login.",
};

interface NameOption {
  readonly name: string;
  readonly detail?: string;
}

/**
 * A name from the boat account, or a typed one while the account's lists
 * cannot be read, so a missing key or a boat outage never blocks the choice.
 * A saved name the account no longer has stays selectable, marked missing.
 */
function CatalogNameField({
  label,
  noneLabel,
  catalog,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly noneLabel: string;
  readonly catalog: BoatCatalogView;
  readonly options: ReadonlyArray<NameOption>;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  if (catalog.state === "loading") {
    return <p className="text-muted-foreground text-xs">Loading…</p>;
  }
  if (catalog.state !== "ready") {
    return (
      <Input
        key={value}
        size="sm"
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        placeholder="None"
        defaultValue={value}
        onBlur={(event) => {
          const next = event.target.value.trim();
          if (next !== value) onChange(next);
        }}
      />
    );
  }
  const missing = value !== "" && !options.some((option) => option.name === value);
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string" && next !== value) onChange(next);
      }}
      onOpenChange={(open) => {
        if (open) catalog.refresh();
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>{(selected: string) => (selected === "" ? noneLabel : selected)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value="">{noneLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.name} value={option.name}>
            {option.name}
            {option.detail === undefined ? null : (
              <span className="text-muted-foreground"> · {option.detail}</span>
            )}
          </SelectItem>
        ))}
        {missing ? (
          <SelectItem value={value}>
            {value}
            <span className="text-muted-foreground"> (not found)</span>
          </SelectItem>
        ) : null}
      </SelectPopup>
    </Select>
  );
}

export function BoatSnapshotPicker(props: {
  readonly catalog: BoatCatalogView;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const options =
    props.catalog.state === "ready"
      ? props.catalog.snapshots.map((snapshot) => {
          const detail = [
            snapshot.status === "ready" ? null : snapshot.status,
            snapshot.sizeBytes === undefined ? null : formatBytes(snapshot.sizeBytes),
          ].filter((part) => part !== null);
          return {
            name: snapshot.name,
            ...(detail.length === 0 ? {} : { detail: detail.join(" · ") }),
          };
        })
      : [];
  return <CatalogNameField label="Base snapshot" noneLabel="None" options={options} {...props} />;
}

export function BoatEnvironmentPicker(props: {
  readonly catalog: BoatCatalogView;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const options =
    props.catalog.state === "ready"
      ? props.catalog.environments.map((environment) => ({
          name: environment.name,
          ...(environment.isDefault ? { detail: "default" } : {}),
        }))
      : [];
  return (
    <CatalogNameField
      label="Boat environment"
      noneLabel="None (no secrets)"
      options={options}
      {...props}
    />
  );
}

/** One line when the account's lists cannot be read; the fields fall back to typed names. */
export function BoatCatalogError({ catalog }: { readonly catalog: BoatCatalogView }) {
  if (catalog.state !== "error") return null;
  return (
    <p className="text-muted-foreground text-xs">
      Could not load your boat snapshots and environments ({catalog.error}). Type their names
      instead.
    </p>
  );
}

export function BoatTailscalePicker({
  value,
  connectionMode,
  onChange,
}: {
  readonly value: BoatVmTailscaleMode;
  readonly connectionMode: ConnectionMode;
  readonly onChange: (value: BoatVmTailscaleMode) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (BoatVmTailscaleMode.literals.includes(next as BoatVmTailscaleMode)) {
          onChange(next as BoatVmTailscaleMode);
        }
      }}
    >
      <SelectTrigger size="sm" aria-label="Tailscale">
        <SelectValue>{(selected: BoatVmTailscaleMode) => TAILSCALE_LABELS[selected]}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {BoatVmTailscaleMode.literals.map((mode) => (
          <SelectItem
            key={mode}
            value={mode}
            // A Tailscale connection has no other way to reach the VM.
            disabled={mode === "off" && connectionMode === "tailscale"}
          >
            {TAILSCALE_LABELS[mode]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function BoatConnectionPicker({
  value,
  tailscale,
  onChange,
}: {
  readonly value: ConnectionMode;
  readonly tailscale: BoatVmTailscaleMode;
  readonly onChange: (value: ConnectionMode) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next === "boat" || next === "tailscale") onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label="VM connection">
        <SelectValue>{(selected: ConnectionMode) => CONNECTION_LABELS[selected]}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value="boat">{CONNECTION_LABELS.boat}</SelectItem>
        <SelectItem value="tailscale" disabled={tailscale === "off"}>
          {CONNECTION_LABELS.tailscale}
        </SelectItem>
      </SelectPopup>
    </Select>
  );
}
