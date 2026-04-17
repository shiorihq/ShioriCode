import { useQuery as useServerQuery } from "@tanstack/react-query";
import { type HostedBillingPlan, type HostedBillingSnapshot } from "contracts";
import { useMemo, useState } from "react";

import { type HostedSubscriptionPlanId } from "../../convex/api";
import { useHostedShioriState } from "../../convex/HostedShioriProvider";
import { ensureNativeApi } from "../../nativeApi";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { openHostedBillingCheckout, openHostedBillingPortal } from "./hostedBillingActions";

type HostedBillingPanelMode = "gate" | "account";

type PendingAction =
  | { kind: "checkout"; planId: HostedBillingPlan["id"] }
  | { kind: "portal"; flow: "manage" | "cancel" }
  | null;

export interface HostedBillingPanelViewProps {
  mode: HostedBillingPanelMode;
  snapshot: HostedBillingSnapshot | null;
  isLoading: boolean;
  errorMessage: string | null;
  subscriptionPlanId: HostedSubscriptionPlanId | null;
  subscriptionPlanLabel: string | null;
  isAnnual: boolean;
  pendingAction: PendingAction;
  onAnnualChange: (next: boolean) => void;
  onCheckout: (planId: HostedBillingPlan["id"]) => void;
  onPortal: (flow: "manage" | "cancel") => void;
}

function billingPanelTitle(mode: HostedBillingPanelMode, hasPaidPlan: boolean): string {
  if (mode === "gate") {
    return "Upgrade to continue";
  }
  return hasPaidPlan ? "Subscription" : "Upgrade your plan";
}

function billingPanelDescription(mode: HostedBillingPanelMode, hasPaidPlan: boolean): string {
  if (mode === "gate") {
    return "Pick a Shiori plan and we’ll open secure Stripe checkout in your browser.";
  }
  return hasPaidPlan
    ? "Manage billing, payment methods, and higher tiers through your Shiori subscription."
    : "Choose a paid Shiori plan to unlock hosted coding access.";
}

function resolveUpgradeState(input: {
  plan: HostedBillingPlan;
  subscriptionPlanId: HostedSubscriptionPlanId | null;
  snapshot: HostedBillingSnapshot | null;
}): {
  label: string;
  disabled: boolean;
} {
  const { plan, subscriptionPlanId, snapshot } = input;
  if (subscriptionPlanId === plan.id) {
    return {
      label: "Current plan",
      disabled: true,
    };
  }

  const currentPlanOrder =
    subscriptionPlanId && subscriptionPlanId !== "free"
      ? (snapshot?.plans.find((candidate) => candidate.id === subscriptionPlanId)?.sortOrder ??
        null)
      : null;

  if (currentPlanOrder !== null && currentPlanOrder > plan.sortOrder) {
    return {
      label: "Included in your plan",
      disabled: true,
    };
  }

  return {
    label: plan.buttonText ?? "Upgrade",
    disabled: false,
  };
}

function formatPlanPrice(
  plan: HostedBillingPlan,
  isAnnual: boolean,
): {
  amount: string;
  detail: string;
} {
  if (isAnnual && plan.annualPrice !== null) {
    return {
      amount: `$${Math.round(plan.annualPrice / 12)}/mo`,
      detail: `$${plan.annualPrice}/year billed annually`,
    };
  }

  return {
    amount: `$${plan.monthlyPrice}/mo`,
    detail: "Billed monthly",
  };
}

