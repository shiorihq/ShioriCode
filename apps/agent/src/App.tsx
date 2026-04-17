import { Box, Text, useApp, useInput, useStdin } from "ink";
import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ProviderInteractionMode, ProviderKind } from "contracts";
import {
  deriveActivePlanState,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveReasoningEntries,
  deriveTimelineEntries,
  deriveVisibleTimelineMessages,
  deriveWorkLogEntries,
  findLatestProposedPlan,
  isSessionActivelyRunningTurn,
} from "shared/orchestrationSession";
import { listActiveThreadsByUpdatedAt } from "shared/orchestrationClientProjection";
import type { Thread } from "shared/orchestrationClientTypes";

import { Composer } from "./components/Composer";
import {
  ApprovalBanner,
  Panel,
  PromptOverlay,
  SettingsOverlay,
  ThreadPicker,
  UserInputBanner,
} from "./components/Overlays";
import { matchCommands, SLASH_COMMANDS, SlashMenu } from "./components/SlashMenu";
import { StatusLine } from "./components/StatusLine";
import { estimateEntryRows, isExpandableEntry, Timeline } from "./components/Timeline";
import { Welcome } from "./components/Welcome";
import { useTerminalDimensions } from "./hooks/useTerminalDimensions";
import { palette } from "./theme";
import {
  createAgentController,
  cycleModel,
  cycleProvider,
  getThreadProviderSelection,
  withProvider,
  type AgentController,
} from "./controller";

interface AppProps {
  readonly controller: AgentController;
  readonly dimensions?: {
    readonly columns: number;
    readonly rows: number;
  };
}

interface PromptState {
  readonly title: string;
  readonly placeholder?: string;
  readonly initialValue?: string;
  readonly secret?: boolean;
  readonly onSubmit: (value: string) => Promise<void> | void;
}

type OverlayKind = "none" | "switcher" | "settings" | "help";
type ScreenMode = "prompt" | "transcript";

function useControllerState(controller: AgentController) {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}

/** Rows reserved for chrome: welcome (3) + overlays (variable, 0 when none) + composer (3) + status (2). */
const WELCOME_ROWS = 4;
const STATUS_ROWS = 2;
const COMPOSER_ROWS = 3;
const TIMELINE_STATUS_ROWS = 1;
const TRANSCRIPT_FOOTER_ROWS = 1;

