import {
  AuthStandardClientScopes,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopSandboxEnvironmentBootstrap,
  type DesktopSandboxEnvironmentFailure,
  type DesktopSandboxEnvironmentReconnectInput,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, vi } from "vite-plus/test";
import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";

import {
  canRetainCachedPlatformRegistrationAfterRefreshFailure,
  canReuseCachedPlatformRegistration,
  layer,
  isRejectedBootstrapCredentialError,
  isRejectedSecondaryBootstrap,
  makeDesktopSandboxGateway,
  nextRejectedSecondaryBootstrap,
  SANDBOX_STOPPED_DETAIL,
  sandboxFailureError,
  primaryRegistrationToRetainAfterTopologyRead,
  prepareDesktopSshEnvironment,
  provisionDesktopSshEnvironment,
  secondaryRegistrationsToRetainAfterTopologyRead,
} from "./platform.ts";

const TARGET: DesktopSshEnvironmentTarget = {
  alias: "devbox",
  hostname: "devbox.example.test",
  username: "developer",
  port: 22,
};

const SSH_BOOTSTRAP = {
  target: TARGET,
  httpBaseUrl: "http://127.0.0.1:3201/",
  wsBaseUrl: "ws://127.0.0.1:3201/",
  pairingToken: "abandoned-token",
};

