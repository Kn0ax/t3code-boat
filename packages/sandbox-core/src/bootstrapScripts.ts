/**
 * The shell scripts `SandboxEnvironmentManager` runs inside a sandbox.
 *
 * They build on the SSH path rather than copying it: the pinned-release
 * runner (`buildRemoteT3RunnerScript`), the Node discovery and the stop script
 * come from `@t3tools/ssh/tunnel` unchanged, and every script keeps the SSH
 * state layout (`~/.t3/ssh-launch/<key>/{run-t3.sh,pid,port,managed}`) so the
 * reused stop script finds the server's ownership files where it expects them.
 *
 * Starting the server is the sandbox's own, which is why the SSH launch script
 * is not reused. It binds `t3 serve` to 127.0.0.1 on a scanned free port
 * because ssh forwards loopback, while a provider's preview proxy reaches one
 * fixed port from outside the loopback interface. An exec that starts the
 * server and waits for it never returns, so the launch uses `startBackground`
 * and checks readiness with a separate exec. The sandbox launch is
 * therefore three steps:
 *
 * 1. `launch` (exec) writes the runner, reuses a server that already answers
 *    with the same runner, replaces one whose release changed or that stopped
 *    answering, and otherwise prints the absolute log path for a new one. It
 *    starts nothing.
 * 2. `serve` (`provider.startBackground`) records its own pid and `exec`s into
 *    `t3 serve --host 0.0.0.0 --port <port>`, with `$HOME/.local/bin` (where
 *    the agent CLIs are installed) on its PATH.
 * 3. `ready` (exec) polls the server's descriptor on loopback with curl
 *    (wget, node or the release's own helper when curl is missing) and turns a
 *    server that exited, never started or never answered into a fixed message.
 *
 * Installing runs as its own step first so a cold ~70 MB download gets its own
 * exec budget and failure stage, and the optional agent CLI install sits
 * between the two.
 *
 * Every script starts with a `# t3-sandbox-script: <kind>` line so fakes (and
 * anyone reading a provider's exec log) can tell them apart.
 */
import {
  buildRemoteNodeEnvScript,
  buildRemoteStopScript,
  buildRemoteT3RunnerScript,
  type RemoteT3RunnerOptions,
} from "@t3tools/ssh/tunnel";

/**
 * State directory key under `~/.t3/ssh-launch/`. A sandbox hosts exactly one
 * environment, so the key is a constant rather than a hash of the target.
 */
export const SANDBOX_STATE_KEY = "sandbox";

/**
 * Shell assignments the serve step exports into `t3 serve` and then deletes.
 * A provider whose sandbox env outlives the sandbox (boat copies it into
 * snapshots and forks) writes its secrets here before each start instead.
 */
export const SANDBOX_LAUNCH_ENV_PATH = "~/.t3/launch-env";

/** The launch env file's content; names that are not shell variable names are dropped. */
export function formatSandboxLaunchEnv(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `${name}='${value.replaceAll("'", "'\\''")}'\n`)
    .join("");
}

/** Where `t3 serve` writes its output inside the sandbox (for messages; the launch step prints it absolute). */
export const SANDBOX_SERVER_LOG_PATH = `~/.t3/ssh-launch/${SANDBOX_STATE_KEY}/server.log`;

/**
 * How long a pairing token minted for the automatic connect stays valid. The
 * server's default is 5 minutes; the client exchanges the token right after
 * the bootstrap, but a slow proxy or a retry should not outlive it.
 */
export const SANDBOX_PAIRING_TOKEN_TTL_MINUTES = 10;
const MAX_PAIRING_TOKEN_TTL_MINUTES = 24 * 60;

/** How long the ready step waits for a new server to answer on loopback. */
const READY_TIMEOUT_SECONDS = 60;
/** How long the ready step waits for the background step to record a pid at all. */
const START_GRACE_SECONDS = 15;
/** Bound on one loopback readiness request (`curl -m`, `wget --timeout`). */
const PROBE_TIMEOUT_SECONDS = 2;

