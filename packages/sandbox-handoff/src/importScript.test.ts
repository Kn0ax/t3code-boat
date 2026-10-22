// @effect-diagnostics nodeBuiltinImport:off - Runs the generated script in a real POSIX shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { HandoffInvalidInputError } from "./errors.ts";
import { buildSandboxImportScript, SANDBOX_IMPORT_EXIT_CODES } from "./importScript.ts";
import { snapshotWorkspace } from "./snapshot.ts";
import {
  git,
  makeRepositoryWithWork,
  makeTempDir,
  statusOf,
  workTreeContents,
  writeFile,
} from "./testing/fixtures.ts";
import * as NodeServices from "./testing/nodeServices.ts";

const hostPath = process.env.PATH ?? "/usr/bin:/bin";
const CLAUDE_ID = "5973b6c0-94b8-487b-a530-2aeb6098ae0e";
const CODEX_FILE = "rollout-2026-10-11T10-00-00-0199d2a4-5d1e-7c3a-9f00-2aeb6098ae0e.jsonl";

let scratch: string;
let source: string;
let sandboxHome: string;

beforeEach(() => {
  scratch = makeTempDir("t3-handoff-import-test-");
  source = NodePath.join(scratch, "source");
  sandboxHome = NodePath.join(scratch, "sandbox-home");
  NodeFS.mkdirSync(source);
  NodeFS.mkdirSync(sandboxHome);
});

afterEach(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

/** Runs the script the way a provider exec does: `sh` with the script on stdin. */
const runScript = (script: string) => {
  const result = NodeChildProcess.spawnSync("sh", ["-s"], {
    input: script,
    encoding: "utf8",
    env: { HOME: sandboxHome, PATH: hostPath },
    timeout: 60_000,
  });
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
};

const syntaxCheck = (script: string) =>
  NodeChildProcess.spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });

