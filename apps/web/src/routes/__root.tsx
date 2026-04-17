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
import { LoaderCircle } from "lucide-react";
import { resolveOnboardingState } from "shared/onboarding";

import { APP_DISPLAY_NAME } from "../branding";
import { useHostedShioriState } from "../convex/HostedShioriProvider";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { HostedShioriAuthPanel } from "../components/auth/HostedShioriAuthPanel";
import { HostedBillingPanel } from "../components/billing/HostedBillingPanel";
import { OnboardingScreen } from "../components/onboarding/OnboardingScreen";
import { TelemetryBridge } from "../components/TelemetryBridge";
import { Button } from "../components/ui/button";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { ensureNativeApi, readNativeApi } from "../nativeApi";
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
import { createOrchestrationRecoveryCoordinator } from "../orchestrationRecovery";
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
  if (!readNativeApi()) {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            Connecting to {APP_DISPLAY_NAME} server...
          </p>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <ServerStateBootstrap />
        <TelemetryBridge />
        <SettingsReturnPathTracker />
        <EventRouter />
        <AuthGate>
          <OnboardingGate>
            <AppSidebarLayout>
              <Outlet />
            </AppSidebarLayout>
          </OnboardingGate>
        </AuthGate>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function SettingsReturnPathTracker() {
  const pathname = useLocation({ select: (location) => location.pathname });

  useEffect(() => {
    rememberSettingsReturnPath(pathname);
  }, [pathname]);

  return null;
}

export function AuthGateScreenContent() {
  const { isAuthenticated, isSubscriptionLoading, isPaidSubscriber } = useHostedShioriState();
  const requiresPaidPlan = isAuthenticated && !isSubscriptionLoading && isPaidSubscriber === false;
  const heading = requiresPaidPlan ? "Paid subscription required" : "Sign in required";
  const description = requiresPaidPlan
    ? "ShioriCode is available to active paid Shiori subscribers. Upgrade your Shiori plan to continue."
    : "Sign in with your Shiori account to unlock the app and load your model catalog.";

  return (
    <div className="relative flex min-h-screen flex-col bg-background px-6 py-8 text-foreground sm:px-10">
      <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground/50 uppercase">
        {APP_DISPLAY_NAME}
      </p>

      <div className="flex flex-1 items-center justify-center">
        <div className="auth-form-enter w-full max-w-[380px]">
          <h1 className="text-[1.75rem] font-bold leading-tight tracking-tight sm:text-[2rem]">
            {heading}
          </h1>
          <p className="mt-3 mb-10 text-[15px] leading-relaxed text-muted-foreground">
            {description}
          </p>

          <HostedShioriAuthPanel heading="" description="" />
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
  const { isAuthenticated, isAuthLoading, isSubscriptionLoading, isPaidSubscriber } =
    useHostedShioriState();
  const lastGateReasonRef = useRef<string | null>(null);

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

  if (!isPaidSubscriber) {
    return <AuthGateScreenContent />;
  }

  return <>{children}</>;
}

function OnboardingGate({ children }: { children: ReactNode }) {
  const { isAuthenticated, isSubscriptionLoading, isPaidSubscriber } = useHostedShioriState();
  const serverConfig = useServerConfig();
  const { defaultProjectId, handleNewThread } = useHandleNewThread();
  const canRunOnboarding = isAuthenticated && !isSubscriptionLoading && isPaidSubscriber;
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

    void ensureNativeApi()
      .onboarding.getState()
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
        <p className="shimmer shimmer-spread-200 flex items-center gap-1.5 text-sm text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" />
          Warming up the Agents
        </p>
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

function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  if (events.length < 2) {
    return [...events];
  }

  const coalesced: OrchestrationEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (
      previous?.type === "thread.message-sent" &&
      event.type === "thread.message-sent" &&
      previous.payload.threadId === event.payload.threadId &&
      previous.payload.messageId === event.payload.messageId
    ) {
      coalesced[coalesced.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          attachments: event.payload.attachments ?? previous.payload.attachments,
          createdAt: previous.payload.createdAt,
          text:
            !event.payload.streaming && event.payload.text.length > 0
              ? event.payload.text
              : previous.payload.text + event.payload.text,
        },
      };
      continue;
    }

    coalesced.push(event);
  }

  return coalesced;
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
    const pendingDomainEvents: OrchestrationEvent[] = [];
    let flushPendingDomainEventsScheduled = false;

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

    const applyEventBatch = (events: ReadonlyArray<OrchestrationEvent>) => {
      const nextEvents = recovery.markEventBatchApplied(events);
      if (nextEvents.length === 0) {
        return;
      }

      const batchEffects = deriveOrchestrationBatchEffects(nextEvents);
      const uiEvents = coalesceOrchestrationUiEvents(nextEvents);
      const needsProjectUiSync = nextEvents.some(
        (event) =>
          event.type === "project.created" ||
          event.type === "project.meta-updated" ||
          event.type === "project.deleted",
      );

      if (batchEffects.needsProviderInvalidation) {
        needsProviderInvalidation = true;
        void queryInvalidationThrottler.maybeExecute();
      }

      applyOrchestrationEvents(uiEvents);
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
    };
    const flushPendingDomainEvents = () => {
      flushPendingDomainEventsScheduled = false;
      if (disposed || pendingDomainEvents.length === 0) {
        return;
      }

      const events = pendingDomainEvents.splice(0, pendingDomainEvents.length);
      applyEventBatch(events);
    };
    const schedulePendingDomainEventFlush = () => {
      if (flushPendingDomainEventsScheduled) {
        return;
      }

      flushPendingDomainEventsScheduled = true;
      queueMicrotask(flushPendingDomainEvents);
    };

    const recoverFromSequenceGap = async (): Promise<void> => {
      if (!recovery.beginReplayRecovery("sequence-gap")) {
        return;
      }

      const fromSequenceExclusive = recovery.getState().latestSequence;
      try {
        const events = await api.orchestration.replayEvents(fromSequenceExclusive);
        if (!disposed) {
          applyEventBatch(events);
        }
      } catch {
        recovery.failReplayRecovery();
        void fallbackToSnapshotRecovery();
        return;
      }

      if (!disposed && recovery.completeReplayRecovery()) {
        void recoverFromSequenceGap();
      }
    };

    const runSnapshotRecovery = async (reason: "bootstrap" | "replay-failed"): Promise<void> => {
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
        const snapshot = await api.orchestration.getSnapshot();
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
      } catch {
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
      const action = recovery.classifyDomainEvent(event.sequence);
      if (action === "apply") {
        pendingDomainEvents.push(event);
        schedulePendingDomainEventFlush();
        return;
      }
      if (action === "recover") {
        flushPendingDomainEvents();
        void recoverFromSequenceGap();
      }
    });
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
      flushPendingDomainEventsScheduled = false;
      pendingDomainEvents.length = 0;
      queryInvalidationThrottler.cancel();
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
