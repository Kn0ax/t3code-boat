import { describe, expect, it } from "vite-plus/test";

import {
  boatVmLaunchProgressSummary,
  boatVmSandboxLabel,
  boatVmSnapshotName,
  boatVmSnapshotNameForLabel,
  boatVmThreadCopyOrigin,
  boatVmThreadOriginKey,
  isBoatSnapshotName,
  parseBoatVmSandboxLabel,
} from "./boatVms.ts";

describe("boatVmSandboxLabel", () => {
  it("names a VM t3:<repository>[:<task>] and reads both namings back", () => {
    expect(boatVmSandboxLabel("acme/app", "Fix  the\nlogin")).toBe("t3:acme/app:Fix the login");
    expect(boatVmSandboxLabel(null, "Explore")).toBe("t3:no-project:Explore");
    expect(boatVmSandboxLabel("acme/app")).toBe("t3:acme/app");
    expect(boatVmSandboxLabel("acme/app", "  ")).toBe("t3:acme/app");

    expect(parseBoatVmSandboxLabel("t3:acme/app:Fix: the login")).toEqual({
      label: "acme/app",
      task: "Fix: the login",
    });
    expect(parseBoatVmSandboxLabel("t3:no-project")).toEqual({ label: "scratch" });
    expect(parseBoatVmSandboxLabel("vm acme/app")).toEqual({ label: "acme/app" });
    expect(parseBoatVmSandboxLabel("vm scratch")).toEqual({ label: "scratch" });
    expect(parseBoatVmSandboxLabel("vm ")).toEqual({ label: "" });
    expect(parseBoatVmSandboxLabel("sandbox job 1")).toBeNull();
  });
});

describe("boatVmThreadCopyOrigin", () => {
  it("reads the VM thread back from a copy's id", () => {
    const key = boatVmThreadOriginKey("bx_abc", "thread:1");
    expect(boatVmThreadCopyOrigin(`import:${key}`)).toEqual({
      sandboxId: "bx_abc",
      threadId: "thread:1",
    });
    expect(boatVmThreadCopyOrigin("import:claude:abc")).toBeNull();
    expect(boatVmThreadCopyOrigin("import:boat-vm:bx_abc:")).toBeNull();
    expect(boatVmThreadCopyOrigin("thread-1")).toBeNull();
  });
});

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
