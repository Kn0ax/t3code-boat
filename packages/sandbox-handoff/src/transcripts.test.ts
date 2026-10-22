// @effect-diagnostics nodeBuiltinImport:off - Lays out provider homes on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { HandoffInvalidInputError } from "./errors.ts";
import { makeTempDir, writeFile } from "./testing/fixtures.ts";
import * as NodeServices from "./testing/nodeServices.ts";
import {
  claudeProjectDirName,
  locateNativeTranscript,
  rewriteTranscriptPaths,
  sandboxTranscriptRelativePath,
} from "./transcripts.ts";

const CODEX_ID = "0199d2a4-5d1e-7c3a-9f00-2aeb6098ae0e";
const CLAUDE_ID = "5973b6c0-94b8-487b-a530-2aeb6098ae0e";

const jsonl = (records: ReadonlyArray<unknown>) =>
  records.map((record) => JSON.stringify(record)).join("\n");

describe("claudeProjectDirName", () => {
  // Expected values come from running the Agent SDK's own `fm` (sdk.mjs, 0.3.276).
  it.each([
    ["/Users/me/my project.v2", "-Users-me-my-project-v2"],
    ["/Users/me/café/😀", "-Users-me-caf----"],
    [
      `/home/daytona/workspace/${"very-long-directory-name-segment/".repeat(7)}project`,
      "-home-daytona-workspace-very-long-directory-name-segment-very-long-directory-name-segment-very-long-directory-name-segment-very-long-directory-name-segment-very-long-directory-name-segment-very-long-d-cegj3p",
    ],
  ])("names %s like Claude Code", (cwd, expected) => {
    assert.equal(claudeProjectDirName(cwd), expected);
  });
});