export type SandboxScriptKind =
  | "install"
  | "agent-clis"
  | "launch"
  | "serve"
  | "ready"
  | "pair"
  | "stop";

const SCRIPT_KIND_MARKER = "# t3-sandbox-script: ";
const SCRIPT_KINDS: ReadonlyArray<SandboxScriptKind> = [
  "install",
  "agent-clis",
  "launch",
  "serve",
  "ready",
  "pair",
  "stop",
];

/** Which bootstrap script `script` is, from its first line; undefined for anything else. */
export function sandboxScriptKind(script: string): SandboxScriptKind | undefined {
  const newline = script.indexOf("\n");
  const firstLine = newline < 0 ? script : script.slice(0, newline);
  if (!firstLine.startsWith(SCRIPT_KIND_MARKER)) {
    return undefined;
  }
  const kind = firstLine.slice(SCRIPT_KIND_MARKER.length).trim();
  return SCRIPT_KINDS.find((candidate) => candidate === kind);
}

const SERVER_LOG_SUFFIX = `/.t3/ssh-launch/${SANDBOX_STATE_KEY}/server.log`;

/**
 * Whether `path`, as the launch step printed it, is an absolute path to the
 * server log: the only thing the manager passes on as the background log path.
 */
export function isSandboxServerLogPath(path: string): boolean {
  return (
    path.startsWith("/") &&
    path.endsWith(SERVER_LOG_SUFFIX) &&
    !path.split("/").includes("..") &&
    !/[\p{Cc}"\\]/u.test(path)
  );
}

// Provider exec APIs do not all start a login shell, and a few run without
// HOME. Every script, including the reused SSH ones, relies on it.
const SANDBOX_PREAMBLE = `if [ -z "\${HOME:-}" ]; then
  HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
  if [ -z "$HOME" ]; then
    HOME="$(awk -F: -v uid="$(id -u)" '$3 == uid { print $6; exit }' /etc/passwd 2>/dev/null)"
  fi
  if [ -z "$HOME" ]; then
    printf 'Cannot determine the home directory of the sandbox user.\\n' >&2
    exit 1
  fi
  export HOME
fi`;

function withPreamble(kind: SandboxScriptKind, body: string): string {
  return `${SCRIPT_KIND_MARKER}${kind}\n${SANDBOX_PREAMBLE}\n${body}`;
}

/**
 * Fills `@@TOKEN@@` placeholders in order, so a value may itself carry
 * placeholders that later entries fill. Values are inserted through a
 * function because a replacement string would expand `$$`, `$&` and friends:
 * the runner's `"$$"` (its install lock's owner pid) would arrive as `"$"`.
 */
function applyPlaceholders(template: string, replacements: Readonly<Record<string, string>>) {
  let result = template;
  for (const [token, value] of Object.entries(replacements)) {
    result = result.replaceAll(`@@${token}@@`, () => value);
  }
  return result;
}

function stripTrailingNewlines(value: string): string {
  return value.replace(/\n+$/u, "");
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError(`${port} is not a TCP port.`);
  }
}

