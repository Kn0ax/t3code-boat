import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { OFFICIAL_T3_HOME_DIRNAME } from "@t3tools/shared/t3Home";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import { decodeServerSettingsJsonExit } from "../serverSettings.ts";
import { mapSettingsSecrets } from "../settingsSecrets.ts";
import { baseDirFlag } from "./config.ts";

const IMPORT_MARKER_FILENAME = "imported-from.json";

// High enough that the pruning in migrate-dev-db never drops a project or a
// thread it would otherwise keep.
const KEEP_ALL = 1_000_000;

const ImportHomePart = Schema.Literals(["projects", "settings", "secrets"]);
export type ImportHomePart = typeof ImportHomePart.Type;

const encodeMarker = Schema.encodeEffect(
  fromJsonStringPretty(
    Schema.Struct({
      from: Schema.String,
      importedAt: Schema.String,
      parts: Schema.Array(ImportHomePart),
    }),
  ),
);

export class ImportHomeSameDirectoryError extends Schema.TaggedError<ImportHomeSameDirectoryError>()(
  "ImportHomeSameDirectoryError",
  { directory: Schema.String },
) {
  override get message(): string {
    return `The source and target are the same directory (${this.directory}). Pick a different --from or --base-dir.`;
  }
}

export class ImportHomeNothingSelectedError extends Schema.TaggedError<ImportHomeNothingSelectedError>()(
  "ImportHomeNothingSelectedError",
  {},
) {
  override get message(): string {
    return "Choose what to copy with --projects, --settings, or --secrets.";
  }
}

export class ImportHomeSettingsUnreadableError extends Schema.TaggedError<ImportHomeSettingsUnreadableError>()(
  "ImportHomeSettingsUnreadableError",
  { settingsPath: Schema.String },
) {
  override get message(): string {
    return `Could not read the secrets ${this.settingsPath} refers to, because it is not valid settings.`;
  }
}

// Copying these would make two installs claim one server identity or T3 Connect
// link. Settings never reference them; this guards the copy if that changes.
const isIdentitySecret = (name: string) =>
  name.startsWith("cloud-") ||
  [
    "server-signing-key",
    "asset-access-signing-key",
    "mcp-oauth-signing-key",
    "secret-request-salt",
  ].includes(name);

/** The secret store names a settings file refers to. */
const settingsSecretNames = (settingsJson: string): Option.Option<ReadonlyArray<string>> => {
  const decoded = decodeServerSettingsJsonExit(settingsJson);
  if (Exit.isFailure(decoded)) return Option.none();
  const names = new Set<string>();
  mapSettingsSecrets(decoded.value, (secret) => {
    names.add(secret.secretName);
    return secret;
  });
  return Option.some([...names].filter((name) => !isIdentitySecret(name)));
};

const canonical = Effect.fn("importHome.canonical")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => directory));
});

const importHome = Effect.fn("importHome")(function* (input: {
  readonly from: string;
  readonly baseDir: string;
  readonly parts: ReadonlyArray<ImportHomePart>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (input.parts.length === 0) return yield* new ImportHomeNothingSelectedError();
  const from = path.resolve(input.from);
  const baseDir = path.resolve(input.baseDir);
  if ((yield* canonical(from)) === (yield* canonical(baseDir))) {
    return yield* new ImportHomeSameDirectoryError({ directory: baseDir });
  }
  const sourceState = path.join(from, "userdata");
  const targetState = path.join(baseDir, "userdata");
  yield* fs.makeDirectory(targetState, { recursive: true });

  if (input.parts.includes("projects")) {
    // Loaded on demand: the script is also a standalone CLI, and bundling it
    // into every command would run its entrypoint check at startup.
    const { runMigrateDevDb } = yield* Effect.promise(
      () => import("../../scripts/migrate-dev-db.ts"),
    );
    yield* runMigrateDevDb({
      baseDir,
      source: path.join(sourceState, "statev2.sqlite"),
      projects: KEEP_ALL,
      threadsPerProject: KEEP_ALL,
      includeSettledAndArchived: true,
    });
  }

  if (input.parts.includes("settings")) {
    for (const file of ["settings.json", "keybindings.json"]) {
      const source = path.join(sourceState, file);
      if (!(yield* fs.exists(source))) continue;
      yield* fs.copyFile(source, path.join(targetState, file));
      yield* Console.log(`Copied ${file}`);
    }
  }

  if (input.parts.includes("secrets")) {
    const settingsPath = path.join(sourceState, "settings.json");
    const names = (yield* fs.exists(settingsPath))
      ? yield* Option.match(settingsSecretNames(yield* fs.readFileString(settingsPath)), {
          onNone: () => Effect.fail(new ImportHomeSettingsUnreadableError({ settingsPath })),
          onSome: Effect.succeed,
        })
      : [];
    const targetSecrets = path.join(targetState, "secrets");
    let copied = 0;
    for (const name of names) {
      const source = path.join(sourceState, "secrets", `${name}.bin`);
      if (!(yield* fs.exists(source))) continue;
      if (copied === 0) {
        yield* fs.makeDirectory(targetSecrets, { recursive: true });
        yield* fs.chmod(targetSecrets, 0o700);
      }
      const target = path.join(targetSecrets, `${name}.bin`);
      yield* fs.copyFile(source, target);
      yield* fs.chmod(target, 0o600);
      copied += 1;
    }
    yield* Console.log(`Copied ${copied} ${copied === 1 ? "secret" : "secrets"}`);
  }

  const importedAt = DateTime.formatIso(yield* DateTime.now);
  yield* fs.writeFileString(
    path.join(targetState, IMPORT_MARKER_FILENAME),
    `${yield* encodeMarker({ from, importedAt, parts: input.parts })}\n`,
  );
});

const envT3Home = Config.String("T3CODE_HOME").pipe(Config.option);

export const importHomeCommand = Command.make("import-home", {
  from: Flag.String("from").pipe(
    Flag.withDescription("T3 Code data directory to copy from. Default: ~/.t3."),
    Flag.optional,
  ),
  baseDir: baseDirFlag,
  projects: Flag.Boolean("projects").pipe(
    Flag.withDescription("Copy projects and their threads."),
    Flag.withDefault(false),
  ),
  settings: Flag.Boolean("settings").pipe(
    Flag.withDescription("Copy settings.json and keybindings.json."),
    Flag.withDefault(false),
  ),
  secrets: Flag.Boolean("secrets").pipe(
    Flag.withDescription(
      "Copy the provider logins and keys settings use. Never this server's identity or T3 Connect link.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Copy data from another T3 Code data directory, such as the official app's.",
  ),
  Command.withHandler(
    Effect.fn("cli.importHome")(function* (flags) {
      const path = yield* Path.Path;
      const envHome = Option.filter(yield* envT3Home, (value) => value.trim().length > 0);
      const baseDir = yield* resolveBaseDir(
        Option.getOrUndefined(Option.orElse(flags.baseDir, () => envHome)),
      );
      const from = Option.isSome(flags.from)
        ? yield* expandHomePath(flags.from.value.trim())
        : path.join(yield* HostProcess.HomeDirectory, OFFICIAL_T3_HOME_DIRNAME);
      const parts = (["projects", "settings", "secrets"] as const).filter((part) => flags[part]);
      yield* importHome({ from, baseDir, parts });
      yield* Console.log(`Imported ${parts.join(", ")} from ${from} into ${baseDir}`);
    }),
  ),
);
