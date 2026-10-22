/**
 * How a script reaches a boat sandbox byte-exact.
 *
 * boat's command endpoint takes one command string, runs it through the
 * sandbox's shell with no stdin, and returns stdout and stderr apart. So the
 * script and every argument travel base64-encoded as arguments of one fixed
 * `sh -c` wrapper: the only text any shell parses is the wrapper itself, which
 * decodes the script into a temp file, rebuilds "$@" from the decoded
 * arguments and runs the script under POSIX `sh`.
 *
 * boat keeps every command string (and, with monitoring on, its output) in
 * its 90-day command history, so base64 is transport, not secrecy: scripts
 * and args must not carry secrets, as the contract already requires.
 */
import * as Base64 from "effect/encoding/Base64";

/** Exit status of a wrapper that failed before the script ran (no temp dir, undecodable payload). */
export const BOAT_WRAPPER_FAILURE_EXIT_CODE = 125;

/** `$0` of the exec wrapper. */
const BOAT_EXEC_ARGV0 = "t3-sandbox-exec";

/** `$0` of the background wrapper. */
const BOAT_BACKGROUND_ARGV0 = "t3-sandbox-background";

const FAIL = `exit ${BOAT_WRAPPER_FAILURE_EXIT_CODE}`;

/**
 * Decodes the script (`$1`) into a temp dir that goes when the wrapper exits,
 * rebuilds "$@" from the decoded args (`$2`...; the `x` sentinel keeps
 * trailing newlines), and runs the script under `sh`. `hup` is the HUP trap.
 */
const runScript = (hup: string) => `t3_dir="$(mktemp -d)" || ${FAIL}
trap "rm -rf \\"$t3_dir\\"" EXIT
trap ${hup} HUP
trap "exit 130" INT
trap "exit 143" TERM
printf "%s" "$1" | base64 -d >"$t3_dir/script" || ${FAIL}
shift
t3_count=$#
while [ "$t3_count" -gt 0 ]; do
  t3_arg="$(printf "%s" "$1" | base64 -d && printf x)" || ${FAIL}
  shift
  set -- "$@" "\${t3_arg%x}"
  t3_count=$((t3_count - 1))
done
sh "$t3_dir/script" "$@" </dev/null
exit $?`;

/**
 * Runs as `sh -c WRAPPER t3-sandbox-exec SCRIPT_B64 [ARG_B64...]`. It is
 * single-quoted into the command, so it must never contain a single quote.
 * Exit status 125 means the wrapper itself failed; otherwise it exits with the
 * script's status. The temp dir also goes when a stopped command is sent
 * SIGTERM.
 */
const EXEC_WRAPPER = runScript(`"exit 129"`);

/**
 * Runs as `sh -c WRAPPER t3-sandbox-background LOG_B64 SCRIPT_B64 [ARG_B64...]`
 * under a detached command. Before anything else it points its own stdout and
 * stderr at the log (appending; created 0600 if new, its directory created
 * first) and stdin at /dev/null, so even its own failures land there and
 * nothing reaches boat's per-process log or command history. A log path of
 * `~` or `~/...` is resolved against the sandbox user's home: a `~` that
 * arrives as data is never expanded by a redirection. HUP is ignored, as under
 * `nohup`, and the ignore is inherited by the script.
 */
const BACKGROUND_WRAPPER = `t3_log="$(printf "%s" "$1" | base64 -d && printf x)" || ${FAIL}
t3_log="\${t3_log%x}"
shift
case "$t3_log" in
  "~" | "~/"*)
    [ -n "\${HOME:-}" ] || HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
    [ -n "$HOME" ] || ${FAIL}
    t3_log="$HOME\${t3_log#?}"
    ;;
esac
case "$t3_log" in
  */*) t3_log_dir="\${t3_log%/*}" ;;
  *) t3_log_dir=. ;;
esac
mkdir -p -- "\${t3_log_dir:-/}" || ${FAIL}
(umask 077 && : >>"$t3_log") || ${FAIL}
exec >>"$t3_log" 2>&1 </dev/null
${runScript(`""`)}`;

