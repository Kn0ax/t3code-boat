import { DEFAULT_SERVER_SETTINGS, type ServerConfig } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  update: vi.fn(),
  catalog: { state: "no-key" } as unknown,
}));

vi.mock(import("../../state/server"), () => ({
  serverEnvironment: { updateSettings: "update" } as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => state.update) as never,
}));
vi.mock(import("../../state/boatSnapshots"), async (original) => ({
  ...(await original()),
  useBoatCatalog: (() => state.catalog) as never,
  // A created snapshot stays saving for the rest of the test.
  watchBoatSnapshotSave: (() => new Promise(() => {})) as never,
}));

import { BoatStep } from "./BoatStep";

const config = (boatKey: string) =>
  ({
    environment: { environmentId: "host" },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      sandboxJobs: {
        ...DEFAULT_SERVER_SETTINGS.sandboxJobs,
        providerKeys: { boat: boatKey },
        boatVmBaseSnapshot: "",
      },
    },
  }) as unknown as ServerConfig;

const setup = (catalog: unknown) => {
  state.update.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.catalog = catalog;
};

it("asks only for the key until one is saved", async () => {
  setup({ state: "no-key" });
  const onContinue = vi.fn();
  await using _screen = await render(
    <BoatStep serverConfig={config("")} onContinue={onContinue} />,
  );
  expect(page.getByRole("combobox", { name: "Base snapshot" }).query()).toBeNull();
  expect(page.getByRole("textbox", { name: "Base snapshot" }).query()).toBeNull();
  await userEvent.click(page.getByRole("button", { name: "Continue" }));
  expect(state.update).not.toHaveBeenCalled();
  expect(onContinue).toHaveBeenCalledOnce();
});

it("saves the snapshot, environment, and Tailscale choices from the boat account", async () => {
  setup({
    state: "ready",
    snapshots: [{ name: "t3-base", status: "ready" }],
    environments: [{ name: "work", isDefault: true }],
    refresh: () => {},
  });
  const onContinue = vi.fn();
  await using _screen = await render(
    <BoatStep serverConfig={config("<redacted>")} onContinue={onContinue} />,
  );
  await userEvent.click(page.getByRole("combobox", { name: "Base snapshot" }));
  await userEvent.click(page.getByRole("option", { name: "t3-base" }));
  await userEvent.click(page.getByRole("combobox", { name: "Boat environment" }));
  await userEvent.click(page.getByRole("option", { name: /^work/ }));
  await userEvent.click(page.getByRole("combobox", { name: "Tailscale" }));
  await userEvent.click(page.getByRole("option", { name: "Snapshot joins itself" }));
  await userEvent.click(page.getByRole("combobox", { name: "VM connection" }));
  await userEvent.click(page.getByRole("option", { name: "Tailscale" }));
  await userEvent.click(page.getByRole("button", { name: "Continue" }));
  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    environmentId: "host",
    input: {
      patch: {
        sandboxJobs: {
          boatVmBaseSnapshot: "t3-base",
          boatVmEnvironment: "work",
          boatVmTailscale: "snapshot",
          boatVmConnectionMode: "tailscale",
        },
      },
    },
  });
  expect(onContinue).toHaveBeenCalledOnce();
});

it("creates the missing base snapshot and keeps it as the choice", async () => {
  setup({ state: "ready", snapshots: [], environments: [], refresh: () => {} });
  const onContinue = vi.fn();
  await using _screen = await render(
    <BoatStep serverConfig={config("<redacted>")} onContinue={onContinue} />,
  );
  await userEvent.click(page.getByRole("button", { name: "Create" }));
  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    environmentId: "host",
    input: { name: "t3-base" },
  });
  await userEvent.click(page.getByRole("button", { name: "Continue" }));
  expect(state.update).toHaveBeenLastCalledWith({
    environmentId: "host",
    input: { patch: { sandboxJobs: { boatVmBaseSnapshot: "t3-base" } } },
  });
});
