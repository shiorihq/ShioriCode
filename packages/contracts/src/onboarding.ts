import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

export const ONBOARDING_STEP_IDS = ["sign-in", "connect-provider", "start-first-thread"] as const;

export const OnboardingStepId = Schema.Literals(ONBOARDING_STEP_IDS);
export type OnboardingStepId = typeof OnboardingStepId.Type;

export const OnboardingProgress = Schema.Struct({
  version: Schema.Literal(1).pipe(Schema.withDecodingDefault(() => 1 as const)),
  completedStepIds: Schema.Array(OnboardingStepId).pipe(Schema.withDecodingDefault(() => [])),
  dismissed: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
});
export type OnboardingProgress = typeof OnboardingProgress.Type;

export const DEFAULT_ONBOARDING_PROGRESS: OnboardingProgress = Schema.decodeSync(
  OnboardingProgress,
)({});

export const OnboardingStep = Schema.Struct({
  id: OnboardingStepId,
  order: NonNegativeInt,
  title: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  completed: Schema.Boolean,
});
export type OnboardingStep = typeof OnboardingStep.Type;

export const OnboardingState = Schema.Struct({
  version: Schema.Literal(1),
  dismissed: Schema.Boolean,
  completed: Schema.Boolean,
  currentStepId: Schema.NullOr(OnboardingStepId),
  completedCount: NonNegativeInt,
  totalSteps: NonNegativeInt,
  steps: Schema.Array(OnboardingStep),
});
export type OnboardingState = typeof OnboardingState.Type;

export const OnboardingCompleteStepInput = Schema.Struct({
  stepId: OnboardingStepId,
});
export type OnboardingCompleteStepInput = typeof OnboardingCompleteStepInput.Type;

export class OnboardingError extends Schema.TaggedErrorClass<OnboardingError>()("OnboardingError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}
