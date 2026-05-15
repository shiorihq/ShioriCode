import {
  Automation,
  AutomationId,
  AutomationKind,
  AutomationLastRunStatus,
  AutomationScheduleRrule,
  AutomationStatus,
  IsoDateTime,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  AutomationRepository,
  type AutomationRepositoryShape,
} from "../Services/AutomationRepository.ts";

const AutomationRow = Schema.Struct({
  automationId: AutomationId,
  kind: AutomationKind,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  projectId: Schema.NullOr(ProjectId),
  projectlessCwd: Schema.NullOr(TrimmedNonEmptyString),
  modelSelection: Schema.fromJsonString(ModelSelection),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  scheduleRrule: AutomationScheduleRrule,
  status: AutomationStatus,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastRunThreadId: Schema.NullOr(ThreadId),
  lastRunStatus: AutomationLastRunStatus,
  lastRunError: Schema.NullOr(TrimmedString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
type AutomationRow = typeof AutomationRow.Type;

const AutomationIdRequest = Schema.Struct({
  automationId: AutomationId,
});

const AutomationDueRequest = Schema.Struct({
  now: Schema.String,
});

const AutomationDeleteRequest = Schema.Struct({
  automationId: AutomationId,
  deletedAt: Schema.String,
});

function rowToAutomation(row: AutomationRow): Automation {
  return {
    ...row,
    id: row.automationId,
  };
}

const makeAutomationRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const automationColumns = sql`
    SELECT
      automation_id AS "automationId",
      kind,
      title,
      prompt,
      project_id AS "projectId",
      projectless_cwd AS "projectlessCwd",
      COALESCE(model_selection_json, '{"provider":"codex","model":"gpt-5.5"}') AS "modelSelection",
      COALESCE(runtime_mode, 'full-access') AS "runtimeMode",
      COALESCE(interaction_mode, 'default') AS "interactionMode",
      schedule_rrule AS "scheduleRrule",
      status,
      next_run_at AS "nextRunAt",
      last_run_at AS "lastRunAt",
      last_run_thread_id AS "lastRunThreadId",
      last_run_status AS "lastRunStatus",
      last_run_error AS "lastRunError",
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      deleted_at AS "deletedAt"
    FROM automations
  `;

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AutomationRow,
    execute: () =>
      sql`
        ${automationColumns}
        WHERE deleted_at IS NULL
        ORDER BY created_at ASC, automation_id ASC
      `,
  });

  const listDueRows = SqlSchema.findAll({
    Request: AutomationDueRequest,
    Result: AutomationRow,
    execute: ({ now }) =>
      sql`
        ${automationColumns}
        WHERE deleted_at IS NULL
          AND status = 'active'
          AND next_run_at IS NOT NULL
          AND next_run_at <= ${now}
        ORDER BY next_run_at ASC, automation_id ASC
      `,
  });

  const getRowById = SqlSchema.findOneOption({
    Request: AutomationIdRequest,
    Result: AutomationRow,
    execute: ({ automationId }) =>
      sql`
        ${automationColumns}
        WHERE automation_id = ${automationId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const upsertRow = SqlSchema.void({
    Request: Automation,
    execute: (automation) =>
      sql`
        INSERT INTO automations (
          automation_id,
          kind,
          title,
          prompt,
          target_thread_id,
          project_id,
          projectless_cwd,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          schedule_rrule,
          status,
          next_run_at,
          last_run_at,
          last_run_thread_id,
          last_run_status,
          last_run_error,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${automation.id},
          ${automation.kind},
          ${automation.title},
          ${automation.prompt},
          ${automation.lastRunThreadId ?? automation.id},
          ${automation.projectId},
          ${automation.projectlessCwd},
          ${JSON.stringify(automation.modelSelection)},
          ${automation.runtimeMode},
          ${automation.interactionMode},
          ${automation.scheduleRrule},
          ${automation.status},
          ${automation.nextRunAt},
          ${automation.lastRunAt},
          ${automation.lastRunThreadId},
          ${automation.lastRunStatus},
          ${automation.lastRunError},
          ${automation.createdAt},
          ${automation.updatedAt},
          ${automation.deletedAt}
        )
        ON CONFLICT (automation_id)
        DO UPDATE SET
          kind = excluded.kind,
          title = excluded.title,
          prompt = excluded.prompt,
          project_id = excluded.project_id,
          projectless_cwd = excluded.projectless_cwd,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          schedule_rrule = excluded.schedule_rrule,
          status = excluded.status,
          next_run_at = excluded.next_run_at,
          last_run_at = excluded.last_run_at,
          last_run_thread_id = excluded.last_run_thread_id,
          last_run_status = excluded.last_run_status,
          last_run_error = excluded.last_run_error,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const softDeleteRow = SqlSchema.void({
    Request: AutomationDeleteRequest,
    execute: ({ automationId, deletedAt }) =>
      sql`
        UPDATE automations
        SET deleted_at = ${deletedAt},
            updated_at = ${deletedAt}
        WHERE automation_id = ${automationId}
      `,
  });

  const list: AutomationRepositoryShape["list"] = () =>
    listRows(undefined).pipe(
      Effect.map((rows) => rows.map(rowToAutomation)),
      Effect.mapError(toPersistenceSqlError("AutomationRepository.list:query")),
    );

  const listDue: AutomationRepositoryShape["listDue"] = (now) =>
    listDueRows({ now }).pipe(
      Effect.map((rows) => rows.map(rowToAutomation)),
      Effect.mapError(toPersistenceSqlError("AutomationRepository.listDue:query")),
    );

  const getById: AutomationRepositoryShape["getById"] = (automationId) =>
    getRowById({ automationId }).pipe(
      Effect.map(Option.map(rowToAutomation)),
      Effect.mapError(toPersistenceSqlError("AutomationRepository.getById:query")),
    );

  const upsert: AutomationRepositoryShape["upsert"] = (automation) =>
    upsertRow(automation).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.upsert:query")),
    );

  const softDelete: AutomationRepositoryShape["softDelete"] = (input) =>
    softDeleteRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.softDelete:query")),
    );

  return {
    list,
    listDue,
    getById,
    upsert,
    softDelete,
  } satisfies AutomationRepositoryShape;
});

export const AutomationRepositoryLive = Layer.effect(
  AutomationRepository,
  makeAutomationRepository,
);
