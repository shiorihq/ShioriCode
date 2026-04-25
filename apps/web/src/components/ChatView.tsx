import {
  type ApprovalRequestId,
  DEFAULT_MODEL_BY_PROVIDER,
  type ClaudeCodeEffort,
  MessageId,
  type ModelSelection,
  type ProviderModelOptions,
  type ProviderKind,
  type ProjectEntry,
  type ProviderApprovalDecision,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ServerProvider,
  type ThreadId,
  type TurnId,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  RuntimeMode,
} from "contracts";
import { applyClaudePromptEffortPrefix, normalizeModelSlug } from "shared/model";
import { truncate } from "shared/String";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { gitCreateWorktreeMutationOptions, gitStatusQueryOptions } from "~/lib/gitReactQuery";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { ASSISTANT_PERSONALITY_OPTIONS } from "../assistantPersonalityOptions";
import { isElectron } from "../env";
import {
  parseDiffRouteSearch,
  stripBrowserSearchParams,
  stripDiffSearchParams,
} from "../diffRouteSearch";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  parseStandaloneComposerSlashCommand,
  replaceTextRange,
} from "../composer-logic";
import {
  deriveCompletionDividerBeforeEntryId,
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveReasoningEntries,
  deriveTimelineEntries,
  deriveVisibleTimelineMessages,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  findSidebarProposedPlan,
  findLatestProposedPlan,
  deriveWorkLogEntries,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  isSessionActivelyRunningTurn,
  isLatestTurnSettled,
  formatElapsed,
} from "../session-logic";
import { isScrollContainerNearBottom } from "../chat-scroll";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { useStore } from "../store";
import { useProjectById, useThreadById } from "../storeSelectors";
import { useUiStateStore } from "../uiStateStore";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  proposedPlanTitle,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MAX_TERMINALS_PER_GROUP,
  type ChatMessage,
  type SessionPhase,
  type Thread,
  type TurnDiffSummary,
} from "../types";
import { LRUCache } from "../lib/lruCache";

import { basenameOfPath } from "../vscode-icons";
import { useTheme } from "../hooks/useTheme";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useThreadActions } from "../hooks/useThreadActions";
import { useMediaQuery } from "../hooks/useMediaQuery";
import BranchToolbar from "./BranchToolbar";
import { NoActiveThreadState } from "./chat/NoActiveThreadState";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import PlanSidebar from "./PlanSidebar";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  ListTodoIcon,
  XIcon,
} from "lucide-react";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { cn, isMacPlatform, randomUUID } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { toastManager } from "./ui/toast";
import { newCommandId, newMessageId, newThreadId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import {
  getProviderModelDisplayName,
  getProviderUnavailableReason,
  getProviderModelCapabilities,
  getProviderModels,
  providerModelSupportsImageAttachments,
  resolveSelectableProvider,
} from "../providerModels";
import { useSettings, useUpdateSettings } from "../hooks/useSettings";
import { buildProviderModelSelection, resolveAppModelSelection } from "../modelSelection";
import { isTerminalFocused } from "../lib/terminalFocus";
import { useHostedShioriState } from "../convex/HostedShioriProvider";
import { useMergedServerProviders } from "../convex/shioriProvider";
import {
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  type PersistedComposerImageAttachment,
  hydrateImagesFromPersisted,
  useComposerDraftStore,
  useEffectiveComposerModelState,
  useComposerThreadDraft,
} from "../composerDraftStore";
import {
  appendTerminalContextsToPrompt,
  formatTerminalContextLabel,
  insertInlineTerminalContextPlaceholder,
  removeInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import { deriveLatestContextWindowSnapshot } from "../lib/contextWindow";
import {
  resolveComposerFooterContentWidth,
  shouldForceCompactComposerFooterForFit,
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
} from "./composerFooterLayout";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import BrowserPanel from "./browser/BrowserPanel";
import { BackgroundSubagentsPanel } from "./chat/BackgroundSubagentsPanel";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { deriveBackgroundSubagentRows } from "./chat/subagentDetail";
import { ChatHeader } from "./chat/ChatHeader";
import { ContextWindowMeter } from "./chat/ContextWindowMeter";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { AVAILABLE_PROVIDER_OPTIONS, ProviderModelPicker } from "./chat/ProviderModelPicker";
import { ComposerCommandItem, ComposerCommandMenu } from "./chat/ComposerCommandMenu";
import { ComposerPendingApprovalActions } from "./chat/ComposerPendingApprovalActions";
import { CompactComposerControlsMenu } from "./chat/CompactComposerControlsMenu";
import { ComposerRuntimeModeButton } from "./chat/ComposerRuntimeModeButton";
import { ComposerPlusMenu } from "./chat/ComposerPlusMenu";
import { ComposerPlanModeSuggestion } from "./chat/ComposerPlanModeSuggestion";
import { PlanModeIndicator } from "./chat/PlanModeIndicator";
import { ComposerPrimaryActions } from "./chat/ComposerPrimaryActions";
import { ComposerPendingApprovalPanel } from "./chat/ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./chat/ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./chat/ComposerPlanFollowUpBanner";
import { QueuedMessagesPanel } from "./chat/QueuedMessagesPanel";
import {
  getComposerProviderState,
  renderProviderEffortPicker,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./chat/composerProviderRegistry";
import { playFastModeBlitz } from "./chat/fastModeBlitzFx";
import { ProviderStatusBanner } from "./chat/ProviderStatusBanner";
import { EmptyThreadAmbient } from "./chat/EmptyThreadAmbient";
import { EmptyThreadHeading } from "./chat/EmptyThreadHero";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import { ThreadResumeBanner } from "./chat/ThreadResumeBanner";
import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  buildTemporaryWorktreeBranchName,
  cloneComposerImageForRetry,
  collectUserMessageBlobPreviewUrls,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  getVisibleChatProviderStatus,
  hasServerAcknowledgedLocalDispatch,
  PullRequestDialogState,
  readFileAsDataUrl,
  reconcileMountedTerminalThreadIds,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  threadHasStarted,
  waitForServerThread,
  waitForStartedServerThread,
} from "./ChatView.logic";
import {
  useServerAvailableEditors,
  useServerConfig,
  useServerKeybindings,
} from "~/rpc/serverState";
import {
  type QueuedTurnDraft,
  selectQueuedTurnsForThread,
  useQueuedTurnsStore,
} from "../queuedTurnsStore";
import { Sheet, SheetPopup } from "./ui/sheet";

const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;
const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const BROWSER_PANEL_SHEET_MEDIA_QUERY = "(max-width: 1180px)";

function shouldBackgroundRefreshProviderStatus(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    (provider.status === "warning" || provider.status === "error")
  );
}

type ThreadPlanCatalogEntry = Pick<Thread, "id" | "proposedPlans">;

const MAX_THREAD_PLAN_CATALOG_CACHE_ENTRIES = 500;
const MAX_THREAD_PLAN_CATALOG_CACHE_MEMORY_BYTES = 512 * 1024;
const threadPlanCatalogCache = new LRUCache<{
  proposedPlans: Thread["proposedPlans"];
  entry: ThreadPlanCatalogEntry;
}>(MAX_THREAD_PLAN_CATALOG_CACHE_ENTRIES, MAX_THREAD_PLAN_CATALOG_CACHE_MEMORY_BYTES);

function estimateThreadPlanCatalogEntrySize(thread: Thread): number {
  return Math.max(
    64,
    thread.id.length +
      thread.proposedPlans.reduce(
        (total, plan) =>
          total +
          plan.id.length +
          plan.planMarkdown.length +
          plan.updatedAt.length +
          (plan.turnId?.length ?? 0),
        0,
      ),
  );
}

function toThreadPlanCatalogEntry(thread: Thread): ThreadPlanCatalogEntry {
  const cached = threadPlanCatalogCache.get(thread.id);
  if (cached && cached.proposedPlans === thread.proposedPlans) {
    return cached.entry;
  }

  const entry: ThreadPlanCatalogEntry = {
    id: thread.id,
    proposedPlans: thread.proposedPlans,
  };
  threadPlanCatalogCache.set(
    thread.id,
    {
      proposedPlans: thread.proposedPlans,
      entry,
    },
    estimateThreadPlanCatalogEntrySize(thread),
  );
  return entry;
}

function useThreadPlanCatalog(threadIds: readonly ThreadId[]): ThreadPlanCatalogEntry[] {
  const selector = useMemo(() => {
    let previousThreads: Array<Thread | undefined> | null = null;
    let previousEntries: ThreadPlanCatalogEntry[] = [];

    return (state: { threads: Thread[] }): ThreadPlanCatalogEntry[] => {
      const nextThreads = threadIds.map((threadId) =>
        state.threads.find((thread) => thread.id === threadId),
      );
      const cachedThreads = previousThreads;
      if (
        cachedThreads &&
        nextThreads.length === cachedThreads.length &&
        nextThreads.every((thread, index) => thread === cachedThreads[index])
      ) {
        return previousEntries;
      }

      previousThreads = nextThreads;
      previousEntries = nextThreads.flatMap((thread) =>
        thread ? [toThreadPlanCatalogEntry(thread)] : [],
      );
      return previousEntries;
    };
  }, [threadIds]);

  return useStore(selector);
}

function formatOutgoingPrompt(params: {
  provider: ProviderKind;
  model: string | null;
  models: ReadonlyArray<ServerProvider["models"][number]>;
  effort: string | null;
  text: string;
}): string {
  const caps = getProviderModelCapabilities(params.models, params.model, params.provider);
  if (params.effort && caps.promptInjectedEffortLevels.includes(params.effort)) {
    return applyClaudePromptEffortPrefix(params.text, params.effort as ClaudeCodeEffort | null);
  }
  return params.text;
}

function buildUnsupportedImageAttachmentMessage(modelName: string): string {
  return `${modelName} doesn't support image attachments. Remove the images or switch to a multimodal model.`;
}

const REVIEW_RECENT_CHANGES_PROMPT = "Review the recent changes and suggest improvements.";
const COMPACT_THREAD_CONTEXT_PROMPT =
  "Compact this thread's context. Preserve the current goal, constraints, important files, decisions, unfinished work, and the best next steps so we can continue cleanly later.";
const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;

const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

interface ChatViewProps {
  threadId: ThreadId;
}

function useThreadRelations(input: {
  isServerThread: boolean;
  serverThreadId: ThreadId | undefined;
  parentThreadId: ThreadId | null;
}) {
  const selector = useMemo(() => {
    let previousThreads: Thread[] | null = null;
    let previousThreadIdsByProjectId: Record<string, ThreadId[]> | null = null;
    let previousServerThreadIds: ThreadId[] = [];
    let previousParentThread: Thread | null = null;
    let previousChildThreads: Thread[] = [];
    let previousResult: {
      serverThreadIds: ThreadId[];
      parentThread: Thread | null;
      childThreads: Thread[];
    } = {
      serverThreadIds: previousServerThreadIds,
      parentThread: previousParentThread,
      childThreads: previousChildThreads,
    };

    return (state: {
      threads: Thread[];
      threadIdsByProjectId: Record<string, ThreadId[]>;
    }): {
      serverThreadIds: ThreadId[];
      parentThread: Thread | null;
      childThreads: Thread[];
    } => {
      if (previousThreads !== state.threads) {
        previousThreads = state.threads;
        if (!input.isServerThread || !input.serverThreadId) {
          previousParentThread = null;
          previousChildThreads = [];
        } else {
          previousParentThread =
            input.parentThreadId === null
              ? null
              : (state.threads.find((thread) => thread.id === input.parentThreadId) ?? null);
          previousChildThreads = state.threads
            .filter((thread) => thread.parentThreadId === input.serverThreadId)
            .toSorted(
              (left, right) =>
                left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
            );
        }
      }

      if (previousThreadIdsByProjectId !== state.threadIdsByProjectId) {
        previousThreadIdsByProjectId = state.threadIdsByProjectId;
        previousServerThreadIds = Object.values(state.threadIdsByProjectId).flat();
      }

      if (
        previousResult.serverThreadIds === previousServerThreadIds &&
        previousResult.parentThread === previousParentThread &&
        previousResult.childThreads === previousChildThreads
      ) {
        return previousResult;
      }

      previousResult = {
        serverThreadIds: previousServerThreadIds,
        parentThread: previousParentThread,
        childThreads: previousChildThreads,
      };
      return previousResult;
    };
  }, [input.isServerThread, input.parentThreadId, input.serverThreadId]);

  return useStore(selector);
}

function useLocalDispatchState(input: {
  threadId: ThreadId | null;
  activeThread: Thread | undefined;
  activeLatestTurn: Thread["latestTurn"] | null;
  phase: SessionPhase;
  activities: Thread["activities"];
  activePendingApproval: ApprovalRequestId | null;
  activePendingUserInput: ApprovalRequestId | null;
  threadError: string | null | undefined;
}) {
  const localDispatch = useStore((state) =>
    input.threadId ? (state.pendingThreadDispatchById[input.threadId] ?? null) : null,
  );
  const beginPendingThreadDispatch = useStore((state) => state.beginPendingThreadDispatch);
  const clearPendingThreadDispatch = useStore((state) => state.clearPendingThreadDispatch);

  const beginLocalDispatch = useCallback(
    (options?: { preparingWorktree?: boolean }) => {
      if (!input.threadId) {
        return;
      }
      const preparingWorktree = Boolean(options?.preparingWorktree);
      const current = useStore.getState().pendingThreadDispatchById[input.threadId] ?? null;
      const nextDispatch = current
        ? current.preparingWorktree === preparingWorktree
          ? current
          : { ...current, preparingWorktree }
        : createLocalDispatchSnapshot(input.activeThread, options);
      beginPendingThreadDispatch(input.threadId, nextDispatch);
    },
    [beginPendingThreadDispatch, input.activeThread, input.threadId],
  );

  const resetLocalDispatch = useCallback(() => {
    if (!input.threadId) {
      return;
    }
    clearPendingThreadDispatch(input.threadId);
  }, [clearPendingThreadDispatch, input.threadId]);

  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: input.phase,
        latestTurn: input.activeLatestTurn,
        activities: input.activities,
        hasPendingApproval: input.activePendingApproval !== null,
        hasPendingUserInput: input.activePendingUserInput !== null,
        threadError: input.threadError,
      }),
    [
      input.activities,
      input.activeLatestTurn,
      input.activePendingApproval,
      input.activePendingUserInput,
      input.phase,
      input.threadError,
      localDispatch,
    ],
  );

  useEffect(() => {
    if (!serverAcknowledgedLocalDispatch) {
      return;
    }
    resetLocalDispatch();
  }, [resetLocalDispatch, serverAcknowledgedLocalDispatch]);

  return {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt: localDispatch?.startedAt ?? null,
    isPreparingWorktree: localDispatch?.preparingWorktree ?? false,
    isSendBusy: localDispatch !== null && !serverAcknowledgedLocalDispatch,
  };
}

