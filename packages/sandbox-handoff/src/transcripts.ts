/**
 * Native agent transcripts: where Codex and Claude keep them, and how to move
 * one to a different working directory.
 *
 * The path rules mirror the server's. They are restated here rather than
 * imported because they live in `apps/server` (Codex, Claude) and
 * `@t3tools/provider-core` (`~` expansion), which this package does not
 * depend on; each rule cites its source so the copies can be kept in step.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  HandoffInvalidInputError,
  HandoffTranscriptNotFoundError,
  type HandoffProvider,
} from "./errors.ts";

/**
 * `expandHomePath` from packages/provider-core/src/server/pathExpansion.ts:17-24:
 * a leading `~`, `~/` or `~\` becomes the home directory, anything else is
 * returned unchanged.
 */
function expandHomePath(path: Path.Path, value: string, home: string): string {
  if (!value) return value;
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(home, value.slice(2));
  }
  return value;
}

/**
 * The shared Codex home a Codex instance reads sessions from:
 * apps/server/src/provider/Drivers/CodexHomeLayout.ts:37-41 and :48. A shadow
 * home links `sessions/` back to the shared one (`KNOWN_SHARED_DIRECTORIES`,
 * :18-29), so the shared home is always the one that holds transcripts.
 * `homePath` is the instance's `homePath` setting.
 */
const resolveCodexHomePath = Effect.fn("sandboxHandoff.resolveCodexHomePath")(function* (
  homePath?: string,
) {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const expanded =
    homePath && homePath.trim().length > 0
      ? expandHomePath(path, homePath, home)
      : path.join(home, ".codex");
  return path.resolve(expanded);
});

/**
 * The Claude config directory the CLI uses, by
 * apps/server/src/provider/Drivers/ClaudeHome.ts:18-34: the instance's
 * `homePath`, then an inherited CLAUDE_CONFIG_DIR (not `~`-expanded, as the
 * CLI sees it), then `~/.claude`.
 */
const resolveClaudeConfigDir = Effect.fn("sandboxHandoff.resolveClaudeConfigDir")(function* (
  homePath?: string,
) {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const configured = homePath?.trim() ?? "";
  if (configured.length > 0) {
    return path.resolve(expandHomePath(path, configured, home));
  }
  const inherited = (yield* HostProcess.Environment).CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(home, ".claude"));
});

/** Claude Code's cap on a project directory name before it appends a hash. */
const CLAUDE_PROJECT_DIR_NAME_MAX_LENGTH = 200;

// Java's String.hashCode, which the Agent SDK uses for the long-path suffix.
function stringHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}

/**
 * The directory under `<config>/projects/` that Claude Code files a session
 * under: every character outside `[a-zA-Z0-9]` becomes `-`. Restated from
 * @anthropic-ai/claude-agent-sdk 0.3.276 (`sdk.mjs`, `Tu`/`fm`), which applies
 * it to the realpath of the session's cwd (NFC-normalized on macOS).
 *
 * Names longer than 200 characters are cut and get a hash suffix. This
 * returns the SDK's Node hash; the Bun-built CLI hashes differently, which
 * is why the SDK itself finds long-path directories by prefix and why
 * `locateNativeTranscript` falls back to a scan.
 */
export function claudeProjectDirName(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= CLAUDE_PROJECT_DIR_NAME_MAX_LENGTH) {
    return sanitized;
  }
  return `${sanitized.slice(0, CLAUDE_PROJECT_DIR_NAME_MAX_LENGTH)}-${Math.abs(stringHash(cwd)).toString(36)}`;
}

export interface LocateNativeTranscriptInput {
  readonly provider: HandoffProvider;
  /** Codex thread id or Claude session id (`nativeThreadRef.nativeId`). */
  readonly nativeThreadId: string;
  /** The session's working directory. */
  readonly cwd: string;
  /** The Codex instance's `homePath` setting. */
  readonly codexHome?: string;
  /** The Claude instance's `homePath` setting. */
  readonly claudeConfigDir?: string;
}

export interface NativeTranscriptLocation {
  readonly provider: HandoffProvider;
  readonly nativeThreadId: string;
  /** The provider home searched: the shared CODEX_HOME, or CLAUDE_CONFIG_DIR. */
  readonly homePath: string;
  /** Absolute path of the JSONL transcript. */
  readonly path: string;
  /** `path` relative to `homePath`, with `/` separators. */
  readonly relativePath: string;
  readonly sizeBytes: number;
  /**
   * Claude only: `<project dir>/<session id>/`, where newer CLIs keep subagent
   * transcripts and oversized tool results, when it exists.
   */
  readonly companionDirectory?: string;
}

