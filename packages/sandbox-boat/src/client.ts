/**
 * The slice of the boat API the adapter uses, as an interface a test can fake,
 * plus the binding to the real `@boatdev/sdk` client.
 *
 * Requests use the SDK's own body types; responses are structural subsets of
 * the SDK's models, so `makeBoatSdkClient` would stop compiling if the SDK
 * dropped or reshaped any field read here. Every call takes an `AbortSignal`
 * so an interrupted Effect cancels its HTTP request.
 */
import {
  BoatApi,
  Configuration,
  type CommandRequest,
  type CreateSandboxRequest,
  type ForkRequest,
  type HostPortRequest,
} from "@boatdev/sdk";
import * as Redacted from "effect/Redacted";

/** boat's hosted API, the SDK's own default. */
const DEFAULT_BOAT_API_URL = "https://boat.dev/api/v1";

/** The fields of the SDK's `Sandbox` the adapter reads. */
export interface BoatSandbox {
  readonly id: string;
  readonly name?: string;
  /** `SandboxStateEnum`: init, provisioning, ..., ready, idle, running, archiving, archived, error, cancelled. */
  readonly state: string;
  /** The last stop requested; `pending` / `failing` while the sandbox is archiving. */
  readonly stop?: { readonly status: string } | null;
  /**
   * `owner` for a sandbox the caller created. In an organization's scope a
   * listing also holds teammates' sandboxes (`use` / `view`).
   */
  readonly access?: string;
}

export interface BoatSandboxResponse {
  readonly sandbox: BoatSandbox;
}