/**
 * The sandbox shell receives the whole command as one argument, and Linux caps
 * one argv string at 128 KiB (MAX_ARG_STRLEN). Bootstrap scripts are around
 * 20 KB; anything near the cap is refused up front rather than failing inside
 * the sandbox with an opaque E2BIG. The command is ASCII, so its length is its
 * byte count.
 */
export const MAX_BOAT_EXEC_COMMAND_LENGTH = 120_000;

/** boat rejects a synchronous command `timeoutSeconds` outside 1-600. */
export const MAX_BOAT_SYNC_TIMEOUT_SECONDS = 600;

const singleQuote = (value: string) => `'${value}'`;

const encodedArgs = (args: ReadonlyArray<string> | undefined) =>
  (args ?? []).map((arg) => singleQuote(Base64.encode(arg)));

/**
 * The command string for boat's command endpoint. Every quoted token is either
 * the fixed wrapper or base64 text, so no shell ever interprets script or
 * argument bytes.
 */
export function buildBoatExecCommand(input: {
  readonly script: string;
  readonly args?: ReadonlyArray<string> | undefined;
}): string {
  return [
    "sh",
    "-c",
    singleQuote(EXEC_WRAPPER),
    BOAT_EXEC_ARGV0,
    singleQuote(Base64.encode(input.script)),
    ...encodedArgs(input.args),
  ].join(" ");
}

/** The command string that starts `script` detached with its output in `logPath`. */
export function buildBoatBackgroundCommand(input: {
  readonly script: string;
  readonly args?: ReadonlyArray<string> | undefined;
  readonly logPath: string;
}): string {
  return [
    "sh",
    "-c",
    singleQuote(BACKGROUND_WRAPPER),
    BOAT_BACKGROUND_ARGV0,
    singleQuote(Base64.encode(input.logPath)),
    singleQuote(Base64.encode(input.script)),
    ...encodedArgs(input.args),
  ].join(" ");
}

/**
 * How an exec runs: synchronously with boat's own timeout (whole seconds,
 * rounded up so a short limit never becomes none), or detached and polled when
 * the budget is beyond what a synchronous command allows or unlimited
 * (+Infinity). NaN is no budget at all and is refused.
 */
export type BoatExecPlan =
  | { readonly _tag: "Sync"; readonly timeoutSeconds: number }
  | { readonly _tag: "Detached"; readonly timeoutMs: number | undefined }
  | { readonly _tag: "Invalid" };

export function boatExecPlan(timeoutMs: number): BoatExecPlan {
  if (Number.isNaN(timeoutMs)) {
    return { _tag: "Invalid" };
  }
  if (timeoutMs === Number.POSITIVE_INFINITY) {
    return { _tag: "Detached", timeoutMs: undefined };
  }
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return timeoutSeconds <= MAX_BOAT_SYNC_TIMEOUT_SECONDS
    ? { _tag: "Sync", timeoutSeconds }
    : { _tag: "Detached", timeoutMs };
}

const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

/**
 * The shell-style exit status of a command boat reports without one: killed by
 * a signal (128 + its number on Linux), or by the memory ceiling (SIGKILL).
 * `undefined` when boat gives no reason the status can be derived from.
 */
export function boatExitCode(result: {
  readonly exitCode: number | null;
  readonly signal?: string | null | undefined;
  readonly oomKilled?: boolean | undefined;
}): number | undefined {
  if (result.exitCode !== null && Number.isInteger(result.exitCode)) {
    return result.exitCode;
  }
  if (result.oomKilled === true) {
    return 128 + 9;
  }
  if (typeof result.signal === "string") {
    const name = result.signal.toUpperCase();
    const number = SIGNAL_NUMBERS[name.startsWith("SIG") ? name : `SIG${name}`];
    return number === undefined ? undefined : 128 + number;
  }
  return undefined;
}
