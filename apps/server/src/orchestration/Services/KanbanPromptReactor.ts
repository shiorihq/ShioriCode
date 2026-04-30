import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface KanbanPromptReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class KanbanPromptReactor extends ServiceMap.Service<
  KanbanPromptReactor,
  KanbanPromptReactorShape
>()("t3/orchestration/Services/KanbanPromptReactor") {}
