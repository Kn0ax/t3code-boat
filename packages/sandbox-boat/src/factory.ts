/**
 * The boat adapter as desktop and the server construct it: no account
 * environment unless one is named, and the account's monitoring default, so
 * boat keeps command output and process history. That output includes the
 * one-time pairing credential, which expires minutes after the bootstrap uses it.
 */
import type { SandboxProviderShape } from "@t3tools/sandbox-core";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";

import { makeBoatSandboxProvider } from "./provider.ts";

export function boatSandboxProvider(
  apiKey: Redacted.Redacted<string>,
  options: { readonly environment?: string } = {},
): Effect.Effect<SandboxProviderShape> {
  return Effect.sync(() =>
    makeBoatSandboxProvider({
      apiKey,
      ...(options.environment === undefined
        ? { noEnv: true }
        : { environment: options.environment }),
    }),
  );
}
