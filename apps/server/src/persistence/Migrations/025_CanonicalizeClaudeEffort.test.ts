import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("025_CanonicalizeClaudeEffort", (it) => {
  it.effect("maps legacy claude xhigh effort to max in projections and events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 24 });

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
          branch,
          worktree_path,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-claude-xhigh',
          'project',
          'project-1',
          NULL,
          'Claude xhigh',
          '{"provider":"claudeAgent","model":"claude-opus-4-7","options":{"effort":"xhigh","contextWindow":"1m"}}',
          'full-access',
          'default',
          NULL,
          NULL,
          '2026-02-24T00:00:02.000Z',
          '2026-02-24T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"claudeAgent","model":"claude-opus-4-7","options":{"effort":"xhigh"}}',
          '[]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          'event-claude-xhigh',
          'thread',
          'thread-claude-xhigh',
          1,
          'thread.created',
          '2026-02-24T00:00:02.000Z',
          'client',
          '{"threadId":"thread-claude-xhigh","modelSelection":{"provider":"claudeAgent","model":"claude-opus-4-7","options":{"effort":"xhigh"}}}',
          '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 25 });

      const rows = yield* sql<{
        readonly threadEffort: string;
        readonly projectEffort: string;
        readonly eventEffort: string;
      }>`
        SELECT
          json_extract(
            (SELECT model_selection_json FROM projection_threads WHERE thread_id = 'thread-claude-xhigh'),
            '$.options.effort'
          ) AS "threadEffort",
          json_extract(
            (SELECT default_model_selection_json FROM projection_projects WHERE project_id = 'project-1'),
            '$.options.effort'
          ) AS "projectEffort",
          json_extract(
            (SELECT payload_json FROM orchestration_events WHERE event_id = 'event-claude-xhigh'),
            '$.modelSelection.options.effort'
          ) AS "eventEffort"
      `;

      assert.deepEqual(rows[0], {
        threadEffort: "max",
        projectEffort: "max",
        eventEffort: "max",
      });
    }),
  );
});
