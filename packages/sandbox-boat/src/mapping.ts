/**
 * How contract values map onto boat's, with no I/O: sizes, the region,
 * auto-stop, per-sandbox env, sandbox names, states and hosted-port URLs.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto is a service; these pure helpers carry no requirements.
import * as NodeCrypto from "node:crypto";

import type { CreateSandboxRequestTypeEnum } from "@boatdev/sdk";
import type {
  SandboxExposedPort,
  SandboxProviderFailure,
  SandboxSize,
  SandboxStatus,
} from "@t3tools/sandbox-core";
import * as Result from "effect/Result";

import type { BoatSandbox } from "./client.ts";

/** boat machine types per size: `small` bills at half rate, `large` at twice the default. */
export const BOAT_SIZE_TYPES: Readonly<Record<SandboxSize, CreateSandboxRequestTypeEnum>> = {
  small: "small",
  medium: "default",
  large: "large",
};

/**
 * boat's only region. It runs every sandbox in the EU (Germany, Finland or
 * France) and its API has no way to pick one, so this is the one region id
 * the adapter accepts; any other is refused rather than silently ignored.
 */
const BOAT_REGION = "eu";

/** Whether a create's region is one boat can honor: none, or `BOAT_REGION`. */
export function isBoatRegion(region: string | undefined): boolean {
  const normalized = region?.trim().toLowerCase() ?? "";
  return normalized === "" || normalized === BOAT_REGION;
}

/**
 * boat's auto-stop is a deadline, not idle time: a sandbox archives
 * `ttlSeconds` after it (re)started, busy or not. `null` disables it.
 *
 * - 0 or +Infinity minutes: `null` (never), as the contract's 0 asks.
 * - NaN or negative: `undefined`, so boat applies its own 1 hour default
 *   rather than a malformed value turning auto-stop off and billing forever.
 * - Otherwise whole seconds, at least one minute.
 */
export function boatTtlSeconds(idleTimeoutMinutes: number): number | null | undefined {
  if (Number.isNaN(idleTimeoutMinutes) || idleTimeoutMinutes < 0) {
    return undefined;
  }
  if (idleTimeoutMinutes === 0 || idleTimeoutMinutes === Number.POSITIVE_INFINITY) {
    return null;
  }
  return Math.max(60, Math.round(idleTimeoutMinutes * 60));
}

const BOAT_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Names boat keeps for itself and rejects with `invalid_env`. */
const BOAT_RESERVED_ENV_NAMES: ReadonlySet<string> = new Set([
  "ASCII_TOKEN",
  "ASCII_API_URL",
  "AGENT_ID",
  "PRODUCT_MODE",
  "ENVIRONMENT_ID",
  "BOAT_ID",
  "SERVICE_PREVIEW_TOKEN",
  "BOAT_CLI_TOKEN",
]);

const MAX_BOAT_ENV_VARS = 100;
export const MAX_BOAT_ENV_BYTES = 64 * 1024;

export type BoatEnvProblem = "invalid-name" | "reserved-name" | "too-many" | "too-large";

const utf8 = new TextEncoder();

/**
 * Why boat would refuse this per-sandbox env, checked before any billable
 * call. Only names are inspected for the reason; values are only measured,
 * and the result never quotes either. Size counts name and value bytes, the
 * least boat can mean by "64KB total", so nothing it accepts is refused here.
 */
export function boatEnvProblem(env: Readonly<Record<string, string>>): BoatEnvProblem | undefined {
  const names = Object.keys(env);
  if (names.length > MAX_BOAT_ENV_VARS) {
    return "too-many";
  }
  let bytes = 0;
  for (const name of names) {
    if (!BOAT_ENV_NAME.test(name)) {
      return "invalid-name";
    }
    if (BOAT_RESERVED_ENV_NAMES.has(name)) {
      return "reserved-name";
    }
    bytes += utf8.encode(name).byteLength + utf8.encode(env[name] ?? "").byteLength;
  }
  return bytes > MAX_BOAT_ENV_BYTES ? "too-large" : undefined;
}

/** Marks a sandbox as T3's in the boat dashboard and in `list`. */
export const BOAT_SANDBOX_NAME_PREFIX = "t3code: ";

// boat truncates names past 120 characters.
const MAX_BOAT_NAME_LENGTH = 120;

// What `list` matches on: the prefix without its space, which boat could trim
// from a name that is nothing else.
const T3_NAME_MARKER = BOAT_SANDBOX_NAME_PREFIX.trimEnd();

