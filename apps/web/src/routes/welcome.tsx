import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon, CheckCircle2Icon, LoaderCircleIcon, XCircleIcon } from "lucide-react";

import { useHostedShioriState } from "../convex/HostedShioriProvider";
import { AppLogoMark } from "../components/AppLogoMark";
import { Button } from "../components/ui/button";
import { resolveWelcomeViewModel, type WelcomeRequestedStatus } from "./-welcomeState";

type WelcomePlan = "plus" | "pro" | "max";

export interface WelcomeSearch {
  status?: WelcomeRequestedStatus;
  plan?: WelcomePlan;
  session_id?: string;
  state?: string;
}

function WelcomeRouteView() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const { isPaidSubscriber, isSubscriptionLoading, subscriptionPlanLabel } = useHostedShioriState();

  const viewModel = resolveWelcomeViewModel({
    requestedStatus: search.status,
    isSubscriptionLoading,
    isPaidSubscriber,
    subscriptionPlanLabel,
  });

  return (
    <main className="relative isolate flex min-h-screen items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top,rgba(14,165,233,0.16),transparent_36%),linear-gradient(180deg,#f8fafc_0%,#eef6ff_100%)] px-6 py-10 text-foreground">
      <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.84),rgba(255,255,255,0.32))]" />
      <section className="relative w-full max-w-3xl overflow-hidden rounded-[2rem] border border-border/70 bg-background/90 shadow-[0_28px_100px_-56px_rgba(15,23,42,0.7)] backdrop-blur-xl">
        <div className="grid gap-0 md:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-8 px-8 py-10 sm:px-10 sm:py-12">
            <div className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-foreground px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-background">
              <AppLogoMark className="size-4" />
              ShioriCode
            </div>

            <div className="space-y-4">
              <div className="flex items-center gap-3 text-muted-foreground">
                {viewModel.displayStatus === "success" ? (
                  <CheckCircle2Icon className="size-6 text-emerald-500" />
                ) : viewModel.displayStatus === "cancelled" ? (
                  <XCircleIcon className="size-6 text-amber-500" />
                ) : (
                  <LoaderCircleIcon className="size-6 animate-spin text-sky-500" />
                )}
                <p className="text-sm font-medium uppercase tracking-[0.22em]">
                  {viewModel.eyebrowLabel}
                </p>
              </div>
              <h1 className="max-w-xl text-4xl font-semibold tracking-tight sm:text-5xl">
                {viewModel.headline}
              </h1>
              <p className="max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
                {viewModel.description}
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                size="lg"
                className="min-w-[12rem]"
                onClick={() => void navigate({ to: "/" })}
              >
                {viewModel.primaryActionLabel}
                <ArrowRightIcon className="size-4" />
              </Button>
              <Button
                size="lg"
                variant="outline"
                onClick={() => void navigate({ to: "/settings/account" })}
              >
                Open account
              </Button>
            </div>
          </div>

          <aside className="border-t border-border/70 bg-[linear-gradient(180deg,rgba(226,232,240,0.32),rgba(255,255,255,0.86))] px-8 py-10 sm:px-10 md:border-t-0 md:border-l">
            <div className="space-y-4">
              <div className="rounded-[1.5rem] border border-border/70 bg-background/90 px-5 py-5">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                  Access status
                </p>
                <p className="mt-3 text-lg font-medium leading-7 text-foreground">
                  {viewModel.accessStatusLabel}
                </p>
              </div>

              {viewModel.planLabel ? (
                <div className="rounded-[1.5rem] border border-border/70 bg-background/90 px-5 py-5">
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                    Plan
                  </p>
                  <p className="mt-3 text-2xl font-semibold text-foreground">
                    {viewModel.planLabel}
                  </p>
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}

export const Route = createFileRoute("/welcome")({
  component: WelcomeRouteView,
  validateSearch: (search: Record<string, unknown>): WelcomeSearch => {
    const out: WelcomeSearch = {};

    if (search.status === "success" || search.status === "cancelled") {
      out.status = search.status;
    }
    if (search.plan === "plus" || search.plan === "pro" || search.plan === "max") {
      out.plan = search.plan;
    }
    if (typeof search.session_id === "string" && search.session_id.length > 0) {
      out.session_id = search.session_id;
    }
    if (typeof search.state === "string" && search.state.length > 0) {
      out.state = search.state;
    }

    return out;
  },
});
