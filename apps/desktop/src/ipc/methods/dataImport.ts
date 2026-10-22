import { DesktopT3DataImportInputSchema, DesktopT3DataImportStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopDataImport from "../../app/DesktopDataImport.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getT3DataImport = makeIpcMethod({
  channel: IpcChannels.GET_T3_DATA_IMPORT_CHANNEL,
  payload: Schema.Void,
  result: DesktopT3DataImportStateSchema,
  handler: Effect.fn("desktop.ipc.dataImport.getState")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* DesktopDataImport.readState({
      homeDirectory: environment.homeDirectory,
      baseDir: environment.baseDir,
    });
  }),
});

export const importT3Data = makeIpcMethod({
  channel: IpcChannels.IMPORT_T3_DATA_CHANNEL,
  payload: DesktopT3DataImportInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.dataImport.start")(function* (input) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    yield* DesktopDataImport.writeRequest(environment.baseDir, input);
    yield* lifecycle.relaunch("import-t3-data");
  }),
});
