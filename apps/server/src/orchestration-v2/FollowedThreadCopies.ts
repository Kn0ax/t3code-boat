/**
 * Copies here of threads that still live in another environment, such as a
 * running or stopped boat VM. While the source exists the conversation goes on
 * there, so ThreadManagementService refuses a message sent to such a copy
 * rather than run it here. Once the source is gone, the copies' owner drops it
 * from this set and the copy becomes an ordinary thread.
 *
 * @module FollowedThreadCopies
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export class FollowedThreadCopies extends Context.Service<
  FollowedThreadCopies,
  {
    readonly has: (threadId: ThreadId) => Effect.Effect<boolean>;
    /** Replaces the whole set; the copies' owner is its only writer. */
    readonly replace: (threadIds: ReadonlySet<string>) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/FollowedThreadCopies") {}

const make = Effect.gen(function* () {
  const followed = yield* Ref.make<ReadonlySet<string>>(new Set());
  return FollowedThreadCopies.of({
    has: (threadId) => Ref.get(followed).pipe(Effect.map((ids) => ids.has(threadId))),
    replace: (threadIds) => Ref.set(followed, threadIds),
  });
});

export const layer = Layer.effect(FollowedThreadCopies, make);
