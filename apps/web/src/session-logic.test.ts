import { EventId, MessageId, ThreadId, TurnId, type OrchestrationThreadActivity } from "contracts";
import { describe, expect, it } from "vitest";

import {
  deriveCompletionDividerBeforeEntryId,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  deriveVisibleTimelineMessages,
  PROVIDER_OPTIONS,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveReasoningEntries,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  findLatestProposedPlan,
  findSidebarProposedPlan,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  isSessionActivelyRunningTurn,
  isLatestTurnSettled,
} from "./session-logic";

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  const payload = overrides.payload ?? {};
  return {
    id: EventId.makeUnsafe(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload,
    turnId: overrides.turnId ? TurnId.makeUnsafe(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("derivePendingApprovals", () => {
  it("tracks open approvals and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-1",
          requestKind: "command",
          detail: "bun run lint",
        },
      }),
      makeActivity({
        id: "approval-close",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "approval.resolved",
        summary: "Approval resolved",
        tone: "info",
        payload: { requestId: "req-2" },
      }),
      makeActivity({
        id: "approval-closed-request",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "approval.requested",
        summary: "File-change approval requested",
        tone: "approval",
        payload: { requestId: "req-2", requestKind: "file-change" },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "bun run lint",
      },
    ]);
  });

  it("maps canonical requestType payloads into pending approvals", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-request-type",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-request-type",
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-request-type",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "pwd",
      },
    ]);
  });

  it("clears stale pending approvals when provider reports unknown pending request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-1",
          detail: "Unknown pending permission request: req-stale-1",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });

  it("clears stale pending approvals when the backend marks them stale after restart", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale-restart",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-restart-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale-restart",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-restart-1",
          detail:
            "Stale pending approval request: req-stale-restart-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });
});

describe("derivePendingUserInputs", () => {
  it("tracks open structured prompts and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-resolved",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.resolved",
        summary: "User input submitted",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          answers: {
            sandbox_mode: "workspace-write",
          },
        },
      }),
      makeActivity({
        id: "user-input-open-2",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          questions: [
            {
              id: "approval",
              header: "Approval",
              question: "Continue?",
              options: [
                {
                  label: "yes",
                  description: "Continue execution",
                },
              ],
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([
      {
        requestId: "req-user-input-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("clears stale pending user-input prompts when the provider reports an orphaned request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-stale-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        tone: "error",
        payload: {
          requestId: "req-user-input-stale-1",
          detail:
            "Stale pending user-input request: req-user-input-stale-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([]);
  });
});

describe("deriveActivePlanState", () => {
  it("returns the latest plan update for the active turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-old",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Initial plan",
          plan: [{ step: "Inspect code", status: "pending" }],
        },
      }),
      makeActivity({
        id: "plan-latest",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Refined plan",
          plan: [{ step: "Implement Codex user input", status: "inProgress" }],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.makeUnsafe("turn-1"))).toEqual({
      createdAt: "2026-02-23T00:00:02.000Z",
      turnId: "turn-1",
      explanation: "Refined plan",
      steps: [{ step: "Implement Codex user input", status: "inProgress" }],
    });
  });
});

describe("findLatestProposedPlan", () => {
  it("prefers the latest proposed plan for the active turn", () => {
    expect(
      findLatestProposedPlan(
        [
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "# Older",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:01.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "# Latest",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:02.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-2",
            turnId: TurnId.makeUnsafe("turn-2"),
            planMarkdown: "# Different turn",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:03.000Z",
            updatedAt: "2026-02-23T00:00:03.000Z",
          },
        ],
        TurnId.makeUnsafe("turn-1"),
      ),
    ).toEqual({
      id: "plan:thread-1:turn:turn-1",
      turnId: "turn-1",
      planMarkdown: "# Latest",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the most recently updated proposed plan", () => {
    const latestPlan = findLatestProposedPlan(
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# First",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:01.000Z",
          updatedAt: "2026-02-23T00:00:01.000Z",
        },
        {
          id: "plan:thread-1:turn:turn-2",
          turnId: TurnId.makeUnsafe("turn-2"),
          planMarkdown: "# Latest",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:03.000Z",
        },
      ],
      null,
    );

    expect(latestPlan?.planMarkdown).toBe("# Latest");
  });
});

describe("hasActionableProposedPlan", () => {
  it("returns true for an unimplemented proposed plan", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.makeUnsafe("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:01.000Z",
      }),
    ).toBe(true);
  });

  it("returns false for a proposed plan already implemented elsewhere", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.makeUnsafe("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: "2026-02-23T00:00:02.000Z",
        implementationThreadId: ThreadId.makeUnsafe("thread-implement"),
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe(false);
  });
});

