import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ClientOrchestrationCommand,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationGetTurnDiffInput,
  OrchestrationLatestTurn,
  ProjectionPendingApprovalDecision,
  ProviderApprovalDecision,
  ProjectCreatedPayload,
  ProjectMetaUpdatedPayload,
  OrchestrationProposedPlan,
  OrchestrationSession,
  ProjectCreateCommand,
  ThreadMetaUpdatedPayload,
  ThreadGoalObjective,
  THREAD_GOAL_OBJECTIVE_MAX_SCALARS,
  ThreadTurnStartCommand,
  ThreadCreatedPayload,
  ThreadTurnDiff,
  ThreadTurnStartRequestedPayload,
} from "./orchestration";

const decodeTurnDiffInput = Schema.decodeUnknownEffect(OrchestrationGetTurnDiffInput);
const decodeThreadTurnDiff = Schema.decodeUnknownEffect(ThreadTurnDiff);
const decodeProjectCreateCommand = Schema.decodeUnknownEffect(ProjectCreateCommand);
const decodeProjectCreatedPayload = Schema.decodeUnknownEffect(ProjectCreatedPayload);
const decodeProjectMetaUpdatedPayload = Schema.decodeUnknownEffect(ProjectMetaUpdatedPayload);
const decodeThreadTurnStartCommand = Schema.decodeUnknownEffect(ThreadTurnStartCommand);
const decodeThreadTurnStartRequestedPayload = Schema.decodeUnknownEffect(
  ThreadTurnStartRequestedPayload,
);
const decodeOrchestrationLatestTurn = Schema.decodeUnknownEffect(OrchestrationLatestTurn);
const decodeOrchestrationProposedPlan = Schema.decodeUnknownEffect(OrchestrationProposedPlan);
const decodeOrchestrationSession = Schema.decodeUnknownEffect(OrchestrationSession);
const decodeThreadCreatedPayload = Schema.decodeUnknownEffect(ThreadCreatedPayload);
const decodeClientOrchestrationCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeOrchestrationCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeThreadMetaUpdatedPayload = Schema.decodeUnknownEffect(ThreadMetaUpdatedPayload);
const decodeProviderApprovalDecision = Schema.decodeUnknownEffect(ProviderApprovalDecision);
const decodeProjectionPendingApprovalDecision = Schema.decodeUnknownEffect(
  ProjectionPendingApprovalDecision,
);
const decodeThreadGoalObjective = Schema.decodeUnknownEffect(ThreadGoalObjective);

it.effect("parses turn diff input when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
    });
    assert.strictEqual(parsed.fromTurnCount, 1);
    assert.strictEqual(parsed.toTurnCount, 2);
  }),
);

it.effect("rejects turn diff input when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeTurnDiffInput({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("rejects thread turn diff when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeThreadTurnDiff({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
        diff: "patch",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims branded ids and command string fields at decode boundaries", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreateCommand({
      type: "project.create",
      commandId: " cmd-1 ",
      projectId: " project-1 ",
      title: " Project Title ",
      workspaceRoot: " /tmp/workspace ",
      defaultModelSelection: {
        provider: "codex",
        model: " gpt-5.2 ",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.commandId, "cmd-1");
    assert.strictEqual(parsed.projectId, "project-1");
    assert.strictEqual(parsed.title, "Project Title");
    assert.strictEqual(parsed.workspaceRoot, "/tmp/workspace");
    assert.deepStrictEqual(parsed.defaultModelSelection, {
      provider: "codex",
      model: "gpt-5.2",
    });
  }),
);

it.effect("decodes Kanban item commands and events", () =>
  Effect.gen(function* () {
    const command = yield* decodeOrchestrationCommand({
      type: "kanbanItem.create",
      commandId: "cmd-kanban-create",
      itemId: "kanban-item-1",
      projectId: "project-1",
      pullRequest: {
        number: 42,
        title: "Add Kanban",
        url: "https://github.com/acme/repo/pull/42",
      },
      title: "Track review fixes",
      description: "Keep the agent work visible.",
      status: "todo",
      sortKey: "001",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(command.type, "kanbanItem.create");
    assert.strictEqual(command.status, "todo");

    const event = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-kanban-created",
      aggregateKind: "kanbanItem",
      aggregateId: "kanban-item-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-kanban-create",
      causationEventId: null,
      correlationId: "cmd-kanban-create",
      metadata: {},
      type: "kanbanItem.created",
      payload: {
        item: {
          id: "kanban-item-1",
          projectId: "project-1",
          pullRequest: { number: 42 },
          title: "Track review fixes",
          description: "",
          status: "backlog",
          sortKey: "001",
          blockedReason: null,
          assignees: [],
          notes: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          completedAt: null,
          deletedAt: null,
        },
      },
    });
    assert.strictEqual(event.type, "kanbanItem.created");
    assert.strictEqual(event.payload.item.pullRequest?.number, 42);
  }),
);

