import { describe, expect, it } from "vitest";

import { resolveWelcomeViewModel } from "./-welcomeState";

describe("resolveWelcomeViewModel", () => {
  it("shows a confirmed success state only for active paid subscribers", () => {
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

  it("does not trust the success query state before the paid plan is active", () => {
    expect(
      resolveWelcomeViewModel({
        requestedStatus: "success",
        isSubscriptionLoading: false,
        isPaidSubscriber: false,
        subscriptionPlanLabel: null,
      }),
    ).toMatchObject({
      displayStatus: "pending",
      headline: "Finish setting up ShioriCode",
      planLabel: null,
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

  it("shows a neutral syncing state while subscription access is still loading", () => {
    expect(
      resolveWelcomeViewModel({
        requestedStatus: "success",
        isSubscriptionLoading: true,
        isPaidSubscriber: false,
        subscriptionPlanLabel: null,
      }),
    ).toMatchObject({
      displayStatus: "pending",
      headline: "Finishing your ShioriCode access",
      accessStatusLabel: "Syncing your subscription access",
    });
  });
});
