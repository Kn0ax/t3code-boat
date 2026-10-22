import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * boat VMs a client can run a thread on. The environment that holds the boat
 * key creates them from a snapshot, joins them to the tailnet and keeps them
 * up only while they have work; the client then pairs with the VM's own
 * `t3 serve` like any other remote environment.
 */
export const BoatVmStatus = Schema.Literals([
  "creating",
  "running",
  "stopping",
  "stopped",
  "error",
  "destroyed",
]);
export type BoatVmStatus = typeof BoatVmStatus.Type;

/** Starts the label of every boat VM T3 makes; jobs' nodes and hand-added sandboxes have none. */
export const BOAT_VM_LABEL_PREFIX = "vm ";

/** The VM's tailnet machine name, which is also the first label of its HTTPS origin. */
export const boatVmTailnetHostname = (sandboxId: string): string =>
  `t3-vm-${sandboxId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12)}`;

export const boatVmMatchesTailnetHostname = (sandboxId: string, hostname: string): boolean => {
  const name = hostname.toLowerCase();
  // Auto-joining snapshots may choose their own prefix followed by the full VM id.
  const snapshotId = sandboxId.toLowerCase().replace(/_/g, "-");
  return name === boatVmTailnetHostname(sandboxId) || name.endsWith(`-${snapshotId}`);
};

/** A tailnet name in either scheme above; boat sandbox IDs look like `bx_<id>`. */
export const isBoatVmTailnetHostname = (hostname: string): boolean =>
  /^t3-vm-[a-z0-9]+$|-bx-[a-z0-9]+$/.test(hostname.toLowerCase());

export const BoatVm = Schema.Struct({
  sandboxId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  status: BoatVmStatus,
});
export type BoatVm = typeof BoatVm.Type;