interface PersistentThreadTerminalDrawerProps {
  threadId: ThreadId;
  visible: boolean;
  focusRequestId: number;
  splitShortcutLabel: string | undefined;
  newShortcutLabel: string | undefined;
  closeShortcutLabel: string | undefined;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

function PersistentThreadTerminalDrawer({
  threadId,
  visible,
  focusRequestId,
  splitShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  onAddTerminalContext,
}: PersistentThreadTerminalDrawerProps) {
  const serverThread = useThreadById(threadId);
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const project = useProjectById(serverThread?.projectId ?? draftThread?.projectId);
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, threadId),
  );
  const storeSetTerminalHeight = useTerminalStateStore((state) => state.setTerminalHeight);
  const storeSplitTerminal = useTerminalStateStore((state) => state.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((state) => state.closeTerminal);
  const [localFocusRequestId, setLocalFocusRequestId] = useState(0);
  const terminalOpen = Boolean(terminalState.terminalOpen);
  const [mounted, setMounted] = useState(terminalOpen);
  const [animState, setAnimState] = useState<"open" | "closed">(terminalOpen ? "open" : "closed");
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (terminalOpen) {
      setMounted(true);
      // Render once with animState="closed", then flip to "open" on the next
      // frame so the browser has a starting keyframe to transition from.
      const raf1 = requestAnimationFrame(() => {
        requestAnimationFrame(() => setAnimState("open"));
      });
      return () => cancelAnimationFrame(raf1);
    }
    setAnimState("closed");
    closeTimerRef.current = setTimeout(() => {
      setMounted(false);
      closeTimerRef.current = null;
    }, 220);
    return () => {
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [terminalOpen]);
  const worktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const cwd = useMemo(
    () => (project ? (worktreePath ?? project.cwd) : null),
    [project, worktreePath],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? {
            SHIORICODE_PROJECT_ROOT: project.cwd,
            ...(worktreePath ? { SHIORICODE_WORKTREE_PATH: worktreePath } : {}),
          }
        : {},
    [project, worktreePath],
  );

  const bumpFocusRequestId = useCallback(() => {
    if (!visible) {
      return;
    }
    setLocalFocusRequestId((value) => value + 1);
  }, [visible]);

  const setTerminalHeight = useCallback(
    (height: number) => {
      storeSetTerminalHeight(threadId, height);
    },
    [storeSetTerminalHeight, threadId],
  );

  const splitTerminal = useCallback(() => {
    storeSplitTerminal(threadId, `terminal-${randomUUID()}`);
    bumpFocusRequestId();
  }, [bumpFocusRequestId, storeSplitTerminal, threadId]);

  const createNewTerminal = useCallback(() => {
    storeNewTerminal(threadId, `terminal-${randomUUID()}`);
    bumpFocusRequestId();
  }, [bumpFocusRequestId, storeNewTerminal, threadId]);

  const activateTerminal = useCallback(
    (terminalId: string) => {
      storeSetActiveTerminal(threadId, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeSetActiveTerminal, threadId],
  );

  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readNativeApi();
      if (!api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal.write({ threadId, terminalId, data: "exit\n" }).catch(() => undefined);

      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal.clear({ threadId, terminalId }).catch(() => undefined);
          }
          await api.terminal.close({
            threadId,
            terminalId,
            deleteHistory: true,
          });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }

      storeCloseTerminal(threadId, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeCloseTerminal, terminalState.terminalIds.length, threadId],
  );

  const handleAddTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      if (!visible) {
        return;
      }
      onAddTerminalContext(selection);
    },
    [onAddTerminalContext, visible],
  );

  if (!project || !mounted || !cwd) {
    return null;
  }

  // Non-active thread terminals stay hidden without animation.
  const isAnimatingOut = !terminalOpen && mounted;
  const shouldHide = !visible && !isAnimatingOut;
  const drawerHeightPx = terminalState.terminalHeight;

  return (
    <div
      ref={drawerRef}
      style={{
        display: shouldHide ? "none" : "block",
        height: animState === "open" ? `${drawerHeightPx}px` : "0px",
        overflow: "hidden",
        willChange: "height, opacity",
        opacity: animState === "open" ? 1 : 0,
        transition:
          animState === "open"
            ? "height 200ms ease-in, opacity 200ms ease-in"
            : "height 200ms ease-out, opacity 200ms ease-out",
      }}
    >
      <div style={{ height: `${drawerHeightPx}px` }}>
        <ThreadTerminalDrawer
          threadId={threadId}
          cwd={cwd}
          runtimeEnv={runtimeEnv}
          visible={visible}
          height={terminalState.terminalHeight}
          terminalIds={terminalState.terminalIds}
          activeTerminalId={terminalState.activeTerminalId}
          terminalGroups={terminalState.terminalGroups}
          activeTerminalGroupId={terminalState.activeTerminalGroupId}
          focusRequestId={focusRequestId + localFocusRequestId + (visible ? 1 : 0)}
          onSplitTerminal={splitTerminal}
          onNewTerminal={createNewTerminal}
          splitShortcutLabel={visible ? splitShortcutLabel : undefined}
          newShortcutLabel={visible ? newShortcutLabel : undefined}
          closeShortcutLabel={visible ? closeShortcutLabel : undefined}
          onActiveTerminalChange={activateTerminal}
          onCloseTerminal={closeTerminal}
          onHeightChange={setTerminalHeight}
          onAddTerminalContext={handleAddTerminalContext}
        />
      </div>
    </div>
  );
}

