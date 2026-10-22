import { BearerConnectionProfile } from "@t3tools/client-runtime/connection";
import { EnvironmentId, type BoatVmDesktop } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  boatDesktopOpensInBrowserPanel,
  boatVmSandboxIdOf,
  waitForBoatDesktop,
} from "./boatDesktop";

const environmentId = EnvironmentId.make("vm-env");
const bearer = (extra: Partial<ConstructorParameters<typeof BearerConnectionProfile>[0]> = {}) =>
  Option.some(
    new BearerConnectionProfile({
      connectionId: "bearer-1",
      environmentId,
      label: "acme/app",
      httpBaseUrl: "https://t3-vm-bx1.example.ts.net",
      wsBaseUrl: "wss://t3-vm-bx1.example.ts.net",
      ...extra,
    }),
  );

describe("boatVmSandboxIdOf", () => {
  it("finds the VM of a connection paired directly or through the boat relay", () => {
    expect(
      boatVmSandboxIdOf(
        bearer({ boatVm: { sandboxId: "bx_1", hostEnvironmentId: EnvironmentId.make("host") } }),
      ),
    ).toBe("bx_1");
    expect(boatVmSandboxIdOf(bearer({ boatProxy: { sandboxId: "bx_2" } }))).toBe("bx_2");
  });

  it("finds none for other connections", () => {
    expect(boatVmSandboxIdOf(bearer())).toBeNull();
    expect(boatVmSandboxIdOf(Option.none())).toBeNull();
    expect(boatVmSandboxIdOf(undefined)).toBeNull();
  });
});

describe("boatDesktopOpensInBrowserPanel", () => {
  it("keeps web pages in the panel when it is available", () => {
    expect(boatDesktopOpensInBrowserPanel("https://desktop.example/s?t=1", true)).toBe(true);
    expect(boatDesktopOpensInBrowserPanel("https://desktop.example/s?t=1", false)).toBe(false);
  });

  it("hands other schemes to the system", () => {
    expect(boatDesktopOpensInBrowserPanel("moonlight://desktop.example", true)).toBe(false);
    expect(boatDesktopOpensInBrowserPanel("not a url", true)).toBe(false);
  });
});

describe("waitForBoatDesktop", () => {
  const run = (answers: BoatVmDesktop[], timeoutMs: number) => {
    let clock = 0;
    const waits: number[] = [];
    let requests = 0;
    const result = waitForBoatDesktop({
      request: async () => {
        requests += 1;
        return answers.shift() ?? { status: "provisioning" };
      },
      wait: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      now: () => clock,
      intervalMs: 3_000,
      timeoutMs,
    });
    return { result, waits, requests: () => requests };
  };

  it("asks again while boat is provisioning, then returns the URL", async () => {
    const polled = run(
      [
        { status: "provisioning" },
        { status: "provisioning" },
        { status: "ready", url: "https://d" },
      ],
      120_000,
    );
    expect(await polled.result).toBe("https://d");
    expect(polled.waits).toEqual([3_000, 3_000]);
  });

  it("gives up at the deadline", async () => {
    const polled = run([], 10_000);
    expect(await polled.result).toBeNull();
    expect(polled.requests()).toBe(4);
  });
});
