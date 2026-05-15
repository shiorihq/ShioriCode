import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automations (
      automation_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      target_thread_id TEXT NOT NULL,
      schedule_rrule TEXT NOT NULL,
      status TEXT NOT NULL,
      next_run_at TEXT,
      last_run_at TEXT,
      last_run_status TEXT NOT NULL,
      last_run_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automations_due
    ON automations (status, next_run_at)
    WHERE deleted_at IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automations_thread
    ON automations (target_thread_id)
    WHERE deleted_at IS NULL
  `;
});
