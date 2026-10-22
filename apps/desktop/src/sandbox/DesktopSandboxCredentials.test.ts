import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSandboxCredentials from "./DesktopSandboxCredentials.ts";

const textDecoder = new TextDecoder();

/** Reverses the bytes, so a stored file never holds the plaintext. */
function layerSafeStorage(available: boolean) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(available),
    encryptString: (value) => Effect.succeed(new TextEncoder().encode(value).toReversed()),
    decryptString: (value) => Effect.succeed(textDecoder.decode(value.toReversed())),
    selectedStorageBackend: Effect.succeedNone,
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

function layerFor(baseDir: string, encryptionAvailable: boolean) {
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
  return DesktopSandboxCredentials.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(layerEnvironment, layerSafeStorage(encryptionAvailable), NodeServices.layer),
    ),
  );
}

const withCredentials = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopSandboxCredentials.DesktopSandboxCredentials
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
  >,
  encryptionAvailable = true,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-sandbox-credentials-test-",
    });
    return yield* effect.pipe(Effect.provide(layerFor(baseDir, encryptionAvailable)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopSandboxCredentials", () => {
  it.effect("keeps an encrypted boat key and clears it", () =>
    withCredentials(
      Effect.gen(function* () {
        const credentials = yield* DesktopSandboxCredentials.DesktopSandboxCredentials;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;

        assert.isFalse(yield* credentials.has("boat"));
        assert.isTrue(Option.isNone(yield* credentials.get("boat")));

        yield* credentials.set({ providerId: "boat", secret: Redacted.make("boat-secret-key") });

        assert.isTrue(yield* credentials.has("boat"));
        const boat = Option.getOrThrow(yield* credentials.get("boat"));
        assert.strictEqual(Redacted.value(boat.secret), "boat-secret-key");

        const stored = yield* fileSystem.readFileString(
          `${environment.stateDir}/sandbox-provider-credentials.json`,
        );
        assert.notInclude(stored, "boat-secret-key");

        yield* credentials.clear("boat");
        assert.isFalse(yield* credentials.has("boat"));
      }),
    ),
  );

  it.effect("replaces a provider's credential when it is saved again", () =>
    withCredentials(
      Effect.gen(function* () {
        const credentials = yield* DesktopSandboxCredentials.DesktopSandboxCredentials;
        yield* credentials.set({ providerId: "boat", secret: Redacted.make("first") });
        yield* credentials.set({ providerId: "boat", secret: Redacted.make("second") });

        const boat = Option.getOrThrow(yield* credentials.get("boat"));
        assert.strictEqual(Redacted.value(boat.secret), "second");
      }),
    ),
  );

  it.effect("refuses to save a key when secure storage is unavailable", () =>
    withCredentials(
      Effect.gen(function* () {
        const credentials = yield* DesktopSandboxCredentials.DesktopSandboxCredentials;
        const error = yield* Effect.flip(
          credentials.set({ providerId: "boat", secret: Redacted.make("boat-secret-key") }),
        );

        assert.strictEqual(error._tag, "DesktopSandboxCredentialsError");
        assert.include(error.message, "secure storage is unavailable");
        assert.notInclude(error.message, "boat-secret-key");
        assert.isFalse(yield* credentials.has("boat"));
      }),
      false,
    ),
  );
});