/**
 * Starts a label that is already a whole T3 name, as boat VMs' labels are
 * (`t3:<repository>[:<task>]`); such a label is the name, unprefixed.
 */
const T3_NAMED_LABEL_PREFIX = "t3:";

/**
 * The name the adapter gives a sandbox: the prefix plus the label with
 * whitespace runs collapsed (`sandbox` for a blank one), or a label that
 * is already a T3 name, cut at 120 code points so a cut never splits a
 * surrogate pair.
 */
export function boatSandboxName(label: string): string {
  const collapsed = label.replace(/\s+/gu, " ").trim();
  const name = Array.from(
    collapsed.startsWith(T3_NAMED_LABEL_PREFIX)
      ? collapsed
      : `${BOAT_SANDBOX_NAME_PREFIX}${collapsed || "sandbox"}`,
  );
  return name.length > MAX_BOAT_NAME_LENGTH
    ? name.slice(0, MAX_BOAT_NAME_LENGTH).join("")
    : name.join("");
}

export function isT3Sandbox(sandbox: Pick<BoatSandbox, "name">): boolean {
  return (
    sandbox.name?.startsWith(T3_NAME_MARKER) === true ||
    sandbox.name?.startsWith(T3_NAMED_LABEL_PREFIX) === true
  );
}

/** The label a sandbox shows in T3: its name without the prefix, else the id. */
export function boatSandboxLabel(sandbox: Pick<BoatSandbox, "id" | "name">): string {
  const name = sandbox.name ?? "";
  const label = name.startsWith(T3_NAME_MARKER) ? name.slice(T3_NAME_MARKER.length).trim() : name;
  return label.length > 0 ? label : sandbox.id;
}

const BOAT_STATUS: Readonly<Record<string, SandboxStatus>> = {
  init: "creating",
  provisioning: "creating",
  provisioned: "creating",
  cloning: "creating",
  ready: "running",
  idle: "running",
  running: "running",
  archiving: "stopping",
  archived: "stopped",
  error: "error",
  // A create or fork that never got a machine; boat answers 404 after reporting it once.
  cancelled: "destroyed",
};

/** A boat sandbox as a contract status; anything unrecognized reads as an error. */
export function boatSandboxStatus(sandbox: Pick<BoatSandbox, "state" | "stop">): SandboxStatus {
  const status = BOAT_STATUS[sandbox.state] ?? "error";
  // An accepted stop keeps the sandbox running until its disk is saved
  // (`failing` retries until it is), so it already reads as stopping.
  const stop = sandbox.stop?.status;
  if (status === "running" && (stop === "pending" || stop === "failing")) {
    return "stopping";
  }
  return status;
}

/**
 * The `Idempotency-Key` for a create: fixed-length and header-safe whatever
 * the caller's key looks like (non-ASCII text would make fetch reject the
 * request), and the same for the same key, so boat answers a retried create
 * with the sandbox the first attempt made.
 */
export function boatIdempotencyKey(idempotencyKey: string): string {
  const digest = NodeCrypto.createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
  return `t3code-${digest.slice(0, 40)}`;
}

/**
 * Keep Boat's access token out of the base URL: HTTP and WebSocket forwarding
 * authenticate with the same cookie that Boat's `_token` redirect sets.
 */
export function boatHostedPort(
  raw: string | undefined,
): Result.Result<SandboxExposedPort, SandboxProviderFailure> {
  if (raw === undefined || !URL.canParse(raw)) {
    return Result.fail("provider-error");
  }
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return Result.fail("provider-error");
  }
  if (url.pathname !== "/" || url.hash !== "" || url.username !== "" || url.password !== "") {
    return Result.fail("unsupported");
  }
  const params = [...url.searchParams];
  if (params.length === 0) {
    return Result.succeed({ httpBaseUrl: url.origin, headers: {} });
  }
  const token = url.searchParams.get("_token");
  if (
    params.length !== 1 ||
    params[0]?.[0] !== "_token" ||
    token === null ||
    // RFC 6265 cookie-octet excludes separators, quotes and control characters.
    !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/u.test(token) ||
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".on.boat.dev") ||
    url.port !== ""
  ) {
    return Result.fail("unsupported");
  }
  return Result.succeed({
    httpBaseUrl: url.origin,
    headers: { Cookie: `_port_auth=${token}` },
  });
}

/**
 * boat resolves relative file paths against the sandbox work directory, which
 * is the home directory (`/home/user`), and does not expand `~`.
 */
export function boatFilePath(path: string): string {
  if (path === "~") {
    return ".";
  }
  return path.startsWith("~/") ? path.slice(2) || "." : path;
}
