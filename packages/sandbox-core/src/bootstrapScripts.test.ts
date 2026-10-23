// @effect-diagnostics nodeBuiltinImport:off - Runs the generated scripts in a real POSIX shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import { buildRemoteT3RunnerScript, SshInvalidArchiveVersionError } from "@t3tools/ssh/tunnel";
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";

import {
  buildSandboxAgentClisScript,
  buildSandboxInstallScript,
  buildSandboxLaunchScript,
  buildSandboxPairingScript,
  buildSandboxReadyScript,
  buildSandboxServeScript,
  buildSandboxStopScript,
  isSandboxServerLogPath,
  SANDBOX_AGENT_CLI_PACKAGES,
  SANDBOX_STATE_KEY,
  sandboxRunnerOptions,
  sandboxScriptKind,
} from "./bootstrapScripts.ts";
import { SANDBOX_ENV } from "./agentEnvironment.ts";
import { SANDBOX_T3_PORT } from "./SandboxEnvironmentManager.ts";

const VERSION = "1.2.3";
const RUNNER = sandboxRunnerOptions({ t3Version: VERSION });

// oxlint-disable-next-line t3code/no-global-process-runtime -- The scripts run in a real host shell.
const hostPlatform = NodeOS.platform();
const hostPath = process.env.PATH ?? "/usr/bin:/bin";

const allScripts = () =>
  [
    ["install", buildSandboxInstallScript(RUNNER)],
    ["agent-clis", buildSandboxAgentClisScript()],
    ["launch", buildSandboxLaunchScript({ runner: RUNNER, port: SANDBOX_T3_PORT })],
    ["serve", buildSandboxServeScript({ port: SANDBOX_T3_PORT })],
    ["ready", buildSandboxReadyScript({ port: SANDBOX_T3_PORT })],
    ["pair", buildSandboxPairingScript({ runner: RUNNER })],
    ["stop", buildSandboxStopScript()],
  ] as const;

/** The scripts that run through `exec`, which must never leave a server behind. */
const execScripts = () => allScripts().filter(([kind]) => kind !== "serve");

