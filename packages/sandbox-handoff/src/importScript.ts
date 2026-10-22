/**
 * The POSIX `sh` script that turns an uploaded handoff into a checkout and
 * native transcripts inside a sandbox, run through `SandboxProviderShape.exec`.
 *
 * Restoring the work tree uses plumbing rather than `git stash apply`, so no
 * merge machinery runs: the branch is reset to the handoff's base, the work
 * tree is read from the handoff commit's tree, then the index is read from its
 * second parent. Staged, unstaged and untracked files come back exactly as
 * they were in the source, with no commit on the branch.
 *
 * The script is safe to run again: a target that already holds the bundle's
 * handoff commit skips the git steps, and transcripts are copied (never moved)
 * from their staged paths, so a retry after a failed placement finishes the
 * job. The caller removes the staging files once the script has succeeded.
 */
import { HandoffInvalidInputError, type HandoffProvider } from "./errors.ts";
import { HANDOFF_WIP_REF } from "./snapshot.ts";

/** Exit statuses the import script uses for failures a caller can name. */
export const SANDBOX_IMPORT_EXIT_CODES = {
  /** A path or branch the script was built with is unusable. */
  invalidInput: 64,
  /** The bundle is not a handoff bundle. */
  badBundle: 65,
  /** The bundle or a staged transcript is not where the script was told. */
  missingUpload: 66,
  /** git is not installed. */
  gitUnavailable: 69,
  /** The target exists with uncommitted work, or is a non-empty non-repository. */
  targetNotImportable: 73,
  /** The target repository lacks commits a thin bundle builds on. */
  missingPrerequisites: 74,
  /** The branch exists in the target with commits the handoff does not contain. */
  branchDiverged: 75,
} as const;

export interface SandboxTranscriptPlacement {
  readonly provider: HandoffProvider;
  /** Absolute path the (already rewritten) transcript was uploaded to. */
  readonly stagedPath: string;
  /** Destination relative to the provider home, from `sandboxTranscriptRelativePath`. */
  readonly relativePath: string;
  /**
   * The sandbox provider home. Defaults to `$CODEX_HOME` or `~/.codex` for
   * Codex and `$CLAUDE_CONFIG_DIR` or `~/.claude` for Claude, evaluated in
   * the sandbox.
   */
  readonly homePath?: string;
}

export interface SandboxImportScriptInput {
  /** Absolute path of the uploaded bundle in the sandbox. */
  readonly bundleRemotePath: string;
  /** Branch to check out at the handoff's base commit. */
  readonly branchName: string;
  /**
   * Absolute, canonical path of the checkout. It may be missing or empty (a
   * new repository is made), or an existing clean clone of the same project
   * (needed for a bundle made with `excludeReachableFrom`).
   */
  readonly targetCwd: string;
  readonly transcripts?: ReadonlyArray<SandboxTranscriptPlacement>;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// oxlint-disable-next-line no-control-regex -- control characters are exactly what is refused.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export function absolutePath(field: string, value: string): string {
  const segments = value.split("/").slice(1);
  if (
    !value.startsWith("/") ||
    value === "/" ||
    CONTROL_CHARACTER.test(value) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new HandoffInvalidInputError({
      field,
      reason: `'${value}' must be a normalized absolute path`,
    });
  }
  return value;
}

function relativePath(field: string, value: string): string {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    CONTROL_CHARACTER.test(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new HandoffInvalidInputError({
      field,
      reason: `'${value}' must be a relative path without '.' or '..' segments`,
    });
  }
  return value;
}

