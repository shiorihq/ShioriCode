import type {
  AutomationCreateInput,
  AutomationIdInput,
  AutomationListResult,
  AutomationUpdateInput,
} from "contracts";
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";
import type { AutomationError } from "contracts";

export interface AutomationServiceShape {
  readonly list: Effect.Effect<AutomationListResult, AutomationError>;
  readonly create: (
    input: AutomationCreateInput,
  ) => Effect.Effect<AutomationListResult, AutomationError>;
  readonly update: (
    input: AutomationUpdateInput,
  ) => Effect.Effect<AutomationListResult, AutomationError>;
  readonly delete: (
    input: AutomationIdInput,
  ) => Effect.Effect<AutomationListResult, AutomationError>;
  readonly runNow: (
    input: AutomationIdInput,
  ) => Effect.Effect<AutomationListResult, AutomationError>;
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

export class AutomationService extends ServiceMap.Service<
  AutomationService,
  AutomationServiceShape
>()("shioricode/automations/AutomationService") {}