it.effect("decodes historical project.created payloads with a default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.provider, "codex");
  }),
);

it.effect("decodes project.meta-updated payloads with explicit default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectMetaUpdatedPayload({
      projectId: "project-1",
      defaultModelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.provider, "claudeAgent");
  }),
);

it.effect("rejects command fields that become empty after trim", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeProjectCreateCommand({
        type: "project.create",
        commandId: "cmd-1",
        projectId: "project-1",
        title: "  ",
        workspaceRoot: "/tmp/workspace",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("limits goal objectives by Unicode scalar values", () =>
  Effect.gen(function* () {
    const accepted = "🚀".repeat(THREAD_GOAL_OBJECTIVE_MAX_SCALARS);
    assert.strictEqual(yield* decodeThreadGoalObjective(accepted), accepted);

    const rejected = yield* Effect.exit(decodeThreadGoalObjective(`${accepted}🚀`));
    assert.ok(Exit.isFailure(rejected));
  }),
);

it.effect("requires positive non-null goal token budgets", () =>
  Effect.gen(function* () {
    const publicRequest = yield* Effect.exit(
      decodeOrchestrationCommand({
        type: "thread.goal.set",
        commandId: "command-goal-budget",
        threadId: "thread-goal-budget",
        expectedGoalLifecycleKey: null,
        objective: "Ship the goal",
        tokenBudget: 0,
        createdAt: "2026-07-16T10:00:00.000Z",
      }),
    );
    assert.ok(Exit.isFailure(publicRequest));

    const turnIntent = yield* Effect.exit(
      decodeThreadTurnStartCommand({
        type: "thread.turn.start",
        commandId: "command-goal-turn-budget",
        threadId: "thread-goal-budget",
        message: {
          messageId: "message-goal-budget",
          role: "user",
          text: "Ship the goal",
          attachments: [],
        },
        goalIntent: {
          objective: "Ship the goal",
          status: "active",
          tokenBudget: 0,
          expectedGoalLifecycleKey: null,
        },
        createdAt: "2026-07-16T10:00:00.000Z",
      }),
    );
    assert.ok(Exit.isFailure(turnIntent));

    const snapshot = yield* Effect.exit(
      decodeOrchestrationCommand({
        type: "thread.goal.snapshot.set",
        commandId: "command-goal-snapshot-budget",
        threadId: "thread-goal-budget",
        goal: {
          threadId: "thread-goal-budget",
          objective: "Ship the goal",
          status: "active",
          tokenBudget: 0,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: "2026-07-16T10:00:00.000Z",
          updatedAt: "2026-07-16T10:00:00.000Z",
        },
        createdAt: "2026-07-16T10:00:00.000Z",
      }),
    );
    assert.ok(Exit.isFailure(snapshot));

    const factualEvent = yield* Effect.exit(
      decodeOrchestrationEvent({
        sequence: 1,
        eventId: "event-goal-updated-budget",
        aggregateKind: "thread",
        aggregateId: "thread-goal-budget",
        occurredAt: "2026-07-16T10:00:00.000Z",
        commandId: "command-goal-updated-budget",
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.goal-updated",
        payload: {
          threadId: "thread-goal-budget",
          goal: {
            threadId: "thread-goal-budget",
            objective: "Ship the goal",
            status: "active",
            tokenBudget: 0,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: "2026-07-16T10:00:00.000Z",
            updatedAt: "2026-07-16T10:00:00.000Z",
          },
        },
      }),
    );
    assert.ok(Exit.isFailure(factualEvent));
  }),
);

it.effect("strips harness-owned goal lifecycle fields from public commands", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationCommand({
      type: "thread.goal.set",
      commandId: "command-goal-public-fields",
      threadId: "thread-goal-public-fields",
      expectedGoalLifecycleKey: null,
      objective: "Ship the goal",
      tokensUsed: 100,
      timeUsedSeconds: 20,
      goalCreatedAt: "2026-07-16T09:00:00.000Z",
      goalUpdatedAt: "2026-07-16T09:01:00.000Z",
      createdAt: "2026-07-16T10:00:00.000Z",
    });

    assert.strictEqual("tokensUsed" in parsed, false);
    assert.strictEqual("timeUsedSeconds" in parsed, false);
    assert.strictEqual("goalCreatedAt" in parsed, false);
    assert.strictEqual("goalUpdatedAt" in parsed, false);
  }),
);

it.effect("rejects harness-owned limit statuses on public goal commands", () =>
  Effect.gen(function* () {
    for (const status of ["blocked", "usageLimited", "budgetLimited"] as const) {
      const result = yield* Effect.exit(
        decodeOrchestrationCommand({
          type: "thread.goal.set",
          commandId: `command-goal-status-${status}`,
          threadId: "thread-goal-status",
          expectedGoalLifecycleKey: null,
          objective: "Ship the goal",
          status,
          createdAt: "2026-07-16T10:00:00.000Z",
        }),
      );
      assert.ok(Exit.isFailure(result));
    }
  }),
);

it.effect("decodes harness-only goal lifecycle commands and mutation metadata", () =>
  Effect.gen(function* () {
    const statusReport = yield* decodeOrchestrationCommand({
      type: "thread.goal.status.report",
      commandId: "server:goal-complete",
      threadId: "thread-goal-internal",
      expectedGoalLifecycleKey: "goal:lifecycle-1",
      status: "complete",
      turnId: "turn-goal-internal",
      createdAt: "2026-07-16T10:00:00.000Z",
    });
    assert.strictEqual(statusReport.type, "thread.goal.status.report");

    const continuation = yield* decodeOrchestrationCommand({
      type: "thread.goal.continue",
      commandId: "server:goal-continue",
      threadId: "thread-goal-internal",
      expectedGoalLifecycleKey: "goal:lifecycle-1",
      sourceTurnId: "turn-goal-internal",
      createdAt: "2026-07-16T10:00:01.000Z",
    });
    assert.strictEqual(continuation.type, "thread.goal.continue");

    const event = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-goal-user-mutation",
      aggregateKind: "thread",
      aggregateId: "thread-goal-internal",
      occurredAt: "2026-07-16T10:00:00.000Z",
      commandId: "command-goal-user-mutation",
      causationEventId: null,
      correlationId: "command-goal-user-mutation",
      metadata: { threadGoalMutation: "user" },
      type: "thread.goal-updated",
      payload: {
        threadId: "thread-goal-internal",
        goal: {
          threadId: "thread-goal-internal",
          lifecycleId: "goal:lifecycle-1",
          objective: "Ship the goal",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: "2026-07-16T10:00:00.000Z",
          updatedAt: "2026-07-16T10:00:00.000Z",
        },
      },
    });
    assert.strictEqual(event.metadata.threadGoalMutation, "user");
  }),
);

