/**
 * boat VMs a thread can run on. Not kept around: a VM starts from the
 * repository's named snapshot (else the general one), joins the tailnet,
 * pulls the repository and serves `t3 serve` over Tailscale HTTPS, so every
 * client on the tailnet pairs with it like any other remote environment.
 *
 * boat's auto-stop is a deadline, not idle time, so a VM is created with the
 * idle window as its deadline and this server pushes the deadline out while
 * the VM has work. With nothing to do, or this server gone, boat archives it;
 * picking it again resumes it from its saved disk.
 *
 * @module BoatVmService
 */
import {
  BOAT_VM_LABEL_PREFIX,
  BoatVmError,
  boatVmSnapshotName,
  boatVmTailnetHostname,
  type BoatVmBringHomeInput,
  type BoatVmBringHomeResult,
  type BoatVmCancelLaunchInput,
  type BoatVmCancelLaunchResult,
  type BoatVmBroughtHome,
  type BoatVmCatalog,
  type BoatVmDesktop,
  type BoatVmDesktopInput,
  type BoatVmLaunchInput,
  type BoatVmLaunchListEvent,
  type BoatVmLaunchResult,
  type BoatVmListResult,
  type BoatVmSaveSnapshotInput,
  type BoatVmSnapshotState,
  type OrchestrationProjectShell,
  type SandboxJobSettings,
} from "@t3tools/contracts";
import {
  formatSandboxLaunchEnv,
  SANDBOX_LAUNCH_ENV_PATH,
  SANDBOX_STATE_KEY,
  SandboxEnvironmentManager,
  SandboxProviderError,
  sandboxAgentEnvironment,
  sandboxScriptKind,
  type SandboxEnvironmentBootstrap,
  type SandboxProviderShape,
  type SandboxExecResult,
  type SandboxExposedPort,
  type SandboxInfo,
  type SandboxRef,
} from "@t3tools/sandbox-core";
import { importBranchesBundle } from "@t3tools/sandbox-handoff";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ThreadImportService from "../orchestration-v2/ThreadImportService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { projectShellForRemote } from "../project/repositoryRemote.ts";
import * as Settings from "../serverSettings.ts";
import * as BoatVmProxy from "./BoatVmProxy.ts";
import * as BoatCatalog from "./BoatCatalog.ts";
import * as BoatVmLifecycle from "./BoatVmLifecycle.ts";
import * as BoatVmLaunches from "./BoatVmLaunches.ts";
import { sandboxT3Version } from "./SandboxJobService.ts";

const T3_PORT = 3773;
/** Activity in the last check interval (plus slack) keeps a VM up. */
const KEEP_ALIVE_INTERVAL_MINUTES = 5;
const SCRIPT_TIMEOUT_MS = 5 * 60_000;
const SYNC_ENV_PATH = "~/.t3/boat-sync-env";

/** scp-style remotes (`git@host:owner/repo`) have no SSH key on the VM; HTTPS takes GH_TOKEN. */
export const boatVmCloneUrl = (remoteUrl: string): string => {
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(remoteUrl);
  if (scp !== null) return `https://${scp[1]}/${scp[2]}`;
  return remoteUrl.replace(/^ssh:\/\/[\w.-]+@([\w.-]+)(?::\d+)?\//, "https://$1/");
};

const directoryName = (name: string) => {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "");
  return safe === "" ? "workspace" : safe.slice(0, 64);
};

/** Where the auth key waits for the tailnet script, which deletes it. */
export const TAILNET_KEY_PATH = "~/.t3/tailscale-authkey";

// A VM made from a snapshot carries the source VM's T3 state (its environment
// ID, keys and threads) and Tailscale node key. Reset T3 before a clone starts;
// snapshots that manage their own Tailscale identity must keep that state.
export const CLONE_RESET_SCRIPT = `set -eu
MARKER="$HOME/.t3/boat-vm-id"
mkdir -p "$HOME/.t3"
if [ "$(cat "$MARKER" 2>/dev/null || true)" != "$1" ]; then
  rm -rf "$HOME/.t3/userdata"
  if [ "\${2:-auth-key}" != snapshot ]; then
    sudo systemctl stop tailscaled >/dev/null 2>&1 || true
    sudo rm -f /var/lib/tailscale/tailscaled.state
  fi
  printf '%s' "$1" >"$MARKER"
fi
`;

// Joins the tailnet and serves T3's port over HTTPS; prints the VM's tailnet name.
export const TAILNET_SCRIPT = `set -eu
TS_HOSTNAME="$1"
TS_AUTHKEY="$(cat "$HOME/.t3/tailscale-authkey" 2>/dev/null || true)"
rm -f "$HOME/.t3/tailscale-authkey"
if [ -z "\${TS_AUTHKEY:-}" ]; then
  printf 'No Tailscale auth key reached the VM.\\n' >&2
  exit 3
fi
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1
fi
sudo systemctl enable --now tailscaled >/dev/null 2>&1 || true
# --reset drops flags a snapshot set before, which tailscale up would otherwise
# require repeating.
sudo tailscale up --reset --auth-key="$TS_AUTHKEY" --hostname="$TS_HOSTNAME" >/dev/null
if [ "\${2:-https}" = http ]; then
  sudo tailscale serve --bg --http=80 http://127.0.0.1:${T3_PORT} >/dev/null
else
  sudo tailscale serve --bg --https=443 http://127.0.0.1:${T3_PORT} >/dev/null
fi
sudo tailscale status --json | node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{process.stdout.write(String(JSON.parse(s).Self.DNSName).replace(/\\.$/,""))})'
`;

// Releases a VM's tailnet node before boat deletes it, so it does not linger.
export const TAILNET_LOGOUT_SCRIPT = `sudo tailscale logout >/dev/null 2>&1 || true
`;

