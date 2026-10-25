import {
  DEFAULT_SERVER_SETTINGS,
  type BoatVmTailscaleMode,
  type SandboxJobSettingsPatch,
  type ServerConfig,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { useBoatCatalog } from "../../state/boatSnapshots";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  BoatCatalogError,
  BoatConnectionPicker,
  BoatEnvironmentPicker,
  BoatSnapshotPicker,
  BoatTailscalePicker,
} from "../settings/BoatCatalogPickers";
import { useCreateBaseSnapshot } from "../settings/useCreateBaseSnapshot";
import { SecretKeyField } from "../settings/SecretKeyField";
import { Button } from "../ui/button";

type ConnectionMode = ServerConfig["settings"]["sandboxJobs"]["boatVmConnectionMode"];

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="w-56">{children}</div>
    </div>
  );
}

export function BoatStep({
  serverConfig,
  onContinue,
}: {
  readonly serverConfig: ServerConfig;
  readonly onContinue: () => void;
}) {
  const update = useAtomCommand(serverEnvironment.updateSettings, "Boat settings");
  const sandboxJobs = serverConfig.settings.sandboxJobs;
  const keySaved = sandboxJobs.providerKeys.boat !== "";
  const catalog = useBoatCatalog(serverConfig.environment.environmentId, keySaved);
  const [baseSnapshot, setBaseSnapshot] = useState(sandboxJobs.boatVmBaseSnapshot);
  const createBaseSnapshot = useCreateBaseSnapshot(serverConfig.environment.environmentId);
  const baseSnapshotName =
    baseSnapshot.trim() || DEFAULT_SERVER_SETTINGS.sandboxJobs.boatVmBaseSnapshot;
  const baseSnapshotExists =
    catalog.state === "ready" &&
    catalog.snapshots.some((snapshot) => snapshot.name === baseSnapshotName);
  const [boatEnvironment, setBoatEnvironment] = useState(sandboxJobs.boatVmEnvironment);
  const [tailscale, setTailscale] = useState<BoatVmTailscaleMode>(sandboxJobs.boatVmTailscale);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>(
    sandboxJobs.boatVmConnectionMode,
  );
  const save = (patch: typeof SandboxJobSettingsPatch.Type) =>
    update({
      environmentId: serverConfig.environment.environmentId,
      input: { patch: { sandboxJobs: patch } },
    });

  const saveAndContinue = () => {
    const patch = keySaved
      ? {
          ...(baseSnapshot.trim() !== sandboxJobs.boatVmBaseSnapshot
            ? { boatVmBaseSnapshot: baseSnapshot.trim() }
            : {}),
          ...(boatEnvironment.trim() !== sandboxJobs.boatVmEnvironment
            ? { boatVmEnvironment: boatEnvironment.trim() }
            : {}),
          ...(tailscale !== sandboxJobs.boatVmTailscale ? { boatVmTailscale: tailscale } : {}),
          ...(connectionMode !== sandboxJobs.boatVmConnectionMode
            ? { boatVmConnectionMode: connectionMode }
            : {}),
        }
      : {};
    if (Object.keys(patch).length > 0) void save(patch);
    onContinue();
  };

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Boat VMs</h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        Optional. With a boat API key, a thread can run on a cloud VM. You can change this later in
        Settings.
      </p>
      <div className="mt-5 space-y-4">
        <SecretKeyField
          label="boat API key"
          saved={keySaved}
          onSave={(boat) => void save({ providerKeys: { boat } })}
        />
        {keySaved ? (
          <>
            <BoatCatalogError catalog={catalog} />
            <Field label="Base snapshot">
              <BoatSnapshotPicker
                catalog={catalog}
                value={baseSnapshot}
                onChange={setBaseSnapshot}
              />
            </Field>
            {catalog.state === "ready" && !baseSnapshotExists ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  No {baseSnapshotName} snapshot yet. Create one so new VMs start with T3 and the
                  agents installed.
                </p>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={createBaseSnapshot.pending}
                  onClick={() => {
                    setBaseSnapshot(baseSnapshotName);
                    void createBaseSnapshot.run(baseSnapshotName);
                  }}
                >
                  {createBaseSnapshot.pending ? "Creating…" : "Create"}
                </Button>
              </div>
            ) : null}
            <Field label="Boat environment">
              <BoatEnvironmentPicker
                catalog={catalog}
                value={boatEnvironment}
                onChange={setBoatEnvironment}
              />
            </Field>
            <Field label="Tailscale">
              <BoatTailscalePicker
                value={tailscale}
                connectionMode={connectionMode}
                onChange={setTailscale}
              />
            </Field>
            {tailscale === "auth-key" ? (
              <SecretKeyField
                label="Tailscale auth key"
                saved={sandboxJobs.tailscaleAuthKey !== ""}
                onSave={(tailscaleAuthKey) => void save({ tailscaleAuthKey })}
              />
            ) : null}
            <Field label="VM connection">
              <BoatConnectionPicker
                value={connectionMode}
                tailscale={tailscale}
                onChange={setConnectionMode}
              />
            </Field>
          </>
        ) : null}
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost-muted" onClick={onContinue}>
          Skip
        </Button>
        <Button onClick={saveAndContinue}>Continue</Button>
      </div>
    </>
  );
}
