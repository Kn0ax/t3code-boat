// @effect-diagnostics nodeBuiltinImport:off - Test fixtures build real repositories with the git CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const GIT_TEST_ENV = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs git synchronously; throws on a non-zero exit unless `allowFailure`. */
export function git(
  cwd: string,
  args: ReadonlyArray<string>,
  options: { readonly allowFailure?: boolean } = {},
): CommandResult {
  const result = NodeChildProcess.spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_TEST_ENV },
  });
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A canonical (realpath) temporary directory. */
export function makeTempDir(prefix: string): string {
  return NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
}

export function writeFile(root: string, relativePath: string, content: string): void {
  const filePath = NodePath.join(root, relativePath);
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.writeFileSync(filePath, content);
}

/**
 * A repository on branch `feature/move` with two commits and every kind of
 * pending change: staged, unstaged, partly staged, staged and unstaged
 * deletions, a mode change, a staged new file, untracked files (with spaces,
 * non-ASCII, nested, a symlink) and ignored files.
 */
export function makeRepositoryWithWork(root: string): void {
  git(root, ["init", "--quiet", "--initial-branch=main"]);
  writeFile(root, ".gitignore", "*.log\nbuild/\n");
  writeFile(root, "README.md", "# Fixture\n");
  writeFile(root, "src/app.ts", "export const app = 1;\n");
  writeFile(root, "src/remove-me.ts", "export const gone = true;\n");
  writeFile(root, "src/stage-delete.ts", "export const staged = true;\n");
  writeFile(root, "bin/run.sh", "#!/bin/sh\necho run\n");
  NodeFS.chmodSync(NodePath.join(root, "bin/run.sh"), 0o755);
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "-m", "first"]);
  writeFile(root, "README.md", "# Fixture\n\nSecond commit.\n");
  git(root, ["commit", "--quiet", "--all", "-m", "second"]);
  git(root, ["checkout", "--quiet", "-b", "feature/move"]);

  writeFile(root, "src/app.ts", "export const app = 2;\n");
  git(root, ["add", "src/app.ts"]);
  writeFile(root, "README.md", "# Fixture\n\nSecond commit.\n\nStaged line.\n");
  git(root, ["add", "README.md"]);
  writeFile(root, "README.md", "# Fixture\n\nSecond commit.\n\nStaged line.\n\nUnstaged line.\n");
  NodeFS.chmodSync(NodePath.join(root, "bin/run.sh"), 0o644);
  NodeFS.rmSync(NodePath.join(root, "src/remove-me.ts"));
  git(root, ["rm", "--quiet", "src/stage-delete.ts"]);
  writeFile(root, "notes/new.md", "staged new file\n");
  git(root, ["add", "notes/new.md"]);
  writeFile(root, "untracked file.txt", "has a space\n");
  writeFile(root, "dir/deep/untracked.ts", "export {};\n");
  writeFile(root, "café.txt", "non-ascii name\n");
  NodeFS.symlinkSync("README.md", NodePath.join(root, "readme-link"));
  writeFile(root, "debug.log", "ignored\n");
  writeFile(root, "build/out.js", "ignored too\n");
}

/** Porcelain v2 status with every untracked file, NUL-separated. */
export function statusOf(root: string): string {
  return git(root, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"]).stdout;
}

/**
 * Every entry below `directory` with its type, size, mode and mtime, so a
 * comparison catches a write anywhere (an object, a ref, a log, the index).
 */
export function treeFingerprint(
  directory: string,
  options: { readonly skip?: ReadonlyArray<string> } = {},
): ReadonlyArray<string> {
  const entries: Array<string> = [];
  const walk = (current: string) => {
    for (const name of NodeFS.readdirSync(current).toSorted()) {
      const entryPath = NodePath.join(current, name);
      const relative = NodePath.relative(directory, entryPath);
      if (options.skip?.includes(relative)) continue;
      const stats = NodeFS.lstatSync(entryPath);
      entries.push(
        `${relative} ${stats.isDirectory() ? "d" : stats.isSymbolicLink() ? "l" : "f"} ${stats.size} ${stats.mode} ${stats.mtimeMs}`,
      );
      if (stats.isDirectory()) walk(entryPath);
    }
  };
  walk(directory);
  return entries;
}

/** Contents of every file below `root` outside `.git` and the ignored fixtures. */
export function workTreeContents(root: string): Readonly<Record<string, string>> {
  const contents: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of NodeFS.readdirSync(current).toSorted()) {
      const entryPath = NodePath.join(current, name);
      const relative = NodePath.relative(root, entryPath);
      if (relative === ".git" || relative === "build" || relative === "debug.log") continue;
      const stats = NodeFS.lstatSync(entryPath);
      if (stats.isDirectory()) {
        walk(entryPath);
      } else if (stats.isSymbolicLink()) {
        contents[relative] = `-> ${NodeFS.readlinkSync(entryPath)}`;
      } else {
        contents[relative] =
          `${(stats.mode & 0o111) === 0 ? "" : "+x "}${NodeFS.readFileSync(entryPath, "utf8")}`;
      }
    }
  };
  walk(root);
  return contents;
}
