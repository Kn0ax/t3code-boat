/**
 * The boat adapter as desktop and the server construct it: no account
 * environment unless one is named, and no command monitoring, which would keep
 * the pairing credential boat would otherwise store.
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
      monitoring: false,
    }),
  );
}
