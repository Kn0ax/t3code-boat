// Tool results arrive as JSON text inside MCP envelopes from another T3 server,
// and the MCP bridge takes a fetch function to add the provider's headers.
// @effect-diagnostics preferSchemaOverJson:off globalFetch:off
import { EnvironmentHttpApi } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import { callAcpMcpTool } from "../mcp/AcpMcpStdioBridge.ts";

/**
 * How this server talks to the T3 server inside a sandbox node: as an outside
 * MCP client of the node's own `/mcp`, using the same orchestrator tools an
 * agent would. It signs in through the node's MCP OAuth flow with the
 * one-time pairing code the bootstrap minted, so no new server-to-server
 * protocol exists. The provider's request headers go on
 * every request; this is Node, so no loopback forward is needed.
 */
export interface SandboxNodeEndpoint {
  readonly httpBaseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

export class SandboxNodeMcpError extends Schema.TaggedError<SandboxNodeMcpError>()(
  "SandboxNodeMcpError",
  {
    reason: Schema.Literals(["unreachable", "unsupported", "sign-in-refused", "bad-response"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** A tool on the node answered with a failure of its own. */
export class SandboxNodeToolError extends Schema.TaggedError<SandboxNodeToolError>()(
  "SandboxNodeToolError",
  {
    tool: Schema.String,
    code: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `The sandbox node's ${this.tool} failed (${this.code}): ${this.detail}`;
  }
}

export class SandboxNodeMcp extends Context.Service<
  SandboxNodeMcp,
  {
    /** Spends `pairingCode` for a full-access MCP client session on the node. */
    readonly signIn: (
      endpoint: SandboxNodeEndpoint,
      pairingCode: string,
    ) => Effect.Effect<Redacted.Redacted<string>, SandboxNodeMcpError>;
    readonly call: <S extends Schema.Top>(input: {
      readonly endpoint: SandboxNodeEndpoint;
      readonly token: Redacted.Redacted<string>;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly result: S;
    }) => Effect.Effect<
      S["Type"],
      SandboxNodeMcpError | SandboxNodeToolError,
      S["DecodingServices"]
    >;
  }
>()("t3/sandbox/SandboxNodeMcp") {}

const CLIENT_NAME = "T3 Code sandbox jobs";
// Never contacted: the code comes back in the decision response, not a redirect.
const REDIRECT_URI = "http://127.0.0.1/t3-sandbox-job";

const base64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

const ToolFailure = Schema.Struct({ code: Schema.String, message: Schema.String });
const decodeToolFailure = Schema.decodeUnknownOption(ToolFailure);

interface McpToolEnvelope {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
}

/** The JSON a T3 tool returned, from its structured content or its text. */
const payloadOf = (envelope: McpToolEnvelope): unknown => {
  if (envelope.structuredContent !== undefined) return envelope.structuredContent;
  const text = envelope.content?.find((part) => part.type === "text")?.text;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;

  const withHeaders = (endpoint: SandboxNodeEndpoint) =>
    HttpApiClient.make(EnvironmentHttpApi, {
      baseUrl: endpoint.httpBaseUrl,
      transformClient: HttpClient.mapRequest(HttpClientRequest.setHeaders(endpoint.headers)),
    }).pipe(Effect.provide(FetchHttpClient.layer));

  const signIn = Effect.fn("SandboxNodeMcp.signIn")(function* (
    endpoint: SandboxNodeEndpoint,
    pairingCode: string,
  ) {
    const refused = (detail: string) => (cause: unknown) =>
      new SandboxNodeMcpError({ reason: "sign-in-refused", detail, cause });
    const client = yield* withHeaders(endpoint);
    // The node names its own resource from the Host it sees, which behind a
    // provider proxy is the proxy's; ask instead of computing it.
    // A node that answers without this endpoint runs a t3 release older than
    // MCP sign-in, which needs a different fix than a node that is down.
    const metadata = yield* client.mcpOAuth.mcpProtectedResource().pipe(
      Effect.mapError((cause) =>
        HttpClientError.isHttpClientError(cause) && cause.response === undefined
          ? new SandboxNodeMcpError({
              reason: "unreachable",
              detail: "The sandbox node's T3 server did not answer.",
              cause,
            })
          : new SandboxNodeMcpError({
              reason: "unsupported",
              detail:
                "The sandbox node's T3 release is too old for sandbox jobs: it has no MCP sign-in.",
              cause,
            }),
      ),
    );
    const registered = yield* client.mcpOAuth
      .register({ payload: { client_name: CLIENT_NAME, redirect_uris: [REDIRECT_URI] } })
      .pipe(Effect.mapError(refused("The sandbox node refused to register T3 Code.")));
    const verifier = base64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie));
    const challenge = base64Url(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)).pipe(Effect.orDie),
    );
    const authorization = {
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: metadata.resource,
    };
    const decision = yield* client.mcpOAuth
      .decision({
        payload: {
          authorization,
          decision: { _tag: "pairing-code", access: "full-access", code: pairingCode },
        },
      })
      .pipe(Effect.mapError(refused("The sandbox node refused its pairing code.")));
    const code = new URL(decision.redirectTo).searchParams.get("code");
    if (code === null) {
      return yield* refused("The sandbox node did not approve T3 Code.")(undefined);
    }
    const token = yield* client.mcpOAuth
      .token({
        payload: {
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          client_id: registered.client_id,
          code_verifier: verifier,
          resource: metadata.resource,
        },
      })
      .pipe(Effect.mapError(refused("The sandbox node did not issue a session.")));
    return Redacted.make(token.access_token);
  });

  const call = Effect.fn("SandboxNodeMcp.call")(
    function* <S extends Schema.Top>(input: {
      readonly endpoint: SandboxNodeEndpoint;
      readonly token: Redacted.Redacted<string>;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly result: S;
    }) {
      const result = yield* callAcpMcpTool({
        endpoint: `${input.endpoint.httpBaseUrl.replace(/\/+$/, "")}/mcp`,
        authorization: `Bearer ${Redacted.value(input.token)}`,
        tool: input.tool,
        arguments: input.arguments,
        fetchImplementation: (url, init) =>
          fetch(url, {
            ...init,
            headers: { ...input.endpoint.headers, ...(init?.headers as Record<string, string>) },
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new SandboxNodeMcpError({
              reason: "unreachable",
              detail: `Could not call ${input.tool} on the sandbox node.`,
              cause,
            }),
        ),
      );
      const envelope = (
        typeof result === "object" && result !== null ? result : {}
      ) as McpToolEnvelope;
      const payload = payloadOf(envelope);
      if (envelope.isError === true) {
        const failure = Option.getOrUndefined(decodeToolFailure(payload));
        return yield* new SandboxNodeToolError({
          tool: input.tool,
          code: failure?.code ?? "tool_error",
          detail: failure?.message ?? "The tool reported an error.",
        });
      }
      // oxlint-disable-next-line t3code/no-inline-schema-compile -- The result schema is the caller's, so it is only known per call.
      return yield* Schema.decodeUnknownEffect(input.result)(payload).pipe(
        Effect.mapError(
          (cause) =>
            new SandboxNodeMcpError({
              reason: "bad-response",
              detail: `The sandbox node's ${input.tool} answered in an unexpected shape.`,
              cause,
            }),
        ),
      );
    },
    (effect, input) =>
      effect.pipe(Effect.withSpan("SandboxNodeMcp.call", { attributes: { tool: input.tool } })),
  );

  return SandboxNodeMcp.of({ signIn, call });
});

export const layer = Layer.effect(SandboxNodeMcp, make);
