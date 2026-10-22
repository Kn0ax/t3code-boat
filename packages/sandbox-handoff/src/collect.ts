/**
 * Bringing a sandbox node's work back: a script that commits what the node
 * changed and writes it as a bundle thin against the commit the node started
 * from, and the local fetch that files that bundle under a ref without
 * touching the user's work tree, index or branches.
 *
 * @module sandbox-handoff/collect
 */
import * as Effect from "effect/Effect";

import { HandoffInvalidInputError } from "./errors.ts";
import { firstLine, runGit } from "./git.ts";
import { absolutePath, shellQuote } from "./importScript.ts";

const COMMIT_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// Only refs this module files results under, so a caller cannot overwrite a branch.
const RESULT_REF = /^refs\/t3\/sandbox\/[A-Za-z0-9._-]+$/;

export interface SandboxCollectScriptInput {
  /** The node's checkout. */
  readonly targetCwd: string;
  /** The commit the node's work started from; the local repository has it. */
  readonly baseCommit: string;
  /** Where the bundle is written in the node. */
  readonly bundleRemotePath: string;
  readonly commitMessage: string;
}

/**
 * Commits every change in the node's checkout (hooks off, a fixed identity),
 * then bundles `baseCommit..HEAD` when HEAD moved. Prints one JSON line,
 * `{"head":sha,"changed":bool}`; no bundle is written when nothing changed.
 */
export function buildSandboxCollectScript(input: SandboxCollectScriptInput): string {
  const target = absolutePath("targetCwd", input.targetCwd);
  const bundle = absolutePath("bundleRemotePath", input.bundleRemotePath);
  if (!COMMIT_SHA.test(input.baseCommit)) {
    throw new HandoffInvalidInputError({ field: "baseCommit", reason: "must be a full commit id" });
  }
  return [
    "# t3-sandbox-script: handoff-collect",
    "set -eu",
    "unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_TERMINAL_PROMPT=0",
    "export GIT_TERMINAL_PROMPT",
    "t3_git() {",
    "  git -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name='T3 Code' -c user.email='t3code@localhost' \"$@\"",
    "}",
    `cd ${shellQuote(target)}`,
    "t3_git add --all",
    "if ! t3_git diff --cached --quiet; then",
    `  t3_git commit --quiet --no-verify -m ${shellQuote(input.commitMessage)}`,
    "fi",
    'T3_HEAD="$(t3_git rev-parse HEAD)"',
    `if [ "$T3_HEAD" = ${shellQuote(input.baseCommit)} ]; then`,
    `  printf '{"head":"%s","changed":false}\\n' "$T3_HEAD"`,
    "  exit 0",
    "fi",
    `rm -f ${shellQuote(bundle)}`,
    `t3_git bundle create --quiet ${shellQuote(bundle)} ${shellQuote(`${input.baseCommit}..HEAD`)}`,
    `printf '{"head":"%s","changed":true}\\n' "$T3_HEAD"`,
    "",
  ].join("\n");
}

// A per-machine namespace, so fetching one machine's branches never touches a branch.
const BRANCHES_REF_PREFIX = /^refs\/t3\/boat\/[A-Za-z0-9._-]+\/$/;

/**
 * Mirrors a bundle's branches (and `HEAD`, for a detached checkout) under
 * `refPrefix` in the repository at `repositoryRoot`, dropping refs there whose
 * branch is gone, and returns the refs it holds afterwards. The work tree,
 * index and branches are left alone.
 */
export const importBranchesBundle = Effect.fn("sandboxHandoff.importBranchesBundle")(
  function* (input: {
    readonly repositoryRoot: string;
    readonly bundlePath: string;
    readonly refPrefix: string;
    readonly includeHead: boolean;
  }) {
    if (!BRANCHES_REF_PREFIX.test(input.refPrefix)) {
      return yield* new HandoffInvalidInputError({
        field: "refPrefix",
        reason: "must be refs/t3/boat/<id>/",
      });
    }
    yield* runGit({
      step: "fetch:branches-bundle",
      cwd: input.repositoryRoot,
      args: [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        "--prune",
        input.bundlePath,
        `+refs/heads/*:${input.refPrefix}*`,
        ...(input.includeHead ? [`+HEAD:${input.refPrefix}HEAD`] : []),
      ],
    });
    const listed = yield* runGit({
      step: "for-each-ref:branches",
      cwd: input.repositoryRoot,
      args: ["for-each-ref", "--format=%(refname)", input.refPrefix],
    });
    return listed.stdout.split("\n").filter((line) => line.length > 0);
  },
);

/**
 * Files a collected bundle's HEAD under `ref` (a `refs/t3/sandbox/...` ref)
 * in the repository at `repositoryRoot` and returns the commit it points at.
 */
export const importCollectedBundle = Effect.fn("sandboxHandoff.importCollectedBundle")(
  function* (input: {
    readonly repositoryRoot: string;
    readonly bundlePath: string;
    readonly ref: string;
  }) {
    if (!RESULT_REF.test(input.ref)) {
      return yield* new HandoffInvalidInputError({
        field: "ref",
        reason: "must be under refs/t3/sandbox/",
      });
    }
    yield* runGit({
      step: "fetch:collected-bundle",
      cwd: input.repositoryRoot,
      args: [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        input.bundlePath,
        `+HEAD:${input.ref}`,
      ],
    });
    const resolved = yield* runGit({
      step: "rev-parse:collected",
      cwd: input.repositoryRoot,
      args: ["rev-parse", "--verify", `${input.ref}^{commit}`],
    });
    return firstLine(resolved.stdout);
  },
);
