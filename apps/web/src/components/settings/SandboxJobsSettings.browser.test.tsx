import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  supported: false,
  kind: "environment",
  connectionMode: "boat" as "boat" | "tailscale",
  host: null as string | null,
  boatKey: "",
  baseSnapshot: "",
  catalog: { state: "no-key" } as unknown,
  update: vi.fn(),
  selectScope: vi.fn(),
}));

const setup = (
  input: Pick<typeof state, "supported" | "kind" | "connectionMode"> &
    Partial<Pick<typeof state, "host" | "boatKey" | "baseSnapshot" | "catalog">>,
) => {
  Object.assign(state, {
    host: null,
    boatKey: "",
    baseSnapshot: "",
    catalog: { state: "no-key" },
    ...input,
  });
  state.update.mockClear();
  state.selectScope.mockClear();
};

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [{ environmentId: "laptop", label: "Laptop", serverConfig: null }],
  })) as never,
}));
vi.mock(import("../../state/boatVmHost"), async (original) => ({
  ...(await original()),
  useBoatVmHostEnvironmentId: (() => state.host) as never,
}));
vi.mock(import("../../state/boatSnapshots"), async (original) => ({
  ...(await original()),
  useBoatCatalog: (() => state.catalog) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: state.kind },
    selectScope: state.selectScope,
    environment: {
      environmentId: "host",
      label: "Development server",
      serverConfig: { environment: { capabilities: { sandboxJobs: state.supported } } },
    },
  })) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({
    ...DEFAULT_SERVER_SETTINGS,
    sandboxJobs: {
      ...DEFAULT_SERVER_SETTINGS.sandboxJobs,
      providerKeys: { boat: state.boatKey },
      boatVmBaseSnapshot: state.baseSnapshot,
      boatVmConnectionMode: state.connectionMode,
    },
  })) as never,
  useUpdateScopedSettings: () => state.update,
  useScopedSettingsMixed: () => false,
}));
vi.mock(import("./SettingsScopeNotice"), () => ({
  SettingsScopeNotice: ({ children }: { children: string }) => <p>{children}</p>,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsSection: ({ children }: { children?: React.ReactNode }) => <section>{children}</section>,
  SettingsRow: ({
    children,
    control,
    description,
  }: {
    children?: React.ReactNode;
    control?: React.ReactNode;
    description?: React.ReactNode;
  }) => (
    <div>
      {description}
      {control}
      {children}
    </div>
  ),
}));

import { SandboxJobsSettings } from "./SandboxJobsSettings";

describe("SandboxJobsSettings", () => {
  it("does not accept secrets or toggles for an older environment", async () => {
    setup({ supported: false, kind: "environment", connectionMode: "boat" });
    await using screen = await render(<SandboxJobsSettings />);
    expect(screen.container.textContent).toContain("supports Boat VMs");
    expect(screen.container.querySelector("input")).toBeNull();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("requires one environment instead of sending credentials to every server", async () => {
    setup({ supported: true, kind: "all", connectionMode: "boat" });
    await using screen = await render(<SandboxJobsSettings />);
    expect(screen.container.querySelector("input")).toBeNull();
  });

  it("saves the Tailscale mode on the managing environment and names the key destination", async () => {
    setup({ supported: true, kind: "environment", connectionMode: "boat" });
    await using screen = await render(<SandboxJobsSettings />);
    expect(screen.container.textContent).toContain("Saved on Development server");
    expect(page.getByRole("textbox", { name: "Tailscale auth key" }).query()).toBeNull();
    await userEvent.click(page.getByRole("combobox", { name: "Tailscale" }));
    await userEvent.click(page.getByRole("option", { name: "Snapshot joins itself" }));
    expect(state.update).toHaveBeenCalledExactlyOnceWith({
      sandboxJobs: { boatVmTailscale: "snapshot" },
    });
  });

  it("picks the base snapshot from the boat account and keeps a missing one visible", async () => {
    setup({
      supported: true,
      kind: "environment",
      connectionMode: "boat",
      boatKey: "<redacted>",
      baseSnapshot: "t3-gone",
      catalog: {
        state: "ready",
        snapshots: [{ name: "t3-base", status: "ready", sizeBytes: 2048 }],
        environments: [{ name: "work", isDefault: true }],
        refresh: () => {},
      },
    });
    await using _screen = await render(<SandboxJobsSettings />);
    await userEvent.click(page.getByRole("combobox", { name: "Base snapshot" }));
    await expect.element(page.getByRole("option", { name: "t3-gone (not found)" })).toBeVisible();
    await userEvent.click(page.getByRole("option", { name: /^t3-base/ }));
    expect(state.update).toHaveBeenCalledExactlyOnceWith({
      sandboxJobs: { boatVmBaseSnapshot: "t3-base" },
    });
  });

  it("falls back to typed names when the boat account cannot be read", async () => {
    setup({
      supported: true,
      kind: "environment",
      connectionMode: "boat",
      boatKey: "<redacted>",
      catalog: { state: "error", error: "boat could not list the snapshots (network)." },
    });
    await using _screen = await render(<SandboxJobsSettings />);
    const input = page.getByRole("textbox", { name: "Boat environment" });
    await userEvent.fill(input, "work");
    await userEvent.tab();
    expect(state.update).toHaveBeenCalledExactlyOnceWith({
      sandboxJobs: { boatVmEnvironment: "work" },
    });
  });

  it("points another environment to the one managing boat VMs", async () => {
    setup({ supported: true, kind: "environment", connectionMode: "boat", host: "laptop" });
    await using screen = await render(<SandboxJobsSettings />);
    expect(screen.container.textContent).toContain(
      "Boat VMs and sandbox jobs are managed by Laptop.",
    );
    expect(screen.container.querySelector("input")).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Open Laptop" }));
    expect(state.selectScope).toHaveBeenCalledExactlyOnceWith({ machine: "laptop" });
  });
});
