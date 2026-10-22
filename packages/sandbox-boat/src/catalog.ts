/**
 * boat-only account calls the generic sandbox provider has no place for: the
 * account's named snapshots and environments, and saving a sandbox as a named
 * snapshot. Only names and display fields leave this module; an environment's
 * env contents and secret files never do.
 */
import { SandboxProviderFailure } from "@t3tools/sandbox-core";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { makeBoatApi, type BoatCallOptions } from "./client.ts";
import { toBoatCallFailure } from "./errors.ts";

const REQUEST_TIMEOUT = Duration.seconds(30);

/** The fields of the SDK's `NamedSnapshot` the catalog reads. */
export interface BoatNamedSnapshot {
  readonly name: string;
  /** `saving`, `ready` or `failed`. */
  readonly status: string;
  readonly sizeBytes?: number;
  readonly createdAt?: Date;
}

/** The fields of the SDK's `SandboxEnvironment` the catalog reads. */
export interface BoatEnvironmentSummary {
  readonly name: string;
  /** boat applies the default environment when a sandbox names none. */
  readonly isDefault: boolean;
}

/** The slice of the boat API the catalog uses, as an interface a test can fake. */
export interface BoatCatalogClient {
  readonly listNamedSnapshots: (
    options?: BoatCallOptions,
  ) => Promise<{ readonly snapshots: ReadonlyArray<BoatNamedSnapshot> }>;
  readonly getNamedSnapshot: (
    name: string,
    options?: BoatCallOptions,
  ) => Promise<{ readonly snapshot: BoatNamedSnapshot }>;
  readonly environments: (
    options?: BoatCallOptions,
  ) => Promise<{ readonly environments: ReadonlyArray<BoatEnvironmentSummary> }>;
  /** Answers at once with `saving`; a running sandbox takes a fresh capture first. */
  readonly saveNamedSnapshot: (
    request: { readonly sandboxId: string; readonly name: string },
    options?: BoatCallOptions,
  ) => Promise<{ readonly snapshot: BoatNamedSnapshot }>;
  readonly desktop: (sandboxId: string, options?: BoatCallOptions) => Promise<BoatDesktopResponse>;
}

/** The fields of the SDK's `DesktopResponse` the catalog reads. `desktopUrl` carries a secret. */
export interface BoatDesktopResponse {
  readonly desktopUrl?: string | null;
  readonly mode?: string;
  readonly provisioning?: boolean;
}

export const BoatCatalogOperation = Schema.Literals([
  "listSnapshots",
  "listEnvironments",
  "saveSnapshot",
  "snapshotStatus",
  "desktop",
]);
export type BoatCatalogOperation = typeof BoatCatalogOperation.Type;

const OPERATION_TEXT: Readonly<Record<BoatCatalogOperation, string>> = {
  listSnapshots: "list the snapshots",
  listEnvironments: "list the environments",
  saveSnapshot: "save the snapshot",
  snapshotStatus: "read the snapshot",
  desktop: "open the desktop",
};

/** Like `SandboxProviderError`: boat's text can quote request details, so only the label travels. */
export class BoatCatalogError extends Schema.TaggedError<BoatCatalogError>()("BoatCatalogError", {
  operation: BoatCatalogOperation,
  failure: SandboxProviderFailure,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `boat could not ${OPERATION_TEXT[this.operation]} (${this.failure}).`;
  }
}

export interface BoatSnapshotState {
  readonly name: string;
  readonly status: string;
}

/** `url` is secret-bearing: hand it to the user, never to a log or span. */
export type BoatDesktop =
  | { readonly status: "ready"; readonly url: string; readonly mode?: string }
  | { readonly status: "provisioning" };

