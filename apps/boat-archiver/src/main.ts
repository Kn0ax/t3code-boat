/**
 * `t3-boat-archiver`: one pass of the boat VM lifecycle rules, then exit.
 * Run it from a timer next to the home T3 server (see README.md).
 *
 * Environment:
 * - BOAT_API_KEY: the boat key the home T3 server uses for boat VMs.
 * - T3_URL: the home T3 server's origin, such as http://127.0.0.1:3773.
 * - T3_TOKEN: a bearer token with the orchestration:operate scope.
 * - IDLE_MINUTES (optional, default 30): how long without a message stops a VM.
 * - STATE_FILE (optional): where the archiver remembers what it copied.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
import { makeBoatSandboxProvider } from "@t3tools/sandbox-boat";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { ArchiverError, ArchiverState, emptyState, runPass, type HomeServer } from "./archiver.ts";

const StateJson = Schema.fromJsonString(ArchiverState);
const decodeState = Schema.decodeEffect(StateJson);
const encodeState = Schema.encodeEffect(StateJson);

const program = Effect.gen(function* () {
  const config = yield* Config.all({
    boatApiKey: Config.Redacted("BOAT_API_KEY"),
    t3Url: Config.String("T3_URL").pipe(Config.map((url) => url.replace(/\/+$/, ""))),
    t3Token: Config.Redacted("T3_TOKEN"),
    idleMinutes: Config.Int("IDLE_MINUTES").pipe(Config.withDefault(30)),
    stateFile: Config.String("STATE_FILE").pipe(Config.option),
    stateHome: Config.String("XDG_STATE_HOME").pipe(Config.option),
    home: Config.String("HOME"),
  });
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const stateFile = Option.getOrElse(config.stateFile, () =>
    path.join(
      Option.getOrElse(config.stateHome, () => path.join(config.home, ".local", "state")),
      "t3-boat-archiver",
      "state.json",
    ),
  );

  const state = yield* fileSystem.readFileString(stateFile).pipe(
    Effect.flatMap(decodeState),
    Effect.orElseSucceed(() => emptyState),
  );

  const home: HomeServer = {
    importThread: (input) =>
      HttpClientRequest.post(`${config.t3Url}/api/orchestration/threads/import`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(config.t3Token)),
        HttpClientRequest.setHeader(
          ORCHESTRATION_PROTOCOL_HEADER,
          ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        ),
        HttpClientRequest.bodyJson(input),
        Effect.flatMap(httpClient.execute),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? Effect.void
            : response.text.pipe(
                Effect.flatMap((text) =>
                  Effect.fail(
                    new ArchiverError({
                      message: `home T3 answered ${response.status}: ${text.slice(0, 300)}`,
                    }),
                  ),
                ),
              ),
        ),
        Effect.mapError((error) =>
          error._tag === "ArchiverError" ? error : new ArchiverError({ message: error.message }),
        ),
      ),
  };

  const provider = makeBoatSandboxProvider({
    apiKey: config.boatApiKey,
    noEnv: true,
    monitoring: false,
  });
  const now = yield* DateTime.now;
  const { state: next, reports } = yield* runPass({
    provider,
    home,
    state,
    nowMs: DateTime.toEpochMillis(now),
    idleMinutes: config.idleMinutes,
  });

  yield* fileSystem.makeDirectory(path.dirname(stateFile), { recursive: true });
  yield* fileSystem.writeFileString(`${stateFile}.tmp`, yield* encodeState(next));
  yield* fileSystem.rename(`${stateFile}.tmp`, stateFile);
  for (const report of reports) {
    if (report.action === "none" && report.copied.length === 0 && report.problems.length === 0) {
      continue;
    }
    yield* Effect.log("boat.archiver.vm", report);
  }
});

program.pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  NodeRuntime.runMain,
);
