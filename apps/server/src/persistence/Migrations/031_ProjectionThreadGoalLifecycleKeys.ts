import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const addColumnIfMissing = Effect.fn("addGoalLifecycleColumnIfMissing")(function* (
  table: "projection_thread_sessions" | "projection_turns",
) {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql.unsafe<{ readonly name: string }>(`PRAGMA table_info(${table})`, []);

  if (columns.some((column) => column.name === "goal_lifecycle_key")) {
    return;
  }

  yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN goal_lifecycle_key TEXT`, []);
});

/**
 * Repair databases that applied the initial version of migration 030 before
 * goal lifecycle bindings were added to the session and turn projections.
 * Applied migration IDs are immutable, so these columns need their own ID.
 */
export default Effect.gen(function* () {
  yield* addColumnIfMissing("projection_thread_sessions");
  yield* addColumnIfMissing("projection_turns");
});