function assertWholeSeconds(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive whole number of seconds.`);
  }
}

// The state files every launch step shares, named as the SSH scripts name them.
const STATE_FILES = `STATE_DIR="$HOME/.t3/ssh-launch/@@T3_STATE_KEY@@"
T3_PORT=@@T3_PORT@@
PORT_FILE="$STATE_DIR/port"
PID_FILE="$STATE_DIR/pid"
MANAGED_FILE="$STATE_DIR/managed"
LOG_FILE="$STATE_DIR/server.log"
RUNNER_FILE="$STATE_DIR/run-t3.sh"`;

const PROCESS_HELPERS = `pid_alive() {
  kill -0 "$1" 2>/dev/null || return 1
  # A zombie still answers kill -0 until its parent reaps it, and the
  # provider's process supervisor is that parent for a background server.
  case "$(sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null)" in
    Z*) return 1 ;;
  esac
  return 0
}
# The pid file outlives a sandbox stop and resume while the process does not,
# and the pid may since belong to something else: only a live \`t3 serve\` counts.
is_t3_server() {
  pid_alive "$1" || return 1
  [ -r "/proc/$1/cmdline" ] || return 0
  tr '\\000' ' ' <"/proc/$1/cmdline" | grep -q ' serve '
}
wait_for_pid_exit() {
  WAIT_COUNT=0
  while pid_alive "$1" && [ "$WAIT_COUNT" -lt 50 ]; do
    WAIT_COUNT=$((WAIT_COUNT + 1))
    sleep 0.1
  done
  if pid_alive "$1"; then
    kill -9 "$1" 2>/dev/null || true
  fi
}`;

// One request for the server's own descriptor on loopback. The subshell drops
// proxy settings, which providers set to route egress through their own proxy,
// so the request never leaves the sandbox, and all output is discarded: probe
// errors such as \`curl: (7)\` must not reach the stderr the manager classifies.
const PROBE_HELPERS = `T3_READY_URL="http://127.0.0.1:$T3_PORT/.well-known/t3/environment"
T3_NODE_PROBE='const request = require("node:http").get(process.argv[1], { timeout: @@T3_PROBE_TIMEOUT_MS@@ }, (response) => { response.resume(); process.exit(response.statusCode >= 200 && response.statusCode < 300 ? 0 : 1); }); request.on("timeout", () => process.exit(1)); request.on("error", () => process.exit(1));'
probe_ready() (
  unset http_proxy HTTP_PROXY https_proxy HTTPS_PROXY all_proxy ALL_PROXY
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m @@T3_PROBE_TIMEOUT_SECONDS@@ -o /dev/null "$T3_READY_URL"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --timeout=@@T3_PROBE_TIMEOUT_SECONDS@@ --tries=1 -O /dev/null "$T3_READY_URL"
  elif command -v node >/dev/null 2>&1; then
    node -e "$T3_NODE_PROBE" "$T3_READY_URL"
  else
    # The release executable ships the SSH readiness helper, so a bare image
    # can still be probed.
    "$RUNNER_FILE" __ssh-helper wait-ready "$T3_PORT" @@T3_PROBE_TIMEOUT_MS@@ @@T3_PROBE_TIMEOUT_MS@@
  fi
) >/dev/null 2>&1`;

// Version managers (nvm, fnm, asdf, ...) only reach PATH through rc files a
// provider's non-login exec skips. The SSH node discovery finds them; it runs
// in a subshell because nvm.sh and friends are not nounset-clean, and only the
// PATH it settles on comes back. Agent CLIs installed with npm need it, and so
// does `t3 serve`, which spawns them from `$HOME/.local/bin`.
const DISCOVER_PATH = `T3_DISCOVERED_PATH="$(set +eu; ensure_remote_node_path >/dev/null 2>&1; printf '%s' "$PATH")" || true
if [ -n "$T3_DISCOVERED_PATH" ]; then
  PATH="$T3_DISCOVERED_PATH"
fi
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) PATH="$HOME/.local/bin:$PATH" ;;
esac
export PATH`;

const INSTALL_SCRIPT = `set -eu
STATE_DIR="$HOME/.t3/ssh-launch/@@T3_STATE_KEY@@"
INSTALL_RUNNER="$STATE_DIR/install-t3.$$.sh"
mkdir -p "$STATE_DIR"
trap 'rm -f "$INSTALL_RUNNER"' EXIT
# A private copy of the runner: run-t3.sh belongs to the launch script, which
# compares it to decide whether a running server is still the right release.
cat >"$INSTALL_RUNNER" <<'SH'
@@T3_RUNNER_SCRIPT@@
SH
chmod 700 "$INSTALL_RUNNER"
# Resolving the runner downloads, verifies and unpacks the pinned release (a
# no-op once it is installed) and proves the executable starts here.
"$INSTALL_RUNNER" --version >/dev/null
printf '{"installed":true}\\n'
`;

/**
 * The agent CLI releases a sandbox installs when its image lacks them. Pinned
 * so a bad release cannot break every new node and VM at once.
 */
export const SANDBOX_AGENT_CLI_PACKAGES = {
  claude: "@anthropic-ai/claude-code@2.1.304",
  codex: "@openai/codex@0.163.0",
} as const;

// Sandboxes may run as a non-root user, whose `npm install -g`
// fails on the system prefix, so the CLIs always go to a per-user prefix that
// the serve script puts on the server's PATH.
const AGENT_CLIS_SCRIPT = `set -u
@@T3_NODE_ENV_SCRIPT@@
STATE_DIR="$HOME/.t3/ssh-launch/@@T3_STATE_KEY@@"
LOG_FILE="$STATE_DIR/agent-clis.log"
mkdir -p "$STATE_DIR"
@@T3_DISCOVER_PATH@@
if ! command -v npm >/dev/null 2>&1; then
  printf '{"npm":false,"failed":""}\\n'
  exit 0
