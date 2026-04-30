import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { KanbanItemAssignee, KanbanItemNote, KanbanItemPullRequestLink } from "contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionKanbanItemInput,
  ProjectionKanbanItem,
  ProjectionKanbanItemRepository,
  type ProjectionKanbanItemRepositoryShape,
} from "../Services/ProjectionKanbanItems.ts";

const ProjectionKanbanItemDbRow = ProjectionKanbanItem.mapFields(
  Struct.assign({
    pullRequest: Schema.NullOr(Schema.fromJsonString(KanbanItemPullRequestLink)),
    assignees: Schema.fromJsonString(Schema.Array(KanbanItemAssignee)),
    notes: Schema.fromJsonString(Schema.Array(KanbanItemNote)),
  }),
);

const makeProjectionKanbanItemRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionKanbanItemRow = SqlSchema.void({
    Request: ProjectionKanbanItemDbRow,
    execute: (row) => sql`
      INSERT INTO projection_kanban_items (
        item_id,
        project_id,
        pull_request_json,
        title,
        description,
        prompt,
        generated_prompt,
        prompt_status,
        prompt_error,
        status,
        sort_key,
        blocked_reason,
        assignees_json,
        notes_json,
        created_at,
        updated_at,
        completed_at,
        deleted_at
      )
      VALUES (
        ${row.itemId},
        ${row.projectId},
        ${row.pullRequest},
        ${row.title},
        ${row.description},
        ${row.prompt},
        ${row.generatedPrompt},
        ${row.promptStatus},
        ${row.promptError},
        ${row.status},
        ${row.sortKey},
        ${row.blockedReason},
        ${row.assignees},
        ${row.notes},
        ${row.createdAt},
        ${row.updatedAt},
        ${row.completedAt},
        ${row.deletedAt}
      )
      ON CONFLICT (item_id)
      DO UPDATE SET
        project_id = excluded.project_id,
        pull_request_json = excluded.pull_request_json,
        title = excluded.title,
        description = excluded.description,
        prompt = excluded.prompt,
        generated_prompt = excluded.generated_prompt,
        prompt_status = excluded.prompt_status,
        prompt_error = excluded.prompt_error,
        status = excluded.status,
        sort_key = excluded.sort_key,
        blocked_reason = excluded.blocked_reason,
        assignees_json = excluded.assignees_json,
        notes_json = excluded.notes_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at,
        deleted_at = excluded.deleted_at
    `,
  });

  const getProjectionKanbanItemRow = SqlSchema.findOneOption({
    Request: GetProjectionKanbanItemInput,
    Result: ProjectionKanbanItemDbRow,
    execute: ({ itemId }) => sql`
      SELECT
        item_id AS "itemId",
        project_id AS "projectId",
        pull_request_json AS "pullRequest",
        title,
        description,
        prompt,
        generated_prompt AS "generatedPrompt",
        prompt_status AS "promptStatus",
        prompt_error AS "promptError",
        status,
        sort_key AS "sortKey",
        blocked_reason AS "blockedReason",
        assignees_json AS "assignees",
        notes_json AS "notes",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt",
        deleted_at AS "deletedAt"
      FROM projection_kanban_items
      WHERE item_id = ${itemId}
    `,
  });

  const listProjectionKanbanItemRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionKanbanItemDbRow,
    execute: () => sql`
      SELECT
        item_id AS "itemId",
        project_id AS "projectId",
        pull_request_json AS "pullRequest",
        title,
        description,
        prompt,
        generated_prompt AS "generatedPrompt",
        prompt_status AS "promptStatus",
        prompt_error AS "promptError",
        status,
        sort_key AS "sortKey",
        blocked_reason AS "blockedReason",
        assignees_json AS "assignees",
        notes_json AS "notes",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt",
        deleted_at AS "deletedAt"
      FROM projection_kanban_items
      ORDER BY status ASC, sort_key ASC, created_at ASC, item_id ASC
    `,
  });

  const upsert: ProjectionKanbanItemRepositoryShape["upsert"] = (row) =>
    upsertProjectionKanbanItemRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionKanbanItemRepository.upsert:query")),
    );

  const getById: ProjectionKanbanItemRepositoryShape["getById"] = (input) =>
    getProjectionKanbanItemRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionKanbanItemRepository.getById:query")),
    );

  const listAll: ProjectionKanbanItemRepositoryShape["listAll"] = () =>
    listProjectionKanbanItemRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionKanbanItemRepository.listAll:query")),
    );

  return {
    upsert,
    getById,
    listAll,
  } satisfies ProjectionKanbanItemRepositoryShape;
});

export const ProjectionKanbanItemRepositoryLive = Layer.effect(
  ProjectionKanbanItemRepository,
  makeProjectionKanbanItemRepository,
);
