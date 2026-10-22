import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
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
});
