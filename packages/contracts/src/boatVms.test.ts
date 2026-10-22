import { describe, expect, it } from "vite-plus/test";

import {
  boatVmLaunchProgressSummary,
  boatVmSnapshotName,
  boatVmSnapshotNameForLabel,
  isBoatSnapshotName,
} from "./boatVms.ts";

describe("boatVmSnapshotName", () => {
  it("names the repository snapshot the way boat accepts it", () => {
    expect(boatVmSnapshotName({ owner: "Acme", name: "T3 Code" })).toBe("t3-acme-t3-code");
    expect(boatVmSnapshotName({ name: "my_app.js" })).toBe("t3-my-app-js");
    const long = boatVmSnapshotName({ owner: "acme", name: "a".repeat(80) });
    expect(long).toHaveLength(63);
    expect(isBoatSnapshotName(long)).toBe(true);
  });

  it("reads owner and repository from a VM label", () => {
    expect(boatVmSnapshotNameForLabel("Acme/App")).toBe("t3-acme-app");
    expect(boatVmSnapshotNameForLabel("app")).toBe("t3-app");
  });
});

describe("boatVmLaunchProgressSummary", () => {
  it("names the snapshot a new VM starts from", () => {
    expect(boatVmLaunchProgressSummary({ stage: "creating", detail: "t3-acme-app" })).toBe(
      "Creating the VM from t3-acme-app",
    );
    expect(boatVmLaunchProgressSummary({ stage: "creating" })).toBe("Creating the VM");
    expect(boatVmLaunchProgressSummary({ stage: "syncing" })).toBe(
      "Cloning or pulling the repository",
    );
  });
});