describe("rewriteTranscriptPaths", () => {
  const codexTranscript = jsonl([
    {
      timestamp: "2026-10-11T10:00:00.000Z",
      type: "session_meta",
      payload: { id: CODEX_ID, cwd: "/Users/me/proj", originator: "codex_cli_rs" },
    },
    {
      type: "turn_context",
      payload: {
        cwd: "/Users/me/proj",
        sandbox_policy: { mode: "workspace-write", writable_roots: ["/Users/me/proj"] },
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<environment_context>\n  <cwd>/Users/me/proj</cwd>\n</environment_context>",
          },
        ],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({
          command: ["bash", "-lc", "cat /Users/me/proj/src/app.ts"],
          workdir: "/Users/me/proj",
        }),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Edited /Users/me/proj/src/app.ts. /Users/me/proj2, /Users/me/proj.git and /backup/Users/me/proj are other paths. Done in /Users/me/proj.",
          },
        ],
      },
    },
  ]);

  it("moves every reference to the working directory and nothing else", () => {
    const rewritten = rewriteTranscriptPaths(
      `${codexTranscript}\nnot json /Users/me/proj\n`,
      "/Users/me/proj/",
      "/home/daytona/work/proj",
      "codex",
    );
    const lines = rewritten.split("\n");
    assert.equal(lines.at(-2), "not json /home/daytona/work/proj");
    assert.equal(lines.at(-1), "");
    const records = lines.slice(0, 5).map((line) => JSON.parse(line));
    assert.equal(records[0].payload.cwd, "/home/daytona/work/proj");
    assert.equal(records[0].payload.id, CODEX_ID);
    assert.deepEqual(records[1].payload.sandbox_policy.writable_roots, ["/home/daytona/work/proj"]);
    assert.include(records[2].payload.content[0].text, "<cwd>/home/daytona/work/proj</cwd>");
    assert.deepEqual(JSON.parse(records[3].payload.arguments), {
      command: ["bash", "-lc", "cat /home/daytona/work/proj/src/app.ts"],
      workdir: "/home/daytona/work/proj",
    });
    assert.equal(
      records[4].payload.content[0].text,
      "Edited /home/daytona/work/proj/src/app.ts. /Users/me/proj2, /Users/me/proj.git and /backup/Users/me/proj are other paths. Done in /home/daytona/work/proj.",
    );
  });

  it("matches a source path at every JSON escaping level", () => {
    const source = `/Users/me/it's "quoted" \\ dir`;
    const transcript = jsonl([
      { cwd: source, arguments: JSON.stringify({ workdir: source }) },
      { text: `cd ${source}/src` },
    ]);
    const target = "/home/u/$& dir";
    const records = rewriteTranscriptPaths(transcript, source, target, "codex")
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records[0].cwd, target);
    assert.equal(JSON.parse(records[0].arguments).workdir, target);
    assert.equal(records[1].text, `cd ${target}/src`);
  });

  it("refuses a target that would need JSON escaping", () => {
    assert.throws(
      () => rewriteTranscriptPaths("", "/Users/me/proj", '/home/u/"quoted"', "codex"),
      HandoffInvalidInputError,
    );
  });

  it("rewrites every alias and, with the homes, Claude's project directory", () => {
    const transcript = jsonl([
      { type: "user", cwd: "/private/tmp/proj", sessionId: CLAUDE_ID, message: { content: "hi" } },
      {
        type: "assistant",
        cwd: "/tmp/proj",
        message: {
          content: [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/proj/a.ts" } }],
        },
      },
      {
        type: "user",
        cwd: "/private/tmp/proj",
        message: {
          content: [
            {
              type: "tool_result",
              content: `Output saved to /Users/me/.claude/projects/-private-tmp-proj/${CLAUDE_ID}/tool-results/toolu_1.txt (see /Users/me/.claude/settings.json)`,
            },
          ],
        },
      },
    ]);
    const rewritten = rewriteTranscriptPaths(
      transcript,
      ["/tmp/proj", "/private/tmp/proj"],
      "/home/daytona/proj",
      "claude",
      { providerHome: { from: "/Users/me/.claude", to: "/home/daytona/.claude" } },
    );
    const records = rewritten.split("\n").map((line) => JSON.parse(line));
    assert.equal(records[0].cwd, "/home/daytona/proj");
    assert.equal(records[1].cwd, "/home/daytona/proj");
    assert.equal(records[1].message.content[0].input.file_path, "/home/daytona/proj/a.ts");
    assert.equal(
      records[2].message.content[0].content,
      `Output saved to /home/daytona/.claude/projects/-home-daytona-proj/${CLAUDE_ID}/tool-results/toolu_1.txt (see /home/daytona/.claude/settings.json)`,
    );
  });

  it("refuses the filesystem root and relative paths", () => {
    assert.throws(
      () => rewriteTranscriptPaths("", "/", "/home/u", "codex"),
      HandoffInvalidInputError,
    );
    assert.throws(
      () => rewriteTranscriptPaths("", "/Users/me", "relative", "codex"),
      HandoffInvalidInputError,
    );
  });
});

