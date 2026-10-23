import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopSandboxEnvironmentReconnectResultSchema,
  DesktopSandboxEnvironmentTargetSchema,
} from "./ipc.ts";

describe("DesktopSandboxEnvironmentTargetSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopSandboxEnvironmentTargetSchema);
  const target = {
    providerId: "boat",
    label: "Agent box",
    size: "medium",
    idleTimeoutMinutes: 30,
    installAgentClis: true,
  };

  it("never forwards the GitHub token unless the target opts in", () => {
    expect(decode(target).forwardGithubToken).toBe(false);
    expect(decode({ ...target, forwardGithubToken: true }).forwardGithubToken).toBe(true);
  });

  it("rejects an unknown provider and a negative idle timeout", () => {
    expect(() => decode({ ...target, providerId: "elsewhere" })).toThrow();
    expect(() => decode({ ...target, idleTimeoutMinutes: -1 })).toThrow();
  });
});

describe("DesktopSandboxEnvironmentReconnectResultSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopSandboxEnvironmentReconnectResultSchema);

  it("distinguishes a stopped sandbox from a failure", () => {
    const sandbox = { providerId: "boat", sandboxId: "box-1" };
    expect(decode({ type: "sandbox-environment-stopped", sandbox })).toEqual({
      type: "sandbox-environment-stopped",
      sandbox,
    });
    expect(
      decode({
        type: "sandbox-environment-failed",
        stage: "launch",
        failure: "timeout",
        detail: "t3 serve did not start.",
      }),
    ).toMatchObject({ type: "sandbox-environment-failed", stage: "launch" });
  });
});