export interface BoatSandboxPage {
  readonly sandboxes: ReadonlyArray<BoatSandbox>;
  readonly pageInfo?: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

/** A synchronous command's result (`type: "command.finished"`). */
export interface BoatCommandFinished {
  readonly type: "command.finished";
  readonly exitCode: number | null;
  readonly signal?: string | null;
  readonly oomKilled?: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** boat cut the stream: what arrived is not all the command wrote. */
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
  readonly timedOut: boolean;
}

/** A detached command's start confirmation (`type: "command.started"`). */
export interface BoatCommandStarted {
  readonly type: "command.started";
  readonly processId: number;
}

export interface BoatCommandStatus {
  /** running, exited, or lost (the sandbox agent restarted and forgot the process). */
  readonly status: string;
  readonly running: boolean;
  readonly exitCode: number | null;
  readonly signal?: string | null;
  readonly oomKilled?: boolean;
  /** Output written since the requested offset. */
  readonly stdout: string;
  readonly stderr: string;
  /** Where `stdout` starts: the offset asked for, or 0 when the log was replaced. */
  readonly stdoutOffset?: number;
  readonly stderrOffset?: number;
  readonly stdoutNextOffset?: number;
  readonly stderrNextOffset?: number;
  /** More output is already written: read again at once. */
  readonly more?: boolean;
}

export interface BoatHostedPort {
  /** Public HTTPS URL; carries a `_token` query parameter unless the port is public. Secret. */
  readonly url?: string;
  readonly isProtected?: boolean;
  /** `public` or `private`. */
  readonly access?: string;
}

export interface BoatForked {
  /** The new sandbox's id. */
  readonly id: string;
  readonly sandbox?: BoatSandbox | null;
}

export interface BoatCallOptions {
  readonly signal?: AbortSignal;
}

export interface BoatClient {
  /** `idempotencyKey` travels as the `Idempotency-Key` header. */
  readonly create: (
    request: { readonly idempotencyKey: string; readonly body: CreateSandboxRequest },
    options?: BoatCallOptions,
  ) => Promise<BoatSandboxResponse>;
  readonly get: (sandboxId: string, options?: BoatCallOptions) => Promise<BoatSandboxResponse>;
  readonly list: (
    request: { readonly cursor?: string },
    options?: BoatCallOptions,
  ) => Promise<BoatSandboxPage>;
  readonly rename: (
    sandboxId: string,
    name: string,
    options?: BoatCallOptions,
  ) => Promise<BoatSandboxResponse>;
  /** Command200Response: finished for a synchronous call, started for `detached`. */
  readonly command: (
    sandboxId: string,
    request: CommandRequest,
    options?: BoatCallOptions,
  ) => Promise<BoatCommandFinished | BoatCommandStarted | { readonly type?: undefined }>;
  readonly commandStatus: (
    sandboxId: string,
    request: {
      readonly processId: number;
      readonly stdoutOffset: number;
      readonly stderrOffset: number;
    },
    options?: BoatCallOptions,
  ) => Promise<BoatCommandStatus>;
  readonly stopCommand: (
    sandboxId: string,
    processId: number,
    options?: BoatCallOptions,
  ) => Promise<unknown>;
  /** Content comes back base64-encoded. */
  readonly readFile: (
    sandboxId: string,
    path: string,
    options?: BoatCallOptions,
  ) => Promise<{ readonly content: string; readonly encoding: string }>;
  readonly writeFile: (
    sandboxId: string,
    request: { readonly path: string; readonly contentBase64: string },
    options?: BoatCallOptions,
  ) => Promise<unknown>;
  readonly hostPort: (
    sandboxId: string,
    request: HostPortRequest,
    options?: BoatCallOptions,
  ) => Promise<BoatHostedPort>;
  /** Moves the auto-stop deadline to now + `ttlSeconds`. */
  readonly setTtl: (
    sandboxId: string,
    ttlSeconds: number,
    options?: BoatCallOptions,
  ) => Promise<BoatSandboxResponse>;
  readonly stop: (sandboxId: string, options?: BoatCallOptions) => Promise<unknown>;
  readonly resume: (
    sandboxId: string,
    options?: BoatCallOptions,
  ) => Promise<{ readonly sandbox?: BoatSandbox | null }>;
  /** Irreversible: removes the machine and every snapshot only it uses. */
  readonly deleteSandbox: (sandboxId: string, options?: BoatCallOptions) => Promise<unknown>;
  /** `idempotencyKey` travels as the `Idempotency-Key` header. */
  readonly fork: (
    sandboxId: string,
    request: { readonly idempotencyKey: string; readonly body: ForkRequest },
    options?: BoatCallOptions,
  ) => Promise<BoatForked>;
}

/**
 * Thrown in place of a request when no API key is configured, so a blank key
 * never sends an unauthenticated request; classified as `unauthorized`.
 */
export class BoatMissingApiKeyError extends Error {
  override readonly name = "BoatMissingApiKeyError";
  constructor() {
    super("No boat API key is configured.");
  }
}

export interface BoatSdkClientConfig {
  /** boat API key. Secret: only ever read by the SDK when it builds a request's bearer header. */
  readonly apiKey: Redacted.Redacted<string>;
  /** Defaults to `DEFAULT_BOAT_API_URL`. */
  readonly baseUrl?: string;
  /** Organization wallet new sandboxes bill to (id or name); omitted uses the account's active wallet. */
  readonly org?: string;
}

const init = (options: BoatCallOptions | undefined): RequestInit | undefined =>
  options?.signal === undefined ? undefined : { signal: options.signal };

/** The SDK client for `config`, its key read per request. */
export function makeBoatApi(config: Pick<BoatSdkClientConfig, "apiKey" | "baseUrl">): BoatApi {
  return new BoatApi(
    new Configuration({
      basePath: (config.baseUrl ?? DEFAULT_BOAT_API_URL).replace(/\/+$/, ""),
      // A function, so the key leaves its Redacted wrapper only per request.
      accessToken: () => {
        const apiKey = Redacted.value(config.apiKey).trim();
        if (apiKey.length === 0) {
          throw new BoatMissingApiKeyError();
        }
        return apiKey;
      },
    }),
  );
}

/** Binds `BoatClient` to the real SDK. */
export function makeBoatSdkClient(config: BoatSdkClientConfig): BoatClient {
  const api = makeBoatApi(config);
  const org = config.org === undefined ? {} : { org: config.org };

  return {
    create: (request, options) =>
      api.create(
        {
          idempotencyKey: request.idempotencyKey,
          createSandboxRequest: { ...request.body, ...org },
        },
        init(options),
      ),
    get: (sandboxId, options) => api.get({ sandboxId }, init(options)),
    list: (request, options) =>
      api.sandboxes(
        { ...org, ...(request.cursor === undefined ? {} : { cursor: request.cursor }) },
        init(options),
      ),
    rename: (sandboxId, name, options) =>
      api.update({ sandboxId, updateSandboxRequest: { name } }, init(options)),
    command: (sandboxId, request, options) =>
      api.command({ sandboxId, commandRequest: request }, init(options)),
    commandStatus: (sandboxId, request, options) =>
      api.commandStatus(
        {
          sandboxId,
          processId: request.processId,
          stdoutOffset: request.stdoutOffset,
          stderrOffset: request.stderrOffset,
        },
        init(options),
      ),
    stopCommand: (sandboxId, processId, options) =>
      api.stopCommand({ sandboxId, processId }, init(options)),
    readFile: (sandboxId, path, options) =>
      api.readFile({ sandboxId, path, encoding: "base64" }, init(options)),
    writeFile: (sandboxId, request, options) =>
      api.writeFile(
        {
          sandboxId,
          fileWriteRequest: {
            path: request.path,
            content: request.contentBase64,
            encoding: "base64",
          },
        },
        init(options),
      ),
    hostPort: (sandboxId, request, options) =>
      api.hostPort({ sandboxId, hostPortRequest: request }, init(options)),
    setTtl: (sandboxId, ttlSeconds, options) =>
      api.update({ sandboxId, updateSandboxRequest: { ttlSeconds } }, init(options)),
    stop: (sandboxId, options) => api.stop({ sandboxId }, init(options)),
    resume: (sandboxId, options) => api.resume({ sandboxId }, init(options)),
    deleteSandbox: (sandboxId, options) =>
      // The API demands the sandbox id echoed back as a confirmation header.
      api.deleteSandbox({ sandboxId, xAsciiConfirmDelete: sandboxId }, init(options)),
    fork: (sandboxId, request, options) =>
      api.fork(
        { sandboxId, idempotencyKey: request.idempotencyKey, forkRequest: request.body },
        init(options),
      ),
  };
}
