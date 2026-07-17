import {
  type ChatAttachment,
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationThreadResumeState,
  PROVIDER_DISPLAY_NAMES,
  ProviderKind,
  TEXT_GENERATION_PROVIDER_KINDS,
  type OrchestrationSession,
  type ServerProvider,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  type ThreadGoal,
  type TurnId,
} from "contracts";
import {
  Cache,
  Cause,
  Deferred,
  Duration,
  Effect,
  Equal,
  Exit,
  Layer,
  Option,
  Schema,
  Stream,
  type Scope,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { makeDrainableWorker } from "shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { isAutomationThread } from "../../automations/threadIdentity.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { ProviderAdapterRequestError, ProviderServiceError } from "../../provider/Errors.ts";
import { CODEX_SPARK_MODEL } from "../../provider/codexAccount.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import {
  incompleteKanbanItemsAssignedToThread,
  newGoalCompletionSortKey,
} from "../goalCompletion.ts";
import { renderThreadGoalInput } from "../threadGoalHarness.ts";

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.interaction-mode-set"
      | "thread.goal-updated"
      | "thread.goal-cleared"
      | "thread.goal-continuation-requested"
      | "thread.session-set"
      | "thread.session-ensure-requested"
      | "thread.turn-start-requested"
      | "thread.turn-steer-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const HANDLED_GOAL_CONTINUATION_SOURCE_MAX = 20_000;
const HANDLED_GOAL_CONTINUATION_SOURCE_TTL = Duration.hours(24);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const WORKTREE_BRANCH_PREFIX = "shioricode";
const TEMP_WORKTREE_BRANCH_PATTERN = new RegExp(`^${WORKTREE_BRANCH_PREFIX}\\/[0-9a-f]{8}$`);
const DEFAULT_THREAD_TITLE = "New Thread";
const THREAD_METADATA_TEXT_GENERATION_PROVIDERS = new Set<ProviderKind>(
  TEXT_GENERATION_PROVIDER_KINDS,
);