describe("findSidebarProposedPlan", () => {
  it("prefers the running turn source proposed plan when available on the same thread", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.makeUnsafe("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.makeUnsafe("turn-plan"),
                planMarkdown: "# Source plan",
                implementedAt: "2026-02-23T00:00:03.000Z",
                implementationThreadId: ThreadId.makeUnsafe("thread-2"),
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
            ],
          },
          {
            id: ThreadId.makeUnsafe("thread-2"),
            proposedPlans: [
              {
                id: "plan-2",
                turnId: TurnId.makeUnsafe("turn-other"),
                planMarkdown: "# Latest elsewhere",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:04.000Z",
                updatedAt: "2026-02-23T00:00:05.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: false,
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    ).toEqual({
      id: "plan-1",
      turnId: "turn-plan",
      planMarkdown: "# Source plan",
      implementedAt: "2026-02-23T00:00:03.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the latest proposed plan once the turn is settled", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.makeUnsafe("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.makeUnsafe("turn-plan"),
                planMarkdown: "# Older",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
              {
                id: "plan-2",
                turnId: TurnId.makeUnsafe("turn-latest"),
                planMarkdown: "# Latest",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:03.000Z",
                updatedAt: "2026-02-23T00:00:04.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: true,
        threadId: ThreadId.makeUnsafe("thread-1"),
      })?.planMarkdown,
    ).toBe("# Latest");
  });
});

describe("deriveWorkLogEntries", () => {
  it("keeps tool started entries as running work log rows", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Tool call",
        kind: "tool.started",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-start"]);
    expect(entries[0]?.running).toBe(true);
  });

  it("omits task start and completion lifecycle entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        summary: "default task started",
        tone: "info",
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Updating files",
        tone: "info",
      }),
      makeActivity({
        id: "task-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["task-progress"]);
  });

  it("filters by turn id when provided", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "turn-1", turnId: "turn-1", summary: "Tool call", kind: "tool.started" }),
      makeActivity({
        id: "turn-2",
        turnId: "turn-2",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({ id: "no-turn", summary: "Checkpoint captured", tone: "info" }),
    ];

    const entries = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"));
    expect(entries.map((entry) => entry.id)).toEqual(["turn-2"]);
  });

  it("keeps tool rows from all turns when no turn filter is provided", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "turn-1-tool",
        turnId: "turn-1",
        summary: "First turn tool",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "turn-2-tool",
        turnId: "turn-2",
        summary: "Second turn tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["turn-1-tool", "turn-2-tool"]);
  });

  it("collapses a started tool row into the completed row for the same tool lifecycle", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Execute command started",
        tone: "tool",
        payload: {
          itemId: "tool:call-1",
          itemType: "command_execution",
          title: "Execute command",
          detail: "ls -R src",
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Execute command",
        tone: "tool",
        payload: {
          itemId: "tool:call-1",
          itemType: "command_execution",
          title: "Execute command",
          detail: "ls -R src",
          data: { stdout: "done" },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("tool-start");
    expect(entries[0]?.createdAt).toBe("2026-02-23T00:00:01.000Z");
    expect(entries[0]?.running).toBe(false);
  });

  it("collapses matching started/completed tool rows by stable item id even when text differs", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Execute command started",
        tone: "tool",
        payload: {
          itemId: "tool:call-2",
          itemType: "command_execution",
          title: "Execute command",
          detail: "find src -name '*.ts'",
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Command complete",
        tone: "tool",
        payload: {
          itemId: "tool:call-2",
          itemType: "command_execution",
          title: "Execute command",
          detail: "find src -name '*.ts' <exited with exit code 0>",
          data: { stdout: "a.ts\nb.ts" },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("tool-start");
    expect(entries[0]?.createdAt).toBe("2026-02-23T00:00:01.000Z");
    expect(entries[0]?.running).toBe(false);
  });

  it("collapses started/completed tool rows by item id even when other activities interleave", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-start-interleaved",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Bash started",
        tone: "tool",
        payload: {
          itemId: "tool:call-interleaved",
          itemType: "command_execution",
          title: "Bash",
          detail: "mkdir -p ./dogfood-output/screenshots ./dogfood-output/videos",
        },
      }),
      makeActivity({
        id: "commentary-interleaved",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "assistant.commentary",
        summary: "Status update",
        tone: "info",
        payload: {
          detail: "Let me check if the dev server is running.",
        },
      }),
      makeActivity({
        id: "tool-complete-interleaved",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Bash completed",
        tone: "tool",
        payload: {
          itemId: "tool:call-interleaved",
          itemType: "command_execution",
          title: "Bash",
          detail: "mkdir -p ./dogfood-output/screenshots ./dogfood-output/videos",
          data: { stdout: "" },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual([
      "tool-start-interleaved",
      "commentary-interleaved",
    ]);
    expect(entries[0]?.createdAt).toBe("2026-02-23T00:00:01.000Z");
    expect(entries[0]?.running).toBe(false);
  });

  it("does not keep completed tool updates marked as running", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-update-completed",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Execute command",
        tone: "tool",
        payload: {
          itemType: "command_execution",
          title: "Execute command",
          status: "completed",
          detail: "bun run lint",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("tool-update-completed");
    expect(entries[0]?.running).toBe(false);
  });

  it("keeps assistant commentary entries in the work log so they can render as muted status text", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "commentary-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "assistant.commentary",
        summary: "Status update",
        tone: "info",
        payload: {
          detail: "Checking auth state first.",
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        tone: "tool",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["commentary-1", "tool-complete"]);
  });

  it("omits checkpoint captured info entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "checkpoint",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Checkpoint captured",
        tone: "info",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        tone: "tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits ExitPlanMode lifecycle entries once the plan card is shown", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "exit-plan-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          detail: 'ExitPlanMode: {"allowedPrompts":[{"tool":"Bash","prompt":"run tests"}]}',
        },
      }),
      makeActivity({
        id: "exit-plan-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          detail: "ExitPlanMode: {}",
        },
      }),
      makeActivity({
        id: "real-work-log",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail: "Bash: bun test",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["real-work-log"]);
  });

  it("orders work log by activity sequence when present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "second",
        createdAt: "2026-02-23T00:00:03.000Z",
        sequence: 2,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "first",
        createdAt: "2026-02-23T00:00:04.000Z",
        sequence: 1,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("extracts command text for command tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["bun", "run", "lint"],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("bun run lint");
  });

  it("unwraps shell launcher prefixes from command tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "shell-command-tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: '/bin/zsh -lc "pwd && rg --files -g \\"AGENTS.md\\""',
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe('pwd && rg --files -g "AGENTS.md"');
  });

  it("keeps compact Codex tool metadata used for icons and labels", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-with-metadata",
        kind: "tool.completed",
        summary: "bash",
        payload: {
          itemType: "command_execution",
          title: "bash",
          status: "completed",
          detail: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
          data: {
            item: {
              command: ["bun", "run", "dev"],
              result: {
                content: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
                exitCode: 0,
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      command: "bun run dev",
      detail: '{ "dev": "vite dev --port 3000" }',
      itemType: "command_execution",
      toolTitle: "bash",
    });
  });

  it("preserves full command stdout and stderr payloads in work log output", () => {
    const stdout = `${"stdout line\n".repeat(150)}stdout tail`;
    const stderr = `${"stderr line\n".repeat(60)}stderr tail`;
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-output",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail: "bun run lint",
          data: {
            command: "bun run lint",
            stdout,
            stderr,
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.output).toEqual({
      command: "bun run lint",
      stdout,
      stderr,
    });
  });

  it("shows runtime warning messages as work log details", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "runtime-warning",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "info",
        payload: {
          message: "Provider got slow",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      label: "Runtime warning",
      detail: "Provider got slow",
    });
  });

  it("hides MCP refresh-token runtime warnings from the work log", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "runtime-warning",
        kind: "runtime.warning",
        summary: "Runtime warning",
        tone: "info",
        payload: {
          message:
            '2026-04-10T10:02:09.111601Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Auth(TokenRefreshFailed("Server returned error response: invalid_grant: Invalid refresh token"))',
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
  });

  it("extracts changed file paths for file-change tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          data: {
            item: {
              changes: [
                { path: "apps/web/src/components/ChatView.tsx" },
                { filename: "apps/web/src/session-logic.ts" },
              ],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual([
      "apps/web/src/components/ChatView.tsx",
      "apps/web/src/session-logic.ts",
    ]);
  });

  it("extracts notebook paths for notebook edit tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "notebook-tool",
        kind: "tool.completed",
        summary: "Notebook edit",
        payload: {
          itemType: "file_change",
          data: {
            toolName: "NotebookEdit",
            input: {
              notebook_path: "/tmp/demo.ipynb",
              cell_id: "cell-1",
              new_source: "print('hello')",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual(["/tmp/demo.ipynb"]);
  });

  it("collapses repeated lifecycle updates for the same tool call into one entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-update-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-update-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
          data: {
            item: {
              command: ["sed", "-n", "1,40p", "/tmp/app.ts"],
            },
          },
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tool-update-1",
      createdAt: "2026-02-23T00:00:01.000Z",
      label: "Tool call completed",
      detail: 'Read: {"file_path":"/tmp/app.ts"}',
      command: "sed -n 1,40p /tmp/app.ts",
      itemType: "dynamic_tool_call",
      toolTitle: "Tool call",
    });
  });

  it("merges started tool input with completed write_file output for collapsed entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "write-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Write file",
        payload: {
          itemId: "tool:write-1",
          itemType: "file_change",
          title: "Write file",
          status: "inProgress",
          detail: "apps/web/src/index.css",
          data: {
            toolName: "write_file",
            input: {
              path: "apps/web/src/index.css",
              content: "body {\n  color: red;\n}",
            },
          },
        },
      }),
      makeActivity({
        id: "write-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Write file",
        payload: {
          itemId: "tool:write-1",
          itemType: "file_change",
          title: "Write file",
          status: "completed",
          detail: "apps/web/src/index.css",
          data: {
            path: "apps/web/src/index.css",
            bytesWritten: 22,
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toBeDefined();
    expect(entry?.output).toEqual({
      toolName: "write_file",
      input: {
        path: "apps/web/src/index.css",
        content: "body {\n  color: red;\n}",
      },
      path: "apps/web/src/index.css",
      bytesWritten: 22,
    });
  });

  it("merges started web search input with completed hosted search output for collapsed entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "web-search-start",
        createdAt: "2026-04-14T00:00:01.000Z",
        kind: "tool.started",
        summary: "Web search started",
        payload: {
          itemId: "tool:web-search-1",
          itemType: "web_search",
          title: "Web Search",
          status: "inProgress",
          detail: "chicken pox treatment",
          data: {
            toolName: "web_search",
            input: {
              query: "chicken pox treatment",
            },
          },
        },
      }),
      makeActivity({
        id: "web-search-complete",
        createdAt: "2026-04-14T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Web search completed",
        payload: {
          itemId: "tool:web-search-1",
          itemType: "web_search",
          title: "Web Search",
          status: "completed",
          detail: "chicken pox treatment",
          data: {
            provider: "duckduckgo",
            query: "chicken pox treatment",
            results: [
              {
                title: "How to Treat Chickenpox | CDC",
                url: "https://www.cdc.gov/chickenpox/treatment/index.html",
              },
            ],
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toBeDefined();
    expect(entry?.detail).toBe("chicken pox treatment");
    expect(entry?.output).toEqual({
      toolName: "web_search",
      input: {
        query: "chicken pox treatment",
      },
      provider: "duckduckgo",
      query: "chicken pox treatment",
      results: [
        {
          title: "How to Treat Chickenpox | CDC",
          url: "https://www.cdc.gov/chickenpox/treatment/index.html",
        },
      ],
    });
  });

  it("collapses tool lifecycle rows using normalized command metadata when completion detail differs", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Execute command started",
        tone: "tool",
        payload: {
          itemType: "command_execution",
          title: "Execute command",
          detail: '/bin/zsh -lc "sed -n \\"1,40p\\" package.json"',
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Execute command",
        tone: "tool",
        payload: {
          itemType: "command_execution",
          title: "Execute command",
          data: {
            item: {
              command: '/bin/zsh -lc "sed -n \\"1,40p\\" package.json"',
            },
            result: {
              stdout: "{}",
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tool-start",
      createdAt: "2026-02-23T00:00:01.000Z",
      command: 'sed -n "1,40p" package.json',
      detail: '/bin/zsh -lc "sed -n \\"1,40p\\" package.json"',
      running: false,
    });
  });

  it("collapses generic tool lifecycle rows using structured tool input when detail is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-start",
        createdAt: "2026-04-18T12:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        tone: "tool",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          data: {
            toolName: "skill",
            input: {
              skill: "frontend-design",
            },
          },
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-04-18T12:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        tone: "tool",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          data: {
            item: {
              toolName: "skill",
              input: {
                skill: "frontend-design",
              },
            },
            result: {
              tool_use_id: "toolu_frontend_design",
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tool-start",
      createdAt: "2026-04-18T12:00:01.000Z",
      running: false,
      output: {
        toolName: "skill",
        input: {
          skill: "frontend-design",
        },
        item: {
          toolName: "skill",
          input: {
            skill: "frontend-design",
          },
        },
        result: {
          tool_use_id: "toolu_frontend_design",
        },
      },
    });
  });

  it("keeps separate tool entries when an identical call starts after the prior one completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-1-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-1-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-update",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-complete",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries.map((entry) => entry.id)).toEqual(["tool-1-update", "tool-2-update"]);
  });

  it("collapses same-timestamp lifecycle rows even when completed sorts before updated by id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "z-update-earlier",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "a-complete-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "z-update-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("z-update-earlier");
    expect(entries[0]?.createdAt).toBe("2026-02-23T00:00:01.000Z");
  });
});

