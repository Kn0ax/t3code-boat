import { describe, expect, it } from "vite-plus/test";

import { nextOnboardingStep, resolveOnboardingSteps } from "./wizardSteps.logic";

const officialData = { sourcePath: "/home/user/.t3", available: true, imported: false };

describe("resolveOnboardingSteps", () => {
  it("offers to copy data first, then Boat before projects", () => {
    expect(resolveOnboardingSteps({ dataImport: officialData, boatSupported: true })).toEqual([
      "copy-data",
      "connection",
      "agents",
      "boat",
      "import",
    ]);
  });

  it("skips copying and project import once data was copied", () => {
    expect(
      resolveOnboardingSteps({
        dataImport: { ...officialData, imported: true },
        boatSupported: true,
      }),
    ).toEqual(["connection", "agents", "boat"]);
  });

  it("still offers project import after a copy without projects", () => {
    expect(
      resolveOnboardingSteps({
        dataImport: { ...officialData, imported: true, importedProjects: false },
        boatSupported: false,
      }),
    ).toEqual(["connection", "agents", "import"]);
  });

  it("keeps the original steps outside the desktop app and without Boat support", () => {
    expect(resolveOnboardingSteps({ dataImport: null, boatSupported: false })).toEqual([
      "connection",
      "agents",
      "import",
    ]);
    expect(
      resolveOnboardingSteps({
        dataImport: { ...officialData, available: false },
        boatSupported: false,
      }),
    ).toEqual(["connection", "agents", "import"]);
  });
});

describe("nextOnboardingStep", () => {
  it("returns the following step, or null after the last one", () => {
    const steps = resolveOnboardingSteps({ dataImport: null, boatSupported: true });
    expect(nextOnboardingStep(steps, "agents")).toBe("boat");
    expect(nextOnboardingStep(steps, "import")).toBeNull();
    expect(nextOnboardingStep(steps, "copy-data")).toBeNull();
  });
});
