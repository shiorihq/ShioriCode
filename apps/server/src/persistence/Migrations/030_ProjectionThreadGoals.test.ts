import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("030_ProjectionThreadGoals", (it) => {
  it.effect("backfills each thread from its latest historical goal event", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 29 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'thread-active-goal',
            'project-1',
            'Active goal',
            '{"provider":"codex","model":"gpt-5-codex"}',
            NULL,
            NULL,
            NULL,
            '2026-07-01T00:00:00.000Z',
            '2026-07-01T00:00:01.000Z',
            NULL
          ),
          (
            'thread-cleared-goal',
            'project-1',
            'Cleared goal',
            '{"provider":"codex","model":"gpt-5-codex"}',
            NULL,
            NULL,
            NULL,
            '2026-07-01T00:00:00.000Z',
            '2026-07-01T00:00:01.000Z',
            NULL
          ),
          (
            'thread-without-goal',
            'project-1',
            'No goal',
            '{"provider":"codex","model":"gpt-5-codex"}',
            NULL,
            NULL,
            NULL,
            '2026-07-01T00:00:00.000Z',
            '2026-07-01T00:00:09.000Z',
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
        VALUES
          (
            'event-active-goal-initial',
            'thread',
            'thread-active-goal',
            0,
            'thread.goal-updated',
            '2026-07-01T00:00:02.000Z',
            'client',
            '{"threadId":"thread-active-goal","goal":{"threadId":"thread-active-goal","objective":"Initial objective","status":"active","tokenBudget":1000,"tokensUsed":10,"timeUsedSeconds":1,"createdAt":"2026-07-01T00:00:02.000Z","updatedAt":"2026-07-01T00:00:02.000Z"}}',
            '{}'
          ),
          (
            'event-active-goal-cleared',
            'thread',
            'thread-active-goal',
            1,
            'thread.goal-cleared',
            '2026-07-01T00:00:03.000Z',
            'client',
            '{"threadId":"thread-active-goal","clearedAt":"2026-07-01T00:00:03.000Z"}',
            '{}'
          ),
          (
            'event-active-goal-final',
            'thread',
            'thread-active-goal',
            2,
            'thread.goal-updated',
            '2026-07-01T00:00:04.000Z',
            'client',
            '{"threadId":"thread-active-goal","goal":{"threadId":"provider-thread-id","objective":"Final objective","status":"paused","tokenBudget":2000,"tokensUsed":20,"timeUsedSeconds":2,"createdAt":"2026-07-01T00:00:02.000Z","updatedAt":"2026-07-01T00:00:04.000Z"}}',
            '{}'
          ),
          (
            'event-cleared-goal-set',
            'thread',
            'thread-cleared-goal',
            0,
            'thread.goal-updated',
            '2026-07-01T00:00:05.000Z',
            'client',
            '{"threadId":"thread-cleared-goal","goal":{"threadId":"thread-cleared-goal","objective":"Will be cleared","status":"active","tokenBudget":null,"tokensUsed":0,"timeUsedSeconds":0,"createdAt":"2026-07-01T00:00:05.000Z","updatedAt":"2026-07-01T00:00:05.000Z"}}',
            '{}'
          ),
          (
            'event-cleared-goal-clear',
            'thread',
            'thread-cleared-goal',
            1,
            'thread.goal-cleared',
            '2026-07-01T00:00:06.000Z',
            'client',
            '{"threadId":"thread-cleared-goal","clearedAt":"2026-07-01T00:00:06.000Z"}',
            '{}'
          )
      `;

      yield* sql`
        INSERT INTO projection_state (
          projector,
          last_applied_sequence,
          updated_at
        )
        VALUES (
          'projection.threads',
          5,
          '2026-07-01T00:00:06.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 30 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "goal_json"));

      const sessionColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      assert.ok(sessionColumns.some((column) => column.name === "goal_lifecycle_key"));

      const turnColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_turns)
      `;
      assert.ok(turnColumns.some((column) => column.name === "goal_lifecycle_key"));

      const rows = yield* sql<{
        readonly threadId: string;
        readonly goal: string | null;
        readonly updatedAt: string;
      }>`
        SELECT
          thread_id AS "threadId",
          goal_json AS "goal",
          updated_at AS "updatedAt"
        FROM projection_threads
        ORDER BY thread_id ASC
      `;

      assert.deepStrictEqual(
        rows.map((row) => ({
          ...row,
          goal: row.goal === null ? null : JSON.parse(row.goal),
        })),
        [
          {
            threadId: "thread-active-goal",
            goal: {
              threadId: "thread-active-goal",
              objective: "Final objective",
              status: "paused",
              tokenBudget: 2_000,
              tokensUsed: 20,
              timeUsedSeconds: 2,
              createdAt: "2026-07-01T00:00:02.000Z",
              updatedAt: "2026-07-01T00:00:04.000Z",
            },
            updatedAt: "2026-07-01T00:00:04.000Z",
          },
          {
            threadId: "thread-cleared-goal",
            goal: null,
            updatedAt: "2026-07-01T00:00:06.000Z",
          },
          {
            threadId: "thread-without-goal",
            goal: null,
            updatedAt: "2026-07-01T00:00:09.000Z",
          },
        ],
      );

      const stateRows = yield* sql<{
        readonly lastAppliedSequence: number;
      }>`
        SELECT last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = 'projection.threads'
      `;
      assert.equal(stateRows[0]?.lastAppliedSequence, 5);
    }),
  );
});

const providerHistoryLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

providerHistoryLayer("030_ProjectionThreadGoals provider history", (it) => {
  it.effect("excludes historical provider-native goals while preserving harness history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 29 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'thread-provider-update-only',
            'project-1',
            'Provider update only',
            '{"provider":"codex","model":"gpt-5-codex"}',
            NULL,
            NULL,
            NULL,
            '2026-07-02T00:00:00.000Z',
            '2026-07-02T00:00:01.000Z',
            NULL
          ),
          (
            'thread-provider-clear-only',
            'project-1',
            'Provider clear only',
            '{"provider":"codex","model":"gpt-5-codex"}',
            NULL,
            NULL,
            NULL,
            '2026-07-02T00:00:00.000Z',
            '2026-07-02T00:00:01.000Z',
            NULL
          ),
          (
            'thread-harness-set-provider-clear',
            'project-1',
            'Harness set then provider clear',
            '{"provider":"codex","model":"gpt-5-codex"}',
            NULL,
            NULL,
            NULL,
            '2026-07-02T00:00:00.000Z',
            '2026-07-02T00:00:01.000Z',
            NULL
          ),
          (
            'thread-harness-clear-provider-update',
            'project-1',
            'Harness clear then provider update',
            '{"provider":"codex","model":"gpt-5-codex"}',
            NULL,
            NULL,
            NULL,
            '2026-07-02T00:00:00.000Z',
            '2026-07-02T00:00:01.000Z',
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
          command_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          (
            'event-provider-update-only',
            'thread',
            'thread-provider-update-only',
            0,
            'thread.goal-updated',
            '2026-07-02T00:00:02.000Z',
            'provider:codex-goal-update:thread-goal-set:uuid-1',
            'provider',
            '{"threadId":"thread-provider-update-only","goal":{"threadId":"thread-provider-update-only","objective":"Codex-owned objective","status":"active","tokenBudget":null,"tokensUsed":0,"timeUsedSeconds":0,"createdAt":"2026-07-02T00:00:02.000Z","updatedAt":"2026-07-02T00:00:02.000Z"}}',
            '{}'
          ),
          (
            'event-provider-clear-only',
            'thread',
            'thread-provider-clear-only',
            0,
            'thread.goal-cleared',
            '2026-07-02T00:00:03.000Z',
            'provider:codex-goal-clear:thread-goal-clear:uuid-2',
            'provider',
            '{"threadId":"thread-provider-clear-only","clearedAt":"2026-07-02T00:00:03.000Z"}',
            '{}'
          ),
          (
            'event-harness-set-before-provider-clear',
            'thread',
            'thread-harness-set-provider-clear',
            0,
            'thread.goal-updated',
            '2026-07-02T00:00:04.000Z',
            'client:harness-goal-set',
            'client',
            '{"threadId":"thread-harness-set-provider-clear","goal":{"threadId":"thread-harness-set-provider-clear","lifecycleId":"goal:harness-set","objective":"Harness objective","status":"active","tokenBudget":1200,"tokensUsed":12,"timeUsedSeconds":3,"createdAt":"2026-07-02T00:00:04.000Z","updatedAt":"2026-07-02T00:00:04.000Z"}}',
            '{"threadGoalMutation":"user"}'
          ),
          (
            'event-provider-clear-after-harness-set',
            'thread',
            'thread-harness-set-provider-clear',
            1,
            'thread.goal-cleared',
            '2026-07-02T00:00:05.000Z',
            'provider:codex-goal-clear-after-set:thread-goal-clear:uuid-3',
            'provider',
            '{"threadId":"thread-harness-set-provider-clear","clearedAt":"2026-07-02T00:00:05.000Z"}',
            '{}'
          ),
          (
            'event-harness-set-before-harness-clear',
            'thread',
            'thread-harness-clear-provider-update',
            0,
            'thread.goal-updated',
            '2026-07-02T00:00:06.000Z',
            'client:harness-goal-set-before-clear',
            'client',
            '{"threadId":"thread-harness-clear-provider-update","goal":{"threadId":"thread-harness-clear-provider-update","lifecycleId":"goal:harness-cleared","objective":"Cleared harness objective","status":"active","tokenBudget":null,"tokensUsed":0,"timeUsedSeconds":0,"createdAt":"2026-07-02T00:00:06.000Z","updatedAt":"2026-07-02T00:00:06.000Z"}}',
            '{"threadGoalMutation":"user"}'
          ),
          (
            'event-harness-clear-before-provider-update',
            'thread',
            'thread-harness-clear-provider-update',
            1,
            'thread.goal-cleared',
            '2026-07-02T00:00:07.000Z',
            'client:harness-goal-clear',
            'client',
            '{"threadId":"thread-harness-clear-provider-update","clearedAt":"2026-07-02T00:00:07.000Z"}',
            '{"threadGoalMutation":"user"}'
          ),
          (
            'event-provider-update-after-harness-clear',
            'thread',
            'thread-harness-clear-provider-update',
            2,
            'thread.goal-updated',
            '2026-07-02T00:00:08.000Z',
            'provider:codex-goal-update-after-clear:thread-goal-set:uuid-4',
            'provider',
            '{"threadId":"thread-harness-clear-provider-update","goal":{"threadId":"thread-harness-clear-provider-update","objective":"Codex objective after clear","status":"active","tokenBudget":null,"tokensUsed":0,"timeUsedSeconds":0,"createdAt":"2026-07-02T00:00:08.000Z","updatedAt":"2026-07-02T00:00:08.000Z"}}',
            '{}'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 30 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly goal: string | null;
        readonly updatedAt: string;
      }>`
        SELECT
          thread_id AS "threadId",
          goal_json AS "goal",
          updated_at AS "updatedAt"
        FROM projection_threads
        ORDER BY thread_id ASC
      `;

      assert.deepStrictEqual(
        rows.map((row) => ({
          ...row,
          goal: row.goal === null ? null : JSON.parse(row.goal),
        })),
        [
          {
            threadId: "thread-harness-clear-provider-update",
            goal: null,
            updatedAt: "2026-07-02T00:00:08.000Z",
          },
          {
            threadId: "thread-harness-set-provider-clear",
            goal: null,
            updatedAt: "2026-07-02T00:00:05.000Z",
          },
          {
            threadId: "thread-provider-clear-only",
            goal: null,
            updatedAt: "2026-07-02T00:00:03.000Z",
          },
          {
            threadId: "thread-provider-update-only",
            goal: null,
            updatedAt: "2026-07-02T00:00:02.000Z",
          },
        ],
      );
    }),
  );
});
