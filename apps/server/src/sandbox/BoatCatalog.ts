/**
 * The boat account's named snapshots and environments, and saving a VM as a
 * named snapshot, for `BoatVmService`. Kept apart from the VM lifecycle: these
 * calls only read or write account records and never touch a VM's shell.
 *
 * @module BoatCatalog
 */
import {
  BoatVmError,
  type BoatVmCatalog,
  type BoatVmSaveSnapshotInput,
  type BoatVmSnapshotStatusInput,
  type SandboxJobSettings,
} from "@t3tools/contracts";
import type { BoatCatalogShape } from "@t3tools/sandbox-boat";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export type BoatCatalogResolver = (
  settings: SandboxJobSettings,
) => Effect.Effect<BoatCatalogShape | undefined>;

export const resolveBoatCatalog: BoatCatalogResolver = Effect.fn("BoatVmService.resolveCatalog")(
  function* (settings: SandboxJobSettings) {
    const secret = settings.providerKeys.boat.trim();
    if (secret === "") return undefined;
    // The SDK loads on first use, so servers without boat never pay for it.
    const boat = yield* Effect.promise(() => import("@t3tools/sandbox-boat"));
    return yield* boat.boatCatalog(Redacted.make(secret));
  },
);

const NO_KEY = "Add a boat key in Settings, Integrations, Boat VMs, to use boat snapshots.";

export const makeOperations = (
  getSettings: Effect.Effect<SandboxJobSettings, BoatVmError>,
  resolveCatalog: BoatCatalogResolver,
) => {
  const requireCatalog = getSettings.pipe(
    Effect.flatMap(resolveCatalog),
    Effect.filterOrFail(
      (catalog): catalog is BoatCatalogShape => catalog !== undefined,
      () => new BoatVmError({ message: NO_KEY }),
    ),
  );
  const toVmError = (error: { readonly message: string }) =>
    new BoatVmError({ message: error.message });

  const catalog: Effect.Effect<BoatVmCatalog, BoatVmError> = Effect.gen(function* () {
    const account = yield* resolveCatalog(yield* getSettings);
    if (account === undefined) return { available: false, snapshots: [], environments: [] };
    const [snapshots, environments] = yield* Effect.all([account.snapshots, account.environments], {
      concurrency: 2,
    }).pipe(Effect.mapError(toVmError));
    return {
      available: true,
      snapshots: snapshots.map((snapshot) => ({
        name: snapshot.name,
        status: snapshot.status,
        ...(snapshot.sizeBytes !== undefined &&
        Number.isSafeInteger(snapshot.sizeBytes) &&
        snapshot.sizeBytes >= 0
          ? { sizeBytes: snapshot.sizeBytes }
          : {}),
        ...(snapshot.createdAt === undefined || Number.isNaN(snapshot.createdAt.getTime())
          ? {}
          : { createdAt: snapshot.createdAt.toISOString() }),
      })),
      environments: environments.map((environment) => ({
        name: environment.name,
        isDefault: environment.isDefault,
      })),
    };
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("boat.vm.catalog.failed", { error: error.message }),
    ),
    Effect.withSpan("BoatVmService.catalog"),
  );

  const saveSnapshot = Effect.fn("BoatVmService.saveSnapshot")(
    function* (input: BoatVmSaveSnapshotInput) {
      const account = yield* requireCatalog;
      return yield* account.saveSnapshot(input).pipe(Effect.mapError(toVmError));
    },
    Effect.tapError((error) =>
      Effect.logWarning("boat.vm.snapshot.save.failed", { error: error.message }),
    ),
  );

  const snapshotStatus = Effect.fn("BoatVmService.snapshotStatus")(function* (
    input: BoatVmSnapshotStatusInput,
  ) {
    const account = yield* requireCatalog;
    return yield* account.snapshotStatus(input.name).pipe(Effect.mapError(toVmError));
  });

  return { catalog, saveSnapshot, snapshotStatus };
};
