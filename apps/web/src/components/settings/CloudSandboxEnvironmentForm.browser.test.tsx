import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import type { DesktopSandboxEnvironmentTarget } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, render } from "../../../test/render";
import { CloudSandboxEnvironmentForm } from "./CloudSandboxEnvironmentForm";

interface ConnectInput {
  readonly target: DesktopSandboxEnvironmentTarget;
  readonly idempotencyKey: string;
}

const state = vi.hoisted(() => ({
  connect: vi.fn<(input: ConnectInput) => Promise<unknown>>(),
  toast: vi.fn(),
}));

vi.mock("~/connection/onboarding", () => ({ connectSandboxEnvironment: "connect-sandbox" }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.connect }));
vi.mock(import("../ui/toast"), async (original) => ({
  ...(await original()),
  toastManager: { add: state.toast } as never,
}));

function makeBridge() {
  const saved = new Set<string>();
  return {
    saved,
    ensureSandboxEnvironment: vi.fn(),
    setSandboxProviderCredential: vi.fn(async (input: { readonly providerId: string }) => {
      saved.add(input.providerId);
    }),
    clearSandboxProviderCredential: vi.fn(async (providerId: string) => {
      saved.delete(providerId);
    }),
    hasSandboxProviderCredential: vi.fn(async (providerId: string) => saved.has(providerId)),
  };
}

const failure = (detail: string) =>
  AsyncResult.failure(Cause.fail(new ConnectionTransientError({ reason: "timeout", detail })));
const success = () => AsyncResult.success("environment-sandbox");

const onConnected = vi.fn();
const onBusyChange = vi.fn();

function resetHarness() {
  state.connect.mockReset();
  state.toast.mockReset();
  onConnected.mockReset();
  onBusyChange.mockReset();
}

function form(bridge: ReturnType<typeof makeBridge>) {
  return (
    <CloudSandboxEnvironmentForm
      bridge={bridge as never}
      onBusyChange={onBusyChange}
      onConnected={onConnected}
    />
  );
}

function hasText(container: HTMLElement, text: string): boolean {
  return container.textContent?.includes(text) ?? false;
}

async function typeKey(container: HTMLElement, value: string) {
  await userEvent.fill(container.querySelector<HTMLInputElement>('input[type="password"]')!, value);
}

async function createSandbox() {
  await userEvent.click(page.getByRole("button", { name: "Create sandbox" }));
}

describe("CloudSandboxEnvironmentForm", () => {
  it("retries a failed add with the same attempt key after the dialog is reopened", async () => {
    resetHarness();
    const bridge = makeBridge();
    state.connect
      .mockResolvedValueOnce(failure("T3 did not answer on the boat sandbox."))
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success());

    let firstKey = "";
    {
      await using screen = await render(form(bridge), { router: false });
      await typeKey(screen.container, "boat_secret");
      await createSandbox();

      expect(bridge.setSandboxProviderCredential).toHaveBeenCalledWith({
        providerId: "boat",
        secret: "boat_secret",
      });
      await expect.element(page.getByText("T3 did not answer on the boat sandbox.")).toBeVisible();
      firstKey = state.connect.mock.calls[0]![0].idempotencyKey;
    }

    // The retry must adopt the sandbox the failed attempt created, not pay for a second one.
    {
      await using screen = await render(form(bridge), { router: false });
      await createSandbox();
      expect(screen.container.isConnected).toBe(true);
    }

    expect(state.connect.mock.calls[1]![0].idempotencyKey).toBe(firstKey);
    expect(onConnected).toHaveBeenCalledTimes(1);

    // Once an add succeeds, the next one creates a new sandbox.
    {
      await using _screen = await render(form(bridge), { router: false });
      await createSandbox();
    }
    expect(state.connect.mock.calls[2]![0].idempotencyKey).not.toBe(firstKey);
  });

  it("reports an add that finishes after the dialog closed, and leaves the dialog alone", async () => {
    resetHarness();
    const bridge = makeBridge();
    let finish: (result: unknown) => void = () => {};
    state.connect.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await using screen = await render(form(bridge), { router: false });
    await typeKey(screen.container, "boat_secret");
    await createSandbox();
    expect(hasText(screen.container, "Creating sandbox… this can take a minute")).toBe(true);
    await screen.unmount();
    onBusyChange.mockClear();

    await act(async () => finish(success()));

    expect(onConnected).not.toHaveBeenCalled();
    expect(onBusyChange).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Sandbox ready" }),
    );
  });

  it("saves a replacement key without creating a sandbox", async () => {
    resetHarness();
    const bridge = makeBridge();
    await using screen = await render(form(bridge), { router: false });
    await typeKey(screen.container, "dtn_rotated");
    await userEvent.click(
      page.getByRole("button", { name: "Save the key without creating a sandbox" }),
    );

    expect(bridge.setSandboxProviderCredential).toHaveBeenCalledWith({
      providerId: "boat",
      secret: "dtn_rotated",
    });
    expect(state.connect).not.toHaveBeenCalled();
    expect(hasText(screen.container, "A boat key is saved")).toBe(true);
  });

  it("creates a new sandbox when a retry asks for one set up differently", async () => {
    resetHarness();
    const bridge = makeBridge();
    state.connect.mockResolvedValueOnce(failure("boat timed out.")).mockResolvedValue(success());
    await using screen = await render(form(bridge), { router: false });
    await typeKey(screen.container, "boat_secret");
    await createSandbox();
    await expect.element(page.getByText("boat timed out.")).toBeVisible();
    const firstKey = state.connect.mock.calls[0]![0].idempotencyKey;

    // The GitHub token is part of the sandbox's environment, fixed at create
    // time, so the sandbox the failed attempt made cannot be adopted for it.
    await userEvent.click(
      screen.container.querySelector('[role="switch"][aria-label="Forward my GitHub token"]')!,
    );
    await createSandbox();

    expect(state.connect.mock.calls[1]![0].target).toMatchObject({ forwardGithubToken: true });
    expect(state.connect.mock.calls[1]![0].idempotencyKey).not.toBe(firstKey);
  });

  it("offers boat no region choice and sends none", async () => {
    resetHarness();
    const bridge = makeBridge();
    state.connect.mockResolvedValue(success());
    bridge.saved.add("boat");
    await using screen = await render(form(bridge), { router: false });

    await expect.element(page.getByText("boat runs every sandbox in the EU.")).toBeVisible();
    expect(screen.container.querySelector('[aria-label="Region"]')).toBeNull();

    // The key saved earlier is used; nothing new is written.
    expect(hasText(screen.container, "A boat key is saved")).toBe(true);
    await createSandbox();
    expect(bridge.setSandboxProviderCredential).not.toHaveBeenCalled();
    expect(state.connect.mock.calls[0]![0].target).toMatchObject({ providerId: "boat" });
    expect(state.connect.mock.calls[0]![0].target).not.toHaveProperty("region");
  });

  it("warns that boat's stop timer is a deadline, and that 0 leaves it running", async () => {
    resetHarness();
    const bridge = makeBridge();
    await using screen = await render(form(bridge), { router: false });
    expect(
      hasText(screen.container, "boat stops the sandbox this many minutes after it starts"),
    ).toBe(true);
    await userEvent.fill(page.getByRole("textbox", { name: "Auto-stop after (minutes)" }), "0");
    expect(
      hasText(screen.container, "0 keeps the sandbox running, and billing, until you stop it."),
    ).toBe(true);
    expect(
      hasText(screen.container, "boat stops the sandbox this many minutes after it starts"),
    ).toBe(false);
  });
});
