import {
  DesktopT3DataImportInputSchema,
  type DesktopT3DataImportInput,
  type DesktopT3DataImportState,
} from "@t3tools/contracts";
import { OFFICIAL_T3_HOME_DIRNAME } from "@t3tools/shared/t3Home";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";

/**
 * The copy runs in the server's own `import-home` command before the backend
 * starts, so the target database is never open while it is replaced. The app
 * relaunches to get there; this request file carries the choice across.
 */
const REQUEST_FILENAME = "import-request.json";
const ERROR_FILENAME = "import-error.txt";
// Written by `t3 import-home` on success.
const MARKER_PATH = ["userdata", "imported-from.json"] as const;
const IMPORT_TIMEOUT = Duration.minutes(15);
const MAX_ERROR_LENGTH = 2_000;

const RequestJson = Schema.fromJsonString(DesktopT3DataImportInputSchema);
const decodeRequest = Schema.decodeUnknownEffect(RequestJson);
const encodeRequest = Schema.encodeEffect(RequestJson);

class DesktopDataImportFailedError extends Schema.TaggedError<DesktopDataImportFailedError>()(
  "DesktopDataImportFailedError",
  { output: Schema.String },
) {
  override get message(): string {
    return this.output;
  }
}

const canonical = (fs: FileSystem.FileSystem, directory: string) =>
  fs.realPath(directory).pipe(Effect.orElseSucceed(() => directory));

export const readState = Effect.fn("desktop.dataImport.readState")(function* (input: {
  readonly homeDirectory: string;
  readonly baseDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.join(input.homeDirectory, OFFICIAL_T3_HOME_DIRNAME);
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const sameDirectory =
    (yield* canonical(fs, sourcePath)) === (yield* canonical(fs, input.baseDir));
  const available =
    !sameDirectory && (yield* exists(path.join(sourcePath, "userdata", "statev2.sqlite")));
  const imported = yield* exists(path.join(input.baseDir, ...MARKER_PATH));
  const lastError = yield* fs
    .readFileString(path.join(input.baseDir, ERROR_FILENAME))
    .pipe(Effect.orElseSucceed(() => ""));
  return {
    sourcePath,
    available,
    imported,
    ...(lastError.trim() === "" ? {} : { lastError: lastError.trim() }),
  } satisfies DesktopT3DataImportState;
});

export const writeRequest = Effect.fn("desktop.dataImport.writeRequest")(function* (
  baseDir: string,
  request: DesktopT3DataImportInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(baseDir, { recursive: true });
  yield* fs.writeFileString(path.join(baseDir, REQUEST_FILENAME), yield* encodeRequest(request));
});

/** Runs a requested import with the runtime, entry and env the backend starts with. */
export const runPendingImport = Effect.fn("desktop.dataImport.runPending")(function* (
  config: Pick<
    DesktopBackendManager.DesktopBackendStartConfig,
    "executablePath" | "args" | "entryPath" | "cwd" | "env" | "extendEnv"
  > & { readonly bootstrap: { readonly t3Home?: string | undefined } },
) {
  // Only the local backend owns a desktop T3 home; WSL backends use their own.
  const baseDir = config.bootstrap.t3Home;
  if (baseDir === undefined) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const requestPath = path.join(baseDir, REQUEST_FILENAME);
  const errorPath = path.join(baseDir, ERROR_FILENAME);
  if (!(yield* fs.exists(requestPath).pipe(Effect.orElseSucceed(() => false)))) return;

  const run = Effect.gen(function* () {
    yield* fs.remove(errorPath, { force: true });
    const request = yield* decodeRequest(yield* fs.readFileString(requestPath));
    const parts = (["projects", "settings", "secrets"] as const).filter((part) => request[part]);
    const entryIndex = config.args.indexOf(config.entryPath);
    const args = [
      ...config.args.slice(0, entryIndex + 1),
      "import-home",
      "--base-dir",
      baseDir,
      ...parts.map((part) => `--${part}`),
    ];
    const [exitCode, output] = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(config.executablePath, args, {
            cwd: config.cwd,
            env: config.env,
            extendEnv: config.extendEnv,
            stdin: "ignore",
          }),
        );
        return yield* Effect.all(
          [handle.exitCode, Stream.mkString(Stream.decodeText(handle.all))],
          {
            concurrency: 2,
          },
        );
      }),
    ).pipe(Effect.timeout(IMPORT_TIMEOUT));
    if (exitCode !== 0) {
      return yield* new DesktopDataImportFailedError({
        output: output.trim().slice(-MAX_ERROR_LENGTH) || `Exited with code ${exitCode}.`,
      });
    }
  });

  yield* run.pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      return fs
        .writeFileString(errorPath, error instanceof Error ? error.message : String(error))
        .pipe(Effect.ignore);
    }),
    Effect.ensuring(fs.remove(requestPath, { force: true }).pipe(Effect.ignore)),
  );
});
