import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE automations ADD COLUMN project_id TEXT`.pipe(Effect.ignore);
  yield* sql`ALTER TABLE automations ADD COLUMN projectless_cwd TEXT`.pipe(Effect.ignore);
  yield* sql`ALTER TABLE automations ADD COLUMN model_selection_json TEXT`.pipe(Effect.ignore);
  yield* sql`ALTER TABLE automations ADD COLUMN runtime_mode TEXT`.pipe(Effect.ignore);
  yield* sql`ALTER TABLE automations ADD COLUMN interaction_mode TEXT`.pipe(Effect.ignore);
  yield* sql`ALTER TABLE automations ADD COLUMN last_run_thread_id TEXT`.pipe(Effect.ignore);

  yield* sql`
    UPDATE automations
    SET
      project_id = COALESCE(
        project_id,
        (SELECT project_id FROM projection_threads WHERE thread_id = automations.target_thread_id)
      ),
      projectless_cwd = COALESCE(
        projectless_cwd,
        (SELECT projectless_cwd FROM projection_threads WHERE thread_id = automations.target_thread_id)
      ),
      model_selection_json = COALESCE(
        model_selection_json,
        (SELECT model_selection_json FROM projection_threads WHERE thread_id = automations.target_thread_id),
        '{"provider":"codex","model":"gpt-5.5"}'
      ),
      runtime_mode = COALESCE(
        runtime_mode,
        (SELECT runtime_mode FROM projection_threads WHERE thread_id = automations.target_thread_id),
        'full-access'
      ),
      interaction_mode = COALESCE(
        interaction_mode,
        (SELECT interaction_mode FROM projection_threads WHERE thread_id = automations.target_thread_id),
        'default'
      ),
      kind = CASE WHEN kind = 'heartbeat' THEN 'automation' ELSE kind END
    WHERE deleted_at IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automations_project
    ON automations (project_id)
    WHERE deleted_at IS NULL
  `;
});
