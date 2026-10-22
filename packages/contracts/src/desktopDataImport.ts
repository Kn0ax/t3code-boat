import * as Schema from "effect/Schema";

/** Copying data from the official T3 Code app's home into this one. */
export const DesktopT3DataImportStateSchema = Schema.Struct({
  sourcePath: Schema.String,
  available: Schema.Boolean,
  imported: Schema.Boolean,
  /** Whether that copy included projects and threads; older shells leave it out. */
  importedProjects: Schema.optionalKey(Schema.Boolean),
  lastError: Schema.optionalKey(Schema.String),
});
export type DesktopT3DataImportState = typeof DesktopT3DataImportStateSchema.Type;

export const DesktopT3DataImportInputSchema = Schema.Struct({
  projects: Schema.Boolean,
  settings: Schema.Boolean,
  secrets: Schema.Boolean,
});
export type DesktopT3DataImportInput = typeof DesktopT3DataImportInputSchema.Type;