describe("deriveTimelineEntries", () => {
  it("includes proposed plans alongside messages and work entries in chronological order", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [],
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# Ship it",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
      ],
      [
        {
          id: "work-1",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Ran tests",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "proposed-plan", "work"]);
    expect(entries[1]).toMatchObject({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: "# Ship it",
        implementedAt: null,
        implementationThreadId: null,
      },
    });
  });

  it("orders same-timestamp work entries before assistant messages", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("user-1"),
          role: "user",
          text: "Search the web for treatment advice.",
          createdAt: "2026-04-13T09:50:14.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant-1"),
          role: "assistant",
          text: "Chickenpox typically runs its course on its own.",
          createdAt: "2026-04-13T09:50:15.000Z",
          streaming: false,
        },
      ],
      [],
      [],
      [
        {
          id: "work-web-search-1",
          createdAt: "2026-04-13T09:50:15.000Z",
          label: "Web search",
          tone: "tool",
          itemType: "web_search",
          detail: "best way to get rid of chicken pox treatment",
        },
      ],
    );

    expect(entries.map((entry) => entry.id)).toEqual([
      "user-1",
      "work-web-search-1",
      "assistant-1",
    ]);
  });

  it("keeps late work activity above a completed assistant message", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("user-1"),
          role: "user",
          text: "Investigate the layout bug.",
          createdAt: "2026-04-21T00:18:00.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant-1"),
          role: "assistant",
          text: "I found the issue and fixed it.",
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-04-21T00:18:05.000Z",
          completedAt: "2026-04-21T00:18:20.000Z",
          streaming: false,
        },
      ],
      [],
      [],
      [
        {
          id: "work-edit-1",
          createdAt: "2026-04-21T00:18:12.000Z",
          label: "Edit file",
          tone: "tool",
          itemType: "file_change",
          detail: "apps/web/src/components/chat/MessagesTimeline.tsx",
        },
      ],
    );

    expect(entries.map((entry) => entry.id)).toEqual(["user-1", "work-edit-1", "assistant-1"]);
  });

  it("anchors the completion divider to latestTurn.assistantMessageId before timestamp fallback", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("assistant-earlier"),
          role: "assistant",
          text: "progress update",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant-final"),
          role: "assistant",
          text: "final answer",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [],
      [],
      [],
    );

    expect(
      deriveCompletionDividerBeforeEntryId(entries, {
        assistantMessageId: MessageId.makeUnsafe("assistant-final"),
        startedAt: "2026-02-23T00:00:00.000Z",
        completedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe("assistant-final");
  });
});

