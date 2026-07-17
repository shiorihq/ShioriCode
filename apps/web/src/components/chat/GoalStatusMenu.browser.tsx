import "../../index.css";

import type { ThreadGoal } from "contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { GoalStatusMenu } from "./GoalStatusMenu";
import type { GoalUpdatePatch } from "./goalUi";

const makeGoal = (overrides: Partial<ThreadGoal> = {}): ThreadGoal =>
  ({
    threadId: "thread-goal-menu-browser",
    objective: "Finish the resilient goal workflow",
    status: "budgetLimited",
    tokenBudget: 50_000,
    tokensUsed: 63_876,
    timeUsedSeconds: 5_400,
    createdAt: "2026-07-16T08:00:00.000Z",
    updatedAt: "2026-07-16T09:30:00.000Z",
    ...overrides,
  }) as ThreadGoal;

async function mountGoalMenu(options?: {
  goal?: ThreadGoal;
  onUpdateGoal?: (patch: GoalUpdatePatch) => Promise<void>;
  onClearGoal?: () => Promise<void>;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const onUpdateGoal = options?.onUpdateGoal ?? vi.fn(async () => undefined);
  const onClearGoal = options?.onClearGoal ?? vi.fn(async () => undefined);
  const screen = await render(
    <GoalStatusMenu
      goal={options?.goal ?? makeGoal()}
      onUpdateGoal={onUpdateGoal}
      onClearGoal={onClearGoal}
    />,
    { container: host },
  );

  return {
    onUpdateGoal,
    onClearGoal,
    rerenderGoal: async (goal: ThreadGoal) => {
      await screen.rerender(
        <GoalStatusMenu goal={goal} onUpdateGoal={onUpdateGoal} onClearGoal={onClearGoal} />,
      );
    },
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
    [Symbol.asyncDispose]: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("GoalStatusMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows objective, elapsed time, token progress, and useful limited-state actions", async () => {
    await using _ = await mountGoalMenu();

    await page
      .getByRole("button", {
        name: "Goal Budget limited. Time 1h 30m. 63.9K/50K tokens.",
      })
      .click();

    await expect.element(page.getByText("Finish the resilient goal workflow")).toBeVisible();
    await expect.element(page.getByText("Time 1h 30m")).toBeVisible();
    await expect.element(page.getByText("63.9K/50K tokens")).toBeVisible();
    await expect.element(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50000");
    await expect.element(page.getByRole("menuitem", { name: "Edit goal" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Mark complete" })).toBeVisible();
    await expect
      .element(page.getByRole("menuitem", { name: "Resume goal" }))
      .not.toBeInTheDocument();
  });

  it("requires a cleared or increased exhausted budget and exposes save pending state", async () => {
    let resolveUpdate: (() => void) | undefined;
    const onUpdateGoal = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    await using _ = await mountGoalMenu({ onUpdateGoal });

    await page.getByRole("button", { name: /Goal Budget limited/ }).click();
    await page.getByRole("menuitem", { name: "Edit goal" }).click();

    const budgetInput = page.getByLabelText("Token budget (optional)");
    await budgetInput.fill("63876");
    await page.getByRole("button", { name: "Save and resume" }).click();

    await expect.element(page.getByRole("alert")).toHaveTextContent("above 63.9K tokens");
    expect(onUpdateGoal).not.toHaveBeenCalled();

    await budgetInput.fill("70000");
    await page.getByRole("button", { name: "Save and resume" }).click();

    await vi.waitFor(() => {
      expect(onUpdateGoal).toHaveBeenCalledWith({ tokenBudget: 70_000, status: "active" });
    });
    await expect.element(page.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    await expect.element(page.getByRole("button", { name: "Save and resume" })).toBeDisabled();

    resolveUpdate?.();
    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").not.toContain("Adjust budget and resume");
    });
  });

  it("reactivates a completed goal when its editor is submitted", async () => {
    const onUpdateGoal = vi.fn(async () => undefined);
    await using _ = await mountGoalMenu({
      goal: makeGoal({ status: "complete", tokenBudget: null }),
      onUpdateGoal,
    });

    await page.getByRole("button", { name: /Goal Complete/ }).click();
    await page.getByRole("menuitem", { name: "Edit goal" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();

    await vi.waitFor(() => {
      expect(onUpdateGoal).toHaveBeenCalledWith({ status: "active" });
    });
  });

  it("surfaces manual completion failures for Shiori goals", async () => {
    const onUpdateGoal = vi.fn(async () => {
      throw new Error("Could not finalize the goal");
    });
    await using _ = await mountGoalMenu({ onUpdateGoal });

    await page.getByRole("button", { name: /Goal Budget limited/ }).click();
    await page.getByRole("menuitem", { name: "Mark complete" }).click();

    await expect.element(page.getByRole("alert")).toHaveTextContent("Could not finalize");
    expect(onUpdateGoal).toHaveBeenCalledWith({ status: "complete" });
  });

  it("keeps the edit dialog open and shows mutation failures without lifecycle fields", async () => {
    const onUpdateGoal = vi.fn(async () => {
      throw new Error("Could not save the goal update");
    });
    await using _ = await mountGoalMenu({
      goal: makeGoal({ status: "paused" }),
      onUpdateGoal,
    });

    await page.getByRole("button", { name: /Goal Paused/ }).click();
    await page.getByRole("menuitem", { name: "Edit goal" }).click();
    await page.getByLabelText("Objective").fill("Ship a polished goal workflow");
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect.element(page.getByRole("alert")).toHaveTextContent("Could not save");
    await expect.element(page.getByRole("dialog")).toBeVisible();
    expect(onUpdateGoal).toHaveBeenCalledWith({ objective: "Ship a polished goal workflow" });
  });

  it("closes stale editor state only when the goal lifecycle changes", async () => {
    const onUpdateGoal = vi.fn(async () => undefined);
    const mounted = await mountGoalMenu({
      goal: makeGoal({
        lifecycleId: "goal-old",
        status: "paused",
        objective: "Old objective",
        tokenBudget: 1_000,
      }),
      onUpdateGoal,
    });
    await using _ = mounted;

    await page.getByRole("button", { name: /Goal Paused/ }).click();
    await page.getByRole("menuitem", { name: "Edit goal" }).click();
    await page.getByLabelText("Objective").fill("");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Enter a goal objective");

    await mounted.rerenderGoal(
      makeGoal({
        lifecycleId: "goal-old",
        status: "paused",
        objective: "Old objective",
        tokenBudget: 1_000,
        tokensUsed: 500,
        updatedAt: "2026-07-16T09:45:00.000Z",
      }),
    );
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect.element(page.getByLabelText("Objective")).toHaveValue("");

    await mounted.rerenderGoal(
      makeGoal({
        lifecycleId: "goal-new",
        status: "paused",
        objective: "Replacement objective",
        tokenBudget: 2_000,
        createdAt: "2026-07-16T10:00:00.000Z",
        updatedAt: "2026-07-16T10:00:00.000Z",
      }),
    );

    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    expect(onUpdateGoal).not.toHaveBeenCalled();

    await page.getByRole("button", { name: /Goal Paused/ }).click();
    await page.getByRole("menuitem", { name: "Edit goal" }).click();
    await expect.element(page.getByLabelText("Objective")).toHaveValue("Replacement objective");
    await expect.element(page.getByLabelText("Token budget (optional)")).toHaveValue(2_000);
  });

  it("closes a non-terminal editor when the same lifecycle completes", async () => {
    const onUpdateGoal = vi.fn(async () => undefined);
    const mounted = await mountGoalMenu({
      goal: makeGoal({
        lifecycleId: "goal-completes-while-editing",
        status: "active",
        objective: "Finish before the provider reports completion",
        tokenBudget: 2_000,
      }),
      onUpdateGoal,
    });
    await using _ = mounted;

    await page.getByRole("button", { name: /Goal Active/ }).click();
    await page.getByRole("menuitem", { name: "Edit goal" }).click();
    await page.getByLabelText("Objective").fill("A stale objective draft");

    await mounted.rerenderGoal(
      makeGoal({
        lifecycleId: "goal-completes-while-editing",
        status: "complete",
        objective: "Finish before the provider reports completion",
        tokenBudget: 2_000,
        updatedAt: "2026-07-16T09:45:00.000Z",
      }),
    );

    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(onUpdateGoal).not.toHaveBeenCalled();

    await page.getByRole("button", { name: /Goal Complete/ }).click();
    await page.getByRole("menuitem", { name: "Edit goal" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();

    await vi.waitFor(() => {
      expect(onUpdateGoal).toHaveBeenCalledWith({ status: "active" });
    });
  });

  it("closes a stale clear confirmation when a legacy goal lifecycle changes", async () => {
    const onClearGoal = vi.fn(async () => undefined);
    const mounted = await mountGoalMenu({
      goal: makeGoal({ status: "paused" }),
      onClearGoal,
    });
    await using _ = mounted;

    await page.getByRole("button", { name: /Goal Paused/ }).click();
    await page.getByRole("menuitem", { name: /Clear goal/ }).click();
    await expect.element(page.getByRole("alertdialog")).toBeVisible();

    await mounted.rerenderGoal(
      makeGoal({
        status: "active",
        objective: "Replacement legacy goal",
        createdAt: "2026-07-16T10:00:00.000Z",
        updatedAt: "2026-07-16T10:00:00.000Z",
      }),
    );

    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    expect(onClearGoal).not.toHaveBeenCalled();
  });

  it("requires confirmation before clearing and reports clear failures", async () => {
    const onClearGoal = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Could not save the goal clear"))
      .mockResolvedValue(undefined);
    await using _ = await mountGoalMenu({ onClearGoal });

    await page.getByRole("button", { name: /Goal Budget limited/ }).click();
    await page.getByRole("menuitem", { name: /Clear goal/ }).click();

    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    expect(onClearGoal).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Keep goal" }).click();
    expect(onClearGoal).not.toHaveBeenCalled();

    await page.getByRole("button", { name: /Goal Budget limited/ }).click();
    await page.getByRole("menuitem", { name: /Clear goal/ }).click();
    await page.getByRole("button", { name: "Clear goal" }).click();

    await expect.element(page.getByRole("alert")).toHaveTextContent("Could not save");
    await expect.element(page.getByRole("alertdialog")).toBeVisible();

    await page.getByRole("button", { name: "Clear goal" }).click();
    await vi.waitFor(() => {
      expect(onClearGoal).toHaveBeenCalledTimes(2);
      expect(document.body.textContent ?? "").not.toContain("Clear goal?");
    });
  });
});
