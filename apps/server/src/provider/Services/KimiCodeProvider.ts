import { ServiceMap } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface KimiCodeProviderShape extends ServerProviderShape {}

export class KimiCodeProvider extends ServiceMap.Service<KimiCodeProvider, KimiCodeProviderShape>()(
  "t3/provider/Services/KimiCodeProvider",
) {}