describe("deriveVisibleTimelineMessages", () => {
  it("keeps only the latest assistant message for completed turns with commentary-style updates", () => {
    const messages = deriveVisibleTimelineMessages(
      [
        {
          id: MessageId.makeUnsafe("user-1"),
          role: "user",
          text: "ship it",
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-23T00:00:00.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant-commentary"),
          role: "assistant",
          text: "working on it",
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant-final"),
          role: "assistant",
          text: "done",
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-23T00:00:02.000Z",
          streaming: false,
        },
      ],
      {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      },
    );

    expect(messages.map((message) => message.id)).toEqual(["user-1", "assistant-final"]);
  });

  it("keeps completed assistant commentary rows when explicitly preserving them", () => {
    const messages = deriveVisibleTimelineMessages(
      [
        {
          id: MessageId.makeUnsafe("user-1"),
          role: "user",
          text: "ship it",
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-23T00:00:00.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant-commentary"),
          role: "assistant",
          text: "working on it",
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant-final"),
          role: "assistant",
          text: "done",
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-23T00:00:02.000Z",
          streaming: false,
        },
      ],
      {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      },
      { preserveCompletedAssistantMessages: true },
    );

    expect(messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-commentary",
      "assistant-final",
    ]);
  });

  it("keeps completed assistant commentary rows for the currently running turn", () => {
    const messages = deriveVisibleTimelineMessages(
      [
        {
          id: MessageId.makeUnsafe("assistant-commentary-1"),
          role: "assistant",
          text: "checking auth",
          turnId: TurnId.makeUnsafe("turn-live"),
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant-commentary-2"),
          role: "assistant",
          text: "checking billing",
          turnId: TurnId.makeUnsafe("turn-live"),
          createdAt: "2026-02-23T00:00:02.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant-final-streaming"),
          role: "assistant",
          text: "draft",
          turnId: TurnId.makeUnsafe("turn-live"),
          createdAt: "2026-02-23T00:00:03.000Z",
          streaming: true,
        },
      ],
      {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-live"),
      },
    );

    expect(messages.map((message) => message.id)).toEqual([
      "assistant-commentary-1",
      "assistant-commentary-2",
      "assistant-final-streaming",
    ]);
  });
});