fi
install_agent_cli() {
  if command -v "$1" >/dev/null 2>&1; then
    return 0
  fi
  printf '== npm install -g --prefix %s %s\\n' "$HOME/.local" "$2" >>"$LOG_FILE"
  npm install -g --prefix "$HOME/.local" --no-audit --no-fund "$2" >>"$LOG_FILE" 2>&1 && command -v "$1" >/dev/null 2>&1
}
T3_FAILED=""
install_agent_cli claude @@T3_CLAUDE_PACKAGE@@ || T3_FAILED="$T3_FAILED claude"
install_agent_cli codex @@T3_CODEX_PACKAGE@@ || T3_FAILED="$T3_FAILED codex"
printf '{"npm":true,"failed":"%s"}\\n' "\${T3_FAILED# }"
`;

// Decides; never starts anything, so the exec running it returns.
const LAUNCH_SCRIPT = `set -eu
@@T3_STATE_FILES@@
RUNNER_NEXT="$STATE_DIR/run-t3.next.$$"
mkdir -p "$STATE_DIR"
trap 'rm -f "$RUNNER_NEXT"' EXIT
cat >"$RUNNER_NEXT" <<'SH'
@@T3_RUNNER_SCRIPT@@
SH
RUNNER_CHANGED=0
if [ ! -f "$RUNNER_FILE" ] || ! cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then
  RUNNER_CHANGED=1
fi
mv "$RUNNER_NEXT" "$RUNNER_FILE"
chmod 700 "$RUNNER_FILE"
# Installs the pinned release if the install step has not (a no-op otherwise),
# so the serve step and the readiness helper find it.
"$RUNNER_FILE" --version >/dev/null
@@T3_PROCESS_HELPERS@@
@@T3_PROBE_HELPERS@@
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -n "$REMOTE_PID" ] && is_t3_server "$REMOTE_PID"; then
  if [ "$RUNNER_CHANGED" -eq 0 ] && { probe_ready || { sleep 1; probe_ready; }; }; then
    printf '{"remotePort":%s,"serverKind":"managed","reused":true}\\n' "$T3_PORT"
    exit 0
  fi
  # Another release, or a server that stopped answering: replace it.
  kill "$REMOTE_PID" 2>/dev/null || true
  wait_for_pid_exit "$REMOTE_PID"
fi
rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"
if probe_ready; then
  # Something this script did not start already answers on the port (a
  # \`t3 serve\` run by hand, say). Reuse it instead of failing to bind; the
  # stop script leaves external servers alone.
  printf '%s\\n' "$T3_PORT" >"$PORT_FILE"
  printf 'external\\n' >"$MANAGED_FILE"
  printf '{"remotePort":%s,"serverKind":"external","reused":true}\\n' "$T3_PORT"
  exit 0
fi
# Headless \`t3 serve\` prints pairing details into its log, so the log stays
# private to the sandbox user and no step ever echoes it.
if [ -f "$LOG_FILE" ]; then
  mv -f "$LOG_FILE" "$LOG_FILE.previous" 2>/dev/null || true
