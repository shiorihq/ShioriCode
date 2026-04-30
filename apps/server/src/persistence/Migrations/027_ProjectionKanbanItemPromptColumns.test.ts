import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("027_ProjectionKanbanItemPromptColumns", (it) => {
  it.effect(
    "adds prompt columns when Kanban projection table was created by the original 026",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 25 });
        yield* sql`
        CREATE TABLE projection_kanban_items (
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
        yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (26, 'ProjectionKanbanItems')
      `;

        yield* runMigrations({ toMigrationInclusive: 27 });

        const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_kanban_items)
      `;
        assert.deepStrictEqual(
          columns
            .map((column) => column.name)
            .filter((name) =>
              ["prompt", "generated_prompt", "prompt_status", "prompt_error"].includes(name),
            ),
          ["prompt", "generated_prompt", "prompt_status", "prompt_error"],
        );
      }),
  );
});
