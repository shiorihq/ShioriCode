import {
  OrchestrationEvent,
  ThreadId,
  type OnboardingState,
  type OnboardingStepId,
  type ServerLifecycleWelcomePayload,
} from "contracts";
import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  useLocation,
} from "@tanstack/react-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";
import { resolveOnboardingState } from "shared/onboarding";

import { APP_DISPLAY_NAME } from "../branding";
import { isElectron } from "../env";
import { useHostedShioriState } from "../convex/HostedShioriProvider";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { ShioriWordmark } from "../components/ShioriWordmark";
import {
  HostedShioriAuthPanel,
  type PasswordStage,
} from "../components/auth/HostedShioriAuthPanel";
import { HostedBillingPanel } from "../components/billing/HostedBillingPanel";
import { OnboardingScreen } from "../components/onboarding/OnboardingScreen";
import { TelemetryBridge } from "../components/TelemetryBridge";
import { Button } from "../components/ui/button";
import { LoadingText } from "../components/ui/loading-text";
import { Spinner } from "../components/ui/spinner";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { ensureNativeApi, hasDesktopNativeBridge, readNativeApi } from "../nativeApi";
import {
  getServerConfigUpdatedNotification,
  ServerConfigUpdatedNotification,
  startServerStateSync,
  useServerConfig,
  useServerConfigUpdatedSubscription,
  useServerWelcomeSubscription,
} from "../rpc/serverState";
import {
  clearPromotedDraftThread,
  clearPromotedDraftThreads,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { terminalRunningSubprocessFromEvent } from "../terminalActivity";
import { migrateLocalSettingsToServer } from "../hooks/useSettings";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { projectQueryKeys } from "../lib/projectReactQuery";
import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";
import { rememberSettingsReturnPath } from "../lib/settingsNavigation";
import { deriveOrchestrationBatchEffects } from "../orchestrationEventEffects";
import { coalesceOrchestrationUiEvents, createFrameBatcher } from "../orchestrationEventBatching";
import {
  createOrchestrationRecoveryCoordinator,
  shouldRecoverStaleRunningOrchestration,
} from "../orchestrationRecovery";
import { logTelemetryErrorOnce, recordTelemetry } from "../telemetry";
import { getWsRpcClient } from "~/wsRpcClient";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
  if (isElectron && !hasDesktopNativeBridge()) {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex flex-1 items-center justify-center">
          <AgentWarmupMessage />
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <TelemetryBridge />
        <SettingsReturnPathTracker />
        <AuthGate>
          <ServerStateBootstrap />
          <EventRouter />
          <OnboardingGate>
            <AppRouteShell>
              <Outlet />
            </AppRouteShell>
          </OnboardingGate>
        </AuthGate>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function AgentWarmupMessage() {
  return (
    <LoadingText className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Spinner className="size-3.5" />
      Warming up the Agents
    </LoadingText>
  );
}

function AppRouteShell({ children }: { children: ReactNode }) {
  const pathname = useLocation({ select: (location) => location.pathname });

  if (pathname === "/welcome") {
    return <>{children}</>;
  }

  return <AppSidebarLayout>{children}</AppSidebarLayout>;
}

function SettingsReturnPathTracker() {
  const pathname = useLocation({ select: (location) => location.pathname });

  useEffect(() => {
    rememberSettingsReturnPath(pathname);
  }, [pathname]);

  return null;
}

const AUTH_STAGE_COPY: Record<PasswordStage, { heading: string; description: string }> = {
  signIn: {
    heading: "Sign in required",
    description: "Sign in with your Shiori account to unlock the app and load your model catalog.",
  },
  signUp: {
    heading: "Create your Shiori account",
    description: "Set up a Shiori account to unlock ShioriCode and your model catalog.",
  },
  forgot: {
    heading: "Reset your password",
    description: "Enter your email and we'll send a code to reset your Shiori password.",
  },
  verifyEmail: {
    heading: "Verify your email",
    description: "Enter the code we sent to your email to finish signing in.",
  },
  reset: {
    heading: "Choose a new password",
    description: "Enter the reset code we sent you and pick a new password.",
  },
};

export function AuthGateScreenContent() {
  const { isAuthenticated, isSubscriptionLoading, isPaidSubscriber } = useHostedShioriState();
  const requiresPaidPlan = isAuthenticated && !isSubscriptionLoading && isPaidSubscriber === false;
  const [authStage, setAuthStage] = useState<PasswordStage>("signIn");
  const stageCopy = AUTH_STAGE_COPY[authStage] ?? AUTH_STAGE_COPY.signIn;
  const heading = requiresPaidPlan ? "Paid subscription required" : stageCopy.heading;
  const description = requiresPaidPlan
    ? "ShioriCode is available to active paid Shiori subscribers. Upgrade your Shiori plan to continue."
    : stageCopy.description;

  return (
    <div className="relative flex min-h-screen flex-col bg-background px-6 py-8 text-foreground sm:px-10">
      <div className="flex flex-1 items-center justify-center">
        <div
          className={`auth-form-enter w-full ${requiresPaidPlan ? "max-w-[960px]" : "max-w-[380px]"}`}
        >
          <div className="mb-5 flex justify-start">
            <ShioriWordmark showLogo={false} />
          </div>
          <h1 className="text-[1.75rem] font-bold leading-tight tracking-tight sm:text-[2rem]">
            {heading}
          </h1>
          <p className="mt-3 mb-10 text-[15px] leading-relaxed text-muted-foreground">
            {description}
          </p>

          <HostedShioriAuthPanel
            heading=""
            description=""
            syncStageWithUrl={!requiresPaidPlan}
            onStageChange={setAuthStage}
          />
          {requiresPaidPlan ? (
            <div className="mt-6">
              <HostedBillingPanel mode="gate" />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AuthGate({ children }: { children: ReactNode }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isAuthenticated, isAuthLoading, isSubscriptionLoading, isPaidSubscriber } =
    useHostedShioriState();
  const lastGateReasonRef = useRef<string | null>(null);
  const allowWelcomeRoute = pathname === "/welcome" && isAuthenticated;

  const gateReason =
    isAuthLoading || (isAuthenticated && isSubscriptionLoading)
      ? null
      : !isAuthenticated
        ? "sign_in_required"
        : !isPaidSubscriber
          ? "paid_subscription_required"
          : null;

  useEffect(() => {
    if (gateReason === null || lastGateReasonRef.current === gateReason) {
      return;
    }
    lastGateReasonRef.current = gateReason;
    recordTelemetry("web.auth_gate.viewed", {
      reason: gateReason,
    });
  }, [gateReason]);

  if (isAuthLoading || (isAuthenticated && isSubscriptionLoading) || !isAuthenticated) {
    return <AuthGateScreenContent />;
  }

  if (!isPaidSubscriber && !allowWelcomeRoute) {
    return <AuthGateScreenContent />;
  }

  return <>{children}</>;
}

function OnboardingGate({ children }: { children: ReactNode }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isAuthenticated, isSubscriptionLoading, isPaidSubscriber } = useHostedShioriState();
  const serverConfig = useServerConfig();
  const { defaultProjectId, handleNewThread } = useHandleNewThread();
  const canRunOnboarding = isAuthenticated && !isSubscriptionLoading && isPaidSubscriber;
  const allowWelcomeRoute = pathname === "/welcome" && isAuthenticated;
  const [bootstrappedOnboardingState, setBootstrappedOnboardingState] =
    useState<OnboardingState | null>(null);
  const [onboardingOverrideState, setOnboardingOverrideState] = useState<OnboardingState | null>(
    null,
  );
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [pendingStepId, setPendingStepId] = useState<OnboardingStepId | null>(null);
  const lastViewedStepRef = useRef<OnboardingStepId | null>(null);

  const serverOnboardingState = useMemo(() => {
    if (!canRunOnboarding || serverConfig === null) {
      return null;
    }
    return resolveOnboardingState(serverConfig.settings.onboarding);
  }, [canRunOnboarding, serverConfig]);

  const onboardingState =
    onboardingOverrideState ?? serverOnboardingState ?? bootstrappedOnboardingState;

  if (allowWelcomeRoute) {
    return <>{children}</>;
  }

  const completeOnboardingStep = useCallback(async (stepId: OnboardingStepId) => {
    setPendingStepId(stepId);
    setOnboardingError(null);
    try {
      const state = await ensureNativeApi().onboarding.completeStep({ stepId });
      setOnboardingOverrideState(state);
      return state;
    } catch (error: unknown) {
      setOnboardingError(
        error instanceof Error ? error.message : "Failed to complete onboarding step.",
      );
      return null;
    } finally {
      setPendingStepId((currentStepId) => (currentStepId === stepId ? null : currentStepId));
    }
  }, []);

  const startCoding = useCallback(async () => {
    const state = await completeOnboardingStep("start-first-thread");
    if (!state?.completed || !defaultProjectId) {
      return;
    }
    await handleNewThread(defaultProjectId);
  }, [completeOnboardingStep, defaultProjectId, handleNewThread]);

  useEffect(() => {
    if (!canRunOnboarding) {
      setBootstrappedOnboardingState(null);
      setOnboardingOverrideState(null);
      setOnboardingError(null);
      setPendingStepId(null);
    }
  }, [canRunOnboarding]);

  useEffect(() => {
    if (
      !canRunOnboarding ||
      serverOnboardingState !== null ||
      onboardingOverrideState !== null ||
      bootstrappedOnboardingState !== null
    ) {
      return;
    }

    let cancelled = false;
    const api = readNativeApi();
    if (!api) {
      return;
    }

    void api.onboarding
      .getState()
      .then((state) => {
        if (cancelled) {
          return;
        }
        setBootstrappedOnboardingState(state);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [
    bootstrappedOnboardingState,
    canRunOnboarding,
    onboardingOverrideState,
    serverOnboardingState,
  ]);

  useEffect(() => {
    if (!onboardingOverrideState || !serverOnboardingState) {
      return;
    }

    if (onboardingStatesEqual(onboardingOverrideState, serverOnboardingState)) {
      setOnboardingOverrideState(null);
    }
  }, [onboardingOverrideState, serverOnboardingState]);

  useEffect(() => {
    if (!bootstrappedOnboardingState || !serverOnboardingState) {
      return;
    }

    if (onboardingStatesEqual(bootstrappedOnboardingState, serverOnboardingState)) {
      setBootstrappedOnboardingState(null);
    }
  }, [bootstrappedOnboardingState, serverOnboardingState]);

  useEffect(() => {
    if (!canRunOnboarding || !onboardingState) {
      return;
    }
    if (onboardingState.completed || onboardingState.currentStepId !== "sign-in") {
      return;
    }
    if (pendingStepId !== null) {
      return;
    }

    completeOnboardingStep("sign-in");
  }, [canRunOnboarding, completeOnboardingStep, onboardingState, pendingStepId]);

  useEffect(() => {
    if (!canRunOnboarding || onboardingState === null || onboardingState.completed) {
      lastViewedStepRef.current = null;
      return;
    }
    if (lastViewedStepRef.current === onboardingState.currentStepId) {
      return;
    }
    lastViewedStepRef.current = onboardingState.currentStepId;
    recordTelemetry("web.onboarding.step_viewed", {
      stepId: onboardingState.currentStepId,
    });
  }, [canRunOnboarding, onboardingState]);

  if (!canRunOnboarding) {
    return null;
  }

  if (onboardingState === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <AgentWarmupMessage />
      </div>
    );
  }

  if (!onboardingState.completed) {
    return (
      <OnboardingScreen
        onboardingState={onboardingState}
        pendingStepId={pendingStepId}
        onboardingError={onboardingError}
        onCompleteStep={completeOnboardingStep}
        onStartCoding={startCoding}
      />
    );
  }

  return <>{children}</>;
}

function onboardingStatesEqual(left: OnboardingState, right: OnboardingState): boolean {
  if (
    left.completed !== right.completed ||
    left.completedCount !== right.completedCount ||
    left.totalSteps !== right.totalSteps ||
    left.currentStepId !== right.currentStepId ||
    left.steps.length !== right.steps.length
  ) {
    return false;
  }

  for (const [index, leftStep] of left.steps.entries()) {
    const rightStep = right.steps[index];
    if (!rightStep || rightStep.id !== leftStep.id || rightStep.completed !== leftStep.completed) {
      return false;
    }
  }

  return true;
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    logTelemetryErrorOnce("web.route_error_boundary", {
      message,
      details,
    });
  }, [details, message]);

  const copyTrace = useCallback(() => {
    void navigator.clipboard.writeText(details).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [details]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10 text-foreground">
      <section className="w-full max-w-md">
        <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{message}</p>

        <div className="mt-5 flex gap-2">
          <Button size="sm" onClick={() => reset()}>
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>

        <details className="group mt-6">
          <summary className="cursor-pointer text-xs text-muted-foreground/50 transition-colors select-none hover:text-muted-foreground">
            <span className="group-open:hidden">Show stack trace</span>
            <span className="hidden group-open:inline">Hide stack trace</span>
          </summary>
          <div className="relative mt-2">
            <button
              type="button"
              onClick={copyTrace}
              className="absolute top-2 right-2 rounded-md border border-border/50 bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <pre className="max-h-52 overflow-auto rounded-lg border border-border/50 bg-muted/40 px-3 py-2.5 font-mono text-[11px] leading-[1.6] text-foreground/50">
              {details}
            </pre>
          </div>
        </details>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

const ORCHESTRATION_RECOVERY_REQUEST_TIMEOUT_MS = 8_000;
const ORCHESTRATION_RUNNING_WATCHDOG_INTERVAL_MS = 5_000;
const ORCHESTRATION_RUNNING_STALE_AFTER_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function ServerStateBootstrap() {
  useEffect(() => {
    return startServerStateSync(getWsRpcClient().server);
  }, []);

  return null;
}

function EventRouter() {
  const applyOrchestrationEvents = useStore((store) => store.applyOrchestrationEvents);
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const syncProjects = useUiStateStore((store) => store.syncProjects);
  const syncThreads = useUiStateStore((store) => store.syncThreads);
  const clearThreadUi = useUiStateStore((store) => store.clearThreadUi);
  const removeTerminalState = useTerminalStateStore((store) => store.removeTerminalState);
  const removeOrphanedTerminalStates = useTerminalStateStore(
    (store) => store.removeOrphanedTerminalStates,
  );
  const queryClient = useQueryClient();
  const seenServerConfigUpdateIdRef = useRef(getServerConfigUpdatedNotification()?.id ?? 0);
  const disposedRef = useRef(false);
  const bootstrapFromSnapshotRef = useRef<() => Promise<void>>(async () => undefined);
  const serverConfig = useServerConfig();

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload) return;

    migrateLocalSettingsToServer();
    void (async () => {
      await bootstrapFromSnapshotRef.current();
      if (disposedRef.current) {
        return;
      }

      if (!payload.bootstrapProjectId) {
        return;
      }
      setProjectExpanded(payload.bootstrapProjectId, true);
    })().catch(() => undefined);
  });

  const handleServerConfigUpdated = useEffectEvent(
    (notification: ServerConfigUpdatedNotification | null) => {
      if (!notification) return;

      const { id, payload, source } = notification;
      if (id <= seenServerConfigUpdateIdRef.current) {
        return;
      }
      seenServerConfigUpdateIdRef.current = id;
      if (source !== "keybindingsUpdated") {
        return;
      }

      const issue = payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
      if (!issue) {
        toastManager.add({
          type: "success",
          title: "Keybindings updated",
          description: "Keybindings configuration reloaded successfully.",
        });
        return;
      }

      toastManager.add({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: issue.message,
        actionProps: {
          children: "Open keybindings.json",
          onClick: () => {
            const api = readNativeApi();
            if (!api) {
              return;
            }

            void Promise.resolve(serverConfig ?? api.server.getConfig())
              .then((config) => {
                const editor = resolveAndPersistPreferredEditor(config.availableEditors);
                if (!editor) {
                  throw new Error("No available editors found.");
                }
                return api.shell.openInEditor(config.keybindingsConfigPath, editor);
              })
              .catch((error) => {
                toastManager.add({
                  type: "error",
                  title: "Unable to open keybindings file",
                  description:
                    error instanceof Error ? error.message : "Unknown error opening file.",
                });
              });
          },
        },
      });
    },
  );

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    let disposed = false;
    disposedRef.current = false;
    const recovery = createOrchestrationRecoveryCoordinator();
    let needsProviderInvalidation = false;
    let lastOrchestrationActivityAt = Date.now();

    const reconcileSnapshotDerivedState = () => {
      const threads = useStore.getState().threads;
      const projects = useStore.getState().projects;
      syncProjects(projects.map((project) => ({ id: project.id, cwd: project.cwd })));
      syncThreads(
        threads.map((thread) => ({
          id: thread.id,
          seedVisitedAt: thread.updatedAt ?? thread.createdAt,
        })),
      );
      clearPromotedDraftThreads(threads.map((thread) => thread.id));
      const draftThreadIds = Object.keys(
        useComposerDraftStore.getState().draftThreadsByThreadId,
      ) as ThreadId[];
      const activeThreadIds = collectActiveTerminalThreadIds({
        snapshotThreads: threads.map((thread) => ({
          id: thread.id,
          deletedAt: null,
          archivedAt: thread.archivedAt,
        })),
        draftThreadIds,
      });
      removeOrphanedTerminalStates(activeThreadIds);
    };

    const queryInvalidationThrottler = new Throttler(
      () => {
        if (!needsProviderInvalidation) {
          return;
        }
        needsProviderInvalidation = false;
        void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
        // Invalidate workspace entry queries so the @-mention file picker
        // reflects files created, deleted, or restored during this turn.
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
      },
      {
        wait: 100,
        leading: false,
        trailing: true,
      },
    );

    const applyEventBatch = (
      events: ReadonlyArray<OrchestrationEvent>,
      options?: { readonly recoverOnFailure?: boolean },
    ): boolean => {
      const nextEvents = recovery.selectApplicableEventBatch(events);
      if (nextEvents.length === 0) {
        return true;
      }

      try {
        const batchEffects = deriveOrchestrationBatchEffects(nextEvents);
        const uiEvents = coalesceOrchestrationUiEvents(nextEvents);
        const needsProjectUiSync = nextEvents.some(
          (event) =>
            event.type === "project.created" ||
            event.type === "project.meta-updated" ||
            event.type === "project.deleted",
        );

        applyOrchestrationEvents(uiEvents);
        recovery.markEventBatchApplied(nextEvents);
        lastOrchestrationActivityAt = Date.now();

        if (batchEffects.needsProviderInvalidation) {
          needsProviderInvalidation = true;
          void queryInvalidationThrottler.maybeExecute();
        }

        if (needsProjectUiSync) {
          const projects = useStore.getState().projects;
          syncProjects(projects.map((project) => ({ id: project.id, cwd: project.cwd })));
        }
        const needsThreadUiSync = nextEvents.some(
          (event) => event.type === "thread.created" || event.type === "thread.deleted",
        );
        if (needsThreadUiSync) {
          const threads = useStore.getState().threads;
          syncThreads(
            threads.map((thread) => ({
              id: thread.id,
              seedVisitedAt: thread.updatedAt ?? thread.createdAt,
            })),
          );
        }
        const draftStore = useComposerDraftStore.getState();
        for (const threadId of batchEffects.clearPromotedDraftThreadIds) {
          clearPromotedDraftThread(threadId);
        }
        for (const threadId of batchEffects.clearDeletedThreadIds) {
          draftStore.clearDraftThread(threadId);
          clearThreadUi(threadId);
        }
        for (const threadId of batchEffects.removeTerminalStateThreadIds) {
          removeTerminalState(threadId);
        }
        return true;
      } catch (error: unknown) {
        logTelemetryErrorOnce("web.orchestration_event_batch_failed", {
          message: error instanceof Error ? error.message : String(error),
          eventCount: nextEvents.length,
          firstSequence: nextEvents[0]?.sequence ?? null,
          lastSequence: nextEvents.at(-1)?.sequence ?? null,
        });
        if (options?.recoverOnFailure !== false) {
          void fallbackToSnapshotRecovery();
        }
        return false;
      }
    };
    const domainEventBatcher = createFrameBatcher<OrchestrationEvent>({
      flush: (events) => {
        if (!disposed) {
          applyEventBatch(events);
        }
      },
      maxDelayMs: 100,
      maxItems: 500,
    });

    const recoverFromSequenceGap = async (): Promise<void> => {
      if (!recovery.beginReplayRecovery("sequence-gap")) {
        return;
      }

      const fromSequenceExclusive = recovery.getState().latestSequence;
      try {
        const events = await withTimeout(
          api.orchestration.replayEvents(fromSequenceExclusive),
          ORCHESTRATION_RECOVERY_REQUEST_TIMEOUT_MS,
          "Timed out while replaying orchestration events.",
        );
        lastOrchestrationActivityAt = Date.now();
        if (!disposed && !applyEventBatch(events, { recoverOnFailure: false })) {
          recovery.failReplayRecovery();
          void fallbackToSnapshotRecovery();
          return;
        }
      } catch (error: unknown) {
        logTelemetryErrorOnce("web.orchestration_replay_failed", {
          message: error instanceof Error ? error.message : String(error),
          fromSequenceExclusive,
        });
        recovery.failReplayRecovery();
        void fallbackToSnapshotRecovery();
        return;
      }

      if (!disposed && recovery.completeReplayRecovery()) {
        void recoverFromSequenceGap();
      }
    };

    const runSnapshotRecovery = async (
      reason: "bootstrap" | "replay-failed" | "stale-running-thread",
    ): Promise<void> => {
      const started = recovery.beginSnapshotRecovery(reason);
      if (import.meta.env.MODE !== "test") {
        const state = recovery.getState();
        console.info("[orchestration-recovery]", "Snapshot recovery requested.", {
          reason,
          skipped: !started,
          ...(started
            ? {}
            : {
                blockedBy: state.inFlight?.kind ?? null,
                blockedByReason: state.inFlight?.reason ?? null,
              }),
          state,
        });
      }
      if (!started) {
        return;
      }

      try {
        const snapshot = await withTimeout(
          api.orchestration.getSnapshot(),
          ORCHESTRATION_RECOVERY_REQUEST_TIMEOUT_MS,
          "Timed out while loading orchestration snapshot.",
        );
        lastOrchestrationActivityAt = Date.now();
        if (!disposed) {
          const shouldApplySnapshot = recovery.shouldApplySnapshot(snapshot.snapshotSequence);
          if (shouldApplySnapshot) {
            syncServerReadModel(snapshot);
            reconcileSnapshotDerivedState();
          } else if (import.meta.env.MODE !== "test") {
            console.info("[orchestration-recovery]", "Skipped stale snapshot recovery payload.", {
              snapshotSequence: snapshot.snapshotSequence,
              latestSequence: recovery.getState().latestSequence,
              reason,
            });
          }
          if (recovery.completeSnapshotRecovery(snapshot.snapshotSequence)) {
            void recoverFromSequenceGap();
          }
        }
      } catch (error: unknown) {
        logTelemetryErrorOnce("web.orchestration_snapshot_recovery_failed", {
          message: error instanceof Error ? error.message : String(error),
          reason,
        });
        // Keep prior state and wait for welcome or a later replay attempt.
        recovery.failSnapshotRecovery();
      }
    };

    const bootstrapFromSnapshot = async (): Promise<void> => {
      await runSnapshotRecovery("bootstrap");
    };
    bootstrapFromSnapshotRef.current = bootstrapFromSnapshot;

    const fallbackToSnapshotRecovery = async (): Promise<void> => {
      await runSnapshotRecovery("replay-failed");
    };
    const unsubDomainEvent = api.orchestration.onDomainEvent((event) => {
      lastOrchestrationActivityAt = Date.now();
      const action = recovery.classifyDomainEvent(event.sequence);
      if (action === "apply") {
        domainEventBatcher.push(event);
        return;
      }
      if (action === "recover") {
        domainEventBatcher.flushNow();
        void recoverFromSequenceGap();
      }
    });
    const watchdogTimerId = window.setInterval(() => {
      if (disposed) {
        return;
      }
      if (recovery.getState().inFlight) {
        return;
      }

      const state = useStore.getState();
      if (
        !shouldRecoverStaleRunningOrchestration({
          now: Date.now(),
          lastActivityAt: lastOrchestrationActivityAt,
          staleAfterMs: ORCHESTRATION_RUNNING_STALE_AFTER_MS,
          threads: state.threads,
          pendingThreadDispatchById: state.pendingThreadDispatchById,
        })
      ) {
        return;
      }

      void runSnapshotRecovery("stale-running-thread");
    }, ORCHESTRATION_RUNNING_WATCHDOG_INTERVAL_MS);
    const unsubTerminalEvent = api.terminal.onEvent((event) => {
      const thread = useStore.getState().threads.find((entry) => entry.id === event.threadId);
      if (thread && thread.archivedAt !== null) {
        return;
      }
      useTerminalStateStore.getState().recordTerminalEvent(event);
      const hasRunningSubprocess = terminalRunningSubprocessFromEvent(event);
      if (hasRunningSubprocess === null) {
        return;
      }
      useTerminalStateStore
        .getState()
        .setTerminalActivity(
          ThreadId.makeUnsafe(event.threadId),
          event.terminalId,
          hasRunningSubprocess,
        );
    });
    return () => {
      disposed = true;
      disposedRef.current = true;
      needsProviderInvalidation = false;
      domainEventBatcher.dispose();
      queryInvalidationThrottler.cancel();
      window.clearInterval(watchdogTimerId);
      unsubDomainEvent();
      unsubTerminalEvent();
    };
  }, [
    applyOrchestrationEvents,
    queryClient,
    removeTerminalState,
    removeOrphanedTerminalStates,
    clearThreadUi,
    setProjectExpanded,
    syncProjects,
    syncServerReadModel,
    syncThreads,
  ]);

  useServerWelcomeSubscription(handleWelcome);
  useServerConfigUpdatedSubscription(handleServerConfigUpdated);

  return null;
}
