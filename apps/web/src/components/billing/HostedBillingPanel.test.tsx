import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { HostedBillingPanelView } from "./HostedBillingPanel";

const baseSnapshot = {
  plans: [
    {
      id: "plus" as const,
      name: "Plus",
      description: "Starter paid plan",
      monthlyPrice: 10,
      annualPrice: 96,
      sortOrder: 0,
      highlighted: false,
      buttonText: "Get Plus",
      features: ["Feature A", "Feature B"],
    },
    {
      id: "pro" as const,
      name: "Pro",
      description: "Power plan",
      monthlyPrice: 30,
      annualPrice: 288,
      sortOrder: 1,
      highlighted: true,
      buttonText: "Go Pro",
      features: ["Feature C"],
    },
  ],
};

describe("HostedBillingPanelView", () => {
  it("renders upgrade actions on the gate for free users", () => {
    const html = renderToStaticMarkup(
      <HostedBillingPanelView
        mode="gate"
        snapshot={baseSnapshot}
        isLoading={false}
        errorMessage={null}
        subscriptionPlanId="free"
        subscriptionPlanLabel={null}
        isAnnual={false}
        pendingAction={null}
        onAnnualChange={vi.fn()}
        onCheckout={vi.fn()}
        onPortal={vi.fn()}
      />,
    );

    expect(html).toContain("Upgrade to continue");
    expect(html).toContain("Get Plus");
    expect(html).toContain("Go Pro");
    expect(html).toContain("Popular");
    expect(html).not.toContain("Manage billing");
  });

  it("renders management actions and current-plan state for paid users", () => {
    const html = renderToStaticMarkup(
      <HostedBillingPanelView
        mode="account"
        snapshot={baseSnapshot}
        isLoading={false}
        errorMessage={null}
        subscriptionPlanId="plus"
        subscriptionPlanLabel="Plus plan"
        isAnnual
        pendingAction={null}
        onAnnualChange={vi.fn()}
        onCheckout={vi.fn()}
        onPortal={vi.fn()}
      />,
    );

    expect(html).toContain("Manage billing");
    expect(html).toContain("Cancel in portal");
    expect(html).toContain("Current plan");
    expect(html).toContain("$96/year billed annually");
  });
});
