import {
  SandboxJobAgent,
  SandboxJobProviderId,
  SandboxJobSize,
  SandboxJobState,
  SandboxJobThread,
  type SandboxJob,
  type SandboxJobId,
  type ThreadId,
  isSandboxJobFinished,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

export class SandboxJobStoreError extends Schema.TaggedError<SandboxJobStoreError>()(
  "SandboxJobStoreError",
  { cause: Schema.optional(Schema.Defect()) },
) {}

/** A job as the server keeps it: the public view plus what only the server needs. */
export interface SandboxJobRecord {
  readonly jobId: SandboxJobId;
  readonly requestKey: string | null;
  readonly parentThreadId: ThreadId | null;
  /** The local checkout the node's workspace was copied from, and where its work comes back. */
  readonly workspaceRoot: string;
  readonly title: string;
  readonly task: string;
  readonly providerId: SandboxJobProviderId;
  readonly size: typeof SandboxJobSize.Type;
  readonly agent: SandboxJobAgent;
  readonly model: string | null;
  readonly state: SandboxJobState;
  readonly sandboxId: string | null;
  /** The workspace's path inside the node. */
  readonly nodeCwd: string | null;
  /** The commit the node's branch starts from; the collected bundle is thin against it. */
  readonly baseCommit: string | null;
  readonly remoteProjectId: string | null;
  readonly threads: ReadonlyArray<SandboxJobThread>;
  readonly activeThreadId: ThreadId | null;
  readonly activeRunId: string | null;
  readonly lastRunStatus: string | null;
  readonly lastSummary: string | null;
  readonly resultRef: string | null;
  readonly resultBranch: string | null;
  readonly pushed: boolean;
  readonly error: string | null;
  readonly idleSince: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SandboxJobRecordPatch = Partial<
  Omit<SandboxJobRecord, "jobId" | "requestKey" | "createdAt" | "updatedAt">
>;

export const toPublicJob = (record: SandboxJobRecord): SandboxJob => ({
  jobId: record.jobId,
  title: record.title,
  parentThreadId: record.parentThreadId,
  providerId: record.providerId,
  size: record.size,
  state: record.state,
  sandboxId: record.sandboxId,
  threads: record.threads,
  activeThreadId: record.activeThreadId,
  lastRunStatus: record.lastRunStatus,
  lastSummary: record.lastSummary,
  resultRef: record.resultRef,
  resultBranch: record.resultBranch,
  pushed: record.pushed,
  error: record.error,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  expiresAt: record.expiresAt,
});

const Row = Schema.Struct({
  job_id: Schema.String,
  request_key: Schema.NullOr(Schema.String),
  parent_thread_id: Schema.NullOr(Schema.String),
  workspace_root: Schema.String,
  title: Schema.String,
  task: Schema.String,
  provider_id: SandboxJobProviderId,
  size: SandboxJobSize,
  agent: SandboxJobAgent,
  model: Schema.NullOr(Schema.String),
  state: SandboxJobState,
  sandbox_id: Schema.NullOr(Schema.String),
  node_cwd: Schema.NullOr(Schema.String),
  base_commit: Schema.NullOr(Schema.String),
  remote_project_id: Schema.NullOr(Schema.String),
  threads_json: Schema.fromJsonString(Schema.Array(SandboxJobThread)),
  active_thread_id: Schema.NullOr(Schema.String),
  active_run_id: Schema.NullOr(Schema.String),
  last_run_status: Schema.NullOr(Schema.String),
  last_summary: Schema.NullOr(Schema.String),
  result_ref: Schema.NullOr(Schema.String),
  result_branch: Schema.NullOr(Schema.String),
  pushed: Schema.Number,
  error: Schema.NullOr(Schema.String),
  idle_since: Schema.NullOr(Schema.String),
  expires_at: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
});
type Row = typeof Row.Encoded;
const decodeRow = Schema.decodeUnknownEffect(Row);
const encodeThreads = Schema.encodeSync(Schema.fromJsonString(Schema.Array(SandboxJobThread)));

const fromRow = (row: unknown) =>
  decodeRow(row).pipe(
    Effect.map((r): SandboxJobRecord => ({
      jobId: r.job_id as SandboxJobId,
      requestKey: r.request_key,
      parentThreadId: r.parent_thread_id as ThreadId | null,
      workspaceRoot: r.workspace_root,
      title: r.title,
      task: r.task,
      providerId: r.provider_id,
      size: r.size,
      agent: r.agent,
      model: r.model,
      state: r.state,
      sandboxId: r.sandbox_id,
      nodeCwd: r.node_cwd,
      baseCommit: r.base_commit,
      remoteProjectId: r.remote_project_id,
      threads: r.threads_json,
      activeThreadId: r.active_thread_id as ThreadId | null,
      activeRunId: r.active_run_id,
      lastRunStatus: r.last_run_status,
      lastSummary: r.last_summary,
      resultRef: r.result_ref,
      resultBranch: r.result_branch,
      pushed: r.pushed !== 0,
      error: r.error,
      idleSince: r.idle_since,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  );

const toRow = (record: SandboxJobRecord): Row => ({
  job_id: record.jobId,
  request_key: record.requestKey,
  parent_thread_id: record.parentThreadId,
  workspace_root: record.workspaceRoot,
  title: record.title,
  task: record.task,
  provider_id: record.providerId,
  size: record.size,
  agent: record.agent,
  model: record.model,
  state: record.state,
  sandbox_id: record.sandboxId,
  node_cwd: record.nodeCwd,
  base_commit: record.baseCommit,
  remote_project_id: record.remoteProjectId,
  threads_json: encodeThreads(record.threads),
  active_thread_id: record.activeThreadId,
  active_run_id: record.activeRunId,
  last_run_status: record.lastRunStatus,
  last_summary: record.lastSummary,
  result_ref: record.resultRef,
  result_branch: record.resultBranch,
  pushed: record.pushed ? 1 : 0,
  error: record.error,
  idle_since: record.idleSince,
  expires_at: record.expiresAt,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
});

export class SandboxJobStore extends Context.Service<
  SandboxJobStore,
  {
    readonly insert: (record: SandboxJobRecord) => Effect.Effect<void, SandboxJobStoreError>;
    readonly get: (
      jobId: SandboxJobId,
    ) => Effect.Effect<SandboxJobRecord | undefined, SandboxJobStoreError>;
    readonly getByRequestKey: (
      requestKey: string,
    ) => Effect.Effect<SandboxJobRecord | undefined, SandboxJobStoreError>;
    /** Applies `patch` and stamps `updatedAt`; returns the stored result. */
    readonly update: (
      jobId: SandboxJobId,
      patch: SandboxJobRecordPatch,
      updatedAt: string,
    ) => Effect.Effect<SandboxJobRecord, SandboxJobStoreError>;
    /** Newest first. */
    readonly list: (input: {
      readonly includeFinished: boolean;
    }) => Effect.Effect<ReadonlyArray<SandboxJobRecord>, SandboxJobStoreError>;
  }
>()("t3/sandbox/SandboxJobStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fail = (cause: unknown) => new SandboxJobStoreError({ cause });

  // Own table, not effect_sql_migrations. Upstream owns those ids, and a fork
  // migration that reuses one is skipped or rejected on the next sync.
  yield* Migrator.make({})({
    table: "sandbox_job_migrations",
    loader: Migrator.fromRecord({
      "1_SandboxJobs": Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // One row per sandbox job (an ephemeral node). The node's MCP session token
        // lives in the secret store, never here.
        yield* sql`
          CREATE TABLE IF NOT EXISTS sandbox_jobs (
            job_id TEXT PRIMARY KEY,
            request_key TEXT UNIQUE,
            parent_thread_id TEXT,
            workspace_root TEXT NOT NULL,
            title TEXT NOT NULL,
            task TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            size TEXT NOT NULL,
            agent TEXT NOT NULL,
            model TEXT,
            state TEXT NOT NULL,
            sandbox_id TEXT,
            node_cwd TEXT,
            base_commit TEXT,
            remote_project_id TEXT,
            threads_json TEXT NOT NULL DEFAULT '[]',
            active_thread_id TEXT,
            active_run_id TEXT,
            last_run_status TEXT,
            last_summary TEXT,
            result_ref TEXT,
            result_branch TEXT,
            pushed INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            idle_since TEXT,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
        `;
        yield* sql`CREATE INDEX IF NOT EXISTS sandbox_jobs_state ON sandbox_jobs (state)`;
      }),
    }),
  }).pipe(Effect.mapError(fail));

  const write = (record: SandboxJobRecord) => {
    const row = toRow(record);
    return sql`INSERT OR REPLACE INTO sandbox_jobs ${sql.insert(row)}`.pipe(
      Effect.asVoid,
      Effect.mapError(fail),
    );
  };

  const selectOne = (rows: ReadonlyArray<unknown>) =>
    rows[0] === undefined
      ? Effect.succeed(undefined)
      : fromRow(rows[0]).pipe(Effect.mapError(fail));

  // Retired providers' rows stay intact for recovery with an older build, and
  // every query skips them as if they were not there.
  const supported = () => sql`provider_id IN ${sql.in(SandboxJobProviderId.literals)}`;

  const get = (jobId: SandboxJobId) =>
    sql`SELECT * FROM sandbox_jobs WHERE job_id = ${jobId} AND ${supported()}`.pipe(
      Effect.mapError(fail),
      Effect.flatMap(selectOne),
    );

  return SandboxJobStore.of({
    insert: (record) =>
      sql`INSERT INTO sandbox_jobs ${sql.insert(toRow(record))}`.pipe(
        Effect.asVoid,
        Effect.mapError(fail),
        Effect.withSpan("SandboxJobStore.insert"),
      ),
    get: (jobId) => get(jobId).pipe(Effect.withSpan("SandboxJobStore.get")),
    getByRequestKey: (requestKey) =>
      sql`SELECT * FROM sandbox_jobs WHERE request_key = ${requestKey} AND ${supported()}`.pipe(
        Effect.mapError(fail),
        Effect.flatMap(selectOne),
        Effect.withSpan("SandboxJobStore.getByRequestKey"),
      ),
    update: Effect.fn("SandboxJobStore.update")(
      function* (jobId, patch, updatedAt) {
        const current = yield* get(jobId);
        if (current === undefined) return yield* fail(new Error(`No sandbox job ${jobId}.`));
        const next: SandboxJobRecord = { ...current, ...patch, updatedAt };
        yield* write(next);
        return next;
      },
      sql.withTransaction,
      Effect.mapError(fail),
      Effect.withSpan("SandboxJobStore.update"),
    ),
    list: ({ includeFinished }) =>
      sql`SELECT * FROM sandbox_jobs WHERE ${supported()} ORDER BY created_at DESC`.pipe(
        Effect.mapError(fail),
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) => fromRow(row).pipe(Effect.mapError(fail))),
        ),
        Effect.map((records) =>
          includeFinished
            ? records
            : records.filter((record) => !isSandboxJobFinished(record.state)),
        ),
        Effect.withSpan("SandboxJobStore.list"),
      ),
  });
});

export const layer = Layer.effect(SandboxJobStore, make);
