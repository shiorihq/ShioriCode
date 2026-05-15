import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_kanban_items (
      item_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      pull_request_json TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
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

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_kanban_items)
  `;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("prompt")) {
    yield* sql`ALTER TABLE projection_kanban_items ADD COLUMN prompt TEXT NOT NULL DEFAULT ''`;
  }
  if (!columnNames.has("generated_prompt")) {
    yield* sql`ALTER TABLE projection_kanban_items ADD COLUMN generated_prompt TEXT`;
  }
  if (!columnNames.has("prompt_status")) {
    yield* sql`
      ALTER TABLE projection_kanban_items
      ADD COLUMN prompt_status TEXT NOT NULL DEFAULT 'idle'
    `;
  }
  if (!columnNames.has("prompt_error")) {
    yield* sql`ALTER TABLE projection_kanban_items ADD COLUMN prompt_error TEXT`;
  }
});