function pendingSetup() {
  let resolve!: (bootstrap: DesktopSshEnvironmentBootstrap) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<DesktopSshEnvironmentBootstrap>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeBridge(
  calls: string[],
  options?: {
    readonly failDescriptor?: boolean;
    readonly savedTokenRejected?: boolean;
    readonly savedTokenPermissions?: ReadonlyArray<string>;
  },
): DesktopBridge {
  return {
    ensureSshEnvironment: async (
      target: DesktopSshEnvironmentTarget,
      ensureOptions?: { issuePairingToken?: boolean },
    ) => {
      calls.push("ensure");
      return {
        target,
        httpBaseUrl: "http://127.0.0.1:3201/",
        wsBaseUrl: "ws://127.0.0.1:3201/",
        pairingToken: ensureOptions?.issuePairingToken === true ? "pairing-token" : null,
      };
    },
    disconnectSshEnvironment: async () => {
      calls.push("disconnect");
    },
    fetchSshSessionState: async () => {
      calls.push("session");
      return {
        authenticated: options?.savedTokenRejected !== true,
        permissions: options?.savedTokenPermissions ?? AuthStandardClientScopes,
      };
    },
    fetchSshEnvironmentDescriptor: async () => {
      calls.push("descriptor");
      if (options?.failDescriptor === true) {
        throw new Error("descriptor unavailable");
      }
      return {
        environmentId: EnvironmentId.make("environment-ssh"),
        label: "SSH environment",
        platform: {
          os: "linux",
          arch: "x64",
        },
        serverVersion: "0.0.0-test",
        capabilities: {
          repositoryIdentity: true,
        },
      };
    },
    bootstrapSshBearerSession: async () => {
      calls.push("token");
      return {
        access_token: "bearer-token",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: AuthStandardClientScopes.join(" "),
      };
    },
  } as unknown as DesktopBridge;
}

describe("desktop SSH pairing", () => {
  it.effect("does not consume the credential when adding a route to a different machine", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const error = yield* provisionDesktopSshEnvironment(
        makeBridge(calls),
        TARGET,
        EnvironmentId.make("some-other-machine"),
      ).pipe(Effect.flip);

      expect(error).toMatchObject({ reason: "configuration" });
      expect(calls).toEqual(["ensure", "descriptor"]);
    }),
  );

  it.effect("exchanges one setup credential after repeated interrupted provisions", () =>
    Effect.gen(function* () {
      const bridge = makeBridge([]);
      const setup = pendingSetup();
      const ensure = vi.spyOn(bridge, "ensureSshEnvironment").mockReturnValue(setup.promise);
      const exchange = vi.spyOn(bridge, "bootstrapSshBearerSession");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const interrupted = yield* Effect.forkChild(
          provisionDesktopSshEnvironment(bridge, TARGET),
          { startImmediately: true },
        );
        yield* Fiber.interrupt(interrupted);
      }

      const retry = yield* Effect.forkChild(provisionDesktopSshEnvironment(bridge, TARGET), {
        startImmediately: true,
      });
      setup.resolve(SSH_BOOTSTRAP);
      const provisioned = yield* Fiber.join(retry);

      expect(provisioned.bearerToken).toBe("bearer-token");
      expect(ensure).toHaveBeenCalledExactlyOnceWith(TARGET, { issuePairingToken: true });
      expect(exchange).toHaveBeenCalledExactlyOnceWith(
        SSH_BOOTSTRAP.httpBaseUrl,
        "abandoned-token",
      );
    }),
  );

  it.effect("starts fresh after an abandoned setup settles in success or failure", () =>
    Effect.gen(function* () {
      for (const outcome of ["success", "failure"]) {
        const bridge = makeBridge([]);
        const setup = pendingSetup();
        const ensure = vi.spyOn(bridge, "ensureSshEnvironment").mockReturnValueOnce(setup.promise);
        const exchange = vi.spyOn(bridge, "bootstrapSshBearerSession");
        const interrupted = yield* Effect.forkChild(
          provisionDesktopSshEnvironment(bridge, TARGET),
          { startImmediately: true },
        );
        yield* Fiber.interrupt(interrupted);
        if (outcome === "success") setup.resolve(SSH_BOOTSTRAP);
        else setup.reject(new Error("remote launch failed"));
        yield* Effect.promise(() =>
          setup.promise.then(
            () => undefined,
            () => undefined,
          ),
        );

        const provisioned = yield* provisionDesktopSshEnvironment(bridge, TARGET);

        expect(provisioned.bearerToken).toBe("bearer-token");
        expect(ensure).toHaveBeenCalledTimes(2);
        expect(exchange).toHaveBeenCalledExactlyOnceWith(
          SSH_BOOTSTRAP.httpBaseUrl,
          "pairing-token",
        );
      }
    }),
  );

  it.effect("disconnect invalidates unfinished setup even before provision is interrupted", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const bridge = makeBridge(calls);
      const setup = pendingSetup();
      const ensure = vi.spyOn(bridge, "ensureSshEnvironment").mockReturnValueOnce(setup.promise);
      const exchange = vi.spyOn(bridge, "bootstrapSshBearerSession");
      vi.stubGlobal("window", { desktopBridge: bridge });
      const ssh = yield* ClientCapabilities.SshEnvironmentGateway.pipe(Effect.provide(layer));
      const interrupted = yield* Effect.forkChild(ssh.provision(TARGET), {
        startImmediately: true,
      });
      yield* ssh.disconnect(TARGET);
      yield* Fiber.interrupt(interrupted);

      const retry = yield* Effect.forkChild(ssh.provision(TARGET), { startImmediately: true });
      setup.resolve(SSH_BOOTSTRAP);
      const provisioned = yield* Fiber.join(retry);

      expect(provisioned.bearerToken).toBe("bearer-token");
      expect(ensure).toHaveBeenCalledTimes(2);
      expect(calls).toEqual(["disconnect", "ensure", "descriptor", "token"]);
      expect(exchange).toHaveBeenCalledExactlyOnceWith(SSH_BOOTSTRAP.httpBaseUrl, "pairing-token");
    }),
  );

  it.effect("reconnects with the saved token while it holds every standard scope", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const bridge = makeBridge(calls);
      const ensure = vi.spyOn(bridge, "ensureSshEnvironment");
      const prepared = yield* prepareDesktopSshEnvironment(bridge, {
        target: TARGET,
        expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
        bearerToken: "saved-token",
      });

      expect(prepared.bearerToken).toBe("saved-token");
      expect(ensure).toHaveBeenCalledExactlyOnceWith(TARGET, { issuePairingToken: false });
      expect(calls).toEqual(["ensure", "descriptor", "session"]);
    }),
  );

  it.effect("pairs again when the host no longer accepts the saved token", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const prepared = yield* prepareDesktopSshEnvironment(
        makeBridge(calls, { savedTokenRejected: true }),
        {
          target: TARGET,
          expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
          bearerToken: "saved-token",
        },
      );

      expect(prepared.bearerToken).toBe("bearer-token");
      expect(calls).toEqual(["ensure", "descriptor", "session", "ensure", "descriptor", "token"]);
    }),
  );

  it.effect("pairs again when the saved token predates a standard scope", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const prepared = yield* prepareDesktopSshEnvironment(
        makeBridge(calls, {
          savedTokenPermissions: ["orchestration:read", "orchestration:operate"],
        }),
        {
          target: TARGET,
          expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
          bearerToken: "saved-token",
        },
      );

      expect(prepared.bearerToken).toBe("bearer-token");
      expect(calls).toEqual(["ensure", "descriptor", "session", "ensure", "descriptor", "token"]);
    }),
  );

  it.effect("stops before sending the saved token or pairing on a different machine", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const error = yield* prepareDesktopSshEnvironment(makeBridge(calls), {
        target: TARGET,
        expectedEnvironmentId: EnvironmentId.make("some-other-machine"),
        bearerToken: "saved-token",
      }).pipe(Effect.flip);

      expect(error).toMatchObject({ reason: "configuration" });
      expect(calls).toEqual(["ensure", "descriptor"]);
    }),
  );
});

