import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ name: string; notnull: number }>`
    PRAGMA table_info(projection_threads)
  `;
  const hasWorkspaceKind = columns.some((column) => column.name === "workspace_kind");
  const projectIdColumn = columns.find((column) => column.name === "project_id");
  const projectIdAllowsNull = projectIdColumn?.notnull === 0;

  if (hasWorkspaceKind && projectIdAllowsNull) {
    return;
  }

  yield* sql`DROP INDEX IF EXISTS idx_projection_threads_project_id`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_threads_project_archived_at`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_threads_project_deleted_created`;

  yield* sql`ALTER TABLE projection_threads RENAME TO projection_threads_old`;

  yield* sql`
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      workspace_kind TEXT NOT NULL DEFAULT 'project',
      project_id TEXT,
      projectless_cwd TEXT,
      title TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL DEFAULT 'full-access',
      interaction_mode TEXT NOT NULL DEFAULT 'default',
      parent_thread_id TEXT,
      branch_source_turn_id TEXT,
      branch TEXT,
      worktree_path TEXT,
      tag TEXT,
      resume_state TEXT NOT NULL DEFAULT 'resumed',
      latest_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT
    )
  `;

  yield* sql`
    INSERT INTO projection_threads (
      thread_id,
      workspace_kind,
      project_id,
      projectless_cwd,
      title,
      model_selection_json,
      runtime_mode,
      interaction_mode,
      parent_thread_id,
      branch_source_turn_id,
      branch,
      worktree_path,
      tag,
      resume_state,
      latest_turn_id,
      created_at,
      updated_at,
      archived_at,
      deleted_at
    )
    SELECT
      thread_id,
      'project',
      project_id,
      NULL,
      title,
      model_selection_json,
      runtime_mode,
      interaction_mode,
      parent_thread_id,
      branch_source_turn_id,
      branch,
      worktree_path,
      tag,
      resume_state,
      latest_turn_id,
      created_at,
      updated_at,
      archived_at,
      deleted_at
    FROM projection_threads_old
  `;

  yield* sql`DROP TABLE projection_threads_old`;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_id
    ON projection_threads(project_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_archived_at
    ON projection_threads(project_id, archived_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_deleted_created
    ON projection_threads(project_id, deleted_at, created_at)
  `;
});
