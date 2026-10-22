/**
 * Captures a work tree so it can continue in another environment.
 *
 * The snapshot is one commit shaped like a `git stash` entry: its tree is the
 * whole work tree (tracked changes plus untracked files that are not ignored),
 * its first parent is HEAD and its second parent is a commit of the index, so
 * the receiving side can restore staged and unstaged changes separately
 * (`buildSandboxImportScript`). It travels as a git bundle carrying one ref,
 * `HANDOFF_WIP_REF`.
 *
 * Nothing in the user's repository changes, not even an object's mtime.
 * Index work happens on copies of the index (GIT_INDEX_FILE), and every
 * object the snapshot writes (blobs for changed and untracked files, trees,
 * the two commits) goes to a scratch bare repository through
 * GIT_OBJECT_DIRECTORY. The bundle is created from that scratch repository,
 * which reads the user's objects as an alternate, so the user's refs, reflogs
 * and object store are only read.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import {
  HandoffFileSystemError,
  HandoffGitCommandError,
  HandoffInvalidInputError,
  HandoffNotAWorkTreeError,
  HandoffRevisionNotFoundError,
  HandoffUnbornHeadError,
  HandoffUnmergedPathsError,
} from "./errors.ts";
import { firstLine, runGit, stderrTail } from "./git.ts";

/** The only ref a handoff bundle carries. */
export const HANDOFF_WIP_REF = "refs/t3/handoff/wip";

// The checkpoint commits in apps/server/src/vcs/GitVcsDriver.ts use the same
// identity. Setting it also keeps commit-tree working where user.email is unset.
const HANDOFF_IDENTITY = {
  GIT_AUTHOR_NAME: "T3 Code",
  GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
  GIT_COMMITTER_NAME: "T3 Code",
  GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
};

// For commands that load an index copy. An fsmonitor daemon answers for the
// real index, not the copy; split-index writes would add a shared index file
// to the user's git directory; the sparse setting matches the checkpoint code.
const INDEX_COPY_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.splitIndex=false",
  "-c",
  "sparse.expectFilesOutsideOfPatterns=false",
] as const;

export interface WorkspaceSnapshotInput {
  /** Absolute path inside the work tree to capture (a linked worktree is fine). */
  readonly cwd: string;
  /**
   * Absolute path to write the bundle to. Defaults to `workspace.bundle` in a
   * new temporary directory, which the caller removes once it is uploaded.
   */
  readonly bundlePath?: string;
  /**
   * Revisions the receiving repository already has, such as the remote
   * branches a sandbox clone was made from. Commits reachable from them are
   * left out of the bundle, which then needs them as prerequisites. Omitted,
   * the bundle carries the full history and can seed an empty repository.
   */
  readonly excludeReachableFrom?: ReadonlyArray<string>;
}

export interface WorkspaceSnapshot {
  readonly bundlePath: string;
  /** The handoff commit: work tree contents, parents `[baseCommitSha, indexCommitSha]`. */
  readonly commitSha: string;
  /** The index (staged changes), parent `baseCommitSha`. */
  readonly indexCommitSha: string;
  /** HEAD when the snapshot was taken. */
  readonly baseCommitSha: string;
  /** The checked-out branch, or null on a detached HEAD. */
  readonly branchName: string | null;
  /** Top of the work tree the snapshot was taken from. */
  readonly repositoryRoot: string;
  /** False when neither the index nor the work tree differ from HEAD. */
  readonly hasChanges: boolean;
  /** Commits `excludeReachableFrom` resolved to; the receiver must have them. */
  readonly excludedCommitShas: ReadonlyArray<string>;
}

const fileSystemError =
  (operation: HandoffFileSystemError["operation"], path: string) =>
  (cause: PlatformError.PlatformError) =>
    new HandoffFileSystemError({ operation, path, cause });

const NOT_A_WORK_TREE_PATTERN = /not a git repository|must be run in a work tree/i;

