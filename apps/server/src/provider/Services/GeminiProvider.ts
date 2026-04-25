import { ServiceMap } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface GeminiProviderShape extends ServerProviderShape {}

export class GeminiProvider extends ServiceMap.Service<GeminiProvider, GeminiProviderShape>()(
  "shiori/provider/Services/GeminiProvider",
) {}