// The snapshot's boot service owns login and hostname. Wait for its actual
// connection instead of racing it or resetting a resumed machine's identity.
export const SNAPSHOT_TAILNET_SCRIPT = `set -eu
TS_AUTHKEY="$(cat "$HOME/.t3/tailscale-authkey" 2>/dev/null || true)"
rm -f "$HOME/.t3/tailscale-authkey"
if ! command -v tailscale >/dev/null 2>&1; then
  printf 'The snapshot does not have Tailscale installed.\\n' >&2
  exit 3
fi
ATTEMPT=0
while [ "$ATTEMPT" -lt 60 ]; do
  if DNS_NAME="$(sudo tailscale status --json 2>/dev/null | node -e '
    let input = "";
    process.stdin.on("data", (data) => { input += data; }).on("end", () => {
      try {
        const status = JSON.parse(input);
        const name = String(status.Self?.DNSName ?? "").replace(/\\.$/, "");
        if (status.BackendState !== "Running" || name.length > 253 ||
          !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(name)) {
          process.exitCode = 1;
          return;
        }
        process.stdout.write(name);
      } catch { process.exitCode = 1; }
    });
  ')"; then
    if [ "\${1:-https}" = http ]; then
      sudo tailscale serve --bg --http=80 http://127.0.0.1:${T3_PORT} >/dev/null
    else
      sudo tailscale serve --bg --https=443 http://127.0.0.1:${T3_PORT} >/dev/null
    fi
    printf '%s' "$DNS_NAME"
    exit 0
  fi
  ATTEMPT=$((ATTEMPT + 1))
  # A saved key rescues a VM the snapshot cannot log in, such as one first joined
  # with that key whose node has since expired.
  if [ -n "$TS_AUTHKEY" ] && [ "$ATTEMPT" -ge 15 ] && sudo tailscale status --json 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{process.exitCode=JSON.parse(s).BackendState==="NeedsLogin"?0:1})'; then
    sudo tailscale up --reset --auth-key="$TS_AUTHKEY" >/dev/null
    TS_AUTHKEY=""
  fi
  sleep 2
done
printf 'The snapshot did not connect to Tailscale within 120 seconds. Check its automatic Tailscale setup.\\n' >&2
exit 3
`;

// Clones the repository, or pulls it when the snapshot already has it, and
// prints the checkout and how it went: synced, dirty (local changes, fetched
// but left as it is) or diverged (could not fast-forward). GH_TOKEN comes
// from the launch env file, as the VM's env holds no keys.
export const SYNC_SCRIPT = `set -eu
REMOTE="$1"
DIR="$HOME/work/$2"
if [ -f "$HOME/.t3/boat-sync-env" ]; then
  set -a
  . "$HOME/.t3/boat-sync-env"
  set +a
  rm -f "$HOME/.t3/boat-sync-env"
fi
# Sync can start before the server configures its global Git helper.
if [ -n "\${GH_TOKEN:-}" ]; then
  export GIT_CONFIG_COUNT=2
  export GIT_CONFIG_KEY_0=credential.https://github.com.helper GIT_CONFIG_VALUE_0=''
  export GIT_CONFIG_KEY_1=credential.https://github.com.helper
  export GIT_CONFIG_VALUE_1='!f() { test "$1" = get && test -n "\${GH_TOKEN:-}" && printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; }; f'
fi
# A host's SSH and HTTPS URLs, with or without a user, address the same
# repository, and hosts match owner and name without regard to case.
remote_identity() {
  printf '%s' "$1" |
    sed -E 's#^[a-z+]+://##; s#^[^@/]*@##; s#^([^/:]+):#\\1/#; s#/+$##; s#[.]git$##' |
    tr 'A-Z' 'a-z'
}
EXPECTED="$(remote_identity "$REMOTE")"
BASE_DIR="$DIR"
SUFFIX=1
while [ -e "$DIR" ]; do
  ORIGIN="$(git -C "$DIR" config --get remote.origin.url 2>/dev/null || true)"
  if [ -n "$ORIGIN" ] && [ "$(remote_identity "$ORIGIN")" = "$EXPECTED" ]; then
    break
  fi
  SUFFIX=$((SUFFIX + 1))
  DIR="$BASE_DIR-$SUFFIX"
done
STATE=synced
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --prune --quiet origin
  if [ -n "$(git -C "$DIR" status --porcelain)" ]; then
    STATE=dirty
  elif ! git -C "$DIR" pull --ff-only --quiet; then
    STATE=diverged
  fi
else
  mkdir -p "$HOME/work"
  # Cloned aside and moved in, so a clone a timeout left running never looks
  # like a checkout to the next launch.
  CLONE="$(mktemp -d "$HOME/work/.clone.XXXXXX")"
  git clone --quiet "$REMOTE" "$CLONE/repo"
  mv "$CLONE/repo" "$DIR"
  rmdir "$CLONE"
fi
printf '%s\\n%s\\n' "$DIR" "$STATE"
`;

// A launch with no repository gets the VM server's own scratch folder (its
// base dir is ~/.t3), so the client opens it there as a "No project" thread.
const SCRATCH_SCRIPT = `set -eu
mkdir -p "$HOME/.t3/scratch"
printf '%s\\n' "$HOME/.t3/scratch"
`;

/** The label and progress name of a VM launched without a repository. */
const SCRATCH_VM_NAME = "scratch";

const SYNC_WARNINGS: Readonly<Record<string, (name: string) => string>> = {
  dirty: (name) =>
    `${name} has uncommitted changes on the VM, so it was not updated. Commit or discard them there to pull.`,
  diverged: (name) =>
    `${name} on the VM could not fast-forward to the remote branch, so it was not updated.`,
};

// Exits 0 while the VM has work: T3's state changed in the last N minutes (a
// turn, a message), a client is connected (tailscale serve reaches T3 on
// loopback), or the server has a child process (an agent, a terminal, a dev
// server; an idle agent session ends after the server's own idle timeout).
// /proc/net/tcp gives the local port in hex (the second argument) and state
// 01 for established. The server's pid is the one the serve step recorded,
// and a parent pid is the second field after a /proc stat line's name.
export const BUSY_SCRIPT = `if find "$HOME/.t3/userdata" -maxdepth 1 -mmin "-$1" 2>/dev/null | grep -q .; then exit 0; fi
for TABLE in /proc/net/tcp /proc/net/tcp6; do
  [ -r "$TABLE" ] && awk -v port=":$2" 'substr($2, length($2) - 4) == port && $4 == "01" { found = 1 } END { exit !found }' "$TABLE" && exit 0
done
SERVER="$(cat "$HOME/.t3/ssh-launch/${SANDBOX_STATE_KEY}/pid" 2>/dev/null || true)"
case "$SERVER" in ''|*[!0-9]*) exit 1 ;; esac
sed -n 's/.*) [A-Za-z] \\([0-9]*\\) .*/\\1/p' /proc/[0-9]*/stat 2>/dev/null | grep -qx "$SERVER"`;

