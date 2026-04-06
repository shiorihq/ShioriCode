import type { HostedSubscriptionPlanId } from "./api";

export function normalizeHostedSubscriptionPlanId(
  raw: string | undefined,
): HostedSubscriptionPlanId {
  if (raw === "plus" || raw === "pro" || raw === "max" || raw === "free") {
    return raw;
  }
  return "free";
}

export function hostedSubscriptionPlanLabel(plan: HostedSubscriptionPlanId): string {
  switch (plan) {
    case "free":
      return "Free plan";
    case "plus":
      return "Plus plan";
    case "pro":
      return "Pro plan";
    case "max":
      return "Max plan";
  }
}
