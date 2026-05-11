import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface GoalPromptReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class GoalPromptReactor extends ServiceMap.Service<
  GoalPromptReactor,
  GoalPromptReactorShape
>()("t3/orchestration/Services/GoalPromptReactor") {}
