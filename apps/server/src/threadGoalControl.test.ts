import type { OrchestrationReadModel, OrchestrationCommand } from "contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine.ts";
import { createThreadGoalCapability } from "./threadGoalCapability.ts";
import { handleThreadGoalControlRequest } from "./threadGoalControl.ts";

const NOW = "2026-07-17T09:00:00.000Z";
const GOAL_ID = "goal:lifecycle-a";

function readModel(threadId = "thread-a"): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [],
    kanbanItems: [],
    threads: [
      {
        id: threadId,
        projectId: null,
        projectlessCwd: "/tmp/project",
        title: "Thread",
        modelSelection: { provider: "codex", model: "default", options: {} },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        tag: null,
        resumeState: "resumed",
        latestTurn: null,
        goal: {
          threadId,
          lifecycleId: GOAL_ID,
          objective: "Finish the feature",
          status: "active",
          tokenBudget: 10_000,
          tokensUsed: 123,
          timeUsedSeconds: 5,
          createdAt: "2026-07-17T08:00:00.000Z",
          updatedAt: "2026-07-17T08:00:00.000Z",
        },
        createdAt: "2026-07-17T08:00:00.000Z",
        updatedAt: "2026-07-17T08:00:00.000Z",
        pinnedAt: null,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: "turn-a",
          goalLifecycleKey: GOAL_ID,
          lastError: null,
          updatedAt: "2026-07-17T08:30:00.000Z",
        },
      },
    ],
    updatedAt: "2026-07-17T08:30:00.000Z",
  } as unknown as OrchestrationReadModel;
}

function engine(
  model: OrchestrationReadModel,
  dispatchOverride?: OrchestrationEngineShape["dispatch"],
) {
  const commands: OrchestrationCommand[] = [];
  const value: OrchestrationEngineShape = {
    getReadModel: () => Effect.succeed(model),
    readEvents: () => Stream.empty,
    dispatch:
      dispatchOverride ??
      ((command) => {
        commands.push(command);
        return Effect.succeed({ sequence: 2 });
      }),
    streamDomainEvents: Stream.empty,
  };
  return { value, commands };
}

function issueActiveCapability(
  capability: ReturnType<typeof createThreadGoalCapability>,
  threadId = "thread-a" as never,
): string {
  const token = capability.issue(threadId);
  capability.commit(threadId);
  return token;
}