describe("desktop-local bearer cache", () => {
  const registration = {} as never;

  it("retains only unexpired secondaries after a topology read failure", () => {
    const valid = {
      expiresAtEpochMs: 20_000,
      signature: "valid-secondary",
      registration,
      refreshAtEpochMs: 15_000,
    };
    const previous = new Map([
      ["valid-secondary", valid],
      [
        "expired-secondary",
        {
          expiresAtEpochMs: 10_000,
          signature: "expired-secondary",
          registration,
          refreshAtEpochMs: 5_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Failure", cause: new Error("IPC unavailable") },
        10_000,
      ),
    ).toEqual(new Map([["valid-secondary", valid]]));
  });

  it("treats a successful empty topology as authoritative removal", () => {
    const previous = new Map([
      [
        "secondary",
        {
          expiresAtEpochMs: 20_000,
          signature: "secondary",
          registration,
          refreshAtEpochMs: 15_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Success", bootstraps: [] },
        10_000,
      ),
    ).toEqual(new Map());
  });
});

describe("rejected desktop-local bootstrap tokens", () => {
  it("retries at once when the token or endpoint changes", () => {
    const rejected = nextRejectedSecondaryBootstrap(undefined, "http://a|ws://a|old-token", 0);

    expect(isRejectedSecondaryBootstrap(rejected, "http://a|ws://a|new-token", 1)).toBe(false);
    expect(isRejectedSecondaryBootstrap(rejected, "http://b|ws://b|old-token", 1)).toBe(false);
    expect(isRejectedSecondaryBootstrap(undefined, "http://a|ws://a|old-token", 1)).toBe(false);
    expect(nextRejectedSecondaryBootstrap(rejected, "http://a|ws://a|new-token", 1).delayMs).toBe(
      60_000,
    );
  });

  // regression: #16273 a rejected desktop-local credential was retried every poll
  it("treats only authentication rejections as a dead credential", () => {
    expect(
      isRejectedBootstrapCredentialError(
        new ConnectionBlockedError({ reason: "authentication", detail: "invalid" }),
      ),
    ).toBe(true);
    expect(
      isRejectedBootstrapCredentialError(
        new ConnectionTransientError({ reason: "endpoint-unavailable", detail: "booting" }),
      ),
    ).toBe(false);
  });
});

describe("desktop-local bearer cache across token changes", () => {
  it("keeps a live bearer when only the bootstrap token rotates", () => {
    const cached = {
      signature: "http://a|ws://a",
      registration: {} as never,
      expiresAtEpochMs: 20_000,
      refreshAtEpochMs: 15_000,
    };

    expect(canReuseCachedPlatformRegistration(cached, "http://a|ws://a", 10_000)).toBe(true);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, "http://a|ws://a", 16_000),
    ).toBe(true);
    expect(canReuseCachedPlatformRegistration(cached, "http://b|ws://b", 10_000)).toBe(false);
  });
});

describe("primary topology cache", () => {
  const registration = {} as never;
  const cached = {
    signature: "primary|http://127.0.0.1:3773/|ws://127.0.0.1:3773/",
    registration,
  };
  const previous = new Map([[PRIMARY_LOCAL_ENVIRONMENT_ID, cached]]);

  it("retains the cached primary after a transient topology read failure", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Failure",
        cause: new Error("IPC unavailable"),
      }),
    ).toBe(cached);
  });
});

