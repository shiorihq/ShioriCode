import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!threadColumns.some((column) => column.name === "goal_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN goal_json TEXT
    `;
  }

  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;

  if (!sessionColumns.some((column) => column.name === "goal_lifecycle_key")) {
    yield* sql`
      ALTER TABLE projection_thread_sessions
      ADD COLUMN goal_lifecycle_key TEXT
    `;
  }

  const turnColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_turns)
  `;

  if (!turnColumns.some((column) => column.name === "goal_lifecycle_key")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN goal_lifecycle_key TEXT
    `;
  }

  // The thread projector historically advanced its cursor past goal events without
  // applying them. Backfill directly from the event log instead of rewinding that
  // cursor and replaying unrelated thread events.
  yield* sql`
    WITH ranked_goal_events AS (
      SELECT
        stream_id AS thread_id,
        event_type,
        payload_json,
        occurred_at,
        CASE
          WHEN event_type = 'thread.goal-updated'
            AND COALESCE(command_id, '') LIKE 'provider:%:thread-goal-set:%'
          THEN 1
          WHEN event_type = 'thread.goal-cleared'
            AND COALESCE(command_id, '') LIKE 'provider:%:thread-goal-clear:%'
          THEN 1
          ELSE 0
        END AS is_provider_native,
        ROW_NUMBER() OVER (
          PARTITION BY stream_id
          ORDER BY sequence DESC
        ) AS event_rank
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND event_type IN ('thread.goal-updated', 'thread.goal-cleared')
    ),
    latest_goal_events AS (
      SELECT
        thread_id,
        event_type,
        payload_json,
        is_provider_native,
        CASE
          WHEN event_type = 'thread.goal-updated'
          THEN COALESCE(json_extract(payload_json, '$.goal.updatedAt'), occurred_at)
          ELSE COALESCE(json_extract(payload_json, '$.clearedAt'), occurred_at)
        END AS goal_updated_at
      FROM ranked_goal_events
      WHERE event_rank = 1
    )
    UPDATE projection_threads
    SET
      goal_json = CASE
        -- Before goals became a ShioriCode harness feature, Codex-native goal
        -- notifications were translated into these same orchestration facts.
        -- If the latest fact is provider-owned, clear the projection instead
        -- of skipping it and accidentally resurrecting an older UI goal.
        WHEN latest_goal_events.is_provider_native = 0
          AND latest_goal_events.event_type = 'thread.goal-updated'
        THEN json_set(
          json_extract(latest_goal_events.payload_json, '$.goal'),
          '$.threadId', latest_goal_events.thread_id,
          '$.objective', substr(
            json_extract(latest_goal_events.payload_json, '$.goal.objective'),
            1,
            4000
          ),
          '$.tokenBudget', CASE
            WHEN json_extract(latest_goal_events.payload_json, '$.goal.tokenBudget') IS NULL
              THEN NULL
            WHEN json_extract(latest_goal_events.payload_json, '$.goal.tokenBudget') > 0
              THEN json_extract(latest_goal_events.payload_json, '$.goal.tokenBudget')
            ELSE NULL
          END
        )
        ELSE NULL
      END,
      updated_at = CASE
        WHEN latest_goal_events.goal_updated_at > projection_threads.updated_at
        THEN latest_goal_events.goal_updated_at
        ELSE projection_threads.updated_at
      END
    FROM latest_goal_events
    WHERE latest_goal_events.thread_id = projection_threads.thread_id
  `;
});