describe("sandbox bootstrap scripts", () => {
  const syntaxCheck = (script: string) =>
    NodeChildProcess.spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });

  it.skipIf(hostPlatform === "win32").each(allScripts())(
    "%s parses with sh -n",
    (_kind, script) => {
      assert.isAbove(script.length, 0);
      const result = syntaxCheck(script);
      assert.equal(result.status, 0, result.stderr);
    },
  );

  it.skipIf(hostPlatform === "win32")("sh -n catches a broken script", () => {
    assert.notEqual(syntaxCheck("if true; then\n  echo unterminated\n").status, 0);
  });

  it.each(allScripts())(
    "%s carries its kind marker and no unfilled placeholder",
    (kind, script) => {
      assert.equal(sandboxScriptKind(script), kind);
      assert.notMatch(script, /@@[A-Z0-9_]+@@/u);
    },
  );

  it("does not recognise arbitrary scripts", () => {
    assert.isUndefined(sandboxScriptKind("echo hi"));
    assert.isUndefined(sandboxScriptKind("# t3-sandbox-script: rm-rf\necho hi"));
  });

  it.each([
    ["install", buildSandboxInstallScript(RUNNER)],
    ["launch", buildSandboxLaunchScript({ runner: RUNNER, port: SANDBOX_T3_PORT })],
    ["pair", buildSandboxPairingScript({ runner: RUNNER })],
  ] as const)("%s embeds the SSH runner byte for byte", (_kind, script) => {
    // A replacement string would turn the install lock's "$$" into "$".
    assert.include(script, buildRemoteT3RunnerScript(RUNNER));
    assert.include(script, `printf '%s\\n' "$$" > "$T3_LOCK"`);
  });

  it.each(execScripts())("%s never starts a server, so its exec returns", (_kind, script) => {
    assert.notInclude(script, "nohup");
    assert.notInclude(script, " serve --host");
    assert.notMatch(script, /[^&]&\s*$/mu);
  });

  it("serves on the fixed port on every interface with the agent CLIs on PATH", () => {
    const serve = buildSandboxServeScript({ port: SANDBOX_T3_PORT });
    assert.include(serve, `T3_PORT=${SANDBOX_T3_PORT}`);
    assert.include(
      serve,
      'exec env T3CODE_NO_BROWSER=1 "$RUNNER_FILE" serve --host 0.0.0.0 --port "$T3_PORT" --base-dir "$DEFAULT_SERVER_HOME" >>"$LOG_FILE" 2>&1 </dev/null',
    );
    assert.include(serve, 'PATH="$HOME/.local/bin:$PATH"');
    assert.include(serve, "export PATH");
    assert.include(serve, `STATE_DIR="$HOME/.t3/ssh-launch/${SANDBOX_STATE_KEY}"`);
    assert.notInclude(serve, "--host 127.0.0.1");
    assert.notInclude(serve, "pick-port");
    assert.notMatch(serve, /[^&]&\s*$/mu);
  });

  it("decides in the launch step and probes with curl, then wget, node or the release helper", () => {
    const launch = buildSandboxLaunchScript({ runner: RUNNER, port: SANDBOX_T3_PORT });
    const ready = buildSandboxReadyScript({ port: SANDBOX_T3_PORT });
    for (const script of [launch, ready]) {
      assert.include(script, `T3_READY_URL="http://127.0.0.1:$T3_PORT/.well-known/t3/environment"`);
      assert.include(script, 'curl -fsS -m 2 -o /dev/null "$T3_READY_URL"');
      assert.include(script, 'wget -q --timeout=2 --tries=1 -O /dev/null "$T3_READY_URL"');
      assert.include(script, 'node -e "$T3_NODE_PROBE" "$T3_READY_URL"');
      assert.include(script, '"$RUNNER_FILE" __ssh-helper wait-ready "$T3_PORT" 2000 2000');
      assert.include(
        script,
        "unset http_proxy HTTP_PROXY https_proxy HTTPS_PROXY all_proxy ALL_PROXY",
      );
    }
    assert.include(launch, '"logPath":"%s"');
    // The server log can hold a pairing token, so no step echoes it.
    for (const [, script] of allScripts()) {
      assert.notInclude(script, "tail -n");
      assert.notInclude(script, `cat "$LOG_FILE"`);
    }
  });

  it("installs agent CLIs under the user's own prefix and never fails on them", () => {
    const script = buildSandboxAgentClisScript();
    assert.include(script, `install_agent_cli claude ${SANDBOX_AGENT_CLI_PACKAGES.claude}`);
    assert.include(script, `install_agent_cli codex ${SANDBOX_AGENT_CLI_PACKAGES.codex}`);
    for (const pinned of Object.values(SANDBOX_AGENT_CLI_PACKAGES)) {
      assert.match(pinned, /^@[a-z-]+\/[a-z-]+@\d+\.\d+\.\d+$/u);
    }
    assert.include(script, 'npm install -g --prefix "$HOME/.local" --no-audit --no-fund "$2"');
    assert.notInclude(script, 'npm install -g "$2"');
    assert.include(script, `printf '{"npm":false,"failed":""}\\n'`);
    assert.notInclude(script, "set -e");
  });

  it("mints pairing tokens with an explicit TTL", () => {
    assert.include(
      buildSandboxPairingScript({ runner: RUNNER }),
      `auth pairing create --base-dir "$HOME/.t3" --ttl '10m' --json`,
    );
    assert.include(buildSandboxPairingScript({ runner: RUNNER, ttlMinutes: 30 }), "--ttl '30m'");
  });

  it.each([0, 1.5, -5, 24 * 60 + 1, Number.NaN])("rejects a pairing TTL of %s minutes", (ttl) => {
    assert.throws(() => buildSandboxPairingScript({ runner: RUNNER, ttlMinutes: ttl }), RangeError);
  });

  it("rejects a version that is not one exact release", () => {
    assert.throws(
      () => buildSandboxInstallScript(sandboxRunnerOptions({ t3Version: "1.2.3; rm -rf ~" })),
      SshInvalidArchiveVersionError,
    );
  });

  it("passes a release mirror through to the runner", () => {
    const script = buildSandboxInstallScript(
      sandboxRunnerOptions({ t3Version: VERSION, releaseBaseUrl: "https://mirror.example/t3/" }),
    );
    assert.include(script, "T3_RELEASE_BASE_URL='https://mirror.example/t3'");
  });

  it.each([
    ["/home/daytona/.t3/ssh-launch/sandbox/server.log", true],
    ["/root/.t3/ssh-launch/sandbox/server.log", true],
    ["~/.t3/ssh-launch/sandbox/server.log", false],
    ["home/u/.t3/ssh-launch/sandbox/server.log", false],
    ["/etc/passwd", false],
    ["/home/u/../../etc/.t3/ssh-launch/sandbox/server.log", false],
    ['/home/u"; rm -rf ~; "/.t3/ssh-launch/sandbox/server.log', false],
    ["/home/u\n/.t3/ssh-launch/sandbox/server.log", false],
  ] as const)("accepts %j as the server log path: %s", (path, expected) => {
    assert.equal(isSandboxServerLogPath(path), expected);
  });
});

