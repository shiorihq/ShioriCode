import type { KanbanItemId, ProjectId, ThreadId } from "contracts";
import { describe, expect, it } from "vitest";

import type { Thread } from "~/types";

import { deriveGoalStatus, type Goal } from "./goalShared";

const baseGoal = {
  id: "goal-1" as KanbanItemId,
  projectId: "project-1" as ProjectId,
  pullRequest: null,
  title: "Add resumable streaming",
  description: "",
  prompt: "",
  generatedPrompt: null,
  promptStatus: "idle",
  promptError: null,
  status: "backlog",
  sortKey: "001",
  blockedReason: null,
  assignees: [],
  notes: [],
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
  completedAt: null,
  deletedAt: null,
} satisfies Goal;

function goal(overrides: Partial<Goal>): Goal {
  return { ...baseGoal, ...overrides };
}

function thread(overrides: Partial<Thread>): Thread {
  return {
    id: "thread-1" as ThreadId,
    codexThreadId: null,
    projectId: "project-1" as ProjectId,
    projectlessCwd: null,
    title: "Run goal",
    modelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    session: null,
    resumeState: "resumed",
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    updatedAt: "2026-05-01T00:00:00.000Z",
    latestTurn: null,
    pendingSourceProposedPlan: undefined,
    parentThreadId: null,
    branchSourceTurnId: null,
    branch: null,
    worktreePath: null,
    tag: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("deriveGoalStatus", () => {
  it("treats goals without a plan as drafts", () => {
    expect(deriveGoalStatus(goal({}), [])).toBe("draft");
  });

  it("treats goals with plan bullets as ready", () => {
    expect(deriveGoalStatus(goal({ prompt: "- Inspect\n- Implement" }), [])).toBe("ready");
  });

  it("uses an active linked thread as running", () => {
    const activeThread = thread({
      session: {
        provider: "codex",
        status: "running",
        orchestrationStatus: "running",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
    });
    const activeGoal = goal({
      prompt: "- Inspect",
      assignees: [
        {
          id: "assignee-1" as never,
          provider: "codex",
          model: "gpt-5.4-mini",
          role: "owner",
          status: "assigned",
          threadId: activeThread.id,
          assignedAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
      ],
    });

    expect(deriveGoalStatus(activeGoal, [activeThread])).toBe("running");
  });

  it("prefers completed when the goal has been marked done", () => {
    expect(
      deriveGoalStatus(goal({ status: "done", completedAt: "2026-05-01T00:00:00.000Z" }), []),
    ).toBe("completed");
  });
});
