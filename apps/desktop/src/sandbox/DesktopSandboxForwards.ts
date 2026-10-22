import type { DesktopSandboxRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  startSandboxForward,
  type SandboxForward,
  type SandboxForwardUpstream,
} from "./sandboxForward.ts";

export class DesktopSandboxForwardError extends Schema.TaggedError<DesktopSandboxForwardError>()(
  "DesktopSandboxForwardError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Could not open a local port for the cloud sandbox.";
  }
}

export interface DesktopSandboxForwardEndpoint {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

/**
 * One loopback forward per sandbox, the way SSH environments ride a local
 * port forward. The renderer only ever talks to the forward; see
 * `startSandboxForward` for why. A forward keeps its port for the life of the
 * app, and a reconnect only points it at the provider's current URL.
 */
export class DesktopSandboxForwards extends Context.Service<
  DesktopSandboxForwards,
  {
    readonly open: (
      sandbox: DesktopSandboxRef,
      upstream: SandboxForwardUpstream,
    ) => Effect.Effect<DesktopSandboxForwardEndpoint, DesktopSandboxForwardError>;
    readonly close: (sandbox: DesktopSandboxRef) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/sandbox/DesktopSandboxForwards") {}

const forwardKey = (sandbox: DesktopSandboxRef) =>
  JSON.stringify([sandbox.providerId, sandbox.sandboxId]);

const endpoint = (forward: SandboxForward): DesktopSandboxForwardEndpoint => ({
  httpBaseUrl: `http://127.0.0.1:${forward.port}/`,
  wsBaseUrl: `ws://127.0.0.1:${forward.port}/`,
});

const closeForward = (forward: SandboxForward) => Effect.promise(() => forward.close());

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const forwards = new Map<string, SandboxForward>();
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...forwards.values()], closeForward, { discard: true }).pipe(
      Effect.ensuring(Effect.sync(() => forwards.clear())),
    ),
  );

  const open = Effect.fn("desktop.sandbox.forwards.open")(function* (
    sandbox: DesktopSandboxRef,
    upstream: SandboxForwardUpstream,
  ) {
    const key = forwardKey(sandbox);
    const existing = forwards.get(key);
    if (existing !== undefined) {
      existing.retarget(upstream);
      return endpoint(existing);
    }
    const started = yield* Effect.tryPromise({
      try: () => startSandboxForward(upstream),
      catch: (cause) => new DesktopSandboxForwardError({ cause }),
    });
    // Another open for the same sandbox may have finished while this one listened.
    const raced = forwards.get(key);
    if (raced !== undefined) {
      yield* closeForward(started);
      raced.retarget(upstream);
      return endpoint(raced);
    }
    forwards.set(key, started);
    return endpoint(started);
  });

  const close = Effect.fn("desktop.sandbox.forwards.close")(function* (sandbox: DesktopSandboxRef) {
    const key = forwardKey(sandbox);
    const forward = forwards.get(key);
    if (forward === undefined) return;
    forwards.delete(key);
    yield* closeForward(forward);
  });

  return DesktopSandboxForwards.of({ open, close });
});

export const layer = Layer.effect(DesktopSandboxForwards, make);
