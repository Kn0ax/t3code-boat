import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveBoatVmHostEnvironmentId } from "./boatVmHost";

const primary = EnvironmentId.make("primary");
const laptop = EnvironmentId.make("laptop");
const environment = (environmentId: EnvironmentId, sandboxJobs: boolean) => ({
  environmentId,
  serverConfig: { environment: { capabilities: { sandboxJobs } } } as never,
});

describe("resolveBoatVmHostEnvironmentId", () => {
  it("uses the primary environment until one is chosen", () => {
    expect(
      resolveBoatVmHostEnvironmentId(null, primary, [
        environment(primary, true),
        environment(laptop, true),
      ]),
    ).toBe(primary);
  });

  it("uses the chosen environment while it can host boat VMs", () => {
    expect(
      resolveBoatVmHostEnvironmentId(laptop, primary, [
        environment(primary, true),
        environment(laptop, true),
      ]),
    ).toBe(laptop);
  });

  it("falls back to the primary when the chosen environment is gone or cannot host", () => {
    expect(resolveBoatVmHostEnvironmentId(laptop, primary, [environment(primary, true)])).toBe(
      primary,
    );
    expect(
      resolveBoatVmHostEnvironmentId(laptop, primary, [
        environment(primary, true),
        environment(laptop, false),
      ]),
    ).toBe(primary);
    expect(
      resolveBoatVmHostEnvironmentId(laptop, primary, [
        { environmentId: laptop, serverConfig: null },
      ]),
    ).toBe(primary);
  });
});