describe("deriveReasoningEntries", () => {
  it("groups reasoning lifecycle activities into a single streaming entry", () => {
    const entries = deriveReasoningEntries([
      makeActivity({
        id: "reasoning-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "reasoning.started",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-1",
        payload: { itemId: "reasoning-item-1" },
      }),
      makeActivity({
        id: "reasoning-delta-1",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "reasoning.delta",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-1",
        payload: { itemId: "reasoning-item-1", delta: "Trace " },
      }),
      makeActivity({
        id: "reasoning-delta-2",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "reasoning.delta",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-1",
        payload: { itemId: "reasoning-item-1", delta: "state" },
      }),
      makeActivity({
        id: "reasoning-completed",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "reasoning.completed",
        summary: "Thought",
        tone: "info",
        turnId: "turn-1",
        payload: { itemId: "reasoning-item-1" },
      }),
    ]);

    expect(entries).toEqual([
      {
        id: "reasoning:reasoning-item-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        completedAt: "2026-02-23T00:00:04.000Z",
        text: "Trace state",
        streaming: false,
        turnId: TurnId.makeUnsafe("turn-1"),
      },
    ]);
  });

  it("separates indexed reasoning summary blocks inside one reasoning entry", () => {
    const entries = deriveReasoningEntries([
      makeActivity({
        id: "reasoning-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "reasoning.started",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-summary",
        payload: { itemId: "reasoning-item-summary" },
      }),
      makeActivity({
        id: "reasoning-summary-0",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "reasoning.delta",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-summary",
        payload: {
          itemId: "reasoning-item-summary",
          delta: "Inspecting padding changes\n\nFirst block.",
          summaryIndex: 0,
        },
      }),
      makeActivity({
        id: "reasoning-summary-1",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "reasoning.delta",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-summary",
        payload: {
          itemId: "reasoning-item-summary",
          delta: "Adjusting left-padding for workgroups\n\nSecond block.",
          summaryIndex: 1,
        },
      }),
      makeActivity({
        id: "reasoning-completed",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "reasoning.completed",
        summary: "Thought",
        tone: "info",
        turnId: "turn-summary",
        payload: { itemId: "reasoning-item-summary" },
      }),
    ]);

    expect(entries).toEqual([
      {
        id: "reasoning:reasoning-item-summary",
        createdAt: "2026-02-23T00:00:01.000Z",
        completedAt: "2026-02-23T00:00:04.000Z",
        text: "Inspecting padding changes\n\nFirst block.\n\nAdjusting left-padding for workgroups\n\nSecond block.",
        streaming: false,
        turnId: TurnId.makeUnsafe("turn-summary"),
      },
    ]);
  });

  it("synthesizes reasoning entries from reasoning progress summaries", () => {
    const entries = deriveReasoningEntries([
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.progress",
        summary: "Reasoning update",
        tone: "info",
        turnId: "turn-2",
        payload: {
          taskId: "turn-2",
          detail: "Comparing both transports before editing.",
          displayAs: "reasoning",
        },
      }),
      makeActivity({
        id: "task-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
        turnId: "turn-2",
        payload: {
          taskId: "turn-2",
          status: "completed",
        },
      }),
    ]);

    expect(entries).toEqual([
      {
        id: "reasoning-task:turn-2",
        createdAt: "2026-02-23T00:00:01.000Z",
        completedAt: "2026-02-23T00:00:02.000Z",
        text: "Comparing both transports before editing.",
        streaming: false,
        turnId: TurnId.makeUnsafe("turn-2"),
      },
    ]);
  });

  it("keeps backward compatibility for persisted reasoning progress summaries", () => {
    const entries = deriveReasoningEntries([
      makeActivity({
        id: "task-progress-legacy",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.progress",
        summary: "Reasoning update",
        tone: "info",
        turnId: "turn-legacy",
        payload: {
          taskId: "turn-legacy",
          detail: "Compare persisted snapshots.",
        },
      }),
    ]);

    expect(entries).toEqual([
      {
        id: "reasoning-task:turn-legacy",
        createdAt: "2026-02-23T00:00:01.000Z",
        text: "Compare persisted snapshots.",
        streaming: true,
        turnId: TurnId.makeUnsafe("turn-legacy"),
      },
    ]);
  });

  it("does not treat legacy Claude task progress summaries as reasoning blocks", () => {
    const entries = deriveReasoningEntries([
      makeActivity({
        id: "task-progress-legacy-claude",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.progress",
        summary: "Reasoning update",
        tone: "info",
        turnId: "turn-legacy-claude",
        payload: {
          taskId: "task-subagent-1",
          detail: "Running List React component files in apps/web/src",
        },
      }),
    ]);

    expect(entries).toEqual([]);
  });

  it("appends multiple reasoning progress summaries into one persisted block", () => {
    const entries = deriveReasoningEntries([
      makeActivity({
        id: "task-progress-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.progress",
        summary: "Reasoning update",
        tone: "info",
        turnId: "turn-2",
        payload: {
          taskId: "turn-2",
          detail: "Compare auth flow.",
        },
      }),
      makeActivity({
        id: "task-progress-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Reasoning update",
        tone: "info",
        turnId: "turn-2",
        payload: {
          taskId: "turn-2",
          detail: "Check entitlement API.",
        },
      }),
    ]);

    expect(entries).toEqual([
      {
        id: "reasoning-task:turn-2",
        createdAt: "2026-02-23T00:00:01.000Z",
        text: "Compare auth flow.\n\nCheck entitlement API.",
        streaming: true,
        turnId: TurnId.makeUnsafe("turn-2"),
      },
    ]);
  });

  it("does not leave an empty reasoning block behind when only commentary survives", () => {
    const entries = deriveReasoningEntries([
      makeActivity({
        id: "reasoning-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "reasoning.started",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-4",
        payload: { itemId: "reasoning-item-4" },
      }),
      makeActivity({
        id: "assistant-commentary",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "assistant.commentary",
        summary: "Status update",
        tone: "info",
        turnId: "turn-4",
        payload: { detail: "Checking auth state first." },
      }),
      makeActivity({
        id: "reasoning-completed",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "reasoning.completed",
        summary: "Thought",
        tone: "info",
        turnId: "turn-4",
        payload: { itemId: "reasoning-item-4" },
      }),
    ]);

    expect(entries).toEqual([]);
  });

  it("suppresses completed reasoning entries when no visible reasoning text survived", () => {
    const entries = deriveReasoningEntries([
      makeActivity({
        id: "reasoning-started-empty",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "reasoning.started",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-2",
        payload: { itemId: "reasoning-item-empty" },
      }),
      makeActivity({
        id: "reasoning-completed-empty",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "reasoning.completed",
        summary: "Thought",
        tone: "info",
        turnId: "turn-2",
        payload: { itemId: "reasoning-item-empty" },
      }),
    ]);

    expect(entries).toEqual([]);
  });

  it("suppresses in-progress reasoning entries until visible reasoning text arrives", () => {
    const entries = deriveReasoningEntries([
      makeActivity({
        id: "reasoning-started-streaming-empty",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "reasoning.started",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-streaming-empty",
        payload: { itemId: "reasoning-item-streaming-empty" },
      }),
    ]);

    expect(entries).toEqual([]);
  });

  it("suppresses empty Shiori reasoning lifecycle entries when no visible reasoning text arrived", () => {
    const entries = deriveReasoningEntries([
      makeActivity({
        id: "reasoning-started-shiori-empty",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "reasoning.started",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-shiori-empty",
        payload: { itemId: "reasoning:turn-shiori-empty:block-1" },
      }),
      makeActivity({
        id: "reasoning-completed-shiori-empty",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "reasoning.completed",
        summary: "Thought",
        tone: "info",
        turnId: "turn-shiori-empty",
        payload: { itemId: "reasoning:turn-shiori-empty:block-1" },
      }),
    ]);

    expect(entries).toEqual([]);
  });

  it("ignores unrelated task completion events when no reasoning progress exists", () => {
    const entries = deriveReasoningEntries([
      makeActivity({
        id: "task-complete-only",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
        turnId: "turn-plain-task",
        payload: {
          taskId: "turn-plain-task",
          status: "completed",
        },
      }),
    ]);

    expect(entries).toEqual([]);
  });

  it("treats reasoning deltas without item ids as separate entries instead of turn-level buckets", () => {
    const entries = deriveReasoningEntries([
      makeActivity({
        id: "reasoning-delta-a",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "reasoning.delta",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-3",
        payload: { delta: "Compare " },
      }),
      makeActivity({
        id: "reasoning-delta-b",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "reasoning.delta",
        summary: "Thinking",
        tone: "info",
        turnId: "turn-3",
        payload: { delta: "providers" },
      }),
      makeActivity({
        id: "turn-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "turn.completed",
        summary: "Turn completed",
        tone: "info",
        turnId: "turn-3",
      }),
    ]);

    expect(entries).toEqual([
      {
        id: "reasoning:reasoning-delta-a",
        createdAt: "2026-02-23T00:00:01.000Z",
        text: "Compare ",
        streaming: true,
        turnId: TurnId.makeUnsafe("turn-3"),
      },
      {
        id: "reasoning:reasoning-delta-b",
        createdAt: "2026-02-23T00:00:02.000Z",
        text: "providers",
        streaming: true,
        turnId: TurnId.makeUnsafe("turn-3"),
      },
    ]);
  });
});

