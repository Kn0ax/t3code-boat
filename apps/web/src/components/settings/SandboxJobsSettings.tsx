import { boatVmCapableEnvironmentIds } from "@t3tools/client-runtime/boat-vms";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  SandboxJobSize,
  type ServerSettings,
} from "@t3tools/contracts";
import { useState } from "react";

import { setBoatVmHostEnvironmentId, useBoatVmHostEnvironmentId } from "../../state/boatVmHost";
import { useBoatCatalog } from "../../state/boatSnapshots";
import { useBoatVmEnvironmentIds } from "../../state/boatVms";
import { useEnvironments } from "../../state/environments";
import { resolveServerSelfUpdateCapability } from "../../versionSkew";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  BoatCatalogError,
  BoatConnectionPicker,
  BoatEnvironmentPicker,
  BoatSnapshotPicker,
  BoatTailscalePicker,
  TAILSCALE_DESCRIPTIONS,
} from "./BoatCatalogPickers";
import { SaveVmAsSnapshotMenu } from "./SaveVmAsSnapshotMenu";
import { useCreateBaseSnapshot } from "./useCreateBaseSnapshot";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { ScopedSwitch } from "./ScopedSwitch";
import { SecretKeyField } from "./SecretKeyField";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

type SandboxJobSettings = ServerSettings["sandboxJobs"];
type ProviderKeyId = keyof SandboxJobSettings["providerKeys"];
type AgentKeyName = keyof SandboxJobSettings["agentKeys"];

const PROVIDER_KEYS: ReadonlyArray<{ readonly id: ProviderKeyId; readonly label: string }> = [
  { id: "boat", label: "boat API key" },
];

const AGENT_KEYS: ReadonlyArray<{ readonly name: AgentKeyName; readonly label: string }> = [
  { name: "ANTHROPIC_API_KEY", label: "Anthropic API key (Claude)" },
  { name: "OPENAI_API_KEY", label: "OpenAI API key (Codex)" },
  { name: "GH_TOKEN", label: "GitHub token (private repositories)" },
];

const SIZE_LABELS: Readonly<Record<SandboxJobSize, string>> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

function LimitField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <NumberField
      value={value}
      min={1}
      step={1}
      size="sm"
      className="w-24"
      onValueChange={(next) => {
        if (next !== null && next >= 1) onChange(Math.round(next));
      }}
    >
      <NumberFieldGroup>
        <NumberFieldInput aria-label={label} />
      </NumberFieldGroup>
    </NumberField>
  );
}

/**
 * Links a server without a boat key to the one that has it, so this server's
 * agents use boat VMs through it. The pairing code is spent on save.
 */
function BoatManagerLinkRow({
  boatManager,
  onSave,
}: {
  readonly boatManager: SandboxJobSettings["boatManager"];
  readonly onSave: (patch: { readonly url: string; readonly pairingCode?: string }) => void;
}) {
  const [url, setUrl] = useState(boatManager.url);
  const [pairingCode, setPairingCode] = useState("");
  // The row remounts on every link change, which is when the expiry can change.
  const [nowMs] = useState(() => Date.now());
  const linked = boatManager.url !== "";
  const expiresAt = Date.parse(boatManager.expiresAt);
  const current = linked && boatManager.token !== "" && !(expiresAt <= nowMs);
  const host = linked && URL.canParse(boatManager.url) ? new URL(boatManager.url).host : "";
  return (
    <SettingsRow
      title="Boat manager"
      serverScoped
      settingKeys={["sandboxJobs"]}
      description="Without a boat key here, agents on this environment can still use boat VMs through the environment that has the key. Pair with a code from its Settings, Connections."
      status={
        linked ? (
          current ? (
            `Linked to ${host}${Number.isNaN(expiresAt) ? "" : ` until ${new Date(expiresAt).toLocaleDateString()}`}.`
          ) : (
            <span className="block text-warning-foreground">
              The link to {host} has ended. Pair again with a new code.
            </span>
          )
        ) : undefined
      }
    >
      <form
        className="grid max-w-2xl gap-2 pb-3.5 sm:grid-cols-[1fr_10rem_auto_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          if (url.trim() === "" || pairingCode.trim() === "") return;
          onSave({ url: url.trim(), pairingCode: pairingCode.trim() });
          setPairingCode("");
        }}
      >
        <Input
          size="sm"
          type="url"
          autoComplete="off"
          spellCheck={false}
          aria-label="Boat manager URL"
          placeholder="Boat manager URL"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Input
          size="sm"
          autoComplete="off"
          spellCheck={false}
          aria-label="Pairing code"
          placeholder="Pairing code"
          value={pairingCode}
          onChange={(event) => setPairingCode(event.target.value)}
        />
        <Button type="submit" size="xs" disabled={url.trim() === "" || pairingCode.trim() === ""}>
          {linked ? "Relink" : "Link"}
        </Button>
        {linked ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setUrl("");
              onSave({ url: "" });
            }}
          >
            Unlink
          </Button>
        ) : null}
      </form>
    </SettingsRow>
  );
}