export function HostedBillingPanelView(props: HostedBillingPanelViewProps) {
  const hasPaidPlan = Boolean(props.subscriptionPlanId && props.subscriptionPlanId !== "free");

  return (
    <div className={props.mode === "gate" ? "space-y-5" : "space-y-4"}>
      <div className="space-y-1">
        {props.mode === "gate" ? (
          <h2 className="text-base font-semibold text-foreground">
            {billingPanelTitle(props.mode, hasPaidPlan)}
          </h2>
        ) : null}
        <p className="text-sm text-muted-foreground">
          {billingPanelDescription(props.mode, hasPaidPlan)}
        </p>
        {props.subscriptionPlanLabel ? (
          <p className="text-xs text-muted-foreground">
            Current plan: {props.subscriptionPlanLabel}
          </p>
        ) : null}
      </div>

      {hasPaidPlan ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={props.pendingAction !== null}
            onClick={() => props.onPortal("manage")}
          >
            {props.pendingAction?.kind === "portal" && props.pendingAction.flow === "manage"
              ? "Opening billing…"
              : "Manage billing"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={props.pendingAction !== null}
            onClick={() => props.onPortal("cancel")}
          >
            {props.pendingAction?.kind === "portal" && props.pendingAction.flow === "cancel"
              ? "Opening cancel flow…"
              : "Cancel in portal"}
          </Button>
        </div>
      ) : null}

      <div className="inline-flex items-center rounded-full border border-border/70 bg-background/70 p-1">
        <button
          type="button"
          className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
            props.isAnnual ? "text-muted-foreground" : "bg-foreground text-background"
          }`}
          onClick={() => props.onAnnualChange(false)}
        >
          Monthly
        </button>
        <button
          type="button"
          className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
            props.isAnnual ? "bg-foreground text-background" : "text-muted-foreground"
          }`}
          onClick={() => props.onAnnualChange(true)}
        >
          Annual
        </button>
      </div>

      {props.isLoading ? (
        <div className="rounded-xl border border-border/70 bg-background/60 px-4 py-5 text-sm text-muted-foreground">
          Loading subscription options…
        </div>
      ) : null}

      {props.errorMessage ? (
        <div className="rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {props.errorMessage}
        </div>
      ) : null}

      {props.snapshot ? (
        <div className="grid gap-3 md:grid-cols-3">
          {props.snapshot.plans
            .toSorted((left, right) => left.sortOrder - right.sortOrder)
            .map((plan) => {
              const upgradeState = resolveUpgradeState({
                plan,
                subscriptionPlanId: props.subscriptionPlanId,
                snapshot: props.snapshot,
              });
              const price = formatPlanPrice(plan, props.isAnnual);
              const isPendingCheckout =
                props.pendingAction?.kind === "checkout" && props.pendingAction.planId === plan.id;

              return (
                <article
                  key={plan.id}
                  className={`flex h-full flex-col rounded-2xl border px-4 py-4 ${
                    plan.highlighted
                      ? "border-primary/40 bg-primary/5"
                      : "border-border/70 bg-background/60"
                  }`}
                >
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-foreground">{plan.name}</h3>
                      {plan.highlighted ? (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                          Popular
                        </span>
                      ) : null}
                    </div>
                    <p className="text-lg font-semibold text-foreground">{price.amount}</p>
                    <p className="text-xs text-muted-foreground/60">{price.detail}</p>
                    <p className="text-sm text-muted-foreground">{plan.description}</p>
                  </div>

                  <ul className="mt-4 flex-1 space-y-2 text-sm text-muted-foreground">
                    {plan.features.slice(0, 4).map((feature) => (
                      <li key={feature}>{feature}</li>
                    ))}
                  </ul>

                  <Button
                    className="mt-6 w-full"
                    variant={plan.highlighted ? "default" : "outline"}
                    disabled={upgradeState.disabled || props.pendingAction !== null}
                    onClick={() => props.onCheckout(plan.id)}
                  >
                    {isPendingCheckout ? "Opening checkout…" : upgradeState.label}
                  </Button>
                </article>
              );
            })}
        </div>
      ) : null}
    </div>
  );
}

function toActionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  return "Please try again.";
}

export function HostedBillingPanel({ mode }: { mode: HostedBillingPanelMode }) {
  const { isAuthenticated, subscriptionPlanId, subscriptionPlanLabel } = useHostedShioriState();
  const [isAnnual, setIsAnnual] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  const billingSnapshotQuery = useServerQuery({
    queryKey: ["server", "hostedBillingSnapshot"],
    queryFn: () => ensureNativeApi().server.getHostedBillingSnapshot(),
    enabled: isAuthenticated,
    staleTime: 5 * 60_000,
  });

  const onCheckout = async (planId: HostedBillingPlan["id"]) => {
    setPendingAction({ kind: "checkout", planId });
    try {
      await openHostedBillingCheckout(ensureNativeApi(), { planId, isAnnual });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open checkout",
        description: `${toActionErrorMessage(error)} Try again after signing in again if the issue persists.`,
      });
    } finally {
      setPendingAction((current) =>
        current?.kind === "checkout" && current.planId === planId ? null : current,
      );
    }
  };

  const onPortal = async (flow: "manage" | "cancel") => {
    setPendingAction({ kind: "portal", flow });
    try {
      await openHostedBillingPortal(ensureNativeApi(), flow);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: flow === "cancel" ? "Could not open cancel flow" : "Could not open billing portal",
        description: `${toActionErrorMessage(error)} Try again after signing in again if the issue persists.`,
      });
    } finally {
      setPendingAction((current) =>
        current?.kind === "portal" && current.flow === flow ? null : current,
      );
    }
  };

  const errorMessage = useMemo(() => {
    if (!billingSnapshotQuery.error) {
      return null;
    }
    return toActionErrorMessage(billingSnapshotQuery.error);
  }, [billingSnapshotQuery.error]);

  return (
    <HostedBillingPanelView
      mode={mode}
      snapshot={billingSnapshotQuery.data ?? null}
      isLoading={billingSnapshotQuery.isLoading}
      errorMessage={errorMessage}
      subscriptionPlanId={subscriptionPlanId}
      subscriptionPlanLabel={subscriptionPlanLabel}
      isAnnual={isAnnual}
      pendingAction={pendingAction}
      onAnnualChange={setIsAnnual}
      onCheckout={(planId) => {
        void onCheckout(planId);
      }}
      onPortal={(flow) => {
        void onPortal(flow);
      }}
    />
  );
}
