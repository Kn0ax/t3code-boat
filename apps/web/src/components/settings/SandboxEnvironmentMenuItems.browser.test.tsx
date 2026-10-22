import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  SandboxConnectionProfile,
  SandboxConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import type { EnvironmentPresentation } from "~/state/environments";
import { act, render } from "../../../test/render";
import { Menu, MenuPopup } from "../ui/menu";
import { SandboxEnvironmentMenuItems } from "./SandboxEnvironmentMenuItems";

const state = vi.hoisted(() => ({
  commands: {
    resume: vi.fn(),
    stop: vi.fn(),
    destroy: vi.fn(),
  },
  confirm: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("~/connection/onboarding", () => ({
  resumeSandboxEnvironment: "resume",
  stopSandboxEnvironment: "stop",
  destroySandboxEnvironment: "destroy",
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "resume" | "stop" | "destroy") => state.commands[command],
}));
vi.mock("~/confirmDialog", () => ({ requestConfirmDialog: state.confirm }));
vi.mock(import("../ui/toast"), async (original) => ({
  ...(await original()),
  toastManager: { add: state.toast } as never,
}));

const environmentId = EnvironmentId.make("environment-sandbox");

function sandboxEnvironment(phase: "connected" | "error"): EnvironmentPresentation {
  const target = new SandboxConnectionTarget({
    environmentId,
    label: "Agent box",
    connectionId: "sandbox-1",
  });
  return {
    environmentId,
    label: "Agent box",
    displayUrl: null,
    relayManaged: false,
    serverConfig: null,
    connection: { phase, error: null, traceId: null },
    entry: {
      target,
      profile: Option.some(
        new SandboxConnectionProfile({
          connectionId: "sandbox-1",
          environmentId,
          label: "Agent box",
          target: {
            providerId: "boat",
            label: "Agent box",
            size: "medium",
            idleTimeoutMinutes: 30,
            installAgentClis: true,
            forwardGithubToken: false,
          },
          sandbox: { providerId: "boat", sandboxId: "sandbox-1" },
          providerUrl: "https://3773-sandbox-1.boat.test",
        }),
      ),
      enabled: true,
    },
  };
}

function menuItems(): Array<HTMLElement> {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

function items(): Array<string> {
  return menuItems().map((item) => item.textContent ?? "");
}

async function click(label: string) {
  await userEvent.click(page.getByRole("menuitem", { name: label }));
}

function resetHarness() {
  for (const command of Object.values(state.commands)) {
    command.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  }
  state.confirm.mockReset();
  state.toast.mockReset();
}

function openMenu(environment: EnvironmentPresentation) {
  return render(
    <Menu open>
      <MenuPopup>
        <SandboxEnvironmentMenuItems environment={environment} />
      </MenuPopup>
    </Menu>,
    { router: false },
  );
}

describe("SandboxEnvironmentMenuItems", () => {
  it("offers Start only while the sandbox is not connected", async () => {
    resetHarness();
    {
      await using _screen = await openMenu(sandboxEnvironment("connected"));
      expect(items()).toEqual(["Stop sandbox", "Delete sandbox…"]);
    }

    await using _screen = await openMenu(sandboxEnvironment("error"));
    expect(items()).toEqual(["Start sandbox", "Stop sandbox", "Delete sandbox…"]);
    await click("Start sandbox");
    expect(state.commands.resume).toHaveBeenCalledWith(environmentId);
  });

  it("still shows a running start after the menu closes and reopens", async () => {
    resetHarness();
    let finish: (result: unknown) => void = () => {};
    state.commands.resume.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    {
      await using _screen = await openMenu(sandboxEnvironment("error"));
      await click("Start sandbox");
    }

    await using _screen = await openMenu(sandboxEnvironment("error"));
    expect(items()).toEqual(["Starting sandbox…", "Stop sandbox", "Delete sandbox…"]);
    expect(menuItems().every((item) => item.getAttribute("aria-disabled") === "true")).toBe(true);

    await act(async () => finish(AsyncResult.success(undefined)));
    expect(items()).toEqual(["Start sandbox", "Stop sandbox", "Delete sandbox…"]);
    expect(state.commands.resume).toHaveBeenCalledTimes(1);
  });

  it("deletes the sandbox only after the user confirms", async () => {
    resetHarness();
    await using _screen = await openMenu(sandboxEnvironment("connected"));

    state.confirm.mockResolvedValueOnce(false);
    await click("Delete sandbox…");
    expect(state.confirm).toHaveBeenCalledTimes(1);
    expect(state.commands.destroy).not.toHaveBeenCalled();

    state.confirm.mockResolvedValueOnce(true);
    await click("Delete sandbox…");
    expect(state.commands.destroy).toHaveBeenCalledWith(environmentId);
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Sandbox deleted" }),
    );
  });

  it("renders nothing for an environment that is not a cloud sandbox", async () => {
    resetHarness();
    const bearer = new BearerConnectionTarget({
      environmentId,
      label: "Desk",
      connectionId: "bearer-1",
    });
    await using _screen = await openMenu({
      ...sandboxEnvironment("connected"),
      entry: {
        target: bearer,
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId: "bearer-1",
            environmentId,
            label: "Desk",
            httpBaseUrl: "https://desk.example.test",
            wsBaseUrl: "wss://desk.example.test",
          }),
        ),
        enabled: true,
      },
    });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(items()).toEqual([]);
  });
});