export default function ChatView({ threadId }: ChatViewProps) {
  const serverThread = useThreadById(threadId);
  const setStoreThreadError = useStore((store) => store.setError);
  const setStoreThreadBranch = useStore((store) => store.setThreadBranch);
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const activeThreadLastVisitedAt = useUiStateStore(
    (store) => store.threadLastVisitedAtById[threadId],
  );
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const navigate = useNavigate();
  const rawSearch = useSearch({
    strict: false,
    select: (params) => parseDiffRouteSearch(params),
  });
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const createWorktreeMutation = useMutation(gitCreateWorktreeMutationOptions({ queryClient }));
  const composerDraft = useComposerThreadDraft(threadId);
  const prompt = composerDraft.prompt;
  const composerImages = composerDraft.images;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        terminalContexts: composerTerminalContexts,
      }),
    [composerImages.length, composerTerminalContexts, prompt],
  );
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftProviderModelOptions = useComposerDraftStore(
    (store) => store.setProviderModelOptions,
  );
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const addComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.addTerminalContexts,
  );
  const removeComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.removeTerminalContext,
  );
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const promptRef = useRef(prompt);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isScrolledFromTop, setIsScrolledFromTop] = useState(false);
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>(composerTerminalContexts);
  const [localDraftErrorsByThreadId, setLocalDraftErrorsByThreadId] = useState<
    Record<ThreadId, string | null>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingApprovalDecision, setRespondingApprovalDecision] =
    useState<ProviderApprovalDecision | null>(null);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const [planSidebarOpen, setPlanSidebarOpen] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
  const [isBackgroundSubagentsPanelOpen, setIsBackgroundSubagentsPanelOpen] = useState(true);
  // Tracks whether the user explicitly dismissed the sidebar for the active turn.
  const planSidebarDismissedForTurnRef = useRef<string | null>(null);
  // When set, the thread-change reset effect will open the sidebar instead of closing it.
  // Used by "Implement in a new thread" to carry the sidebar-open intent across navigation.
  const planSidebarOpenOnNextThreadRef = useRef(false);
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const [messagesScrollElement, setMessagesScrollElement] = useState<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const lastKnownScrollTopRef = useRef(0);
  const isPointerScrollActiveRef = useRef(false);
  const lastTouchClientYRef = useRef<number | null>(null);
  const pendingUserScrollUpIntentRef = useRef(false);
  const pendingAutoScrollFrameRef = useRef<number | null>(null);
  const pendingInteractionAnchorRef = useRef<{
    element: HTMLElement;
    top: number;
  } | null>(null);
  const pendingInteractionAnchorFrameRef = useRef<number | null>(null);
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerFormHeightRef = useRef(0);
  const composerFooterRef = useRef<HTMLDivElement>(null);
  const composerFooterLeadingRef = useRef<HTMLDivElement>(null);
  const composerFooterActionsRef = useRef<HTMLDivElement>(null);
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewHandoffTimeoutByMessageIdRef = useRef<Record<string, number>>({});
  const sendInFlightRef = useRef(false);
  const draftThreadMaterializationPromisesRef = useRef(new Map<ThreadId, Promise<boolean>>());
  const dragDepthRef = useRef(0);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});
  const setMessagesScrollContainerRef = useCallback((element: HTMLDivElement | null) => {
    messagesScrollRef.current = element;
    setMessagesScrollElement(element);
  }, []);

  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const terminalState = useMemo(
    () => selectThreadTerminalState(terminalStateByThreadId, threadId),
    [terminalStateByThreadId, threadId],
  );
  const openTerminalThreadIds = useMemo(
    () =>
      Object.entries(terminalStateByThreadId).flatMap(([nextThreadId, nextTerminalState]) =>
        nextTerminalState.terminalOpen ? [nextThreadId as ThreadId] : [],
      ),
    [terminalStateByThreadId],
  );
  const storeSetTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const storeSplitTerminal = useTerminalStateStore((s) => s.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((s) => s.newTerminal);
  const storeCloseTerminal = useTerminalStateStore((s) => s.closeTerminal);
  const { branchThread } = useThreadActions();
  const queuedTurns = useQueuedTurnsStore((state) =>
    selectQueuedTurnsForThread(state.queuedTurnsByThreadId, threadId),
  );
  const enqueueQueuedTurn = useQueuedTurnsStore((state) => state.enqueueQueuedTurn);
  const removeQueuedTurn = useQueuedTurnsStore((state) => state.removeQueuedTurn);
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const draftThreadIds = useMemo(
    () => Object.keys(draftThreadsByThreadId) as ThreadId[],
    [draftThreadsByThreadId],
  );
  const [mountedTerminalThreadIds, setMountedTerminalThreadIds] = useState<ThreadId[]>([]);

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(threadId, nextPrompt);
    },
    [setComposerDraftPrompt, threadId],
  );
  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      addComposerDraftImage(threadId, image);
    },
    [addComposerDraftImage, threadId],
  );
  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      addComposerDraftImages(threadId, images);
    },
    [addComposerDraftImages, threadId],
  );
  const addComposerTerminalContextsToDraft = useCallback(
    (contexts: TerminalContextDraft[]) => {
      addComposerDraftTerminalContexts(threadId, contexts);
    },
    [addComposerDraftTerminalContexts, threadId],
  );
  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      removeComposerDraftImage(threadId, imageId);
    },
    [removeComposerDraftImage, threadId],
  );
  const removeComposerTerminalContextFromDraft = useCallback(
    (contextId: string) => {
      const contextIndex = composerTerminalContexts.findIndex(
        (context) => context.id === contextId,
      );
      if (contextIndex < 0) {
        return;
      }
      const nextPrompt = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
      promptRef.current = nextPrompt.prompt;
      setPrompt(nextPrompt.prompt);
      removeComposerDraftTerminalContext(threadId, contextId);
      setComposerCursor(nextPrompt.cursor);
      setComposerTrigger(
        detectComposerTrigger(
          nextPrompt.prompt,
          expandCollapsedComposerCursor(nextPrompt.prompt, nextPrompt.cursor),
        ),
      );
    },
    [composerTerminalContexts, removeComposerDraftTerminalContext, setPrompt, threadId],
  );

  const fallbackDraftProject = useProjectById(draftThread?.projectId);
  const localDraftError = serverThread ? null : (localDraftErrorsByThreadId[threadId] ?? null);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            fallbackDraftProject?.defaultModelSelection ?? {
              provider: "codex",
              model: DEFAULT_MODEL_BY_PROVIDER.codex,
            },
            localDraftError,
          )
        : undefined,
    [draftThread, fallbackDraftProject?.defaultModelSelection, localDraftError, threadId],
  );
  const activeThread = serverThread ?? localDraftThread;
  const runtimeMode =
    composerDraft.runtimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode =
    composerDraft.interactionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE;
  const isServerThread = serverThread !== undefined;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = isLocalDraftThread;
  const diffOpen = rawSearch.diff === "1";
  const browserOpen = rawSearch.browser === "1";
  const shouldUseBrowserSheet = useMediaQuery(BROWSER_PANEL_SHEET_MEDIA_QUERY);
  const activeThreadId = activeThread?.id ?? null;
  const { serverThreadIds, parentThread, childThreads } = useThreadRelations({
    isServerThread,
    serverThreadId: serverThread?.id,
    parentThreadId: serverThread?.parentThreadId ?? null,
  });
  const existingOpenTerminalThreadIds = useMemo(() => {
    const existingThreadIds = new Set<ThreadId>([...serverThreadIds, ...draftThreadIds]);
    return openTerminalThreadIds.filter((nextThreadId) => existingThreadIds.has(nextThreadId));
  }, [draftThreadIds, openTerminalThreadIds, serverThreadIds]);
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const threadPlanCatalog = useThreadPlanCatalog(
    useMemo(() => {
      const threadIds: ThreadId[] = [];
      if (activeThread?.id) {
        threadIds.push(activeThread.id);
      }
      const sourceThreadId = activeLatestTurn?.sourceProposedPlan?.threadId;
      if (sourceThreadId && sourceThreadId !== activeThread?.id) {
        threadIds.push(sourceThreadId);
      }
      return threadIds;
    }, [activeLatestTurn?.sourceProposedPlan?.threadId, activeThread?.id]),
  );
  const activeContextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(activeThread?.activities ?? []),
    [activeThread?.activities],
  );
  useEffect(() => {
    setMountedTerminalThreadIds((currentThreadIds) => {
      const nextThreadIds = reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: existingOpenTerminalThreadIds,
        activeThreadId,
        activeThreadTerminalOpen: Boolean(activeThreadId && terminalState.terminalOpen),
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
      });
      return currentThreadIds.length === nextThreadIds.length &&
        currentThreadIds.every((nextThreadId, index) => nextThreadId === nextThreadIds[index])
        ? currentThreadIds
        : nextThreadIds;
    });
  }, [activeThreadId, existingOpenTerminalThreadIds, terminalState.terminalOpen]);
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const activeProject = useProjectById(activeThread?.projectId);
  const isProjectThread = activeProject !== undefined;
  const handleBranchActiveThread = useCallback(async () => {
    if (!isServerThread || !serverThread) {
      return;
    }
    try {
      await branchThread(serverThread.id);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not branch thread",
        description: error instanceof Error ? error.message : "An unknown error occurred.",
      });
    }
  }, [branchThread, isServerThread, serverThread]);

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      });
      setComposerHighlightedItemId(null);
    },
    [canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: { branch: string; worktreePath: string | null; envMode: DraftThreadEnvMode }) => {
      if (!activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const storedDraftThread = getDraftThreadByProjectId(activeProject.id);
      if (storedDraftThread) {
        setDraftThreadContext(storedDraftThread.threadId, input);
        setProjectDraftThreadId(activeProject.id, storedDraftThread.threadId, input);
        if (storedDraftThread.threadId !== threadId) {
          await navigate({
            to: "/$threadId",
            params: { threadId: storedDraftThread.threadId },
          });
        }
        return storedDraftThread.threadId;
      }

      const activeDraftThread = getDraftThread(threadId);
      if (!isServerThread && activeDraftThread?.projectId === activeProject.id) {
        setDraftThreadContext(threadId, input);
        setProjectDraftThreadId(activeProject.id, threadId, input);
        return threadId;
      }

      clearProjectDraftThreadId(activeProject.id);
      const nextThreadId = newThreadId();
      setProjectDraftThreadId(activeProject.id, nextThreadId, {
        createdAt: new Date().toISOString(),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        ...input,
      });
      await navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
      });
      return nextThreadId;
    },
    [
      activeProject,
      clearProjectDraftThreadId,
      getDraftThread,
      getDraftThreadByProjectId,
      isServerThread,
      navigate,
      setDraftThreadContext,
      setProjectDraftThreadId,
      threadId,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: { branch: string; worktreePath: string | null }) => {
      await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
      });
    },
    [openOrReuseProjectDraftThread],
  );

  useEffect(() => {
    if (!serverThread?.id) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnCompletedAt)) return;
    const lastVisitedAt = activeThreadLastVisitedAt ? Date.parse(activeThreadLastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= turnCompletedAt) return;

    markThreadVisited(serverThread.id);
  }, [
    activeLatestTurn?.completedAt,
    activeThreadLastVisitedAt,
    latestTurnSettled,
    markThreadVisited,
    serverThread?.id,
  ]);

  const sessionProvider = activeThread?.session?.provider ?? null;
  const selectedProviderByThreadId = composerDraft.activeProvider ?? null;
  const threadProvider =
    activeThread?.modelSelection.provider ?? activeProject?.defaultModelSelection?.provider ?? null;
  const hasThreadStarted = threadHasStarted(activeThread);
  const lockedProvider: ProviderKind | null = hasThreadStarted
    ? (sessionProvider ?? threadProvider ?? selectedProviderByThreadId ?? null)
    : null;
  const serverConfig = useServerConfig();
  const providerStatuses = useMergedServerProviders(serverConfig?.providers ?? EMPTY_PROVIDERS);
  const hasRequestedBackgroundProviderRefreshRef = useRef(false);
  const { authToken: hostedShioriAuthToken } = useHostedShioriState();
  const unlockedSelectedProvider = resolveSelectableProvider(
    providerStatuses,
    selectedProviderByThreadId ?? threadProvider ?? "codex",
  );
  const selectedProvider: ProviderKind = lockedProvider ?? unlockedSelectedProvider;
  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId,
    providers: providerStatuses,
    selectedProvider,
    threadModelSelection: activeThread?.modelSelection,
    projectModelSelection: activeProject?.defaultModelSelection,
    settings,
  });
  const selectedProviderModels = getProviderModels(providerStatuses, selectedProvider);
  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        prompt,
        modelOptions: composerModelOptions,
      }),
    [composerModelOptions, prompt, selectedModel, selectedProvider, selectedProviderModels],
  );
  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  const selectedModelDisplayName = useMemo(
    () => getProviderModelDisplayName(selectedProviderModels, selectedModel, selectedProvider),
    [selectedModel, selectedProvider, selectedProviderModels],
  );
  const selectedModelSupportsImageAttachments = useMemo(
    () =>
      providerModelSupportsImageAttachments(
        selectedProviderModels,
        selectedModel,
        selectedProvider,
      ),
    [selectedModel, selectedProvider, selectedProviderModels],
  );
  const selectedModelSelection = useMemo<ModelSelection>(
    () =>
      buildProviderModelSelection(selectedProvider, selectedModel, selectedModelOptionsForDispatch),
    [selectedModel, selectedModelOptionsForDispatch, selectedProvider],
  );
  useEffect(() => {
    if (hasRequestedBackgroundProviderRefreshRef.current) {
      return;
    }

    if (!providerStatuses.some(shouldBackgroundRefreshProviderStatus)) {
      return;
    }

    const api = readNativeApi();
    if (!api) {
      return;
    }

    hasRequestedBackgroundProviderRefreshRef.current = true;
    void api.server.refreshProviders().catch(() => {
      hasRequestedBackgroundProviderRefreshRef.current = false;
    });
  }, [providerStatuses]);
  const ensureProviderCanStartTurn = useCallback(
    async (provider: ProviderKind) => {
      const unavailableReason = getProviderUnavailableReason(providerStatuses, provider);
      if (unavailableReason) {
        throw new Error(unavailableReason);
      }
      if (provider !== "shiori") {
        return;
      }

      const api = readNativeApi();
      if (!api) {
        throw new Error("Native API not found");
      }
      console.info("[shiori-send] synchronizing Shiori account token before turn start", {
        provider,
        tokenPresent: hostedShioriAuthToken !== null,
      });
      if (!hostedShioriAuthToken) {
        throw new Error(
          "Shiori account token is unavailable or invalid. Sign out and sign back in to continue.",
        );
      }
      await api.server.setShioriAuthToken(hostedShioriAuthToken);
    },
    [hostedShioriAuthToken, providerStatuses],
  );
  const buildDraftThreadTitle = useCallback(
    (input: {
      trimmedPrompt: string;
      composerImagesSnapshot: ReadonlyArray<ComposerImageAttachment>;
      composerTerminalContextsSnapshot: ReadonlyArray<TerminalContextDraft>;
    }) => {
      const firstComposerImageName = input.composerImagesSnapshot[0]?.name ?? null;
      let titleSeed = input.trimmedPrompt;
      if (!titleSeed) {
        if (firstComposerImageName) {
          titleSeed = `Image: ${firstComposerImageName}`;
        } else if (input.composerTerminalContextsSnapshot.length > 0) {
          titleSeed = formatTerminalContextLabel(input.composerTerminalContextsSnapshot[0]!);
        } else {
          titleSeed = "New Thread";
        }
      }
      return truncate(titleSeed);
    },
    [],
  );
  const materializeLocalDraftThread = useCallback(
    async (input: {
      title: string;
      modelSelection: ModelSelection;
      branch: string | null;
      worktreePath: string | null;
    }): Promise<boolean> => {
      if (!isLocalDraftThread || !activeProject || !activeThread) {
        return false;
      }

      const existingServerThread = useStore
        .getState()
        .threads.find((thread) => thread.id === threadId);
      if (threadHasStarted(existingServerThread ?? null)) {
        return true;
      }

      const existingPromise = draftThreadMaterializationPromisesRef.current.get(threadId);
      if (existingPromise) {
        return existingPromise;
      }

      const api = readNativeApi();
      if (!api) {
        return false;
      }

      const promise = api.orchestration
        .dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          projectId: activeProject.id,
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode,
          interactionMode,
          parentThreadId: null,
          branchSourceTurnId: null,
          branch: input.branch,
          worktreePath: input.worktreePath,
          createdAt: activeThread.createdAt,
        })
        .then(async () => {
          await waitForServerThread(threadId);
          void api.orchestration
            .dispatchCommand({
              type: "thread.session.ensure",
              commandId: newCommandId(),
              threadId,
              createdAt: new Date().toISOString(),
            })
            .catch(() => undefined);
          return true;
        })
        .catch(() => false)
        .finally(() => {
          draftThreadMaterializationPromisesRef.current.delete(threadId);
        });

      draftThreadMaterializationPromisesRef.current.set(threadId, promise);
      return promise;
    },
    [activeProject, activeThread, interactionMode, isLocalDraftThread, runtimeMode, threadId],
  );
  const selectedModelForPicker = selectedModel;
  const draftThreadCreateModelSelection = useMemo<ModelSelection>(
    () =>
      buildProviderModelSelection(
        selectedProvider,
        selectedModel ||
          activeProject?.defaultModelSelection?.model ||
          DEFAULT_MODEL_BY_PROVIDER.codex,
        selectedModelSelection.options,
      ),
    [
      activeProject?.defaultModelSelection?.model,
      selectedModel,
      selectedModelSelection.options,
      selectedProvider,
    ],
  );
  const phase = derivePhase(activeThread?.session ?? null);
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const workLogEntries = useMemo(
    () => deriveWorkLogEntries(threadActivities, undefined),
    [threadActivities],
  );
  const reasoningEntries = useMemo(
    () => deriveReasoningEntries(threadActivities),
    [threadActivities],
  );
  const latestTurnHasToolActivity = useMemo(
    () => hasToolActivityForTurn(threadActivities, activeLatestTurn?.turnId),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const threadSessionStatus = activeThread?.session?.orchestrationStatus ?? null;
  const pendingApprovals = useMemo(
    () => (threadSessionStatus === "running" ? derivePendingApprovals(threadActivities) : []),
    [threadActivities, threadSessionStatus],
  );
  const pendingUserInputs = useMemo(
    () => (threadSessionStatus === "running" ? derivePendingUserInputs(threadActivities) : []),
    [threadActivities, threadSessionStatus],
  );

  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const sidebarProposedPlan = useMemo(
    () =>
      findSidebarProposedPlan({
        threads: threadPlanCatalog,
        latestTurn: activeLatestTurn,
        latestTurnSettled,
        threadId: activeThread?.id ?? null,
      }),
    [activeLatestTurn, activeThread?.id, latestTurnSettled, threadPlanCatalog],
  );
  const activePlan = useMemo(
    () => deriveActivePlanState(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);

  const activePendingApproval = pendingApprovals[0] ?? null;
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree,
    isSendBusy,
  } = useLocalDispatchState({
    threadId: activeThread?.id ?? null,
    activeThread,
    activeLatestTurn,
    phase,
    activities: threadActivities,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError: activeThread?.error,
  });
  const isTurnRunning = isSessionActivelyRunningTurn(
    activeLatestTurn,
    activeThread?.session ?? null,
  );
  const isWorking = isTurnRunning || isSendBusy || isConnecting || isRevertingCheckpoint;
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    activeLatestTurn,
    activeThread?.session ?? null,
    localDispatchStartedAt,
  );
  const isComposerApprovalState = activePendingApproval !== null;

  const [planSuggestionDismissed, setPlanSuggestionDismissed] = useState(false);
  const showPlanSuggestion =
    !planSuggestionDismissed &&
    /\bplan\b/i.test(prompt) &&
    interactionMode !== "plan" &&
    !isComposerApprovalState &&
    pendingUserInputs.length === 0;

  const hasComposerHeader =
    isComposerApprovalState ||
    pendingUserInputs.length > 0 ||
    (showPlanFollowUpPrompt && activeProposedPlan !== null);
  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  const composerFooterActionLayoutKey = useMemo(() => {
    if (activePendingProgress) {
      return `pending:${activePendingProgress.questionIndex}:${activePendingProgress.isLastQuestion}:${activePendingIsResponding}`;
    }
    if (isTurnRunning) {
      return "running";
    }
    if (showPlanFollowUpPrompt) {
      return prompt.trim().length > 0 ? "plan:refine" : "plan:implement";
    }
    return `idle:${composerSendState.hasSendableContent}:${isSendBusy}:${isConnecting}:${isPreparingWorktree}`;
  }, [
    activePendingIsResponding,
    activePendingProgress,
    composerSendState.hasSendableContent,
    isConnecting,
    isPreparingWorktree,
    isSendBusy,
    isTurnRunning,
    prompt,
    showPlanFollowUpPrompt,
  ]);
  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);
  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      lastSyncedPendingInputRef.current = null;
      return;
    }
    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const nextCursor = collapseExpandedComposerCursor(nextCustomAnswer, nextCustomAnswer.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(
      detectComposerTrigger(
        nextCustomAnswer,
        expandCollapsedComposerCursor(nextCustomAnswer, nextCursor),
      ),
    );
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.customAnswer,
    activePendingUserInput?.requestId,
    activePendingProgress?.activeQuestion?.id,
  ]);
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    for (const timeoutId of Object.values(attachmentPreviewHandoffTimeoutByMessageIdRef.current)) {
      window.clearTimeout(timeoutId);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    for (const previewUrl of previousPreviewUrls) {
      if (!previewUrls.includes(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });

    const existingTimeout = attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    if (typeof existingTimeout === "number") {
      window.clearTimeout(existingTimeout);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId] = window.setTimeout(() => {
      const currentPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId];
      if (currentPreviewUrls) {
        for (const previewUrl of currentPreviewUrls) {
          revokeBlobPreviewUrl(previewUrl);
        }
      }
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) return existing;
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      delete attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    }, ATTACHMENT_PREVIEW_HANDOFF_TTL_MS);
  }, []);
  const serverMessages = activeThread?.messages;
  const preserveCompletedAssistantMessages =
    activeThread?.session?.provider === "claudeAgent" ||
    activeThread?.modelSelection.provider === "claudeAgent";
  const timelineMessages = useMemo(() => {
    const messages = serverMessages ?? [];
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          // oxlint-disable-next-line no-map-spread
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    if (optimisticUserMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return deriveVisibleTimelineMessages(
        serverMessagesWithPreviewHandoff,
        activeThread?.session ?? null,
        { preserveCompletedAssistantMessages },
      );
    }
    return deriveVisibleTimelineMessages(
      [...serverMessagesWithPreviewHandoff, ...pendingMessages],
      activeThread?.session ?? null,
      { preserveCompletedAssistantMessages },
    );
  }, [
    serverMessages,
    attachmentPreviewHandoffByMessageId,
    optimisticUserMessages,
    activeThread?.session,
    preserveCompletedAssistantMessages,
  ]);
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(
        timelineMessages,
        reasoningEntries,
        activeThread?.proposedPlans ?? [],
        workLogEntries,
      ),
    [activeThread?.proposedPlans, reasoningEntries, timelineMessages, workLogEntries],
  );
  const activeTurnId = activeThread?.session?.activeTurnId ?? activeLatestTurn?.turnId ?? null;
  const isAwaitingSendAck = !isRevertingCheckpoint && (isSendBusy || isConnecting);
  const isEmptyThread = timelineEntries.length === 0 && !isWorking;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    let pendingTurnCountForPreviousUser: number | null = null;

    // Walk backwards once so each user message picks up the nearest assistant
    // message checkpoint in its turn segment without nested scanning.
    for (let index = timelineEntries.length - 1; index >= 0; index -= 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message") {
        continue;
      }

      if (entry.message.role === "assistant") {
        const summary = turnDiffSummaryByAssistantMessageId.get(entry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount === "number") {
          pendingTurnCountForPreviousUser = Math.max(0, turnCount - 1);
        }
        continue;
      }

      if (entry.message.role === "user" && pendingTurnCountForPreviousUser !== null) {
        byUserMessageId.set(entry.message.id, pendingTurnCountForPreviousUser);
        pendingTurnCountForPreviousUser = null;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  const completionSummary = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurn?.startedAt) return null;
    if (!activeLatestTurn.completedAt) return null;
    if (!latestTurnHasToolActivity) return null;

    const elapsed = formatElapsed(activeLatestTurn.startedAt, activeLatestTurn.completedAt);
    return elapsed ? `Worked for ${elapsed}` : null;
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.startedAt,
    latestTurnHasToolActivity,
    latestTurnSettled,
  ]);
  const completionDividerBeforeEntryId = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!completionSummary) return null;
    return deriveCompletionDividerBeforeEntryId(timelineEntries, activeLatestTurn);
  }, [activeLatestTurn, completionSummary, latestTurnSettled, timelineEntries]);
  const messagesTimelineRenderKey = useMemo(() => {
    const threadId = activeThread?.id ?? "no-thread";
    const turnId = activeLatestTurn?.turnId ?? "no-turn";
    const turnPhase = latestTurnSettled ? (activeLatestTurn?.completedAt ?? "settled") : "live";
    return `${threadId}:${turnId}:${turnPhase}`;
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.turnId,
    activeThread?.id,
    latestTurnSettled,
  ]);
  const gitCwd = activeProject ? (activeThread?.worktreePath ?? activeProject.cwd) : null;
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const isPathTrigger = composerTriggerKind === "path";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    pathTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectivePathQuery = pathTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const gitStatusQuery = useQuery(gitStatusQueryOptions(gitCwd));
  const keybindings = useServerKeybindings();
  const availableEditors = useServerAvailableEditors();
  const modelOptionsByProvider = useMemo(
    () => ({
      shiori: providerStatuses.find((provider) => provider.provider === "shiori")?.models ?? [],
      kimiCode: providerStatuses.find((provider) => provider.provider === "kimiCode")?.models ?? [],
      gemini: providerStatuses.find((provider) => provider.provider === "gemini")?.models ?? [],
      cursor: providerStatuses.find((provider) => provider.provider === "cursor")?.models ?? [],
      codex: providerStatuses.find((provider) => provider.provider === "codex")?.models ?? [],
      claudeAgent:
        providerStatuses.find((provider) => provider.provider === "claudeAgent")?.models ?? [],
    }),
    [providerStatuses],
  );
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByProvider[selectedProvider];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByProvider, selectedModelForPicker, selectedProvider]);
  const searchableModelOptions = useMemo(
    () =>
      AVAILABLE_PROVIDER_OPTIONS.filter(
        (option) => lockedProvider === null || option.value === lockedProvider,
      ).flatMap((option) =>
        modelOptionsByProvider[option.value].map(({ slug, name }) => ({
          provider: option.value,
          providerLabel: option.label,
          slug,
          name,
          searchSlug: slug.toLowerCase(),
          searchName: name.toLowerCase(),
          searchProvider: option.label.toLowerCase(),
        })),
      ),
    [lockedProvider, modelOptionsByProvider],
  );
  const selectedModelCapabilities = useMemo(
    () => getProviderModelCapabilities(selectedProviderModels, selectedModel, selectedProvider),
    [selectedModel, selectedProvider, selectedProviderModels],
  );
  const fastModeEnabled =
    selectedModelCapabilities.supportsFastMode &&
    (selectedModelSelection.options as { fastMode?: boolean } | undefined)?.fastMode === true;
  const assistantPersonalityOption = useMemo(
    () =>
      ASSISTANT_PERSONALITY_OPTIONS.find(
        (option) => option.value === settings.assistantPersonality,
      ) ?? ASSISTANT_PERSONALITY_OPTIONS[0]!,
    [settings.assistantPersonality],
  );
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: gitCwd,
      query: effectivePathQuery,
      enabled: isPathTrigger,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
  const backgroundSubagentRows = useMemo(
    () =>
      activeThread
        ? deriveBackgroundSubagentRows({
            provider: activeThread.session?.provider ?? activeThread.modelSelection.provider,
            workEntries: workLogEntries,
            activities: activeThread.activities,
          })
        : [],
    [activeThread, workLogEntries],
  );
  useEffect(() => {
    if (backgroundSubagentRows.length === 0) {
      setIsBackgroundSubagentsPanelOpen(true);
    }
  }, [backgroundSubagentRows.length]);
  const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      const query = composerTrigger.query.trim().toLowerCase();
      const agentItems = backgroundSubagentRows
        .filter((row) => {
          if (!query) {
            return true;
          }
          return (
            row.displayName.toLowerCase().includes(query) ||
            row.mentionName.toLowerCase().includes(query) ||
            (row.agentRole?.toLowerCase().includes(query) ?? false) ||
            (row.instruction?.toLowerCase().includes(query) ?? false)
          );
        })
        .map((row) => ({
          id: `agent:${row.provider}:${row.rootItemId}`,
          type: "agent" as const,
          mentionName: row.mentionName,
          label: row.displayName,
          description: row.agentRole
            ? `${row.agentRole} · ${row.status === "active" ? "working" : "awaiting instruction"}`
            : row.status === "active"
              ? "working"
              : "awaiting instruction",
        }));
      const pathItems = workspaceEntries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path" as const,
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.parentPath ?? "",
      }));
      return [...agentItems, ...pathItems];
    }

    if (composerTrigger.kind === "slash-command") {
      const slashCommandItems = [
        {
          id: "slash:compact",
          type: "slash-command",
          command: "compact",
          label: "/compact",
          description: "Compact this thread's context",
        },
        {
          id: "slash:fast",
          type: "slash-command",
          command: "fast",
          label: "/fast",
          description: fastModeEnabled
            ? "Turn off Fast mode and return to standard inference speed"
            : selectedModelCapabilities.supportsFastMode
              ? "Turn on Fast mode for quicker responses"
              : "Fast mode is unavailable for the current model",
        },
        {
          id: "slash:feedback",
          type: "slash-command",
          command: "feedback",
          label: "/feedback",
          description: "Open the feedback form",
        },
        {
          id: "slash:fork",
          type: "slash-command",
          command: "fork",
          label: "/fork",
          description: "Fork this chat into local or a new worktree",
        },
        {
          id: "slash:mcp",
          type: "slash-command",
          command: "mcp",
          label: "/mcp",
          description: "Show MCP server status",
        },
        {
          id: "slash:memories",
          type: "slash-command",
          command: "memories",
          label: "/memories",
          description: `Generate memories ${settings.generateMemories ? "on" : "off"}`,
        },
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch response model for this thread",
        },
        {
          id: "slash:personality",
          type: "slash-command",
          command: "personality",
          label: "/personality",
          description: assistantPersonalityOption.label,
        },
        {
          id: "slash:plan",
          type: "slash-command",
          command: "plan",
          label: "/plan",
          description: "Switch this thread into plan mode",
        },
        {
          id: "slash:default",
          type: "slash-command",
          command: "default",
          label: "/default",
          description: "Switch this thread back to default mode",
        },
        {
          id: "slash:review",
          type: "slash-command",
          command: "review",
          label: "/review",
          description: "Review the recent changes and suggest improvements",
        },
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;

      if (composerTrigger.command === "fork") {
        const query = composerTrigger.query.trim().toLowerCase();
        return [
          {
            id: "slash:fork:local",
            type: "slash-command" as const,
            command: "fork" as const,
            value: "local",
            label: "/fork local",
            description: "Fork this chat into a local thread",
          },
          {
            id: "slash:fork:worktree",
            type: "slash-command" as const,
            command: "fork" as const,
            value: "worktree",
            label: "/fork worktree",
            description: "Fork this chat into a new worktree",
          },
        ].filter((item) => {
          if (!query) {
            return true;
          }
          return (
            item.label.toLowerCase().includes(query) ||
            item.description.toLowerCase().includes(query)
          );
        });
      }

      if (composerTrigger.command === "personality") {
        const query = composerTrigger.query.trim().toLowerCase();
        return ASSISTANT_PERSONALITY_OPTIONS.filter((option) => {
          if (!query) {
            return true;
          }
          return (
            option.value.includes(query) ||
            option.label.toLowerCase().includes(query) ||
            option.description.toLowerCase().includes(query)
          );
        }).map((option) => ({
          id: `slash:personality:${option.value}`,
          type: "slash-command" as const,
          command: "personality" as const,
          value: option.value,
          label: `/personality ${option.value}`,
          description: option.description,
        }));
      }

      const query = composerTrigger.query.trim().toLowerCase();
      const visibleItems = composerTrigger.command
        ? slashCommandItems.filter((item) => item.command === composerTrigger.command)
        : slashCommandItems;
      if (!query) {
        return [...visibleItems];
      }
      return visibleItems.filter((item) => {
        const normalizedLabel = item.label.slice(1).toLowerCase();
        return (
          item.command.includes(query) ||
          normalizedLabel.includes(query) ||
          item.description.toLowerCase().includes(query)
        );
      });
    }

    return searchableModelOptions
      .filter(({ searchSlug, searchName, searchProvider }) => {
        const query = composerTrigger.query.trim().toLowerCase();
        if (!query) return true;
        return (
          searchSlug.includes(query) || searchName.includes(query) || searchProvider.includes(query)
        );
      })
      .map(({ provider, providerLabel, slug, name }) => ({
        id: `model:${provider}:${slug}`,
        type: "model",
        provider,
        model: slug,
        label: name,
        description: `${providerLabel} · ${slug}`,
      }));
  }, [
    assistantPersonalityOption.label,
    backgroundSubagentRows,
    composerTrigger,
    fastModeEnabled,
    searchableModelOptions,
    selectedModelCapabilities.supportsFastMode,
    settings.generateMemories,
    workspaceEntries,
  ]);
  const composerMenuOpen = Boolean(composerTrigger);
  const activeComposerMenuItem = useMemo(
    () =>
      composerMenuItems.find((item) => item.id === composerHighlightedItemId) ??
      composerMenuItems[0] ??
      null,
    [composerHighlightedItemId, composerMenuItems],
  );
  composerMenuOpenRef.current = composerMenuOpen;
  composerMenuItemsRef.current = composerMenuItems;
  activeComposerMenuItemRef.current = activeComposerMenuItem;
  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(nonPersistedComposerImageIds),
    [nonPersistedComposerImageIds],
  );
  const activeProviderStatus = useMemo(
    () =>
      getVisibleChatProviderStatus(
        providerStatuses.find((status) => status.provider === selectedProvider) ?? null,
      ),
    [selectedProvider, providerStatuses],
  );
  // Default true while loading to avoid toolbar flicker.
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const terminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: true,
        terminalOpen: Boolean(terminalState.terminalOpen),
      },
    }),
    [terminalState.terminalOpen],
  );
  const nonTerminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: false,
        terminalOpen: Boolean(terminalState.terminalOpen),
      },
    }),
    [terminalState.terminalOpen],
  );
  const terminalToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.toggle"),
    [keybindings],
  );
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const diffPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "diff.toggle", nonTerminalShortcutLabelOptions),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const browserPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "browser.toggle", nonTerminalShortcutLabelOptions),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const onToggleDiff = useCallback(() => {
    if (!isProjectThread) {
      return;
    }

    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return diffOpen ? { ...rest, diff: undefined } : { ...rest, diff: "1" };
      },
    });
  }, [diffOpen, isProjectThread, navigate, threadId]);
  const onToggleBrowser = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => {
        const rest = stripBrowserSearchParams(previous);
        return browserOpen ? rest : { ...rest, browser: "1" };
      },
    });
  }, [browserOpen, navigate, threadId]);

  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "closed")),
  );
  const activeTerminalGroup =
    terminalState.terminalGroups.find(
      (group) => group.id === terminalState.activeTerminalGroupId,
    ) ??
    terminalState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      if (useStore.getState().threads.some((thread) => thread.id === targetThreadId)) {
        setStoreThreadError(targetThreadId, error);
        return;
      }
      setLocalDraftErrorsByThreadId((existing) => {
        if ((existing[targetThreadId] ?? null) === error) {
          return existing;
        }
        return {
          ...existing,
          [targetThreadId]: error,
        };
      });
    },
    [setStoreThreadError],
  );

  const restoreQueuedTurnToComposer = useCallback(
    async (queuedDraft: QueuedTurnDraft) => {
      const composerIsDirty =
        promptRef.current.length > 0 ||
        composerImagesRef.current.length > 0 ||
        composerTerminalContextsRef.current.length > 0;
      if (composerIsDirty) {
        const confirmationMessage = "Replace the current composer draft with this queued message?";
        const api = readNativeApi();
        const confirmed = api
          ? await api.dialogs.confirm(confirmationMessage)
          : window.confirm(confirmationMessage);
        if (!confirmed) {
          return false;
        }
      }

      removeQueuedTurn(queuedDraft.threadId, queuedDraft.id);
      clearComposerDraftContent(queuedDraft.threadId);

      const restoredPrompt = queuedDraft.composerSnapshot.prompt;
      promptRef.current = restoredPrompt;
      setPrompt(restoredPrompt);
      setComposerDraftTerminalContexts(queuedDraft.threadId, [
        ...queuedDraft.composerSnapshot.terminalContexts,
      ]);

      const restoredImages = hydrateImagesFromPersisted(
        queuedDraft.composerSnapshot.persistedAttachments,
      );
      if (restoredImages.length > 0) {
        addComposerImagesToDraft(restoredImages);
        syncComposerDraftPersistedAttachments(queuedDraft.threadId, [
          ...queuedDraft.composerSnapshot.persistedAttachments,
        ]);
      }

      setComposerDraftModelSelection(queuedDraft.threadId, queuedDraft.modelSelection);
      setComposerDraftRuntimeMode(queuedDraft.threadId, queuedDraft.runtimeMode);
      setComposerDraftInteractionMode(queuedDraft.threadId, queuedDraft.interactionMode);
      setComposerCursor(collapseExpandedComposerCursor(restoredPrompt, restoredPrompt.length));
      setComposerTrigger(detectComposerTrigger(restoredPrompt, restoredPrompt.length));
      setThreadError(queuedDraft.threadId, null);

      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAtEnd();
      });
      return true;
    },
    [
      addComposerImagesToDraft,
      clearComposerDraftContent,
      removeQueuedTurn,
      setComposerDraftInteractionMode,
      setComposerDraftModelSelection,
      setComposerDraftRuntimeMode,
      setComposerDraftTerminalContexts,
      setPrompt,
      setThreadError,
      syncComposerDraftPersistedAttachments,
    ],
  );

  const onDeleteQueuedTurn = useCallback(
    (queuedTurnId: string) => {
      if (!activeThread) {
        return;
      }
      removeQueuedTurn(activeThread.id, queuedTurnId);
    },
    [activeThread, removeQueuedTurn],
  );

  const onEditQueuedTurn = useCallback(
    async (queuedTurnId: string) => {
      const queuedDraft = queuedTurns.find((entry) => entry.id === queuedTurnId);
      if (!queuedDraft) {
        return;
      }
      await restoreQueuedTurnToComposer(queuedDraft);
    },
    [queuedTurns, restoreQueuedTurnToComposer],
  );

  const focusComposer = useCallback(() => {
    composerEditorRef.current?.focusAtEnd();
  }, []);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      if (!activeThread) {
        return;
      }
      const snapshot = composerEditorRef.current?.readSnapshot() ?? {
        value: promptRef.current,
        cursor: composerCursor,
        expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
        terminalContextIds: composerTerminalContexts.map((context) => context.id),
      };
      const insertion = insertInlineTerminalContextPlaceholder(
        snapshot.value,
        snapshot.expandedCursor,
      );
      const nextCollapsedCursor = collapseExpandedComposerCursor(
        insertion.prompt,
        insertion.cursor,
      );
      const inserted = insertComposerDraftTerminalContext(
        activeThread.id,
        insertion.prompt,
        {
          id: randomUUID(),
          threadId: activeThread.id,
          createdAt: new Date().toISOString(),
          ...selection,
        },
        insertion.contextIndex,
      );
      if (!inserted) {
        return;
      }
      promptRef.current = insertion.prompt;
      setComposerCursor(nextCollapsedCursor);
      setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCollapsedCursor);
      });
    },
    [activeThread, composerCursor, composerTerminalContexts, insertComposerDraftTerminalContext],
  );
  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadId) return;
      storeSetTerminalOpen(activeThreadId, open);
    },
    [activeThreadId, storeSetTerminalOpen],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadId) return;
    setTerminalOpen(!terminalState.terminalOpen);
  }, [activeThreadId, setTerminalOpen, terminalState.terminalOpen]);
  const splitTerminal = useCallback(() => {
    if (!activeThreadId || hasReachedSplitLimit) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeSplitTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, hasReachedSplitLimit, storeSplitTerminal]);
  const createNewTerminal = useCallback(() => {
    if (!activeThreadId) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeNewTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, storeNewTerminal]);
  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readNativeApi();
      if (!activeThreadId || !api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal
          .write({ threadId: activeThreadId, terminalId, data: "exit\n" })
          .catch(() => undefined);
      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal
              .clear({ threadId: activeThreadId, terminalId })
              .catch(() => undefined);
          }
          await api.terminal.close({
            threadId: activeThreadId,
            terminalId,
            deleteHistory: true,
          });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }
      storeCloseTerminal(activeThreadId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, storeCloseTerminal, terminalState.terminalIds.length],
  );
  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
      threadId,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftThread,
      scheduleComposerFocus,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
      threadId,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode]);
  const toggleRuntimeMode = useCallback(() => {
    void handleRuntimeModeChange(
      runtimeMode === "full-access" ? "approval-required" : "full-access",
    );
  }, [handleRuntimeModeChange, runtimeMode]);
  const handleAssistantPersonalityChange = useCallback(
    (value: (typeof ASSISTANT_PERSONALITY_OPTIONS)[number]["value"]) => {
      updateSettings({ assistantPersonality: value });
      scheduleComposerFocus();
    },
    [scheduleComposerFocus, updateSettings],
  );
  const toggleMemoriesGeneration = useCallback(() => {
    updateSettings({ generateMemories: !settings.generateMemories });
    scheduleComposerFocus();
  }, [scheduleComposerFocus, settings.generateMemories, updateSettings]);
  const toggleFastMode = useCallback(() => {
    if (!activeThread) {
      return;
    }
    if (!selectedModelCapabilities.supportsFastMode) {
      toastManager.add({
        type: "warning",
        title: "Fast mode is unavailable",
        description: `${selectedModelDisplayName} does not support Fast mode.`,
      });
      scheduleComposerFocus();
      return;
    }

    const currentProviderOptions = composerModelOptions?.[selectedProvider];
    const nextProviderOptions = {
      ...(currentProviderOptions as Record<string, unknown> | undefined),
      fastMode: !fastModeEnabled,
    };
    setComposerDraftProviderModelOptions(
      activeThread.id,
      selectedProvider,
      nextProviderOptions as ProviderModelOptions[ProviderKind],
      { persistSticky: true },
    );
    playFastModeBlitz(!fastModeEnabled);
    scheduleComposerFocus();
  }, [
    activeThread,
    composerModelOptions,
    fastModeEnabled,
    scheduleComposerFocus,
    selectedModelCapabilities.supportsFastMode,
    selectedModelDisplayName,
    selectedProvider,
    setComposerDraftProviderModelOptions,
  ]);
  const openSettingsRoute = useCallback(
    (to: "/settings/feedback" | "/settings/skills") => {
      void navigate({ to });
    },
    [navigate],
  );
  const handleForkThread = useCallback(
    async (mode: "local" | "worktree" = "local") => {
      if (serverThread) {
        await branchThread(serverThread.id, { mode });
        return;
      }

      toastManager.add({
        type: "warning",
        title: "Fork is unavailable for this thread",
        description: "Start the thread first, then fork it from the slash menu.",
      });
    },
    [branchThread, serverThread],
  );
  const togglePlanSidebar = useCallback(() => {
    setPlanSidebarOpen((open) => {
      if (open) {
        const turnKey = activePlan?.turnId ?? sidebarProposedPlan?.turnId ?? null;
        if (turnKey) {
          planSidebarDismissedForTurnRef.current = turnKey;
        }
      } else {
        planSidebarDismissedForTurnRef.current = null;
      }
      return !open;
    });
  }, [activePlan?.turnId, sidebarProposedPlan?.turnId]);

  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      modelSelection?: ModelSelection;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }) => {
      if (!serverThread) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        return;
      }

      if (
        input.modelSelection !== undefined &&
        (input.modelSelection.model !== serverThread.modelSelection.model ||
          input.modelSelection.provider !== serverThread.modelSelection.provider ||
          JSON.stringify(input.modelSelection.options ?? null) !==
            JSON.stringify(serverThread.modelSelection.options ?? null))
      ) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: input.threadId,
          modelSelection: input.modelSelection,
        });
      }

      if (input.runtimeMode !== serverThread.runtimeMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.runtime-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          createdAt: input.createdAt,
        });
      }

      if (input.interactionMode !== serverThread.interactionMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.interaction-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          interactionMode: input.interactionMode,
          createdAt: input.createdAt,
        });
      }
    },
    [serverThread],
  );
  useEffect(() => {
    if (!isServerThread || !activeThread) {
      return;
    }
    if (activeThread.messages.length > 0 || activeThread.latestTurn !== null) {
      return;
    }
    if (activeThread.resumeState === "unrecoverable" || activeThread.resumeState === "resuming") {
      return;
    }

    const modelSelectionChanged =
      activeThread.modelSelection.provider !== draftThreadCreateModelSelection.provider ||
      activeThread.modelSelection.model !== draftThreadCreateModelSelection.model ||
      JSON.stringify(activeThread.modelSelection.options ?? null) !==
        JSON.stringify(draftThreadCreateModelSelection.options ?? null);
    const runtimeModeChanged = activeThread.runtimeMode !== runtimeMode;
    const interactionModeChanged = activeThread.interactionMode !== interactionMode;
    const needsSessionWarmup =
      activeThread.session === null ||
      activeThread.session.orchestrationStatus === "stopped" ||
      activeThread.session.orchestrationStatus === "error";

    if (
      !modelSelectionChanged &&
      !runtimeModeChanged &&
      !interactionModeChanged &&
      !needsSessionWarmup
    ) {
      return;
    }

    const api = readNativeApi();
    if (!api) {
      return;
    }

    void (async () => {
      await persistThreadSettingsForNextTurn({
        threadId: activeThread.id,
        createdAt: new Date().toISOString(),
        modelSelection: draftThreadCreateModelSelection,
        runtimeMode,
        interactionMode,
      }).catch(() => undefined);

      await api.orchestration
        .dispatchCommand({
          type: "thread.session.ensure",
          commandId: newCommandId(),
          threadId: activeThread.id,
          createdAt: new Date().toISOString(),
        })
        .catch(() => undefined);
    })();
  }, [
    activeThread,
    draftThreadCreateModelSelection,
    interactionMode,
    isServerThread,
    persistThreadSettingsForNextTurn,
    runtimeMode,
  ]);

  // Auto-scroll on new messages
  const messageCount = timelineMessages.length;
  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior });
    lastKnownScrollTopRef.current = scrollContainer.scrollTop;
    shouldAutoScrollRef.current = true;
  }, []);
  const cancelPendingStickToBottom = useCallback(() => {
    const pendingFrame = pendingAutoScrollFrameRef.current;
    if (pendingFrame === null) return;
    pendingAutoScrollFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);
  const cancelPendingInteractionAnchorAdjustment = useCallback(() => {
    const pendingFrame = pendingInteractionAnchorFrameRef.current;
    if (pendingFrame === null) return;
    pendingInteractionAnchorFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);
  const scheduleStickToBottom = useCallback(() => {
    if (pendingAutoScrollFrameRef.current !== null) return;
    pendingAutoScrollFrameRef.current = window.requestAnimationFrame(() => {
      pendingAutoScrollFrameRef.current = null;
      scrollMessagesToBottom();
    });
  }, [scrollMessagesToBottom]);
  const onMessagesClickCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer || !(event.target instanceof Element)) return;

      const trigger = event.target.closest<HTMLElement>(
        "button, summary, [role='button'], [data-scroll-anchor-target]",
      );
      if (!trigger || !scrollContainer.contains(trigger)) return;
      if (trigger.closest("[data-scroll-anchor-ignore]")) return;

      pendingInteractionAnchorRef.current = {
        element: trigger,
        top: trigger.getBoundingClientRect().top,
      };

      cancelPendingInteractionAnchorAdjustment();
      pendingInteractionAnchorFrameRef.current = window.requestAnimationFrame(() => {
        pendingInteractionAnchorFrameRef.current = null;
        const anchor = pendingInteractionAnchorRef.current;
        pendingInteractionAnchorRef.current = null;
        const activeScrollContainer = messagesScrollRef.current;
        if (!anchor || !activeScrollContainer) return;
        if (!anchor.element.isConnected || !activeScrollContainer.contains(anchor.element)) return;

        const nextTop = anchor.element.getBoundingClientRect().top;
        const delta = nextTop - anchor.top;
        if (Math.abs(delta) < 0.5) return;

        activeScrollContainer.scrollTop += delta;
        lastKnownScrollTopRef.current = activeScrollContainer.scrollTop;
      });
    },
    [cancelPendingInteractionAnchorAdjustment],
  );
  const forceStickToBottom = useCallback(() => {
    cancelPendingStickToBottom();
    scrollMessagesToBottom();
    scheduleStickToBottom();
  }, [cancelPendingStickToBottom, scheduleStickToBottom, scrollMessagesToBottom]);
  const pauseTimelineAutoScroll = useCallback(() => {
    shouldAutoScrollRef.current = false;
    pendingUserScrollUpIntentRef.current = false;

    const scrollContainer = messagesScrollRef.current;
    const canScroll =
      scrollContainer !== null && scrollContainer.scrollHeight > scrollContainer.clientHeight;
    setShowScrollToBottom(canScroll);
  }, []);
  const autoScrollOnSend = useCallback(() => {
    shouldAutoScrollRef.current = true;
    forceStickToBottom();
  }, [forceStickToBottom]);
  const onMessagesScroll = useCallback(() => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    const currentScrollTop = scrollContainer.scrollTop;
    const isNearBottom = isScrollContainerNearBottom(scrollContainer);

    if (!shouldAutoScrollRef.current && isNearBottom) {
      shouldAutoScrollRef.current = true;
      pendingUserScrollUpIntentRef.current = false;
    } else if (shouldAutoScrollRef.current && pendingUserScrollUpIntentRef.current) {
      const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
      if (scrolledUp && !isNearBottom) {
        shouldAutoScrollRef.current = false;
      }
      pendingUserScrollUpIntentRef.current = false;
    } else if (shouldAutoScrollRef.current && isPointerScrollActiveRef.current) {
      const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
      if (scrolledUp && !isNearBottom) {
        shouldAutoScrollRef.current = false;
      }
    } else if (shouldAutoScrollRef.current && !isNearBottom) {
      // Catch-all for keyboard/assistive scroll interactions.
      const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
      if (scrolledUp) {
        shouldAutoScrollRef.current = false;
      }
    }

    const canScroll = scrollContainer.scrollHeight > scrollContainer.clientHeight;
    setShowScrollToBottom(!shouldAutoScrollRef.current && canScroll);
    setIsScrolledFromTop(currentScrollTop > 8);
    lastKnownScrollTopRef.current = currentScrollTop;
  }, []);
  const onMessagesWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      pendingUserScrollUpIntentRef.current = true;
    }
  }, []);
  const onMessagesPointerDown = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = true;
  }, []);
  const onMessagesPointerUp = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = false;
  }, []);
  const onMessagesPointerCancel = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = false;
  }, []);
  const onMessagesTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    lastTouchClientYRef.current = touch.clientY;
  }, []);
  const onMessagesTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    const previousTouchY = lastTouchClientYRef.current;
    if (previousTouchY !== null && touch.clientY > previousTouchY + 1) {
      pendingUserScrollUpIntentRef.current = true;
    }
    lastTouchClientYRef.current = touch.clientY;
  }, []);
  const onMessagesTouchEnd = useCallback((_event: React.TouchEvent<HTMLDivElement>) => {
    lastTouchClientYRef.current = null;
  }, []);
  useEffect(() => {
    return () => {
      cancelPendingStickToBottom();
      cancelPendingInteractionAnchorAdjustment();
    };
  }, [cancelPendingInteractionAnchorAdjustment, cancelPendingStickToBottom]);
  useLayoutEffect(() => {
    if (!activeThread?.id) return;
    shouldAutoScrollRef.current = true;
    scheduleStickToBottom();
    const timeout = window.setTimeout(() => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer) return;
      if (isScrollContainerNearBottom(scrollContainer)) return;
      scheduleStickToBottom();
    }, 96);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [activeThread?.id, scheduleStickToBottom]);
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;
    const measureFooterCompactness = () => {
      const composerFormWidth = measureComposerFormWidth();
      const heuristicFooterCompact = shouldUseCompactComposerFooter(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      });
      const footer = composerFooterRef.current;
      const footerStyle = footer ? window.getComputedStyle(footer) : null;
      const footerContentWidth = resolveComposerFooterContentWidth({
        footerWidth: footer?.clientWidth ?? null,
        paddingLeft: footerStyle ? Number.parseFloat(footerStyle.paddingLeft) : null,
        paddingRight: footerStyle ? Number.parseFloat(footerStyle.paddingRight) : null,
      });
      const fitInput = {
        footerContentWidth,
        leadingContentWidth: composerFooterLeadingRef.current?.scrollWidth ?? null,
        actionsWidth: composerFooterActionsRef.current?.scrollWidth ?? null,
      };
      const nextFooterCompact =
        heuristicFooterCompact || shouldForceCompactComposerFooterForFit(fitInput);
      const nextPrimaryActionsCompact =
        nextFooterCompact &&
        shouldUseCompactComposerPrimaryActions(composerFormWidth, {
          hasWideActions: composerFooterHasWideActions,
        });

      return {
        primaryActionsCompact: nextPrimaryActionsCompact,
        footerCompact: nextFooterCompact,
      };
    };

    composerFormHeightRef.current = composerForm.getBoundingClientRect().height;
    const initialCompactness = measureFooterCompactness();
    setIsComposerPrimaryActionsCompact(initialCompactness.primaryActionsCompact);
    setIsComposerFooterCompact(initialCompactness.footerCompact);
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;

      const nextCompactness = measureFooterCompactness();
      setIsComposerPrimaryActionsCompact((previous) =>
        previous === nextCompactness.primaryActionsCompact
          ? previous
          : nextCompactness.primaryActionsCompact,
      );
      setIsComposerFooterCompact((previous) =>
        previous === nextCompactness.footerCompact ? previous : nextCompactness.footerCompact,
      );

      const nextHeight = entry.contentRect.height;
      const previousHeight = composerFormHeightRef.current;
      composerFormHeightRef.current = nextHeight;

      if (previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) return;
      if (!shouldAutoScrollRef.current) return;
      scheduleStickToBottom();
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [
    activeThread?.id,
    composerFooterActionLayoutKey,
    composerFooterHasWideActions,
    scheduleStickToBottom,
  ]);
  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [messageCount, scheduleStickToBottom]);
  useEffect(() => {
    if (!isTurnRunning) return;
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [isTurnRunning, scheduleStickToBottom, timelineEntries]);
  // Clear scroll masks when the content no longer overflows the container.
  useEffect(() => {
    const el = messagesScrollElement;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const canScroll = el.scrollHeight > el.clientHeight;
      if (!canScroll) {
        setShowScrollToBottom(false);
        setIsScrolledFromTop(false);
      }
    });
    observer.observe(el);
    // Also observe the inner content size (first child, if any).
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [messagesScrollElement]);

  useEffect(() => {
    setExpandedWorkGroups({});
    setPullRequestDialogState(null);
    if (planSidebarOpenOnNextThreadRef.current) {
      planSidebarOpenOnNextThreadRef.current = false;
      setPlanSidebarOpen(true);
    } else {
      setPlanSidebarOpen(false);
    }
    planSidebarDismissedForTurnRef.current = null;
  }, [activeThread?.id]);

  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      return;
    }
    setComposerHighlightedItemId((existing) =>
      existing && composerMenuItems.some((item) => item.id === existing)
        ? existing
        : (composerMenuItems[0]?.id ?? null),
    );
  }, [composerMenuItems, composerMenuOpen]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id || terminalState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, terminalState.terminalOpen]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages]);

  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) {
      return;
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [activeThread?.id, activeThread?.messages, handoffAttachmentPreviews, optimisticUserMessages]);

  useEffect(() => {
    promptRef.current = prompt;
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
  }, [prompt]);

  useEffect(() => {
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    resetLocalDispatch();
    setComposerHighlightedItemId(null);
    setComposerCursor(collapseExpandedComposerCursor(promptRef.current, promptRef.current.length));
    setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    setExpandedImage(null);
  }, [resetLocalDispatch, threadId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(threadId);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ?? [];
      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
        await Promise.all(
          composerImages.map(async (image) => {
            try {
              const dataUrl = await readFileAsDataUrl(image.file);
              stagedAttachmentById.set(image.id, {
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
              });
            } catch {
              const existingPersisted = existingPersistedById.get(image.id);
              if (existingPersisted) {
                stagedAttachmentById.set(image.id, existingPersisted);
              }
            }
          }),
        );
        const serialized = Array.from(stagedAttachmentById.values());
        if (cancelled) {
          return;
        }
        // Stage attachments in persisted draft state first so persist middleware can write them.
        syncComposerDraftPersistedAttachments(threadId, serialized);
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        const fallbackPersistedIds = fallbackPersistedAttachments
          .map((attachment) => attachment.id)
          .filter((id) => currentImageIds.has(id));
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) {
          return;
        }
        syncComposerDraftPersistedAttachments(threadId, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    clearComposerDraftPersistedAttachments,
    composerImages,
    syncComposerDraftPersistedAttachments,
    threadId,
  ]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);
  const navigateExpandedImage = useCallback((direction: -1 | 1) => {
    setExpandedImage((existing) => {
      if (!existing || existing.images.length <= 1) {
        return existing;
      }
      const nextIndex =
        (existing.index + direction + existing.images.length) % existing.images.length;
      if (nextIndex === existing.index) {
        return existing;
      }
      return { ...existing, index: nextIndex };
    });
  }, []);

  useEffect(() => {
    if (!expandedImage) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeExpandedImage();
        return;
      }
      if (expandedImage.images.length <= 1) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateExpandedImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateExpandedImage(1);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeExpandedImage, expandedImage, navigateExpandedImage]);

  const activeWorktreePath = activeThread?.worktreePath;
  const envMode: DraftThreadEnvMode = activeWorktreePath
    ? "worktree"
    : isLocalDraftThread
      ? (draftThread?.envMode ?? "local")
      : "local";

  useEffect(() => {
    if (!activeThreadId) return;
    const previous = terminalOpenByThreadRef.current[activeThreadId] ?? false;
    const current = Boolean(terminalState.terminalOpen);

    if (!previous && current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalOpenByThreadRef.current[activeThreadId] = current;
  }, [activeThreadId, focusComposer, terminalState.terminalOpen]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || event.defaultPrevented) return;

      // Meta+Shift+P (Ctrl+Shift+P on non-Mac) toggles plan mode
      if (
        event.shiftKey &&
        event.key.toLowerCase() === "p" &&
        (isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey)
      ) {
        event.preventDefault();
        event.stopPropagation();
        toggleInteractionMode();
        return;
      }

      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: Boolean(terminalState.terminalOpen),
      };

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) return;
        closeTerminal(terminalState.activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      if (command === "browser.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleBrowser();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    terminalState.terminalOpen,
    terminalState.activeTerminalId,
    activeThreadId,
    closeTerminal,
    createNewTerminal,
    setTerminalOpen,
    splitTerminal,
    keybindings,
    onToggleBrowser,
    onToggleDiff,
    toggleInteractionMode,
    toggleTerminalVisibility,
  ]);

  const addComposerImages = (files: File[]) => {
    if (!activeThreadId || files.length === 0) return;

    if (pendingUserInputs.length > 0) {
      toastManager.add({
        type: "error",
        title: "Attach images after answering plan questions.",
      });
      return;
    }

    if (!selectedModelSupportsImageAttachments) {
      toastManager.add({
        type: "error",
        title: "Image attachments unavailable",
        description: buildUnsupportedImageAttachmentMessage(selectedModelDisplayName),
      });
      return;
    }

    const nextImages: ComposerImageAttachment[] = [];
    let nextImageCount = composerImagesRef.current.length;
    let error: string | null = null;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
        continue;
      }
      if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        error = `'${file.name}' exceeds the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`;
        continue;
      }
      if (nextImageCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
        break;
      }

      const previewUrl = URL.createObjectURL(file);
      nextImages.push({
        type: "image",
        id: randomUUID(),
        name: file.name || "image",
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl,
        file,
      });
      nextImageCount += 1;
    }

    if (nextImages.length === 1 && nextImages[0]) {
      addComposerImage(nextImages[0]);
    } else if (nextImages.length > 1) {
      addComposerImagesToDraft(nextImages);
    }
    setThreadError(activeThreadId, error);
  };

  const removeComposerImage = (imageId: string) => {
    removeComposerImageFromDraft(imageId);
  };

  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) {
      return;
    }
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    addComposerImages(imageFiles);
  };

  const onComposerDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOverComposer(true);
  };

  const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverComposer(true);
  };

  const onComposerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOverComposer(false);
    }
  };

  const onComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    const files = Array.from(event.dataTransfer.files);
    addComposerImages(files);
    focusComposer();
  };

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const api = readNativeApi();
      if (!api || !activeThread || isRevertingCheckpoint) return;

      if (isTurnRunning || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
        return;
      }
      const confirmed = await api.dialogs.confirm(
        [
          `Revert this thread to checkpoint ${turnCount}?`,
          "This will discard newer messages and turn diffs in this thread.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.checkpoint.revert",
          commandId: newCommandId(),
          threadId: activeThread.id,
          turnCount,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to revert thread state.",
        );
      }
      setIsRevertingCheckpoint(false);
    },
    [activeThread, isConnecting, isRevertingCheckpoint, isSendBusy, isTurnRunning, setThreadError],
  );

  const onSend = async (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    const api = readNativeApi();
    if (!api || !activeThread || isSendBusy || isConnecting || sendInFlightRef.current) return;
    if (activePendingProgress) {
      if (activePendingProgress.isLastQuestion && activePendingResolvedAnswers) {
        autoScrollOnSend();
      }
      onAdvanceActivePendingUserInput();
      return;
    }
    let promptForSend = promptRef.current;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent: initialHasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length,
      terminalContexts: composerTerminalContexts,
    });
    if (showPlanFollowUpPrompt && activeProposedPlan) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      promptRef.current = "";
      clearComposerDraftContent(activeThread.id);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
      await onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      });
      return;
    }
    let hasSendableContent = initialHasSendableContent;
    const standaloneSlashCommand =
      composerImages.length === 0 && sendableComposerTerminalContexts.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand) {
      if (standaloneSlashCommand.command === "review") {
        promptForSend = REVIEW_RECENT_CHANGES_PROMPT;
        promptRef.current = promptForSend;
        hasSendableContent = true;
        clearComposerDraftContent(activeThread.id);
        setComposerHighlightedItemId(null);
        setComposerCursor(0);
        setComposerTrigger(null);
      } else if (standaloneSlashCommand.command === "compact") {
        promptForSend = COMPACT_THREAD_CONTEXT_PROMPT;
        promptRef.current = promptForSend;
        hasSendableContent = true;
        clearComposerDraftContent(activeThread.id);
        setComposerHighlightedItemId(null);
        setComposerCursor(0);
        setComposerTrigger(null);
      } else if (standaloneSlashCommand.command === "fast") {
        toggleFastMode();
        promptRef.current = "";
        clearComposerDraftContent(activeThread.id);
        setComposerHighlightedItemId(null);
        setComposerCursor(0);
        setComposerTrigger(null);
        return;
      } else if (standaloneSlashCommand.command === "feedback") {
        openSettingsRoute("/settings/feedback");
        promptRef.current = "";
        clearComposerDraftContent(activeThread.id);
        setComposerHighlightedItemId(null);
        setComposerCursor(0);
        setComposerTrigger(null);
        return;
      } else if (standaloneSlashCommand.command === "fork") {
        await handleForkThread(standaloneSlashCommand.value ?? "local");
        promptRef.current = "";
        clearComposerDraftContent(activeThread.id);
        setComposerHighlightedItemId(null);
        setComposerCursor(0);
        setComposerTrigger(null);
        return;
      } else if (standaloneSlashCommand.command === "mcp") {
        openSettingsRoute("/settings/skills");
        promptRef.current = "";
        clearComposerDraftContent(activeThread.id);
        setComposerHighlightedItemId(null);
        setComposerCursor(0);
        setComposerTrigger(null);
        return;
      } else if (standaloneSlashCommand.command === "memories") {
        toggleMemoriesGeneration();
        promptRef.current = "";
        clearComposerDraftContent(activeThread.id);
        setComposerHighlightedItemId(null);
        setComposerCursor(0);
        setComposerTrigger(null);
        return;
      } else if (standaloneSlashCommand.command === "personality") {
        handleAssistantPersonalityChange(standaloneSlashCommand.value);
        promptRef.current = "";
        clearComposerDraftContent(activeThread.id);
        setComposerHighlightedItemId(null);
        setComposerCursor(0);
        setComposerTrigger(null);
        return;
      } else {
        handleInteractionModeChange(standaloneSlashCommand.command);
        promptRef.current = "";
        clearComposerDraftContent(activeThread.id);
        setComposerHighlightedItemId(null);
        setComposerCursor(0);
        setComposerTrigger(null);
        return;
      }
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        });
      }
      return;
    }
    if (composerImages.length > 0 && !selectedModelSupportsImageAttachments) {
      setThreadError(
        activeThread.id,
        buildUnsupportedImageAttachmentMessage(selectedModelDisplayName),
      );
      return;
    }
    if (!activeProject) return;
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || activeThread.messages.length === 0;
    const baseBranchForWorktree =
      isFirstMessage && envMode === "worktree" && !activeThread.worktreePath
        ? activeThread.branch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && envMode === "worktree" && !activeThread.worktreePath;
    if (shouldCreateWorktree && !activeThread.branch) {
      setStoreThreadError(
        threadIdForSend,
        "Select a base branch before sending in New worktree mode.",
      );
      return;
    }
    try {
      await ensureProviderCanStartTurn(selectedModelSelection.provider);
    } catch (error) {
      setStoreThreadError(
        threadIdForSend,
        error instanceof Error ? error.message : "Selected provider is unavailable.",
      );
      return;
    }

    sendInFlightRef.current = true;
    flushSync(() => {
      beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });
    });

    const composerImagesSnapshot = [...composerImages];
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const messageTextForSend = appendTerminalContextsToPrompt(
      promptForSend,
      composerTerminalContextsSnapshot,
    );
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = formatOutgoingPrompt({
      provider: selectedProvider,
      model: selectedModel,
      models: selectedProviderModels,
      effort: selectedPromptEffort,
      text: messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
    });
    const title = buildDraftThreadTitle({
      trimmedPrompt: trimmed,
      composerImagesSnapshot,
      composerTerminalContextsSnapshot,
    });
    const queuedImageSnapshotPromise = Promise.all(
      composerImagesSnapshot.map(async (image) => {
        const dataUrl = await readFileAsDataUrl(image.file);
        return {
          persistedAttachment: {
            id: image.id,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl,
          },
          uploadAttachment: {
            type: "image" as const,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl,
          },
        };
      }),
    );
    const optimisticAttachments = composerImagesSnapshot.map((image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    }));

    if (isTurnRunning) {
      autoScrollOnSend();
      const queuedImageSnapshots = await queuedImageSnapshotPromise;
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "omitted",
        );
        toastManager.add({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        });
      }

      enqueueQueuedTurn({
        id: randomUUID(),
        threadId: threadIdForSend,
        messageId: String(messageIdForSend),
        text: outgoingMessageText,
        attachments: queuedImageSnapshots.map((snapshot) => snapshot.uploadAttachment),
        modelSelection: selectedModelSelection,
        runtimeMode,
        interactionMode,
        titleSeed: activeThread.title.trim() || "New Thread",
        createdAt: messageCreatedAt,
        composerSnapshot: {
          prompt: promptForSend,
          persistedAttachments: queuedImageSnapshots.map(
            (snapshot) => snapshot.persistedAttachment,
          ),
          terminalContexts: composerTerminalContextsSnapshot,
        },
      });
      promptRef.current = "";
      clearComposerDraftContent(threadIdForSend);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
      setThreadError(threadIdForSend, null);
      toastManager.add({
        type: "info",
        title: "Message queued",
        description: "It will send automatically when the current turn finishes.",
      });
      sendInFlightRef.current = false;
      resetLocalDispatch();
      return;
    }

    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
        createdAt: messageCreatedAt,
        streaming: false,
      },
    ]);
    // Sending a message should always bring the latest user turn into view.
    autoScrollOnSend();

    setThreadError(threadIdForSend, null);
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add({
        type: "warning",
        title: toastCopy.title,
        description: toastCopy.description,
      });
    }
    promptRef.current = "";
    clearComposerDraftContent(threadIdForSend);
    setComposerHighlightedItemId(null);
    setComposerCursor(0);
    setComposerTrigger(null);

    let createdServerThreadForLocalDraft = false;
    let turnStartSucceeded = false;
    let hasMaterializedServerThread = isServerThread;
    let nextThreadBranch = activeThread.branch;
    let nextThreadWorktreePath = activeThread.worktreePath;
    await (async () => {
      if (!hasMaterializedServerThread && isLocalDraftThread) {
        hasMaterializedServerThread = await materializeLocalDraftThread({
          title,
          modelSelection: draftThreadCreateModelSelection,
          branch: nextThreadBranch,
          worktreePath: nextThreadWorktreePath,
        });
      }

      // On first message: lock in branch + create worktree if needed.
      if (baseBranchForWorktree) {
        beginLocalDispatch({ preparingWorktree: true });
        const newBranch = buildTemporaryWorktreeBranchName();
        const result = await createWorktreeMutation.mutateAsync({
          cwd: activeProject.cwd,
          branch: baseBranchForWorktree,
          newBranch,
        });
        nextThreadBranch = result.worktree.branch;
        nextThreadWorktreePath = result.worktree.path;
        if (hasMaterializedServerThread) {
          await api.orchestration.dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: threadIdForSend,
            branch: result.worktree.branch,
            worktreePath: result.worktree.path,
          });
          // Keep local thread state in sync immediately so terminal drawer opens
          // with the worktree cwd/env instead of briefly using the project root.
          setStoreThreadBranch(threadIdForSend, result.worktree.branch, result.worktree.path);
        }
      }

      if (isLocalDraftThread && !hasMaterializedServerThread) {
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          projectId: activeProject.id,
          title,
          modelSelection: draftThreadCreateModelSelection,
          runtimeMode,
          interactionMode,
          parentThreadId: null,
          branchSourceTurnId: null,
          branch: nextThreadBranch,
          worktreePath: nextThreadWorktreePath,
          createdAt: activeThread.createdAt,
        });
        createdServerThreadForLocalDraft = true;
        hasMaterializedServerThread = true;
      }

      // Auto-title from first message
      if (isFirstMessage && hasMaterializedServerThread) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          title,
        });
      }

      if (hasMaterializedServerThread) {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          ...(selectedModel ? { modelSelection: selectedModelSelection } : {}),
          runtimeMode,
          interactionMode,
        });
      }

      beginLocalDispatch({ preparingWorktree: false });
      const turnAttachments = (await queuedImageSnapshotPromise).map(
        (snapshot) => snapshot.uploadAttachment,
      );
      await ensureProviderCanStartTurn(selectedModelSelection.provider);
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          attachments: turnAttachments,
        },
        modelSelection: selectedModelSelection,
        titleSeed: title,
        runtimeMode,
        interactionMode,
        createdAt: messageCreatedAt,
      });
      turnStartSucceeded = true;
    })().catch(async (err: unknown) => {
      if (createdServerThreadForLocalDraft && !turnStartSucceeded) {
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: threadIdForSend,
          })
          .catch(() => undefined);
      }
      if (
        !turnStartSucceeded &&
        promptRef.current.length === 0 &&
        composerImagesRef.current.length === 0 &&
        composerTerminalContextsRef.current.length === 0
      ) {
        setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        promptRef.current = promptForSend;
        setPrompt(promptForSend);
        setComposerCursor(collapseExpandedComposerCursor(promptForSend, promptForSend.length));
        addComposerImagesToDraft(composerImagesSnapshot.map(cloneComposerImageForRetry));
        addComposerTerminalContextsToDraft(composerTerminalContextsSnapshot);
        setComposerTrigger(detectComposerTrigger(promptForSend, promptForSend.length));
      }
      setThreadError(
        threadIdForSend,
        err instanceof Error ? err.message : "Failed to send message.",
      );
    });
    sendInFlightRef.current = false;
    if (!turnStartSucceeded) {
      resetLocalDispatch();
    }
  };

  const onInterrupt = async () => {
    const api = readNativeApi();
    if (!api || !activeThread) return;
    await api.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId: activeThread.id,
      ...(activeLatestTurn?.turnId ? { turnId: activeLatestTurn.turnId } : {}),
      createdAt: new Date().toISOString(),
    });
  };

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      setRespondingApprovalDecision(decision);
      await api.orchestration
        .dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setStoreThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit approval decision.",
          );
        });
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      setRespondingApprovalDecision(null);
    },
    [activeThreadId, setStoreThreadError],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      await api.orchestration
        .dispatchCommand({
          type: "thread.user-input.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          answers,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setStoreThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit user input.",
          );
        });
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [activeThreadId, setStoreThreadError],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: {
            selectedOptionLabel: optionLabel,
            customAnswer: "",
          },
        },
      }));
      promptRef.current = "";
      setComposerCursor(0);
      setComposerTrigger(null);
    },
    [activePendingUserInput],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInput) {
        return;
      }
      promptRef.current = value;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingUserInput.requestId]?.[questionId],
            value,
          ),
        },
      }));
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(value, expandedCursor),
      );
    },
    [activePendingUserInput],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      interactionMode: nextInteractionMode,
    }: {
      text: string;
      interactionMode: "default" | "plan";
    }) => {
      const api = readNativeApi();
      if (
        !api ||
        !activeThread ||
        !isServerThread ||
        isSendBusy ||
        isConnecting ||
        sendInFlightRef.current
      ) {
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const outgoingMessageText = formatOutgoingPrompt({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        effort: selectedPromptEffort,
        text: trimmed,
      });
      try {
        await ensureProviderCanStartTurn(selectedModelSelection.provider);
      } catch (error) {
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : "Selected provider is unavailable.",
        );
        return;
      }

      sendInFlightRef.current = true;
      flushSync(() => {
        beginLocalDispatch({ preparingWorktree: false });
      });
      setThreadError(threadIdForSend, null);
      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          createdAt: messageCreatedAt,
          streaming: false,
        },
      ]);
      autoScrollOnSend();

      try {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          modelSelection: selectedModelSelection,
          runtimeMode,
          interactionMode: nextInteractionMode,
        });

        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(threadIdForSend, nextInteractionMode);

        await ensureProviderCanStartTurn(selectedModelSelection.provider);
        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: [],
          },
          modelSelection: selectedModelSelection,
          titleSeed: activeThread.title,
          runtimeMode,
          interactionMode: nextInteractionMode,
          ...(nextInteractionMode === "default" && activeProposedPlan
            ? {
                sourceProposedPlan: {
                  threadId: activeThread.id,
                  planId: activeProposedPlan.id,
                },
              }
            : {}),
          createdAt: messageCreatedAt,
        });
        // Optimistically open the plan sidebar when implementing (not refining).
        // "default" mode here means the agent is executing the plan, which produces
        // step-tracking activities that the sidebar will display.
        if (nextInteractionMode === "default") {
          planSidebarDismissedForTurnRef.current = null;
          setPlanSidebarOpen(true);
        }
        sendInFlightRef.current = false;
      } catch (err) {
        setOptimisticUserMessages((existing) =>
          existing.filter((message) => message.id !== messageIdForSend),
        );
        setThreadError(
          threadIdForSend,
          err instanceof Error ? err.message : "Failed to send plan follow-up.",
        );
        sendInFlightRef.current = false;
        resetLocalDispatch();
      }
    },
    [
      activeThread,
      activeProposedPlan,
      autoScrollOnSend,
      beginLocalDispatch,
      ensureProviderCanStartTurn,
      isConnecting,
      isSendBusy,
      isServerThread,
      persistThreadSettingsForNextTurn,
      resetLocalDispatch,
      runtimeMode,
      selectedPromptEffort,
      selectedModelSelection,
      selectedProvider,
      selectedProviderModels,
      setComposerDraftInteractionMode,
      setThreadError,
      selectedModel,
    ],
  );

  const onImplementPlanInNewThread = useCallback(async () => {
    const api = readNativeApi();
    if (
      !api ||
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      sendInFlightRef.current
    ) {
      return;
    }

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: selectedProvider,
      model: selectedModel,
      models: selectedProviderModels,
      effort: selectedPromptEffort,
      text: implementationPrompt,
    });
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = selectedModelSelection;
    try {
      await ensureProviderCanStartTurn(nextThreadModelSelection.provider);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not start implementation thread",
        description: error instanceof Error ? error.message : "Selected provider is unavailable.",
      });
      return;
    }

    sendInFlightRef.current = true;
    flushSync(() => {
      beginLocalDispatch({ preparingWorktree: false });
    });
    const finish = () => {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    };

    await api.orchestration
      .dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        runtimeMode,
        interactionMode: "default",
        parentThreadId: null,
        branchSourceTurnId: null,
        branch: activeThread.branch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      })
      .then(() => {
        return ensureProviderCanStartTurn(nextThreadModelSelection.provider);
      })
      .then(() => {
        return api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: selectedModelSelection,
          titleSeed: nextThreadTitle,
          runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        });
      })
      .then(() => {
        return waitForStartedServerThread(nextThreadId);
      })
      .then(() => {
        // Signal that the plan sidebar should open on the new thread.
        planSidebarOpenOnNextThreadRef.current = true;
        return navigate({
          to: "/$threadId",
          params: { threadId: nextThreadId },
        });
      })
      .catch(async (err) => {
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: nextThreadId,
          })
          .catch(() => undefined);
        toastManager.add({
          type: "error",
          title: "Could not start implementation thread",
          description:
            err instanceof Error ? err.message : "An error occurred while creating the new thread.",
        });
      })
      .then(finish, finish);
  }, [
    activeProject,
    activeProposedPlan,
    activeThread,
    beginLocalDispatch,
    ensureProviderCanStartTurn,
    isConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    resetLocalDispatch,
    runtimeMode,
    selectedPromptEffort,
    selectedModelSelection,
    selectedProvider,
    selectedProviderModels,
    selectedModel,
  ]);

  const onProviderModelSelect = useCallback(
    (provider: ProviderKind, model: string) => {
      if (!activeThread) return;
      if (lockedProvider !== null && provider !== lockedProvider) {
        scheduleComposerFocus();
        return;
      }
      const resolvedProvider = resolveSelectableProvider(providerStatuses, provider);
      const resolvedModel = resolveAppModelSelection(
        resolvedProvider,
        settings,
        providerStatuses,
        model,
      );
      const nextModelSelection: ModelSelection = {
        provider: resolvedProvider,
        model: resolvedModel,
      };
      setComposerDraftModelSelection(activeThread.id, nextModelSelection);
      setStickyComposerModelSelection(nextModelSelection);
      if (composerImagesRef.current.length > 0) {
        const nextProviderModels = getProviderModels(providerStatuses, resolvedProvider);
        if (
          !providerModelSupportsImageAttachments(
            nextProviderModels,
            resolvedModel,
            resolvedProvider,
          )
        ) {
          toastManager.add({
            type: "warning",
            title: "Attached images won't send with this model",
            description: buildUnsupportedImageAttachmentMessage(
              getProviderModelDisplayName(nextProviderModels, resolvedModel, resolvedProvider),
            ),
          });
        }
      }
      scheduleComposerFocus();
    },
    [
      activeThread,
      lockedProvider,
      providerStatuses,
      scheduleComposerFocus,
      setComposerDraftModelSelection,
      setStickyComposerModelSelection,
      settings,
    ],
  );
  const setPromptFromTraits = useCallback(
    (nextPrompt: string) => {
      const currentPrompt = promptRef.current;
      if (nextPrompt === currentPrompt) {
        scheduleComposerFocus();
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [scheduleComposerFocus, setPrompt],
  );
  const providerTraitsMenuContent = renderProviderTraitsMenuContent({
    provider: selectedProvider,
    threadId,
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedProvider],
    prompt,
    onPromptChange: setPromptFromTraits,
  });
  const providerEffortPicker = renderProviderEffortPicker({
    provider: selectedProvider,
    threadId,
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedProvider],
    prompt,
    onPromptChange: setPromptFromTraits,
  });
  const providerTraitsPicker = renderProviderTraitsPicker({
    provider: selectedProvider,
    threadId,
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedProvider],
    prompt,
    onPromptChange: setPromptFromTraits,
  });
  const compactControlsMenuNeeded = Boolean(
    providerTraitsMenuContent || activePlan || sidebarProposedPlan || planSidebarOpen,
  );
  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { envMode: mode });
      }
      scheduleComposerFocus();
    },
    [isLocalDraftThread, scheduleComposerFocus, setDraftThreadContext, threadId],
  );

  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string },
    ): boolean => {
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInput) {
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingUserInput.requestId]: {
            ...existing[activePendingUserInput.requestId],
            [activePendingQuestion.id]: setPendingUserInputCustomAnswer(
              existing[activePendingUserInput.requestId]?.[activePendingQuestion.id],
              next.text,
            ),
          },
        }));
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        detectComposerTrigger(next.text, expandCollapsedComposerCursor(next.text, nextCursor)),
      );
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCursor);
      });
      return true;
    },
    [activePendingProgress?.activeQuestion, activePendingUserInput, setPrompt],
  );

  const readComposerSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    };
  }, [composerCursor, composerTerminalContexts]);

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
    };
  }, [readComposerSnapshot]);

  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) => {
      if (composerSelectLockRef.current) return;
      composerSelectLockRef.current = true;
      window.requestAnimationFrame(() => {
        composerSelectLockRef.current = false;
      });
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      if (item.type === "agent") {
        const replacement = `@${item.mentionName} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "path") {
        const replacement = `@${item.path} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "slash-command") {
        if (item.command === "model") {
          const replacement = "/model ";
          const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
            snapshot.value,
            trigger.rangeEnd,
            replacement,
          );
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            replacementRangeEnd,
            replacement,
            { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
          );
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
        if (item.command === "personality" && !item.value) {
          const replacement = "/personality ";
          const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
            snapshot.value,
            trigger.rangeEnd,
            replacement,
          );
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            replacementRangeEnd,
            replacement,
            { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
          );
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
        if (item.command === "fork" && !item.value) {
          const replacement = "/fork ";
          const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
            snapshot.value,
            trigger.rangeEnd,
            replacement,
          );
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            replacementRangeEnd,
            replacement,
            { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
          );
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
        if (item.command === "review") {
          const replacement = REVIEW_RECENT_CHANGES_PROMPT;
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            trigger.rangeEnd,
            replacement,
            { expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd) },
          );
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }
        if (item.command === "compact") {
          const applied = applyPromptReplacement(
            trigger.rangeStart,
            trigger.rangeEnd,
            COMPACT_THREAD_CONTEXT_PROMPT,
            { expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd) },
          );
          if (applied) {
            setComposerHighlightedItemId(null);
          }
          return;
        }

        if (item.command === "fast") {
          toggleFastMode();
        } else if (item.command === "feedback") {
          openSettingsRoute("/settings/feedback");
        } else if (item.command === "fork") {
          void handleForkThread(item.value === "worktree" ? "worktree" : "local");
        } else if (item.command === "mcp") {
          openSettingsRoute("/settings/skills");
        } else if (item.command === "memories") {
          toggleMemoriesGeneration();
        } else if (item.command === "personality" && item.value) {
          handleAssistantPersonalityChange(
            item.value as (typeof ASSISTANT_PERSONALITY_OPTIONS)[number]["value"],
          );
        } else {
          void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
        }
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      onProviderModelSelect(item.provider, item.model);
      const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
        expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
      });
      if (applied) {
        setComposerHighlightedItemId(null);
      }
    },
    [
      applyPromptReplacement,
      handleAssistantPersonalityChange,
      handleForkThread,
      handleInteractionModeChange,
      openSettingsRoute,
      onProviderModelSelect,
      resolveActiveComposerTrigger,
      toggleFastMode,
      toggleMemoriesGeneration,
    ],
  );
  const onComposerMenuItemHighlighted = useCallback((itemId: string | null) => {
    setComposerHighlightedItemId(itemId);
  }, []);
  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) {
        return;
      }
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [composerHighlightedItemId, composerMenuItems],
  );
  const isComposerMenuLoading =
    composerTriggerKind === "path" &&
    ((pathTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
      workspaceEntriesQuery.isLoading ||
      workspaceEntriesQuery.isFetching);
  const hasDecoratedComposerFrame =
    composerProviderState.composerFrameClassName !== undefined &&
    composerProviderState.composerFrameClassName.length > 0;

  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      terminalContextIds: string[],
    ) => {
      if (activePendingProgress?.activeQuestion && activePendingUserInput) {
        onChangeActivePendingUserInputCustomAnswer(
          activePendingProgress.activeQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
        setComposerDraftTerminalContexts(
          threadId,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        );
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      composerTerminalContexts,
      onChangeActivePendingUserInputCustomAnswer,
      setPrompt,
      setComposerDraftTerminalContexts,
      threadId,
    ],
  );

  const onComposerCommandKey = (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => {
    if (key === "Tab" && event.shiftKey) {
      toggleInteractionMode();
      return true;
    }

    const { trigger } = resolveActiveComposerTrigger();
    const menuIsActive = composerMenuOpenRef.current || trigger !== null;

    if (menuIsActive) {
      const currentItems = composerMenuItemsRef.current;
      if (key === "ArrowDown" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if (key === "Tab" || key === "Enter") {
        const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
        if (selectedItem) {
          onSelectComposerItem(selectedItem);
          return true;
        }
      }
    }

    if (key === "Enter" && !event.shiftKey) {
      void onSend();
      return true;
    }
    return false;
  };
  const onToggleWorkGroup = useCallback(
    (groupId: string, currentlyExpanded: boolean) => {
      if (currentlyExpanded) {
        pauseTimelineAutoScroll();
      }
      setExpandedWorkGroups((existing) => ({
        ...existing,
        [groupId]: !currentlyExpanded,
      }));
    },
    [pauseTimelineAutoScroll],
  );
  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const expandedImageItem = expandedImage ? expandedImage.images[expandedImage.index] : null;
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      if (!isProjectThread) {
        return;
      }

      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return filePath
            ? { ...rest, diff: "1", diffTurnId: turnId, diffFilePath: filePath }
            : { ...rest, diff: "1", diffTurnId: turnId };
        },
      });
    },
    [isProjectThread, navigate, threadId],
  );
  const onRevertUserMessage = (messageId: MessageId) => {
    const targetTurnCount = revertTurnCountByUserMessageId.get(messageId);
    if (typeof targetTurnCount !== "number") {
      return;
    }
    void onRevertToTurnCount(targetTurnCount);
  };

  const onRetryAssistantMessage = useCallback(
    async (assistantMessageId: MessageId) => {
      const api = readNativeApi();
      if (
        !api ||
        !activeThread ||
        isRevertingCheckpoint ||
        isTurnRunning ||
        isSendBusy ||
        isConnecting ||
        sendInFlightRef.current
      )
        return;

      try {
        autoScrollOnSend();
        await api.orchestration.dispatchCommand({
          type: "thread.turn.retry",
          commandId: newCommandId(),
          threadId: activeThread.id,
          assistantMessageId,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to retry message.",
        );
      }
    },
    [
      activeThread,
      autoScrollOnSend,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      isTurnRunning,
      setThreadError,
    ],
  );

  // Empty state: no active thread
  if (!activeThread) {
    return <NoActiveThreadState />;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      {/* Top bar */}
      <header
        className={cn(
          "px-3 sm:px-5",
          isElectron ? "drag-region flex h-[52px] items-center" : "py-2 sm:py-3",
        )}
      >
        <ChatHeader
          activeThreadTitle={activeThread.title}
          activeProjectPath={gitCwd ?? undefined}
          isGitRepo={isGitRepo}
          openInCwd={gitCwd}
          keybindings={keybindings}
          availableEditors={availableEditors}
          terminalToggleShortcutLabel={terminalToggleShortcutLabel}
          browserToggleShortcutLabel={browserPanelShortcutLabel}
          diffToggleShortcutLabel={diffPanelShortcutLabel}
          browserOpen={browserOpen}
          diffOpen={diffOpen}
          isBranchedThread={activeThread.parentThreadId !== null}
          parentThread={
            parentThread
              ? {
                  threadId: parentThread.id,
                  title: parentThread.title,
                  archivedAt: parentThread.archivedAt,
                }
              : null
          }
          missingParentThread={
            activeThread.parentThreadId && !parentThread
              ? { threadId: activeThread.parentThreadId }
              : null
          }
          childThreads={childThreads.map((thread) => ({
            threadId: thread.id,
            title: thread.title,
            archivedAt: thread.archivedAt,
          }))}
          onBranchThread={
            isServerThread && activeThread.archivedAt === null ? handleBranchActiveThread : null
          }
          onNavigateToThread={(nextThreadId) => {
            void navigate({
              to: "/$threadId",
              params: { threadId: nextThreadId },
            });
          }}
          onToggleBrowser={onToggleBrowser}
          onToggleDiff={onToggleDiff}
        />
      </header>

      {/* Error banner */}
      <ProviderStatusBanner status={activeProviderStatus} />
      <ThreadResumeBanner
        resumeState={activeThread.resumeState}
        onResumeAction={() => focusComposer()}
      />
      <ThreadErrorBanner
        error={activeThread.error}
        onDismiss={() => setThreadError(activeThread.id, null)}
      />
      {/* Main content area with optional plan sidebar */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Chat column */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Messages Wrapper */}
          {!isEmptyThread && (
            <div className="relative flex min-h-0 flex-1 flex-col">
              {/* Messages */}
              <div
                ref={setMessagesScrollContainerRef}
                className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 py-3 [-ms-overflow-style:none] [scrollbar-width:none] sm:px-5 sm:py-4 [&::-webkit-scrollbar]:hidden"
                style={{
                  maskImage: `linear-gradient(to bottom, ${isScrolledFromTop ? "transparent 0%, black 5rem" : "black 0%"}, ${showScrollToBottom ? "black calc(100% - 5rem), transparent 100%" : "black 100%"})`,
                }}
                onScroll={onMessagesScroll}
                onClickCapture={onMessagesClickCapture}
                onWheel={onMessagesWheel}
                onPointerDown={onMessagesPointerDown}
                onPointerUp={onMessagesPointerUp}
                onPointerCancel={onMessagesPointerCancel}
                onTouchStart={onMessagesTouchStart}
                onTouchMove={onMessagesTouchMove}
                onTouchEnd={onMessagesTouchEnd}
                onTouchCancel={onMessagesTouchEnd}
              >
                <MessagesTimeline
                  key={messagesTimelineRenderKey}
                  hasMessages={timelineEntries.length > 0}
                  isWorking={isWorking}
                  showWorkingIndicator={isWorking && !isAwaitingSendAck}
                  activeTurnInProgress={isWorking || !latestTurnSettled}
                  activeTurnStartedAt={activeWorkStartedAt}
                  activeTurnId={activeTurnId}
                  scrollContainer={messagesScrollElement}
                  timelineEntries={timelineEntries}
                  completionDividerBeforeEntryId={completionDividerBeforeEntryId}
                  completionSummary={completionSummary}
                  turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                  showTurnDiffActions={isProjectThread}
                  expandedWorkGroups={expandedWorkGroups}
                  onToggleWorkGroup={onToggleWorkGroup}
                  onOpenTurnDiff={onOpenTurnDiff}
                  revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                  onRevertUserMessage={onRevertUserMessage}
                  onRetryAssistantMessage={onRetryAssistantMessage}
                  isRevertingCheckpoint={isRevertingCheckpoint}
                  onImageExpand={onExpandTimelineImage}
                  markdownCwd={gitCwd ?? undefined}
                  resolvedTheme={resolvedTheme}
                  timestampFormat={timestampFormat}
                  workspaceRoot={activeProject?.cwd ?? undefined}
                />
              </div>

              {/* scroll to bottom pill — shown when user has scrolled away from the bottom */}
              {showScrollToBottom && (
                <div className="pointer-events-none absolute bottom-1 left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5">
                  <button
                    type="button"
                    onClick={() => scrollMessagesToBottom("smooth")}
                    className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1 text-muted-foreground text-xs shadow-sm transition-colors hover:border-border hover:text-foreground hover:cursor-pointer"
                  >
                    <ChevronDownIcon className="size-3.5" />
                    Scroll to bottom
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Input bar */}
          <div
            className={cn(
              "relative w-full min-w-0",
              isEmptyThread
                ? "flex flex-1 flex-col items-center justify-center px-3 sm:px-5"
                : cn("shrink-0 px-3 sm:px-5", isGitRepo ? "pb-1" : "pb-3 sm:pb-4"),
            )}
          >
            {isEmptyThread && <EmptyThreadAmbient promptLength={prompt.trim().length} />}
            {isEmptyThread && (
              <div className="relative z-10 mx-auto mb-8 w-full min-w-0 max-w-[52rem]">
                <EmptyThreadHeading projectName={activeProject?.name} />
              </div>
            )}
            <form
              ref={composerFormRef}
              onSubmit={onSend}
              className="relative z-10 mx-auto w-full min-w-0 max-w-[52rem]"
              data-chat-composer-form="true"
            >
              {showPlanSuggestion && (
                <ComposerPlanModeSuggestion
                  onActivate={toggleInteractionMode}
                  onDismiss={() => setPlanSuggestionDismissed(true)}
                />
              )}
              <BackgroundSubagentsPanel
                provider={activeThread.session?.provider ?? activeThread.modelSelection.provider}
                activities={activeThread.activities}
                open={isBackgroundSubagentsPanelOpen}
                onOpenChange={setIsBackgroundSubagentsPanelOpen}
              />
              <div className="relative">
                {composerMenuOpen && !isComposerApprovalState && (
                  <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-4">
                    <ComposerCommandMenu
                      items={composerMenuItems}
                      resolvedTheme={resolvedTheme}
                      isLoading={isComposerMenuLoading}
                      triggerKind={composerTriggerKind}
                      activeItemId={activeComposerMenuItem?.id ?? null}
                      onHighlightedItemChange={onComposerMenuItemHighlighted}
                      onSelect={onSelectComposerItem}
                    />
                  </div>
                )}
                <div
                  data-chat-composer-frame="true"
                  className={cn(
                    "group relative z-10 min-w-0 overflow-hidden transition-[margin-top,color,box-shadow,border-color,background-color] duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                    backgroundSubagentRows.length > 0 &&
                      isBackgroundSubagentsPanelOpen &&
                      "-mt-6 sm:-mt-8",
                    hasDecoratedComposerFrame
                      ? ["rounded-[22px] p-px", composerProviderState.composerFrameClassName]
                      : [
                          "rounded-[20px] border bg-card shadow-sm has-focus-visible:border-ring/45",
                          isDragOverComposer ? "border-primary/70 bg-accent/30" : "border-border",
                        ],
                  )}
                  onDragEnter={onComposerDragEnter}
                  onDragOver={onComposerDragOver}
                  onDragLeave={onComposerDragLeave}
                  onDrop={onComposerDrop}
                >
                  <div
                    data-chat-composer-surface="true"
                    className={cn(
                      "min-w-0",
                      hasDecoratedComposerFrame && [
                        "rounded-[20px] border bg-card shadow-sm transition-colors duration-200 has-focus-visible:border-ring/45",
                        isDragOverComposer ? "border-primary/70 bg-accent/30" : "border-border",
                        composerProviderState.composerSurfaceClassName,
                      ],
                    )}
                  >
                    {activePendingApproval ? (
                      <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                        <ComposerPendingApprovalPanel
                          approval={activePendingApproval}
                          pendingCount={pendingApprovals.length}
                        />
                      </div>
                    ) : pendingUserInputs.length > 0 ? (
                      <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                        <ComposerPendingUserInputPanel
                          pendingUserInputs={pendingUserInputs}
                          respondingRequestIds={respondingRequestIds}
                          answers={activePendingDraftAnswers}
                          questionIndex={activePendingQuestionIndex}
                          onSelectOption={onSelectActivePendingUserInputOption}
                          onAdvance={onAdvanceActivePendingUserInput}
                        />
                      </div>
                    ) : showPlanFollowUpPrompt && activeProposedPlan ? (
                      <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                        <ComposerPlanFollowUpBanner
                          key={activeProposedPlan.id}
                          planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                        />
                      </div>
                    ) : null}
                    {!isComposerApprovalState && pendingUserInputs.length === 0 ? (
                      <QueuedMessagesPanel
                        queuedTurns={queuedTurns}
                        onDeleteQueuedTurn={onDeleteQueuedTurn}
                        onEditQueuedTurn={(queuedTurnId) => void onEditQueuedTurn(queuedTurnId)}
                      />
                    ) : null}
                    <div
                      className={cn(
                        "relative px-3 pb-2 sm:px-4",
                        hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4",
                      )}
                    >
                      {!isComposerApprovalState &&
                        pendingUserInputs.length === 0 &&
                        composerImages.length > 0 && (
                          <div className="mb-3 flex flex-wrap gap-2">
                            {composerImages.map((image) => (
                              <div
                                key={image.id}
                                className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                              >
                                {image.previewUrl ? (
                                  <button
                                    type="button"
                                    className="h-full w-full cursor-zoom-in"
                                    aria-label={`Preview ${image.name}`}
                                    onClick={() => {
                                      const preview = buildExpandedImagePreview(
                                        composerImages,
                                        image.id,
                                      );
                                      if (!preview) return;
                                      setExpandedImage(preview);
                                    }}
                                  >
                                    <img
                                      src={image.previewUrl}
                                      alt={image.name}
                                      className="h-full w-full object-cover"
                                    />
                                  </button>
                                ) : (
                                  <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
                                    {image.name}
                                  </div>
                                )}
                                {nonPersistedComposerImageIdSet.has(image.id) && (
                                  <Tooltip>
                                    <TooltipTrigger
                                      render={
                                        <span
                                          role="img"
                                          aria-label="Draft attachment may not persist"
                                          className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                                        >
                                          <CircleAlertIcon className="size-3" />
                                        </span>
                                      }
                                    />
                                    <TooltipPopup
                                      side="top"
                                      className="max-w-64 whitespace-normal leading-tight"
                                    >
                                      Draft attachment could not be saved locally and may be lost on
                                      navigation.
                                    </TooltipPopup>
                                  </Tooltip>
                                )}
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                                  onClick={() => removeComposerImage(image.id)}
                                  aria-label={`Remove ${image.name}`}
                                >
                                  <XIcon />
                                </Button>
                              </div>
                            ))}
                          </div>
                        )}
                      <ComposerPromptEditor
                        ref={composerEditorRef}
                        value={
                          isComposerApprovalState
                            ? ""
                            : activePendingProgress
                              ? activePendingProgress.customAnswer
                              : prompt
                        }
                        cursor={composerCursor}
                        terminalContexts={
                          !isComposerApprovalState && pendingUserInputs.length === 0
                            ? composerTerminalContexts
                            : []
                        }
                        onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                        onChange={onPromptChange}
                        onCommandKeyDown={onComposerCommandKey}
                        onPaste={onComposerPaste}
                        placeholder={
                          isComposerApprovalState
                            ? (activePendingApproval?.detail ??
                              "Resolve this approval request to continue")
                            : activePendingProgress
                              ? "Type your own answer, or leave this blank to use the selected option"
                              : showPlanFollowUpPrompt && activeProposedPlan
                                ? "Add feedback to refine the plan, or leave this blank to implement it"
                                : phase === "disconnected"
                                  ? "Ask for follow-up changes or attach images"
                                  : "Ask anything, @tag files/folders, or use / to show available commands"
                        }
                        disabled={isConnecting || isComposerApprovalState}
                      />
                    </div>

                    {/* Bottom toolbar */}
                    {activePendingApproval ? (
                      <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
                        <ComposerPendingApprovalActions
                          requestId={activePendingApproval.requestId}
                          isResponding={respondingRequestIds.includes(
                            activePendingApproval.requestId,
                          )}
                          respondingDecision={respondingApprovalDecision}
                          onRespondToApproval={onRespondToApproval}
                        />
                      </div>
                    ) : (
                      <div
                        ref={composerFooterRef}
                        data-chat-composer-footer="true"
                        data-chat-composer-footer-compact={
                          isComposerFooterCompact ? "true" : "false"
                        }
                        className={cn(
                          "flex min-w-0 flex-nowrap items-center gap-2 overflow-hidden px-2.5 pb-2.5 sm:px-3 sm:pb-3",
                          "justify-between",
                          isComposerFooterCompact ? "gap-1.5" : "gap-2 sm:gap-0",
                        )}
                      >
                        <div
                          ref={composerFooterLeadingRef}
                          className={cn(
                            "flex min-w-0 flex-1 items-center",
                            isComposerFooterCompact
                              ? "gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                              : "gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                          )}
                        >
                          {/* Plus menu */}
                          <ComposerPlusMenu
                            threadId={threadId}
                            provider={selectedProvider}
                            models={selectedProviderModels}
                            model={selectedModel}
                            modelOptions={composerModelOptions?.[selectedProvider]}
                            planModeActive={interactionMode === "plan"}
                            onTogglePlanMode={toggleInteractionMode}
                            onAddFiles={addComposerImages}
                          />

                          {/* Provider/model picker */}
                          <ProviderModelPicker
                            compact={isComposerFooterCompact}
                            provider={selectedProvider}
                            model={selectedModelForPickerWithCustomFallback}
                            lockedProvider={lockedProvider}
                            providers={providerStatuses}
                            modelOptionsByProvider={modelOptionsByProvider}
                            modelOptions={composerModelOptions?.[selectedProvider]}
                            {...(composerProviderState.modelPickerIconClassName
                              ? {
                                  activeProviderIconClassName:
                                    composerProviderState.modelPickerIconClassName,
                                }
                              : {})}
                            onProviderModelChange={onProviderModelSelect}
                          />

                          {providerEffortPicker}

                          {isComposerFooterCompact ? (
                            <>
                              {compactControlsMenuNeeded ? (
                                <CompactComposerControlsMenu
                                  activePlan={Boolean(
                                    activePlan || sidebarProposedPlan || planSidebarOpen,
                                  )}
                                  planSidebarOpen={planSidebarOpen}
                                  runtimeMode={runtimeMode}
                                  traitsMenuContent={providerTraitsMenuContent}
                                  onTogglePlanSidebar={togglePlanSidebar}
                                  onRuntimeModeChange={handleRuntimeModeChange}
                                />
                              ) : (
                                <ComposerRuntimeModeButton
                                  compact
                                  runtimeMode={runtimeMode}
                                  onToggle={toggleRuntimeMode}
                                />
                              )}
                              {interactionMode === "plan" && (
                                <>
                                  <Separator orientation="vertical" className="mx-0.5 h-4" />
                                  <PlanModeIndicator onDisable={toggleInteractionMode} />
                                </>
                              )}
                            </>
                          ) : (
                            <>
                              {providerTraitsPicker ? (
                                <>
                                  <Separator
                                    orientation="vertical"
                                    className="mx-0.5 hidden h-4 sm:block"
                                  />
                                  {providerTraitsPicker}
                                </>
                              ) : null}

                              {interactionMode === "plan" ? (
                                <>
                                  <Separator
                                    orientation="vertical"
                                    className="mx-0.5 hidden h-4 sm:block"
                                  />
                                  <PlanModeIndicator onDisable={toggleInteractionMode} />
                                </>
                              ) : null}

                              <Separator
                                orientation="vertical"
                                className="mx-0.5 hidden h-4 sm:block"
                              />

                              <ComposerRuntimeModeButton
                                compact={false}
                                runtimeMode={runtimeMode}
                                onToggle={toggleRuntimeMode}
                              />

                              {activePlan || sidebarProposedPlan || planSidebarOpen ? (
                                <>
                                  <Separator
                                    orientation="vertical"
                                    className="mx-0.5 hidden h-4 sm:block"
                                  />
                                  <Button
                                    variant="ghost"
                                    className={cn(
                                      "shrink-0 whitespace-nowrap px-2 sm:px-3",
                                      planSidebarOpen
                                        ? "text-blue-400 hover:text-blue-300"
                                        : "text-muted-foreground/70 hover:text-foreground/80",
                                    )}
                                    size="sm"
                                    type="button"
                                    onClick={togglePlanSidebar}
                                    title={
                                      planSidebarOpen ? "Hide plan sidebar" : "Show plan sidebar"
                                    }
                                  >
                                    <ListTodoIcon />
                                    <span className="sr-only sm:not-sr-only">Plan</span>
                                  </Button>
                                </>
                              ) : null}
                            </>
                          )}
                        </div>

                        {/* Right side: send / stop button */}
                        <div
                          ref={composerFooterActionsRef}
                          data-chat-composer-actions="right"
                          data-chat-composer-primary-actions-compact={
                            isComposerPrimaryActionsCompact ? "true" : "false"
                          }
                          className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
                        >
                          {activeContextWindow ? (
                            <ContextWindowMeter usage={activeContextWindow} />
                          ) : null}
                          {isPreparingWorktree ? (
                            <span className="text-muted-foreground/70 text-xs">
                              Preparing worktree...
                            </span>
                          ) : null}
                          <ComposerPrimaryActions
                            compact={isComposerPrimaryActionsCompact}
                            pendingAction={
                              activePendingProgress
                                ? {
                                    questionIndex: activePendingProgress.questionIndex,
                                    isLastQuestion: activePendingProgress.isLastQuestion,
                                    canAdvance: activePendingProgress.canAdvance,
                                    isResponding: activePendingIsResponding,
                                    isComplete: Boolean(activePendingResolvedAnswers),
                                  }
                                : null
                            }
                            isRunning={isTurnRunning}
                            awaitingSendAck={isAwaitingSendAck}
                            queuedTurnCount={queuedTurns.length}
                            showPlanFollowUpPrompt={
                              pendingUserInputs.length === 0 && showPlanFollowUpPrompt
                            }
                            promptHasText={prompt.trim().length > 0}
                            isSendBusy={isSendBusy}
                            isConnecting={isConnecting}
                            isPreparingWorktree={isPreparingWorktree}
                            hasSendableContent={composerSendState.hasSendableContent}
                            onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                            onInterrupt={() => void onInterrupt()}
                            onImplementPlanInNewThread={() => void onImplementPlanInNewThread()}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </form>
            {isEmptyThread && (
              <div className="relative z-10 mx-auto mt-2 flex w-full min-w-0 max-w-[52rem] flex-wrap items-center justify-start gap-x-0.5 gap-y-1">
                <BranchToolbar
                  inline
                  threadId={activeThread.id}
                  onEnvModeChange={onEnvModeChange}
                  envLocked={envLocked}
                  isGitRepo={isGitRepo}
                  onComposerFocusRequest={scheduleComposerFocus}
                  {...(canCheckoutPullRequestIntoThread
                    ? { onCheckoutPullRequestRequest: openPullRequestDialog }
                    : {})}
                />
              </div>
            )}
          </div>

          {!isEmptyThread && (
            <BranchToolbar
              threadId={activeThread.id}
              onEnvModeChange={onEnvModeChange}
              envLocked={envLocked}
              isGitRepo={isGitRepo}
              onComposerFocusRequest={scheduleComposerFocus}
              {...(canCheckoutPullRequestIntoThread
                ? { onCheckoutPullRequestRequest: openPullRequestDialog }
                : {})}
            />
          )}

          {pullRequestDialogState ? (
            <PullRequestThreadDialog
              key={pullRequestDialogState.key}
              open
              cwd={activeProject?.cwd ?? null}
              initialReference={pullRequestDialogState.initialReference}
              onOpenChange={(open) => {
                if (!open) {
                  closePullRequestDialog();
                }
              }}
              onPrepared={handlePreparedPullRequestThread}
            />
          ) : null}
        </div>
        {/* end chat column */}

        {!shouldUseBrowserSheet && browserOpen ? (
          <div
            className={cn(
              "hidden min-h-0 shrink-0 border-l border-border bg-card text-foreground md:flex",
              "w-[min(42vw,36rem)] min-w-[24rem] max-w-[44rem]",
              "shadow-[-20px_0_40px_-36px_rgba(15,23,42,0.55)]",
            )}
          >
            <BrowserPanel
              threadId={activeThread.id}
              active
              cwd={gitCwd ?? activeProject?.cwd ?? null}
              isAgentWorking={isWorking}
              onClose={onToggleBrowser}
              onStopAgent={() => void onInterrupt()}
            />
          </div>
        ) : null}

        {/* Plan sidebar */}
        {planSidebarOpen ? (
          <PlanSidebar
            activePlan={activePlan}
            activeProposedPlan={sidebarProposedPlan}
            markdownCwd={gitCwd ?? undefined}
            workspaceRoot={activeProject?.cwd ?? undefined}
            timestampFormat={timestampFormat}
            onClose={() => {
              setPlanSidebarOpen(false);
              // Track that the user explicitly dismissed for this turn so auto-open won't fight them.
              const turnKey = activePlan?.turnId ?? sidebarProposedPlan?.turnId ?? null;
              if (turnKey) {
                planSidebarDismissedForTurnRef.current = turnKey;
              }
            }}
          />
        ) : null}
      </div>
      {/* end horizontal flex container */}

      {mountedTerminalThreadIds.map((mountedThreadId) => (
        <PersistentThreadTerminalDrawer
          key={mountedThreadId}
          threadId={mountedThreadId}
          visible={mountedThreadId === activeThreadId && terminalState.terminalOpen}
          focusRequestId={mountedThreadId === activeThreadId ? terminalFocusRequestId : 0}
          splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
          newShortcutLabel={newTerminalShortcutLabel ?? undefined}
          closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
          onAddTerminalContext={addTerminalContextToDraft}
        />
      ))}

      {shouldUseBrowserSheet ? (
        <Sheet
          open={browserOpen}
          onOpenChange={(open) => {
            if (!open && browserOpen) {
              onToggleBrowser();
            }
          }}
        >
          <SheetPopup
            side="right"
            showCloseButton={false}
            keepMounted
            className="w-[min(92vw,920px)] max-w-[920px] p-0"
          >
            {browserOpen ? (
              <BrowserPanel
                threadId={activeThread.id}
                active
                cwd={gitCwd ?? activeProject?.cwd ?? null}
                isAgentWorking={isWorking}
                onClose={onToggleBrowser}
                onStopAgent={() => void onInterrupt()}
              />
            ) : null}
          </SheetPopup>
        </Sheet>
      ) : null}

      {expandedImage && expandedImageItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
          role="dialog"
          aria-modal="true"
          aria-label="Expanded image preview"
        >
          <button
            type="button"
            className="absolute inset-0 z-0 cursor-zoom-out"
            aria-label="Close image preview"
            onClick={closeExpandedImage}
          />
          {expandedImage.images.length > 1 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
              aria-label="Previous image"
              onClick={() => {
                navigateExpandedImage(-1);
              }}
            >
              <ChevronLeftIcon className="size-5" />
            </Button>
          )}
          <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="absolute right-2 top-2"
              onClick={closeExpandedImage}
              aria-label="Close image preview"
            >
              <XIcon />
            </Button>
            <img
              src={expandedImageItem.src}
              alt={expandedImageItem.name}
              className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl"
              draggable={false}
            />
            <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
              {expandedImageItem.name}
              {expandedImage.images.length > 1
                ? ` (${expandedImage.index + 1}/${expandedImage.images.length})`
                : ""}
            </p>
          </div>
          {expandedImage.images.length > 1 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
              aria-label="Next image"
              onClick={() => {
                navigateExpandedImage(1);
              }}
            >
              <ChevronRightIcon className="size-5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