export function App({ controller, dimensions: dimensionsOverride }: AppProps) {
  const state = useControllerState(controller);
  const { setRawMode } = useStdin();
  const { exit } = useApp();
  const dimensions = useTerminalDimensions(dimensionsOverride);

  const [composerValue, setComposerValue] = useState("");
  const [overlay, setOverlay] = useState<OverlayKind>("none");
  const [screenMode, setScreenMode] = useState<ScreenMode>("prompt");
  const [switcherIndex, setSwitcherIndex] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [, setHistoryCursor] = useState<number | null>(null);
  const [pendingUserAnswers, setPendingUserAnswers] = useState<Record<string, unknown>>({});

  // Timeline scroll + expansion state.
  const [scrollOffset, setScrollOffset] = useState(0); // 0 = tail-follow
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const transcriptMode = screenMode === "transcript";

  useEffect(() => {
    void controller.initialize();
    return () => {
      void controller.dispose();
    };
  }, [controller]);

  const recentThreads = useMemo(
    () => listActiveThreadsByUpdatedAt(state.projection.threads),
    [state.projection.threads],
  );

  const selectedThread = useMemo(() => {
    if (!state.selectedThreadId) {
      return null;
    }
    const index = state.projection.threadIndexById[state.selectedThreadId];
    return index === undefined ? null : (state.projection.threads[index] ?? null);
  }, [state.projection.threadIndexById, state.projection.threads, state.selectedThreadId]);

  useEffect(() => {
    if (!selectedThread) return;
    const currentIndex = recentThreads.findIndex((thread) => thread.id === selectedThread.id);
    if (currentIndex >= 0) setSwitcherIndex(currentIndex);
  }, [recentThreads, selectedThread]);

  const providerSelection = getThreadProviderSelection(state);
  const pendingApprovals = selectedThread ? derivePendingApprovals(selectedThread.activities) : [];
  const pendingUserInputs = selectedThread
    ? derivePendingUserInputs(selectedThread.activities)
    : [];
  const activePlan = selectedThread
    ? deriveActivePlanState(selectedThread.activities, selectedThread.latestTurn?.turnId)
    : null;
  const proposedPlan = selectedThread
    ? findLatestProposedPlan(
        selectedThread.proposedPlans,
        selectedThread.latestTurn?.turnId ?? null,
      )
    : null;

  const reasoningEntries = useMemo(
    () => (selectedThread ? deriveReasoningEntries(selectedThread.activities) : []),
    [selectedThread],
  );
  const workEntries = useMemo(
    () =>
      selectedThread
        ? deriveWorkLogEntries(
            selectedThread.activities,
            selectedThread.latestTurn?.turnId ?? undefined,
          )
        : [],
    [selectedThread],
  );
  const timelineEntries = useMemo(
    () =>
      selectedThread
        ? deriveTimelineEntries(
            deriveVisibleTimelineMessages(selectedThread.messages, selectedThread.session),
            reasoningEntries,
            selectedThread.proposedPlans,
            workEntries,
          )
        : [],
    [reasoningEntries, selectedThread, workEntries],
  );

  const currentPendingUserInput = pendingUserInputs[0] ?? null;
  useEffect(() => {
    if (!currentPendingUserInput) {
      setPendingUserAnswers({});
      return;
    }
    setPendingUserAnswers((current) => (Object.keys(current).length === 0 ? current : {}));
  }, [currentPendingUserInput]);

  const currentPendingQuestion = useMemo(() => {
    if (!currentPendingUserInput) return null;
    return (
      currentPendingUserInput.questions.find(
        (question) => pendingUserAnswers[question.id] === undefined,
      ) ?? null
    );
  }, [currentPendingUserInput, pendingUserAnswers]);

  const showingSlashMenu = !transcriptMode && composerValue.startsWith("/");
  const slashMatches = showingSlashMenu ? matchCommands(composerValue) : [];
  useEffect(() => {
    setSlashIndex((current) => {
      if (slashMatches.length === 0) return 0;
      return Math.min(current, slashMatches.length - 1);
    });
  }, [slashMatches.length]);

  const composerDisabled = transcriptMode || prompt !== null || overlay !== "none";
  const footerRows = transcriptMode ? TRANSCRIPT_FOOTER_ROWS : COMPOSER_ROWS;

  // Compute timeline viewport geometry.
  const overlayRows = computeOverlayRows({
    pendingApproval: Boolean(pendingApprovals[0]),
    pendingUserInput: Boolean(currentPendingUserInput && currentPendingQuestion),
    switcherOpen: overlay === "switcher",
    settingsOpen: overlay === "settings",
    helpOpen: overlay === "help",
    promptOpen: prompt !== null,
    slashMenuOpen: showingSlashMenu,
    activePlanRows: activePlan ? Math.min(6, activePlan.steps.length + 1) : 0,
    proposedPlanRow: proposedPlan ? 1 : 0,
    recentThreadCount: recentThreads.length,
    slashMatchCount: slashMatches.length,
  });

  const timelineHeight = Math.max(
    4,
    dimensions.rows - WELCOME_ROWS - TIMELINE_STATUS_ROWS - STATUS_ROWS - footerRows - overlayRows,
  );

  const measuredTimelineEntries = useMemo(
    () =>
      timelineEntries.map((entry) => ({
        entry,
        rows: estimateEntryRows(
          entry,
          transcriptMode || expandedIds.has(entry.id),
          dimensions.columns,
          transcriptMode,
        ),
      })),
    [timelineEntries, transcriptMode, expandedIds, dimensions.columns],
  );

  const totalTimelineRows = useMemo(
    () => measuredTimelineEntries.reduce((total, entry) => total + entry.rows, 0),
    [measuredTimelineEntries],
  );

  const maxScrollOffset = Math.max(0, totalTimelineRows - timelineHeight);

  // Slice entries to fit viewport, honoring scrollOffset. scrollOffset counts from
  // the newest entry backwards: 0 = show latest, higher = show older.
  const visibleTimelineEntries = useMemo(() => {
    if (measuredTimelineEntries.length === 0) return [];
    // Working from the bottom. scrollOffset = how many rows we've scrolled past the bottom.
    let bottomIndex = measuredTimelineEntries.length - 1;
    let skippedRows = 0;
    while (bottomIndex >= 0 && skippedRows < scrollOffset) {
      const row = measuredTimelineEntries[bottomIndex];
      if (!row) break;
      skippedRows += row.rows;
      bottomIndex -= 1;
    }
    if (bottomIndex < 0) bottomIndex = 0;
    // Now take entries upward from bottomIndex until we fill timelineHeight.
    let used = 0;
    let topIndex = bottomIndex;
    while (topIndex >= 0) {
      const row = measuredTimelineEntries[topIndex];
      if (!row) break;
      if (used + row.rows > timelineHeight && topIndex !== bottomIndex) break;
      used += row.rows;
      topIndex -= 1;
    }
    return measuredTimelineEntries
      .slice(Math.max(0, topIndex + 1), bottomIndex + 1)
      .map((item) => item.entry);
  }, [measuredTimelineEntries, scrollOffset, timelineHeight]);

  const hiddenBelow = useMemo(() => {
    if (visibleTimelineEntries.length === 0) return 0;
    const lastVisible = visibleTimelineEntries[visibleTimelineEntries.length - 1];
    const lastIndex = timelineEntries.findIndex((entry) => entry.id === lastVisible?.id);
    return Math.max(0, timelineEntries.length - 1 - lastIndex);
  }, [timelineEntries, visibleTimelineEntries]);

  const hiddenAbove = useMemo(() => {
    if (visibleTimelineEntries.length === 0) return 0;
    const firstVisible = visibleTimelineEntries[0];
    const firstIndex = timelineEntries.findIndex((entry) => entry.id === firstVisible?.id);
    return Math.max(0, firstIndex);
  }, [timelineEntries, visibleTimelineEntries]);

  useEffect(() => {
    if (scrollOffset > maxScrollOffset) {
      setScrollOffset(maxScrollOffset);
    }
  }, [maxScrollOffset, scrollOffset]);

  const runAction = useCallback(
    async (action: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      try {
        await action();
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const executeSlashCommand = useCallback(
    (name: string) => {
      switch (name) {
        case "/help":
          setOverlay("help");
          return;
        case "/new":
          void runAction(() => controller.createThread());
          return;
        case "/threads":
          setOverlay("switcher");
          return;
        case "/model":
          setOverlay("settings");
          return;
        case "/interrupt":
          void runAction(() => controller.interruptSelectedThread());
          return;
        case "/archive":
          void runAction(() => controller.archiveSelectedThread());
          return;
        case "/clear":
          setComposerValue("");
          return;
        case "/exit":
        case "/quit":
          void controller.dispose().finally(() => exit());
          return;
        default:
          return;
      }
    },
    [controller, exit, runAction],
  );

  const submitComposer = useCallback(
    (value: string) => {
      if (value.startsWith("/")) {
        const matches = matchCommands(value);
        const command = matches[slashIndex] ?? matches[0] ?? null;
        if (command) {
          setComposerValue("");
          executeSlashCommand(command.name);
          return;
        }
      }
      setHistory((current) => [...current, value].slice(-50));
      setHistoryCursor(null);
      setComposerValue("");
      setScrollOffset(0);
      void runAction(() => controller.sendMessage(value));
    },
    [controller, executeSlashCommand, runAction, slashIndex],
  );

  const openPrompt = useCallback((nextPrompt: PromptState) => {
    setPrompt(nextPrompt);
    setPromptValue(nextPrompt.initialValue ?? "");
  }, []);

  const enterTranscriptMode = useCallback(() => {
    setScreenMode("transcript");
    setOverlay("none");
    setFocusedId(null);
    setScrollOffset(0);
  }, []);

  const exitTranscriptMode = useCallback(() => {
    setScreenMode("prompt");
  }, []);

  const toggleTranscriptMode = useCallback(() => {
    if (transcriptMode) {
      exitTranscriptMode();
      return;
    }
    enterTranscriptMode();
  }, [enterTranscriptMode, exitTranscriptMode, transcriptMode]);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const moveFocus = useCallback(
    (delta: number) => {
      const expandable = timelineEntries.filter(isExpandableEntry);
      if (expandable.length === 0) return;
      const currentIndex = focusedId ? expandable.findIndex((entry) => entry.id === focusedId) : -1;
      const nextIndex =
        currentIndex === -1
          ? delta > 0
            ? 0
            : expandable.length - 1
          : Math.max(0, Math.min(expandable.length - 1, currentIndex + delta));
      const target = expandable[nextIndex];
      if (target) setFocusedId(target.id);
    },
    [focusedId, timelineEntries],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      void controller.dispose().finally(() => exit());
      return;
    }

    if (key.ctrl && input === "o" && prompt === null) {
      toggleTranscriptMode();
      return;
    }

    if (key.escape) {
      if (prompt) {
        setPrompt(null);
        setPromptValue("");
        return;
      }
      if (transcriptMode) {
        exitTranscriptMode();
        return;
      }
      if (overlay !== "none") {
        setOverlay("none");
        return;
      }
      if (focusedId !== null) {
        setFocusedId(null);
        setScrollOffset(0);
        return;
      }
    }

    if (prompt) {
      if (key.return) {
        const currentPrompt = prompt;
        const value = promptValue;
        void runAction(async () => {
          await currentPrompt.onSubmit(value);
          setPrompt(null);
          setPromptValue("");
        });
        return;
      }
      if (key.backspace || key.delete) {
        setPromptValue((current) => current.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input.length > 0) {
        setPromptValue((current) => current + input);
      }
      return;
    }

    if (transcriptMode) {
      if (!key.ctrl && !key.meta && input === "q") {
        exitTranscriptMode();
        return;
      }
      if (key.home) {
        setScrollOffset(maxScrollOffset);
        return;
      }
      if (key.end) {
        setScrollOffset(0);
        return;
      }
      if (key.pageUp) {
        setScrollOffset((current) =>
          Math.min(maxScrollOffset, current + Math.max(1, Math.floor(timelineHeight / 2))),
        );
        return;
      }
      if (key.pageDown) {
        setScrollOffset((current) =>
          Math.max(0, current - Math.max(1, Math.floor(timelineHeight / 2))),
        );
        return;
      }
      if (key.upArrow) {
        setScrollOffset((current) => Math.min(maxScrollOffset, current + 1));
        return;
      }
      if (key.downArrow) {
        setScrollOffset((current) => Math.max(0, current - 1));
        return;
      }
      return;
    }

    if (key.ctrl && input === "p") {
      setOverlay(overlay === "switcher" ? "none" : "switcher");
      return;
    }
    if (key.ctrl && input === "n") {
      void runAction(() => controller.createThread());
      return;
    }
    if ((key.ctrl && input === ",") || (key.ctrl && input === "s")) {
      setOverlay(overlay === "settings" ? "none" : "settings");
      return;
    }
    if (key.ctrl && input === "r") {
      void runAction(() => controller.interruptSelectedThread());
      return;
    }
    if (key.ctrl && input === "a") {
      void runAction(() => controller.archiveSelectedThread());
      return;
    }

    // Timeline scrolling & entry navigation.
    if (key.pageUp) {
      setScrollOffset((current) =>
        Math.min(maxScrollOffset, current + Math.max(1, Math.floor(timelineHeight / 2))),
      );
      return;
    }
    if (key.pageDown) {
      setScrollOffset((current) =>
        Math.max(0, current - Math.max(1, Math.floor(timelineHeight / 2))),
      );
      return;
    }
    if (key.ctrl && key.upArrow) {
      moveFocus(-1);
      return;
    }
    if (key.ctrl && key.downArrow) {
      moveFocus(1);
      return;
    }
    if (key.ctrl && input === " ") {
      if (focusedId) toggleExpanded(focusedId);
      return;
    }

    if (overlay === "switcher") {
      if (key.upArrow) {
        setSwitcherIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (key.downArrow) {
        setSwitcherIndex((current) => Math.min(recentThreads.length - 1, current + 1));
        return;
      }
      if (key.return) {
        const nextThread = recentThreads[switcherIndex];
        if (nextThread) {
          controller.selectThread(nextThread.id);
          setOverlay("none");
        }
      }
      return;
    }

    if (overlay === "settings" && selectedThread && providerSelection) {
      if (input === "[") {
        void runAction(async () => {
          const nextProvider = cycleProvider(providerSelection.provider, state.serverConfig, -1);
          await controller.updateThreadModelSelection(
            withProvider(providerSelection, nextProvider, state.serverConfig),
          );
        });
        return;
      }
      if (input === "]") {
        void runAction(async () => {
          const nextProvider = cycleProvider(providerSelection.provider, state.serverConfig, 1);
          await controller.updateThreadModelSelection(
            withProvider(providerSelection, nextProvider, state.serverConfig),
          );
        });
        return;
      }
      if (key.leftArrow) {
        void runAction(() =>
          controller.updateThreadModelSelection(
            cycleModel(providerSelection, state.serverConfig, -1),
          ),
        );
        return;
      }
      if (key.rightArrow) {
        void runAction(() =>
          controller.updateThreadModelSelection(
            cycleModel(providerSelection, state.serverConfig, 1),
          ),
        );
        return;
      }
      if (input === "r") {
        void runAction(() =>
          controller.setThreadRuntimeMode(
            selectedThread.runtimeMode === "full-access" ? "approval-required" : "full-access",
          ),
        );
        return;
      }
      if (input === "i") {
        void runAction(() =>
          controller.setThreadInteractionMode(
            selectedThread.interactionMode === "default" ? "plan" : "default",
          ),
        );
        return;
      }
      if (input === "f") {
        void runAction(() => controller.refreshProviders());
        return;
      }
      if (
        input === "l" &&
        (providerSelection.provider === "codex" || providerSelection.provider === "claudeAgent")
      ) {
        const providerKind = providerSelection.provider;
        void runAction(async () => {
          setRawMode?.(false);
          try {
            await controller.runProviderLogin(providerKind);
          } finally {
            setRawMode?.(true);
          }
        });
        return;
      }
      if (providerSelection.provider === "shiori" && input === "e") {
        openPrompt({
          title: "Edit Shiori API Base URL",
          initialValue: state.serverConfig?.settings.providers.shiori.apiBaseUrl ?? "",
          onSubmit: async (value) => {
            await controller.updateServerSettings({
              providers: {
                shiori: {
                  apiBaseUrl: value.trim(),
                },
              },
            });
          },
        });
        return;
      }
      if (providerSelection.provider === "shiori" && input === "t") {
        openPrompt({
          title: "Import Shiori Token",
          secret: true,
          placeholder: "Paste hosted Shiori token",
          onSubmit: async (value) => {
            await controller.setShioriAuthToken(value.trim() || null);
          },
        });
        return;
      }
      if (providerSelection.provider === "shiori" && input === "x") {
        void runAction(() => controller.setShioriAuthToken(null));
      }
      return;
    }

    if (currentPendingUserInput && currentPendingQuestion) {
      const optionIndex = Number.parseInt(input, 10) - 1;
      const selectedOption = currentPendingQuestion.options[optionIndex];
      if (!Number.isNaN(optionIndex) && selectedOption) {
        const nextAnswers = {
          ...pendingUserAnswers,
          [currentPendingQuestion.id]: selectedOption.label,
        };
        const remainingQuestion = currentPendingUserInput.questions.find(
          (question) => nextAnswers[question.id] === undefined,
        );
        if (remainingQuestion) {
          setPendingUserAnswers(nextAnswers);
        } else {
          setPendingUserAnswers({});
          void runAction(() =>
            controller.respondToUserInput(currentPendingUserInput.requestId, nextAnswers),
          );
        }
        return;
      }
    }

    if (pendingApprovals.length > 0 && !showingSlashMenu) {
      const approval = pendingApprovals[0];
      if (!approval) return;
      const decision =
        input === "1"
          ? "accept"
          : input === "2"
            ? "acceptForSession"
            : input === "3"
              ? "decline"
              : input === "4"
                ? "cancel"
                : null;
      if (decision) {
        void runAction(() => controller.respondToApproval(approval.requestId, decision));
        return;
      }
    }

    if (showingSlashMenu) {
      if (key.upArrow) {
        setSlashIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (key.downArrow) {
        setSlashIndex((current) => Math.min(slashMatches.length - 1, current + 1));
        return;
      }
      if (key.tab) {
        const command = slashMatches[slashIndex];
        if (command) {
          setComposerValue(command.name + " ");
        }
        return;
      }
    }
  });

  const providerSnapshot = providerSelection
    ? (state.serverConfig?.providers.find(
        (provider) => provider.provider === providerSelection.provider,
      ) ?? null)
    : null;

  const activeSince = useMemo(() => {
    if (!selectedThread) return null;
    if (!isSessionActivelyRunningTurn(selectedThread.latestTurn ?? null, selectedThread.session)) {
      return null;
    }
    return selectedThread.latestTurn?.startedAt ?? null;
  }, [selectedThread]);

  const sessionStatus = sessionBadge(selectedThread);
  const composerPlaceholder = busy
    ? "Working…"
    : currentPendingQuestion
      ? "Answer inline above to continue…"
      : pendingApprovals.length > 0
        ? "Approval required above — press 1/2/3/4"
        : undefined;

  const statusHint =
    state.phase === "loading"
      ? "connecting to backend…"
      : transcriptMode
        ? "detailed transcript · ctrl+o or q return · ↑↓ scroll · pgup/pgdn page · home/end jump"
        : overlay === "switcher"
          ? "↑↓ navigate · enter switch · esc close"
          : overlay === "settings"
            ? "esc close · [ ] provider · ← → model · r runtime · i interaction"
            : focusedId
              ? "ctrl+↑↓ select · ctrl+space expand · ctrl+o transcript · pgup/pgdn scroll · esc follow"
              : "/ commands · ? help · ctrl+o transcript · ctrl+p threads · ctrl+↑↓ select · pgup/pgdn scroll · ctrl+c exit";

  return (
    <Box flexDirection="column" width={dimensions.columns} height={dimensions.rows}>
      <Welcome cwd={state.cwd} />

      <Box paddingX={1} justifyContent="space-between">
        <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} earlier` : " "}</Text>
        <Text dimColor>{hiddenBelow > 0 ? `${hiddenBelow} newer ↓` : " "}</Text>
      </Box>

      <Timeline
        entries={visibleTimelineEntries}
        height={timelineHeight}
        columns={dimensions.columns}
        expandedIds={expandedIds}
        focusedId={transcriptMode ? null : focusedId}
        transcriptMode={transcriptMode}
        {...(state.phase === "loading"
          ? { placeholder: "Connecting to backend…" }
          : !selectedThread
            ? { placeholder: "No thread selected." }
            : {})}
      />

      {activePlan ? (
        <Box paddingX={1} flexDirection="column">
          <Text color={palette.accent} bold>
            ◆ plan
          </Text>
          {activePlan.steps.slice(0, 5).map((step) => (
            <Text key={step.step} dimColor={step.status === "completed"}>
              {step.status === "completed"
                ? "  [x] "
                : step.status === "inProgress"
                  ? "  [›] "
                  : "  [ ] "}
              {step.step}
            </Text>
          ))}
        </Box>
      ) : null}

      {proposedPlan ? (
        <Box paddingX={1}>
          <Text color={palette.accentBright} bold>
            ◆ proposed plan ready
          </Text>
        </Box>
      ) : null}

      {pendingApprovals[0] ? (
        <ApprovalBanner
          title="approval required"
          {...(pendingApprovals[0].detail ? { detail: pendingApprovals[0].detail } : {})}
        />
      ) : null}

      {currentPendingUserInput && currentPendingQuestion ? (
        <UserInputBanner
          header={currentPendingQuestion.header}
          question={currentPendingQuestion.question}
          options={currentPendingQuestion.options}
        />
      ) : null}

      {overlay === "switcher" ? (
        <ThreadPicker threads={recentThreads} selectedIndex={switcherIndex} />
      ) : null}

      {overlay === "settings" && selectedThread && providerSelection ? (
        <SettingsOverlay
          provider={providerLabel(providerSelection.provider)}
          model={providerSelection.model}
          runtimeMode={selectedThread.runtimeMode}
          interactionMode={selectedThread.interactionMode}
          providerSnapshot={providerSnapshot}
          isShiori={providerSelection.provider === "shiori"}
          isExternalLoginProvider={
            providerSelection.provider === "codex" || providerSelection.provider === "claudeAgent"
          }
        />
      ) : null}

      {overlay === "help" ? <HelpPanel /> : null}

      {prompt ? (
        <PromptOverlay
          title={prompt.title}
          {...(prompt.placeholder ? { placeholder: prompt.placeholder } : {})}
          value={promptValue}
          {...(prompt.secret ? { secret: true } : {})}
        />
      ) : null}

      {showingSlashMenu ? <SlashMenu query={composerValue} selectedIndex={slashIndex} /> : null}

      {transcriptMode ? (
        <TranscriptFooter />
      ) : (
        <Composer
          value={composerValue}
          onChange={setComposerValue}
          onSubmit={submitComposer}
          {...(composerPlaceholder ? { placeholder: composerPlaceholder } : {})}
          disabled={composerDisabled}
          focused={!composerDisabled}
          onHistoryPrev={() => {
            if (history.length === 0) return;
            setHistoryCursor((current) => {
              const next = current === null ? history.length - 1 : Math.max(0, current - 1);
              const value = history[next];
              if (value !== undefined) setComposerValue(value);
              return next;
            });
          }}
          onHistoryNext={() => {
            setHistoryCursor((current) => {
              if (current === null) return null;
              const next = current + 1;
              if (next >= history.length) {
                setComposerValue("");
                return null;
              }
              const value = history[next];
              if (value !== undefined) setComposerValue(value);
              return next;
            });
          }}
        />
      )}

      <StatusLine
        provider={providerSelection?.provider ?? null}
        model={providerSelection?.model ?? null}
        runtimeMode={selectedThread?.runtimeMode ?? null}
        interactionMode={selectedThread?.interactionMode ?? null}
        sessionStatus={sessionStatus}
        activeSince={activeSince}
        notice={state.notice}
        error={state.error}
        hint={statusHint}
      />
    </Box>
  );
}

function computeOverlayRows(inputs: {
  pendingApproval: boolean;
  pendingUserInput: boolean;
  switcherOpen: boolean;
  settingsOpen: boolean;
  helpOpen: boolean;
  promptOpen: boolean;
  slashMenuOpen: boolean;
  activePlanRows: number;
  proposedPlanRow: number;
  recentThreadCount: number;
  slashMatchCount: number;
}): number {
  let rows = 0;
  if (inputs.pendingApproval) rows += 5;
  if (inputs.pendingUserInput) rows += 6;
  if (inputs.switcherOpen) rows += Math.min(10, inputs.recentThreadCount + 4);
  if (inputs.settingsOpen) rows += 10;
  if (inputs.helpOpen) rows += 14;
  if (inputs.promptOpen) rows += 5;
  if (inputs.slashMenuOpen) rows += Math.min(8, inputs.slashMatchCount);
  rows += inputs.activePlanRows;
  rows += inputs.proposedPlanRow;
  return rows;
}

function sessionBadge(thread: Thread | null): string {
  if (!thread?.session) return "idle";
  return thread.session.orchestrationStatus;
}

function providerLabel(provider: ProviderKind): string {
  switch (provider) {
    case "shiori":
      return "shiori";
    case "claudeAgent":
      return "claude";
    case "codex":
    default:
      return "codex";
  }
}

function TranscriptFooter() {
  return (
    <Box
      alignItems="center"
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderStyle="single"
      marginTop={1}
      paddingLeft={2}
      width="100%"
    >
      <Text dimColor>
        Showing detailed transcript · ctrl+o to toggle · ↑↓ scroll · pgup/pgdn page · home/end jump
        · q return
      </Text>
    </Box>
  );
}

function HelpPanel() {
  return (
    <Panel title="help" footer="esc close">
      <Text color={palette.accent} bold>
        Shortcuts
      </Text>
      <Text dimColor>ctrl+p threads · ctrl+n new · ctrl+s settings · ctrl+r interrupt</Text>
      <Text dimColor>
        ctrl+o transcript · ctrl+↑↓ select entry · ctrl+space expand · pgup/pgdn scroll
      </Text>
      <Text dimColor>ctrl+a archive · ctrl+c exit · shift+enter newline · enter send</Text>
      <Text> </Text>
      <Text color={palette.accent} bold>
        Commands
      </Text>
      {SLASH_COMMANDS.map((command) => (
        <Box key={command.name}>
          <Text color={palette.accent}>{command.name.padEnd(12)}</Text>
          <Text dimColor>{command.description}</Text>
        </Box>
      ))}
    </Panel>
  );
}

export function AppWithController({
  baseDir,
  cwd,
  projectId,
  threadId,
  newThread,
}: {
  readonly baseDir?: string;
  readonly cwd?: string;
  readonly projectId?: string;
  readonly threadId?: string;
  readonly newThread?: boolean;
}) {
  const [controller] = useState(() =>
    createAgentController({
      ...(baseDir ? { baseDir } : {}),
      ...(cwd ? { cwd } : {}),
      ...(projectId ? { projectId } : {}),
      ...(threadId ? { threadId } : {}),
      ...(newThread ? { newThread } : {}),
    }),
  );

  return <App controller={controller} />;
}

export type { ProviderKind, ProviderInteractionMode };