describe("thread-goal control", () => {
  it("derives the thread from the capability and reports status with the active turn", async () => {
    const capability = createThreadGoalCapability(new Uint8Array(32).fill(7));
    const harness = engine(readModel());
    const result = await handleThreadGoalControlRequest({
      authorization: `Bearer ${issueActiveCapability(capability)}`,
      body: { action: "update", goal_id: GOAL_ID, status: "complete", threadId: "thread-b" },
      orchestrationEngine: harness.value,
      verifyCapability: capability.verify,
      now: () => NOW,
    });

    expect(result.status).toBe(200);
    expect(harness.commands).toHaveLength(1);
    expect(harness.commands[0]).toMatchObject({
      type: "thread.goal.status.report",
      threadId: "thread-a",
      expectedGoalLifecycleKey: GOAL_ID,
      status: "complete",
      turnId: "turn-a",
      createdAt: NOW,
    });
  });

  it("returns the current goal without dispatching", async () => {
    const capability = createThreadGoalCapability(new Uint8Array(32).fill(7));
    const harness = engine(readModel());
    const result = await handleThreadGoalControlRequest({
      authorization: `Bearer ${issueActiveCapability(capability)}`,
      body: { action: "get" },
      orchestrationEngine: harness.value,
      verifyCapability: capability.verify,
    });

    expect(result).toMatchObject({
      status: 200,
      body: { ok: true, goal: { goal_id: GOAL_ID, status: "active" } },
    });
    expect(harness.commands).toEqual([]);
  });

  it("authorizes the goal after turn acceptance and before a physical turn id arrives", async () => {
    const capability = createThreadGoalCapability(new Uint8Array(32).fill(7));
    const model = readModel();
    const acceptedModel = {
      ...model,
      threads: model.threads.map((thread) => ({
        ...thread,
        session: thread.session
          ? {
              ...thread.session,
              status: "ready" as const,
              activeTurnId: null,
              goalLifecycleKey: GOAL_ID,
            }
          : null,
      })),
    } as OrchestrationReadModel;
    const harness = engine(acceptedModel);
    const token = issueActiveCapability(capability);

    const getResult = await handleThreadGoalControlRequest({
      authorization: `Bearer ${token}`,
      body: { action: "get" },
      orchestrationEngine: harness.value,
      verifyCapability: capability.verify,
    });
    const updateResult = await handleThreadGoalControlRequest({
      authorization: `Bearer ${token}`,
      body: { action: "update", goal_id: GOAL_ID, status: "complete" },
      orchestrationEngine: harness.value,
      verifyCapability: capability.verify,
      now: () => NOW,
    });

    expect(getResult).toMatchObject({
      status: 200,
      body: { goal: { goal_id: GOAL_ID } },
    });
    expect(updateResult.status).toBe(200);
    expect(harness.commands[0]).toMatchObject({
      type: "thread.goal.status.report",
      expectedGoalLifecycleKey: GOAL_ID,
    });
    expect(harness.commands[0]).not.toHaveProperty("turnId");
  });

  it("rejects capabilities for archived threads", async () => {
    const capability = createThreadGoalCapability(new Uint8Array(32).fill(7));
    const model = readModel();
    const archivedModel = {
      ...model,
      threads: model.threads.map((thread) => ({
        ...thread,
        archivedAt: "2026-07-17T08:45:00.000Z",
      })),
    } as OrchestrationReadModel;
    const harness = engine(archivedModel);

    const result = await handleThreadGoalControlRequest({
      authorization: `Bearer ${issueActiveCapability(capability)}`,
      body: { action: "update", goal_id: GOAL_ID, status: "complete" },
      orchestrationEngine: harness.value,
      verifyCapability: capability.verify,
    });

    expect(result).toMatchObject({ status: 404 });
    expect(harness.commands).toEqual([]);
  });

  it("allows the bound goal turn to report after the UI switches to plan mode", async () => {
    const capability = createThreadGoalCapability(new Uint8Array(32).fill(7));
    const model = readModel();
    const planModel = {
      ...model,
      threads: model.threads.map((thread) => ({ ...thread, interactionMode: "plan" as const })),
    } as OrchestrationReadModel;
    const harness = engine(planModel);

    const result = await handleThreadGoalControlRequest({
      authorization: `Bearer ${issueActiveCapability(capability)}`,
      body: { action: "update", goal_id: GOAL_ID, status: "complete" },
      orchestrationEngine: harness.value,
      verifyCapability: capability.verify,
    });

    expect(result).toMatchObject({ status: 200 });
    expect(harness.commands).toHaveLength(1);
  });

  it("rejects an unbound plan turn after the UI switches back to default mode", async () => {
    const capability = createThreadGoalCapability(new Uint8Array(32).fill(7));
    const model = readModel();
    const unboundModel = {
      ...model,
      threads: model.threads.map((thread) => ({
        ...thread,
        interactionMode: "default" as const,
        session: thread.session ? { ...thread.session, goalLifecycleKey: null } : null,
      })),
    } as OrchestrationReadModel;
    const harness = engine(unboundModel);

    const result = await handleThreadGoalControlRequest({
      authorization: `Bearer ${issueActiveCapability(capability)}`,
      body: { action: "update", goal_id: GOAL_ID, status: "complete" },
      orchestrationEngine: harness.value,
      verifyCapability: capability.verify,
    });

    expect(result).toMatchObject({ status: 409 });
    expect(harness.commands).toEqual([]);
  });

  it("rejects invalid capabilities, stale goal ids, and unsupported status values", async () => {
    const capability = createThreadGoalCapability(new Uint8Array(32).fill(7));
    const harness = engine(readModel());
    const common = {
      orchestrationEngine: harness.value,
      verifyCapability: capability.verify,
    } as const;

    expect(
      await handleThreadGoalControlRequest({
        ...common,
        authorization: "Bearer invalid",
        body: { action: "get" },
      }),
    ).toMatchObject({ status: 401 });
    expect(
      await handleThreadGoalControlRequest({
        ...common,
        authorization: `Bearer ${issueActiveCapability(capability)}`,
        body: { action: "update", goal_id: "old", status: "complete" },
      }),
    ).toMatchObject({ status: 409 });
    expect(
      await handleThreadGoalControlRequest({
        ...common,
        authorization: `Bearer ${issueActiveCapability(capability)}`,
        body: { action: "update", goal_id: GOAL_ID, status: "active" },
      }),
    ).toMatchObject({ status: 400 });
    expect(harness.commands).toEqual([]);
  });

  it("fails closed when the lifecycle changes during dispatch", async () => {
    const capability = createThreadGoalCapability(new Uint8Array(32).fill(7));
    const harness = engine(
      readModel(),
      vi.fn(() => Effect.fail(new Error("stale") as never)),
    );

    const result = await handleThreadGoalControlRequest({
      authorization: `Bearer ${issueActiveCapability(capability)}`,
      body: { action: "update", goal_id: GOAL_ID, status: "blocked" },
      orchestrationEngine: harness.value,
      verifyCapability: capability.verify,
    });

    expect(result).toMatchObject({ status: 409 });
  });
});
