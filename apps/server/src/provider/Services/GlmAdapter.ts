import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface GlmAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "glm";
}

export class GlmAdapter extends ServiceMap.Service<GlmAdapter, GlmAdapterShape>()(
  "t3/provider/Services/GlmAdapter",
) {}
