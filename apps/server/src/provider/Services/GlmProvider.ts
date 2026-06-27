import { ServiceMap } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface GlmProviderShape extends ServerProviderShape {}

export class GlmProvider extends ServiceMap.Service<GlmProvider, GlmProviderShape>()(
  "t3/provider/Services/GlmProvider",
) {}