/** Cloud sandbox nodes agents can start through the sandbox_job MCP tools. */
export function SandboxJobsSettings() {
  const { scope, environment, selectScope } = useSettingsScope();
  const { environments } = useEnvironments();
  const hostEnvironmentId = useBoatVmHostEnvironmentId();
  const vmEnvironmentIds = useBoatVmEnvironmentIds();
  // A boat VM never manages others, and once one environment does, it is the only choice here.
  const eligibleEnvironmentIds = boatVmCapableEnvironmentIds(environments).filter(
    (id) => !vmEnvironmentIds.has(id),
  );
  const choiceEnvironmentIds =
    hostEnvironmentId !== null && eligibleEnvironmentIds.includes(hostEnvironmentId)
      ? [hostEnvironmentId]
      : eligibleEnvironmentIds;
  if (
    scope.kind !== "environment" ||
    environment?.serverConfig?.environment.capabilities.sandboxJobs !== true
  ) {
    return (
      <SettingsSection id="sandbox-jobs" title="Sandbox jobs">
        <SettingsScopeNotice
          target="environment"
          targetId="sandbox-jobs"
          eligibleEnvironmentIds={choiceEnvironmentIds}
        >
          {eligibleEnvironmentIds.length > 0
            ? "Choose one environment to manage Boat VMs and save their keys."
            : "Connect an environment running a version of T3 Code that supports Boat VMs to configure sandbox jobs."}
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }
  if (hostEnvironmentId !== null && environment.environmentId !== hostEnvironmentId) {
    const hostLabel =
      environments.find((entry) => entry.environmentId === hostEnvironmentId)?.label ??
      "another environment";
    return (
      <SettingsSection id="sandbox-jobs" title="Sandbox jobs">
        <SettingsRow
          title="Managed elsewhere"
          description={`Boat VMs and sandbox jobs are managed by ${hostLabel}.`}
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={() => selectScope({ machine: hostEnvironmentId })}
            >
              Open {hostLabel}
            </Button>
          }
        />
      </SettingsSection>
    );
  }
  return (
    <SandboxJobsForm
      key={environment.environmentId}
      hostEnvironmentId={hostEnvironmentId}
      eligibleEnvironmentIds={eligibleEnvironmentIds}
    />
  );
}