function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = Cause.squash(cause);
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function shouldStartFreshCodexSessionForModelSwitch(input: {
  readonly requestedModelSelection?: ModelSelection;
  readonly activeSessionModel: string | undefined;
}): boolean {
  return (
    input.requestedModelSelection?.provider === "codex" &&
    input.requestedModelSelection.model === CODEX_SPARK_MODEL &&
    input.activeSessionModel !== CODEX_SPARK_MODEL
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = Cause.squash(cause);
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    return error.detail.toLowerCase().includes("unknown pending user-input request");
  }
  return Cause.pretty(cause).toLowerCase().includes("unknown pending user-input request");
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function providerFailureDetail(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (
    typeof error === "object" &&
    error !== null &&
    "detail" in error &&
    typeof error.detail === "string"
  ) {
    return error.detail;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return Cause.pretty(cause);
}

function isPendingProviderCheckMessage(message: string | undefined): boolean {
  return typeof message === "string" && /^Checking\b/i.test(message.trim());
}

function providerNotReadyDetail(
  provider: ProviderKind,
  snapshot: ServerProvider | null,
): string | undefined {
  if (!snapshot) {
    return undefined;
  }

  if (snapshot.status === "ready") {
    return undefined;
  }

  if (snapshot.status === "warning" && isPendingProviderCheckMessage(snapshot.message)) {
    return undefined;
  }

  const providerLabel = PROVIDER_DISPLAY_NAMES[provider] ?? provider;
  return (
    snapshot.message ??
    (!snapshot.enabled
      ? `${providerLabel} is disabled in settings.`
      : `${providerLabel} is not ready yet. Resolve the provider warning before starting a turn.`)
  );
}

function isTemporaryWorktreeBranch(branch: string): boolean {
  return TEMP_WORKTREE_BRANCH_PATTERN.test(branch.trim().toLowerCase());
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const git = yield* GitCore;
  const textGeneration = yield* TextGeneration;
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const handledGoalContinuationSources = yield* Cache.make<string, true>({
    capacity: HANDLED_GOAL_CONTINUATION_SOURCE_MAX,
    timeToLive: HANDLED_GOAL_CONTINUATION_SOURCE_TTL,
    lookup: () => Effect.succeed(true),
  });
  const hasHandledGoalContinuationSourceRecently = (key: string) =>
    Cache.getOption(handledGoalContinuationSources, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledGoalContinuationSources, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();
  const latestUserMessageSequenceByThread = new Map<ThreadId, number>();
  // Keep one continuation latched per thread until the provider proves that
  // the accepted turn actually started. This closes the projection window in
  // which multiple durable continuation facts can otherwise cross the
  // provider boundary, while allowing later source-less resumes (for example
  // plan -> default mode) after that turn has begun.
  const inFlightTurnDispatches = new Map<
    ThreadId,
    { readonly key: string; readonly messageId: MessageId; readonly latchedAt: number }
  >();
  type DeferredTurnStart = Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>;
  const deferredTurnStarts = new Map<ThreadId, ReadonlyArray<DeferredTurnStart>>();
  const enqueueDeferredTurnStart = (event: DeferredTurnStart) => {
    const queued = deferredTurnStarts.get(event.payload.threadId) ?? [];
    if (queued.some((entry) => entry.payload.messageId === event.payload.messageId)) return;
    deferredTurnStarts.set(event.payload.threadId, [...queued, event]);
  };
  const takeDeferredTurnStart = (threadId: ThreadId): DeferredTurnStart | undefined => {
    const queued = deferredTurnStarts.get(threadId);
    const next = queued?.[0];
    if (!next) return undefined;
    if (queued.length === 1) {
      deferredTurnStarts.delete(threadId);
    } else {
      deferredTurnStarts.set(threadId, queued.slice(1));
    }
    return next;
  };
  const threadsWithObservedRunningTurn = new Set<ThreadId>();
  const IN_FLIGHT_TURN_DISPATCH_TIMEOUT_MS = 60_000;
  const inFlightTurnDispatch = (threadId: ThreadId) => {
    const entry = inFlightTurnDispatches.get(threadId);
    if (!entry) return null;
    if (Date.now() - entry.latchedAt <= IN_FLIGHT_TURN_DISPATCH_TIMEOUT_MS) {
      return entry;
    }
    inFlightTurnDispatches.delete(threadId);
    return null;
  };
  const latchTurnDispatch = (threadId: ThreadId, key: string, messageId: MessageId) =>
    inFlightTurnDispatches.set(threadId, { key, messageId, latchedAt: Date.now() });
  const deletePendingTurnStart = (threadId: ThreadId, messageId: MessageId) =>
    projectionTurnRepository.deletePendingTurnStart({ threadId, messageId });
  const discardIgnoredGoalContinuation = (
    event: Extract<ProviderIntentEvent, { type: "thread.goal-continuation-requested" }>,
  ) => {
    const inFlight = inFlightTurnDispatch(event.payload.threadId);
    // Reconcile can process the same durable fact concurrently with the hot
    // stream. Keep the row owned by that exact provider send until a physical
    // turn id consumes it or the send fails.
    return inFlight?.messageId === event.payload.messageId
      ? Effect.void
      : deletePendingTurnStart(event.payload.threadId, event.payload.messageId);
  };
  const inFlightSessionEnsures = new Map<ThreadId, Deferred.Deferred<ThreadId, unknown>>();
  const inFlightSessionEnsuresSemaphore = yield* Semaphore.make(1);

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.steer.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-failure-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: input.kind,
        summary: input.summary,
        payload: {
          detail: input.detail,
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("provider-session-set"),
      threadId: input.threadId,
      session: input.session,
      createdAt: input.createdAt,
    });

  const setThreadResumeState = (input: {
    readonly threadId: ThreadId;
    readonly resumeState: OrchestrationThreadResumeState;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.resume-state.set",
      commandId: serverCommandId("provider-resume-state-set"),
      threadId: input.threadId,
      resumeState: input.resumeState,
      createdAt: input.createdAt,
    });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    return readModel.threads.find((entry) => entry.id === threadId);
  });

  const setThreadGoalSnapshot = (goal: ThreadGoal) =>
    orchestrationEngine.dispatch({
      type: "thread.goal.snapshot.set",
      commandId: serverCommandId("provider-goal-snapshot-set"),
      threadId: goal.threadId,
      goal,
      createdAt: goal.updatedAt,
    });

  const ensureSessionForThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly updateResumeState?: boolean;
    },
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const currentProvider: ProviderKind | undefined = Schema.is(ProviderKind)(
      thread.session?.providerName,
    )
      ? thread.session.providerName
      : undefined;
    const requestedModelSelection = options?.modelSelection;
    const shouldUpdateResumeState = options?.updateResumeState !== false;
    const threadProvider: ProviderKind = currentProvider ?? thread.modelSelection.provider;
    if (
      requestedModelSelection !== undefined &&
      requestedModelSelection.provider !== threadProvider
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: threadProvider,
        method: "thread.turn.start",
        detail: `Thread '${threadId}' is bound to provider '${threadProvider}' and cannot switch to '${requestedModelSelection.provider}'.`,
      });
    }
    const preferredProvider: ProviderKind = currentProvider ?? threadProvider;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });

    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderKind;
    }) =>
      providerService.startSession(threadId, {
        threadId,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        modelSelection: desiredModelSelection,
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimeMode: desiredRuntimeMode,
      });

    const bindSessionToThread = (session: ProviderSession) =>
      setThreadSession({
        threadId,
        session: {
          threadId,
          status: mapProviderSessionStatusToOrchestrationStatus(session.status),
          providerName: session.provider,
          runtimeMode: desiredRuntimeMode,
          // Provider turn ids are not orchestration turn ids.
          activeTurnId: null,
          goalLifecycleKey: null,
          lastError: session.lastError ?? null,
          updatedAt: session.updatedAt,
        },
        createdAt,
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" ? thread.id : null;
    if (existingSessionThreadId) {
      const activeSession = yield* resolveActiveSession(existingSessionThreadId);
      if (!activeSession) {
        yield* Effect.logInfo("provider command reactor recreating missing provider session", {
          threadId,
          currentProvider,
          desiredProvider: desiredModelSelection.provider,
          desiredRuntimeMode: desiredRuntimeMode,
        });
        if (shouldUpdateResumeState) {
          yield* setThreadResumeState({
            threadId,
            resumeState: "resuming",
            createdAt,
          });
        }
        const restartedSession = yield* startProviderSession(undefined);
        yield* bindSessionToThread(restartedSession);
        if (shouldUpdateResumeState) {
          yield* setThreadResumeState({
            threadId,
            resumeState: "resumed",
            createdAt,
          });
        }
        return restartedSession.threadId;
      }

      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const providerChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.provider !== currentProvider;
      const sessionModelSwitch =
        currentProvider === undefined
          ? "in-session"
          : (yield* providerService.getCapabilities(currentProvider)).sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const shouldRestartForModelChange =
        modelChanged &&
        (sessionModelSwitch === "restart-session" ||
          shouldStartFreshCodexSessionForModelSwitch({
            requestedModelSelection,
            activeSessionModel: activeSession?.model,
          }));
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        currentProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !providerChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        return existingSessionThreadId;
      }

      const resumeCursor =
        providerChanged || shouldRestartForModelChange
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider,
        desiredProvider: desiredModelSelection.provider,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        providerChanged,
        modelChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      if (shouldUpdateResumeState) {
        yield* setThreadResumeState({
          threadId,
          resumeState: "resuming",
          createdAt,
        });
      }
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
      });
      yield* bindSessionToThread(restartedSession);
      if (shouldUpdateResumeState) {
        yield* setThreadResumeState({
          threadId,
          resumeState: "resumed",
          createdAt,
        });
      }
      return restartedSession.threadId;
    }

    if (shouldUpdateResumeState) {
      yield* setThreadResumeState({
        threadId,
        resumeState: "resuming",
        createdAt,
      });
    }
    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    if (shouldUpdateResumeState) {
      yield* setThreadResumeState({
        threadId,
        resumeState: "resumed",
        createdAt,
      });
    }
    return startedSession.threadId;
  });

  const ensureSessionForThreadShared = Effect.fnUntraced(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly updateResumeState?: boolean;
    },
  ) {
    const acquired = yield* inFlightSessionEnsuresSemaphore.withPermit(
      Effect.gen(function* () {
        const existing = inFlightSessionEnsures.get(threadId);
        if (existing) {
          return { deferred: existing, owner: false } as const;
        }

        const deferred = yield* Deferred.make<ThreadId, unknown>();
        inFlightSessionEnsures.set(threadId, deferred);
        return { deferred, owner: true } as const;
      }),
    );

    if (!acquired.owner) {
      return yield* Deferred.await(acquired.deferred);
    }

    const clearInFlight = inFlightSessionEnsuresSemaphore.withPermit(
      Effect.sync(() => {
        inFlightSessionEnsures.delete(threadId);
      }),
    );

    const exit = yield* Effect.exit(
      ensureSessionForThread(threadId, createdAt, options).pipe(Effect.ensuring(clearInFlight)),
    );

    if (Exit.isSuccess(exit)) {
      yield* Deferred.succeed(acquired.deferred, exit.value).pipe(Effect.orDie);
      return exit.value;
    }

    yield* Deferred.failCause(acquired.deferred, exit.cause).pipe(Effect.orDie);
    return yield* Effect.failCause(exit.cause);
  });

  const patchThreadGoal = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly objective?: string;
    readonly status?: ThreadGoal["status"];
    readonly tokenBudget?: number | null;
    readonly requestedAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return null;
    }

    const previous = thread.goal;
    if (!previous && input.objective === undefined) {
      return null;
    }
    const goal: ThreadGoal = {
      threadId: input.threadId,
      ...(previous?.lifecycleId !== undefined ? { lifecycleId: previous.lifecycleId } : {}),
      objective: input.objective ?? previous!.objective,
      status: input.status ?? previous?.status ?? "active",
      tokenBudget:
        input.tokenBudget !== undefined ? input.tokenBudget : (previous?.tokenBudget ?? null),
      tokensUsed: previous?.tokensUsed ?? 0,
      timeUsedSeconds: previous?.timeUsedSeconds ?? 0,
      createdAt: previous?.createdAt ?? input.requestedAt,
      updatedAt: input.requestedAt,
    };
    yield* setThreadGoalSnapshot(goal);
    return goal;
  });

  const harnessGoalCommandId = (
    tag: string,
    threadId: ThreadId,
    completedAt: string,
    suffix = "",
  ) =>
    CommandId.makeUnsafe(
      `server:harness-goal:${tag}:${threadId}:${completedAt}${suffix.length > 0 ? `:${suffix}` : ""}`,
    );

  const finalizeHarnessGoal = Effect.fnUntraced(function* (
    threadId: ThreadId,
    completedAt: string,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    for (const item of incompleteKanbanItemsAssignedToThread(readModel, threadId)) {
      yield* orchestrationEngine.dispatch({
        type: "kanbanItem.complete",
        commandId: harnessGoalCommandId("kanban-complete", threadId, completedAt, String(item.id)),
        itemId: item.id,
        sortKey: newGoalCompletionSortKey(),
        completedAt,
      });
    }

    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (
      thread &&
      isAutomationThread(thread) &&
      thread.session !== null &&
      thread.session.status !== "stopped"
    ) {
      yield* orchestrationEngine.dispatch({
        type: "thread.session.stop",
        commandId: harnessGoalCommandId("session-stop", threadId, completedAt),
        threadId,
        createdAt: completedAt,
      });
    }
  });

  const ensureProviderReadyForTurn = Effect.fnUntraced(function* (provider: ProviderKind) {
    const providers = yield* providerRegistry.getProviders;
    const snapshot = providers.find((entry) => entry.provider === provider) ?? null;
    const detail = providerNotReadyDetail(provider, snapshot);
    if (!detail) {
      return;
    }

    return yield* new ProviderAdapterRequestError({
      provider,
      method: "thread.turn.start",
      detail,
    });
  });

  const ensureTurnSession = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly modelSelection?: ModelSelection;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return null;
    }
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    yield* ensureProviderReadyForTurn(requestedModelSelection.provider);
    yield* ensureSessionForThreadShared(
      input.threadId,
      input.createdAt,
      input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {},
    );
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    return { thread, requestedModelSelection } as const;
  });

  const sendTurnForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly goalLifecycleKey: string | null;
    readonly createdAt: string;
  }) {
    const prepared = yield* ensureTurnSession(input);
    if (!prepared) {
      return;
    }
    const { requestedModelSelection } = prepared;
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : (yield* providerService.getCapabilities(activeSession.provider)).sessionModelSwitch;
    const modelForTurn =
      sessionModelSwitch === "unsupported"
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;
    let currentThread = yield* resolveThread(input.threadId);
    const currentGoalLifecycleKey =
      currentThread?.goal?.lifecycleId ?? currentThread?.goal?.createdAt ?? null;
    const goalForTurn =
      input.goalLifecycleKey !== null && currentGoalLifecycleKey === input.goalLifecycleKey
        ? currentThread?.goal
        : null;
    const renderedInput = renderThreadGoalInput({
      text: input.messageText,
      goal: goalForTurn,
      interactionMode: input.interactionMode ?? currentThread?.interactionMode,
    });
    const boundGoalLifecycleKey =
      goalForTurn?.status === "active" &&
      (input.interactionMode ?? currentThread?.interactionMode) !== "plan"
        ? input.goalLifecycleKey
        : null;

    // Publish the harness binding before releasing the prompt to the provider.
    // A provider can invoke its mandatory goal tool immediately from sendTurn;
    // waiting for an asynchronous turn.started event would make that first
    // tool call race the runtime-ingestion queue.
    if (
      boundGoalLifecycleKey !== null &&
      currentThread?.session &&
      currentThread.session.status !== "running" &&
      currentThread.session.activeTurnId === null
    ) {
      const preboundAt = new Date().toISOString();
      yield* setThreadSession({
        threadId: currentThread.id,
        session: {
          ...currentThread.session,
          goalLifecycleKey: boundGoalLifecycleKey,
          updatedAt:
            currentThread.session.updatedAt > preboundAt
              ? currentThread.session.updatedAt
              : preboundAt,
        },
        createdAt: preboundAt,
      });
      currentThread = yield* resolveThread(input.threadId);
    }

    const sessionRevisionBeforeSend = currentThread?.session
      ? {
          status: currentThread.session.status,
          activeTurnId: currentThread.session.activeTurnId,
          updatedAt: currentThread.session.updatedAt,
        }
      : null;

    const clearFailedPrebinding = Effect.gen(function* () {
      if (boundGoalLifecycleKey === null) return;
      const latest = yield* resolveThread(input.threadId);
      if (
        !latest?.session ||
        latest.session.status === "running" ||
        latest.session.activeTurnId !== null ||
        latest.session.goalLifecycleKey !== boundGoalLifecycleKey
      ) {
        return;
      }
      const clearedAt = new Date().toISOString();
      yield* setThreadSession({
        threadId: latest.id,
        session: {
          ...latest.session,
          goalLifecycleKey: null,
          updatedAt: latest.session.updatedAt > clearedAt ? latest.session.updatedAt : clearedAt,
        },
        createdAt: clearedAt,
      });
    });

    const providerTurn = yield* providerService
      .sendTurn({
        threadId: input.threadId,
        messageId: input.messageId,
        ...(renderedInput ? { input: renderedInput } : {}),
        ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
        ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      })
      .pipe(Effect.onError(() => clearFailedPrebinding.pipe(Effect.ignore({ log: false }))));
    const latestThread = yield* resolveThread(input.threadId);
    const latestSession = latestThread?.session;
    if (latestThread && latestSession) {
      const persistedTurn = yield* projectionTurnRepository.getByTurnId({
        threadId: latestThread.id,
        turnId: providerTurn.turnId,
      });
      const providerAlreadyClosedTurn =
        Option.isSome(persistedTurn) &&
        persistedTurn.value.state !== "pending" &&
        persistedTurn.value.state !== "running";
      const sessionChangedWhileSending =
        sessionRevisionBeforeSend !== null &&
        (latestSession.status !== sessionRevisionBeforeSend.status ||
          latestSession.activeTurnId !== sessionRevisionBeforeSend.activeTurnId ||
          latestSession.updatedAt !== sessionRevisionBeforeSend.updatedAt);
      const newerTerminalSession =
        sessionChangedWhileSending &&
        latestSession.status !== "running" &&
        latestSession.activeTurnId === null;
      const conflictingRunningTurn =
        latestSession.status === "running" &&
        latestSession.activeTurnId !== null &&
        latestSession.activeTurnId !== providerTurn.turnId;
      if (providerAlreadyClosedTurn || newerTerminalSession || conflictingRunningTurn) {
        return providerTurn;
      }
      const acceptedAt = new Date().toISOString();
      yield* setThreadSession({
        threadId: latestThread.id,
        session: {
          ...latestSession,
          status: "running",
          providerName: latestSession.providerName ?? requestedModelSelection.provider,
          activeTurnId: providerTurn.turnId,
          goalLifecycleKey: boundGoalLifecycleKey,
          lastError: null,
          updatedAt: latestSession.updatedAt > acceptedAt ? latestSession.updatedAt : acceptedAt,
        },
        createdAt: acceptedAt,
      });
    }
    return providerTurn;
  });

  const bindActiveTurnToGoal = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId;
    readonly goalLifecycleKey: string;
  }) {
    const latestThread = yield* resolveThread(input.threadId);
    const latestSession = latestThread?.session;
    const activeTurnId = input.turnId ?? latestSession?.activeTurnId ?? null;
    const latestGoalLifecycleKey =
      latestThread?.goal?.lifecycleId ?? latestThread?.goal?.createdAt ?? null;
    if (
      !latestThread ||
      !latestSession ||
      activeTurnId === null ||
      latestSession.activeTurnId !== activeTurnId ||
      latestGoalLifecycleKey !== input.goalLifecycleKey
    ) {
      return;
    }

    const boundAt = new Date().toISOString();
    yield* setThreadSession({
      threadId: latestThread.id,
      session: {
        ...latestSession,
        goalLifecycleKey: input.goalLifecycleKey,
        updatedAt: latestSession.updatedAt > boundAt ? latestSession.updatedAt : boundAt,
      },
      createdAt: boundAt,
    });
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection: ModelSelection;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection: input.modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* git.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly titleSeed?: string;
    readonly modelSelection: ModelSelection;
  }) {
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const generated = yield* textGeneration.generateThreadTitle({
        cwd: input.cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection: input.modelSelection,
      });
      if (!generated) return;

      const thread = yield* resolveThread(input.threadId);
      if (!thread) return;
      if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
        return;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("thread-title-rename"),
        threadId: input.threadId,
        title: generated.title,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename thread title", {
          threadId: input.threadId,
          cwd: input.cwd,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const processTurnStartRequested: (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
    options?: { readonly skipDeduplication?: boolean },
  ) => Effect.Effect<void, OrchestrationDispatchError, Scope.Scope> = Effect.fnUntraced(
    function* (event, options) {
      const key = turnStartKeyForEvent(event);
      if (!options?.skipDeduplication && (yield* hasHandledTurnStartRecently(key))) {
        return;
      }

      if (inFlightTurnDispatch(event.payload.threadId)) {
        // The command was already accepted durably, but another physical send is
        // crossing the provider boundary. Queue the request and run it
        // after that turn reaches a terminal session state.
        enqueueDeferredTurnStart(event);
        return;
      }

      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        yield* deletePendingTurnStart(event.payload.threadId, event.payload.messageId);
        return;
      }
      const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
      if (!message || message.role !== "user") {
        yield* deletePendingTurnStart(event.payload.threadId, event.payload.messageId);
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.start.failed",
          summary: "Provider turn start failed",
          detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
          turnId: null,
          createdAt: event.payload.createdAt,
        });
        return;
      }

      const isFirstUserMessageTurn =
        thread.messages.filter((entry) => entry.role === "user").length === 1;
      if (isFirstUserMessageTurn) {
        const generationModelSelection = event.payload.modelSelection ?? thread.modelSelection;
        const canGenerateThreadMetadata = THREAD_METADATA_TEXT_GENERATION_PROVIDERS.has(
          generationModelSelection.provider,
        );
        const generationCwd =
          resolveThreadWorkspaceCwd({
            thread,
            projects: (yield* orchestrationEngine.getReadModel()).projects,
          }) ?? process.cwd();
        const generationInput = {
          messageText: message.text,
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
        };

        if (canGenerateThreadMetadata) {
          yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
            threadId: event.payload.threadId,
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            modelSelection: generationModelSelection,
            ...generationInput,
          }).pipe(Effect.forkScoped);

          if (canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
            yield* maybeGenerateThreadTitleForFirstTurn({
              threadId: event.payload.threadId,
              cwd: generationCwd,
              modelSelection: generationModelSelection,
              ...generationInput,
            }).pipe(Effect.forkScoped);
          }
        }
      }

      const sendInput = {
        threadId: event.payload.threadId,
        messageId: event.payload.messageId,
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: event.payload.modelSelection }
          : {}),
        interactionMode: event.payload.interactionMode,
        goalLifecycleKey: event.payload.goalLifecycleKey ?? null,
        createdAt: event.payload.createdAt,
      } as const;
      const attemptedGoalLifecycleKey = event.payload.goalLifecycleKey ?? null;

      // Goal state is already persisted by the same orchestration command that
      // emitted this request. Every provider now receives exactly one ordinary
      // turn; the harness renders the active goal into that turn's input.
      const dispatchKey = `turn-start:${event.eventId}`;
      latchTurnDispatch(thread.id, dispatchKey, event.payload.messageId);
      const sent = yield* sendTurnForThread(sendInput).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* deletePendingTurnStart(event.payload.threadId, event.payload.messageId);
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.turn.start.failed",
              summary: "Provider turn start failed",
              detail: providerFailureDetail(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
            });
            yield* setThreadResumeState({
              threadId: event.payload.threadId,
              resumeState: "needs_resume",
              createdAt: event.payload.createdAt,
            }).pipe(Effect.ignore);
            if (attemptedGoalLifecycleKey !== null) {
              yield* orchestrationEngine
                .dispatch({
                  type: "thread.goal.status.report",
                  commandId: CommandId.makeUnsafe(
                    `server:harness-goal-initial-send-failed:${event.eventId}`,
                  ),
                  threadId: event.payload.threadId,
                  expectedGoalLifecycleKey: attemptedGoalLifecycleKey,
                  status: "blocked",
                  createdAt: new Date().toISOString(),
                })
                .pipe(Effect.ignore({ log: false }));
            }
            return false;
          }),
        ),
      );
      if (!sent) {
        if (inFlightTurnDispatches.get(thread.id)?.key === dispatchKey) {
          inFlightTurnDispatches.delete(thread.id);
        }
        const latestThread = yield* resolveThread(thread.id);
        const latestGoal = latestThread?.goal;
        if (
          latestThread &&
          latestGoal?.status === "active" &&
          latestThread.interactionMode !== "plan" &&
          (latestGoal.lifecycleId ?? latestGoal.createdAt) !== attemptedGoalLifecycleKey &&
          latestThread.session?.status !== "running" &&
          (latestThread.session?.activeTurnId ?? null) === null
        ) {
          yield* orchestrationEngine
            .dispatch({
              type: "thread.goal.continue",
              commandId: CommandId.makeUnsafe(
                `server:harness-goal-replacement-after-send-failure:${event.eventId}`,
              ),
              threadId: latestThread.id,
              expectedGoalLifecycleKey: latestGoal.lifecycleId ?? latestGoal.createdAt,
              createdAt: new Date().toISOString(),
            })
            .pipe(Effect.ignore({ log: false }));
        }
        const deferred = takeDeferredTurnStart(thread.id);
        if (deferred) {
          yield* processTurnStartRequested(deferred, { skipDeduplication: true });
        }
      }
    },
  );

  const processTurnSteerRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-steer-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.steer.failed",
        summary: "Provider turn steer failed",
        detail: `User message '${event.payload.messageId}' was not found for turn steer request.`,
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.steer.failed",
        summary: "Provider turn steer failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    const normalizedInput = toNonEmptyProviderInput(message.text);
    if (!normalizedInput) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.steer.failed",
        summary: "Provider turn steer failed",
        detail: "Steering input cannot be empty.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    const currentGoalLifecycleKey = thread.goal?.lifecycleId ?? thread.goal?.createdAt ?? null;
    const goalForSteer =
      event.payload.goalLifecycleKey != null &&
      currentGoalLifecycleKey === event.payload.goalLifecycleKey
        ? thread.goal
        : null;
    const providerInput = renderThreadGoalInput({
      text: normalizedInput,
      goal: goalForSteer,
      interactionMode: thread.interactionMode,
    });
    if (!providerInput) {
      return;
    }

    const activeTurnId = event.payload.turnId ?? thread.session?.activeTurnId ?? null;
    const previousGoalLifecycleKey = thread.session?.goalLifecycleKey ?? null;
    const shouldPrebindGoal =
      event.payload.goalLifecycleKey != null &&
      goalForSteer?.status === "active" &&
      thread.session?.status === "running" &&
      activeTurnId !== null;
    if (shouldPrebindGoal) {
      yield* bindActiveTurnToGoal({
        threadId: event.payload.threadId,
        turnId: activeTurnId,
        goalLifecycleKey: event.payload.goalLifecycleKey,
      });
    }

    const steered = yield* providerService
      .steerTurn({
        threadId: event.payload.threadId,
        messageId: event.payload.messageId,
        input: providerInput,
        ...(event.payload.turnId !== undefined ? { turnId: event.payload.turnId } : {}),
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.steer.failed",
            summary: "Provider turn steer failed",
            detail: providerFailureDetail(cause),
            turnId: event.payload.turnId ?? null,
            createdAt: event.payload.createdAt,
          }).pipe(Effect.as(false)),
        ),
      );
    if (!steered) {
      if (shouldPrebindGoal) {
        const latest = yield* resolveThread(event.payload.threadId);
        if (
          latest?.session?.status === "running" &&
          latest.session.activeTurnId === activeTurnId &&
          latest.session.goalLifecycleKey === event.payload.goalLifecycleKey
        ) {
          const restoredAt = new Date().toISOString();
          yield* setThreadSession({
            threadId: latest.id,
            session: {
              ...latest.session,
              goalLifecycleKey: previousGoalLifecycleKey,
              updatedAt:
                latest.session.updatedAt > restoredAt ? latest.session.updatedAt : restoredAt,
            },
            createdAt: restoredAt,
          });
        }
      }
      return;
    }

    if (event.payload.goalLifecycleKey != null) {
      yield* bindActiveTurnToGoal({
        threadId: event.payload.threadId,
        ...(event.payload.turnId !== undefined ? { turnId: event.payload.turnId } : {}),
        goalLifecycleKey: event.payload.goalLifecycleKey,
      });
    }
  });

  const processGoalUpdated = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.goal-updated" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    const currentGoal = thread?.goal;
    const eventGoal = event.payload.goal;
    if (
      !thread ||
      !currentGoal ||
      (currentGoal.lifecycleId ?? currentGoal.createdAt) !==
        (eventGoal.lifecycleId ?? eventGoal.createdAt) ||
      currentGoal.updatedAt !== eventGoal.updatedAt ||
      currentGoal.status !== eventGoal.status
    ) {
      return;
    }
    const eventGoalLifecycleKey = eventGoal.lifecycleId ?? eventGoal.createdAt;
    const activeTurnOwnsEventGoal =
      thread.session?.status === "running" &&
      thread.session.activeTurnId !== null &&
      thread.session.goalLifecycleKey === eventGoalLifecycleKey;

    if (
      (eventGoal.status === "budgetLimited" ||
        (eventGoal.status === "paused" && event.metadata.threadGoalMutation !== "interrupt")) &&
      activeTurnOwnsEventGoal
    ) {
      // The harness projects the factual stop condition before interrupting the
      // provider, so every adapter observes the same budget/pause policy.
      yield* providerService.interruptTurn({ threadId: thread.id }).pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: thread.id,
            kind: "provider.turn.interrupt.failed",
            summary:
              eventGoal.status === "budgetLimited"
                ? "Budget-limited goal turn interrupt failed"
                : "Paused goal turn interrupt failed",
            detail: providerFailureDetail(cause),
            turnId: thread.session?.activeTurnId ?? null,
            createdAt: eventGoal.updatedAt,
          }),
        ),
      );
      return;
    }

    const isUserMutation = event.metadata.threadGoalMutation === "user";
    if (eventGoal.status === "active" && isUserMutation) {
      if (thread.session?.status === "running") {
        if (thread.session.providerName !== "codex") {
          return;
        }
        const input = renderThreadGoalInput({
          text: undefined,
          goal: eventGoal,
          interactionMode: thread.interactionMode,
        });
        if (input) {
          const activeTurnId = thread.session.activeTurnId;
          const previousGoalLifecycleKey = thread.session.goalLifecycleKey ?? null;
          const latestBeforeSteer = yield* resolveThread(thread.id);
          const sessionBeforeSteer = latestBeforeSteer?.session;
          const shouldPrebindGoal =
            latestBeforeSteer !== undefined &&
            sessionBeforeSteer?.status === "running" &&
            sessionBeforeSteer.activeTurnId === activeTurnId &&
            (latestBeforeSteer.goal?.lifecycleId ?? latestBeforeSteer.goal?.createdAt ?? null) ===
              eventGoalLifecycleKey &&
            sessionBeforeSteer.goalLifecycleKey !== eventGoalLifecycleKey;
          if (shouldPrebindGoal) {
            const preboundAt = new Date().toISOString();
            yield* setThreadSession({
              threadId: latestBeforeSteer.id,
              session: {
                ...sessionBeforeSteer,
                goalLifecycleKey: eventGoalLifecycleKey,
                updatedAt:
                  sessionBeforeSteer.updatedAt > preboundAt
                    ? sessionBeforeSteer.updatedAt
                    : preboundAt,
              },
              createdAt: preboundAt,
            });
          }
          const steered = yield* providerService
            .steerTurn({
              threadId: thread.id,
              messageId: MessageId.makeUnsafe(`goal-update:${event.eventId}`),
              input,
              ...(activeTurnId !== null ? { turnId: activeTurnId } : {}),
            })
            .pipe(
              Effect.as(true),
              Effect.catchCause((cause) =>
                appendProviderFailureActivity({
                  threadId: thread.id,
                  kind: "provider.turn.steer.failed",
                  summary: "Goal update steer failed",
                  detail: providerFailureDetail(cause),
                  turnId: thread.session?.activeTurnId ?? null,
                  createdAt: eventGoal.updatedAt,
                }).pipe(Effect.as(false)),
              ),
            );
          if (!steered && shouldPrebindGoal) {
            const latest = yield* resolveThread(thread.id);
            if (
              latest?.session?.status === "running" &&
              latest.session.activeTurnId === activeTurnId &&
              latest.session.goalLifecycleKey === eventGoalLifecycleKey
            ) {
              const restoredAt = new Date().toISOString();
              yield* setThreadSession({
                threadId: latest.id,
                session: {
                  ...latest.session,
                  goalLifecycleKey: previousGoalLifecycleKey,
                  updatedAt:
                    latest.session.updatedAt > restoredAt ? latest.session.updatedAt : restoredAt,
                },
                createdAt: restoredAt,
              });
            }
          } else if (steered && activeTurnId !== null) {
            yield* bindActiveTurnToGoal({
              threadId: thread.id,
              turnId: activeTurnId,
              goalLifecycleKey: eventGoalLifecycleKey,
            });
          }
        }
        return;
      }

      if (thread.interactionMode !== "plan" && (thread.session?.activeTurnId ?? null) === null) {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.goal.continue",
            commandId: CommandId.makeUnsafe(
              `server:harness-goal-user-continuation:${event.eventId}`,
            ),
            threadId: thread.id,
            expectedGoalLifecycleKey: eventGoal.lifecycleId ?? eventGoal.createdAt,
            createdAt: eventGoal.updatedAt,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logDebug("provider command reactor skipped user goal continuation", {
                threadId: thread.id,
                cause: Cause.pretty(cause),
              }),
            ),
          );
      }
      return;
    }

    if (eventGoal.status === "complete" && isUserMutation && activeTurnOwnsEventGoal) {
      yield* providerService.interruptTurn({ threadId: thread.id }).pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: thread.id,
            kind: "provider.turn.interrupt.failed",
            summary: "Completed goal turn interrupt failed",
            detail: providerFailureDetail(cause),
            turnId: thread.session?.activeTurnId ?? null,
            createdAt: eventGoal.updatedAt,
          }),
        ),
      );
      return;
    }

    if (
      eventGoal.status === "complete" &&
      thread.session?.status !== "running" &&
      (thread.session?.activeTurnId ?? null) === null
    ) {
      yield* finalizeHarnessGoal(thread.id, eventGoal.updatedAt);
    }
  });

  const processGoalCleared = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.goal-cleared" }>,
  ) {
    if (event.metadata.threadGoalMutation !== "user") return;
    const thread = yield* resolveThread(event.payload.threadId);
    if (
      thread?.session?.status !== "running" ||
      thread.session.activeTurnId === null ||
      event.payload.goalLifecycleKey === undefined ||
      thread.session.goalLifecycleKey !== event.payload.goalLifecycleKey
    ) {
      return;
    }
    yield* providerService.interruptTurn({ threadId: thread.id }).pipe(
      Effect.catchCause((cause) =>
        appendProviderFailureActivity({
          threadId: thread.id,
          kind: "provider.turn.interrupt.failed",
          summary: "Cleared goal turn interrupt failed",
          detail: providerFailureDetail(cause),
          turnId: thread.session?.activeTurnId ?? null,
          createdAt: event.payload.clearedAt,
        }),
      ),
    );
  });

  const processGoalContinuationRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.goal-continuation-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    const goal = thread?.goal;
    if (
      !thread ||
      !goal ||
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      (goal.lifecycleId ?? goal.createdAt) !== event.payload.expectedGoalLifecycleKey ||
      goal.status !== "active" ||
      thread.interactionMode === "plan" ||
      thread.session?.status === "running" ||
      (thread.session?.activeTurnId ?? null) !== null
    ) {
      yield* discardIgnoredGoalContinuation(event);
      return;
    }

    // A user turn that was persisted after the idle continuation request wins
    // the race. Its own reactor event will carry the goal context.
    if ((latestUserMessageSequenceByThread.get(thread.id) ?? -1) > event.sequence) {
      yield* discardIgnoredGoalContinuation(event);
      return;
    }

    const continuationKey = `${thread.id}:${event.payload.expectedGoalLifecycleKey}:${event.payload.sourceTurnId ?? "idle"}`;
    if (inFlightTurnDispatch(thread.id)) {
      yield* discardIgnoredGoalContinuation(event);
      return;
    }
    if (
      event.payload.sourceTurnId !== undefined &&
      (yield* hasHandledGoalContinuationSourceRecently(continuationKey))
    ) {
      yield* discardIgnoredGoalContinuation(event);
      return;
    }
    latchTurnDispatch(thread.id, continuationKey, event.payload.messageId);

    const sent = yield* sendTurnForThread({
      threadId: thread.id,
      messageId: event.payload.messageId,
      messageText: "",
      interactionMode: "default",
      goalLifecycleKey: event.payload.expectedGoalLifecycleKey,
      createdAt: event.payload.createdAt,
    }).pipe(
      Effect.as(true),
      Effect.catchCause((cause) => {
        const failedAt = new Date().toISOString();
        return deletePendingTurnStart(thread.id, event.payload.messageId).pipe(
          Effect.andThen(
            Effect.all(
              [
                orchestrationEngine
                  .dispatch({
                    type: "thread.goal.status.report",
                    commandId: CommandId.makeUnsafe(
                      `server:harness-goal-continuation-failed:${event.eventId}`,
                    ),
                    threadId: thread.id,
                    expectedGoalLifecycleKey: event.payload.expectedGoalLifecycleKey,
                    status: "blocked",
                    createdAt: failedAt,
                  })
                  .pipe(Effect.ignore({ log: false })),
                appendProviderFailureActivity({
                  threadId: thread.id,
                  kind: "provider.turn.start.failed",
                  summary: "Goal continuation failed",
                  detail: providerFailureDetail(cause),
                  turnId: null,
                  createdAt: failedAt,
                }),
              ],
              { concurrency: "unbounded", discard: true },
            ),
          ),
          Effect.as(false),
        );
      }),
    );
    if (!sent && inFlightTurnDispatches.get(thread.id)?.key === continuationKey) {
      inFlightTurnDispatches.delete(thread.id);
      const latestThread = yield* resolveThread(thread.id);
      const latestGoal = latestThread?.goal;
      if (
        latestThread &&
        latestGoal?.status === "active" &&
        latestThread.interactionMode !== "plan" &&
        (latestGoal.lifecycleId ?? latestGoal.createdAt) !==
          event.payload.expectedGoalLifecycleKey &&
        latestThread.session?.status !== "running" &&
        (latestThread.session?.activeTurnId ?? null) === null
      ) {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.goal.continue",
            commandId: CommandId.makeUnsafe(
              `server:harness-goal-replacement-continuation:${event.eventId}`,
            ),
            threadId: latestThread.id,
            expectedGoalLifecycleKey: latestGoal.lifecycleId ?? latestGoal.createdAt,
            createdAt: new Date().toISOString(),
          })
          .pipe(Effect.ignore({ log: false }));
      }
      const deferred = takeDeferredTurnStart(thread.id);
      if (deferred) {
        yield* processTurnStartRequested(deferred, { skipDeduplication: true });
      }
    }
  });

  const processSessionSet = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-set" }>,
  ) {
    if (event.payload.session.status === "running") {
      inFlightTurnDispatches.delete(event.payload.threadId);
      threadsWithObservedRunningTurn.add(event.payload.threadId);
      return;
    }

    if (
      (event.payload.session.status === "ready" &&
        threadsWithObservedRunningTurn.has(event.payload.threadId)) ||
      event.payload.session.status === "error" ||
      event.payload.session.status === "interrupted" ||
      event.payload.session.status === "stopped"
    ) {
      inFlightTurnDispatches.delete(event.payload.threadId);
      threadsWithObservedRunningTurn.delete(event.payload.threadId);
      const deferred = takeDeferredTurnStart(event.payload.threadId);
      if (deferred) {
        yield* processTurnStartRequested(deferred, { skipDeduplication: true });
      }
    }

    const thread = yield* resolveThread(event.payload.threadId);
    const goal = thread?.goal;
    if (thread && goal?.status === "complete" && (thread.session?.activeTurnId ?? null) === null) {
      yield* finalizeHarnessGoal(thread.id, goal.updatedAt);
    }
  });

  const processSessionEnsureRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-ensure-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const requestedModelSelection =
      threadModelSelections.get(event.payload.threadId) ?? thread.modelSelection;

    const providerReady = yield* ensureProviderReadyForTurn(requestedModelSelection.provider).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logDebug("provider command reactor skipped background session warmup", {
          threadId: event.payload.threadId,
          provider: requestedModelSelection.provider,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );
    if (!providerReady) {
      return;
    }

    yield* ensureSessionForThreadShared(event.payload.threadId, event.occurredAt, {
      modelSelection: requestedModelSelection,
      updateResumeState: false,
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("provider command reactor failed to prewarm thread session", {
          threadId: event.payload.threadId,
          provider: requestedModelSelection.provider,
          cause: Cause.pretty(cause),
        }),
      ),
    );
    threadModelSelections.set(event.payload.threadId, requestedModelSelection);
  });

  const processTurnInterruptRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService.interruptTurn({ threadId: event.payload.threadId });
  });

  const processApprovalResponseRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.approval.respond.failed",
              summary: "Provider approval response failed",
              detail: isUnknownPendingApprovalRequestError(cause)
                ? stalePendingRequestDetail("approval", event.payload.requestId)
                : providerFailureDetail(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            });

            if (!isUnknownPendingApprovalRequestError(cause)) return;
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToUserInput({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        answers: event.payload.answers,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.user-input.respond.failed",
            summary: "Provider user input response failed",
            detail: isUnknownPendingUserInputRequestError(cause)
              ? stalePendingRequestDetail("user-input", event.payload.requestId)
              : providerFailureDetail(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processSessionStopRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    inFlightTurnDispatches.delete(event.payload.threadId);
    deferredTurnStarts.delete(event.payload.threadId);
    threadsWithObservedRunningTurn.delete(event.payload.threadId);
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService.stopSession({ threadId: thread.id });
    }

    // Clean up cached model selection to prevent unbounded Map growth.
    threadModelSelections.delete(event.payload.threadId);

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        goalLifecycleKey: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
    yield* setThreadResumeState({
      threadId: thread.id,
      resumeState: "resumed",
      createdAt: now,
    });
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    switch (event.type) {
      case "thread.goal-updated":
        yield* processGoalUpdated(event);
        return;
      case "thread.goal-cleared":
        yield* processGoalCleared(event);
        return;
      case "thread.goal-continuation-requested":
        yield* processGoalContinuationRequested(event);
        return;
      case "thread.session-set":
        yield* processSessionSet(event);
        return;
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThreadShared(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "thread.interaction-mode-set": {
        if (event.payload.interactionMode === "plan") return;
        const thread = yield* resolveThread(event.payload.threadId);
        const goal = thread?.goal;
        if (
          thread &&
          goal?.status === "active" &&
          thread.deletedAt === null &&
          thread.archivedAt === null &&
          thread.session?.status !== "running" &&
          (thread.session?.activeTurnId ?? null) === null
        ) {
          yield* orchestrationEngine
            .dispatch({
              type: "thread.goal.continue",
              commandId: CommandId.makeUnsafe(
                `server:harness-goal-mode-continuation:${event.eventId}`,
              ),
              threadId: thread.id,
              expectedGoalLifecycleKey: goal.lifecycleId ?? goal.createdAt,
              createdAt: event.payload.updatedAt,
            })
            .pipe(Effect.ignore({ log: false }));
        }
        return;
      }
      case "thread.session-ensure-requested":
        yield* processSessionEnsureRequested(event);
        return;
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.turn-steer-requested":
        yield* processTurnSteerRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);
  const sessionEnsureWorker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (event.type === "thread.message-sent" && event.payload.role === "user") {
        latestUserMessageSequenceByThread.set(event.payload.threadId, event.sequence);
      }
      if (
        event.type === "thread.goal-updated" ||
        event.type === "thread.goal-cleared" ||
        event.type === "thread.goal-continuation-requested" ||
        event.type === "thread.session-set" ||
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.interaction-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-steer-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested"
      ) {
        return yield* worker.enqueue(event);
      }
      if (event.type === "thread.session-ensure-requested") {
        return yield* sessionEnsureWorker.enqueue(event);
      }
    });

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent),
    );
  });

  const reconcile: ProviderCommandReactorShape["reconcile"] = Effect.gen(function* () {
    // Goal state is durable while this reactor is a hot-stream consumer.
    // Reconcile terminal side effects and active idle continuations after
    // subscribing and after the HTTP control route is reachable, so a crash
    // cannot strand either lifecycle and mandatory goal tools cannot race the
    // listener during boot.
    const readModel = yield* orchestrationEngine.getReadModel();
    yield* Effect.forEach(
      readModel.threads,
      Effect.fn(function* (thread) {
        if (thread.deletedAt === null && thread.archivedAt === null) {
          const pendingTurns = yield* projectionTurnRepository.listPendingTurnStartsByThreadId({
            threadId: thread.id,
          });
          if (pendingTurns.length > 0) {
            let handledRecoverablePendingTurn = false;
            const providerTurnAlreadyRunning =
              thread.session?.status === "running" ||
              (thread.session?.activeTurnId ?? null) !== null;
            const acceptedPendingMessageId =
              providerTurnAlreadyRunning && thread.latestTurn?.state !== "running"
                ? (pendingTurns[0]?.messageId ?? null)
                : null;
            for (const pending of pendingTurns) {
              const isGoalContinuation = String(pending.messageId).startsWith("goal-continuation:");
              if (isGoalContinuation) {
                if (providerTurnAlreadyRunning) {
                  if (pending.messageId === acceptedPendingMessageId) {
                    // Runtime reconciliation owns correlation for the one
                    // accepted physical start whose turn id has not reached
                    // the durable projection yet.
                    handledRecoverablePendingTurn = true;
                  } else {
                    yield* projectionTurnRepository.deletePendingTurnStart({
                      threadId: thread.id,
                      messageId: pending.messageId,
                    });
                  }
                  continue;
                }
                const lifecycleKey = thread.goal?.lifecycleId ?? thread.goal?.createdAt ?? null;
                if (
                  thread.goal?.status !== "active" ||
                  lifecycleKey === null ||
                  lifecycleKey !== pending.goalLifecycleKey ||
                  thread.interactionMode === "plan"
                ) {
                  yield* projectionTurnRepository.deletePendingTurnStart({
                    threadId: thread.id,
                    messageId: pending.messageId,
                  });
                  continue;
                }
                handledRecoverablePendingTurn = true;
                yield* processGoalContinuationRequested({
                  sequence: readModel.snapshotSequence,
                  eventId: EventId.makeUnsafe(
                    `server:startup-pending-goal-continuation:${thread.id}:${pending.messageId}`,
                  ),
                  aggregateKind: "thread",
                  aggregateId: thread.id,
                  type: "thread.goal-continuation-requested",
                  occurredAt: pending.requestedAt,
                  commandId: null,
                  causationEventId: null,
                  correlationId: null,
                  metadata: {},
                  payload: {
                    threadId: thread.id,
                    expectedGoalLifecycleKey: lifecycleKey,
                    messageId: pending.messageId,
                    createdAt: pending.requestedAt,
                  },
                });
                continue;
              }
              const sourceProposedPlan =
                pending.sourceProposedPlanThreadId !== null && pending.sourceProposedPlanId !== null
                  ? {
                      threadId: pending.sourceProposedPlanThreadId,
                      planId: pending.sourceProposedPlanId,
                    }
                  : undefined;
              const recoveredEvent: DeferredTurnStart = {
                sequence: readModel.snapshotSequence,
                eventId: EventId.makeUnsafe(
                  `server:startup-pending-turn:${thread.id}:${pending.messageId}`,
                ),
                aggregateKind: "thread",
                aggregateId: thread.id,
                type: "thread.turn-start-requested",
                occurredAt: pending.requestedAt,
                commandId: null,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                payload: {
                  threadId: thread.id,
                  messageId: pending.messageId,
                  runtimeMode: thread.runtimeMode,
                  interactionMode:
                    pending.goalLifecycleKey !== null ? "default" : thread.interactionMode,
                  goalLifecycleKey: pending.goalLifecycleKey ?? null,
                  ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
                  createdAt: pending.requestedAt,
                },
              };
              handledRecoverablePendingTurn = true;
              if (providerTurnAlreadyRunning) {
                enqueueDeferredTurnStart(recoveredEvent);
              } else {
                yield* processTurnStartRequested(recoveredEvent, { skipDeduplication: true });
              }
            }
            if (handledRecoverablePendingTurn) {
              return;
            }
          }
        }

        const goal = thread.goal;
        if (
          goal?.status === "complete" &&
          thread.deletedAt === null &&
          thread.archivedAt === null &&
          thread.session?.status !== "running" &&
          (thread.session?.activeTurnId ?? null) === null
        ) {
          yield* finalizeHarnessGoal(thread.id, goal.updatedAt).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider command reactor failed to reconcile goal completion", {
                threadId: thread.id,
                cause: Cause.pretty(cause),
              }),
            ),
          );
          return;
        }
        if (
          goal?.status === "active" &&
          thread.deletedAt === null &&
          thread.archivedAt === null &&
          thread.interactionMode !== "plan" &&
          thread.session?.status !== "running" &&
          (thread.session?.activeTurnId ?? null) === null
        ) {
          yield* Effect.gen(function* () {
            const dispatched = yield* orchestrationEngine.dispatch({
              type: "thread.goal.continue",
              commandId: serverCommandId("harness-goal-startup-continuation"),
              threadId: thread.id,
              expectedGoalLifecycleKey: goal.lifecycleId ?? goal.createdAt,
              createdAt: new Date().toISOString(),
            });

            // The domain-event stream is deliberately hot. Process the exact
            // durable startup event here as well so subscription scheduling
            // cannot strand an active goal during reactor startup. The normal
            // in-flight latch makes a concurrent stream delivery harmless.
            const persistedEvent = yield* orchestrationEngine
              .readEvents(dispatched.sequence - 1)
              .pipe(Stream.take(1), Stream.runHead);
            if (
              Option.isSome(persistedEvent) &&
              persistedEvent.value.type === "thread.goal-continuation-requested"
            ) {
              yield* processGoalContinuationRequested(persistedEvent.value);
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "provider command reactor failed to reconcile active goal continuation",
                {
                  threadId: thread.id,
                  cause: Cause.pretty(cause),
                },
              ),
            ),
          );
          return;
        }
      }),
      { concurrency: 1 },
    ).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed startup reconciliation", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  return {
    start,
    reconcile,
    drain: Effect.all([worker.drain, sessionEnsureWorker.drain], { concurrency: "unbounded" }).pipe(
      Effect.asVoid,
    ),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
);