// A stand-in for `t3 serve`: answers the descriptor on the host and port it
// is given, and writes a fake pairing token into its log to prove the scripts
// never surface the log. Marker files in HOME make it fail or hang.
const FAKE_SERVER_JS = `const fs = require("node:fs");
const http = require("node:http");
const home = process.env.HOME;
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
process.stdout.write("Pairing token: LOGGED-PAIRING-SECRET\\n");
fs.writeFileSync(home + "/serve-args", args.join(" ") + "\\n");
fs.writeFileSync(home + "/serve-env", JSON.stringify({ path: process.env.PATH, cwd: process.cwd(), noBrowser: process.env.T3CODE_NO_BROWSER ?? null }));
if (fs.existsSync(home + "/serve-fails")) process.exit(1);
process.on("SIGTERM", () => process.exit(0));
if (fs.existsSync(home + "/serve-hangs")) {
  setInterval(() => {}, 1000);
} else {
  http
    .createServer((request, response) => {
      response.writeHead(request.url === "/.well-known/t3/environment" ? 200 : 404, { "content-type": "application/json" });
      response.end('{"environmentId":"fake"}');
    })
    .listen(Number(value("--port")), value("--host"));
}
`;

// A stand-in for the release executable: `--version`, the SSH readiness
// helper (ready when $HOME/helper-ready exists), `serve` and `auth`.
const fakeT3 = (serverJs: string) => `#!/bin/sh
case "$1" in
  --version) echo "fake" ;;
  __ssh-helper)
    [ "$2" = "wait-ready" ] || exit 2
    [ -f "$HOME/helper-ready" ] ;;
  serve) exec '${process.execPath}' '${serverJs}' "$@" ;;
  auth)
    printf '%s\\n' "$*" >"$HOME/auth-args"
    printf '{\\n  "id": "p1",\\n  "credential": "cred-123"\\n}\\n' ;;
  *) exit 2 ;;
esac
`;

interface ShellResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const canRunLifecycle =
  hostPlatform === "linux" &&
  NodeFS.existsSync("/proc/self/cmdline") &&
  NodeChildProcess.spawnSync("sh", ["-c", "command -v curl"]).status === 0;