fi
(umask 077 && : >"$LOG_FILE")
printf '{"remotePort":%s,"serverKind":"managed","reused":false,"logPath":"%s"}\\n' "$T3_PORT" "$LOG_FILE"
`;

// Points Claude Code (`env` in ~/.claude/settings.json) and Codex (a provider
// entry in config.toml) at the model proxy, or takes back what an earlier
// launch wrote once the proxy is gone, as a VM made from a snapshot can carry
// it. Only the base URL lands on disk: the key stays in the server's
// environment (ANTHROPIC_API_KEY for Claude, the entry's env_key for Codex).
const MODEL_PROXY_JS = String.raw`const fs = require("node:fs");
const path = require("node:path");
const home = process.env.HOME;
const base = process.env.T3_MODEL_PROXY_BASE_URL || "";
const markerPath = path.join(home, ".t3", "model-proxy-base-url");
const read = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const previous = (read(markerPath) || "").trim();

const claudePath = path.join(home, ".claude", "settings.json");
const claudeText = read(claudePath);
let claude;
try {
  claude = claudeText === undefined ? {} : JSON.parse(claudeText);
} catch {
  claude = undefined;
}
// A settings file that is not a JSON object is the user's to fix, not ours to replace.
if (claude !== null && typeof claude === "object" && !Array.isArray(claude)) {
  const env = { ...(claude.env || {}) };
  if (base !== "") env.ANTHROPIC_BASE_URL = base;
  else if (previous !== "" && env.ANTHROPIC_BASE_URL === previous) delete env.ANTHROPIC_BASE_URL;
  if (Object.keys(env).length === 0) delete claude.env;
  else claude.env = env;
  write(claudePath, JSON.stringify(claude, null, 2) + "\n");
}

const BEGIN = "# >>> T3 model proxy (managed by T3 Code)";
const END = "# <<< T3 model proxy";
const codexPath = path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "config.toml");
const codexText = read(codexPath);
let toml = codexText || "";
const start = toml.indexOf(BEGIN);
const stop = toml.indexOf(END);
if (start >= 0 && stop > start) toml = toml.slice(0, start) + toml.slice(stop + END.length).replace(/^\n/, "");
// The block goes first because model_provider is a top-level key, and uses a
// dotted key rather than a table header so the user's own top-level keys
// after it stay top-level. TOML allows model_provider once, so a user's own wins.
if (base !== "" && !/^model_provider\s*=/m.test(toml)) {
  toml = [
    BEGIN,
    'model_provider = "t3-proxy"',
    'model_providers.t3-proxy = { name = "T3 model proxy", base_url = ' + JSON.stringify(base + "/v1") + ', wire_api = "responses", env_key = "T3_MODEL_PROXY_KEY" }',
    END,
    "",
  ].join("\n") + toml;
}
if (toml !== (codexText || "")) write(codexPath, toml);

if (base !== "") write(markerPath, base + "\n");
else fs.rmSync(markerPath, { force: true });
`;

// Git on a node or VM: the identity commits carry, no signing key to ask
// for, and, unless the user allowed pushing, pushes to GitHub rewritten to a
// host that never resolves, so even a write-scoped GH_TOKEN cannot push.
// Fetch and clone ignore pushInsteadOf.
const AGENT_SETUP = `if command -v git >/dev/null 2>&1; then
  # A forwarded GitHub token (GH_TOKEN) lets git fetch (and push, when allowed)
  # GitHub over HTTPS. The helper reads the token when git asks, so it never lands on disk.
  if [ -n "\${GH_TOKEN:-}" ]; then
    git config --global credential.https://github.com.helper '!f() { test "$1" = get && test -n "\${GH_TOKEN:-}" && printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; }; f' || true
  fi
  if [ -n "\${T3_GIT_USER_NAME:-}" ]; then
    git config --global user.name "$T3_GIT_USER_NAME" || true
  fi
  if [ -n "\${T3_GIT_USER_EMAIL:-}" ]; then
    git config --global user.email "$T3_GIT_USER_EMAIL" || true
  fi
  git config --global commit.gpgsign false || true
  git config --global --unset-all url.https://push-disabled.invalid/.pushInsteadOf >/dev/null 2>&1 || true
  if [ "\${T3_GIT_ALLOW_PUSH:-0}" != "1" ]; then
    for T3_PUSH_URL in https://github.com/ git@github.com: ssh://git@github.com/; do
      git config --global --add url.https://push-disabled.invalid/.pushInsteadOf "$T3_PUSH_URL" || true
    done
  fi