function SandboxJobsForm({
  hostEnvironmentId,
  eligibleEnvironmentIds,
}: {
  readonly hostEnvironmentId: EnvironmentId | null;
  readonly eligibleEnvironmentIds: readonly EnvironmentId[];
}) {
  const { sandboxJobs } = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const update = (patch: NonNullable<Parameters<typeof updateSettings>[0]["sandboxJobs"]>) =>
    updateSettings({ sandboxJobs: patch });
  const defaults = DEFAULT_SERVER_SETTINGS.sandboxJobs;
  const { environment } = useSettingsScope();
  const { environments } = useEnvironments();
  const environmentLabel = (environmentId: EnvironmentId) =>
    environments.find((entry) => entry.environmentId === environmentId)?.label ?? environmentId;
  // boat archives a VM once its deadline passes, and only a running server pushes it out.
  const hostedByDesktopApp =
    resolveServerSelfUpdateCapability(environment?.serverConfig) === "desktop-managed";
  const tailscaleOff = sandboxJobs.boatVmTailscale === "off";
  const catalog = useBoatCatalog(
    environment?.environmentId ?? null,
    sandboxJobs.providerKeys.boat !== "",
  );
  const createBaseSnapshot = useCreateBaseSnapshot(environment?.environmentId ?? null);
  // None still offers the default name, and picks it once created.
  const baseSnapshotName = sandboxJobs.boatVmBaseSnapshot || defaults.boatVmBaseSnapshot;
  const baseSnapshotMissing =
    catalog.state === "ready" &&
    sandboxJobs.boatVmBaseSnapshot !== "" &&
    !catalog.snapshots.some((snapshot) => snapshot.name === sandboxJobs.boatVmBaseSnapshot);

  return (
    <div className="space-y-4">
      <SettingsSection id="sandbox-jobs" title="Sandbox jobs">
        <SettingsRow
          {...searchableSetting("sandbox-jobs")}
          serverScoped
          settingKeys={["sandboxJobs"]}
          description="Let agents hand work to a cloud sandbox. Each job keeps its sandbox and disk until an agent or you complete it, which brings the work back as a git branch, or discard it. Sandboxes bill your provider account."
          control={
            <ScopedSwitch
              settingKeys={["sandboxJobs"]}
              checked={sandboxJobs.enabled}
              aria-label="Sandbox jobs"
              onCheckedChange={(checked) => update({ enabled: Boolean(checked) })}
            />
          }
        />
        <SettingsRow
          title="Provider keys"
          serverScoped
          settingKeys={["sandboxJobs"]}
          description={`Saved on ${environment?.label ?? "this environment"}. The same boat key starts sandbox jobs and boat VMs. It is separate from a key saved in the desktop app under Connections.`}
        >
          <div className="grid max-w-2xl gap-2 pb-3.5">
            {PROVIDER_KEYS.map((provider) => (
              <SecretKeyField
                key={provider.id}
                label={provider.label}
                saved={sandboxJobs.providerKeys[provider.id] !== ""}
                onSave={(value) => update({ providerKeys: { [provider.id]: value } })}
              />
            ))}
          </div>
        </SettingsRow>
        <SettingsRow
          title="Agent keys"
          serverScoped
          settingKeys={["sandboxJobs"]}
          description="Set on every sandbox and VM, over the same keys from the boat environment."
        >
          <div className="grid max-w-2xl gap-2 pb-3.5">
            {AGENT_KEYS.map((key) => (
              <SecretKeyField
                key={key.name}
                label={key.label}
                saved={sandboxJobs.agentKeys[key.name] !== ""}
                onSave={(value) => update({ agentKeys: { [key.name]: value } })}
              />
            ))}
          </div>
        </SettingsRow>
      </SettingsSection>
      <FoldedSettingsSection
        id="sandbox-options"
        title="Optional credentials and limits"
        summary="Model proxy, Git identity, push access, and idle timers"
      >
        <SettingsRow
          title="Stop idle sandboxes after"
          serverScoped
          settingKeys={["sandboxJobs"]}
          description={`Minutes without a run before a job's sandbox is stopped. Its disk is kept and it resumes on the next message. Default ${defaults.idleStopMinutes}.`}
          control={
            <LimitField
              label="Minutes before an idle sandbox stops"
              value={sandboxJobs.idleStopMinutes}
              onChange={(idleStopMinutes) => update({ idleStopMinutes })}
            />
          }
        />
        <SettingsRow
          title="Model proxy"
          serverScoped
          settingKeys={["sandboxJobs"]}
          description="An Anthropic- and OpenAI-compatible proxy such as CLIProxyAPI or LiteLLM. With both a URL and a key, Claude and Codex in every sandbox and boat VM use it instead of the agent keys."
        >
          <div className="grid max-w-2xl gap-2 pb-3.5">
            <Input
              key={sandboxJobs.modelProxy.baseUrl}
              size="sm"
              type="url"
              autoComplete="off"
              spellCheck={false}
              aria-label="Model proxy URL"
              placeholder="Proxy URL, such as http://proxy.tailnet.ts.net:8317"
              defaultValue={sandboxJobs.modelProxy.baseUrl}
              onBlur={(event) => {
                const baseUrl = event.target.value.trim();
                if (baseUrl !== sandboxJobs.modelProxy.baseUrl) update({ modelProxy: { baseUrl } });
              }}
            />
            <SecretKeyField
              label="Model proxy key"
              saved={sandboxJobs.modelProxy.key !== ""}
              onSave={(key) => update({ modelProxy: { key } })}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title="Git identity"
          serverScoped
          settingKeys={["sandboxJobs"]}
          description="The author of commits made in sandboxes and boat VMs."
        >
          <div className="grid max-w-2xl gap-2 pb-3.5 sm:grid-cols-2">
            <Input
              key={sandboxJobs.gitUserName}
              size="sm"
              autoComplete="off"
              spellCheck={false}
              aria-label="Git name"
              placeholder="Name"
              defaultValue={sandboxJobs.gitUserName}
              onBlur={(event) => {
                const gitUserName = event.target.value.trim();
                if (gitUserName !== sandboxJobs.gitUserName) update({ gitUserName });
              }}
            />
            <Input
              key={sandboxJobs.gitUserEmail}
              size="sm"
              type="email"
              autoComplete="off"
              spellCheck={false}
              aria-label="Git email"
              placeholder="Email"
              defaultValue={sandboxJobs.gitUserEmail}
              onBlur={(event) => {
                const gitUserEmail = event.target.value.trim();
                if (gitUserEmail !== sandboxJobs.gitUserEmail) update({ gitUserEmail });
              }}
            />
          </div>
        </SettingsRow>
        <SettingsRow
          title="Sandboxes and VMs may push"
          serverScoped
          settingKeys={["sandboxJobs"]}
          description="Off: pushing to GitHub fails in sandboxes and boat VMs, even with a GitHub token that can write. Fetching and cloning still work."
          control={
            <ScopedSwitch
              settingKeys={["sandboxJobs"]}
              checked={sandboxJobs.allowPush}
              aria-label="Sandboxes and VMs may push"
              onCheckedChange={(checked) => update({ allowPush: Boolean(checked) })}
            />
          }
        />
        <SettingsRow
          title="Open jobs at once"
          serverScoped
          settingKeys={["sandboxJobs"]}
          description={`Agents cannot start more until one is completed or discarded. Default ${defaults.maxActiveJobs}.`}
          control={
            <LimitField
              label="Most open sandbox jobs"
              value={sandboxJobs.maxActiveJobs}
              onChange={(maxActiveJobs) => update({ maxActiveJobs })}
            />
          }
        />
      </FoldedSettingsSection>
      <SettingsSection id="boat-vms" title="Boat VMs">
        {sandboxJobs.providerKeys.boat === "" ? (
          <BoatManagerLinkRow
            key={sandboxJobs.boatManager.url}
            boatManager={sandboxJobs.boatManager}
            onSave={(boatManager) => update({ boatManager })}
          />
        ) : null}
        <SettingsRow
          title="Managed by"
          description="The environment this device starts boat VMs and sandbox jobs through. It keeps the keys and settings below."
          control={
            <div className="w-48">
              <Select
                value={hostEnvironmentId}
                onValueChange={(value) => {
                  const chosen = eligibleEnvironmentIds.find((id) => id === value);
                  if (chosen !== undefined) void setBoatVmHostEnvironmentId(chosen);
                }}
              >
                <SelectTrigger size="sm" aria-label="Managed by">
                  <SelectValue>{(value: EnvironmentId) => environmentLabel(value)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {eligibleEnvironmentIds.map((id) => (
                    <SelectItem key={id} value={id}>
                      {environmentLabel(id)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          }
        />
        <SettingsRow
          title="Base snapshot"
          serverScoped
          settingKeys={["sandboxJobs"]}
          description={`A new VM starts from the repository's snapshot, t3-<owner>-<repo>, else this one, else a plain VM. Choose None to skip it. Default ${defaults.boatVmBaseSnapshot}.`}
          status={
            catalog.state === "error" ? (
              <BoatCatalogError catalog={catalog} />
            ) : baseSnapshotMissing ? (
              `There is no snapshot named ${sandboxJobs.boatVmBaseSnapshot} yet, so new VMs start plain. Create it, or save a VM you set up.`
            ) : undefined
          }
          control={
            <div className="w-48">
              <BoatSnapshotPicker
                catalog={catalog}
                value={sandboxJobs.boatVmBaseSnapshot}
                onChange={(boatVmBaseSnapshot) => update({ boatVmBaseSnapshot })}
              />
            </div>
          }
        >
          {catalog.state === "ready" && environment ? (
            <div className="flex flex-wrap gap-2 pb-3.5">
              <Button
                size="xs"
                variant="outline"
                disabled={createBaseSnapshot.pending}
                onClick={() => {
                  if (sandboxJobs.boatVmBaseSnapshot === "") {
                    update({ boatVmBaseSnapshot: baseSnapshotName });
                  }
                  void createBaseSnapshot.run(baseSnapshotName);
                }}
              >
                {createBaseSnapshot.pending ? "Creating…" : `Create ${baseSnapshotName}`}
              </Button>
              <SaveVmAsSnapshotMenu
                environmentId={environment.environmentId}
                name={baseSnapshotName}
              />
            </div>
          ) : null}
        </SettingsRow>
        <SettingsRow
          title="Boat environment"
          serverScoped
          settingKeys={["sandboxJobs"]}
          description="A boat environment new VMs attach, with the agent logins and secrets it holds. Only VMs you start from Run on get it, never agents' sandbox jobs. None attaches no environment."
          control={
            <div className="w-48">
              <BoatEnvironmentPicker
                catalog={catalog}
                value={sandboxJobs.boatVmEnvironment}
                onChange={(boatVmEnvironment) => update({ boatVmEnvironment })}
              />
            </div>
          }
        />
        <SettingsRow
          title="VM size"
          serverScoped
          settingKeys={["sandboxJobs"]}
          description="With a boat key saved, a thread's Run on menu can start a boat VM. VMs stay up only while this environment's server runs."
          status={
            hostedByDesktopApp ? (
              <span className="block text-warning-foreground">
                The desktop app runs this environment, so its VMs archive when this computer sleeps
                or the app quits. An always-on host keeps them up.
              </span>
            ) : undefined
          }
          control={
            <div className="w-48">
              <Select
                value={sandboxJobs.boatVmSize}
                onValueChange={(value) => {
                  if (SandboxJobSize.literals.includes(value as SandboxJobSize)) {
                    update({ boatVmSize: value as SandboxJobSize });
                  }
                }}
              >
                <SelectTrigger size="sm" aria-label="boat VM size">
                  <SelectValue>{(value: SandboxJobSize) => SIZE_LABELS[value]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {SandboxJobSize.literals.map((size) => (
                    <SelectItem key={size} value={size}>
                      {SIZE_LABELS[size]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          }
        />
        <SettingsRow
          title="VM connection"
          serverScoped
          settingKeys={["sandboxJobs"]}
          description={
            tailscaleOff
              ? "Boat URLs are protected by a token and work through this environment. To connect directly within your private network, turn on Tailscale below first."
              : "Boat URLs are protected by a token and work through this environment. Tailscale connects directly within your private network. With a Boat URL, Tailscale below gives previews and webhooks the VM’s own address."
          }
          control={
            <div className="w-48">
              <BoatConnectionPicker
                value={sandboxJobs.boatVmConnectionMode}
                tailscale={sandboxJobs.boatVmTailscale}
                onChange={(boatVmConnectionMode) => update({ boatVmConnectionMode })}
              />
            </div>
          }
        />
        <SettingsRow
          title="Tailscale"
          serverScoped
          settingKeys={["sandboxJobs"]}
          description={TAILSCALE_DESCRIPTIONS[sandboxJobs.boatVmTailscale]}
          control={
            <div className="w-48">
              <BoatTailscalePicker
                value={sandboxJobs.boatVmTailscale}
                connectionMode={sandboxJobs.boatVmConnectionMode}
                onChange={(boatVmTailscale) => update({ boatVmTailscale })}
              />
            </div>
          }
        />
        {sandboxJobs.boatVmTailscale === "auth-key" ? (
          <SettingsRow title="Tailscale auth key" serverScoped settingKeys={["sandboxJobs"]}>
            <div className="grid max-w-2xl gap-2 pb-3.5">
              <SecretKeyField
                label="Tailscale auth key"
                saved={sandboxJobs.tailscaleAuthKey !== ""}
                onSave={(tailscaleAuthKey) => update({ tailscaleAuthKey })}
              />
            </div>
          </SettingsRow>
        ) : null}
        <SettingsRow
          title="Stop idle boat VMs after"
          serverScoped
          settingKeys={["sandboxJobs"]}
          description={`Minutes without work before boat archives a VM. Picking it again resumes it. Default ${defaults.boatVmIdleMinutes}.`}
          control={
            <LimitField
              label="Minutes before an idle boat VM stops"
              value={sandboxJobs.boatVmIdleMinutes}
              onChange={(boatVmIdleMinutes) => update({ boatVmIdleMinutes })}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}