// Native ids become file names, so anything that could leave the directory is refused.
const NATIVE_THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const CODEX_ROLLOUT_PREFIX = "rollout-";

export const locateNativeTranscript = Effect.fn("sandboxHandoff.locateNativeTranscript")(function* (
  input: LocateNativeTranscriptInput,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!NATIVE_THREAD_ID_PATTERN.test(input.nativeThreadId) || input.nativeThreadId.includes("..")) {
    return yield* new HandoffInvalidInputError({
      field: "nativeThreadId",
      reason: `'${input.nativeThreadId}' is not a provider session id`,
    });
  }

  // Transcript discovery is best-effort like AgentSessionScanner: an
  // unreadable directory reads as empty and the not-found error lists it.
  const listDirectory = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const fileInfo = (filePath: string) =>
    fileSystem.stat(filePath).pipe(
      Effect.map((info) => (info.type === "File" ? Option.some(info) : Option.none())),
      Effect.orElseSucceed(() => Option.none<FileSystem.File.Info>()),
    );
  const isDirectory = (directoryPath: string) =>
    fileSystem.stat(directoryPath).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
  const toLocation = (
    homePath: string,
    filePath: string,
    info: FileSystem.File.Info,
    companionDirectory?: string,
  ): NativeTranscriptLocation => ({
    provider: input.provider,
    nativeThreadId: input.nativeThreadId,
    homePath,
    path: filePath,
    relativePath: path.relative(homePath, filePath).split(path.sep).join("/"),
    sizeBytes: Number(info.size),
    ...(companionDirectory === undefined ? {} : { companionDirectory }),
  });

  if (input.provider === "codex") {
    const homePath = yield* resolveCodexHomePath(input.codexHome);
    const sessionsDir = path.join(homePath, "sessions");
    const archivedDir = path.join(homePath, "archived_sessions");
    const suffix = `-${input.nativeThreadId}.jsonl`;
    const isRollout = (entry: string) =>
      entry.startsWith(CODEX_ROLLOUT_PREFIX) && entry.endsWith(suffix);

    // sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl (AgentSessionScanner.ts:978-1014),
    // newest first because a moved session is usually a recent one.
    const newestFirst = (entries: ReadonlyArray<string>) => entries.toSorted().toReversed();
    for (const year of newestFirst(yield* listDirectory(sessionsDir))) {
      for (const month of newestFirst(yield* listDirectory(path.join(sessionsDir, year)))) {
        for (const day of newestFirst(yield* listDirectory(path.join(sessionsDir, year, month)))) {
          const directory = path.join(sessionsDir, year, month, day);
          for (const entry of yield* listDirectory(directory)) {
            if (!isRollout(entry)) continue;
            const filePath = path.join(directory, entry);
            const info = yield* fileInfo(filePath);
            if (Option.isSome(info)) return toLocation(homePath, filePath, info.value);
          }
        }
      }
    }
    // An archived session sits flat in archived_sessions/ until
    // `thread/unarchive` (CodexAdapterV2.ts:6512-6528) moves it back.
    for (const entry of yield* listDirectory(archivedDir)) {
      if (!isRollout(entry)) continue;
      const filePath = path.join(archivedDir, entry);
      const info = yield* fileInfo(filePath);
      if (Option.isSome(info)) return toLocation(homePath, filePath, info.value);
    }
    return yield* new HandoffTranscriptNotFoundError({
      provider: "codex",
      nativeThreadId: input.nativeThreadId,
      searched: [sessionsDir, archivedDir],
    });
  }

  const homePath = yield* resolveClaudeConfigDir(input.claudeConfigDir);
  const projectsDir = path.join(homePath, "projects");
  const fileName = `${input.nativeThreadId}.jsonl`;
  const realCwd = yield* fileSystem.realPath(input.cwd).pipe(Effect.orElseSucceed(() => input.cwd));
  // The CLI names the directory after the realpath, NFC-normalized on macOS.
  const candidateDirs = [
    ...new Set(
      [realCwd, realCwd.normalize("NFC"), input.cwd, input.cwd.normalize("NFC")].map((cwd) =>
        path.join(projectsDir, claudeProjectDirName(cwd)),
      ),
    ),
  ];
  const found = Effect.fn("sandboxHandoff.foundClaudeTranscript")(function* (
    directory: string,
    info: FileSystem.File.Info,
  ) {
    const companion = path.join(directory, input.nativeThreadId);
    return toLocation(
      homePath,
      path.join(directory, fileName),
      info,
      (yield* isDirectory(companion)) ? companion : undefined,
    );
  });
  for (const directory of candidateDirs) {
    const info = yield* fileInfo(path.join(directory, fileName));
    if (Option.isSome(info)) return yield* found(directory, info.value);
  }
  // Session ids are UUIDs, so any project directory holding this file is
  // the session's: covers long paths whose hash suffix differs between the
  // SDK and the CLI, and a cwd that has since moved or been deleted.
  for (const entry of (yield* listDirectory(projectsDir)).toSorted()) {
    const directory = path.join(projectsDir, entry);
    if (candidateDirs.includes(directory)) continue;
    const info = yield* fileInfo(path.join(directory, fileName));
    if (Option.isSome(info)) return yield* found(directory, info.value);
  }
  return yield* new HandoffTranscriptNotFoundError({
    provider: "claude",
    nativeThreadId: input.nativeThreadId,
    searched: [...candidateDirs, projectsDir],
  });
});

