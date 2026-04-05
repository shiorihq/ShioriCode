import { ServiceMap } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface ShioriProviderShape extends ServerProviderShape {}

export class ShioriProvider extends ServiceMap.Service<ShioriProvider, ShioriProviderShape>()(
  "t3/provider/Services/ShioriProvider",
) {}
