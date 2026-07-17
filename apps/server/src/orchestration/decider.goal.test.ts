import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "contracts";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const CREATED_AT = "2026-07-16T10:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-goal");

async function makeReadModel(): Promise<OrchestrationReadModel> {
  const empty = createEmptyReadModel(CREATED_AT);
  const withProject = await Effect.runPromise(
    projectEvent(empty, {
      sequence: 1,
      eventId: EventId.makeUnsafe("event-project-created"),
      aggregateKind: "project",
      aggregateId: ProjectId.makeUnsafe("project-goal"),
      type: "project.created",
      occurredAt: CREATED_AT,
      commandId: CommandId.makeUnsafe("command-project-created"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        projectId: ProjectId.makeUnsafe("project-goal"),
        title: "Goal project",
        workspaceRoot: "/tmp/goal-project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    }),
  );
  return Effect.runPromise(
    projectEvent(withProject, {
      sequence: 2,
      eventId: EventId.makeUnsafe("event-thread-created"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.created",
      occurredAt: CREATED_AT,
      commandId: CommandId.makeUnsafe("command-thread-created"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-goal"),
        title: "Goal thread",
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        parentThreadId: null,
        branchSourceTurnId: null,
        branch: null,
        worktreePath: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    }),
  );
}

describe("goal command decisions", () => {
  it("persists standalone goal set and clear commands as Shiori-owned facts", async () => {
    const readModel = await makeReadModel();
    const setFact = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.makeUnsafe("command-goal-set"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: null,
          objective: "Ship reliable goals",
          tokenBudget: null,
          createdAt: CREATED_AT,
        },
        readModel,
      }),
    );

    expect(Array.isArray(setFact)).toBe(false);
    expect(setFact).toMatchObject({
      type: "thread.goal-updated",
      payload: {
        threadId: THREAD_ID,
        goal: {
          threadId: THREAD_ID,
          objective: "Ship reliable goals",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
      },
    });

    const clearFact = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.clear",
          commandId: CommandId.makeUnsafe("command-goal-clear"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: null,
          createdAt: CREATED_AT,
        },
        readModel,
      }),
    );
    expect(clearFact).toMatchObject({
      type: "thread.goal-cleared",
      payload: {
        threadId: THREAD_ID,
        clearedAt: CREATED_AT,
      },
    });
  });

  it("atomically persists message, fresh goal, then an ordinary turn request", async () => {
    const readModel = await makeReadModel();
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("command-goal-turn"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.makeUnsafe("message-goal-turn"),
            role: "user",
            text: "Ship reliable goals",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          goalIntent: {
            objective: "Ship reliable goals",
            status: "active",
            tokenBudget: null,
            expectedGoalLifecycleKey: null,
          },
          createdAt: CREATED_AT,
        },
        readModel,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.goal-updated",
      "thread.turn-start-requested",
    ]);
    expect(events[1]).toMatchObject({
      type: "thread.goal-updated",
      payload: {
        goal: {
          objective: "Ship reliable goals",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: CREATED_AT,
        },
      },
    });
    expect(events[2]).toMatchObject({ type: "thread.turn-start-requested" });
    expect("goalIntent" in events[2]!.payload).toBe(false);
    expect(events[2]).toMatchObject({
      payload: { goalLifecycleKey: "goal:command-goal-turn" },
    });
  });

  it("rejects stale composite goal replacement intents atomically", async () => {
    const readModel = await makeReadModel();
    const goalFact = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.makeUnsafe("command-current-composite-goal"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: null,
          objective: "Current objective",
          createdAt: CREATED_AT,
        },
        readModel,
      }),
    );
    if (Array.isArray(goalFact)) throw new Error("Expected one goal fact");
    const withGoal = await Effect.runPromise(
      projectEvent(readModel, { ...goalFact, sequence: 3 } as OrchestrationEvent),
    );

    const staleStart = await Effect.runPromiseExit(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("command-stale-composite-start"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.makeUnsafe("message-stale-composite-start"),
            role: "user",
            text: "Overwrite from a stale queue",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          goalIntent: {
            objective: "Stale queued objective",
            status: "active",
            tokenBudget: null,
            expectedGoalLifecycleKey: null,
          },
          createdAt: "2026-07-16T10:00:01.000Z",
        },
        readModel: withGoal,
      }),
    );
    expect(Exit.isFailure(staleStart)).toBe(true);

    const runningReadModel: OrchestrationReadModel = {
      ...withGoal,
      threads: withGoal.threads.map((thread) => ({
        ...thread,
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-stale-composite-steer"),
          state: "running" as const,
          requestedAt: CREATED_AT,
          startedAt: CREATED_AT,
          completedAt: null,
          assistantMessageId: null,
        },
      })),
    };
    const staleSteer = await Effect.runPromiseExit(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.steer",
          commandId: CommandId.makeUnsafe("command-stale-composite-steer"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.makeUnsafe("message-stale-composite-steer"),
            role: "user",
            text: "Overwrite from a stale tab",
          },
          goalIntent: {
            objective: "Stale steered objective",
            status: "active",
            tokenBudget: null,
            expectedGoalLifecycleKey: "goal:already-replaced",
          },
          createdAt: "2026-07-16T10:00:02.000Z",
        },
        readModel: runningReadModel,
      }),
    );
    expect(Exit.isFailure(staleSteer)).toBe(true);
  });

  it("requires lifecycle CAS when mutating an existing goal", async () => {
    const readModel = await makeReadModel();
    const goalFact = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.makeUnsafe("command-cas-current-goal"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: null,
          objective: "Current objective",
          createdAt: CREATED_AT,
        },
        readModel,
      }),
    );
    if (Array.isArray(goalFact)) throw new Error("Expected one goal fact");
    const withGoal = await Effect.runPromise(
      projectEvent(readModel, { ...goalFact, sequence: 3 } as OrchestrationEvent),
    );

    const commands = [
      {
        type: "thread.goal.set" as const,
        commandId: CommandId.makeUnsafe("command-cas-missing-set"),
        threadId: THREAD_ID,
        objective: "Overwrite without observing the current lifecycle",
        createdAt: "2026-07-16T10:00:01.000Z",
      },
      {
        type: "thread.goal.clear" as const,
        commandId: CommandId.makeUnsafe("command-cas-missing-clear"),
        threadId: THREAD_ID,
        createdAt: "2026-07-16T10:00:02.000Z",
      },
      {
        type: "thread.turn.start" as const,
        commandId: CommandId.makeUnsafe("command-cas-missing-composite"),
        threadId: THREAD_ID,
        message: {
          messageId: MessageId.makeUnsafe("message-cas-missing-composite"),
          role: "user" as const,
          text: "Replace without lifecycle CAS",
          attachments: [],
        },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        goalIntent: {
          objective: "Composite overwrite",
          status: "active" as const,
          tokenBudget: null,
        },
        createdAt: "2026-07-16T10:00:03.000Z",
      },
    ];

    for (const command of commands) {
      const result = await Effect.runPromiseExit(
        decideOrchestrationCommand({ command: command as never, readModel: withGoal }),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }
  });

  it("rejects goal intent on plan-mode turns", async () => {
    const readModel = await makeReadModel();
    const result = await Effect.runPromiseExit(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("command-plan-goal-turn"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.makeUnsafe("message-plan-goal-turn"),
            role: "user",
            text: "Plan reliable goals",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "plan",
          goalIntent: {
            objective: "Plan reliable goals",
            status: "active",
            tokenBudget: null,
            expectedGoalLifecycleKey: null,
          },
          createdAt: CREATED_AT,
        },
        readModel,
      }),
    );

    expect(Exit.isFailure(result)).toBe(true);
  });

  it("atomically replaces the goal before steering the active turn", async () => {
    const readModel = await makeReadModel();
    const thread = readModel.threads[0]!;
    const runningReadModel: OrchestrationReadModel = {
      ...readModel,
      threads: [
        {
          ...thread,
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-running"),
            state: "running",
            requestedAt: CREATED_AT,
            startedAt: CREATED_AT,
            completedAt: null,
            assistantMessageId: null,
          },
        },
      ],
    };
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.steer",
          commandId: CommandId.makeUnsafe("command-goal-steer"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.makeUnsafe("message-goal-steer"),
            role: "user",
            text: "Replace the current goal",
          },
          goalIntent: {
            objective: "Replace the current goal",
            status: "active",
            tokenBudget: null,
            expectedGoalLifecycleKey: null,
          },
          createdAt: CREATED_AT,
        },
        readModel: runningReadModel,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.goal-updated",
      "thread.turn-steer-requested",
    ]);
    expect(events[1]).toMatchObject({
      type: "thread.goal-updated",
      payload: {
        goal: {
          objective: "Replace the current goal",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
        },
      },
    });
    expect(events[2]).toMatchObject({
      type: "thread.turn-steer-requested",
      payload: { turnId: TurnId.makeUnsafe("turn-running") },
    });
    expect("goalIntent" in events[2]!.payload).toBe(false);
  });

  it("records generic usage against one lifecycle and preserves it across edits", async () => {
    const readModel = await makeReadModel();
    const goalFact = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.makeUnsafe("command-goal-budget"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: null,
          objective: "Stay within budget",
          tokenBudget: 100,
          createdAt: CREATED_AT,
        },
        readModel,
      }),
    );
    if (Array.isArray(goalFact)) throw new Error("Expected one goal fact");
    const withGoal = await Effect.runPromise(
      projectEvent(readModel, { ...goalFact, sequence: 3 } as OrchestrationEvent),
    );

    const usageFact = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.usage.record",
          commandId: CommandId.makeUnsafe("command-goal-usage"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: "goal:command-goal-budget",
          tokensDelta: 100,
          timeDeltaSeconds: 7,
          turnId: TurnId.makeUnsafe("turn-budget"),
          createdAt: "2026-07-16T10:01:00.000Z",
        },
        readModel: withGoal,
      }),
    );
    expect(usageFact).toMatchObject({
      type: "thread.goal-updated",
      payload: {
        turnId: TurnId.makeUnsafe("turn-budget"),
        goal: {
          status: "budgetLimited",
          tokensUsed: 100,
          timeUsedSeconds: 7,
          createdAt: CREATED_AT,
        },
      },
    });

    if (Array.isArray(usageFact)) throw new Error("Expected one usage fact");
    const withUsage = await Effect.runPromise(
      projectEvent(withGoal, { ...usageFact, sequence: 4 } as OrchestrationEvent),
    );
    const blockedAfterBudget = await Effect.runPromiseExit(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.status.report",
          commandId: CommandId.makeUnsafe("command-budget-late-blocked-report"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: "goal:command-goal-budget",
          status: "blocked",
          createdAt: "2026-07-16T10:01:01.000Z",
        },
        readModel: withUsage,
      }),
    );
    expect(Exit.isFailure(blockedAfterBudget)).toBe(true);

    const completedAfterBudget = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.status.report",
          commandId: CommandId.makeUnsafe("command-budget-complete-report"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: "goal:command-goal-budget",
          status: "complete",
          createdAt: "2026-07-16T10:01:02.000Z",
        },
        readModel: withUsage,
      }),
    );
    expect(completedAfterBudget).toMatchObject({ payload: { goal: { status: "complete" } } });

    const editFact = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.makeUnsafe("command-goal-edit"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: "goal:command-goal-budget",
          objective: "Stay within the revised budget",
          status: "active",
          tokenBudget: 200,
          createdAt: "2026-07-16T10:02:00.000Z",
        },
        readModel: withUsage,
      }),
    );
    expect(editFact).toMatchObject({
      type: "thread.goal-updated",
      payload: {
        goal: {
          objective: "Stay within the revised budget",
          status: "active",
          tokenBudget: 200,
          tokensUsed: 100,
          timeUsedSeconds: 7,
          createdAt: CREATED_AT,
        },
      },
    });

    const insufficientBudgetFact = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.makeUnsafe("command-goal-insufficient-budget"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: "goal:command-goal-budget",
          status: "active",
          tokenBudget: 50,
          createdAt: "2026-07-16T10:02:30.000Z",
        },
        readModel: withUsage,
      }),
    );
    expect(insufficientBudgetFact).toMatchObject({
      type: "thread.goal-updated",
      payload: {
        goal: {
          status: "budgetLimited",
          tokenBudget: 50,
          tokensUsed: 100,
        },
      },
    });

    const reopenedFact = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.makeUnsafe("command-goal-reopen"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: "goal:command-goal-budget",
          status: "active",
          tokenBudget: 200,
          createdAt: "2026-07-16T10:02:45.000Z",
        },
        readModel: withUsage,
      }),
    );
    expect(reopenedFact).toMatchObject({
      type: "thread.goal-updated",
      payload: {
        goal: {
          lifecycleId: "goal:command-goal-reopen",
          status: "active",
          tokensUsed: 100,
        },
      },
    });

    const staleEdit = await Effect.runPromiseExit(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.makeUnsafe("command-goal-stale-edit"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: "goal:stale-lifecycle",
          objective: "Overwrite a replacement",
          createdAt: "2026-07-16T10:02:50.000Z",
        },
        readModel: withUsage,
      }),
    );
    expect(Exit.isFailure(staleEdit)).toBe(true);

    const stale = await Effect.runPromiseExit(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.usage.record",
          commandId: CommandId.makeUnsafe("command-goal-stale-usage"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: "goal:stale-lifecycle",
          tokensDelta: 1,
          timeDeltaSeconds: 0,
          createdAt: "2026-07-16T10:03:00.000Z",
        },
        readModel: withUsage,
      }),
    );
    expect(Exit.isFailure(stale)).toBe(true);
  });

  it("uses lifecycle CAS for structured status reports and automatic continuation", async () => {
    const readModel = await makeReadModel();
    const goalFact = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.makeUnsafe("command-structured-goal"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: null,
          objective: "Finish through the harness",
          createdAt: CREATED_AT,
        },
        readModel,
      }),
    );
    if (Array.isArray(goalFact)) throw new Error("Expected one goal fact");
    const withGoal = await Effect.runPromise(
      projectEvent(readModel, { ...goalFact, sequence: 3 } as OrchestrationEvent),
    );

    const continuation = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.continue",
          commandId: CommandId.makeUnsafe("command-goal-continuation"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: "goal:command-structured-goal",
          sourceTurnId: TurnId.makeUnsafe("turn-before-continuation"),
          createdAt: "2026-07-16T10:01:00.000Z",
        },
        readModel: withGoal,
      }),
    );
    expect(continuation).toMatchObject({
      type: "thread.goal-continuation-requested",
      payload: {
        threadId: THREAD_ID,
        expectedGoalLifecycleKey: "goal:command-structured-goal",
        messageId: MessageId.makeUnsafe("goal-continuation:command-goal-continuation"),
        sourceTurnId: TurnId.makeUnsafe("turn-before-continuation"),
      },
    });

    const completed = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.status.report",
          commandId: CommandId.makeUnsafe("command-goal-complete-report"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: "goal:command-structured-goal",
          status: "complete",
          turnId: TurnId.makeUnsafe("turn-before-continuation"),
          createdAt: "2026-07-16T10:01:01.000Z",
        },
        readModel: withGoal,
      }),
    );
    expect(completed).toMatchObject({
      type: "thread.goal-updated",
      payload: {
        turnId: TurnId.makeUnsafe("turn-before-continuation"),
        goal: { status: "complete" },
      },
    });

    const stale = await Effect.runPromiseExit(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.status.report",
          commandId: CommandId.makeUnsafe("command-goal-stale-report"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: "goal:replaced",
          status: "complete",
          createdAt: "2026-07-16T10:01:02.000Z",
        },
        readModel: withGoal,
      }),
    );
    expect(Exit.isFailure(stale)).toBe(true);
  });

  it("rejects a stale same-lifecycle pause after the harness completes a goal", async () => {
    const readModel = await makeReadModel();
    const goalFact = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.makeUnsafe("command-goal-before-stale-pause"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: null,
          objective: "Finish before a stale browser update",
          createdAt: CREATED_AT,
        },
        readModel,
      }),
    );
    if (Array.isArray(goalFact)) throw new Error("Expected one goal fact");
    const withGoal = await Effect.runPromise(
      projectEvent(readModel, { ...goalFact, sequence: 3 } as OrchestrationEvent),
    );

    const completionFact = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.status.report",
          commandId: CommandId.makeUnsafe("command-goal-complete-before-stale-pause"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: "goal:command-goal-before-stale-pause",
          status: "complete",
          createdAt: "2026-07-16T10:01:00.000Z",
        },
        readModel: withGoal,
      }),
    );
    if (Array.isArray(completionFact)) throw new Error("Expected one completion fact");
    const withCompletedGoal = await Effect.runPromise(
      projectEvent(withGoal, { ...completionFact, sequence: 4 } as OrchestrationEvent),
    );

    expect(withCompletedGoal.threads[0]?.goal?.status).toBe("complete");
    const stalePause = await Effect.runPromiseExit(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.makeUnsafe("command-stale-pause-after-completion"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: "goal:command-goal-before-stale-pause",
          status: "paused",
          createdAt: "2026-07-16T10:01:01.000Z",
        },
        readModel: withCompletedGoal,
      }),
    );

    expect(Exit.isFailure(stalePause)).toBe(true);
    expect(withCompletedGoal.threads[0]?.goal?.status).toBe("complete");
  });

  it("pauses an active goal before persisting an interrupt request", async () => {
    const readModel = await makeReadModel();
    const goalFact = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.makeUnsafe("command-interrupted-goal"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: null,
          objective: "Pause safely",
          createdAt: CREATED_AT,
        },
        readModel,
      }),
    );
    if (Array.isArray(goalFact)) throw new Error("Expected one goal fact");
    const withGoal = await Effect.runPromise(
      projectEvent(readModel, { ...goalFact, sequence: 3 } as OrchestrationEvent),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("command-goal-interrupt"),
          threadId: THREAD_ID,
          turnId: TurnId.makeUnsafe("turn-interrupted-goal"),
          createdAt: "2026-07-16T10:02:00.000Z",
        },
        readModel: withGoal,
      }),
    );
    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.goal-updated",
      "thread.turn-interrupt-requested",
    ]);
    expect(events[0]).toMatchObject({
      type: "thread.goal-updated",
      payload: { goal: { status: "paused" } },
    });
    expect(events[1]?.causationEventId).toBe(events[0]?.eventId);

    const stopResult = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.session.stop",
          commandId: CommandId.makeUnsafe("command-goal-session-stop"),
          threadId: THREAD_ID,
          createdAt: "2026-07-16T10:03:00.000Z",
        },
        readModel: withGoal,
      }),
    );
    const stopEvents = Array.isArray(stopResult) ? stopResult : [stopResult];
    expect(stopEvents.map((event) => event.type)).toEqual([
      "thread.goal-updated",
      "thread.session-stop-requested",
    ]);
    expect(stopEvents[0]).toMatchObject({ payload: { goal: { status: "paused" } } });
    expect(stopEvents[1]?.causationEventId).toBe(stopEvents[0]?.eventId);
  });

  it("pauses an active goal atomically when its thread is archived", async () => {
    const readModel = await makeReadModel();
    const goalFact = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.makeUnsafe("command-archived-goal"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: null,
          objective: "Do not keep running after archive",
          createdAt: CREATED_AT,
        },
        readModel,
      }),
    );
    if (Array.isArray(goalFact)) throw new Error("Expected one goal fact");
    const withGoal = await Effect.runPromise(
      projectEvent(readModel, { ...goalFact, sequence: 3 } as OrchestrationEvent),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: CommandId.makeUnsafe("command-archive-active-goal"),
          threadId: THREAD_ID,
        },
        readModel: withGoal,
      }),
    );
    const events = Array.isArray(result) ? result : [result];

    expect(events.map((event) => event.type)).toEqual(["thread.goal-updated", "thread.archived"]);
    expect(events[0]).toMatchObject({ payload: { goal: { status: "paused" } } });
    expect(events[1]?.causationEventId).toBe(events[0]?.eventId);
  });

  it("rejects continuation for a deleted thread", async () => {
    const readModel = await makeReadModel();
    const deletedReadModel: OrchestrationReadModel = {
      ...readModel,
      threads: [
        {
          ...readModel.threads[0]!,
          deletedAt: "2026-07-16T10:01:00.000Z",
          goal: {
            threadId: THREAD_ID,
            lifecycleId: "goal:deleted",
            objective: "Do not restart",
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          },
        },
      ],
    };

    const result = await Effect.runPromiseExit(
      decideOrchestrationCommand({
        command: {
          type: "thread.goal.continue",
          commandId: CommandId.makeUnsafe("command-deleted-goal-continuation"),
          threadId: THREAD_ID,
          expectedGoalLifecycleKey: "goal:deleted",
          createdAt: "2026-07-16T10:02:00.000Z",
        },
        readModel: deletedReadModel,
      }),
    );
    expect(Exit.isFailure(result)).toBe(true);
  });
});
