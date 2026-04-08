import type {
  OrchestrationGetSubagentDetailInput,
  OrchestrationSubagentDetail,
} from "contracts/orchestration";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface SubagentDetailQueryShape {
  readonly getSubagentDetail: (
    input: OrchestrationGetSubagentDetailInput,
  ) => Effect.Effect<OrchestrationSubagentDetail, Error>;
}

export class SubagentDetailQuery extends ServiceMap.Service<
  SubagentDetailQuery,
  SubagentDetailQueryShape
>()("t3/orchestration/Services/SubagentDetailQuery") {}
