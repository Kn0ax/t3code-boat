import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  SandboxConnectionProfile,
  SandboxConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  completeSandboxAttempt,
  formatSandboxError,
  parseSandboxTargetFields,
  sandboxAttemptKey,
  savedSandboxProfile,
} from "./CloudSandboxSettings.logic";

const FIELDS = {
  providerId: "boat",
  label: "  Agent box ",
  size: "medium",
  region: "",
  idleTimeoutMinutes: "45",
  installAgentClis: true,
  forwardGithubToken: false,
} as const;

describe("parseSandboxTargetFields", () => {
  it("builds a target with a trimmed label and no region by default", () => {
    expect(parseSandboxTargetFields(FIELDS)).toEqual({
      providerId: "boat",
      label: "Agent box",
      size: "medium",
      idleTimeoutMinutes: 45,
      installAgentClis: true,
      forwardGithubToken: false,
    });
  });

  it("uses the default idle timeout when the field is empty and allows 0", () => {
    expect(
      parseSandboxTargetFields({ ...FIELDS, idleTimeoutMinutes: " " }).idleTimeoutMinutes,
    ).toBe(30);
    expect(
      parseSandboxTargetFields({ ...FIELDS, idleTimeoutMinutes: "0" }).idleTimeoutMinutes,
    ).toBe(0);
  });

  it("rejects a timeout that is not a whole number of minutes", () => {
    expect(() => parseSandboxTargetFields({ ...FIELDS, idleTimeoutMinutes: "-5" })).toThrow(
      /whole number/,
    );
    expect(() => parseSandboxTargetFields({ ...FIELDS, idleTimeoutMinutes: "1.5" })).toThrow(
      /whole number/,
    );
  });

  it("rejects a region, because boat has none", () => {
    expect(() => parseSandboxTargetFields({ ...FIELDS, region: "eu" })).toThrow(/no region/);
  });
});

describe("savedSandboxProfile", () => {
  const environmentId = EnvironmentId.make("environment-sandbox");
  const profile = new SandboxConnectionProfile({
    connectionId: "sandbox-1",
    environmentId,
    label: "Agent box",
    target: parseSandboxTargetFields(FIELDS),
    sandbox: { providerId: "boat", sandboxId: "sandbox-1" },
    providerUrl: "https://3773-sandbox-1.daytonaproxy01.net",
  });

  it("finds the sandbox behind an environment's routes", () => {
    expect(
      savedSandboxProfile({
        target: new SandboxConnectionTarget({
          environmentId,
          label: "Agent box",
          connectionId: "sandbox-1",
        }),
        profile: Option.some(profile),
        enabled: true,
      }),
    ).toBe(profile);
  });

  it("returns null for an environment that is not a sandbox", () => {
    expect(
      savedSandboxProfile({
        target: new BearerConnectionTarget({
          environmentId,
          label: "Desk",
          connectionId: "bearer-1",
        }),
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
      }),
    ).toBeNull();
  });
});

describe("sandboxAttemptKey", () => {
  it("keeps one key per request until its add succeeds", () => {
    let minted = 0;
    const mint = () => `key-${++minted}`;
    const target = parseSandboxTargetFields({ ...FIELDS, providerId: "boat" });

    const first = sandboxAttemptKey(target, mint);
    // A retry, from this form or a reopened one, reuses the key; the label is
    // only a display name.
    expect(sandboxAttemptKey({ ...target, label: "Renamed" }, mint)).toBe(first);
    // A sandbox created differently is a new attempt.
    expect(sandboxAttemptKey({ ...target, size: "large" }, mint)).not.toBe(first);
    expect(sandboxAttemptKey({ ...target, forwardGithubToken: true }, mint)).not.toBe(first);

    // A stale completion does not clear a newer attempt.
    completeSandboxAttempt(target, "some-other-key");
    expect(sandboxAttemptKey(target, mint)).toBe(first);

    completeSandboxAttempt(target, first);
    expect(sandboxAttemptKey(target, mint)).not.toBe(first);
  });
});

describe("formatSandboxError", () => {
  it("drops Electron's remote method wrapper", () => {
    expect(
      formatSandboxError(
        new Error(
          "Error invoking remote method 'desktop:set-sandbox-provider-credential': DesktopSandboxCredentialsError: Secure storage is unavailable.",
        ),
        "fallback",
      ),
    ).toBe("Secure storage is unavailable.");
    expect(formatSandboxError(null, "fallback")).toBe("fallback");
  });
});