describe("locateNativeTranscript", () => {
  let home: string;

  beforeEach(() => {
    home = makeTempDir("t3-handoff-transcripts-test-");
  });

  afterEach(() => {
    NodeFS.rmSync(home, { recursive: true, force: true });
  });

  const inHome = <A, E>(effect: Effect.Effect<A, E, NodeServices.Services>) =>
    effect.pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provide(NodeServices.layer),
    );

  it.effect("finds a Codex rollout by thread id under the shared home", () =>
    inHome(
      Effect.gen(function* () {
        writeFile(home, ".codex/sessions/2026/10/10/rollout-2026-10-10T09-00-00-other.jsonl", "{}");
        const relativePath = `sessions/2026/10/11/rollout-2026-10-11T10-00-00-${CODEX_ID}.jsonl`;
        writeFile(home, `.codex/${relativePath}`, "{}\n");
        const location = yield* locateNativeTranscript({
          provider: "codex",
          nativeThreadId: CODEX_ID,
          cwd: "/Users/me/proj",
        });
        assert.equal(location.homePath, NodePath.join(home, ".codex"));
        assert.equal(location.relativePath, relativePath);
        assert.equal(location.path, NodePath.join(home, ".codex", relativePath));
        assert.equal(location.sizeBytes, 3);
        assert.equal(sandboxTranscriptRelativePath({ location, targetCwd: "/w" }), relativePath);
      }),
    ),
  );

  it.effect("finds an archived rollout in a configured home and files it back by date", () =>
    inHome(
      Effect.gen(function* () {
        const fileName = `rollout-2026-09-01T08-00-00-${CODEX_ID}.jsonl`;
        writeFile(home, `codex-work/archived_sessions/${fileName}`, "{}\n");
        const location = yield* locateNativeTranscript({
          provider: "codex",
          nativeThreadId: CODEX_ID,
          cwd: "/Users/me/proj",
          codexHome: "~/codex-work",
        });
        assert.equal(location.relativePath, `archived_sessions/${fileName}`);
        assert.equal(
          sandboxTranscriptRelativePath({ location, targetCwd: "/w" }),
          `sessions/2026/09/01/${fileName}`,
        );

        const missing = yield* locateNativeTranscript({
          provider: "codex",
          nativeThreadId: "0199d2a4-0000-7000-8000-000000000000",
          cwd: "/Users/me/proj",
          codexHome: "~/codex-work",
        }).pipe(Effect.flip);
        assert.equal(missing._tag, "HandoffTranscriptNotFoundError");
        if (missing._tag === "HandoffTranscriptNotFoundError") {
          assert.deepEqual(missing.searched, [
            NodePath.join(home, "codex-work", "sessions"),
            NodePath.join(home, "codex-work", "archived_sessions"),
          ]);
        }
      }),
    ),
  );

  it.effect("finds a Claude session under the realpath's project directory", () =>
    inHome(
      Effect.gen(function* () {
        const project = NodePath.join(home, "work", "proj");
        NodeFS.mkdirSync(project, { recursive: true });
        const link = NodePath.join(home, "proj-link");
        NodeFS.symlinkSync(project, link);
        const configDir = NodePath.join(home, "claude-config");
        const projectDir = NodePath.join(configDir, "projects", claudeProjectDirName(project));
        writeFile(projectDir, `${CLAUDE_ID}.jsonl`, "{}\n");
        NodeFS.mkdirSync(NodePath.join(projectDir, CLAUDE_ID, "subagents"), { recursive: true });

        const location = yield* locateNativeTranscript({
          provider: "claude",
          nativeThreadId: CLAUDE_ID,
          cwd: link,
        }).pipe(Effect.provideService(HostProcess.Environment, { CLAUDE_CONFIG_DIR: configDir }));
        assert.equal(location.homePath, configDir);
        assert.equal(location.path, NodePath.join(projectDir, `${CLAUDE_ID}.jsonl`));
        assert.equal(location.companionDirectory, NodePath.join(projectDir, CLAUDE_ID));
        assert.equal(
          sandboxTranscriptRelativePath({ location, targetCwd: "/home/daytona/proj" }),
          `projects/-home-daytona-proj/${CLAUDE_ID}.jsonl`,
        );
      }),
    ),
  );

  it.effect("falls back to any project directory holding the session id", () =>
    inHome(
      Effect.gen(function* () {
        writeFile(home, `.claude/projects/-somewhere-else/${CLAUDE_ID}.jsonl`, "{}\n");
        const location = yield* locateNativeTranscript({
          provider: "claude",
          nativeThreadId: CLAUDE_ID,
          cwd: "/Users/me/moved-away",
        });
        assert.equal(location.relativePath, `projects/-somewhere-else/${CLAUDE_ID}.jsonl`);
        assert.isUndefined(location.companionDirectory);

        const invalid = yield* locateNativeTranscript({
          provider: "claude",
          nativeThreadId: "../escape",
          cwd: "/Users/me/proj",
        }).pipe(Effect.flip);
        assert.equal(invalid._tag, "HandoffInvalidInputError");
      }),
    ),
  );

  it("refuses a Claude target whose project directory name Claude would hash", () => {
    assert.throws(
      () =>
        sandboxTranscriptRelativePath({
          location: { provider: "claude", nativeThreadId: CLAUDE_ID, relativePath: "x" },
          targetCwd: `/${"a".repeat(220)}`,
        }),
      HandoffInvalidInputError,
    );
  });
});
