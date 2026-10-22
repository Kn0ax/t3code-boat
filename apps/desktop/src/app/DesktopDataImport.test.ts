// @effect-diagnostics nodeBuiltinImport:off - exercises real files and a real child process.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as DesktopDataImport from "./DesktopDataImport.ts";

const withRoot = <A, E, R>(run: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-import-"))),
    run,
    (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  ).pipe(Effect.provide(NodeServices.layer));

const writeFile = (path: string, contents: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, contents);
};

// Stands in for the server entry: records its arguments and exits with the
// code in FAKE_EXIT_CODE.
const FAKE_SERVER = `
require("node:fs").writeFileSync(process.env.FAKE_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
const code = Number(process.env.FAKE_EXIT_CODE);
if (code !== 0) process.stderr.write("source database is in use");
process.exit(code);
`;

const startConfig = (root: string, baseDir: string, exitCode: number) => {
  const entryPath = NodePath.join(root, "server.cjs");
  writeFile(entryPath, FAKE_SERVER);
  return {
    executablePath: process.execPath,
    args: [entryPath, "--bootstrap-fd", "3"],
    entryPath,
    cwd: root,
    env: { FAKE_ARGS_PATH: NodePath.join(root, "args.json"), FAKE_EXIT_CODE: String(exitCode) },
    extendEnv: true,
    bootstrap: { t3Home: baseDir },
  };
};

describe("DesktopDataImport", () => {
  it.effect("offers the official home only when it has a database", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, ".t3-boat");
        const empty = yield* DesktopDataImport.readState({ homeDirectory: root, baseDir });
        assert.deepStrictEqual(empty, {
          sourcePath: NodePath.join(root, ".t3"),
          available: false,
          imported: false,
        });

        writeFile(NodePath.join(root, ".t3", "userdata", "statev2.sqlite"), "");
        writeFile(NodePath.join(baseDir, "userdata", "imported-from.json"), "{}");
        const state = yield* DesktopDataImport.readState({ homeDirectory: root, baseDir });
        assert.isTrue(state.available);
        assert.isTrue(state.imported);

        const sameHome = yield* DesktopDataImport.readState({
          homeDirectory: root,
          baseDir: NodePath.join(root, ".t3"),
        });
        assert.isFalse(sameHome.available);
      }),
    ),
  );

  it.effect("runs a requested import with the backend runtime, then drops the request", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "home");
        yield* DesktopDataImport.writeRequest(baseDir, {
          projects: true,
          settings: false,
          secrets: true,
        });

        yield* DesktopDataImport.runPendingImport(startConfig(root, baseDir, 0));

        assert.deepStrictEqual(
          JSON.parse(NodeFS.readFileSync(NodePath.join(root, "args.json"), "utf8")),
          ["import-home", "--base-dir", baseDir, "--projects", "--secrets"],
        );
        assert.isFalse(NodeFS.existsSync(NodePath.join(baseDir, "import-request.json")));
        const state = yield* DesktopDataImport.readState({ homeDirectory: root, baseDir });
        assert.isUndefined(state.lastError);
      }),
    ),
  );

  it.effect("records a failed import for the next getT3DataImport", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "home");
        yield* DesktopDataImport.writeRequest(baseDir, {
          projects: true,
          settings: true,
          secrets: true,
        });

        yield* DesktopDataImport.runPendingImport(startConfig(root, baseDir, 1));

        assert.isFalse(NodeFS.existsSync(NodePath.join(baseDir, "import-request.json")));
        const state = yield* DesktopDataImport.readState({ homeDirectory: root, baseDir });
        assert.strictEqual(state.lastError, "source database is in use");
      }),
    ),
  );

  it.effect("does nothing without a request", () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const baseDir = NodePath.join(root, "home");
        yield* DesktopDataImport.runPendingImport(startConfig(root, baseDir, 0));
        assert.isFalse(NodeFS.existsSync(NodePath.join(root, "args.json")));
      }),
    ),
  );
});
