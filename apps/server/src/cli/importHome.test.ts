// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import { ImportHomeSameDirectoryError } from "./importHome.ts";

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
  );

const withHomes = <A, E>(run: (from: string, target: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-import-home-"))),
    (root) => run(NodePath.join(root, "from"), NodePath.join(root, "target")),
    (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );

const writeFile = (path: string, contents: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, contents);
};

const userdata = (home: string, ...segments: string[]) =>
  NodePath.join(home, "userdata", ...segments);

describe("t3 import-home", () => {
  it.effect("copies only the secrets settings refer to, never identity", () =>
    withHomes((from, target) =>
      Effect.gen(function* () {
        writeFile(
          userdata(from, "settings.json"),
          JSON.stringify({ sandboxJobs: { providerKeys: { boat: SECRET_REDACTED } } }),
        );
        for (const name of [
          "sandbox-provider-boat",
          "server-signing-key",
          "mcp-oauth-signing-key",
          "cloud-environment-credential",
          "unreferenced-key",
        ]) {
          writeFile(userdata(from, "secrets", `${name}.bin`), name);
        }
        writeFile(userdata(from, "environment-id"), "source-environment");

        yield* runCli(["import-home", "--from", from, "--base-dir", target, "--secrets"]);

        assert.deepStrictEqual(NodeFS.readdirSync(userdata(target, "secrets")), [
          "sandbox-provider-boat.bin",
        ]);
        assert.isFalse(NodeFS.existsSync(userdata(target, "environment-id")));
        assert.isFalse(NodeFS.existsSync(userdata(target, "settings.json")));
        const marker = JSON.parse(
          NodeFS.readFileSync(userdata(target, "imported-from.json"), "utf8"),
        ) as { from: string; parts: string[] };
        assert.strictEqual(marker.from, from);
        assert.deepStrictEqual(marker.parts, ["secrets"]);
      }),
    ),
  );

  it.effect("copies settings and keybindings", () =>
    withHomes((from, target) =>
      Effect.gen(function* () {
        writeFile(userdata(from, "settings.json"), '{"enableAssistantStreaming":true}\n');
        writeFile(userdata(from, "keybindings.json"), "[]\n");

        yield* runCli(["import-home", "--from", from, "--base-dir", target, "--settings"]);

        assert.strictEqual(
          NodeFS.readFileSync(userdata(target, "settings.json"), "utf8"),
          '{"enableAssistantStreaming":true}\n',
        );
        assert.strictEqual(
          NodeFS.readFileSync(userdata(target, "keybindings.json"), "utf8"),
          "[]\n",
        );
        assert.isFalse(NodeFS.existsSync(userdata(target, "secrets")));
      }),
    ),
  );

  it.effect("refuses to copy a directory onto itself", () =>
    withHomes((from) =>
      Effect.gen(function* () {
        writeFile(userdata(from, "settings.json"), "{}\n");

        const error = yield* runCli([
          "import-home",
          "--from",
          from,
          "--base-dir",
          NodePath.join(from, "."),
          "--settings",
        ]).pipe(Effect.flip);

        assert.instanceOf(error, ImportHomeSameDirectoryError);
        assert.isFalse(NodeFS.existsSync(userdata(from, "imported-from.json")));
      }),
    ),
  );
});
