import { AutomationId, ProjectId } from "contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AutomationRepository } from "../Services/AutomationRepository.ts";
import { AutomationRepositoryLive } from "./AutomationRepository.ts";

const automationRepositoryLayer = it.layer(
  Layer.mergeAll(
    AutomationRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

automationRepositoryLayer("AutomationRepository", (it) => {
  it.effect("keeps target_thread_id non-null before a scheduled run has a thread", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      const sql = yield* SqlClient.SqlClient;
      const automationId = AutomationId.makeUnsafe("automation-before-first-run");

      yield* repository.upsert({
        id: automationId,
        kind: "automation",
        title: "Morning check",
        prompt: "Review the workspace.",
        projectId: ProjectId.makeUnsafe("project-automation"),
        projectlessCwd: null,
        modelSelection: {
          provider: "gemini",
          model: "auto",
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        scheduleRrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
        status: "active",
        nextRunAt: "2026-05-14T09:00:00.000Z",
        lastRunAt: null,
        lastRunThreadId: null,
        lastRunStatus: "idle",
        lastRunError: null,
        createdAt: "2026-05-14T08:00:00.000Z",
        updatedAt: "2026-05-14T08:00:00.000Z",
        deletedAt: null,
      });

      const rows = yield* sql<{ target_thread_id: string }>`
        SELECT target_thread_id
        FROM automations
        WHERE automation_id = ${automationId}
      `;
      assert.strictEqual(rows[0]?.target_thread_id, automationId);
    }),
  );

  it.effect("stores standalone automation launch context", () =>
    Effect.gen(function* () {
      const repository = yield* AutomationRepository;
      const automationId = AutomationId.makeUnsafe("automation-standalone");

      yield* repository.upsert({
        id: automationId,
        kind: "automation",
        title: "Morning check",
        prompt: "Review the workspace.",
        projectId: ProjectId.makeUnsafe("project-automation"),
        projectlessCwd: null,
        modelSelection: {
          provider: "gemini",
          model: "auto",
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        scheduleRrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
        status: "active",
        nextRunAt: "2026-05-14T09:00:00.000Z",
        lastRunAt: null,
        lastRunThreadId: null,
        lastRunStatus: "idle",
        lastRunError: null,
        createdAt: "2026-05-14T08:00:00.000Z",
        updatedAt: "2026-05-14T08:00:00.000Z",
        deletedAt: null,
      });

      const automations = yield* repository.list();
      assert.deepStrictEqual(automations[0]?.modelSelection, {
        provider: "gemini",
        model: "auto",
      });
      assert.strictEqual(automations[0]?.projectId, ProjectId.makeUnsafe("project-automation"));
      assert.strictEqual(automations[0]?.runtimeMode, "approval-required");
    }),
  );
});
