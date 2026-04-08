import { describe, expect, it } from "vitest";

import {
  completeOnboardingStep,
  getNextOnboardingStepId,
  normalizeOnboardingProgress,
  resetOnboardingProgress,
  resolveOnboardingState,
} from "./onboarding";

describe("onboarding helpers", () => {
  it("normalizes completion order and removes duplicates", () => {
    expect(
      normalizeOnboardingProgress({
        version: 1,
        dismissed: false,
        completedStepIds: ["start-first-thread", "sign-in", "sign-in"],
      }),
    ).toEqual({
      version: 1,
      dismissed: false,
      completedStepIds: ["sign-in", "start-first-thread"],
    });
  });

  it("resolves the next incomplete step", () => {
    expect(getNextOnboardingStepId(resetOnboardingProgress())).toBe("sign-in");
    expect(
      getNextOnboardingStepId({
        version: 1,
        dismissed: false,
        completedStepIds: ["sign-in", "connect-provider"],
      }),
    ).toBe("start-first-thread");
  });

  it("enforces sequential completion", () => {
    const progress = resetOnboardingProgress();
    const rejected = completeOnboardingStep(progress, "start-first-thread");
    expect(rejected.accepted).toBe(false);
    expect(rejected.expectedStepId).toBe("sign-in");

    const first = completeOnboardingStep(progress, "sign-in");
    expect(first.accepted).toBe(true);
    expect(first.changed).toBe(true);
    expect(first.progress.completedStepIds).toEqual(["sign-in"]);
  });

  it("derives a complete state with placeholder metadata", () => {
    const state = resolveOnboardingState({
      version: 1,
      dismissed: false,
      completedStepIds: ["sign-in", "connect-provider", "start-first-thread"],
    });

    expect(state.completed).toBe(true);
    expect(state.currentStepId).toBeNull();
    expect(state.totalSteps).toBe(3);
    expect(state.steps.map((step) => step.title)).toEqual([
      "Sign in",
      "Connect a provider",
      "Start your first thread",
    ]);
  });
});
