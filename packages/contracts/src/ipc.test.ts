import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopEnvironmentBootstrapSchema,
  DesktopSandboxEnvironmentReconnectResultSchema,
  DesktopSandboxEnvironmentTargetSchema,
} from "./ipc.ts";

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});

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