const SANDBOX_TARGET = {
  providerId: "boat",
  label: "Agent box",
  size: "medium",
  idleTimeoutMinutes: 30,
  installAgentClis: true,
  forwardGithubToken: false,
} as const;
const SANDBOX = { providerId: "boat", sandboxId: "sandbox-1" } as const;

function sandboxBootstrap(pairingToken: string): DesktopSandboxEnvironmentBootstrap {
  return {
    target: SANDBOX_TARGET,
    sandbox: SANDBOX,
    httpBaseUrl: "http://127.0.0.1:4100/",
    wsBaseUrl: "ws://127.0.0.1:4100/",
    providerUrl: "https://3773-sandbox-1.daytonaproxy01.net",
    pairingToken,
  };
}

function makeSandboxBridge(
  reconnects: Array<DesktopSandboxEnvironmentReconnectInput>,
  status: "running" | "stopped",
): DesktopBridge {
  let minted = 0;
  return {
    ensureSandboxEnvironment: async () => sandboxBootstrap("provisioned"),
    reconnectSandboxEnvironment: async (input: DesktopSandboxEnvironmentReconnectInput) => {
      reconnects.push(input);
      if (status === "stopped" && !input.resume) {
        return { type: "sandbox-environment-stopped", sandbox: input.sandbox };
      }
      minted += 1;
      return sandboxBootstrap(`token-${minted}`);
    },
    stopSandboxEnvironment: async () => ({ type: "sandbox-environment-done" }),
    destroySandboxEnvironment: async () => ({
      type: "sandbox-environment-failed",
      stage: "destroy",
      failure: "not-found",
      detail: "Daytona could not find the sandbox; it may have been deleted.",
      sandbox: SANDBOX,
    }),
  } as unknown as DesktopBridge;
}