fi
if [ -n "\${T3_MODEL_PROXY_BASE_URL:-}" ] || [ -f "$HOME/.t3/model-proxy-base-url" ]; then
  if command -v node >/dev/null 2>&1; then
    node - <<'JS' || printf 'Could not configure the agent CLIs for the model proxy.\\n' >&2
@@T3_MODEL_PROXY_JS@@
JS
  fi
fi`;

// Runs through provider.startBackground. It becomes the server (\`exec\`), so
// the pid it records is the server's and the stop script can signal it.
const SERVE_SCRIPT = `set -eu
@@T3_NODE_ENV_SCRIPT@@
@@T3_STATE_FILES@@
DEFAULT_SERVER_HOME="$HOME/.t3"
@@T3_PROCESS_HELPERS@@
mkdir -p "$STATE_DIR"
if [ -f "$HOME/.t3/launch-env" ]; then
  set -a
  . "$HOME/.t3/launch-env"
  set +a
  rm -f "$HOME/.t3/launch-env"
fi
# A second start would overwrite the pid file before failing to bind and
# orphan the server that owns the port.
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -n "$REMOTE_PID" ] && [ "$REMOTE_PID" != "$$" ] && is_t3_server "$REMOTE_PID"; then
  printf 'A T3 server is already running in the sandbox (pid %s); not starting another.\\n' "$REMOTE_PID"
  exit 0
fi
printf '%s\\n' "$$" >"$PID_FILE"
printf '%s\\n' "$T3_PORT" >"$PORT_FILE"
printf 'managed\\n' >"$MANAGED_FILE"
@@T3_DISCOVER_PATH@@
# The SSH path starts the server from the login directory; so does this one,
# whatever directory the provider starts background processes in.
cd "$HOME"
# What \`nohup\` did for the SSH-style launch: an ignored SIGHUP stays ignored
# across exec, so the provider closing the session that started this does not
# take the server down.
trap '' HUP
@@T3_AGENT_SETUP@@
# The server's output goes to the log the ready and stop steps know whatever
# the provider does with its own log path, and stdin is never a provider pipe.
exec env T3CODE_NO_BROWSER=1 "$RUNNER_FILE" serve --host 0.0.0.0 --port "$T3_PORT" --base-dir "$DEFAULT_SERVER_HOME" >>"$LOG_FILE" 2>&1 </dev/null
`;

// Waits for the server the serve step started. Failures print fixed messages
// and never the log, which can hold pairing details.
const READY_SCRIPT = `set -u
@@T3_STATE_FILES@@
@@T3_PROCESS_HELPERS@@
@@T3_PROBE_HELPERS@@
T3_STARTED_AT="$(date +%s)"
T3_OUTCOME="timeout"
REMOTE_PID=""
while :; do
  if probe_ready; then
    printf '{"remotePort":%s,"ready":true}\\n' "$T3_PORT"
    exit 0
  fi
  T3_ELAPSED=$(($(date +%s) - T3_STARTED_AT))
  # The background step may not have recorded its pid yet when this starts.
  REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$REMOTE_PID" ]; then
    if ! pid_alive "$REMOTE_PID"; then
      T3_OUTCOME="exited"
      break
    fi
  elif [ "$T3_ELAPSED" -ge @@T3_START_GRACE_SECONDS@@ ]; then
    T3_OUTCOME="not-started"
    break
  fi
  if [ "$T3_ELAPSED" -ge @@T3_READY_TIMEOUT_SECONDS@@ ]; then
    break
  fi
  sleep 0.5 2>/dev/null || sleep 1
done
if grep -q 'EADDRINUSE' "$LOG_FILE" 2>/dev/null; then
  printf 'Port %s is already in use inside the sandbox.\\n' "$T3_PORT" >&2