export const snapshotWorkspace = Effect.fn("sandboxHandoff.snapshotWorkspace")(function* (
  input: WorkspaceSnapshotInput,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(input.cwd)) {
    return yield* new HandoffInvalidInputError({ field: "cwd", reason: "must be absolute" });
  }
  if (input.bundlePath !== undefined && !path.isAbsolute(input.bundlePath)) {
    return yield* new HandoffInvalidInputError({ field: "bundlePath", reason: "must be absolute" });
  }

  const toplevelResult = yield* runGit({
    step: "rev-parse:toplevel",
    cwd: input.cwd,
    args: ["rev-parse", "--show-toplevel"],
    allowedExitCodes: [128],
  });
  if (toplevelResult.exitCode !== 0) {
    if (NOT_A_WORK_TREE_PATTERN.test(toplevelResult.stderr)) {
      return yield* new HandoffNotAWorkTreeError({ cwd: input.cwd });
    }
    const stderr = stderrTail(toplevelResult.stderr);
    return yield* new HandoffGitCommandError({
      step: "rev-parse:toplevel",
      cwd: input.cwd,
      exitCode: toplevelResult.exitCode,
      ...(stderr === undefined ? {} : { stderr }),
    });
  }
  const repositoryRoot = firstLine(toplevelResult.stdout);
  const git = (
    step: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly env?: Readonly<Record<string, string>>;
      readonly allowedExitCodes?: ReadonlyArray<number>;
    },
  ) => runGit({ step, cwd: repositoryRoot, args, ...options });

  const head = yield* git("rev-parse:head", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    allowedExitCodes: [1],
  });
  if (head.exitCode !== 0) {
    return yield* new HandoffUnbornHeadError({ cwd: repositoryRoot });
  }
  const baseCommitSha = firstLine(head.stdout);
  const baseTreeSha = firstLine(
    (yield* git("rev-parse:head-tree", ["rev-parse", "--verify", `${baseCommitSha}^{tree}`]))
      .stdout,
  );
  const branch = yield* git("symbolic-ref", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    allowedExitCodes: [1],
  });
  const branchName = branch.exitCode === 0 ? firstLine(branch.stdout) : null;

  // Paths relative to the work tree root; a linked worktree reports its own
  // index and the common object directory.
  const [indexGitPath = "", objectsGitPath = ""] = (yield* git("rev-parse:git-paths", [
    "rev-parse",
    "--git-path",
    "index",
    "--git-path",
    "objects",
  ])).stdout.split("\n");
  const indexPath = path.resolve(repositoryRoot, indexGitPath);
  const objectsPath = path.resolve(repositoryRoot, objectsGitPath);
  // Older git echoes an unknown rev-parse flag back, so only an exact answer counts.
  const objectFormat = firstLine(
    (yield* git("rev-parse:object-format", ["rev-parse", "--show-object-format"], {
      allowedExitCodes: [128, 129],
    })).stdout,
  );

  const excludedCommitShas: Array<string> = [];
  for (const revision of input.excludeReachableFrom ?? []) {
    if (revision.length === 0 || revision.startsWith("-")) {
      return yield* new HandoffInvalidInputError({
        field: "excludeReachableFrom",
        reason: `'${revision}' is not a revision`,
      });
    }
    const resolved = yield* git(
      "rev-parse:exclude",
      ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`],
      { allowedExitCodes: [1] },
    );
    if (resolved.exitCode !== 0) {
      return yield* new HandoffRevisionNotFoundError({ cwd: repositoryRoot, revision });
    }
    const sha = firstLine(resolved.stdout);
    if (!excludedCommitShas.includes(sha)) excludedCommitShas.push(sha);
  }

  const ownedBundleDirectory =
    input.bundlePath === undefined
      ? yield* fileSystem
          .makeTempDirectory({ prefix: "t3-handoff-" })
          .pipe(Effect.mapError(fileSystemError("makeTempDirectory", "t3-handoff-")))
      : undefined;
  const bundlePath = input.bundlePath ?? path.join(ownedBundleDirectory ?? "", "workspace.bundle");

  const capture = Effect.gen(function* () {
    const scratch = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3-handoff-snapshot-" })
      .pipe(Effect.mapError(fileSystemError("makeTempDirectory", "t3-handoff-snapshot-")));
    const scratchRepository = path.join(scratch, "objects.git");
    const scratchObjects = path.join(scratchRepository, "objects");
    // An explicit --git-dir keeps `safe.bareRepository=explicit` setups working.
    const scratchGit = (step: string, args: ReadonlyArray<string>) =>
      runGit({ step, cwd: scratch, args: [`--git-dir=${scratchRepository}`, ...args] });

    yield* runGit({
      step: "init:scratch",
      cwd: scratch,
      args: [
        "-c",
        "init.defaultBranch=handoff",
        "init",
        "--quiet",
        "--bare",
        ...(objectFormat === "sha1" || objectFormat === "sha256"
          ? [`--object-format=${objectFormat}`]
          : []),
        scratchRepository,
      ],
    });
    const stagedIndex = path.join(scratch, "index-staged");
    const workTreeIndex = path.join(scratch, "index-worktree");
    const indexInfo = yield* fileSystem.stat(indexPath).pipe(
      Effect.asSome,
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed(Option.none<FileSystem.File.Info>()),
      ),
      Effect.mapError(fileSystemError("stat", indexPath)),
    );
    // No index file means an empty index (a `--no-checkout` clone); git reads
    // a missing GIT_INDEX_FILE the same way, so there is nothing to copy.
    if (Option.isSome(indexInfo)) {
      // Git trusts an entry's stat data only when the entry is older than the
      // index file. A copy is newer than the original, so changes made in the
      // same second as the last index write would look clean; backdating the
      // copies keeps git's racy-entry check (same as captureCheckpoint).
      const indexTime = Option.match(indexInfo.value.mtime, {
        onNone: () => 0,
        onSome: (mtime) => Math.floor((mtime.getTime() - 1) / 1000),
      });
      for (const copy of [stagedIndex, workTreeIndex]) {
        yield* fileSystem
          .copyFile(indexPath, copy)
          .pipe(Effect.mapError(fileSystemError("copyFile", copy)));
        if (indexTime > 0) {
          yield* fileSystem
            .utimes(copy, indexTime, indexTime)
            .pipe(Effect.mapError(fileSystemError("utimes", copy)));
        }
      }
    }

    // Partial clones would otherwise fetch missing objects on demand.
    const objectEnv = { GIT_OBJECT_DIRECTORY: scratchObjects, GIT_NO_LAZY_FETCH: "1" };
    const stagedEnv = { ...objectEnv, GIT_INDEX_FILE: stagedIndex };
    const workTreeEnv = { ...objectEnv, GIT_INDEX_FILE: workTreeIndex };

    const unmerged = yield* git("ls-files:unmerged", ["ls-files", "--unmerged", "-z"], {
      env: stagedEnv,
    });
    if (unmerged.stdout.length > 0) {
      const paths = new Set(
        unmerged.stdout
          .split("\0")
          .filter((record) => record.length > 0)
          .map((record) => record.slice(record.indexOf("\t") + 1)),
      );
      return yield* new HandoffUnmergedPathsError({ cwd: repositoryRoot, pathCount: paths.size });
    }

    // Writing phase: the scratch store does not see the user's objects yet.
    // Git "freshens" (re-times) an object it would write when an alternate
    // already has it, so with the user's store attached every reused blob
    // and tree would get a new mtime there. Detached, blobs and trees land in
    // the scratch store, and write-tree is told not to look for the blobs it
    // cannot see.
    const stagedTreeSha = firstLine(
      (yield* git("write-tree:index", [...INDEX_COPY_CONFIG, "write-tree", "--missing-ok"], {
        env: stagedEnv,
      })).stdout,
    );
    // `add -A` from the root stages every change, including deletions and
    // untracked files that no ignore rule matches.
    yield* git("add:worktree", [...INDEX_COPY_CONFIG, "add", "--all", "--", "."], {
      env: workTreeEnv,
    });
    const workTreeTreeSha = firstLine(
      (yield* git("write-tree:worktree", [...INDEX_COPY_CONFIG, "write-tree", "--missing-ok"], {
        env: workTreeEnv,
      })).stdout,
    );

    // Reading phase: commit-tree needs the parent commits and the bundle needs
    // the history, so the user's store is attached as a read-only alternate.
    // Nothing written from here on (two new commits, one scratch ref) exists
    // anywhere yet, so nothing is freshened.
    const alternatesPath = path.join(scratchObjects, "info", "alternates");
    yield* fileSystem
      .writeFileString(alternatesPath, `${objectsPath}\n`)
      .pipe(Effect.mapError(fileSystemError("writeFile", alternatesPath)));

    // commit-tree honours commit.gpgSign, and a signing prompt has no terminal here.
    const commitEnv = { ...objectEnv, ...HANDOFF_IDENTITY };
    const indexCommitSha = firstLine(
      (yield* git(
        "commit-tree:index",
        [
          "commit-tree",
          "--no-gpg-sign",
          stagedTreeSha,
          "-p",
          baseCommitSha,
          "-m",
          "t3 handoff: index",
        ],
        { env: commitEnv },
      )).stdout,
    );
    const commitSha = firstLine(
      (yield* git(
        "commit-tree:worktree",
        [
          "commit-tree",
          "--no-gpg-sign",
          workTreeTreeSha,
          "-p",
          baseCommitSha,
          "-p",
          indexCommitSha,
          "-m",
          `t3 handoff: work in progress on ${branchName ?? "detached HEAD"}`,
        ],
        { env: commitEnv },
      )).stdout,
    );

    yield* scratchGit("update-ref", ["update-ref", HANDOFF_WIP_REF, commitSha]);
    yield* scratchGit("bundle:create", [
      "bundle",
      "create",
      bundlePath,
      HANDOFF_WIP_REF,
      ...excludedCommitShas.map((sha) => `^${sha}`),
    ]);

    return {
      bundlePath,
      commitSha,
      indexCommitSha,
      baseCommitSha,
      branchName,
      repositoryRoot,
      hasChanges: stagedTreeSha !== baseTreeSha || workTreeTreeSha !== baseTreeSha,
      excludedCommitShas,
    } satisfies WorkspaceSnapshot;
  }).pipe(Effect.scoped);

  return yield* capture.pipe(
    Effect.onError(() =>
      ownedBundleDirectory === undefined
        ? Effect.void
        : fileSystem
            .remove(ownedBundleDirectory, { recursive: true, force: true })
            .pipe(Effect.ignore),
    ),
  );
});