export interface BoatCatalogShape {
  readonly snapshots: Effect.Effect<ReadonlyArray<BoatNamedSnapshot>, BoatCatalogError>;
  readonly environments: Effect.Effect<ReadonlyArray<BoatEnvironmentSummary>, BoatCatalogError>;
  readonly saveSnapshot: (input: {
    readonly sandboxId: string;
    readonly name: string;
  }) => Effect.Effect<BoatSnapshotState, BoatCatalogError>;
  readonly snapshotStatus: (name: string) => Effect.Effect<BoatSnapshotState, BoatCatalogError>;
  /** Not ready yet answers `provisioning`; ask again. */
  readonly desktop: (sandboxId: string) => Effect.Effect<BoatDesktop, BoatCatalogError>;
}

const snapshotState = (snapshot: BoatNamedSnapshot): BoatSnapshotState => ({
  name: snapshot.name,
  status: snapshot.status,
});

/** What an SDK call rejected with, before its classification. */
class BoatCatalogRejection {
  readonly _tag = "BoatCatalogRejection";
  readonly cause: unknown;
  constructor(cause: unknown) {
    this.cause = cause;
  }
}

export function makeBoatCatalogFromClient(client: BoatCatalogClient): BoatCatalogShape {
  const call = <A>(
    operation: BoatCatalogOperation,
    run: (options: BoatCallOptions) => Promise<A>,
  ): Effect.Effect<A, BoatCatalogError> =>
    Effect.tryPromise({
      try: (signal) => run({ signal }),
      catch: (cause) => new BoatCatalogRejection(cause),
    }).pipe(
      Effect.catch((rejection) =>
        toBoatCallFailure(rejection.cause).pipe(
          Effect.flatMap((failure) =>
            Effect.fail(
              new BoatCatalogError({ operation, failure: failure.failure, cause: failure }),
            ),
          ),
        ),
      ),
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () => Effect.fail(new BoatCatalogError({ operation, failure: "timeout" })),
      }),
    );

  return {
    snapshots: call("listSnapshots", (options) => client.listNamedSnapshots(options)).pipe(
      Effect.map((response) => response.snapshots),
    ),
    environments: call("listEnvironments", (options) => client.environments(options)).pipe(
      Effect.map((response) => response.environments),
    ),
    saveSnapshot: (input) =>
      call("saveSnapshot", (options) => client.saveNamedSnapshot(input, options)).pipe(
        Effect.map((response) => snapshotState(response.snapshot)),
      ),
    snapshotStatus: (name) =>
      call("snapshotStatus", (options) => client.getNamedSnapshot(name, options)).pipe(
        Effect.map((response) => snapshotState(response.snapshot)),
      ),
    desktop: (sandboxId) =>
      call("desktop", (options) => client.desktop(sandboxId, options)).pipe(
        Effect.flatMap((response): Effect.Effect<BoatDesktop, BoatCatalogError> => {
          if (response.provisioning === true) return Effect.succeed({ status: "provisioning" });
          const url = response.desktopUrl?.trim();
          if (url === undefined || url === "") {
            return Effect.fail(
              new BoatCatalogError({ operation: "desktop", failure: "provider-error" }),
            );
          }
          return Effect.succeed({
            status: "ready",
            url,
            ...(response.mode === undefined ? {} : { mode: response.mode }),
          });
        }),
      ),
  };
}

const init = (options: BoatCallOptions | undefined): RequestInit | undefined =>
  options?.signal === undefined ? undefined : { signal: options.signal };

/** The catalog over the real SDK, for the account `apiKey` belongs to. */
export function boatCatalog(apiKey: Redacted.Redacted<string>): Effect.Effect<BoatCatalogShape> {
  return Effect.sync(() => {
    const api = makeBoatApi({ apiKey });
    return makeBoatCatalogFromClient({
      listNamedSnapshots: (options) => api.listNamedSnapshots(init(options)),
      getNamedSnapshot: (name, options) => api.getNamedSnapshot({ name }, init(options)),
      environments: (options) => api.environments(init(options)),
      saveNamedSnapshot: (request, options) =>
        api.saveNamedSnapshot({ namedSnapshotSaveRequest: request }, init(options)),
      // No `vnc`: boat's default desktop stream, not noVNC. No `publicAccess`: the URL keeps its token.
      desktop: (sandboxId, options) => api.desktop({ sandboxId }, init(options)),
    });
  });
}