const CODEX_ROLLOUT_DATE_PATTERN = /^rollout-(\d{4})-(\d{2})-(\d{2})T/;

/**
 * Where a located transcript goes under the sandbox's provider home, relative
 * to it (posix separators; sandboxes are Linux).
 *
 * Codex keeps its date folder; an archived rollout is filed back under
 * `sessions/` by the date in its name, so it resumes without an unarchive.
 * Claude is filed under the project directory of `targetCwd`, which must be
 * the canonical (realpath) working directory the sandbox thread will use.
 * Paths over 200 characters are refused: the CLI's hash suffix for them
 * cannot be computed outside the CLI.
 */
export function sandboxTranscriptRelativePath(input: {
  readonly location: Pick<NativeTranscriptLocation, "provider" | "nativeThreadId" | "relativePath">;
  readonly targetCwd: string;
}): string {
  const { location } = input;
  if (location.provider === "codex") {
    const fileName = location.relativePath.split("/").at(-1) ?? "";
    const date = CODEX_ROLLOUT_DATE_PATTERN.exec(fileName);
    if (date !== null) {
      return `sessions/${date[1]}/${date[2]}/${date[3]}/${fileName}`;
    }
    return location.relativePath.startsWith("sessions/")
      ? location.relativePath
      : `sessions/${fileName}`;
  }
  if (!input.targetCwd.startsWith("/")) {
    throw new HandoffInvalidInputError({ field: "targetCwd", reason: "must be absolute" });
  }
  const dirName = claudeProjectDirName(input.targetCwd);
  if (dirName.length > CLAUDE_PROJECT_DIR_NAME_MAX_LENGTH) {
    throw new HandoffInvalidInputError({
      field: "targetCwd",
      reason: `Claude names project directories for paths over ${CLAUDE_PROJECT_DIR_NAME_MAX_LENGTH} characters with a CLI-internal hash; choose a shorter sandbox path`,
    });
  }
  return `projects/${dirName}/${location.nativeThreadId}.jsonl`;
}

// Characters that continue a path segment. A match must not be preceded by one
// (`/a/Users/me/proj` is a different path) or followed by one (`proj2`); a
// `.` ends the path only when what follows it does not continue the name, so
// a sentence-ending period is rewritten and `proj.git` is not.
const SEGMENT_CHAR = String.raw`[\p{L}\p{N}\p{M}_~@+%-]`;
const REGEXP_SYNTAX = /[.*+?^${}()|[\]\\/]/g;

