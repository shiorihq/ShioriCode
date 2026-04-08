import {
  DEFAULT_ONBOARDING_PROGRESS,
  ONBOARDING_STEP_IDS,
  type OnboardingProgress,
  type OnboardingState,
  type OnboardingStepId,
} from "contracts";

type OnboardingStepDefinition = {
  readonly id: OnboardingStepId;
  readonly title: string;
  readonly description: string;
};

export const ONBOARDING_STEP_DEFINITIONS: readonly OnboardingStepDefinition[] = [
  {
    id: "sign-in",
    title: "Sign in",
    description: "Authenticate with your Shiori account.",
  },
  {
    id: "connect-provider",
    title: "Connect a provider",
    description: "Connect at least one coding agent — Codex, Claude, or Shiori.",
  },
  {
    id: "start-first-thread",
    title: "Start your first thread",
    description: "Create your first conversation and begin coding.",
  },
] as const;

export function normalizeOnboardingProgress(progress: OnboardingProgress): OnboardingProgress {
  const completed = new Set(progress.completedStepIds);
  return {
    version: DEFAULT_ONBOARDING_PROGRESS.version,
    dismissed: progress.dismissed,
    completedStepIds: ONBOARDING_STEP_IDS.filter((stepId) => completed.has(stepId)),
  };
}

export function getNextOnboardingStepId(progress: OnboardingProgress): OnboardingStepId | null {
  const completed = new Set(normalizeOnboardingProgress(progress).completedStepIds);
  return ONBOARDING_STEP_IDS.find((stepId) => !completed.has(stepId)) ?? null;
}

export function resolveOnboardingState(progress: OnboardingProgress): OnboardingState {
  const normalized = normalizeOnboardingProgress(progress);
  const completed = new Set(normalized.completedStepIds);
  const steps = ONBOARDING_STEP_DEFINITIONS.map((definition, index) => ({
    id: definition.id,
    order: index,
    title: definition.title,
    description: definition.description,
    completed: completed.has(definition.id),
  }));
  const completedCount = steps.reduce((count, step) => (step.completed ? count + 1 : count), 0);
  const totalSteps = steps.length;
  const currentStepId = steps.find((step) => !step.completed)?.id ?? null;

  return {
    version: DEFAULT_ONBOARDING_PROGRESS.version,
    dismissed: normalized.dismissed,
    completed: completedCount === totalSteps,
    currentStepId,
    completedCount,
    totalSteps,
    steps,
  };
}

export interface CompleteOnboardingStepResult {
  readonly progress: OnboardingProgress;
  readonly changed: boolean;
  readonly accepted: boolean;
  readonly expectedStepId: OnboardingStepId | null;
}

export function completeOnboardingStep(
  progress: OnboardingProgress,
  stepId: OnboardingStepId,
): CompleteOnboardingStepResult {
  const normalized = normalizeOnboardingProgress(progress);
  const expectedStepId = getNextOnboardingStepId(normalized);

  if (expectedStepId === null) {
    return {
      progress: normalized,
      changed: false,
      accepted: true,
      expectedStepId: null,
    };
  }

  if (stepId !== expectedStepId) {
    return {
      progress: normalized,
      changed: false,
      accepted: false,
      expectedStepId,
    };
  }

  if (normalized.completedStepIds.includes(stepId)) {
    return {
      progress: normalized,
      changed: false,
      accepted: true,
      expectedStepId,
    };
  }

  return {
    progress: normalizeOnboardingProgress({
      ...normalized,
      completedStepIds: [...normalized.completedStepIds, stepId],
    }),
    changed: true,
    accepted: true,
    expectedStepId,
  };
}

export function resetOnboardingProgress(): OnboardingProgress {
  return {
    version: DEFAULT_ONBOARDING_PROGRESS.version,
    completedStepIds: [],
    dismissed: false,
  };
}
