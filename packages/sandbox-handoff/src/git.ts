import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { HandoffGitCommandError } from "./errors.ts";

const STDERR_TAIL_LENGTH = 2_000;

/**
 * The end of a git command's stderr, where git prints the line that explains
 * the failure. Handoff git commands are local plumbing on the user's own
 * repository (no fetch, no push, no credential helper), so their stderr names
 * paths and refs rather than secrets, and it is the only way to tell "nested
 * repository without a commit" from "disk full".
 */
export function stderrTail(stderr: string): string | undefined {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length <= STDERR_TAIL_LENGTH ? trimmed : trimmed.slice(-STDERR_TAIL_LENGTH);
}

/**
 * Environment of every handoff git command, layered over the server's own.
 *
 * Repository bindings the server may have inherited (a hook environment sets
 * GIT_DIR and GIT_INDEX_FILE) are cleared so git discovers the repository from
 * `cwd`, and callers set the object and index locations explicitly.
 * GIT_OPTIONAL_LOCKS=0 keeps read commands from opportunistically rewriting
 * the user's index, and LC_ALL=C keeps the stderr this module matches stable.
 */
const GIT_BASE_ENV: Readonly<Record<string, string | undefined>> = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const collectText = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

/**
 * Runs one git command to completion. A non-zero exit fails with
 * `HandoffGitCommandError` unless the caller lists it in `allowedExitCodes`
 * (`rev-parse --verify --quiet` exits 1 for "no such revision").
 */
export const runGit = Effect.fn("sandboxHandoff.runGit")(function* (input: {
  readonly step: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly allowedExitCodes?: ReadonlyArray<number>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const commandError = (fields: {
    readonly exitCode?: number;
    readonly stderr?: string;
    readonly cause?: unknown;
  }) => new HandoffGitCommandError({ step: input.step, cwd: input.cwd, ...fields });
  const child = yield* spawner
    .spawn(
      ChildProcess.make("git", input.args, {
        cwd: input.cwd,
        env: { ...GIT_BASE_ENV, ...input.env },
        extendEnv: true,
        // Nothing here reads stdin; a closed one makes an unexpected prompt fail fast.
        stdin: "ignore",
      }),
    )
    .pipe(
      Effect.mapError((cause) => commandError({ cause })),
      // A bad cwd can make node throw synchronously, which arrives as a defect.
      Effect.catchDefect((cause) => Effect.fail(commandError({ cause }))),
    );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collectText(child.stdout), collectText(child.stderr), child.exitCode],
    { concurrency: "unbounded" },
  ).pipe(Effect.mapError((cause) => commandError({ cause })));
  const code = Number(exitCode);
  if (code !== 0 && !(input.allowedExitCodes ?? []).includes(code)) {
    const tail = stderrTail(stderr);
    return yield* commandError({
      exitCode: code,
      ...(tail === undefined ? {} : { stderr: tail }),
    });
  }
  return { stdout, stderr, exitCode: code };
}, Effect.scoped);

/** The first line of a command's stdout, without its line ending. */
export function firstLine(stdout: string): string {
  const newline = stdout.indexOf("\n");
  return (newline < 0 ? stdout : stdout.slice(0, newline)).replace(/\r$/u, "");
}