/** A port as /proc/net/tcp writes it. */
export const busyPortArg = (port: number): string =>
  port.toString(16).toUpperCase().padStart(4, "0");

// Each checkout under ~/work and its origin, one `<directory>\t<url>` line apiece.
const CHECKOUTS_SCRIPT = `for dir in "$HOME"/work/*/; do
  dir="\${dir%/}"
  [ -d "$dir/.git" ] || continue
  url="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
  [ -z "$url" ] || printf '%s\\t%s\\n' "\${dir##*/}" "$url"
done
exit 0
`;

/** Exit status of the bundle script for a checkout with no commit yet. */
const NO_COMMITS_EXIT_CODE = 4;

// Bundles every branch of ~/work/<directory>, and HEAD when it is detached.
// Prints "<bundle path> <detached 0|1> <uncommitted 0|1>". Uncommitted changes
// are left alone: the checkout is the VM's, and only commits travel.
const BUNDLE_SCRIPT = `set -eu
cd "$HOME/work/$1"
git rev-parse --verify --quiet HEAD >/dev/null || exit ${NO_COMMITS_EXIT_CODE}
BUNDLE="$(mktemp "$HOME/.t3-bring-home.XXXXXXXX")"
trap 'rm -f "$BUNDLE"' EXIT
DETACHED=0
git symbolic-ref --quiet HEAD >/dev/null || DETACHED=1
DIRTY=0
[ -z "$(git status --porcelain)" ] || DIRTY=1
if [ "$DETACHED" = 1 ]; then
  git bundle create --quiet "$BUNDLE" --branches HEAD
else
  git bundle create --quiet "$BUNDLE" --branches
fi
trap - EXIT
printf '%s %s %s\\n' "$BUNDLE" "$DETACHED" "$DIRTY"
`;

const REMOVE_BUNDLE_SCRIPT = `case "$1" in
  "$HOME"/.t3-bring-home.*) rm -f -- "$1" ;;
esac
`;

const CHECKOUT_DIRECTORY = /^[A-Za-z0-9._-]+$/;
const BUNDLE_ANSWER = /^(\/\S*\/\.t3-bring-home\.[A-Za-z0-9]+) ([01]) ([01])$/;

/** Where a VM's branches land in a local repository. */
const boatVmRefPrefix = (sandboxId: string): string =>
  `refs/t3/boat/${sandboxId.replace(/[^A-Za-z0-9._-]/g, "-")}/`;

/** This environment's checkout of the repository at `remoteUrl`, matched by repository identity. */
const localCheckoutOf = (
  shells: ReadonlyArray<Pick<OrchestrationProjectShell, "workspaceRoot" | "repositoryIdentity">>,
  remoteUrl: string,
): string | undefined => {
  const shell = projectShellForRemote(shells, remoteUrl);
  return shell === undefined
    ? undefined
    : (shell.repositoryIdentity?.rootPath ?? shell.workspaceRoot);
};

const vmError = (message: string) => new BoatVmError({ message });

const describe = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error._tag === "SandboxEnvironmentError" || error._tag === "SandboxProviderError") &&
  "message" in error &&
  typeof error.message === "string"
    ? error.message
    : "The boat VM could not be prepared. See the server log.";

/**
 * The boat provider with Tailscale as its way in: the VM is reached at its
 * tailnet name instead of a public boat URL, so it never takes connections
 * from outside the tailnet.
 */
export const withTailnet = (
  provider: SandboxProviderShape,
  authKey: string,
  useSnapshotTailscale = false,
  preparationScope?: Scope.Scope,
  transport: "http" | "https" | "boat" = "https",
): SandboxProviderShape => {
  const checked = new Set<string>();
  const earlyExposure = new Map<string, Effect.Effect<SandboxExposedPort, SandboxProviderError>>();
  // The first script on a VM is the manager's install step, before T3 starts.
  const exec: SandboxProviderShape["exec"] = Effect.fn("BoatVmService.withTailnet.exec")(
    function* (ref, input) {
      if (!checked.has(ref.sandboxId)) {
        const reset = yield* provider.exec(ref, {
          script: CLONE_RESET_SCRIPT,
          args: [
            ref.sandboxId,
            // Over the relay, a saved auth key still joins the VM, so a clone resets.
            useSnapshotTailscale || (transport === "boat" && authKey === "")
              ? "snapshot"
              : "auth-key",
          ],
          timeoutMs: SCRIPT_TIMEOUT_MS,
        });
        if (reset.exitCode !== 0) {
          return yield* new SandboxProviderError({
            providerId: provider.id,
            operation: "exec",
            failure: "provider-error",
          });
        }
        checked.add(ref.sandboxId);
      }
      const result = yield* provider.exec(ref, input);
      if (
        useSnapshotTailscale &&
        transport !== "boat" &&
        result.exitCode === 0 &&
        sandboxScriptKind(input.script) === "install"
      ) {
        // A new hostname's certificate takes time. Start it before agent/server setup.
        const exposure = yield* Effect.cached(exposePort(ref, T3_PORT));
        earlyExposure.set(ref.sandboxId, exposure);
        yield* preparationScope === undefined
          ? exposure.pipe(Effect.ignore)
          : exposure.pipe(Effect.ignore, Effect.forkIn(preparationScope));
      }
      return result;
    },
  );
  const exposePort: SandboxProviderShape["exposePort"] = Effect.fn(
    "BoatVmService.withTailnet.exposePort",
  )(function* (ref, port) {
    if (transport === "boat") return yield* provider.exposePort(ref, port);
    if (port !== T3_PORT) {
      return yield* new SandboxProviderError({
        providerId: provider.id,
        operation: "exposePort",
        failure: "unsupported",
      });
    }
    const hostname = boatVmTailnetHostname(ref.sandboxId);
    // Sent as a file on every start, not as create-time env: a resumed VM
    // would keep the key it was made with, and exec args land in boat's
    // command history. A snapshot that logs in itself gets a saved key only as
    // its fallback.
    if (!useSnapshotTailscale || authKey !== "") {
      yield* provider.writeFile(ref, TAILNET_KEY_PATH, new TextEncoder().encode(authKey));
    }
    const result = yield* provider.exec(ref, {
      script: useSnapshotTailscale ? SNAPSHOT_TAILNET_SCRIPT : TAILNET_SCRIPT,
      args: useSnapshotTailscale
        ? transport === "http"
          ? ["http"]
          : []
        : [hostname, ...(transport === "http" ? ["http"] : [])],
      timeoutMs: SCRIPT_TIMEOUT_MS,
    });
    const dnsName = result.stdout.trim();
    if (result.exitCode !== 0 || !/^[a-z0-9.-]+$/i.test(dnsName)) {
      yield* Effect.logWarning("boat.vm.tailnet.failed", {
        sandboxId: ref.sandboxId,
        exitCode: result.exitCode,
        stderr: result.stderr.slice(-500),
      });
      return yield* new SandboxProviderError({
        providerId: provider.id,
        operation: "exposePort",
        failure: "provider-error",
      });
    }
    return { httpBaseUrl: `${transport}://${dnsName}`, headers: {} };
  });
  return {
    ...provider,
    exec,
    exposePort: (ref, port) =>
      port === T3_PORT
        ? (earlyExposure.get(ref.sandboxId) ?? exposePort(ref, port))
        : exposePort(ref, port),
  };
};