describe("deriveWorkLogEntries context window handling", () => {
  it("excludes context window updates from the work log", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "context-1",
          turnId: "turn-1",
          kind: "context-window.updated",
          summary: "Context window updated",
          tone: "info",
        }),
        makeActivity({
          id: "tool-1",
          turnId: "turn-1",
          kind: "tool.completed",
          summary: "Ran command",
          tone: "tool",
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Ran command");
  });

  it("keeps context compaction activities as normal work log entries", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "compaction-1",
          turnId: "turn-1",
          kind: "context-compaction",
          summary: "Context compacted",
          tone: "info",
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Context compacted");
  });
});

describe("hasToolActivityForTurn", () => {
  it("returns false when turn id is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
    ];

    expect(hasToolActivityForTurn(activities, undefined)).toBe(false);
    expect(hasToolActivityForTurn(activities, null)).toBe(false);
  });

  it("returns true only for matching tool activity in the target turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
      makeActivity({ id: "info-1", turnId: "turn-2", kind: "turn.completed", tone: "info" }),
    ];

    expect(hasToolActivityForTurn(activities, TurnId.makeUnsafe("turn-1"))).toBe(true);
    expect(hasToolActivityForTurn(activities, TurnId.makeUnsafe("turn-2"))).toBe(false);
  });
});

