import type { BoatVmLaunchEntry } from "@t3tools/client-runtime/boat-vms";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { readBoatVmLaunch, startBoatVmLaunch, updateBoatVmLaunch } from "./boatVmLaunches";

const entry = (overrides: Partial<BoatVmLaunchEntry> = {}): BoatVmLaunchEntry => ({
  launchId: "launch-1",
  hostEnvironmentId: EnvironmentId.make("host"),
  repositoryName: "ts-rust",
  newVm: true,
  phase: "launching",
  ...overrides,
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