/** Writes the agent keys where the next serve or sync step reads and deletes them. */
const writeLaunchEnv = (
  provider: SandboxProviderShape,
  ref: SandboxRef,
  env: Readonly<Record<string, string>>,
) =>
  Object.keys(env).length === 0
    ? Effect.void
    : provider.writeFile(
        ref,
        SANDBOX_LAUNCH_ENV_PATH,
        new TextEncoder().encode(formatSandboxLaunchEnv(env)),
      );

/**
 * The boat provider with the agent keys handed to each server start as a
 * file. boat keeps per-sandbox env across stops and copies it into every
 * snapshot and fork of the VM, so VMs are created without any.
 */
export const withLaunchEnv = (
  provider: SandboxProviderShape,
  env: Readonly<Record<string, string>>,
): SandboxProviderShape => ({
  ...provider,
  startBackground: (ref, input) =>
    writeLaunchEnv(provider, ref, env).pipe(Effect.andThen(provider.startBackground(ref, input))),
});

export class BoatVmService extends Context.Service<
  BoatVmService,
  {
    readonly list: Effect.Effect<BoatVmListResult, BoatVmError>;
    readonly launch: (input: BoatVmLaunchInput) => Effect.Effect<BoatVmLaunchResult, BoatVmError>;
    /** Every launch in progress, and ones that just ended, on each stage change. */
    readonly launches: Stream.Stream<BoatVmLaunchListEvent>;
    /** Interrupts a launch; a new VM it made is removed like a failed one. */
    readonly cancelLaunch: (
      input: BoatVmCancelLaunchInput,
    ) => Effect.Effect<BoatVmCancelLaunchResult>;
    /**
     * Fetches the branches of every checkout on the VM into this environment's
     * checkout of the same repository, under `boatVmRefPrefix`. Never pushes:
     * the user signs and pushes from their own machine.
     */
    readonly bringHome: (
      input: BoatVmBringHomeInput,
    ) => Effect.Effect<BoatVmBringHomeResult, BoatVmError>;
    /**
     * Applies the VM lifecycle rules to every running VM (see BoatVmLifecycle),
     * then pushes out the deadline of each one left running that had work since
     * the last check.
     */
    readonly keepAlive: Effect.Effect<void>;
    /** The account's named snapshots and environments; unavailable without a boat key. */
    readonly catalog: Effect.Effect<BoatVmCatalog, BoatVmError>;
    /** Starts saving a VM as a named snapshot; boat answers before the capture finishes. */
    readonly saveSnapshot: (
      input: BoatVmSaveSnapshotInput,
    ) => Effect.Effect<BoatVmSnapshotState, BoatVmError>;
    /** The VM's desktop stream URL, or `provisioning` until boat has it ready. */
    readonly desktop: (input: BoatVmDesktopInput) => Effect.Effect<BoatVmDesktop, BoatVmError>;
  }
>()("t3/sandbox/BoatVmService") {}

export type BoatProviderResolver = (
  settings: SandboxJobSettings,
) => Effect.Effect<SandboxProviderShape | undefined, BoatVmError, Scope.Scope>;

export interface BoatVmServiceOptions {
  readonly resolveProvider?: BoatProviderResolver;
  readonly resolveCatalog?: BoatCatalog.BoatCatalogResolver;
  readonly t3Version?: string;
  /** null turns off the background keep-alive loop (tests call `keepAlive`). */
  readonly keepAliveInterval?: Duration.Input | null;
}

