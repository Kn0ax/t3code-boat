import type { DesktopSandboxProviderId } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

/**
 * A cloud sandbox provider's credential as the main process holds it. It is
 * read only here, to build that provider's client, and never crosses IPC.
 */
export interface DesktopSandboxProviderCredential {
  readonly secret: Redacted.Redacted<string>;
}

/** One encrypted entry per provider, so replacing one key never rewrites another's. */
const CredentialsDocument = Schema.Struct({
  version: Schema.Literal(1),
  providers: Schema.Record(Schema.String, Schema.String),
});
type CredentialsDocument = typeof CredentialsDocument.Type;
const CredentialsDocumentJson = fromLenientJson(CredentialsDocument);
const decodeCredentialsDocumentJson = Schema.decodeEffect(CredentialsDocumentJson);
const encodeCredentialsDocumentJson = Schema.encodeEffect(CredentialsDocumentJson);

const StoredCredential = Schema.Struct({
  secret: Schema.String,
});
const StoredCredentialJson = Schema.fromJsonString(StoredCredential);
const decodeStoredCredentialJson = Schema.decodeEffect(StoredCredentialJson);
const encodeStoredCredentialJson = Schema.encodeEffect(StoredCredentialJson);

const EMPTY_DOCUMENT: CredentialsDocument = { version: 1, providers: {} };

export const DesktopSandboxCredentialsOperation = Schema.Literals([
  "check-encryption-availability",
  "read",
  "decode",
  "encrypt",
  "decrypt",
  "write",
]);
export type DesktopSandboxCredentialsOperation = typeof DesktopSandboxCredentialsOperation.Type;

export class DesktopSandboxCredentialsError extends Schema.TaggedError<DesktopSandboxCredentialsError>()(
  "DesktopSandboxCredentialsError",
  {
    operation: DesktopSandboxCredentialsOperation,
    providerId: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.operation) {
      case "check-encryption-availability":
      case "encrypt":
        return "This computer's secure storage is unavailable, so T3 Code cannot save the sandbox API key.";
      case "decrypt":
      case "decode":
        return "T3 Code could not read the saved sandbox API key. Enter it again.";
      case "read":
      case "write":
        return `T3 Code could not ${this.operation} its saved sandbox API keys.`;
    }
  }
}

export class DesktopSandboxCredentials extends Context.Service<
  DesktopSandboxCredentials,
  {
    readonly get: (
      providerId: DesktopSandboxProviderId,
    ) => Effect.Effect<
      Option.Option<DesktopSandboxProviderCredential>,
      DesktopSandboxCredentialsError
    >;
    readonly has: (
      providerId: DesktopSandboxProviderId,
    ) => Effect.Effect<boolean, DesktopSandboxCredentialsError>;
    readonly set: (input: {
      readonly providerId: DesktopSandboxProviderId;
      readonly secret: Redacted.Redacted<string>;
    }) => Effect.Effect<void, DesktopSandboxCredentialsError>;
    readonly clear: (
      providerId: DesktopSandboxProviderId,
    ) => Effect.Effect<void, DesktopSandboxCredentialsError>;
  }
