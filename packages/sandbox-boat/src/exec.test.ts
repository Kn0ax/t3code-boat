// @effect-diagnostics nodeBuiltinImport:off - The fake sandbox shell is a local child process.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  BOAT_WRAPPER_FAILURE_EXIT_CODE,
  boatExecPlan,
  boatExitCode,
  buildBoatBackgroundCommand,
  buildBoatExecCommand,
  MAX_BOAT_SYNC_TIMEOUT_SECONDS,
} from "./exec.ts";

/**
 * Runs a command the way boat's command endpoint does: one string through a
 * shell (bash in boat's Ubuntu image), no stdin, stdout and stderr apart.
 */
function runLikeBoat(command: string, env?: Readonly<Record<string, string>>) {
  return Effect.callback<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>((resume) => {
    const child = NodeChildProcess.spawn("bash", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    });
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("close", (code) => {
      resume(
        Effect.succeed({
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
    });
  });
}

const runScript = (script: string, args?: ReadonlyArray<string>) =>
  runLikeBoat(buildBoatExecCommand({ script, args }));

describe("buildBoatExecCommand", () => {
  it.effect("never puts script or argument bytes into the command text", () =>
    Effect.sync(() => {
      const script = `printf '%s\\n' "it's $HOME" \`id\` "secret-marker-in-script"`;
      const command = buildBoatExecCommand({ script, args: ["secret-marker-in-arg", "a'b"] });
      assert.notInclude(command, "secret-marker-in-script");
      assert.notInclude(command, "secret-marker-in-arg");
      assert.include(command, Base64.encode(script));
      // Everything after the fixed wrapper is plain single-quoted base64.
      const tail = command.slice(command.indexOf("t3-sandbox-exec"));
      assert.match(tail, /^t3-sandbox-exec( '[A-Za-z0-9+/=]*')+$/);
    }),
  );

  it.effect("keeps the wrapper free of single quotes so quoting it is exact", () =>
    Effect.sync(() => {
      const command = buildBoatExecCommand({ script: "" });
      const wrapper = command.slice("sh -c '".length, command.indexOf("' t3-sandbox-exec"));
      assert.notInclude(wrapper, "'");
    }),
  );

  it.effect('delivers the script byte-exact and the args as "$@"', () =>
    Effect.gen(function* () {
      const script = [
        "#!/bin/sh",
        "# quotes ' \" ` $HOME $(id) \\ and unicode: héllo ✓",
        'printf "count=%s\\n" "$#"',
        'for arg in "$@"; do printf "[%s]\\n" "$arg"; done',
        "printf 'to stderr\\n' >&2",
        "exit 7",
        "",
        "",
      ].join("\n");
      const args = ["plain", "with space", 'it\'s "quoted"', "", "$HOME `id`", "trailing\n\n", "ü"];

      const result = yield* runScript(script, args);

      assert.equal(result.exitCode, 7);
      assert.equal(
        result.stdout,
        'count=7\n[plain]\n[with space]\n[it\'s "quoted"]\n[]\n[$HOME `id`]\n[trailing\n\n]\n[ü]\n',
      );
      assert.equal(result.stderr, "to stderr\n");
    }),
  );

  it.effect("runs the exact bytes it was given, trailing newlines included", () =>
    Effect.gen(function* () {
      const script = 'cat "$0"\n\n\n';
      const result = yield* runScript(script);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, script);
    }),
  );

  it.effect("gives the script no stdin and removes its temp dir afterwards", () =>
    Effect.gen(function* () {
      const result = yield* runScript('printf "%s\\n" "$0"; cat; printf "done\\n"');
      const [scriptPath, done] = result.stdout.split("\n");
      assert.equal(done, "done");
      assert.isString(scriptPath);
      assert.isFalse(NodeFS.existsSync(scriptPath!));
    }),
  );

  it.effect("runs a script with no args", () =>
    Effect.gen(function* () {
      const result = yield* runScript('printf "%s" "$#"');
      assert.deepEqual(result, { exitCode: 0, stdout: "0", stderr: "" });
    }),
  );
});

/** A fresh directory standing in for the sandbox user's home. */
const makeHome = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-boat-home-"))),
  (home) => Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true })),
);

