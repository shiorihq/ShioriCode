import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_kanban_items (
      item_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      pull_request_json TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      generated_prompt TEXT,
      prompt_status TEXT NOT NULL DEFAULT 'idle',
      prompt_error TEXT,
      status TEXT NOT NULL,
      sort_key TEXT NOT NULL,
      blocked_reason TEXT,
      assignees_json TEXT NOT NULL,
      notes_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      deleted_at TEXT
    )
  `;

  yield* sql`ALTER TABLE projection_kanban_items ADD COLUMN prompt TEXT NOT NULL DEFAULT ''`.pipe(
    Effect.catch(() => Effect.void),
  );
  yield* sql`ALTER TABLE projection_kanban_items ADD COLUMN generated_prompt TEXT`.pipe(
    Effect.catch(() => Effect.void),
  );
  yield* sql`ALTER TABLE projection_kanban_items ADD COLUMN prompt_status TEXT NOT NULL DEFAULT 'idle'`.pipe(
    Effect.catch(() => Effect.void),
  );
  yield* sql`ALTER TABLE projection_kanban_items ADD COLUMN prompt_error TEXT`.pipe(
    Effect.catch(() => Effect.void),
  );

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_kanban_items_project_pr
    ON projection_kanban_items(project_id, status, sort_key)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_kanban_items_updated_at
    ON projection_kanban_items(updated_at)
  `;
});