elif grep -q 'already running for' "$LOG_FILE" 2>/dev/null; then
  printf 'Another T3 server is already running in the sandbox.\\n' >&2
elif [ "$T3_OUTCOME" = "exited" ]; then
  printf 'T3 server exited before becoming ready; see %s.\\n' "$LOG_FILE" >&2
elif [ "$T3_OUTCOME" = "not-started" ]; then
  printf 'T3 server process did not start; see %s.\\n' "$LOG_FILE" >&2
else
  printf 'T3 server did not become ready on port %s; see %s.\\n' "$T3_PORT" "$LOG_FILE" >&2
fi
# Only a server that is still running gets stopped: the pid of one that
# exited may already belong to something else.
if [ "$T3_OUTCOME" = "timeout" ] && [ -n "$REMOTE_PID" ] && pid_alive "$REMOTE_PID"; then
  kill "$REMOTE_PID" 2>/dev/null || true
  wait_for_pid_exit "$REMOTE_PID"
fi
rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"
exit 1
`;

// The SSH pairing script cannot set a TTL and rewrites run-t3.sh, which the
// launch step owns; this one runs a private copy of the runner instead.
const PAIR_SCRIPT = `set -eu
STATE_DIR="$HOME/.t3/ssh-launch/@@T3_STATE_KEY@@"
PAIR_RUNNER="$STATE_DIR/pair-t3.$$.sh"
mkdir -p "$STATE_DIR"
trap 'rm -f "$PAIR_RUNNER"' EXIT
cat >"$PAIR_RUNNER" <<'SH'
@@T3_RUNNER_SCRIPT@@
SH
chmod 700 "$PAIR_RUNNER"
"$PAIR_RUNNER" auth pairing create --base-dir "$HOME/.t3" --ttl @@T3_PAIRING_TTL@@ --json
`;

function launchStepPlaceholders(port: number): Readonly<Record<string, string>> {
  assertPort(port);
  return {
    // Composite snippets first: their own placeholders are filled by the
    // entries after them.
    T3_STATE_FILES: STATE_FILES,
    T3_PROCESS_HELPERS: PROCESS_HELPERS,
    T3_PROBE_HELPERS: PROBE_HELPERS,
    T3_STATE_KEY: SANDBOX_STATE_KEY,
    T3_PORT: String(port),
    T3_PROBE_TIMEOUT_SECONDS: String(PROBE_TIMEOUT_SECONDS),
    T3_PROBE_TIMEOUT_MS: String(PROBE_TIMEOUT_SECONDS * 1_000),
  };
}

/** Runner options for a sandbox: always the self-contained release archive, never a dev script. */
export function sandboxRunnerOptions(input: {
  readonly t3Version: string;
  readonly releaseBaseUrl?: string | undefined;
}): RemoteT3RunnerOptions {
  return {
    archiveVersion: input.t3Version,
    ...(input.releaseBaseUrl === undefined ? {} : { releaseBaseUrl: input.releaseBaseUrl }),
  };
}

/**
 * Installs the pinned release. Throws `SshInvalidArchiveVersionError` or
 * `SshMissingRunnerError` (from the SSH runner builder) for a bad version.
 */
export function buildSandboxInstallScript(runner: RemoteT3RunnerOptions): string {
  return withPreamble(
    "install",
    applyPlaceholders(INSTALL_SCRIPT, {
      T3_STATE_KEY: SANDBOX_STATE_KEY,
      T3_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteT3RunnerScript(runner)),
    }),
  );
}

/**
 * Installs the Claude Code and Codex CLIs the image lacks into
 * `$HOME/.local`, when npm exists. Always exits 0 and reports what it skipped
 * as JSON: a missing agent CLI must never fail the bootstrap.
 */
export function buildSandboxAgentClisScript(): string {
  return withPreamble(
    "agent-clis",
    applyPlaceholders(AGENT_CLIS_SCRIPT, {
      T3_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(),
      T3_STATE_KEY: SANDBOX_STATE_KEY,
      T3_DISCOVER_PATH: DISCOVER_PATH,
      T3_CLAUDE_PACKAGE: SANDBOX_AGENT_CLI_PACKAGES.claude,
      T3_CODEX_PACKAGE: SANDBOX_AGENT_CLI_PACKAGES.codex,
    }),
  );
}

/**
 * Step 1 of the launch, run with `exec`: reuses or replaces a running server
 * and prints `{"serverKind","reused"}`, plus the absolute `logPath` for the
 * serve step when a new server has to start. Never starts one itself.
 */
export function buildSandboxLaunchScript(input: {
  readonly runner: RemoteT3RunnerOptions;
  readonly port: number;
}): string {
  return withPreamble(
    "launch",
    applyPlaceholders(LAUNCH_SCRIPT, {
      ...launchStepPlaceholders(input.port),
      T3_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteT3RunnerScript(input.runner)),
    }),
  );
}

/**
 * Step 2 of the launch, run with `provider.startBackground`: becomes
 * `t3 serve` on 0.0.0.0:`port`, using the runner the launch step wrote.
 */
export function buildSandboxServeScript(input: { readonly port: number }): string {
  return withPreamble(
    "serve",
    applyPlaceholders(SERVE_SCRIPT, {
      ...launchStepPlaceholders(input.port),
      T3_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(),
      T3_DISCOVER_PATH: DISCOVER_PATH,
      T3_AGENT_SETUP: AGENT_SETUP,
      T3_MODEL_PROXY_JS: stripTrailingNewlines(MODEL_PROXY_JS),
    }),
  );
}

/**
 * Step 3 of the launch, run with `exec`: exits 0 once the server answers on
 * loopback, or 1 with a fixed message (and the server stopped) when it exited,
 * never started, or did not answer in time. The waits are overridable for tests.
 */
export function buildSandboxReadyScript(input: {
  readonly port: number;
  readonly timeoutSeconds?: number;
  readonly startGraceSeconds?: number;
}): string {
  const timeoutSeconds = input.timeoutSeconds ?? READY_TIMEOUT_SECONDS;
  const startGraceSeconds = input.startGraceSeconds ?? START_GRACE_SECONDS;
  assertWholeSeconds("timeoutSeconds", timeoutSeconds);
  assertWholeSeconds("startGraceSeconds", startGraceSeconds);
  return withPreamble(
    "ready",
    applyPlaceholders(READY_SCRIPT, {
      ...launchStepPlaceholders(input.port),
      T3_READY_TIMEOUT_SECONDS: String(timeoutSeconds),
      T3_START_GRACE_SECONDS: String(startGraceSeconds),
    }),
  );
}

/**
 * Mints a one-time pairing token valid for `ttlMinutes` (default
 * `SANDBOX_PAIRING_TOKEN_TTL_MINUTES`) and prints the credential JSON.
 */
export function buildSandboxPairingScript(input: {
  readonly runner: RemoteT3RunnerOptions;
  readonly ttlMinutes?: number;
}): string {
  const ttlMinutes = input.ttlMinutes ?? SANDBOX_PAIRING_TOKEN_TTL_MINUTES;
  if (
    !Number.isInteger(ttlMinutes) ||
    ttlMinutes < 1 ||
    ttlMinutes > MAX_PAIRING_TOKEN_TTL_MINUTES
  ) {
    throw new RangeError(
      `A pairing token TTL must be 1 to ${MAX_PAIRING_TOKEN_TTL_MINUTES} whole minutes.`,
    );
  }
  return withPreamble(
    "pair",
    applyPlaceholders(PAIR_SCRIPT, {
      T3_STATE_KEY: SANDBOX_STATE_KEY,
      T3_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteT3RunnerScript(input.runner)),
      // `t3 auth pairing create --ttl` takes values like `10m`.
      T3_PAIRING_TTL: `'${ttlMinutes}m'`,
    }),
  );
}

/** The SSH stop script: stops a server the launch steps started, never an external one. */
export function buildSandboxStopScript(): string {
  return withPreamble("stop", buildRemoteStopScript(SANDBOX_STATE_KEY));
}
