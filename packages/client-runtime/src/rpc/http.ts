import {
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  type EnvironmentAuthInvalidError,
  type EnvironmentInternalError,
  type EnvironmentOperationForbiddenError,
  type EnvironmentRequestInvalidError,
  type EnvironmentResourceNotFoundError,
  type EnvironmentScopeRequiredError,
} from "@t3tools/contracts";
import * as HttpObservability from "@t3tools/shared/httpObservability";
import { BOAT_PROXY_TOKEN_QUERY_PARAM, boatProxySandboxId } from "@t3tools/shared/boatProxy";
import { normalizeHttpBaseUrl } from "../environment/endpoint.ts";
import * as Redacted from "effect/Redacted";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export class RemoteEnvironmentAuthFetchError extends Data.TaggedError(
  "RemoteEnvironmentAuthFetchError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class RemoteEnvironmentAuthInvalidJsonError extends Data.TaggedError(
  "RemoteEnvironmentAuthInvalidJsonError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class RemoteEnvironmentAuthUndeclaredStatusError extends Data.TaggedError(
  "RemoteEnvironmentAuthUndeclaredStatusError",
)<{
  readonly message: string;
  readonly status: number;
  readonly requestUrl: string;
}> {
  constructor(requestUrl: string, status: number) {
    super({
      message: `Remote environment endpoint ${safeRequestUrl(requestUrl)} returned undeclared status ${status}.`,
      requestUrl: safeRequestUrl(requestUrl),
      status,
    });
  }
}

export class RemoteEnvironmentAuthTimeoutError extends Data.TaggedError(
  "RemoteEnvironmentAuthTimeoutError",
)<{
  readonly message: string;
  readonly requestUrl: string;
  readonly timeoutMs: number;
}> {
  constructor(requestUrl: string, timeoutMs: number) {
    super({
      message: `Remote environment endpoint ${safeRequestUrl(requestUrl)} timed out after ${timeoutMs}ms.`,
      requestUrl: safeRequestUrl(requestUrl),
      timeoutMs,
    });
  }
}

export type RemoteEnvironmentRequestError =
  | EnvironmentRequestInvalidError
  | EnvironmentAuthInvalidError
  | EnvironmentScopeRequiredError
  | EnvironmentOperationForbiddenError
  | EnvironmentResourceNotFoundError
  | EnvironmentInternalError
  | RemoteEnvironmentAuthFetchError
  | RemoteEnvironmentAuthInvalidJsonError
  | RemoteEnvironmentAuthUndeclaredStatusError
  | RemoteEnvironmentAuthTimeoutError;

export const layerRemoteHttpClient = (
  fetchFn: typeof globalThis.fetch,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.merge(
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
    HttpObservability.layer,
  );

const remoteApiBaseUrl = normalizeHttpBaseUrl;

const proxyToken = (baseUrl: string) =>
  boatProxySandboxId(baseUrl) === undefined
    ? null
    : new URL(baseUrl).searchParams.get(BOAT_PROXY_TOKEN_QUERY_PARAM);

const proxyHttpClient = (baseUrl: string) => (client: HttpClient.HttpClient) => {
  const token = proxyToken(baseUrl);
  return token === null
    ? client
    : client.pipe(
        HttpClient.mapRequest(
          HttpClientRequest.setUrlParam(BOAT_PROXY_TOKEN_QUERY_PARAM, Redacted.make(token)),
        ),
      );
};

const safeRequestUrl = (requestUrl: string) => {
  const url = new URL(requestUrl);
  url.searchParams.delete(BOAT_PROXY_TOKEN_QUERY_PARAM);
  return url.toString();
};

export const makeEnvironmentHttpApiClient = (httpBaseUrl: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: remoteApiBaseUrl(httpBaseUrl),
    transformClient: proxyHttpClient(httpBaseUrl),
  });

export const makeEnvironmentHttpApiGroupClient = <
  Group extends keyof typeof EnvironmentHttpApi.groups,
>(
  httpBaseUrl: string,
  group: Group,
) =>
  Effect.flatMap(HttpClient.HttpClient, (httpClient) =>
    HttpApiClient.group(EnvironmentHttpApi, {
      httpClient: proxyHttpClient(httpBaseUrl)(httpClient),
      group,
      baseUrl: remoteApiBaseUrl(httpBaseUrl),
    }),
  );

export const makeEnvironmentHttpApiUrlBuilder = (httpBaseUrl: string) => {
  const builder = HttpApiClient.urlBuilder(EnvironmentHttpApi, {
    baseUrl: remoteApiBaseUrl(httpBaseUrl),
  });
  const token = proxyToken(httpBaseUrl);
  if (token === null) return builder;
  for (const group of Object.values(builder)) {
    for (const [name, build] of Object.entries(group)) {
      Object.defineProperty(group, name, {
        value: (...args: unknown[]) => {
          const url = new URL(Reflect.apply(build, group, args));
          url.searchParams.set(BOAT_PROXY_TOKEN_QUERY_PARAM, token);
          return url.toString();
        },
      });
    }
  }
  return builder;
};

const failRemoteRequest = (
  requestUrl: string,
  cause: unknown,
): Effect.Effect<never, RemoteEnvironmentRequestError> => {
  if (cause instanceof RemoteEnvironmentAuthTimeoutError) {
    return Effect.fail(cause);
  }
  if (isEnvironmentHttpCommonError(cause)) {
    return Effect.fail(cause);
  }
  if (Schema.isSchemaError(cause)) {
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        message: `Remote environment endpoint returned an invalid response from ${safeRequestUrl(requestUrl)}.`,
        cause,
      }),
    );
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    const response = cause.response;
    if (response.status < 200 || response.status >= 300) {
      return Effect.fail(
        new RemoteEnvironmentAuthUndeclaredStatusError(requestUrl, response.status),
      );
    }
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        message: `Remote environment endpoint returned an invalid response from ${safeRequestUrl(requestUrl)}.`,
        cause,
      }),
    );
  }
  return Effect.fail(
    new RemoteEnvironmentAuthFetchError({
      message: `Failed to fetch remote environment endpoint ${safeRequestUrl(requestUrl)}.`,
      cause,
    }),
  );
};

export const executeEnvironmentHttpRequest = <A, E, R>(
  requestUrl: string,
  timeoutMs: number,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, RemoteEnvironmentRequestError, R> =>
  request.pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new RemoteEnvironmentAuthTimeoutError(requestUrl, timeoutMs)),
        onSome: Effect.succeed,
      }),
    ),
    Effect.catch((cause) => failRemoteRequest(requestUrl, cause)),
  );