describe("isLatestTurnSettled", () => {
  const latestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("returns false while the same turn is still active in a running session", () => {
    expect(
      isLatestTurnSettled(
        {
          ...latestTurn,
          completedAt: null,
        },
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
        },
      ),
    ).toBe(false);
  });

  it("returns false when the active turn id still points at the same turn", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-1"),
      }),
    ).toBe(false);
  });

  it("returns false while a different turn is still running", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-2"),
      }),
    ).toBe(false);
  });

  it("returns true once the session is no longer running that turn", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      }),
    ).toBe(true);
  });

  it("returns false when turn timestamps are incomplete", () => {
    expect(
      isLatestTurnSettled(
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          startedAt: null,
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
      ),
    ).toBe(false);
  });
});

describe("isSessionActivelyRunningTurn", () => {
  const completedTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("returns true when the current turn has not completed yet", () => {
    expect(
      isSessionActivelyRunningTurn(
        {
          ...completedTurn,
          completedAt: null,
        },
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
        },
      ),
    ).toBe(true);
  });

  it("returns true when the active turn id still points at the same turn", () => {
    expect(
      isSessionActivelyRunningTurn(completedTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-1"),
      }),
    ).toBe(true);
  });

  it("returns true when a different turn is still active", () => {
    expect(
      isSessionActivelyRunningTurn(completedTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-2"),
      }),
    ).toBe(true);
  });

  it("returns false when the session is not running", () => {
    expect(
      isSessionActivelyRunningTurn(completedTurn, {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      }),
    ).toBe(false);
  });
});

