import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface KimiCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "kimiCode";
}

export class KimiCodeAdapter extends ServiceMap.Service<KimiCodeAdapter, KimiCodeAdapterShape>()(
  "t3/provider/Services/KimiCodeAdapter",
) {}
