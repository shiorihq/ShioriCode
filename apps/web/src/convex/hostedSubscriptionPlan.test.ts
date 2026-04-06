import { describe, expect, it } from "vitest";

import {
  hostedSubscriptionPlanLabel,
  normalizeHostedSubscriptionPlanId,
} from "./hostedSubscriptionPlan";

describe("normalizeHostedSubscriptionPlanId", () => {
  it("maps known tiers", () => {
    expect(normalizeHostedSubscriptionPlanId("plus")).toBe("plus");
    expect(normalizeHostedSubscriptionPlanId("pro")).toBe("pro");
    expect(normalizeHostedSubscriptionPlanId("max")).toBe("max");
    expect(normalizeHostedSubscriptionPlanId("free")).toBe("free");
  });

  it("defaults unknown values to free", () => {
    expect(normalizeHostedSubscriptionPlanId("enterprise")).toBe("free");
    expect(normalizeHostedSubscriptionPlanId(undefined)).toBe("free");
  });
});

describe("hostedSubscriptionPlanLabel", () => {
  it("returns marketing labels", () => {
    expect(hostedSubscriptionPlanLabel("free")).toBe("Free plan");
    expect(hostedSubscriptionPlanLabel("plus")).toBe("Plus plan");
    expect(hostedSubscriptionPlanLabel("pro")).toBe("Pro plan");
    expect(hostedSubscriptionPlanLabel("max")).toBe("Max plan");
  });
});