>()("@t3tools/desktop/sandbox/DesktopSandboxCredentials") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const crypto = yield* Crypto.Crypto;
  const credentialsPath = path.join(environment.stateDir, "sandbox-provider-credentials.json");
  // Read-modify-write of one file: two saves at once must not drop either.
  const writeLock = yield* Semaphore.make(1);

  const fail =
    (operation: DesktopSandboxCredentialsOperation, providerId?: DesktopSandboxProviderId) =>
    (cause: unknown) =>
      new DesktopSandboxCredentialsError({
        operation,
        ...(providerId === undefined ? {} : { providerId }),
        cause,
      });

  const readDocument: Effect.Effect<CredentialsDocument, DesktopSandboxCredentialsError> =
    fileSystem.readFileString(credentialsPath).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(fail("read")(error)),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(EMPTY_DOCUMENT),
          onSome: (raw) => decodeCredentialsDocumentJson(raw).pipe(Effect.mapError(fail("decode"))),
        }),
      ),
    );

  const writeDocument = Effect.fn("desktop.sandboxCredentials.writeDocument")(function* (
    document: CredentialsDocument,
  ) {
    const encoded = yield* encodeCredentialsDocumentJson(document).pipe(
      Effect.mapError(fail("write")),
    );
    const suffix = (yield* crypto.randomUUIDv4().pipe(Effect.mapError(fail("write")))).replace(
      /-/g,
      "",
    );
    const tempPath = `${credentialsPath}.${process.pid}.${suffix}.tmp`;
    yield* fileSystem
      .makeDirectory(path.dirname(credentialsPath), { recursive: true })
      .pipe(Effect.mapError(fail("write")));
    yield* fileSystem
      .writeFileString(tempPath, `${encoded}\n`)
      .pipe(
        Effect.andThen(fileSystem.rename(tempPath, credentialsPath)),
        Effect.mapError(fail("write")),
        Effect.ensuring(fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)),
      );
  });

  const requireEncryption = (providerId: DesktopSandboxProviderId) =>
    safeStorage.isEncryptionAvailable.pipe(
      Effect.mapError(fail("check-encryption-availability", providerId)),
      Effect.filterOrFail(
        (available) => available,
        () => new DesktopSandboxCredentialsError({ operation: "encrypt", providerId }),
      ),
    );

  const get = Effect.fn("desktop.sandboxCredentials.get")(function* (
    providerId: DesktopSandboxProviderId,
  ) {
    const encrypted = (yield* readDocument).providers[providerId];
    if (encrypted === undefined) {
      return Option.none<DesktopSandboxProviderCredential>();
    }
    yield* requireEncryption(providerId);
    const bytes = yield* Effect.fromResult(Base64.decode(encrypted)).pipe(
      Effect.mapError(fail("decode", providerId)),
    );
    const json = yield* safeStorage
      .decryptString(bytes)
      .pipe(Effect.mapError(fail("decrypt", providerId)));
    const stored = yield* decodeStoredCredentialJson(json).pipe(
      Effect.mapError(fail("decode", providerId)),
    );
    return Option.some<DesktopSandboxProviderCredential>({
      secret: Redacted.make(stored.secret),
    });
  });

  return DesktopSandboxCredentials.of({
    get,
    has: (providerId) =>
      readDocument.pipe(
        Effect.map((document) => document.providers[providerId] !== undefined),
        Effect.withSpan("desktop.sandboxCredentials.has"),
      ),
    set: Effect.fn("desktop.sandboxCredentials.set")(
      function* (input) {
        yield* requireEncryption(input.providerId);
        const json = yield* encodeStoredCredentialJson({
          secret: Redacted.value(input.secret),
        }).pipe(Effect.mapError(fail("encrypt", input.providerId)));
        const encrypted = Base64.encode(
          yield* safeStorage
            .encryptString(json)
            .pipe(Effect.mapError(fail("encrypt", input.providerId))),
        );
        const document = yield* readDocument.pipe(
          // An unreadable file holds nothing usable; saving a key replaces it.
          Effect.orElseSucceed(() => EMPTY_DOCUMENT),
        );
        yield* writeDocument({
          version: 1,
          providers: { ...document.providers, [input.providerId]: encrypted },
        });
      },
      writeLock.withPermits(1),
      Effect.withSpan("desktop.sandboxCredentials.set"),
    ),
    clear: Effect.fn("desktop.sandboxCredentials.clear")(
      function* (providerId) {
        const document = yield* readDocument.pipe(Effect.orElseSucceed(() => EMPTY_DOCUMENT));
        if (document.providers[providerId] === undefined) {
          return;
        }
        const { [providerId]: _removed, ...providers } = document.providers;
        yield* writeDocument({ version: 1, providers });
      },
      writeLock.withPermits(1),
      Effect.withSpan("desktop.sandboxCredentials.clear"),
    ),
  });
});

export const layer = Layer.effect(DesktopSandboxCredentials, make);