export const make = Effect.fn("BoatVmService.make")(function* (options: BoatVmServiceOptions = {}) {
  const manager = yield* SandboxEnvironmentManager;
  const settingsService = yield* Settings.ServerSettingsService;
  const boatProxy = yield* BoatVmProxy.BoatVmProxy;
  const crypto = yield* Crypto.Crypto;
  const projects = yield* ProjectService.ProjectService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const t3Version = options.t3Version ?? sandboxT3Version(packageJson.version);
  const lifecycle = yield* BoatVmLifecycle.make({
    statePath: path.join((yield* ServerConfig.ServerConfig).stateDir, "boat-vm-threads.json"),
    manager,
    threadImport: yield* ThreadImportService.ThreadImportService,
    homeProjectFor: (remoteUrl) =>
      remoteUrl === null
        ? managedFolders.ensureScratchProject.pipe(
            Effect.map(({ projectId }) => projectId),
            Effect.mapError((error) => error.message),
          )
        : projects.listShells().pipe(
            Effect.mapError(() => "this environment's projects could not be read"),
            Effect.flatMap((shells) => {
              const project = projectShellForRemote(shells, remoteUrl);
              return project === undefined
                ? Effect.fail(`no project here is a checkout of ${remoteUrl}`)
                : Effect.succeed(project.id);
            }),
          ),
    beforeDelete: (provider, ref) =>
      provider.exec(ref, { script: TAILNET_LOGOUT_SCRIPT, timeoutMs: 20_000 }).pipe(Effect.ignore),
  });

  const resolveProvider: BoatProviderResolver =
    options.resolveProvider ??
    ((settings) =>
      Effect.gen(function* () {
        const secret = settings.providerKeys.boat.trim();
        if (secret === "") return undefined;
        // The SDKs load on first use, so servers without boat never pay for them.
        const boat = yield* Effect.promise(() => import("@t3tools/sandbox-boat"));
        const environment = settings.boatVmEnvironment.trim();
        return yield* boat.boatSandboxProvider(
          Redacted.make(secret),
          environment === "" ? {} : { environment },
        );
      }));

  const getSettings = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.sandboxJobs),
    Effect.mapError(() => vmError("Could not read the server settings.")),
  );

  const requireProvider = (settings: SandboxJobSettings) =>
    resolveProvider(settings).pipe(
      Effect.flatMap((provider) =>
        provider === undefined
          ? Effect.fail(
              vmError("Add a boat key in Settings, Integrations, Sandbox jobs, to use boat VMs."),
            )
          : Effect.succeed(provider),
      ),
    );

  const onlyVms = (sandboxes: ReadonlyArray<SandboxInfo>) =>
    sandboxes.filter((sandbox) => sandbox.label.startsWith(BOAT_VM_LABEL_PREFIX));
  const listVms = (provider: SandboxProviderShape) => provider.list().pipe(Effect.map(onlyVms));

  const list: BoatVmService["Service"]["list"] = Effect.scoped(
    Effect.gen(function* () {
      const provider = yield* resolveProvider(yield* getSettings);
      if (provider === undefined) return { available: false, vms: [] };
      const sandboxes = yield* provider
        .list()
        .pipe(Effect.mapError((error) => vmError(error.message)));
      const vms = onlyVms(sandboxes);
      return {
        available: true,
        // Every live sandbox, so clients can tell a deleted VM from one made outside T3.
        sandboxIds: sandboxes
          .filter((sandbox) => sandbox.status !== "destroyed")
          .map((sandbox) => sandbox.ref.sandboxId),
        vms: vms.map((vm) => ({
          sandboxId: vm.ref.sandboxId,
          label: vm.label.slice(BOAT_VM_LABEL_PREFIX.length).trim() || vm.ref.sandboxId,
          status: vm.status,
        })),
      };
    }),
  ).pipe(
    Effect.tapError((error) => Effect.logWarning("boat.vm.list.failed", { error: error.message })),
    Effect.withSpan("BoatVmService.list"),
  );

  /** A new VM from the first available snapshot; bare VMs need an auth key. */
  const provision = Effect.fn("BoatVmService.provision")(function* (
    provider: SandboxProviderShape,
    settings: SandboxJobSettings,
    input: BoatVmLaunchInput,
  ) {
    const attempt = yield* crypto.randomUUIDv4();
    const repository = input.repository;
    const label = `${BOAT_VM_LABEL_PREFIX}${
      repository === undefined
        ? SCRATCH_VM_NAME
        : `${repository.owner === undefined ? "" : `${repository.owner}/`}${repository.name}`
    }`;
    const baseSnapshot = settings.boatVmBaseSnapshot.trim();
    const repositorySnapshot =
      repository === undefined ? undefined : boatVmSnapshotName(repository);
    const candidates = [
      ...(repositorySnapshot === undefined ? [] : [repositorySnapshot]),
      ...(baseSnapshot === "" || baseSnapshot === repositorySnapshot ? [] : [baseSnapshot]),
      // Only a tailnet join that the snapshot owns rules out a bare VM.
      ...(settings.boatVmConnectionMode === "tailscale" && settings.boatVmTailscale === "snapshot"
        ? []
        : [undefined]),
    ];
    for (const snapshot of candidates) {
      const result = yield* manager
        .provision({
          provider,
          target: {
            label,
            size: settings.boatVmSize,
            idleTimeoutMinutes: settings.boatVmIdleMinutes,
            t3Version,
            installAgentClis: true,
            ...(snapshot === undefined ? {} : { snapshot }),
          },
          // The keys arrive through `withLaunchEnv` on every start instead.
          env: {},
          idempotencyKey: `boat-vm:${attempt}:${snapshot ?? "bare"}`,
        })
        .pipe(
          Effect.map((bootstrap) => ({ bootstrap, label })),
          Effect.catchIf(
            (error) =>
              snapshot !== undefined &&
              error._tag === "SandboxEnvironmentError" &&
              error.stage === "create" &&
              error.failure === "not-found",
            () => Effect.succeed(undefined),
          ),
        );
      if (result !== undefined) {
        yield* Effect.logInfo("boat.vm.created", {
          sandboxId: result.bootstrap.ref.sandboxId,
          snapshot: snapshot ?? null,
        });
        return result;
      }
    }
    const wanted = [repositorySnapshot, baseSnapshot === "" ? undefined : baseSnapshot].filter(
      (name) => name !== undefined,
    );
    return yield* vmError(
      wanted.length === 0
        ? "No Boat snapshot was found. Set a Base snapshot with automatic Tailscale setup, or switch to a Tailscale auth key in Settings."
        : `No Boat snapshot was found. Create ${wanted.join(" or ")} with automatic Tailscale setup, or switch to a Tailscale auth key in Settings.`,
    );
  });

  // A new VM that never finished launching only bills; one picked to resume may
  // hold the user's work, so only the new one is removed.
  const discardFailedVm = Effect.fn("BoatVmService.discardFailedVm")(function* (created: {
    readonly provider: SandboxProviderShape;
    readonly ref: SandboxRef;
  }) {
    yield* created.provider
      .exec(created.ref, { script: TAILNET_LOGOUT_SCRIPT, timeoutMs: 20_000 })
      .pipe(Effect.ignore);
    yield* created.provider.destroy(created.ref).pipe(
      Effect.tap(() => Effect.logInfo("boat.vm.discarded", { sandboxId: created.ref.sandboxId })),
      Effect.catch((error) =>
        Effect.logWarning("boat.vm.discard.failed", {
          sandboxId: created.ref.sandboxId,
          error: error.message,
        }),
      ),
    );
  });

  const runLaunch = (
    input: BoatVmLaunchInput,
    report: (progress: Partial<BoatVmLaunches.BoatVmLaunchProgress>) => Effect.Effect<void>,
  ) => {
    let created: { readonly provider: SandboxProviderShape; readonly ref: SandboxRef } | undefined;
    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* getSettings;
        // A snapshot that joins itself still gets a saved key as its fallback.
        const tailscaleAuthKey =
          settings.boatVmTailscale === "off" ? "" : settings.tailscaleAuthKey.trim();
        const useSnapshotTailscale = settings.boatVmTailscale === "snapshot";
        const useBoatProxy = settings.boatVmConnectionMode === "boat";
        if (!useBoatProxy && settings.boatVmTailscale === "off") {
          return yield* vmError(
            "Boat VMs connect over Tailscale, but Tailscale is off. Choose an auth key or a snapshot that joins itself in Settings, Integrations, Boat VMs, Tailscale.",
          );
        }
        if (!useBoatProxy && !useSnapshotTailscale && tailscaleAuthKey === "") {
          return yield* vmError(
            "Add a Tailscale auth key in Settings, Integrations, Boat VMs, so boat VMs can join your tailnet.",
          );
        }
        const env = sandboxAgentEnvironment(settings);
        const launchScope = yield* Effect.scope;
        const boat = yield* requireProvider(settings);
        const baseProvider = withLaunchEnv(
          withTailnet(
            boat,
            tailscaleAuthKey,
            useSnapshotTailscale,
            launchScope,
            useBoatProxy ? "boat" : (input.transport ?? "https"),
          ),
          env,
        );
        const repository = input.repository;
        const syncRepository = Effect.fn("BoatVmService.syncRepository")(
          function* (ref: SandboxRef) {
            if (repository === undefined) {
              return yield* baseProvider.exec(ref, { script: SCRATCH_SCRIPT, timeoutMs: 20_000 });
            }
            // Serve and repository sync run together and each consumes its own env file.
            yield* baseProvider.writeFile(
              ref,
              SYNC_ENV_PATH,
              new TextEncoder().encode(formatSandboxLaunchEnv(env)),
            );
            return yield* baseProvider
              .exec(ref, {
                script: SYNC_SCRIPT,
                args: [boatVmCloneUrl(repository.remoteUrl), directoryName(repository.name)],
                timeoutMs: Number.POSITIVE_INFINITY,
              })
              .pipe(
                Effect.timeoutOrElse({
                  duration: Duration.millis(SCRIPT_TIMEOUT_MS),
                  orElse: () =>
                    Effect.fail(
                      new SandboxProviderError({
                        providerId: baseProvider.id,
                        operation: "exec",
                        failure: "timeout",
                      }),
                    ),
                }),
              );
          },
          (effect, ref) =>
            effect.pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit) || repository === undefined
                  ? Effect.void
                  : baseProvider
                      .exec(ref, {
                        script: 'rm -f "$HOME/.t3/boat-sync-env"',
                        timeoutMs: 10_000,
                      })
                      .pipe(Effect.timeoutOption(Duration.seconds(10)), Effect.ignore),
              ),
            ),
        );
        let syncFiber: Fiber.Fiber<SandboxExecResult, SandboxProviderError> | undefined;
        // The manager's steps reach boat through this provider, which is where
        // the launch's progress is visible without the manager knowing about it.
        const provider: SandboxProviderShape = {
          ...baseProvider,
          create: (create) =>
            report({ stage: "creating", detail: create.snapshot }).pipe(
              Effect.andThen(baseProvider.create(create)),
              Effect.tap((info) =>
                Effect.sync(() => {
                  // Recorded now so a launch interrupted before provision returns still removes it.
                  created = { provider: boat, ref: info.ref };
                }).pipe(Effect.andThen(report({ sandboxId: info.ref.sandboxId }))),
              ),
            ),
          exec: (ref, command) => {
            const kind = sandboxScriptKind(command.script);
            const stage = kind === "install" ? "installing" : kind === "launch" ? "starting" : null;
            return (stage === null ? Effect.void : report({ stage })).pipe(
              Effect.andThen(baseProvider.exec(ref, command)),
              Effect.tap((result) =>
                result.exitCode === 0 && syncFiber === undefined && kind === "install"
                  ? syncRepository(ref).pipe(
                      Effect.forkIn(launchScope),
                      Effect.tap((fiber) =>
                        Effect.sync(() => {
                          syncFiber = fiber;
                        }),
                      ),
                    )
                  : Effect.void,
              ),
            );
          },
          exposePort: (ref, port) =>
            (useBoatProxy || port !== T3_PORT ? Effect.void : report({ stage: "tailscale" })).pipe(
              Effect.andThen(baseProvider.exposePort(ref, port)),
            ),
        };

        let bootstrap: SandboxEnvironmentBootstrap;
        let label: string;
        if (input.sandboxId === undefined) {
          ({ bootstrap, label } = yield* provision(provider, settings, input).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                if (error._tag === "SandboxEnvironmentError" && error.ref !== undefined) {
                  created = { provider: boat, ref: error.ref };
                }
              }),
            ),
          ));
          created = { provider: boat, ref: bootstrap.ref };
        } else {
          const ref: SandboxRef = { providerId: "boat", sandboxId: input.sandboxId };
          yield* lifecycle.markLaunched(input.sandboxId);
          bootstrap = yield* manager.reconnect({ provider, ref, t3Version, resume: true });
          label = (yield* provider.get(ref)).label;
          // A resume keeps the old deadline, which may be minutes away.
          yield* provider.extendAutoStop?.(ref, settings.boatVmIdleMinutes) ?? Effect.void;
        }

        // Over the relay, the tailnet only gives the VM's ports and webhooks a direct
        // address, so a VM without one still launches.
        const tailnetFiber =
          useBoatProxy && (useSnapshotTailscale || tailscaleAuthKey !== "")
            ? yield* withTailnet(boat, tailscaleAuthKey, useSnapshotTailscale, launchScope, "http")
                .exposePort(bootstrap.ref, T3_PORT)
                .pipe(
                  Effect.map((exposed) => exposed.httpBaseUrl),
                  Effect.orElseSucceed(() => undefined),
                  Effect.forkIn(launchScope),
                )
            : undefined;
        yield* report({ stage: repository === undefined ? "preparing" : "syncing" });
        const sync = yield* syncFiber === undefined
          ? syncRepository(bootstrap.ref)
          : Fiber.join(syncFiber);
        const [workspaceRoot = "", syncState = ""] = sync.stdout.trim().split("\n");
        if (sync.exitCode !== 0 || workspaceRoot === "") {
          yield* Effect.logWarning("boat.vm.sync.failed", {
            sandboxId: bootstrap.ref.sandboxId,
            exitCode: sync.exitCode,
            stderr: sync.stderr.slice(-500),
          });
          return yield* vmError(
            repository === undefined
              ? "The VM could not prepare its scratch folder."
              : `The VM could not clone or pull ${repository.name}. Add a GitHub token in Settings, Integrations, Sandbox jobs, for a private repository.`,
          );
        }
        if (sync.stderr.trim() !== "") {
          yield* Effect.logWarning("boat.vm.sync.partial", {
            sandboxId: bootstrap.ref.sandboxId,
            stderr: sync.stderr.slice(-500),
          });
        }
        const warning =
          repository === undefined ? undefined : SYNC_WARNINGS[syncState]?.(repository.name);
        const proxyToken = useBoatProxy
          ? yield* boatProxy
              .register(bootstrap.ref.sandboxId, {
                httpBaseUrl: bootstrap.httpBaseUrl,
                headers: bootstrap.requestHeaders,
              })
              .pipe(
                Effect.mapError(() => vmError("Could not prepare the private Boat connection.")),
              )
          : undefined;
        const tailnetHttpBaseUrl =
          tailnetFiber === undefined
            ? undefined
            : yield* report({ stage: "tailscale" }).pipe(Effect.andThen(Fiber.join(tailnetFiber)));
        yield* lifecycle.markLaunched(bootstrap.ref.sandboxId);

        return {
          sandboxId: bootstrap.ref.sandboxId,
          label: label.startsWith(BOAT_VM_LABEL_PREFIX)
            ? label.slice(BOAT_VM_LABEL_PREFIX.length).trim() || bootstrap.ref.sandboxId
            : label,
          httpBaseUrl: bootstrap.httpBaseUrl,
          pairingCode: bootstrap.pairingToken,
          workspaceRoot,
          ...(proxyToken === undefined
            ? {}
            : {
                boatProxy: {
                  token: proxyToken,
                  ...(tailnetHttpBaseUrl === undefined ? {} : { tailnetHttpBaseUrl }),
                },
              }),
          ...(warning === undefined ? {} : { warning }),
        };
      }),
    ).pipe(
      // A cancelled launch is interrupted, and leaves a new VM behind just like a failed one.
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) || created === undefined ? Effect.void : discardFailedVm(created),
      ),
      Effect.mapError((error) =>
        error._tag === "BoatVmError"
          ? error
          : // The tailnet step is a boat VM's only exposed port; the manager's
            // generic "failed to publish the T3 port" would not say why.
            error._tag === "SandboxEnvironmentError" && error.stage === "expose"
            ? vmError(
                "The VM could not connect to Tailscale. Check its automatic Tailscale setup or auth key, and that HTTPS is on for the tailnet.",
              )
            : vmError(describe(error)),
      ),
      Effect.withSpan("BoatVmService.launch"),
    );
  };

  const launchTracker = yield* BoatVmLaunches.make(scope);

  const launch: BoatVmService["Service"]["launch"] = Effect.fn("BoatVmService.trackLaunch")(
    function* (input) {
      const launchId =
        input.launchId ??
        (yield* crypto
          .randomUUIDv4()
          .pipe(Effect.mapError(() => vmError("Could not start the boat VM launch."))));
      const began = yield* launchTracker.begin(
        launchId,
        input.repository?.name ?? SCRATCH_VM_NAME,
        input.sandboxId === undefined
          ? { stage: "creating" }
          : { stage: "resuming", sandboxId: input.sandboxId },
      );
      if (!began) return yield* vmError("This boat VM launch is already running.");
      // Its own fiber in the service's scope, so only Cancel interrupts the launch: a
      // client that disconnects stops waiting, but the VM still finishes starting.
      const fiber = yield* runLaunch(input, (progress) =>
        launchTracker.report(launchId, progress),
      ).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? launchTracker.finish(launchId, "done")
            : Cause.hasInterruptsOnly(exit.cause)
              ? launchTracker.finish(launchId, "cancelled")
              : launchTracker.finish(
                  launchId,
                  "failed",
                  Option.getOrUndefined(Exit.findErrorOption(exit))?.message ??
                    "The boat VM could not be prepared. See the server log.",
                ),
        ),
        Effect.forkIn(scope),
      );
      yield* launchTracker.attach(launchId, fiber);
      const exit = yield* Fiber.await(fiber);
      if (Exit.isSuccess(exit)) return exit.value;
      if (Cause.hasInterruptsOnly(exit.cause)) {
        return yield* vmError("The boat VM launch was cancelled.");
      }
      return yield* exit;
    },
  );

  const cancelLaunch: BoatVmService["Service"]["cancelLaunch"] = (input) =>
    launchTracker.cancel(input.launchId).pipe(Effect.map((applied) => ({ applied })));

  /** One VM checkout fetched into `repositoryRoot`; undefined for one with no commits. */
  const bringCheckoutHome = Effect.fn("BoatVmService.bringCheckoutHome")(function* (
    provider: SandboxProviderShape,
    ref: SandboxRef,
    directory: string,
    repositoryRoot: string,
  ) {
    const bundled = yield* provider.exec(ref, {
      script: BUNDLE_SCRIPT,
      args: [directory],
      timeoutMs: SCRIPT_TIMEOUT_MS,
    });
    if (bundled.exitCode === NO_COMMITS_EXIT_CODE) return undefined;
    const answer = BUNDLE_ANSWER.exec(bundled.stdout.trim());
    if (bundled.exitCode !== 0 || answer === null) {
      yield* Effect.logWarning("boat.vm.bringHome.bundle.failed", {
        sandboxId: ref.sandboxId,
        exitCode: bundled.exitCode,
        stderr: bundled.stderr.slice(-500),
      });
      return yield* vmError(`The VM could not bundle ${directory}.`);
    }
    const [, remoteBundle = "", detached, dirty] = answer;
    const bundle = yield* provider
      .readFile(ref, remoteBundle)
      .pipe(
        Effect.ensuring(
          provider
            .exec(ref, { script: REMOVE_BUNDLE_SCRIPT, args: [remoteBundle], timeoutMs: 60_000 })
            .pipe(Effect.ignore),
        ),
      );
    const staging = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3-boat-bring-home-" })
      .pipe(Effect.mapError(() => vmError("Could not stage the VM's work.")));
    const localBundle = path.join(staging, "vm.bundle");
    const refs = yield* fileSystem.writeFile(localBundle, bundle).pipe(
      Effect.andThen(
        importBranchesBundle({
          repositoryRoot,
          bundlePath: localBundle,
          refPrefix: boatVmRefPrefix(ref.sandboxId),
          includeHead: detached === "1",
        }),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.tapError((error) =>
        Effect.logWarning("boat.vm.bringHome.fetch.failed", {
          sandboxId: ref.sandboxId,
          repositoryRoot,
          error: error.message,
        }),
      ),
      Effect.mapError(() => vmError(`The VM's work could not be fetched into ${repositoryRoot}.`)),
    );
    const broughtHome: BoatVmBroughtHome = { repositoryRoot, refs, uncommitted: dirty === "1" };
    return broughtHome;
  });

  const bringHome: BoatVmService["Service"]["bringHome"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* getSettings;
        const provider = yield* requireProvider(settings);
        const ref: SandboxRef = { providerId: "boat", sandboxId: input.sandboxId };
        const vm = yield* provider.get(ref);
        if (!vm.label.startsWith(BOAT_VM_LABEL_PREFIX)) {
          return yield* vmError("That sandbox is not a boat VM T3 Code made.");
        }
        if (vm.status === "destroyed") {
          return yield* vmError("That boat VM no longer exists.");
        }
        // Only its disk is needed: no tailnet and no `t3 serve`.
        if (vm.status !== "running" && vm.status !== "creating") {
          yield* provider.resume(ref);
          yield* provider.extendAutoStop?.(ref, settings.boatVmIdleMinutes) ?? Effect.void;
        }

        const listed = yield* provider.exec(ref, { script: CHECKOUTS_SCRIPT, timeoutMs: 60_000 });
        const vmCheckouts = listed.stdout.split("\n").flatMap((line) => {
          const [directory = "", remoteUrl = ""] = line.split("\t");
          return CHECKOUT_DIRECTORY.test(directory) && remoteUrl.trim() !== ""
            ? [{ directory, remoteUrl: remoteUrl.trim() }]
            : [];
        });
        if (vmCheckouts.length === 0) {
          return yield* vmError("The VM has no repository checkout to bring home.");
        }
        const shells = yield* projects
          .listShells()
          .pipe(Effect.mapError(() => vmError("Could not read this environment's projects.")));

        const checkouts: Array<BoatVmBroughtHome> = [];
        const unmatched: Array<string> = [];
        for (const checkout of vmCheckouts) {
          const repositoryRoot = localCheckoutOf(shells, checkout.remoteUrl);
          if (repositoryRoot === undefined) {
            unmatched.push(checkout.directory);
            continue;
          }
          const broughtHome = yield* bringCheckoutHome(
            provider,
            ref,
            checkout.directory,
            repositoryRoot,
          );
          if (broughtHome !== undefined) checkouts.push(broughtHome);
        }

        if (checkouts.length === 0) {
          return yield* vmError(
            unmatched.length > 0
              ? `No project here is a checkout of ${unmatched.join(", ")}. Add the repository as a project on this machine first.`
              : "The VM has no commits to bring home.",
          );
        }
        const result: BoatVmBringHomeResult = { checkouts, unmatched };
        return result;
      }),
    ).pipe(
      Effect.mapError((error) => (error._tag === "BoatVmError" ? error : vmError(describe(error)))),
      Effect.withSpan("BoatVmService.bringHome"),
    );

  const keepAlive: BoatVmService["Service"]["keepAlive"] = Effect.scoped(
    Effect.gen(function* () {
      const settings = yield* getSettings;
      const provider = yield* resolveProvider(settings);
      if (provider === undefined) return;
      const extend = provider.extendAutoStop;
      const vms = yield* listVms(provider);
      const running = vms.filter((vm) => vm.status === "running");
      yield* Effect.forEach(
        running,
        (vm) =>
          lifecycle.apply(provider, vm.ref, settings.boatVmIdleMinutes).pipe(
            // A VM the lifecycle stopped or deleted must not get a new deadline.
            Effect.flatMap((outcome) =>
              outcome !== "kept" || extend === undefined
                ? Effect.void
                : provider
                    .exec(vm.ref, {
                      script: BUSY_SCRIPT,
                      args: [String(KEEP_ALIVE_INTERVAL_MINUTES + 1), busyPortArg(T3_PORT)],
                      timeoutMs: 60_000,
                    })
                    .pipe(
                      Effect.flatMap((result) =>
                        result.exitCode === 0
                          ? extend(vm.ref, settings.boatVmIdleMinutes)
                          : Effect.void,
                      ),
                    ),
            ),
            Effect.catch((error) =>
              Effect.logWarning("boat.vm.keepAlive.failed", {
                sandboxId: vm.ref.sandboxId,
                error: error.message,
              }),
            ),
          ),
        { concurrency: 4, discard: true },
      );
      yield* lifecycle
        .save(new Set(vms.filter((vm) => vm.status !== "destroyed").map((vm) => vm.ref.sandboxId)))
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("boat.vm.lifecycle.saveFailed", { error: String(error) }),
          ),
        );
    }),
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning("boat.vm.keepAlive.failed", { error: error.message }),
    ),
    Effect.withSpan("BoatVmService.keepAlive"),
  );

  if (options.keepAliveInterval !== null) {
    yield* Effect.forkIn(
      keepAlive.pipe(
        Effect.repeat(
          Schedule.spaced(options.keepAliveInterval ?? `${KEEP_ALIVE_INTERVAL_MINUTES} minutes`),
        ),
      ),
      scope,
    );
  }

  const catalogOperations = BoatCatalog.makeOperations(
    getSettings,
    options.resolveCatalog ?? BoatCatalog.resolveBoatCatalog,
  );

  return BoatVmService.of({
    list,
    launch,
    launches: launchTracker.stream,
    cancelLaunch,
    bringHome,
    keepAlive,
    ...catalogOperations,
  });
});

export const layer = (options: BoatVmServiceOptions = {}) =>
  Layer.effect(BoatVmService, make(options)).pipe(Layer.provide(SandboxEnvironmentManager.layer()));
