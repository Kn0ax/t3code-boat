import * as Schema from "effect/Schema";

export class HandoffGitCommandError extends Schema.TaggedError<HandoffGitCommandError>()(
  "HandoffGitCommandError",
  {
    /** Which handoff step ran the command, e.g. `write-tree:index`. */
    step: Schema.String,
    cwd: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stderr: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const status = this.exitCode === undefined ? "could not run" : `exited ${this.exitCode}`;
    const detail = this.stderr === undefined ? "" : `: ${this.stderr}`;
    return `git (${this.step}) ${status} in '${this.cwd}'${detail}`;
  }
}

export class HandoffNotAWorkTreeError extends Schema.TaggedError<HandoffNotAWorkTreeError>()(
  "HandoffNotAWorkTreeError",
  { cwd: Schema.String },
) {
  override get message(): string {
    return `'${this.cwd}' is not inside a git work tree.`;
  }
}

export class HandoffUnbornHeadError extends Schema.TaggedError<HandoffUnbornHeadError>()(
  "HandoffUnbornHeadError",
  { cwd: Schema.String },
) {
  override get message(): string {
    return `The repository at '${this.cwd}' has no commits yet, so there is no base to hand off.`;
  }
}

export class HandoffUnmergedPathsError extends Schema.TaggedError<HandoffUnmergedPathsError>()(
  "HandoffUnmergedPathsError",
  { cwd: Schema.String, pathCount: Schema.Number },
) {
  override get message(): string {
    return `The index at '${this.cwd}' has ${this.pathCount} unmerged path(s); resolve the conflict before moving the session.`;
  }
}

export class HandoffRevisionNotFoundError extends Schema.TaggedError<HandoffRevisionNotFoundError>()(
  "HandoffRevisionNotFoundError",
  { cwd: Schema.String, revision: Schema.String },
) {
  override get message(): string {
    return `Revision '${this.revision}' does not name a commit in '${this.cwd}'.`;
  }
}

export class HandoffFileSystemError extends Schema.TaggedError<HandoffFileSystemError>()(
  "HandoffFileSystemError",
  {
    operation: Schema.Literals([
      "makeTempDirectory",
      "copyFile",
      "utimes",
      "writeFile",
      "stat",
      "readDirectory",
      "realPath",
      "remove",
    ]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Filesystem operation '${this.operation}' failed for '${this.path}'.`;
  }
}

export const HandoffProvider = Schema.Literals(["codex", "claude"]);
export type HandoffProvider = typeof HandoffProvider.Type;

export class HandoffTranscriptNotFoundError extends Schema.TaggedError<HandoffTranscriptNotFoundError>()(
  "HandoffTranscriptNotFoundError",
  {
    provider: HandoffProvider,
    nativeThreadId: Schema.String,
    /** Directories that were searched, in order. */
    searched: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `No ${this.provider} transcript for '${this.nativeThreadId}' under ${this.searched.join(", ")}.`;
  }
}

export class HandoffInvalidInputError extends Schema.TaggedError<HandoffInvalidInputError>()(
  "HandoffInvalidInputError",
  { field: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Invalid ${this.field}: ${this.reason}`;
  }
}

export type WorkspaceSnapshotError =
  | HandoffGitCommandError
  | HandoffNotAWorkTreeError
  | HandoffUnbornHeadError
  | HandoffUnmergedPathsError
  | HandoffRevisionNotFoundError
  | HandoffFileSystemError
  | HandoffInvalidInputError;

export type LocateTranscriptError =
  | HandoffTranscriptNotFoundError
  | HandoffInvalidInputError
  | HandoffFileSystemError;