export const BoatVmListResult = Schema.Struct({
  /** False until a boat key is saved; clients then offer no boat entries. */
  available: Schema.Boolean,
  vms: Schema.Array(BoatVm),
  /** Inventory also covers saved sandbox connections created outside the VM flow. */
  sandboxIds: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type BoatVmListResult = typeof BoatVmListResult.Type;

export const BoatVmRepository = Schema.Struct({
  remoteUrl: TrimmedNonEmptyString,
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  name: TrimmedNonEmptyString,
});
export type BoatVmRepository = typeof BoatVmRepository.Type;

export const BoatVmLaunchInput = Schema.Struct({
  /** HTTPS pages require HTTPS; desktop and HTTP clients can connect over tailnet HTTP. */
  transport: Schema.optionalKey(Schema.Literals(["http", "https"])),
  /** An existing VM to start; omitted creates a new one. */
  sandboxId: Schema.optionalKey(TrimmedNonEmptyString),
  /** Omitted for a "No project" thread: the VM gets an empty scratch folder instead of a checkout. */
  repository: Schema.optionalKey(BoatVmRepository),
  /** Names the launch on the progress stream, so a client can match it before the call returns. */
  launchId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type BoatVmLaunchInput = typeof BoatVmLaunchInput.Type;

/**
 * In the order a launch reaches them; `tailscale` only when the VM joins the
 * tailnet, and `preparing` in place of `syncing` for a launch with no repository.
 */
export const BoatVmLaunchStage = Schema.Literals([
  "creating",
  "resuming",
  "installing",
  "starting",
  "tailscale",
  "syncing",
  "preparing",
]);
export type BoatVmLaunchStage = typeof BoatVmLaunchStage.Type;

export const BoatVmLaunchStatus = Schema.Literals(["running", "done", "failed", "cancelled"]);
export type BoatVmLaunchStatus = typeof BoatVmLaunchStatus.Type;

export const BoatVmLaunchSnapshot = Schema.Struct({
  launchId: TrimmedNonEmptyString,
  /** Known once boat has made (or was asked to resume) the VM. */
  sandboxId: Schema.optionalKey(TrimmedNonEmptyString),
  repositoryName: TrimmedNonEmptyString,
  stage: BoatVmLaunchStage,
  /** The snapshot a new VM starts from. */
  detail: Schema.optionalKey(Schema.String),
  status: BoatVmLaunchStatus,
  error: Schema.optionalKey(Schema.String),
});
export type BoatVmLaunchSnapshot = typeof BoatVmLaunchSnapshot.Type;

export const BoatVmLaunchListEvent = Schema.Array(BoatVmLaunchSnapshot);
export type BoatVmLaunchListEvent = typeof BoatVmLaunchListEvent.Type;

export const BoatVmCancelLaunchInput = Schema.Struct({
  launchId: TrimmedNonEmptyString,
});
export type BoatVmCancelLaunchInput = typeof BoatVmCancelLaunchInput.Type;

export const BoatVmCancelLaunchResult = Schema.Struct({
  applied: Schema.Boolean,
});
export type BoatVmCancelLaunchResult = typeof BoatVmCancelLaunchResult.Type;

export function boatVmLaunchProgressSummary(
  snapshot: Pick<BoatVmLaunchSnapshot, "stage" | "detail">,
): string {
  switch (snapshot.stage) {
    case "creating":
      return snapshot.detail === undefined
        ? "Creating the VM"
        : `Creating the VM from ${snapshot.detail}`;
    case "resuming":
      return "Resuming the VM";
    case "installing":
      return "Installing T3";
    case "starting":
      return "Starting T3";
    case "tailscale":
      return "Joining Tailscale";
    case "syncing":
      return "Cloning or pulling the repository";
    case "preparing":
      return "Preparing workspace";
  }
}

export const BoatVmLaunchResult = Schema.Struct({
  sandboxId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  /** The VM's tailnet origin using the requested transport. */
  httpBaseUrl: TrimmedNonEmptyString,
  /** One-time pairing code for the VM's `t3 serve`. Secret. */
  pairingCode: TrimmedNonEmptyString,
  /** Secret capability for the launching server's private Boat relay. */
  boatProxy: Schema.optionalKey(
    Schema.Struct({
      token: TrimmedNonEmptyString,
      /** The VM's own tailnet origin for its ports and webhooks, when it joined the tailnet. */
      tailnetHttpBaseUrl: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  ),
  /**
   * The repository's checkout on the VM, freshly pulled unless `warning` says why not;
   * without a repository, the VM server's scratch folder.
   */
  workspaceRoot: TrimmedNonEmptyString,
  /** Why the checkout was left as it was, for the user. */
  warning: Schema.optionalKey(TrimmedNonEmptyString),
});
export type BoatVmLaunchResult = typeof BoatVmLaunchResult.Type;

export const BoatVmBringHomeInput = Schema.Struct({
  sandboxId: TrimmedNonEmptyString,
});
export type BoatVmBringHomeInput = typeof BoatVmBringHomeInput.Type;

/** One VM checkout fetched into this environment's checkout of the same repository. */
export const BoatVmBroughtHome = Schema.Struct({
  /** The local repository the refs landed in. */
  repositoryRoot: TrimmedNonEmptyString,
  /** `refs/t3/boat/<sandboxId>/<branch>`, one per VM branch (plus `HEAD` when detached). */
  refs: Schema.Array(TrimmedNonEmptyString),
  /** The VM checkout had uncommitted changes; only commits travel. */
  uncommitted: Schema.Boolean,
});
export type BoatVmBroughtHome = typeof BoatVmBroughtHome.Type;

export const BoatVmBringHomeResult = Schema.Struct({
  checkouts: Schema.Array(BoatVmBroughtHome),
  /** VM checkouts this environment has no project for, by directory name. */
  unmatched: Schema.Array(TrimmedNonEmptyString),
});
export type BoatVmBringHomeResult = typeof BoatVmBringHomeResult.Type;

/** boat's rule for named snapshots: 1-63 lowercase letters, digits or dashes, not starting with a dash. */
const BOAT_SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const isBoatSnapshotName = (name: string): boolean => BOAT_SNAPSHOT_NAME.test(name);

/**
 * `t3-<owner>-<name>`, lowercase: the snapshot a new VM for the repository
 * starts from, so saving under it makes the next launch use it.
 */
export const boatVmSnapshotName = (repository: {
  readonly owner?: string | undefined;
  readonly name: string;
}): string =>
  `t3-${[repository.owner, repository.name]
    .filter((part) => part !== undefined)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")}`
    .slice(0, 63)
    .replace(/-+$/, "");

/** The repository snapshot name for a VM labelled `owner/name` (or just `name`). */
export const boatVmSnapshotNameForLabel = (label: string): string => {
  const slash = label.lastIndexOf("/");
  return slash === -1
    ? boatVmSnapshotName({ name: label })
    : boatVmSnapshotName({ owner: label.slice(0, slash), name: label.slice(slash + 1) });
};

export const BoatSnapshotName = TrimmedNonEmptyString.check(Schema.isPattern(BOAT_SNAPSHOT_NAME));

/** One of the account's named snapshots. `status` is boat's: saving, ready or failed. */
export const BoatVmSnapshot = Schema.Struct({
  name: TrimmedNonEmptyString,
  status: TrimmedNonEmptyString,
  sizeBytes: Schema.optionalKey(NonNegativeInt),
  createdAt: Schema.optionalKey(IsoDateTime),
});
export type BoatVmSnapshot = typeof BoatVmSnapshot.Type;

/** One of the account's sandbox environments, by name only: its secrets stay on boat. */
export const BoatVmAccountEnvironment = Schema.Struct({
  name: TrimmedNonEmptyString,
  isDefault: Schema.Boolean,
});
export type BoatVmAccountEnvironment = typeof BoatVmAccountEnvironment.Type;

export const BoatVmCatalog = Schema.Struct({
  /** False until a boat key is saved. */
  available: Schema.Boolean,
  snapshots: Schema.Array(BoatVmSnapshot),
  environments: Schema.Array(BoatVmAccountEnvironment),
});
export type BoatVmCatalog = typeof BoatVmCatalog.Type;

export const BoatVmSaveSnapshotInput = Schema.Struct({
  sandboxId: TrimmedNonEmptyString,
  /** Reusing a name replaces that snapshot once the new save is ready. */
  name: BoatSnapshotName,
});
export type BoatVmSaveSnapshotInput = typeof BoatVmSaveSnapshotInput.Type;

export const BoatVmSnapshotState = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** saving, ready or failed. */
  status: TrimmedNonEmptyString,
});
export type BoatVmSnapshotState = typeof BoatVmSnapshotState.Type;

export const BoatVmDesktopInput = Schema.Struct({
  sandboxId: TrimmedNonEmptyString,
});
export type BoatVmDesktopInput = typeof BoatVmDesktopInput.Type;

/** `provisioning` means boat is still preparing the desktop; ask again. */
export const BoatVmDesktop = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    /** boat's desktop stream URL. Secret: it carries an access token. */
    url: TrimmedNonEmptyString,
    /** boat's name for the desktop mode, as boat sent it. */
    mode: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ status: Schema.Literal("provisioning") }),
]);
export type BoatVmDesktop = typeof BoatVmDesktop.Type;

export class BoatVmError extends Schema.TaggedError<BoatVmError>()("BoatVmError", {
  message: Schema.String,
}) {}
