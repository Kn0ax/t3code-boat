import { EnvironmentId, type BoatVmLaunchSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boatVmLaunchBanner,
  readBoatVmLaunch,
  startBoatVmLaunch,
  updateBoatVmLaunch,
  type BoatVmLaunchEntry,
} from "./boatVmLaunches";

const entry = (overrides: Partial<BoatVmLaunchEntry> = {}): BoatVmLaunchEntry => ({
  launchId: "launch-1",
  hostEnvironmentId: EnvironmentId.make("host"),
  repositoryName: "ts-rust",
  newVm: true,
  phase: "launching",
  ...overrides,
});

const snapshot = (overrides: Partial<BoatVmLaunchSnapshot> = {}): BoatVmLaunchSnapshot => ({
  launchId: "launch-1",
  repositoryName: "ts-rust",
  stage: "installing",
  status: "running",
  ...overrides,
});

describe("boatVmLaunchBanner", () => {
  it("shows the stage of its own launch, not another one's", () => {
    const banner = boatVmLaunchBanner(entry(), [
      snapshot({ launchId: "other", stage: "syncing" }),
      snapshot({ stage: "creating", detail: "t3-acme-ts-rust" }),
    ]);
    expect(banner).toEqual({
      title: "Starting a new boat VM for ts-rust",
      description: "Creating the VM from t3-acme-ts-rust",
      failed: false,
      cancellable: true,
    });
  });

  it("starts from the first stage before the server reports one", () => {
    expect(boatVmLaunchBanner(entry({ newVm: false }), []).description).toBe("Resuming the VM");
  });

  it("connects after the launch returns and cannot be cancelled then", () => {
    const banner = boatVmLaunchBanner(entry({ phase: "connecting" }), [snapshot()]);
    expect(banner.description).toBe("Connecting to the VM");
    expect(banner.cancellable).toBe(false);
  });

  it("shows a failure with its error", () => {
    const banner = boatVmLaunchBanner(entry({ phase: "failed", error: "No Boat snapshot." }), []);
    expect(banner).toMatchObject({ failed: true, description: "No Boat snapshot." });
  });
});

describe("updateBoatVmLaunch", () => {
  it("leaves a newer launch from the same composer alone", () => {
    startBoatVmLaunch("draft-a", entry({ launchId: "first" }));
    startBoatVmLaunch("draft-a", entry({ launchId: "second" }));
    updateBoatVmLaunch("draft-a", "first", { phase: "failed", error: "late" });
    expect(readBoatVmLaunch("draft-a")).toMatchObject({ launchId: "second", phase: "launching" });

    updateBoatVmLaunch("draft-a", "second", { phase: "connecting" });
    expect(readBoatVmLaunch("draft-a")?.phase).toBe("connecting");
    updateBoatVmLaunch("draft-a", "second", null);
    expect(readBoatVmLaunch("draft-a")).toBeUndefined();
  });
});
