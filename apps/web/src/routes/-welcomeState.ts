export type WelcomeRequestedStatus = "success" | "cancelled";
export type WelcomeDisplayStatus = "success" | "pending" | "cancelled";

export interface WelcomeViewModel {
  displayStatus: WelcomeDisplayStatus;
  headline: string;
  description: string;
  planLabel: string | null;
  primaryActionLabel: string;
  eyebrowLabel: string;
  accessStatusLabel: string;
}

function normalizePlanLabel(planLabel: string | null): string | null {
  const trimmed = planLabel?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveWelcomeViewModel(input: {
  requestedStatus: WelcomeRequestedStatus | undefined;
  isSubscriptionLoading: boolean;
  isPaidSubscriber: boolean;
  subscriptionPlanLabel: string | null;
}): WelcomeViewModel {
  const planLabel = normalizePlanLabel(input.subscriptionPlanLabel);

  if (input.requestedStatus === "cancelled") {
    return {
      displayStatus: "cancelled",
      headline: "Checkout cancelled",
      description: "No payment was completed, but your desktop app is right where you left it.",
      planLabel: input.isPaidSubscriber ? planLabel : null,
      primaryActionLabel: "Back to home",
      eyebrowLabel: "Back in the app",
      accessStatusLabel: input.isPaidSubscriber
        ? "Your paid plan is active in ShioriCode."
        : "Your Shiori plan is not active in ShioriCode yet.",
    };
  }

  if (input.isPaidSubscriber) {
    return {
      displayStatus: "success",
      headline: `Welcome to ShioriCode${planLabel ? ` ${planLabel}` : ""}`,
      description: "Everything is active. You can jump straight into the app.",
      planLabel,
      primaryActionLabel: "Start coding",
      eyebrowLabel: "Desktop handoff complete",
      accessStatusLabel: "Your paid plan is active in ShioriCode.",
    };
  }

  if (input.isSubscriptionLoading) {
    return {
      displayStatus: "pending",
      headline: "Finishing your ShioriCode access",
      description:
        "We’re syncing your Shiori subscription with the desktop app now. This usually only takes a moment.",
      planLabel: null,
      primaryActionLabel: "Back to home",
      eyebrowLabel: "Syncing access",
      accessStatusLabel: "Syncing your subscription access",
    };
  }

  return {
    displayStatus: "pending",
    headline: "Finish setting up ShioriCode",
    description:
      "Open your account to review your Shiori plan and continue once desktop access is active.",
    planLabel: null,
    primaryActionLabel: "Back to home",
    eyebrowLabel: "Desktop access required",
    accessStatusLabel: "Your Shiori plan is not active in ShioriCode yet.",
  };
}
