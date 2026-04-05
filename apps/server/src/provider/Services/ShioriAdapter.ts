import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface ShioriAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "shiori";
}

export class ShioriAdapter extends ServiceMap.Service<ShioriAdapter, ShioriAdapterShape>()(
  "t3/provider/Services/ShioriAdapter",
) {}
