import { type RuntimeMode } from "contracts";

export function getRuntimeModeLabel(runtimeMode: RuntimeMode): string {
  return runtimeMode === "full-access" ? "Full access" : "Supervised";
}

export function getRuntimeModeTitle(runtimeMode: RuntimeMode): string {
  return runtimeMode === "full-access"
    ? "Full access — click to require approvals"
    : "Supervised — click for full access";
}