it.effect("rejects harness-only goal lifecycle commands at the client boundary", () =>
  Effect.gen(function* () {
    const createdAt = "2026-07-16T10:00:00.000Z";
    const commands: ReadonlyArray<unknown> = [
      {
        type: "thread.goal.snapshot.set",
        commandId: "server:goal-snapshot",
        threadId: "thread-goal-internal",
        goal: {
          threadId: "thread-goal-internal",
          lifecycleId: "goal:lifecycle-1",
          objective: "Ship the harness goal",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt,
          updatedAt: createdAt,
        },
        createdAt,
      },
      {
        type: "thread.goal.usage.record",
        commandId: "server:goal-usage",
        threadId: "thread-goal-internal",
        expectedGoalLifecycleKey: "goal:lifecycle-1",
        tokensDelta: 10,
        timeDeltaSeconds: 1,
        createdAt,
      },
      {
        type: "thread.goal.status.report",
        commandId: "server:goal-complete",
        threadId: "thread-goal-internal",
        expectedGoalLifecycleKey: "goal:lifecycle-1",
        status: "complete",
        createdAt,
      },
      {
        type: "thread.goal.continue",
        commandId: "server:goal-continue",
        threadId: "thread-goal-internal",
        expectedGoalLifecycleKey: "goal:lifecycle-1",
        createdAt,
      },
      {
        type: "thread.goal.snapshot.clear",
        commandId: "server:goal-snapshot-clear",
        threadId: "thread-goal-internal",
        clearedAt: createdAt,
        createdAt,
      },
    ];

    for (const command of commands) {
      const result = yield* Effect.exit(decodeClientOrchestrationCommand(command));
      assert.ok(Exit.isFailure(result));
    }
  }),
);

it.effect("decodes thread.turn.start defaults for provider and runtime mode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-1",
      threadId: "thread-1",
      message: {
        messageId: "msg-1",
        role: "user",
        text: "hello",
        attachments: [],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection, undefined);
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("preserves explicit provider and runtime mode in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-2",
      threadId: "thread-1",
      message: {
        messageId: "msg-2",
        role: "user",
        text: "hello",
        attachments: [],
      },
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.provider, "codex");
    assert.strictEqual(parsed.runtimeMode, "full-access");
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("decodes thread.created runtime mode for historical events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread title",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.modelSelection.provider, "codex");
  }),
);

it.effect("defaults thread lineage metadata for historical thread.created payloads", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread title",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.parentThreadId, undefined);
    assert.strictEqual(parsed.branchSourceTurnId, undefined);
  }),
);