describe("desktop cloud sandbox gateway", () => {
  it("blocks on failures a retry cannot fix and retries the rest", () => {
    const failure = (failure?: "unauthorized" | "quota-exceeded" | "timeout" | "provider-error") =>
      sandboxFailureError({
        type: "sandbox-environment-failed",
        stage: "launch",
        detail: "detail",
        ...(failure === undefined ? {} : { failure }),
      });
    expect(failure("unauthorized")).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "authentication",
    });
    expect(failure("quota-exceeded")).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "permission",
    });
    expect(failure("timeout")).toMatchObject({
      _tag: "ConnectionTransientError",
      reason: "timeout",
    });
    expect(failure("provider-error")).toMatchObject({ _tag: "ConnectionTransientError" });
    expect(
      sandboxFailureError({
        type: "sandbox-environment-failed",
        stage: "credentials",
        detail: "Docker Sandboxes needs your Docker username as well as the access token.",
      }),
    ).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
  });

  it.effect("never resumes a stopped sandbox on an automatic reconnect", () =>
    Effect.gen(function* () {
      const reconnects: Array<DesktopSandboxEnvironmentReconnectInput> = [];
      const bridge = makeSandboxBridge(reconnects, "stopped");
      const gateway = makeDesktopSandboxGateway(() => bridge);

      const error = yield* Effect.flip(
        gateway.prepare({
          connectionId: "sandbox-1",
          expectedEnvironmentId: EnvironmentId.make("environment-sandbox"),
          target: SANDBOX_TARGET,
          sandbox: SANDBOX,
        }),
      );

      expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
      expect(error.message).toBe(SANDBOX_STOPPED_DETAIL);
      expect(reconnects.map((input) => input.resume)).toEqual([false]);
    }),
  );

  it.effect("pairs with the token a resume minted instead of launching again", () =>
    Effect.gen(function* () {
      const reconnects: Array<DesktopSandboxEnvironmentReconnectInput> = [];
      const bridge = makeSandboxBridge(reconnects, "stopped");
      const gateway = makeDesktopSandboxGateway(() => bridge);
      const prepare = gateway.prepare({
        connectionId: "sandbox-1",
        expectedEnvironmentId: EnvironmentId.make("environment-sandbox"),
        target: SANDBOX_TARGET,
        sandbox: SANDBOX,
      });

      yield* gateway.resume({ target: SANDBOX_TARGET, sandbox: SANDBOX });
      const resumed = yield* prepare;

      expect(resumed.pairingToken).toBe("token-1");
      expect(reconnects.map((input) => input.resume)).toEqual([true]);
      // The minted token is used once; the next reconnect asks the desktop again.
      yield* Effect.flip(prepare);
      expect(reconnects.map((input) => input.resume)).toEqual([true, false]);
    }),
  );

  it.effect("pairs the first connect after an add with the token the add minted", () =>
    Effect.gen(function* () {
      const reconnects: Array<DesktopSandboxEnvironmentReconnectInput> = [];
      const bridge = makeSandboxBridge(reconnects, "running");
      const gateway = makeDesktopSandboxGateway(() => bridge);

      yield* gateway.provision({ target: SANDBOX_TARGET, idempotencyKey: "attempt-1" });
      const first = yield* gateway.prepare({
        connectionId: "sandbox-1",
        expectedEnvironmentId: EnvironmentId.make("environment-sandbox"),
        target: SANDBOX_TARGET,
        sandbox: SANDBOX,
      });

      expect(first.pairingToken).toBe("provisioned");
      expect(reconnects).toEqual([]);
    }),
  );

  it.effect("counts a sandbox that is already gone as deleted", () =>
    Effect.gen(function* () {
      const bridge = makeSandboxBridge([], "running");
      const gateway = makeDesktopSandboxGateway(() => bridge);

      yield* gateway.destroy(SANDBOX);
      yield* gateway.stop(SANDBOX);
    }),
  );

  it.effect("says when a failed add left a billable sandbox behind", () =>
    Effect.gen(function* () {
      const failing = (failure: Omit<DesktopSandboxEnvironmentFailure, "type">) =>
        makeDesktopSandboxGateway(
          () =>
            ({
              ...makeSandboxBridge([], "running"),
              ensureSandboxEnvironment: async () => ({
                type: "sandbox-environment-failed",
                ...failure,
              }),
            }) as DesktopBridge,
        ).provision({ target: SANDBOX_TARGET, idempotencyKey: "attempt-1" });
      const timedOut = "T3 did not answer through the Daytona preview URL within 60 seconds.";

      const kept = yield* Effect.flip(
        failing({ stage: "probe", detail: timedOut, sandbox: SANDBOX }),
      );
      expect(kept).toMatchObject({ _tag: "ConnectionTransientError" });
      expect(kept.message).toBe(
        `${timedOut} The boat sandbox it created is kept and billed: create it again with the same settings to retry with it, or delete it in your boat dashboard.`,
      );

      // Nothing was created, or the provider deleted it, so there is nothing to mention.
      const none = yield* Effect.flip(failing({ stage: "create", detail: timedOut }));
      expect(none.message).toBe(timedOut);
      const deleted = "Daytona reports the sandbox as deleted.";
      const gone = yield* Effect.flip(
        failing({ stage: "create", failure: "not-found", detail: deleted, sandbox: SANDBOX }),
      );
      expect(gone.message).toBe(deleted);
    }),
  );

  it.effect("reports cloud sandboxes as unsupported outside the desktop app", () =>
    Effect.gen(function* () {
      const gateway = makeDesktopSandboxGateway(() => undefined);
      const error = yield* Effect.flip(
        gateway.provision({ target: SANDBOX_TARGET, idempotencyKey: "attempt-1" }),
      );

      expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "unsupported" });
    }),
  );
});
