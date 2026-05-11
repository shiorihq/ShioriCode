import { describe, expect, it } from "vitest";

import { resolveWelcomeViewModel } from "./-welcomeState";

describe("resolveWelcomeViewModel", () => {
  it("shows a confirmed success state for active paid subscribers", () => {
    expect(
      resolveWelcomeViewModel({
        requestedStatus: "success",
        isSubscriptionLoading: false,
        isPaidSubscriber: true,
        subscriptionPlanLabel: "Pro",
      }),
    ).toMatchObject({
      displayStatus: "success",
      headline: "Welcome to ShioriCode Pro",
      primaryActionLabel: "Start coding",
      planLabel: "Pro",
    });
  });

  it("allows the success query state without a paid plan", () => {
    expect(
      resolveWelcomeViewModel({
        requestedStatus: "success",
        isSubscriptionLoading: false,
        isPaidSubscriber: false,
        subscriptionPlanLabel: null,
      }),
    ).toMatchObject({
      displayStatus: "success",
      headline: "Welcome to ShioriCode",
      planLabel: null,
      accessStatusLabel: "ShioriCode is ready without a paid plan.",
    });
  });

  it("keeps cancelled flows explicit even for returning users", () => {
    expect(
      resolveWelcomeViewModel({
        requestedStatus: "cancelled",
        isSubscriptionLoading: false,
        isPaidSubscriber: true,
        subscriptionPlanLabel: "Pro",
      }),
    ).toMatchObject({
      displayStatus: "cancelled",
      headline: "Checkout cancelled",
      primaryActionLabel: "Back to home",
      planLabel: "Pro",
    });
  });

  it("does not block the success state while subscription access is still loading", () => {
    expect(
      resolveWelcomeViewModel({
        requestedStatus: "success",
        isSubscriptionLoading: true,
        isPaidSubscriber: false,
        subscriptionPlanLabel: null,
      }),
    ).toMatchObject({
      displayStatus: "success",
      headline: "Welcome to ShioriCode",
      accessStatusLabel: "ShioriCode is ready without a paid plan.",
    });
  });
});
