import {
  DesktopSandboxEnvironmentActionResultSchema,
  DesktopSandboxEnvironmentEnsureInputSchema,
  DesktopSandboxEnvironmentEnsureResultSchema,
  DesktopSandboxEnvironmentReconnectInputSchema,
  DesktopSandboxEnvironmentReconnectResultSchema,
  DesktopSandboxProviderCredentialInputSchema,
  DesktopSandboxProviderIdSchema,
  DesktopSandboxRefSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as DesktopSandboxCredentials from "../../sandbox/DesktopSandboxCredentials.ts";
import * as DesktopSandboxEnvironment from "../../sandbox/DesktopSandboxEnvironment.ts";

export const ensureSandboxEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ENSURE_SANDBOX_ENVIRONMENT_CHANNEL,
  payload: DesktopSandboxEnvironmentEnsureInputSchema,
  result: DesktopSandboxEnvironmentEnsureResultSchema,
  handler: Effect.fn("desktop.ipc.sandboxEnvironment.ensure")(function* (input) {
    const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
    return yield* sandboxes.ensure(input);
  }),
});

export const reconnectSandboxEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RECONNECT_SANDBOX_ENVIRONMENT_CHANNEL,
  payload: DesktopSandboxEnvironmentReconnectInputSchema,
  result: DesktopSandboxEnvironmentReconnectResultSchema,
  handler: Effect.fn("desktop.ipc.sandboxEnvironment.reconnect")(function* (input) {
    const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
    return yield* sandboxes.reconnect(input);
  }),
});

export const stopSandboxEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.STOP_SANDBOX_ENVIRONMENT_CHANNEL,
  payload: DesktopSandboxRefSchema,
  result: DesktopSandboxEnvironmentActionResultSchema,
  handler: Effect.fn("desktop.ipc.sandboxEnvironment.stop")(function* (sandbox) {
    const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
    return yield* sandboxes.stop(sandbox);
  }),
});

export const destroySandboxEnvironment = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESTROY_SANDBOX_ENVIRONMENT_CHANNEL,
  payload: DesktopSandboxRefSchema,
  result: DesktopSandboxEnvironmentActionResultSchema,
  handler: Effect.fn("desktop.ipc.sandboxEnvironment.destroy")(function* (sandbox) {
    const sandboxes = yield* DesktopSandboxEnvironment.DesktopSandboxEnvironment;
    return yield* sandboxes.destroy(sandbox);
  }),
});

/** Write-only: the renderer can replace or clear a key, never read one back. */
export const setSandboxProviderCredential = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_SANDBOX_PROVIDER_CREDENTIAL_CHANNEL,
  payload: DesktopSandboxProviderCredentialInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.sandboxEnvironment.setCredential")(function* (input) {
    const credentials = yield* DesktopSandboxCredentials.DesktopSandboxCredentials;
    yield* credentials.set({
      providerId: input.providerId,
      secret: Redacted.make(input.secret),
    });
  }),
});

export const clearSandboxProviderCredential = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CLEAR_SANDBOX_PROVIDER_CREDENTIAL_CHANNEL,
  payload: DesktopSandboxProviderIdSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.sandboxEnvironment.clearCredential")(function* (providerId) {
    const credentials = yield* DesktopSandboxCredentials.DesktopSandboxCredentials;
    yield* credentials.clear(providerId);
  }),
});

export const hasSandboxProviderCredential = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.HAS_SANDBOX_PROVIDER_CREDENTIAL_CHANNEL,
  payload: DesktopSandboxProviderIdSchema,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.sandboxEnvironment.hasCredential")(function* (providerId) {
    const credentials = yield* DesktopSandboxCredentials.DesktopSandboxCredentials;
    return yield* credentials.has(providerId);
  }),
});
