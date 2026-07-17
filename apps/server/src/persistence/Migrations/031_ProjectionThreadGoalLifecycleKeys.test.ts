import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("031_ProjectionThreadGoalLifecycleKeys", (it) => {
  it.effect("repairs databases that recorded the earlier migration 030 shape", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 29 });

      // The first development version of migration 030 only added goal_json.
      // Reproduce that already-recorded schema so migration 030 cannot replay.
      yield* sql`ALTER TABLE projection_threads ADD COLUMN goal_json TEXT`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (30, 'ProjectionThreadGoals')
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 31 });
      assert.deepStrictEqual(executed, [[31, "ProjectionThreadGoalLifecycleKeys"]]);

      const sessionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      assert.ok(sessionColumns.some((column) => column.name === "goal_lifecycle_key"));

      const turnColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_turns)
      `;
      assert.ok(turnColumns.some((column) => column.name === "goal_lifecycle_key"));

      const rerun = yield* runMigrations({ toMigrationInclusive: 31 });
      assert.deepStrictEqual(rerun, []);
    }),
  );
});