describe.skipIf(!canRunLifecycle)("sandbox bootstrap scripts in a real shell", () => {
  let home = "";
  let port = 0;
  let children: Array<NodeChildProcess.ChildProcess> = [];
  const stateDir = () => NodePath.join(home, ".t3", "ssh-launch", SANDBOX_STATE_KEY);
  const logPath = () => NodePath.join(stateDir(), "server.log");
  const readState = (name: string) => {
    const path = NodePath.join(stateDir(), name);
    return NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8").trim() : null;
  };
  const readHome = (name: string) => NodeFS.readFileSync(NodePath.join(home, name), "utf8").trim();
  // The background servers are this process's children, so one that exited
  // stays a zombie until Node reaps it; that counts as gone.
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    try {
      const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
      return !stat.slice(stat.lastIndexOf(") ") + 2).startsWith("Z");
    } catch {
      return false;
    }
  };
  const seedRuntime = (version: string) => {
    const dir = NodePath.join(home, ".t3", "runtime", "versions", version);
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, "t3"), fakeT3(NodePath.join(home, "fake-server.cjs")), {
      mode: 0o755,
    });
    NodeFS.writeFileSync(NodePath.join(dir, ".install-complete"), `${version}\n`);
  };

  // Async so the event loop keeps serving the test's own listeners.
  const runShell = (
    script: string,
    env: Readonly<Record<string, string>> = {},
  ): Promise<ShellResult> =>
    new Promise((resolve, reject) => {
      const child = NodeChildProcess.spawn("sh", ["-s"], {
        env: { HOME: home, PATH: hostPath, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", reject);
      child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
      child.stdin.end(script);
    });

  const launch = (version = VERSION) =>
    runShell(
      buildSandboxLaunchScript({ runner: sandboxRunnerOptions({ t3Version: version }), port }),
    );
  const ready = (
    options: { readonly timeoutSeconds?: number; readonly env?: Record<string, string> } = {},
  ) =>
    runShell(
      buildSandboxReadyScript({
        port,
        timeoutSeconds: options.timeoutSeconds ?? 20,
        startGraceSeconds: 2,
      }),
      options.env,
    );

  /** What an adapter's startBackground does: run the script detached, output to the log path. */
  const startBackground = (log: string, env: Readonly<Record<string, string>> = {}) => {
    const scriptPath = NodePath.join(home, `serve-${children.length}.sh`);
    NodeFS.writeFileSync(scriptPath, buildSandboxServeScript({ port }));
    const fd = NodeFS.openSync(log, "a");
    const child = NodeChildProcess.spawn("sh", [scriptPath], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { HOME: home, PATH: hostPath, ...env },
      cwd: "/",
    });
    NodeFS.closeSync(fd);
    child.unref();
    children.push(child);
    return child;
  };

  /** Spawns a helper process (an external server, a port squatter) and waits for its port. */
  const spawnListener = async (args: ReadonlyArray<string>) => {
    const child = NodeChildProcess.spawn(process.execPath, [...args], {
      detached: true,
      stdio: "ignore",
      env: { HOME: home, PATH: hostPath },
    });
    child.unref();
    children.push(child);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const listening = await new Promise<boolean>((resolve) => {
        const socket = NodeNet.connect(port, "127.0.0.1");
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      });
      if (listening) {
        return child;
      }
      // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- polls a real subprocess for its port; nothing signals when it listens
      await NodeTimersPromises.setTimeout(50);
    }
    throw new Error(`nothing started listening on ${port}`);
  };

  const freePort = () =>
    new Promise<number>((resolve, reject) => {
      const server = NodeNet.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const picked = typeof address === "object" && address !== null ? address.port : 0;
        server.close(() => resolve(picked));
      });
    });

  /** A launch that wants a new server, its background start, and the ready step. */
  const startServer = async (env: Readonly<Record<string, string>> = {}) => {
    const plan = await launch();
    assert.equal(plan.exitCode, 0, plan.stderr);
    const decoded = JSON.parse(plan.stdout) as { reused: boolean; logPath?: string };
    assert.isFalse(decoded.reused);
    assert.equal(decoded.logPath, logPath());
    const child = startBackground(decoded.logPath ?? "", env);
    const result = await ready();
    return { plan, child, ready: result };
  };

  beforeEach(async () => {
    home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sandbox-scripts-"));
    port = await freePort();
    children = [];
    NodeFS.writeFileSync(NodePath.join(home, "fake-server.cjs"), FAKE_SERVER_JS);
    seedRuntime(VERSION);
  });

  afterEach(() => {
    const pid = Number(readState("pid"));
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
      process.kill(pid, "SIGKILL");
    }
    for (const child of children) {
      if (child.pid !== undefined && isAlive(child.pid)) {
        process.kill(child.pid, "SIGKILL");
      }
    }
    NodeFS.rmSync(home, { recursive: true, force: true });
  });

  it("installs from the pinned runtime and leaves no private runner behind", async () => {
    const result = await runShell(buildSandboxInstallScript(RUNNER));
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), '{"installed":true}');
    assert.deepEqual(
      NodeFS.readdirSync(stateDir()).filter((name) => name.startsWith("install-t3")),
      [],
    );
  });

  it("starts in the background, reuses, pairs, stops and restarts the server", async () => {
    const first = await startServer();
    assert.equal(first.ready.exitCode, 0, first.ready.stderr);
    assert.equal(first.ready.stdout.trim(), `{"remotePort":${port},"ready":true}`);
    // The serve script became the server: the pid it recorded is the process
    // the background start spawned, with no shell left in between.
    const pid = Number(readState("pid"));
    assert.equal(pid, first.child.pid);
    assert.isTrue(isAlive(pid));
    assert.equal(readState("managed"), "managed");
    assert.equal(readState("port"), String(port));
    assert.equal(
      readHome("serve-args"),
      `serve --host 0.0.0.0 --port ${port} --base-dir ${home}/.t3`,
    );
    const serveEnv = JSON.parse(readHome("serve-env")) as {
      path: string;
      cwd: string;
      noBrowser: string | null;
    };
    assert.include(serveEnv.path.split(":"), `${home}/.local/bin`);
    assert.equal(serveEnv.cwd, home);
    assert.equal(serveEnv.noBrowser, "1");
    assert.equal(NodeFS.statSync(logPath()).mode & 0o777, 0o600);

    const second = await launch();
    assert.equal(second.exitCode, 0, second.stderr);
    assert.equal(
      second.stdout.trim(),
      `{"remotePort":${port},"serverKind":"managed","reused":true}`,
    );
    assert.equal(Number(readState("pid")), pid);

    const pairing = await runShell(buildSandboxPairingScript({ runner: RUNNER }));
    assert.equal(pairing.exitCode, 0, pairing.stderr);
    assert.include(pairing.stdout, '"credential": "cred-123"');
    assert.equal(
      readHome("auth-args"),
      `auth pairing create --base-dir ${home}/.t3 --ttl 10m --json`,
    );
    assert.deepEqual(
      NodeFS.readdirSync(stateDir()).filter((name) => name.startsWith("pair-t3")),
      [],
    );

    const stop = await runShell(buildSandboxStopScript());
    assert.equal(stop.exitCode, 0, stop.stderr);
    assert.equal(stop.stdout.trim(), '{"stopped":true}');
    assert.isFalse(isAlive(pid));
    assert.isNull(readState("pid"));

    const third = await startServer();
    assert.equal(third.ready.exitCode, 0, third.ready.stderr);
    assert.notEqual(Number(readState("pid")), pid);
    // The previous run's log is kept aside, and the new one starts empty of it.
    assert.isTrue(NodeFS.existsSync(`${logPath()}.previous`));
    assert.include(NodeFS.readFileSync(logPath(), "utf8"), "LOGGED-PAIRING-SECRET");
    for (const output of [
      first.plan,
      first.ready,
      second,
      pairing,
      stop,
      third.plan,
      third.ready,
    ]) {
      assert.notInclude(output.stdout + output.stderr, "LOGGED-PAIRING-SECRET");
    }
  });

  it("does not start a second server over a running one", async () => {
    const first = await startServer();
    assert.equal(first.ready.exitCode, 0, first.ready.stderr);
    const pid = Number(readState("pid"));

    const extra = startBackground(logPath());
    await new Promise<void>((resolve) => extra.once("exit", () => resolve()));

    assert.equal(extra.exitCode, 0);
    assert.equal(Number(readState("pid")), pid);
    assert.isTrue(isAlive(pid));
    assert.equal((await ready()).exitCode, 0);
  });

  it("replaces a running server when the release changes", async () => {
    assert.equal((await startServer()).ready.exitCode, 0);
    const oldPid = Number(readState("pid"));
    seedRuntime("1.2.4");

    const result = await launch("1.2.4");

    assert.equal(result.exitCode, 0, result.stderr);
    assert.include(result.stdout, '"reused":false');
    assert.isFalse(isAlive(oldPid));
    assert.isNull(readState("pid"));
  });

  it("ignores a stale pid that now belongs to another process", async () => {
    NodeFS.mkdirSync(stateDir(), { recursive: true });
    // This test runner is alive but is not `t3 serve`.
    NodeFS.writeFileSync(NodePath.join(stateDir(), "pid"), `${process.pid}\n`);

    const result = await launch();

    assert.equal(result.exitCode, 0, result.stderr);
    assert.include(result.stdout, '"reused":false');
    assert.isTrue(isAlive(process.pid));
  });

  it("reuses a server it did not start without taking ownership", async () => {
    await spawnListener([
      NodePath.join(home, "fake-server.cjs"),
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ]);

    const result = await launch();

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      `{"remotePort":${port},"serverKind":"external","reused":true}`,
    );
    assert.equal(readState("managed"), "external");
    assert.isNull(readState("pid"));
  });

  it("reports a server that dies on startup with a fixed message and cleans up", async () => {
    NodeFS.writeFileSync(NodePath.join(home, "serve-fails"), "");

    const { ready: result } = await startServer();

    assert.equal(result.exitCode, 1);
    assert.include(result.stderr, "T3 server exited before becoming ready");
    assert.notInclude(result.stderr, "LOGGED-PAIRING-SECRET");
    assert.isNull(readState("pid"));
    assert.isNull(readState("managed"));
  });

  it("reports a port something else holds", async () => {
    // Accepts connections but never answers HTTP, so the launch step does not
    // mistake it for a server to reuse.
    await spawnListener([
      "-e",
      `require("node:net").createServer((socket) => socket.destroy()).listen(${port}, "0.0.0.0")`,
    ]);

    const { ready: result } = await startServer();

    assert.equal(result.exitCode, 1);
    assert.include(result.stderr, `Port ${port} is already in use inside the sandbox.`);
    assert.isNull(readState("pid"));
  });

  it("stops a server that never answers and says so", async () => {
    NodeFS.writeFileSync(NodePath.join(home, "serve-hangs"), "");
    const plan = await launch();
    const child = startBackground((JSON.parse(plan.stdout) as { logPath: string }).logPath);

    const result = await ready({ timeoutSeconds: 2 });

    assert.equal(result.exitCode, 1);
    assert.include(result.stderr, `T3 server did not become ready on port ${port}`);
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- gives the real server process time to exit after the script kills it
    await NodeTimersPromises.setTimeout(200);
    assert.isFalse(child.pid !== undefined && isAlive(child.pid));
    assert.isNull(readState("pid"));
  });

  it("reports a background start that never ran", async () => {
    assert.equal((await launch()).exitCode, 0);

    const result = await ready();

    assert.equal(result.exitCode, 1);
    assert.include(result.stderr, "T3 server process did not start");
  });

  it("probes loopback past a proxy the sandbox routes egress through", async () => {
    assert.equal((await startServer()).ready.exitCode, 0);
    // Port 9 (discard) answers nothing: a probe sent through it would fail.
    const proxy = "http://127.0.0.1:9";
    const result = await ready({
      timeoutSeconds: 3,
      env: { http_proxy: proxy, HTTP_PROXY: proxy, all_proxy: proxy, ALL_PROXY: proxy },
    });
    assert.equal(result.exitCode, 0, result.stderr);
  });

  it("sets up git and the model proxy on start, and takes the proxy back once it is gone", async () => {
    const git = (cwd: string, ...args: Array<string>) =>
      NodeChildProcess.spawnSync("git", args, {
        cwd,
        env: { HOME: home, PATH: hostPath },
        encoding: "utf8",
      }).stdout.trim();
    const claudeSettings = NodePath.join(home, ".claude", "settings.json");
    const codexConfig = NodePath.join(home, ".codex", "config.toml");
    const userCodexConfig = 'approval_policy = "never"\n\n[mcp_servers.docs]\ncommand = "docs"\n';
    NodeFS.mkdirSync(NodePath.dirname(claudeSettings), { recursive: true });
    NodeFS.writeFileSync(claudeSettings, JSON.stringify({ model: "opus", env: { FOO: "1" } }));
    NodeFS.mkdirSync(NodePath.dirname(codexConfig), { recursive: true });
    NodeFS.writeFileSync(codexConfig, userCodexConfig);
    const repo = NodePath.join(home, "repo");
    NodeFS.mkdirSync(repo);
    git(repo, "init", "--quiet");
    git(repo, "remote", "add", "origin", "https://github.com/acme/app.git");

    const first = await startServer({
      [SANDBOX_ENV.modelProxyBaseUrl]: "http://radxa:8317",
      [SANDBOX_ENV.modelProxyKey]: "proxy-secret",
      ANTHROPIC_API_KEY: "proxy-secret",
      [SANDBOX_ENV.gitUserName]: "Malik",
      [SANDBOX_ENV.gitUserEmail]: "malik@example.com",
      [SANDBOX_ENV.gitAllowPush]: "0",
    });
    assert.equal(first.ready.exitCode, 0, first.ready.stderr);
    assert.equal(git(home, "config", "--global", "user.name"), "Malik");
    assert.equal(git(home, "config", "--global", "user.email"), "malik@example.com");
    assert.equal(git(home, "config", "--global", "commit.gpgsign"), "false");
    assert.equal(git(repo, "remote", "get-url", "origin"), "https://github.com/acme/app.git");
    assert.equal(
      git(repo, "remote", "get-url", "--push", "origin"),
      "https://push-disabled.invalid/acme/app.git",
    );
    assert.deepEqual(JSON.parse(NodeFS.readFileSync(claudeSettings, "utf8")), {
      model: "opus",
      env: { FOO: "1", ANTHROPIC_BASE_URL: "http://radxa:8317" },
    });
    const proxied = NodeFS.readFileSync(codexConfig, "utf8");
    assert.include(proxied, 'model_provider = "t3-proxy"\n');
    assert.include(
      proxied,
      'model_providers.t3-proxy = { name = "T3 model proxy", base_url = "http://radxa:8317/v1", wire_api = "responses", env_key = "T3_MODEL_PROXY_KEY" }',
    );
    assert.isTrue(proxied.endsWith(userCodexConfig));
    for (const file of [claudeSettings, codexConfig, NodePath.join(home, ".gitconfig")]) {
      assert.notInclude(NodeFS.readFileSync(file, "utf8"), "proxy-secret");
    }

    assert.equal((await runShell(buildSandboxStopScript())).exitCode, 0);
    const second = await startServer({ [SANDBOX_ENV.gitAllowPush]: "1" });
    assert.equal(second.ready.exitCode, 0, second.ready.stderr);
    assert.equal(
      git(repo, "remote", "get-url", "--push", "origin"),
      "https://github.com/acme/app.git",
    );
    assert.deepEqual(JSON.parse(NodeFS.readFileSync(claudeSettings, "utf8")), {
      model: "opus",
      env: { FOO: "1" },
    });
    assert.equal(NodeFS.readFileSync(codexConfig, "utf8"), userCodexConfig);
  });

  describe("without curl", () => {
    // A PATH holding only the tools the ready step needs, plus the probe tool
    // under test, so `command -v` cannot find the host's curl.
    const toolDir = (tools: ReadonlyArray<string>) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(home, "bin-"));
      for (const tool of tools) {
        const resolved = NodeChildProcess.spawnSync("sh", ["-c", `command -v ${tool}`], {
          encoding: "utf8",
        }).stdout.trim();
        if (resolved.startsWith("/")) {
          NodeFS.symlinkSync(resolved, NodePath.join(dir, tool));
        }
      }
      return dir;
    };
    const BASE_TOOLS = ["sh", "cat", "date", "sleep", "sed", "grep", "tr", "rm"];
    const hasTool = (tool: string) =>
      NodeChildProcess.spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;

    it.skipIf(!hasTool("wget"))("probes with wget", async () => {
      await spawnListener([
        NodePath.join(home, "fake-server.cjs"),
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ]);
      const result = await ready({ env: { PATH: toolDir([...BASE_TOOLS, "wget"]) } });
      assert.equal(result.exitCode, 0, result.stderr);
    });

    it("probes with node", async () => {
      await spawnListener([
        NodePath.join(home, "fake-server.cjs"),
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ]);
      const bin = toolDir(BASE_TOOLS);
      NodeFS.symlinkSync(process.execPath, NodePath.join(bin, "node"));
      const result = await ready({ env: { PATH: bin } });
      assert.equal(result.exitCode, 0, result.stderr);
    });

    it("falls back to the release's readiness helper", async () => {
      assert.equal((await launch()).exitCode, 0);
      NodeFS.writeFileSync(NodePath.join(home, "helper-ready"), "");
      const result = await ready({ env: { PATH: toolDir(BASE_TOOLS) } });
      assert.equal(result.exitCode, 0, result.stderr);
    });
  });

  it("finds the home directory when the exec environment has none", () => {
    const script = buildSandboxStopScript();
    const preamble = script.slice(0, script.indexOf("\nfi\n") + "\nfi".length);
    const result = NodeChildProcess.spawnSync("sh", ["-s"], {
      // Just the preamble: the rest of the script would touch the real home.
      input: `${preamble}\nprintf '%s' "$HOME"\n`,
      encoding: "utf8",
      env: { PATH: hostPath },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.isAbove(result.stdout.length, 0);
  });
});
