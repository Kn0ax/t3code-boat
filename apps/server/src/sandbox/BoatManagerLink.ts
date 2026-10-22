import {
  BoatVmError,
  ServerSettingsError,
  type SandboxJobSettings,
  type SandboxJobSettingsPatch,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as SandboxNodeMcp from "./SandboxNodeMcp.ts";

/**
 * A server without a boat key of its own can link to the T3 server that has
 * one (the manager) and forward its boat VM MCP tools there. It signs in like
 * sandbox jobs sign in to a node: an outside MCP client of the manager's
 * `/mcp`, through the MCP OAuth flow with a one-time pairing code the owner
 * mints on the manager. The session it gets is stored as a settings secret.
 */
export class BoatManagerLink extends Context.Service<
  BoatManagerLink,
  {
    /** The manager's origin when this server has no boat key and is linked to one. */
    readonly manager: Effect.Effect<Option.Option<string>, BoatVmError>;
    /** Calls a boat VM tool on the manager; a tool failure there comes back as it was. */
    readonly call: <P extends Schema.Top, S extends Schema.Top>(input: {
      readonly tool: string;
      readonly parameters: P;
      readonly arguments: P["Type"];
      readonly result: S;
    }) => Effect.Effect<
      S["Type"],
      BoatVmError | SandboxNodeMcp.SandboxNodeToolError,
      P["EncodingServices"] | S["DecodingServices"]
    >;
    /**
     * Spends a settings patch's pairing code for a session on the manager and
     * puts the session in the patch instead; clearing the URL unlinks. The code
     * itself is never stored.
     */
    readonly prepareSettingsPatch: (
      patch: SandboxJobSettingsPatch,
    ) => Effect.Effect<SandboxJobSettingsPatch, ServerSettingsError>;
  }
>()("t3/sandbox/BoatManagerLink") {}

const CLIENT_NAME = "T3 Code boat manager link";

/** The manager's origin, or undefined for anything but an http(s) URL. */
const managerOrigin = (raw: string): string | undefined => {
  if (!URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
};

const hostOf = (origin: string) => new URL(origin).host;

const relinkNeeded = (origin: string) =>
  new BoatVmError({
    message: `This server's link to the boat manager at ${hostOf(origin)} has ended. Pair it again with a new code in Settings, Sandbox jobs, Boat manager.`,
  });

const make = Effect.gen(function* () {
  const settingsService = yield* Settings.ServerSettingsService;
  const nodeMcp = yield* SandboxNodeMcp.SandboxNodeMcp;
  const { settingsPath } = yield* ServerConfig.ServerConfig;

  const getSettings = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.sandboxJobs),
    Effect.mapError(() => new BoatVmError({ message: "Could not read the server settings." })),
  );

  const managerOf = (settings: SandboxJobSettings) =>
    settings.providerKeys.boat.trim() === "" && settings.boatManager.url !== ""
      ? Option.some(settings.boatManager.url)
      : Option.none();

  const manager: BoatManagerLink["Service"]["manager"] = getSettings.pipe(Effect.map(managerOf));

  const call = Effect.fn("BoatManagerLink.call")(
    function* <P extends Schema.Top, S extends Schema.Top>(input: {
      readonly tool: string;
      readonly parameters: P;
      readonly arguments: P["Type"];
      readonly result: S;
    }) {
      const settings = yield* getSettings;
      const origin = managerOf(settings);
      if (Option.isNone(origin)) {
        return yield* new BoatVmError({ message: "This server is not linked to a boat manager." });
      }
      const { token, expiresAt } = settings.boatManager;
      const expiry = DateTime.make(expiresAt);
      const now = yield* DateTime.now;
      if (token === "" || (Option.isSome(expiry) && DateTime.isLessThan(expiry.value, now))) {
        return yield* relinkNeeded(origin.value);
      }
      // oxlint-disable-next-line t3code/no-inline-schema-compile -- The tool's parameters are the caller's, so they are only known per call.
      const encoded = yield* Schema.encodeUnknownEffect(input.parameters)(input.arguments).pipe(
        Effect.mapError(
          () => new BoatVmError({ message: `Could not send ${input.tool} to the boat manager.` }),
        ),
      );
      return yield* nodeMcp
        .call({
          endpoint: { httpBaseUrl: origin.value, headers: {} },
          token: Redacted.make(token),
          tool: input.tool,
          arguments: encoded as Readonly<Record<string, unknown>>,
          result: input.result,
        })
        .pipe(
          Effect.catchTags({
            SandboxNodeMcpError: (error) =>
              Effect.fail(
                error.reason === "unauthorized"
                  ? relinkNeeded(origin.value)
                  : new BoatVmError({
                      message:
                        error.reason === "bad-response"
                          ? `The boat manager at ${hostOf(origin.value)} answered ${input.tool} in an unexpected shape; it may run another T3 release.`
                          : `The boat manager at ${hostOf(origin.value)} did not answer ${input.tool}.`,
                    }),
              ),
          }),
        );
    },
    (effect, input) => effect.pipe(Effect.annotateSpans({ tool: input.tool })),
  );

  const linkFailure = (cause?: unknown) =>
    new ServerSettingsError({ settingsPath, operation: "link-boat-manager", cause });

  const prepareSettingsPatch: BoatManagerLink["Service"]["prepareSettingsPatch"] = Effect.fn(
    "BoatManagerLink.prepareSettingsPatch",
  )(function* (patch) {
    const { boatManager, ...rest } = patch;
    if (boatManager === undefined) return patch;
    // The session is only ever the server's own, from a pairing code below.
    const { pairingCode, url: requestedUrl } = boatManager;
    const current = (yield* settingsService.getSettings).sandboxJobs.boatManager;
    const raw = (requestedUrl ?? current.url).trim();
    if (raw === "") {
      return { ...rest, boatManager: { url: "", token: "", expiresAt: "" } };
    }
    const url = managerOrigin(raw);
    if (url === undefined) return yield* linkFailure();
    const code = pairingCode?.trim() ?? "";
    if (code === "") {
      // A session for one manager is never sent to another one.
      return url === current.url ? { ...rest, boatManager: { url } } : yield* linkFailure();
    }
    const signedIn = yield* nodeMcp
      .signIn({ httpBaseUrl: url, headers: {} }, code, CLIENT_NAME)
      .pipe(
        Effect.tapError((error) =>
          Effect.logWarning("boat.manager.link.failed", {
            host: hostOf(url),
            reason: error.reason,
          }),
        ),
        Effect.mapError(linkFailure),
      );
    const expiresAt = DateTime.add(yield* DateTime.now, { seconds: signedIn.expiresInSeconds });
    return {
      ...rest,
      boatManager: {
        url,
        token: Redacted.value(signedIn.token),
        expiresAt: DateTime.formatIso(expiresAt),
      },
    };
  });

  return BoatManagerLink.of({ manager, call, prepareSettingsPatch });
});

export const layer = Layer.effect(BoatManagerLink, make).pipe(Layer.provide(SandboxNodeMcp.layer));