describe("deriveActiveWorkStartedAt", () => {
  const latestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("prefers the in-flight turn start when the latest turn is not settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          ...latestTurn,
          completedAt: null,
        },
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:10:00.000Z");
  });

  it("keeps the active turn start when the session still points at that turn", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:10:00.000Z");
  });

  it("falls back to sendStartedAt once the latest turn is settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "ready",
          activeTurnId: undefined,
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("uses sendStartedAt for a fresh send after the prior turn completed", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          startedAt: "2026-02-27T21:10:00.000Z",
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });
});

describe("PROVIDER_OPTIONS", () => {
  it("advertises Claude as available while keeping Cursor as a placeholder", () => {
    const kimi = PROVIDER_OPTIONS.find((option) => option.value === "kimiCode");
    const claude = PROVIDER_OPTIONS.find((option) => option.value === "claudeAgent");
    const cursor = PROVIDER_OPTIONS.find((option) => option.value === "cursor");
    expect(PROVIDER_OPTIONS).toEqual([
      { value: "shiori", label: "Shiori", available: true },
      { value: "kimiCode", label: "Kimi", available: true },
      { value: "codex", label: "Codex", available: true },
      { value: "claudeAgent", label: "Claude", available: true },
      { value: "cursor", label: "Cursor", available: false },
    ]);
    expect(kimi).toEqual({
      value: "kimiCode",
      label: "Kimi",
      available: true,
    });
    expect(claude).toEqual({
      value: "claudeAgent",
      label: "Claude",
      available: true,
    });
    expect(cursor).toEqual({
      value: "cursor",
      label: "Cursor",
      available: false,
    });
  });
});