// The script repeats this with `git check-ref-format --branch`; this catches
// what would break the script before it reaches git.
function branchName(value: string): string {
  if (
    value.length === 0 ||
    value.startsWith("-") ||
    CONTROL_CHARACTER.test(value) ||
    /[\s~^:?*[\\]|\.\.|@\{/.test(value)
  ) {
    throw new HandoffInvalidInputError({
      field: "branchName",
      reason: `'${value}' is not a branch name`,
    });
  }
  return value;
}

const CODES = SANDBOX_IMPORT_EXIT_CODES;

const SCRIPT_HEAD = `# t3-sandbox-script: handoff-import
set -eu
t3_fail() {
  printf '%s\\n' "$2" >&2
  exit "$1"
}
command -v git >/dev/null 2>&1 || t3_fail ${CODES.gitUnavailable} 'git is not installed in the sandbox.'
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
GIT_TERMINAL_PROMPT=0
export GIT_TERMINAL_PROMPT
# Restoring must not run repository hooks (post-checkout, reference-transaction).
t3_git() {
  git -c core.hooksPath=/dev/null "$@"
}`;

const SCRIPT_GIT = `[ -f "$T3_BUNDLE" ] || t3_fail ${CODES.missingUpload} "No bundle at $T3_BUNDLE."
git check-ref-format --branch "$T3_BRANCH" >/dev/null 2>&1 ||
  t3_fail ${CODES.invalidInput} "'$T3_BRANCH' is not a valid branch name."
T3_WIP="$(git bundle list-heads "$T3_BUNDLE" "$T3_WIP_REF" 2>/dev/null | cut -d ' ' -f 1)"
[ -n "$T3_WIP" ] || t3_fail ${CODES.badBundle} "$T3_BUNDLE does not carry $T3_WIP_REF."

T3_ALREADY=false
T3_INIT=false
if [ -e "$T3_TARGET/.git" ]; then
  T3_TOP="$(git -C "$T3_TARGET" rev-parse --show-toplevel 2>/dev/null)" ||
    t3_fail ${CODES.targetNotImportable} "$T3_TARGET has a .git entry git cannot open."
  [ "$T3_TOP" = "$(cd "$T3_TARGET" && pwd -P)" ] ||
    t3_fail ${CODES.targetNotImportable} "$T3_TARGET is inside the repository at $T3_TOP, not its top."
  if [ "$(git -C "$T3_TARGET" rev-parse -q --verify "$T3_WIP_REF" 2>/dev/null || true)" = "$T3_WIP" ]; then
    T3_ALREADY=true
  elif [ -n "$(git -C "$T3_TARGET" status --porcelain --untracked-files=all)" ]; then
    t3_fail ${CODES.targetNotImportable} "$T3_TARGET has uncommitted changes; refusing to replace them."
  fi
elif [ -d "$T3_TARGET" ] && [ -n "$(ls -A "$T3_TARGET")" ]; then
  t3_fail ${CODES.targetNotImportable} "$T3_TARGET is not empty and is not a git repository."
else
  mkdir -p "$T3_TARGET"
  T3_INIT=true
fi
cd "$T3_TARGET"`;

// Runs after the canonical-target check, so a refused target is left as it was.
const SCRIPT_INIT = `if [ "$T3_INIT" = true ]; then
  # A 64-digit id means the source repository uses SHA-256 objects.
  if [ "\${#T3_WIP}" -eq 64 ]; then
    t3_git init -q --object-format=sha256 .
  else
    t3_git init -q .
  fi
fi`;

const SCRIPT_CANONICAL_TARGET = `# Claude files sessions under the canonical cwd, so a symlinked target would
# put the transcript where the CLI never looks.
T3_REAL_TARGET="$(pwd -P)"
[ "$T3_REAL_TARGET" = "$T3_TARGET" ] ||
  t3_fail ${CODES.invalidInput} "$T3_TARGET resolves to $T3_REAL_TARGET; pass the canonical path."`;

const SCRIPT_RESTORE = `if [ "$T3_ALREADY" = false ]; then
  if ! T3_VERIFY="$(git bundle verify "$T3_BUNDLE" 2>&1)"; then
    printf '%s\\n' "$T3_VERIFY" >&2
    t3_fail ${CODES.missingPrerequisites} "This repository lacks commits the bundle builds on; fetch them or send a full bundle."
  fi
  t3_git fetch -q --no-tags "$T3_BUNDLE" "+$T3_WIP_REF:$T3_WIP_REF"
  T3_BASE="$(git rev-parse --verify "$T3_WIP^1")"
  if T3_EXISTING="$(git rev-parse -q --verify "refs/heads/$T3_BRANCH")"; then
    git merge-base --is-ancestor "$T3_EXISTING" "$T3_BASE" ||
      t3_fail ${CODES.branchDiverged} "Branch $T3_BRANCH already exists here with commits the handoff does not contain."
  fi
  t3_git checkout -q -B "$T3_BRANCH" "$T3_BASE"
  # Work tree from the handoff commit (deleting what it deleted), then the
  # index from its second parent; files only in the work tree end up untracked.
  t3_git read-tree --reset -u "$T3_WIP^{tree}"
  t3_git read-tree "$T3_WIP^2^{tree}"
  git update-index -q --refresh >/dev/null 2>&1 || true
fi`;

const SCRIPT_TRANSCRIPT_HELPERS = `if [ -z "\${HOME:-}" ]; then
  HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
  [ -n "$HOME" ] || t3_fail ${CODES.invalidInput} 'Cannot determine the home directory of the sandbox user.'
  export HOME
fi
T3_CODEX_HOME="\${CODEX_HOME:-$HOME/.codex}"
T3_CLAUDE_HOME="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
# Transcripts hold the whole conversation, tool output included. Directories
# this creates (a provider home the sandbox never had, say) and every copy are
# private from the moment they exist, not only once chmod runs.
umask 077
t3_place() {
  [ -f "$1" ] || t3_fail ${CODES.missingUpload} "No staged transcript at $1."
  mkdir -p "$(dirname "$2")"
  cp "$1" "$2.t3-import.$$"
  chmod 600 "$2.t3-import.$$"
  mv -f "$2.t3-import.$$" "$2"
}`;

const SCRIPT_RESULT = `printf '{"alreadyImported":%s,"head":"%s","handoffCommit":"%s"}\\n' "$T3_ALREADY" "$(git rev-parse HEAD)" "$T3_WIP"`;

/**
 * Builds the import script. Every value is single-quoted into it, so nothing
 * the caller passes is parsed by the shell. Inputs are validated first and
 * an unusable one throws `HandoffInvalidInputError`.
 *
 * On success the script prints one JSON line,
 * `{"alreadyImported":bool,"head":sha,"handoffCommit":sha}`; failures exit
 * with a `SANDBOX_IMPORT_EXIT_CODES` status and a message on stderr.
 */
export function buildSandboxImportScript(input: SandboxImportScriptInput): string {
  const bundle = absolutePath("bundleRemotePath", input.bundleRemotePath);
  const target = absolutePath("targetCwd", input.targetCwd);
  const branch = branchName(input.branchName);
  const transcripts = (input.transcripts ?? []).map((transcript, index) => {
    const staged = absolutePath(`transcripts[${index}].stagedPath`, transcript.stagedPath);
    const relative = relativePath(`transcripts[${index}].relativePath`, transcript.relativePath);
    const home =
      transcript.homePath === undefined
        ? transcript.provider === "codex"
          ? '"$T3_CODEX_HOME"'
          : '"$T3_CLAUDE_HOME"'
        : shellQuote(absolutePath(`transcripts[${index}].homePath`, transcript.homePath));
    return `t3_place ${shellQuote(staged)} ${home}/${shellQuote(relative)}`;
  });
  const hasClaude = (input.transcripts ?? []).some(
    (transcript) => transcript.provider === "claude",
  );

  return [
    SCRIPT_HEAD,
    `T3_BUNDLE=${shellQuote(bundle)}`,
    `T3_BRANCH=${shellQuote(branch)}`,
    `T3_TARGET=${shellQuote(target)}`,
    `T3_WIP_REF=${shellQuote(HANDOFF_WIP_REF)}`,
    SCRIPT_GIT,
    ...(hasClaude ? [SCRIPT_CANONICAL_TARGET] : []),
    SCRIPT_INIT,
    SCRIPT_RESTORE,
    ...(transcripts.length > 0 ? [SCRIPT_TRANSCRIPT_HELPERS, ...transcripts] : []),
    SCRIPT_RESULT,
    "",
  ].join("\n");
}