describe("buildSandboxImportScript", () => {
  it.each([
    ["without transcripts", []],
    [
      "with transcripts",
      [
        { provider: "codex", stagedPath: "/tmp/it's `odd`/a.jsonl", relativePath: "sessions/a b" },
        {
          provider: "claude",
          stagedPath: "/tmp/$(rm -rf ~)/b.jsonl",
          relativePath: "projects/-x/b.jsonl",
          homePath: '/home/u/"claude"',
        },
      ],
    ],
  ] as const)("parses with sh -n %s", (_label, transcripts) => {
    const script = buildSandboxImportScript({
      bundleRemotePath: '/tmp/handoff/it\'s a "bundle".bundle',
      branchName: "feature/it's-$(x)",
      targetCwd: "/home/daytona/work/$HOME/proj",
      transcripts,
    });
    const result = syntaxCheck(script);
    assert.equal(result.status, 0, result.stderr);
    assert.include(script, `T3_TARGET='/home/daytona/work/$HOME/proj'`);
  });

  it("refuses inputs the script cannot use safely", () => {
    const valid = { bundleRemotePath: "/b", branchName: "main", targetCwd: "/w" };
    const invalid = [
      { ...valid, bundleRemotePath: "relative.bundle" },
      { ...valid, targetCwd: "/w/../etc" },
      { ...valid, targetCwd: "/" },
      { ...valid, branchName: "--force" },
      { ...valid, branchName: "a..b" },
      { ...valid, transcripts: [{ provider: "codex", stagedPath: "/s", relativePath: "../x" }] },
      { ...valid, transcripts: [{ provider: "codex", stagedPath: "s", relativePath: "x" }] },
    ] as const;
    for (const input of invalid) {
      assert.throws(() => buildSandboxImportScript(input), HandoffInvalidInputError);
    }
  });

  it.effect("restores the branch, staged, unstaged and untracked work, and transcripts", () =>
    Effect.gen(function* () {
      makeRepositoryWithWork(source);
      const snapshot = yield* snapshotWorkspace({ cwd: source });
      const target = NodePath.join(scratch, "sandbox", "work", "proj");
      const staging = NodePath.join(scratch, "staging");
      writeFile(staging, "codex.jsonl", '{"type":"session_meta"}\n');
      writeFile(staging, "claude.jsonl", '{"type":"user"}\n');
      const claudeHome = NodePath.join(scratch, "claude home");
      const script = buildSandboxImportScript({
        bundleRemotePath: snapshot.bundlePath,
        branchName: "feature/move",
        targetCwd: target,
        transcripts: [
          {
            provider: "codex",
            stagedPath: NodePath.join(staging, "codex.jsonl"),
            relativePath: `sessions/2026/10/11/${CODEX_FILE}`,
          },
          {
            provider: "claude",
            stagedPath: NodePath.join(staging, "claude.jsonl"),
            relativePath: `projects/-sandbox-proj/${CLAUDE_ID}.jsonl`,
            homePath: claudeHome,
          },
        ],
      });

      const first = runScript(script);
      assert.equal(first.exitCode, 0, first.stderr);
      assert.deepEqual(JSON.parse(first.stdout), {
        alreadyImported: false,
        head: snapshot.baseCommitSha,
        handoffCommit: snapshot.commitSha,
      });
      assert.equal(statusOf(target), statusOf(source));
      assert.deepEqual(workTreeContents(target), workTreeContents(source));

      const codexTranscript = NodePath.join(
        sandboxHome,
        ".codex",
        "sessions/2026/10/11",
        CODEX_FILE,
      );
      const claudeTranscript = NodePath.join(
        claudeHome,
        "projects/-sandbox-proj",
        `${CLAUDE_ID}.jsonl`,
      );
      assert.equal(NodeFS.readFileSync(codexTranscript, "utf8"), '{"type":"session_meta"}\n');
      assert.equal(NodeFS.readFileSync(claudeTranscript, "utf8"), '{"type":"user"}\n');
      assert.equal(NodeFS.statSync(claudeTranscript).mode & 0o777, 0o600);

      // A retry is a no-op for git and places the transcripts again.
      NodeFS.rmSync(codexTranscript);
      const second = runScript(script);
      assert.equal(second.exitCode, 0, second.stderr);
      assert.isTrue(JSON.parse(second.stdout).alreadyImported);
      assert.equal(statusOf(target), statusOf(source));
      assert.isTrue(NodeFS.existsSync(codexTranscript));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps placed transcripts and the directories it creates private", () =>
    Effect.gen(function* () {
      makeRepositoryWithWork(source);
      const snapshot = yield* snapshotWorkspace({ cwd: source });
      const staging = NodePath.join(scratch, "staging");
      writeFile(staging, "claude.jsonl", '{"type":"user","text":"secret tool output"}\n');
      const relativePath = `projects/-sandbox-proj/${CLAUDE_ID}.jsonl`;
      const script = buildSandboxImportScript({
        bundleRemotePath: snapshot.bundlePath,
        branchName: "feature/move",
        targetCwd: NodePath.join(scratch, "sandbox", "proj"),
        transcripts: [
          {
            provider: "claude",
            stagedPath: NodePath.join(staging, "claude.jsonl"),
            relativePath,
          },
        ],
      });
      // A permissive umask, as provider execs commonly run with: what the
      // script creates must not depend on it.
      const result = runScript(`umask 022\n${script}`);
      assert.equal(result.exitCode, 0, result.stderr);

      const claudeHome = NodePath.join(sandboxHome, ".claude");
      for (const directory of [
        claudeHome,
        NodePath.join(claudeHome, "projects"),
        NodePath.join(claudeHome, "projects", "-sandbox-proj"),
      ]) {
        assert.equal(NodeFS.statSync(directory).mode & 0o777, 0o700, directory);
      }
      assert.equal(NodeFS.statSync(NodePath.join(claudeHome, relativePath)).mode & 0o777, 0o600);
      // The copy is created private: no window in which it is readable by others.
      assert.match(script, /umask 077\n[\s\S]*t3_place\(\) \{[\s\S]*cp "\$1"/u);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("applies a thin bundle only where its base history already is", () =>
    Effect.gen(function* () {
      makeRepositoryWithWork(source);
      const snapshot = yield* snapshotWorkspace({
        cwd: source,
        bundlePath: NodePath.join(scratch, "thin.bundle"),
        excludeReachableFrom: ["main"],
      });
      const build = (targetCwd: string) =>
        buildSandboxImportScript({
          bundleRemotePath: snapshot.bundlePath,
          branchName: "feature/move",
          targetCwd,
        });

      const empty = runScript(build(NodePath.join(scratch, "empty")));
      assert.equal(empty.exitCode, SANDBOX_IMPORT_EXIT_CODES.missingPrerequisites, empty.stderr);

      const clone = NodePath.join(scratch, "clone");
      git(scratch, ["clone", "--quiet", "--branch", "main", source, clone]);
      const imported = runScript(build(clone));
      assert.equal(imported.exitCode, 0, imported.stderr);
      assert.equal(statusOf(clone), statusOf(source));
      assert.deepEqual(workTreeContents(clone), workTreeContents(source));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses targets it would damage", () =>
    Effect.gen(function* () {
      makeRepositoryWithWork(source);
      const snapshot = yield* snapshotWorkspace({
        cwd: source,
        bundlePath: NodePath.join(scratch, "full.bundle"),
      });
      const build = (targetCwd: string, transcripts = false) =>
        buildSandboxImportScript({
          bundleRemotePath: snapshot.bundlePath,
          branchName: "feature/move",
          targetCwd,
          ...(transcripts
            ? {
                transcripts: [
                  {
                    provider: "claude" as const,
                    stagedPath: NodePath.join(scratch, "staged.jsonl"),
                    relativePath: `projects/-x/${CLAUDE_ID}.jsonl`,
                  },
                ],
              }
            : {}),
        });

      const dirty = NodePath.join(scratch, "dirty");
      git(scratch, ["clone", "--quiet", source, dirty]);
      writeFile(dirty, "local-work.txt", "not committed\n");
      const dirtyRun = runScript(build(dirty));
      assert.equal(dirtyRun.exitCode, SANDBOX_IMPORT_EXIT_CODES.targetNotImportable);
      assert.isTrue(NodeFS.existsSync(NodePath.join(dirty, "local-work.txt")));

      const plain = NodePath.join(scratch, "plain");
      writeFile(plain, "notes.txt", "not a repository\n");
      assert.equal(runScript(build(plain)).exitCode, SANDBOX_IMPORT_EXIT_CODES.targetNotImportable);

      const diverged = NodePath.join(scratch, "diverged");
      git(scratch, ["clone", "--quiet", "--branch", "main", source, diverged]);
      git(diverged, ["checkout", "--quiet", "-b", "feature/move"]);
      writeFile(diverged, "sandbox-only.txt", "committed in the sandbox\n");
      git(diverged, ["add", "sandbox-only.txt"]);
      git(diverged, ["commit", "--quiet", "-m", "sandbox commit"]);
      assert.equal(runScript(build(diverged)).exitCode, SANDBOX_IMPORT_EXIT_CODES.branchDiverged);
      // A retry is refused the same way, not taken for a finished import.
      assert.equal(runScript(build(diverged)).exitCode, SANDBOX_IMPORT_EXIT_CODES.branchDiverged);

      const real = NodePath.join(scratch, "real");
      NodeFS.mkdirSync(real);
      const link = NodePath.join(scratch, "link");
      NodeFS.symlinkSync(real, link);
      writeFile(scratch, "staged.jsonl", "{}\n");
      assert.equal(runScript(build(link, true)).exitCode, SANDBOX_IMPORT_EXIT_CODES.invalidInput);
      assert.deepEqual(NodeFS.readdirSync(real), []);

      assert.equal(
        runScript(
          buildSandboxImportScript({
            bundleRemotePath: NodePath.join(scratch, "missing.bundle"),
            branchName: "main",
            targetCwd: NodePath.join(scratch, "unused"),
          }),
        ).exitCode,
        SANDBOX_IMPORT_EXIT_CODES.missingUpload,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