describe("buildBoatBackgroundCommand", () => {
  it.effect("keeps the log path, script and args out of the command text", () =>
    Effect.sync(() => {
      const command = buildBoatBackgroundCommand({
        script: "echo secret-marker-in-script",
        args: ["secret-marker-in-arg"],
        logPath: "~/secret-marker-in-log/server.log",
      });
      for (const marker of ["script", "arg", "log"]) {
        assert.notInclude(command, `secret-marker-in-${marker}`);
      }
      const wrapper = command.slice("sh -c '".length, command.indexOf("' t3-sandbox-background"));
      assert.notInclude(wrapper, "'");
      const tail = command.slice(command.indexOf("t3-sandbox-background"));
      assert.match(tail, /^t3-sandbox-background( '[A-Za-z0-9+/=]*')+$/);
    }),
  );

  it.effect("sends all output to the log under ~ and none to its own streams", () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      const script = [
        'printf "out %s|" "$#"',
        'for arg in "$@"; do printf "[%s]" "$arg"; done',
        "printf 'err\\n' >&2",
        "cat",
        "printf 'done\\n'",
      ].join("\n");
      const command = buildBoatBackgroundCommand({
        script,
        args: ["with space", "it's", "trailing\n"],
        logPath: "~/.t3/state/server.log",
      });

      const result = yield* runLikeBoat(command, { HOME: home });

      assert.deepEqual(result, { exitCode: 0, stdout: "", stderr: "" });
      const logPath = NodePath.join(home, ".t3/state/server.log");
      assert.equal(
        NodeFS.readFileSync(logPath, "utf8"),
        "out 3|[with space][it's][trailing\n]err\ndone\n",
      );
      // A new log is private to the sandbox user.
      assert.equal(NodeFS.statSync(logPath).mode & 0o777, 0o600);
    }),
  );

  it.effect("appends to an existing log at an absolute path", () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      const logPath = NodePath.join(home, "server.log");
      NodeFS.writeFileSync(logPath, "previous\n");

      const result = yield* runLikeBoat(
        buildBoatBackgroundCommand({ script: "echo next", logPath }),
      );

      assert.equal(result.exitCode, 0);
      assert.equal(NodeFS.readFileSync(logPath, "utf8"), "previous\nnext\n");
    }),
  );

  it.effect("ignores SIGHUP the way nohup does, for the script as well", () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      const logPath = NodePath.join(home, "server.log");

      const result = yield* runLikeBoat(
        buildBoatBackgroundCommand({ script: 'kill -HUP "$$"; echo survived', logPath }),
      );

      assert.equal(result.exitCode, 0);
      assert.equal(NodeFS.readFileSync(logPath, "utf8"), "survived\n");
    }),
  );

  it.effect("fails with the wrapper status when the log cannot be opened", () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      // A file where the log's directory should be.
      NodeFS.writeFileSync(NodePath.join(home, "blocked"), "");

      const result = yield* runLikeBoat(
        buildBoatBackgroundCommand({
          script: "echo never",
          logPath: NodePath.join(home, "blocked", "server.log"),
        }),
      );

      assert.equal(result.exitCode, BOAT_WRAPPER_FAILURE_EXIT_CODE);
    }),
  );
});

describe("boatExecPlan", () => {
  it.effect("runs synchronously within boat's 600 s cap, rounding up to whole seconds", () =>
    Effect.sync(() => {
      assert.deepEqual(boatExecPlan(60_000), { _tag: "Sync", timeoutSeconds: 60 });
      assert.deepEqual(boatExecPlan(1_500), { _tag: "Sync", timeoutSeconds: 2 });
      assert.deepEqual(boatExecPlan(1), { _tag: "Sync", timeoutSeconds: 1 });
      assert.deepEqual(boatExecPlan(0), { _tag: "Sync", timeoutSeconds: 1 });
      assert.deepEqual(boatExecPlan(MAX_BOAT_SYNC_TIMEOUT_SECONDS * 1000), {
        _tag: "Sync",
        timeoutSeconds: 600,
      });
    }),
  );

  it.effect("runs detached beyond the cap, and unbounded for an infinite budget", () =>
    Effect.sync(() => {
      assert.deepEqual(boatExecPlan(600_001), { _tag: "Detached", timeoutMs: 600_001 });
      assert.deepEqual(boatExecPlan(900_000), { _tag: "Detached", timeoutMs: 900_000 });
      assert.deepEqual(boatExecPlan(Number.POSITIVE_INFINITY), {
        _tag: "Detached",
        timeoutMs: undefined,
      });
    }),
  );

  it.effect("refuses NaN instead of reading it as no limit", () =>
    Effect.sync(() => {
      assert.deepEqual(boatExecPlan(Number.NaN), { _tag: "Invalid" });
      assert.deepEqual(boatExecPlan(Number.NEGATIVE_INFINITY), { _tag: "Sync", timeoutSeconds: 1 });
    }),
  );
});

describe("boatExitCode", () => {
  it.effect("passes exit statuses through and derives one for signals", () =>
    Effect.sync(() => {
      assert.equal(boatExitCode({ exitCode: 0 }), 0);
      assert.equal(boatExitCode({ exitCode: 3, signal: "SIGTERM" }), 3);
      assert.equal(boatExitCode({ exitCode: null, oomKilled: true }), 137);
      assert.equal(boatExitCode({ exitCode: null, signal: "SIGTERM" }), 143);
      assert.equal(boatExitCode({ exitCode: null, signal: "KILL" }), 137);
      assert.isUndefined(boatExitCode({ exitCode: null, signal: "SIGWHATEVER" }));
      assert.isUndefined(boatExitCode({ exitCode: null }));
    }),
  );
});
