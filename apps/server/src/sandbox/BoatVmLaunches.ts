/**
 * Progress of the boat VM launches running on this server, for the banner a
 * client shows above the composer while one runs. Entries live in memory
 * only: a launch is one RPC call, so a restarted server has none to report.
 *
 * @module BoatVmLaunches
 */
import type {
  BoatVmLaunchSnapshot,
  BoatVmLaunchStage,
  BoatVmLaunchStatus,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/** Long enough for a client that missed the end to see it; the RPC result already carries it. */
const FINISHED_RETENTION = Duration.seconds(10);

export interface BoatVmLaunchProgress {
  readonly stage: BoatVmLaunchStage;
  readonly detail?: string | undefined;
  readonly sandboxId?: string | undefined;
}

interface TrackedLaunch {
  snapshot: BoatVmLaunchSnapshot;
  fiber: Fiber.Fiber<unknown, unknown> | undefined;
}

export const make = Effect.fn("BoatVmLaunches.make")(function* (scope: Scope.Scope) {
  const launches = new Map<string, TrackedLaunch>();
  const changes = yield* PubSub.unbounded<ReadonlyArray<BoatVmLaunchSnapshot>>();

  const list = () => Array.from(launches.values(), (tracked) => tracked.snapshot);
  const publish = Effect.suspend(() => PubSub.publish(changes, list()));

  /** False when a launch with this id is still running. */
  const begin = Effect.fn("BoatVmLaunches.begin")(function* (
    launchId: string,
    repositoryName: string,
    progress: BoatVmLaunchProgress,
  ) {
    if (launches.get(launchId)?.snapshot.status === "running") return false;
    launches.set(launchId, {
      fiber: undefined,
      snapshot: {
        launchId,
        repositoryName,
        stage: progress.stage,
        ...(progress.detail === undefined ? {} : { detail: progress.detail }),
        ...(progress.sandboxId === undefined ? {} : { sandboxId: progress.sandboxId }),
        status: "running",
      },
    });
    yield* publish;
    return true;
  });

  const attach = (launchId: string, fiber: Fiber.Fiber<unknown, unknown>) =>
    Effect.sync(() => {
      const tracked = launches.get(launchId);
      if (tracked !== undefined) tracked.fiber = fiber;
    });

  /** Publishes only a change, so a step that runs twice does not repaint every client. */
  const report = (launchId: string, progress: Partial<BoatVmLaunchProgress>) =>
    Effect.suspend(() => {
      const tracked = launches.get(launchId);
      if (tracked === undefined || tracked.snapshot.status !== "running") return Effect.void;
      const current = tracked.snapshot;
      const stage = progress.stage ?? current.stage;
      const detail = progress.stage === undefined ? current.detail : progress.detail;
      const sandboxId = progress.sandboxId ?? current.sandboxId;
      if (stage === current.stage && detail === current.detail && sandboxId === current.sandboxId) {
        return Effect.void;
      }
      const { detail: _detail, sandboxId: _sandboxId, ...rest } = current;
      tracked.snapshot = {
        ...rest,
        stage,
        ...(detail === undefined ? {} : { detail }),
        ...(sandboxId === undefined ? {} : { sandboxId }),
      };
      return publish;
    });

  const finish = Effect.fn("BoatVmLaunches.finish")(function* (
    launchId: string,
    status: Exclude<BoatVmLaunchStatus, "running">,
    error?: string,
  ) {
    const tracked = launches.get(launchId);
    if (tracked === undefined) return;
    tracked.fiber = undefined;
    tracked.snapshot = {
      ...tracked.snapshot,
      status,
      ...(error === undefined ? {} : { error }),
    };
    yield* publish;
    const finished = tracked.snapshot;
    yield* Effect.suspend(() => {
      // A relaunch under the same id replaced the entry; it is not this one's to drop.
      if (launches.get(launchId)?.snapshot !== finished) return Effect.void;
      launches.delete(launchId);
      return publish;
    }).pipe(Effect.delay(FINISHED_RETENTION), Effect.forkIn(scope));
  });

  /** Interrupts the launch and waits until it has cleaned up. */
  const cancel = Effect.fn("BoatVmLaunches.cancel")(function* (launchId: string) {
    const fiber = launches.get(launchId)?.fiber;
    if (fiber === undefined) return false;
    yield* Effect.uninterruptible(Fiber.interrupt(fiber));
    return true;
  });

  const stream = Stream.callback<ReadonlyArray<BoatVmLaunchSnapshot>>(
    (mailbox) =>
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        Queue.offerUnsafe(mailbox, list());
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((snapshots) =>
            Effect.sync(() => Queue.offerUnsafe(mailbox, snapshots)),
          ),
          Effect.forkScoped,
        );
      }),
    { bufferSize: 1, strategy: "sliding" },
  );

  return { begin, attach, report, finish, cancel, stream };
});
