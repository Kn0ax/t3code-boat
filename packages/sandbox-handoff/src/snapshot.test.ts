// @effect-diagnostics nodeBuiltinImport:off - Inspects real repositories on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { HANDOFF_WIP_REF, snapshotWorkspace } from "./snapshot.ts";
import {
  git,
  makeRepositoryWithWork,
  makeTempDir,
  statusOf,
  treeFingerprint,
  workTreeContents,
  writeFile,
} from "./testing/fixtures.ts";
import * as NodeServices from "./testing/nodeServices.ts";

let scratch: string;
let source: string;

beforeEach(() => {
  scratch = makeTempDir("t3-handoff-snapshot-test-");
  source = NodePath.join(scratch, "source");
  NodeFS.mkdirSync(source);
});

afterEach(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

const lines = (text: string) => text.split("\n").filter((line) => line.length > 0);

describe("snapshotWorkspace", () => {
  it.effect("leaves the source repository, index and work tree untouched", () =>
    Effect.gen(function* () {
      makeRepositoryWithWork(source);
      // status may refresh the index itself, so it runs before the fingerprints.
      const statusBefore = statusOf(source);
      const indexBefore = NodeFS.readFileSync(NodePath.join(source, ".git", "index"));
      const gitDirBefore = treeFingerprint(NodePath.join(source, ".git"));
      const workTreeBefore = treeFingerprint(source, { skip: [".git"] });

      const snapshot = yield* snapshotWorkspace({
        cwd: NodePath.join(source, "src"),
        bundlePath: NodePath.join(scratch, "workspace.bundle"),
      });

      assert.deepEqual(NodeFS.readFileSync(NodePath.join(source, ".git", "index")), indexBefore);
      assert.deepEqual(treeFingerprint(NodePath.join(source, ".git")), gitDirBefore);
      assert.deepEqual(treeFingerprint(source, { skip: [".git"] }), workTreeBefore);
      assert.equal(statusOf(source), statusBefore);
      assert.equal(git(source, ["stash", "list"]).stdout, "");

      assert.equal(snapshot.baseCommitSha, git(source, ["rev-parse", "HEAD"]).stdout.trim());
      assert.equal(snapshot.branchName, "feature/move");
      assert.equal(snapshot.repositoryRoot, source);
      assert.isTrue(snapshot.hasChanges);
      assert.deepEqual(snapshot.excludedCommitShas, []);
      assert.isTrue(NodeFS.statSync(snapshot.bundlePath).isFile());
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("bundles the work tree, untracked files included, with the index as a parent", () =>
    Effect.gen(function* () {
      makeRepositoryWithWork(source);
      const snapshot = yield* snapshotWorkspace({ cwd: source });
      const receiver = NodePath.join(scratch, "receiver");
      git(scratch, ["init", "--quiet", receiver]);
      git(receiver, ["fetch", "--quiet", snapshot.bundlePath, `${HANDOFF_WIP_REF}:refs/received`]);

      assert.equal(git(receiver, ["rev-parse", "refs/received"]).stdout.trim(), snapshot.commitSha);
      assert.equal(
        git(receiver, ["rev-parse", "refs/received^1"]).stdout.trim(),
        snapshot.baseCommitSha,
      );
      assert.equal(
        git(receiver, ["rev-parse", "refs/received^2"]).stdout.trim(),
        snapshot.indexCommitSha,
      );

      const files = lines(
        git(receiver, [
          "-c",
          "core.quotePath=false",
          "ls-tree",
          "-r",
          "--name-only",
          "refs/received",
        ]).stdout,
      );
      assert.includeMembers(files, [
        "untracked file.txt",
        "dir/deep/untracked.ts",
        "café.txt",
        "readme-link",
        "notes/new.md",
      ]);
      assert.notInclude(files, "debug.log");
      assert.notInclude(files, "build/out.js");
      assert.notInclude(files, "src/remove-me.ts");
      assert.notInclude(files, "src/stage-delete.ts");
      assert.equal(
        git(receiver, ["show", "refs/received:untracked file.txt"]).stdout,
        "has a space\n",
      );
      assert.equal(
        git(receiver, ["show", "refs/received:README.md"]).stdout,
        NodeFS.readFileSync(NodePath.join(source, "README.md"), "utf8"),
      );

      // The index commit is exactly what was staged: same modes, blobs and paths.
      const staged = lines(git(source, ["ls-files", "--stage"]).stdout).map((line) =>
        line.replace(/^(\d+) ([0-9a-f]+) 0\t/u, "$1 $2\t"),
      );
      const indexTree = lines(git(receiver, ["ls-tree", "-r", "refs/received^2"]).stdout).map(
        (line) => line.replace(/^(\d+) blob ([0-9a-f]+)\t/u, "$1 $2\t"),
      );
      assert.deepEqual(indexTree, staged);

      // A full bundle seeds an empty repository.
      assert.notInclude(
        git(receiver, ["bundle", "verify", snapshot.bundlePath]).stderr,
        "requires",
      );
      NodeFS.rmSync(NodePath.dirname(snapshot.bundlePath), { recursive: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a clean work tree and a detached HEAD", () =>
    Effect.gen(function* () {
      makeRepositoryWithWork(source);
      git(source, ["stash", "push", "--quiet", "--include-untracked"]);
      git(source, ["checkout", "--quiet", "--detach", "HEAD~1"]);
      const snapshot = yield* snapshotWorkspace({
        cwd: source,
        bundlePath: NodePath.join(scratch, "clean.bundle"),
      });
      assert.isFalse(snapshot.hasChanges);
      assert.isNull(snapshot.branchName);
      assert.equal(snapshot.baseCommitSha, git(source, ["rev-parse", "HEAD"]).stdout.trim());
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("captures a linked worktree without touching it", () =>
    Effect.gen(function* () {
      makeRepositoryWithWork(source);
      const linked = NodePath.join(scratch, "linked");
      git(source, ["worktree", "add", "--quiet", "-b", "linked-branch", linked, "main"]);
      writeFile(linked, "linked-only.txt", "from the linked worktree\n");
      writeFile(linked, "README.md", "changed in the linked worktree\n");
      const statusBefore = statusOf(linked);
      const contentsBefore = workTreeContents(linked);
      const commonBefore = treeFingerprint(NodePath.join(source, ".git"));

      const snapshot = yield* snapshotWorkspace({
        cwd: linked,
        bundlePath: NodePath.join(scratch, "linked.bundle"),
      });

      // Before any status call, which may itself rewrite the worktree's index.
      assert.deepEqual(treeFingerprint(NodePath.join(source, ".git")), commonBefore);
      assert.deepEqual(workTreeContents(linked), contentsBefore);
      assert.equal(statusOf(linked), statusBefore);
      assert.equal(snapshot.branchName, "linked-branch");
      assert.equal(snapshot.repositoryRoot, linked);
      const receiver = NodePath.join(scratch, "receiver");
      git(scratch, ["init", "--quiet", receiver]);
      git(receiver, ["fetch", "--quiet", snapshot.bundlePath, `${HANDOFF_WIP_REF}:refs/received`]);
      assert.equal(
        git(receiver, ["show", "refs/received:linked-only.txt"]).stdout,
        "from the linked worktree\n",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("records revisions the receiver already has as exclusions", () =>
    Effect.gen(function* () {
      makeRepositoryWithWork(source);
      const snapshot = yield* snapshotWorkspace({
        cwd: source,
        bundlePath: NodePath.join(scratch, "thin.bundle"),
        excludeReachableFrom: ["main", "HEAD~1", "main"],
      });
      const main = git(source, ["rev-parse", "main"]).stdout.trim();
      const parent = git(source, ["rev-parse", "HEAD~1"]).stdout.trim();
      assert.deepEqual(snapshot.excludedCommitShas, [...new Set([main, parent])]);
      const empty = NodePath.join(scratch, "empty");
      git(scratch, ["init", "--quiet", empty]);
      const verify = git(empty, ["bundle", "verify", snapshot.bundlePath], { allowFailure: true });
      assert.notEqual(verify.status, 0);
      assert.include(verify.stderr, main);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails with typed errors for unusable repositories", () =>
    Effect.gen(function* () {
      const notARepository = yield* snapshotWorkspace({ cwd: source }).pipe(Effect.flip);
      assert.equal(notARepository._tag, "HandoffNotAWorkTreeError");

      git(source, ["init", "--quiet"]);
      const unborn = yield* snapshotWorkspace({ cwd: source }).pipe(Effect.flip);
      assert.equal(unborn._tag, "HandoffUnbornHeadError");

      const relative = yield* snapshotWorkspace({ cwd: "relative/path" }).pipe(Effect.flip);
      assert.equal(relative._tag, "HandoffInvalidInputError");

      writeFile(source, "conflict.txt", "base\n");
      git(source, ["add", "conflict.txt"]);
      git(source, ["commit", "--quiet", "-m", "base"]);
      git(source, ["checkout", "--quiet", "-b", "other"]);
      writeFile(source, "conflict.txt", "other\n");
      git(source, ["commit", "--quiet", "--all", "-m", "other"]);
      git(source, ["checkout", "--quiet", "-"]);
      writeFile(source, "conflict.txt", "mine\n");
      git(source, ["commit", "--quiet", "--all", "-m", "mine"]);
      git(source, ["merge", "--quiet", "other"], { allowFailure: true });
      const unmerged = yield* snapshotWorkspace({
        cwd: source,
        bundlePath: NodePath.join(scratch, "unmerged.bundle"),
      }).pipe(Effect.flip);
      assert.equal(unmerged._tag, "HandoffUnmergedPathsError");
      assert.isFalse(NodeFS.existsSync(NodePath.join(scratch, "unmerged.bundle")));

      const missing = yield* snapshotWorkspace({
        cwd: source,
        excludeReachableFrom: ["no-such-branch"],
      }).pipe(Effect.flip);
      assert.equal(missing._tag, "HandoffRevisionNotFoundError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