const JSON_SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/** The body of a JSON string literal holding `value`, as JSON.stringify writes it. */
function jsonEscape(value: string): string {
  return value.replace(
    // oxlint-disable-next-line no-control-regex -- JSON escapes exactly the control characters.
    /["\\\u0000-\u001f]/g,
    (character) =>
      JSON_SHORT_ESCAPES[character] ??
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function normalizeAbsolutePath(field: string, value: string): string {
  const trimmed = value.length > 1 ? value.replace(/\/+$/u, "") : value;
  if (!trimmed.startsWith("/") || trimmed === "/") {
    throw new HandoffInvalidInputError({
      field,
      reason: `'${value}' must be an absolute path below the filesystem root`,
    });
  }
  return trimmed;
}

/**
 * A rewrite target must read the same at every JSON escaping level: a match
 * of a plain source path does not say which level it sits at, so a target
 * that needs escaping would come out unescaped inside a nested string.
 */
function plainTargetPath(field: string, value: string): string {
  const normalized = normalizeAbsolutePath(field, value);
  if (jsonEscape(normalized) !== normalized) {
    throw new HandoffInvalidInputError({
      field,
      reason: `'${value}' must not contain quotes, backslashes or control characters`,
    });
  }
  return normalized;
}

export interface TranscriptRewriteOptions {
  /**
   * The provider home on each side (CODEX_HOME, CLAUDE_CONFIG_DIR). Claude
   * transcripts point into it for oversized tool results and subagent
   * transcripts under the project directory, so for Claude the project
   * directory name is remapped along with it.
   */
  readonly providerHome?: { readonly from: string; readonly to: string };
}

/**
 * Builds a rewriter that moves every reference to `fromCwd` (and its aliases,
 * such as the realpath) to `toCwd` in transcript text.
 *
 * It works on raw JSONL rather than parsed records so every byte it does not
 * rewrite survives as written: number formatting, key order and lines that
 * do not parse. A path appears in the text JSON-escaped once in a field
 * (`"cwd"`) and twice inside an encoded tool-call argument string
 * (`"arguments":"{\"workdir\":...}"`), so a source is matched at each
 * escaping level; targets are refused unless they need no escaping, which
 * makes one spelling right at every level. All mappings run in one pass,
 * longest first, so a target inside a source is never rewritten again.
 */
function makeTranscriptPathRewriter(
  fromCwd: string | ReadonlyArray<string>,
  toCwd: string,
  provider: HandoffProvider,
  options: TranscriptRewriteOptions = {},
): (text: string) => string {
  const target = plainTargetPath("toCwd", toCwd);
  const sources = [
    ...new Set(
      (typeof fromCwd === "string" ? [fromCwd] : fromCwd).map((source) =>
        normalizeAbsolutePath("fromCwd", source),
      ),
    ),
  ];
  const mappings: Array<{ readonly from: string; readonly to: string }> = sources.map((from) => ({
    from,
    to: target,
  }));
  if (options.providerHome !== undefined) {
    const homeFrom = normalizeAbsolutePath("providerHome.from", options.providerHome.from);
    const homeTo = plainTargetPath("providerHome.to", options.providerHome.to);
    if (provider === "claude") {
      for (const from of sources) {
        mappings.push({
          from: `${homeFrom}/projects/${claudeProjectDirName(from)}`,
          to: `${homeTo}/projects/${claudeProjectDirName(target)}`,
        });
      }
    }
    mappings.push({ from: homeFrom, to: homeTo });
  }

  const replacements = new Map<string, string>();
  for (const mapping of mappings) {
    let from = mapping.from;
    for (let level = 0; level < 3; level += 1) {
      if (from !== mapping.to && !replacements.has(from)) replacements.set(from, mapping.to);
      from = jsonEscape(from);
    }
  }
  if (replacements.size === 0) {
    return (text) => text;
  }
  const alternatives = [...replacements.keys()]
    .toSorted((left, right) => right.length - left.length)
    .map((source) => source.replace(REGEXP_SYNTAX, "\\$&"));
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}\\p{M}._~@+%-])(?:${alternatives.join("|")})(?!${SEGMENT_CHAR}|\\.${SEGMENT_CHAR})`,
    "gu",
  );
  // A replacer function, so `$&` and friends in a target path stay literal.
  return (text) => text.replace(pattern, (match) => replacements.get(match) ?? match);
}

/**
 * Rewrites a whole JSONL transcript from `fromCwd` to `toCwd`. See
 * `makeTranscriptPathRewriter`; pass the realpath as well when it differs,
 * since Claude records the realpath and Codex the path it was given.
 */
export function rewriteTranscriptPaths(
  content: string,
  fromCwd: string | ReadonlyArray<string>,
  toCwd: string,
  provider: HandoffProvider,
  options?: TranscriptRewriteOptions,
): string {
  return makeTranscriptPathRewriter(fromCwd, toCwd, provider, options)(content);
}
