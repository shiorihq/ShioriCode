import type { Automation, AutomationId } from "contracts";
import { ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface AutomationRepositoryShape {
  readonly list: () => Effect.Effect<ReadonlyArray<Automation>, ProjectionRepositoryError>;
  readonly listDue: (
    now: string,
  ) => Effect.Effect<ReadonlyArray<Automation>, ProjectionRepositoryError>;
  readonly getById: (
    automationId: AutomationId,
  ) => Effect.Effect<Option.Option<Automation>, ProjectionRepositoryError>;
  readonly upsert: (automation: Automation) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly softDelete: (input: {
    readonly automationId: AutomationId;
    readonly deletedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class AutomationRepository extends ServiceMap.Service<
  AutomationRepository,
  AutomationRepositoryShape
>()("shioricode/automations/AutomationRepository") {}
