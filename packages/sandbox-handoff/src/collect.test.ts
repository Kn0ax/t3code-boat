// @effect-diagnostics nodeBuiltinImport:off - Runs the generated scripts in a real POSIX shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { buildSandboxCollectScript, importCollectedBundle } from "./collect.ts";
import { buildSandboxImportScript } from "./importScript.ts";
import { snapshotWorkspace } from "./snapshot.ts";
import {
  git,
  makeRepositoryWithWork,
  makeTempDir,
  statusOf,
  writeFile,
} from "./testing/fixtures.ts";
import * as NodeServices from "./testing/nodeServices.ts";

const hostPath = process.env.PATH ?? "/usr/bin:/bin";

let scratch: string;
let source: string;
let node: string;

beforeEach(() => {
  scratch = makeTempDir("t3-handoff-collect-test-");
  source = NodePath.join(scratch, "source");
  node = NodePath.join(scratch, "node", "work", "proj");
  NodeFS.mkdirSync(source);
});

afterEach(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

const runScript = (script: string) => {
  const result = NodeChildProcess.spawnSync("sh", ["-s"], {
    input: script,
    encoding: "utf8",
    env: { HOME: scratch, PATH: hostPath },
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as { head: string; changed: boolean };
};

/** The source's work copied into the node, as a job starts. */
const seedNode = Effect.gen(function* () {
  makeRepositoryWithWork(source);
  const snapshot = yield* snapshotWorkspace({ cwd: source });
  runScript(
    buildSandboxImportScript({
      bundleRemotePath: snapshot.bundlePath,
      branchName: "t3/sandbox/job-1",
      targetCwd: node,
    }),
  );
  return snapshot;
});

describe("sandbox collect", () => {
  it.effect("brings the node's work back under a ref without touching the source checkout", () =>
    Effect.gen(function* () {
      const snapshot = yield* seedNode;
      writeFile(node, "src/agent.ts", "export const agent = true;\n");
      const statusBefore = statusOf(source);
      const bundle = NodePath.join(scratch, "node", "collect.bundle");

      const collected = runScript(
        buildSandboxCollectScript({
          targetCwd: node,
          baseCommit: snapshot.baseCommitSha,
          bundleRemotePath: bundle,
          commitMessage: "T3 Code sandbox job job-1",
        }),
      );
      assert.isTrue(collected.changed);

      const head = yield* importCollectedBundle({
        repositoryRoot: source,
        bundlePath: bundle,
        ref: "refs/t3/sandbox/job-1",
      });
      assert.equal(head, collected.head);
      // The agent's file and the source's uncommitted work both come back.
      assert.equal(
        git(source, ["show", "refs/t3/sandbox/job-1:src/agent.ts"]).stdout,
        "export const agent = true;\n",
      );
      assert.equal(
        git(source, ["show", "refs/t3/sandbox/job-1:src/app.ts"]).stdout,
        "export const app = 2;\n",
      );
      assert.equal(statusOf(source), statusBefore);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports an untouched node without writing a bundle", () =>
    Effect.gen(function* () {
      const snapshot = yield* seedNode;
      // The import leaves the source's uncommitted work as uncommitted work;
      // commit it the way an agent would, then reset to the base.
      git(node, ["reset", "--quiet", "--hard"]);
      git(node, ["clean", "--quiet", "-fd"]);
      const bundle = NodePath.join(scratch, "node", "collect.bundle");
      const collected = runScript(
        buildSandboxCollectScript({
          targetCwd: node,
          baseCommit: snapshot.baseCommitSha,
          bundleRemotePath: bundle,
          commitMessage: "unused",
        }),
      );
      assert.deepEqual(collected, { head: snapshot.baseCommitSha, changed: false });
      assert.isFalse(NodeFS.existsSync(bundle));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a ref outside refs/t3/sandbox", () =>
    Effect.gen(function* () {
      const error = yield* importCollectedBundle({
        repositoryRoot: source,
        bundlePath: "/tmp/x.bundle",
        ref: "refs/heads/main",
      }).pipe(Effect.flip);
      assert.equal(error._tag, "HandoffInvalidInputError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