it.effect("preserves thread lineage metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationCommand({
      type: "thread.create",
      commandId: "cmd-thread-branch",
      threadId: "thread-2",
      projectId: "project-1",
      title: "Thread title (branch)",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      parentThreadId: "thread-1",
      branchSourceTurnId: "turn-1",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.type, "thread.create");
    assert.strictEqual(parsed.parentThreadId, "thread-1");
    assert.strictEqual(parsed.branchSourceTurnId, "turn-1");
  }),
);

it.effect("decodes thread.meta-updated payloads with explicit provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadMetaUpdatedPayload({
      threadId: "thread-1",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.provider, "claudeAgent");
  }),
);

it.effect("decodes thread archive and unarchive commands", () =>
  Effect.gen(function* () {
    const archive = yield* decodeOrchestrationCommand({
      type: "thread.archive",
      commandId: "cmd-archive-1",
      threadId: "thread-1",
    });
    const unarchive = yield* decodeOrchestrationCommand({
      type: "thread.unarchive",
      commandId: "cmd-unarchive-1",
      threadId: "thread-1",
    });

    assert.strictEqual(archive.type, "thread.archive");
    assert.strictEqual(unarchive.type, "thread.unarchive");
  }),
);

it.effect("decodes thread archived and unarchived events", () =>
  Effect.gen(function* () {
    const archived = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-archive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.archived",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-archive-1",
      causationEventId: null,
      correlationId: "cmd-archive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        archivedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const unarchived = yield* decodeOrchestrationEvent({
      sequence: 2,
      eventId: "event-unarchive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.unarchived",
      occurredAt: "2026-01-02T00:00:00.000Z",
      commandId: "cmd-unarchive-1",
      causationEventId: null,
      correlationId: "cmd-unarchive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    assert.strictEqual(archived.type, "thread.archived");
    assert.strictEqual(archived.payload.archivedAt, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(unarchived.type, "thread.unarchived");
  }),
);

it.effect("accepts provider-scoped model options in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-options",
      threadId: "thread-1",
      message: {
        messageId: "msg-options",
        role: "user",
        text: "hello",
        attachments: [],
      },
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.provider, "codex");
    assert.strictEqual(parsed.modelSelection?.options?.reasoningEffort, "high");
    assert.strictEqual(parsed.modelSelection?.options?.fastMode, true);
  }),
);

it.effect("accepts a title seed in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-title-seed",
      threadId: "thread-1",
      message: {
        messageId: "msg-title-seed",
        role: "user",
        text: "hello",
        attachments: [],
      },
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

it.effect("accepts a source proposed plan reference in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-source-plan",
      threadId: "thread-2",
      message: {
        messageId: "msg-source-plan",
        role: "user",
        text: "implement this",
        attachments: [],
      },
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect(
  "decodes thread.turn-start-requested defaults for provider, runtime mode, and interaction mode",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeThreadTurnStartRequestedPayload({
        threadId: "thread-1",
        messageId: "msg-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      assert.strictEqual(parsed.modelSelection, undefined);
      assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
      assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
      assert.strictEqual(parsed.sourceProposedPlan, undefined);
    }),
);

it.effect("decodes thread.turn-start-requested source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes thread.turn-start-requested title seed when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

it.effect("decodes latest turn source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationLatestTurn({
      turnId: "turn-2",
      state: "running",
      requestedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes orchestration session runtime mode defaults", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationSession({
      threadId: "thread-1",
      status: "idle",
      providerName: null,
      providerSessionId: null,
      providerThreadId: null,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
  }),
);

it.effect("defaults proposed plan implementation metadata for historical rows", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-1",
      turnId: "turn-1",
      planMarkdown: "# Plan",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, null);
    assert.strictEqual(parsed.implementationThreadId, null);
  }),
);

it.effect("preserves proposed plan implementation metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-2",
      turnId: "turn-2",
      planMarkdown: "# Plan",
      implementedAt: "2026-01-02T00:00:00.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, "2026-01-02T00:00:00.000Z");
    assert.strictEqual(parsed.implementationThreadId, "thread-2");
  }),
);

it.effect("decodes codex execpolicy amendment approval decisions", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProviderApprovalDecision({
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ['allow: ["git", "status"]'],
      },
    });
    assert.deepStrictEqual(parsed, {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ['allow: ["git", "status"]'],
      },
    });
  }),
);

it.effect("decodes codex network policy amendment approval decisions", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProviderApprovalDecision({
      applyNetworkPolicyAmendment: {
        network_policy_amendment: {
          host: "example.com",
          action: "allow",
        },
      },
    });
    assert.deepStrictEqual(parsed, {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: {
          host: "example.com",
          action: "allow",
        },
      },
    });
  }),
);

it.effect("rejects structured decisions in pending approval projection rows", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeProjectionPendingApprovalDecision({
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ['allow: ["git", "status"]'],
        },
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);
