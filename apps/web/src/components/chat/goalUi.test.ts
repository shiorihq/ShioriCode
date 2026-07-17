import { THREAD_GOAL_OBJECTIVE_MAX_SCALARS, type ThreadGoal } from "contracts";
import { describe, expect, it } from "vitest";

import {
  formatGoalElapsedSeconds,
  formatGoalTokenCount,
  goalTokenProgressPercent,
  mutationErrorMessage,
  resolveGoalEditSubmission,
} from "./goalUi";

const makeGoal = (overrides: Partial<ThreadGoal> = {}): ThreadGoal =>
  ({
    threadId: "thread-goal-ui",
    objective: "Ship the goal workflow",
    status: "active",
    tokenBudget: 50_000,
    tokensUsed: 12_500,
    timeUsedSeconds: 5_400,
    createdAt: "2026-07-16T08:00:00.000Z",
    updatedAt: "2026-07-16T09:30:00.000Z",
    ...overrides,
  }) as ThreadGoal;

describe("goal UI formatting", () => {
  it.each([
    [0, "0s"],
    [59, "59s"],
    [60, "1m"],
    [30 * 60, "30m"],
    [90 * 60, "1h 30m"],
    [2 * 60 * 60, "2h"],
    [24 * 60 * 60, "1d 0h 0m"],
  ])("formats %i elapsed seconds as %s", (seconds, expected) => {
    expect(formatGoalElapsedSeconds(seconds)).toBe(expected);
  });

  it.each([
    [0, "0"],
    [999, "999"],
    [1_000, "1K"],
    [9_500, "9.5K"],
    [50_000, "50K"],
    [63_876, "63.9K"],
    [1_000_000, "1M"],
  ])("formats %i tokens as %s", (tokens, expected) => {
    expect(formatGoalTokenCount(tokens)).toBe(expected);
  });

  it("clamps visual token progress while preserving unbudgeted goals", () => {
    expect(goalTokenProgressPercent(makeGoal())).toBe(25);
    expect(goalTokenProgressPercent(makeGoal({ tokensUsed: 63_876 }))).toBe(100);
    expect(goalTokenProgressPercent(makeGoal({ tokenBudget: null }))).toBeNull();
  });
});

describe("resolveGoalEditSubmission", () => {
  it("returns only changed editable fields and preserves lifecycle facts", () => {
    const goal = makeGoal({ status: "paused" });

    expect(
      resolveGoalEditSubmission({
        goal,
        mode: "edit",
        objective: "  Ship the polished goal workflow  ",
        tokenBudgetInput: "75000",
      }),
    ).toEqual({
      ok: true,
      patch: {
        objective: "Ship the polished goal workflow",
        tokenBudget: 75_000,
      },
    });
  });

  it("allows an optional budget to be cleared without resetting progress", () => {
    expect(
      resolveGoalEditSubmission({
        goal: makeGoal(),
        mode: "edit",
        objective: "Ship the goal workflow",
        tokenBudgetInput: "",
      }),
    ).toEqual({ ok: true, patch: { tokenBudget: null } });
  });

  it("reactivates a completed goal when it is edited", () => {
    expect(
      resolveGoalEditSubmission({
        goal: makeGoal({ status: "complete" }),
        mode: "edit",
        objective: "Ship the goal workflow",
        tokenBudgetInput: "50000",
      }),
    ).toEqual({ ok: true, patch: { status: "active" } });
  });

  it.each(["0", "-1", "1.5", "12k", "9007199254740992"])(
    "rejects invalid token budget %s",
    (tokenBudgetInput) => {
      const result = resolveGoalEditSubmission({
        goal: makeGoal(),
        mode: "edit",
        objective: "Ship the goal workflow",
        tokenBudgetInput,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("positive whole number");
      }
    },
  );

  it("requires an exhausted budget to be cleared or increased before resuming", () => {
    const goal = makeGoal({
      status: "budgetLimited",
      tokenBudget: 50_000,
      tokensUsed: 63_876,
    });

    for (const tokenBudgetInput of ["50000", "63876"]) {
      const result = resolveGoalEditSubmission({
        goal,
        mode: "resumeBudget",
        objective: goal.objective,
        tokenBudgetInput,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("above 63.9K tokens");
      }
    }

    expect(
      resolveGoalEditSubmission({
        goal,
        mode: "resumeBudget",
        objective: goal.objective,
        tokenBudgetInput: "70000",
      }),
    ).toEqual({
      ok: true,
      patch: { tokenBudget: 70_000, status: "active" },
    });
    expect(
      resolveGoalEditSubmission({
        goal,
        mode: "resumeBudget",
        objective: goal.objective,
        tokenBudgetInput: "",
      }),
    ).toEqual({
      ok: true,
      patch: { tokenBudget: null, status: "active" },
    });
  });

  it("counts Unicode scalars and rejects invalid Unicode text", () => {
    const emojiObjective = "🛠".repeat(THREAD_GOAL_OBJECTIVE_MAX_SCALARS);
    expect(
      resolveGoalEditSubmission({
        goal: makeGoal(),
        mode: "edit",
        objective: emojiObjective,
        tokenBudgetInput: "50000",
      }).ok,
    ).toBe(true);

    expect(
      resolveGoalEditSubmission({
        goal: makeGoal(),
        mode: "edit",
        objective: `${emojiObjective}🛠`,
        tokenBudgetInput: "50000",
      }).ok,
    ).toBe(false);
    expect(
      resolveGoalEditSubmission({
        goal: makeGoal(),
        mode: "edit",
        objective: "invalid \ud800 objective",
        tokenBudgetInput: "50000",
      }).ok,
    ).toBe(false);
  });

  it("keeps the useful mutation error message when one is available", () => {
    expect(mutationErrorMessage(new Error("Could not save the update"), "Fallback")).toBe(
      "Could not save the update",
    );
    expect(mutationErrorMessage("unknown", "Fallback")).toBe("Fallback");
  });
});
