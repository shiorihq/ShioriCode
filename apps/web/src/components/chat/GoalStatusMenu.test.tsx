import type { ThreadGoal } from "contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { GoalProgressSummary, GoalStatusMenu } from "./GoalStatusMenu";

const makeGoal = (overrides: Partial<ThreadGoal> = {}): ThreadGoal =>
  ({
    threadId: "thread-goal-menu",
    objective: "Finish the resilient goal workflow",
    status: "budgetLimited",
    tokenBudget: 50_000,
    tokensUsed: 63_876,
    timeUsedSeconds: 5_400,
    createdAt: "2026-07-16T08:00:00.000Z",
    updatedAt: "2026-07-16T09:30:00.000Z",
    ...overrides,
  }) as ThreadGoal;

describe("GoalStatusMenu", () => {
  it("renders compact elapsed and over-budget progress accessibly", () => {
    const markup = renderToStaticMarkup(
      <GoalStatusMenu goal={makeGoal()} onUpdateGoal={vi.fn()} onClearGoal={vi.fn()} />,
    );

    expect(markup).toContain("Goal Budget limited. Time 1h 30m. 63.9K/50K tokens.");
    expect(markup).toContain("63.9K/50K");
  });

  it("clamps the visual bar but exposes the true over-budget usage", () => {
    const markup = renderToStaticMarkup(<GoalProgressSummary goal={makeGoal()} />);

    expect(markup).toContain("Time 1h 30m");
    expect(markup).toContain("63.9K/50K tokens");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="50000"');
    expect(markup).toContain('style="width:100%"');
    expect(markup).toContain("63876 of 50000 tokens used");
  });

  it("reports token usage without rendering a budget bar for an unbudgeted goal", () => {
    const markup = renderToStaticMarkup(
      <GoalProgressSummary goal={makeGoal({ tokenBudget: null, tokensUsed: 12_500 })} />,
    );

    expect(markup).toContain("12.5K tokens used");
    expect(markup).not.toContain('role="progressbar"');
  });
});
