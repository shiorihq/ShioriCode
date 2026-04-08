import { type MessageId, type TurnId } from "contracts";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LazyMotion, domAnimation, m, useReducedMotion } from "framer-motion";
import {
  measureElement as measureVirtualElement,
  type VirtualItem,
  useVirtualizer,
} from "@tanstack/react-virtual";
import { CHAT_THREAD_BODY_CLASS } from "../../chatTypography";
import { deriveTimelineEntries, formatElapsed } from "../../session-logic";
import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX } from "../../chat-scroll";
import { type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import { ChevronDownIcon, Undo2Icon } from "lucide-react";
import { Button } from "../ui/button";
import { clamp } from "effect/Number";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { InlineEditDiff, extractBasename, parseEditDiff } from "./InlineEditDiff";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  buildWorkGroupSummary,
  deriveMessagesTimelineRows,
  estimateMessagesTimelineRowHeight,
  formatWorkEntry,
  getDisplayedWorkEntries,
  type MessagesTimelineRow,
  type WorkTimelineRow,
} from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { BrailleLoader } from "../ui/braille-loader";
import { type TimestampFormat } from "contracts/settings";
import { formatTimestamp } from "../../timestampFormat";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";

/** Changed-files tree: top-level folders start collapsed until expanded or toggled. */
const DEFAULT_CHANGED_FILES_DIRS_EXPANDED = false;
const COLLAPSED_WORK_OUTPUT_LINE_THRESHOLD = 10;
const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;
const MIN_ROWS_FOR_VIRTUALIZATION = 120;

interface MessagesTimelineProps {
  hasMessages: boolean;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  activeTurnId?: TurnId | null;
  scrollContainer: HTMLDivElement | null;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  onVirtualizerSnapshot?: (snapshot: {
    totalSize: number;
    measurements: ReadonlyArray<{
      id: string;
      kind: MessagesTimelineRow["kind"];
      index: number;
      size: number;
      start: number;
      end: number;
    }>;
  }) => void;
}

export const MessagesTimeline = memo(function MessagesTimeline({
  hasMessages,
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  activeTurnId = null,
  scrollContainer,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  onVirtualizerSnapshot,
}: MessagesTimelineProps) {
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const [timelineWidthPx, setTimelineWidthPx] = useState<number | null>(null);

  useLayoutEffect(() => {
    const timelineRoot = timelineRootRef.current;
    if (!timelineRoot) return;

    const updateWidth = (nextWidth: number) => {
      setTimelineWidthPx((previousWidth) => {
        if (previousWidth !== null && Math.abs(previousWidth - nextWidth) < 0.5) {
          return previousWidth;
        }
        return nextWidth;
      });
    };

    updateWidth(timelineRoot.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      updateWidth(timelineRoot.getBoundingClientRect().width);
    });
    observer.observe(timelineRoot);
    return () => {
      observer.disconnect();
    };
  }, [hasMessages, isWorking]);

  const rows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId,
        isWorking,
        activeTurnStartedAt,
      }),
    [timelineEntries, completionDividerBeforeEntryId, isWorking, activeTurnStartedAt],
  );

  const firstUnvirtualizedRowIndex = useMemo(() => {
    const firstTailRowIndex = Math.max(rows.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS, 0);
    if (!activeTurnInProgress) return firstTailRowIndex;

    const turnStartedAtMs =
      typeof activeTurnStartedAt === "string" ? Date.parse(activeTurnStartedAt) : Number.NaN;
    let firstCurrentTurnRowIndex = -1;
    if (!Number.isNaN(turnStartedAtMs)) {
      firstCurrentTurnRowIndex = rows.findIndex((row) => {
        if (row.kind === "working") return true;
        if (!row.createdAt) return false;
        const rowCreatedAtMs = Date.parse(row.createdAt);
        return !Number.isNaN(rowCreatedAtMs) && rowCreatedAtMs >= turnStartedAtMs;
      });
    }

    if (firstCurrentTurnRowIndex < 0) {
      firstCurrentTurnRowIndex = rows.findIndex(
        (row) => row.kind === "message" && row.message.streaming,
      );
    }

    if (firstCurrentTurnRowIndex < 0) return firstTailRowIndex;

    for (let index = firstCurrentTurnRowIndex - 1; index >= 0; index -= 1) {
      const previousRow = rows[index];
      if (!previousRow || previousRow.kind !== "message") continue;
      if (previousRow.message.role === "user") {
        return Math.min(index, firstTailRowIndex);
      }
      if (previousRow.message.role === "assistant" && !previousRow.message.streaming) {
        break;
      }
    }

    return Math.min(firstCurrentTurnRowIndex, firstTailRowIndex);
  }, [activeTurnInProgress, activeTurnStartedAt, rows]);

  const shouldVirtualizeRows = rows.length >= MIN_ROWS_FOR_VIRTUALIZATION;
  const virtualizedRowCount = shouldVirtualizeRows
    ? clamp(firstUnvirtualizedRowIndex, {
        minimum: 0,
        maximum: rows.length,
      })
    : 0;
  const virtualMeasurementScopeKey =
    timelineWidthPx === null ? "width:unknown" : `width:${Math.round(timelineWidthPx)}`;
  const [allDirectoriesExpandedByTurnId, setAllDirectoriesExpandedByTurnId] = useState<
    Record<string, boolean>
  >({});

  const rowVirtualizer = useVirtualizer({
    count: virtualizedRowCount,
    getScrollElement: () => scrollContainer,
    // Scope cached row measurements to the current timeline width so offscreen
    // rows do not keep stale heights after wrapping changes.
    getItemKey: (index: number) => {
      const rowId = rows[index]?.id ?? String(index);
      return `${virtualMeasurementScopeKey}:${rowId}`;
    },
    estimateSize: (index: number) => {
      const row = rows[index];
      if (!row) return 96;
      return estimateMessagesTimelineRowHeight(row, {
        allDirectoriesExpandedByTurnId,
        expandedWorkGroups,
        timelineWidthPx,
        turnDiffSummaryByAssistantMessageId,
      });
    },
    measureElement: measureVirtualElement,
    useAnimationFrameWithResizeObserver: true,
    overscan: 8,
  });
  useEffect(() => {
    if (timelineWidthPx === null) return;
    rowVirtualizer.measure();
  }, [rowVirtualizer, timelineWidthPx]);
  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
      const viewportHeight = instance.scrollRect?.height ?? 0;
      const scrollOffset = instance.scrollOffset ?? 0;
      const itemIntersectsViewport =
        item.end > scrollOffset && item.start < scrollOffset + viewportHeight;
      if (itemIntersectsViewport) {
        return false;
      }
      const remainingDistance = instance.getTotalSize() - (scrollOffset + viewportHeight);
      return remainingDistance > AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    };
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [rowVirtualizer]);
  const pendingMeasureFrameRef = useRef<number | null>(null);
  const scheduleTimelineMeasure = useCallback(() => {
    if (pendingMeasureFrameRef.current !== null) return;
    pendingMeasureFrameRef.current = window.requestAnimationFrame(() => {
      pendingMeasureFrameRef.current = null;
      rowVirtualizer.measure();
    });
  }, [rowVirtualizer]);
  const onTimelineImageLoad = useCallback(() => {
    scheduleTimelineMeasure();
  }, [scheduleTimelineMeasure]);
  useEffect(() => {
    return () => {
      const frame = pendingMeasureFrameRef.current;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);
  useLayoutEffect(() => {
    if (!onVirtualizerSnapshot) {
      return;
    }
    onVirtualizerSnapshot({
      totalSize: rowVirtualizer.getTotalSize(),
      measurements: rowVirtualizer.measurementsCache
        .slice(0, virtualizedRowCount)
        .flatMap((measurement) => {
          const row = rows[measurement.index];
          if (!row) {
            return [];
          }
          return [
            {
              id: row.id,
              kind: row.kind,
              index: measurement.index,
              size: measurement.size,
              start: measurement.start,
              end: measurement.end,
            },
          ];
        }),
    });
  }, [onVirtualizerSnapshot, rowVirtualizer, rows, virtualizedRowCount]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const nonVirtualizedRows = rows.slice(virtualizedRowCount);
  const onToggleAllDirectories = useCallback(
    (turnId: TurnId) => {
      setAllDirectoriesExpandedByTurnId((current) => ({
        ...current,
        [turnId]: !(current[turnId] ?? DEFAULT_CHANGED_FILES_DIRS_EXPANDED),
      }));
      scheduleTimelineMeasure();
    },
    [scheduleTimelineMeasure],
  );

  // Only show the timestamp footer on the last assistant message per turn,
  // with the total accumulated duration from the user message to completion.
  const turnFooterStartByMessageId = useMemo(() => {
    const result = new Map<string, string>();
    let currentTurnStart: string | null = null;
    let lastAssistantInTurn: string | null = null;

    for (const row of rows) {
      if (row.kind === "message" && row.message.role === "user") {
        if (lastAssistantInTurn && currentTurnStart) {
          result.set(lastAssistantInTurn, currentTurnStart);
        }
        currentTurnStart = row.message.createdAt;
        lastAssistantInTurn = null;
      } else if (row.kind === "message" && row.message.role === "assistant") {
        if (currentTurnStart === null) {
          currentTurnStart = row.durationStart;
        }
        if (
          activeTurnInProgress &&
          activeTurnId !== null &&
          row.message.turnId !== undefined &&
          row.message.turnId === activeTurnId
        ) {
          lastAssistantInTurn = null;
        } else {
          lastAssistantInTurn = row.message.id;
        }
      }
    }

    if (lastAssistantInTurn && currentTurnStart) {
      result.set(lastAssistantInTurn, currentTurnStart);
    }

    return result;
  }, [activeTurnId, activeTurnInProgress, rows]);

  const renderWorkRow = (row: WorkTimelineRow, depth = 0): ReactNode => {
    const groupId = row.id;
    const entries = row.groupedEntries;
    const hasChildren = row.childRows.length > 0;
    const wrapperClassName = depth > 0 ? "ml-4 border-l border-border/40 pl-3" : "";

    if (hasChildren) {
      const parentEntry = entries[0]!;
      const isExpanded = expandedWorkGroups[groupId] ?? false;
      const formattedEntry = formatWorkEntry(parentEntry);
      const summary = formattedEntry.detail
        ? `${formattedEntry.action} ${formattedEntry.detail}`
        : formattedEntry.action;
      const isInProgress =
        entries.some((entry) => entry.running) ||
        row.childRows.some(
          (childRow) =>
            childRow.groupedEntries.some((entry) => entry.running) || childRow.stickyInProgress,
        ) ||
        row.stickyInProgress;
      const groupItemsId = `work-group-items-${groupId}`;

      return (
        <div className={wrapperClassName}>
          <div>
            <button
              type="button"
              aria-controls={groupItemsId}
              aria-expanded={isExpanded}
              className={cn(
                CHAT_THREAD_BODY_CLASS,
                "flex w-full min-w-0 cursor-pointer items-center gap-1 rounded-sm border-0 bg-transparent py-0.5 text-left text-foreground/80 transition-colors duration-150 hover:text-foreground/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
              )}
              onClick={() => {
                onToggleWorkGroup(groupId);
                scheduleTimelineMeasure();
              }}
            >
              <ChevronDownIcon
                className={cn(
                  "size-3 shrink-0 transition-transform duration-150",
                  !isExpanded && "-rotate-90",
                )}
              />
              <span className={cn(isInProgress && "shimmer shimmer-spread-200")}>{summary}</span>
            </button>
            <AnimatedExpandPanel open={isExpanded}>
              <div id={groupItemsId} className="mt-1 space-y-1">
                {row.childRows.map((childRow) => (
                  <div key={`nested-work-row:${childRow.id}`}>
                    {renderWorkRow(childRow, depth + 1)}
                  </div>
                ))}
              </div>
            </AnimatedExpandPanel>
          </div>
        </div>
      );
    }

    if (entries.length === 1) {
      const singleEntry = entries[0]!;
      if (isStatusUpdateEntry(singleEntry)) {
        return (
          <div className={wrapperClassName}>
            <StatusUpdateEntry workEntry={singleEntry} markdownCwd={markdownCwd} />
          </div>
        );
      }
      if (!singleEntry.running) {
        const isExpanded = expandedWorkGroups[groupId] ?? false;
        return (
          <div className={wrapperClassName}>
            <ExpandableWorkEntry
              workEntry={singleEntry}
              isExpanded={isExpanded}
              onToggle={() => onToggleWorkGroup(groupId)}
              onHeightChange={scheduleTimelineMeasure}
            />
          </div>
        );
      }
      return (
        <div className={wrapperClassName}>
          <MinimalWorkEntry workEntry={singleEntry} indented={false} />
        </div>
      );
    }

    const isExpanded = expandedWorkGroups[groupId] ?? false;
    const isInProgress = entries.some((e) => e.running) || row.stickyInProgress;
    const summary = buildWorkGroupSummary(entries, row.stickyInProgress);
    const groupItemsId = `work-group-items-${groupId}`;

    return (
      <div className={wrapperClassName}>
        <GroupedWorkEntries
          entries={entries}
          groupItemsId={groupItemsId}
          isExpanded={isExpanded}
          isInProgress={isInProgress}
          summary={summary}
          onHeightChange={scheduleTimelineMeasure}
          onToggleGroup={() => {
            onToggleWorkGroup(groupId);
            scheduleTimelineMeasure();
          }}
        />
      </div>
    );
  };

  const renderRowContent = (row: TimelineRow) => (
    <div
      className="pb-4"
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" && <AnimatedWorkGroupShell>{renderWorkRow(row)}</AnimatedWorkGroupShell>}

      {row.kind === "message" &&
        row.message.role === "user" &&
        (() => {
          const userImages = row.message.attachments ?? [];
          const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
          const terminalContexts = displayedUserMessage.contexts;
          const canRevertAgentWork = revertTurnCountByUserMessageId.has(row.message.id);
          return (
            <div className="group rounded-2xl border border-border/60 bg-secondary/80 px-4 py-3 shadow-sm">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  {userImages.length > 0 && (
                    <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
                      {userImages.map(
                        (image: NonNullable<TimelineMessage["attachments"]>[number]) => (
                          <div
                            key={image.id}
                            className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
                          >
                            {image.previewUrl ? (
                              <button
                                type="button"
                                className="h-full w-full cursor-zoom-in"
                                aria-label={`Preview ${image.name}`}
                                onClick={() => {
                                  const preview = buildExpandedImagePreview(userImages, image.id);
                                  if (!preview) return;
                                  onImageExpand(preview);
                                }}
                              >
                                <img
                                  src={image.previewUrl}
                                  alt={image.name}
                                  className="h-full max-h-[220px] w-full object-cover"
                                  onLoad={onTimelineImageLoad}
                                  onError={onTimelineImageLoad}
                                />
                              </button>
                            ) : (
                              <div
                                className={cn(
                                  CHAT_THREAD_BODY_CLASS,
                                  "flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-muted-foreground/70",
                                )}
                              >
                                {image.name}
                              </div>
                            )}
                          </div>
                        ),
                      )}
                    </div>
                  )}
                  {(displayedUserMessage.visibleText.trim().length > 0 ||
                    terminalContexts.length > 0) && (
                    <UserMessageBody
                      text={displayedUserMessage.visibleText}
                      terminalContexts={terminalContexts}
                    />
                  )}
                </div>
                {(displayedUserMessage.copyText || canRevertAgentWork) && (
                  <div className="flex shrink-0 items-center gap-1.5 pt-0.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                    {displayedUserMessage.copyText && (
                      <MessageCopyButton text={displayedUserMessage.copyText} />
                    )}
                    {canRevertAgentWork && (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={isRevertingCheckpoint || isWorking}
                        onClick={() => onRevertUserMessage(row.message.id)}
                        title="Revert to this message"
                      >
                        <Undo2Icon className="size-3" />
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "assistant" &&
        (() => {
          const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
          return (
            <>
              {row.showCompletionDivider && (
                <div className="mb-3 mt-1">
                  {completionSummary && (
                    <p className={cn(CHAT_THREAD_BODY_CLASS, "mb-2 pl-1 text-foreground/60")}>
                      {completionSummary}
                    </p>
                  )}
                  <span className="block h-px w-full bg-border/60" />
                </div>
              )}
              <div className="min-w-0 px-1 py-0.5">
                <ChatMarkdown
                  text={messageText}
                  cwd={markdownCwd}
                  isStreaming={Boolean(row.message.streaming)}
                />
                {(() => {
                  const turnSummary = turnDiffSummaryByAssistantMessageId.get(row.message.id);
                  if (!turnSummary) return null;
                  const checkpointFiles = turnSummary.files;
                  if (checkpointFiles.length === 0) return null;
                  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
                  const changedFileCountLabel = String(checkpointFiles.length);
                  const allDirectoriesExpanded =
                    allDirectoriesExpandedByTurnId[turnSummary.turnId] ??
                    DEFAULT_CHANGED_FILES_DIRS_EXPANDED;
                  return (
                    <div className="mt-3 rounded-lg border border-border/40 p-2.5">
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <p className={cn(CHAT_THREAD_BODY_CLASS, "min-w-0 text-foreground/80")}>
                          <span>Changed files</span>
                          <span> ({changedFileCountLabel})</span>
                          {hasNonZeroStat(summaryStat) && (
                            <>
                              {" "}
                              <DiffStatLabel
                                additions={summaryStat.additions}
                                deletions={summaryStat.deletions}
                              />
                            </>
                          )}
                        </p>
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            className={cn(
                              CHAT_THREAD_BODY_CLASS,
                              "h-auto min-h-0 shrink-0 px-1.5 py-0.5 text-foreground/75 hover:text-foreground/90",
                            )}
                            data-scroll-anchor-ignore
                            onClick={() => onToggleAllDirectories(turnSummary.turnId)}
                          >
                            {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            className={cn(
                              CHAT_THREAD_BODY_CLASS,
                              "h-auto min-h-0 shrink-0 px-1.5 py-0.5 text-foreground/75 hover:text-foreground/90",
                            )}
                            onClick={() =>
                              onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)
                            }
                          >
                            View diff
                          </Button>
                        </div>
                      </div>
                      <ChangedFilesTree
                        key={`changed-files-tree:${turnSummary.turnId}`}
                        turnId={turnSummary.turnId}
                        files={checkpointFiles}
                        allDirectoriesExpanded={allDirectoriesExpanded}
                        resolvedTheme={resolvedTheme}
                        onHeightChange={scheduleTimelineMeasure}
                        onOpenTurnDiff={onOpenTurnDiff}
                      />
                    </div>
                  );
                })()}
                {(() => {
                  const turnStart = turnFooterStartByMessageId.get(row.message.id);
                  if (!turnStart) return null;
                  return (
                    <div className="mt-1.5 flex items-center gap-1.5">
                      {!row.message.streaming && messageText && (
                        <MessageCopyButton text={messageText} />
                      )}
                      <AssistantMessageMeta
                        createdAt={row.message.createdAt}
                        durationStart={turnStart}
                        completedAt={row.message.completedAt}
                        streaming={Boolean(row.message.streaming)}
                        timestampFormat={timestampFormat}
                      />
                    </div>
                  );
                })()}
              </div>
            </>
          );
        })()}

      {row.kind === "reasoning" && (
        <ReasoningTimelineEntry
          reasoning={row.reasoning}
          markdownCwd={markdownCwd}
          onHeightChange={scheduleTimelineMeasure}
        />
      )}

      {row.kind === "proposed-plan" && (
        <div className="min-w-0 px-1 py-0.5">
          <ProposedPlanCard
            planMarkdown={row.proposedPlan.planMarkdown}
            cwd={markdownCwd}
            workspaceRoot={workspaceRoot}
          />
        </div>
      )}

      {row.kind === "working" && (
        <div className="py-0.5 pl-1">
          <WorkingIndicator createdAt={row.createdAt} />
        </div>
      )}
    </div>
  );

  if (!hasMessages && !isWorking) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className={cn(CHAT_THREAD_BODY_CLASS, "text-foreground/55")}>
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <LazyMotion features={domAnimation}>
      <div
        ref={timelineRootRef}
        data-timeline-root="true"
        className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden"
      >
        {virtualizedRowCount > 0 && (
          <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
            {virtualRows.map((virtualRow: VirtualItem) => {
              const row = rows[virtualRow.index];
              if (!row) return null;

              return (
                <div
                  key={`virtual-row:${row.id}`}
                  data-index={virtualRow.index}
                  data-virtual-row-id={row.id}
                  data-virtual-row-kind={row.kind}
                  data-virtual-row-size={virtualRow.size}
                  data-virtual-row-start={virtualRow.start}
                  ref={rowVirtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {renderRowContent(row)}
                </div>
              );
            })}
          </div>
        )}

        {nonVirtualizedRows.map((row) => (
          <div key={`non-virtual-row:${row.id}`}>{renderRowContent(row)}</div>
        ))}
      </div>
    </LazyMotion>
  );
});

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineReasoning = Extract<TimelineEntry, { kind: "reasoning" }>["reasoning"];
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return null;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);

  if (hours > 0) {
    return `Working for ${minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`}`;
  }

  return `Working for ${minutes}m`;
}

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} • ${duration}`;
}

function useLiveNowIso(active: boolean): string {
  const [nowTick, setNowTick] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      return;
    }

    setNowTick(Date.now());
    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [active]);

  return useMemo(() => new Date(nowTick).toISOString(), [nowTick]);
}

const AssistantMessageMeta = memo(function AssistantMessageMeta(props: {
  createdAt: string;
  durationStart: string;
  completedAt: string | undefined;
  streaming: boolean;
  timestampFormat: TimestampFormat;
}) {
  const nowIso = useLiveNowIso(props.streaming);
  const duration = useMemo(
    () =>
      props.streaming
        ? formatElapsed(props.durationStart, nowIso)
        : formatElapsed(props.durationStart, props.completedAt),
    [nowIso, props.completedAt, props.durationStart, props.streaming],
  );

  return (
    <p className={cn(CHAT_THREAD_BODY_CLASS, "text-foreground/55")}>
      {formatMessageMeta(props.createdAt, duration, props.timestampFormat)}
    </p>
  );
});

const WorkingIndicator = memo(function WorkingIndicator(props: { createdAt: string | null }) {
  const nowIso = useLiveNowIso(props.createdAt !== null);
  const label = props.createdAt
    ? (formatWorkingTimer(props.createdAt, nowIso) ?? "Working")
    : "Working";

  return (
    <p className={cn(CHAT_THREAD_BODY_CLASS, "text-foreground/70")}>
      <BrailleLoader className="mr-1.5 text-foreground/50" />
      {label}
    </p>
  );
});

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
}) {
  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              {props.text.slice(cursor, matchIndex)}
            </span>,
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              {props.text.slice(cursor)}
            </span>,
          );
        }

        return (
          <div
            className={cn(
              CHAT_THREAD_BODY_CLASS,
              "wrap-break-word whitespace-pre-wrap text-foreground",
            )}
          >
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(<span key="user-message-terminal-context-inline-text">{props.text}</span>);
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div
        className={cn(
          CHAT_THREAD_BODY_CLASS,
          "wrap-break-word whitespace-pre-wrap text-foreground",
        )}
      >
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(CHAT_THREAD_BODY_CLASS, "whitespace-pre-wrap wrap-break-word text-foreground")}
    >
      {props.text}
    </div>
  );
});

const ReasoningTimelineEntry = memo(function ReasoningTimelineEntry(props: {
  reasoning: TimelineReasoning;
  markdownCwd: string | undefined;
  onHeightChange?: () => void;
}) {
  const { reasoning, markdownCwd, onHeightChange } = props;
  const [isExpanded, setIsExpanded] = useState(reasoning.streaming);
  const hasContent = reasoning.text.trim().length > 0;
  const placeholderText = reasoning.streaming
    ? "Reasoning is in progress. Details may remain hidden for this provider."
    : "No visible reasoning details were provided for this step.";

  useEffect(() => {
    if (reasoning.streaming) {
      setIsExpanded(true);
    } else {
      setIsExpanded(false);
    }
  }, [reasoning.streaming]);

  useLayoutEffect(() => {
    onHeightChange?.();
  }, [isExpanded, onHeightChange, reasoning.streaming, reasoning.text]);

  return (
    <div className="py-0.5">
      <button
        type="button"
        className={cn(
          CHAT_THREAD_BODY_CLASS,
          "flex w-full min-w-0 items-center gap-1 rounded-sm py-0.5 text-left text-foreground/80 transition-colors duration-150 hover:text-foreground/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
        )}
        onClick={() => {
          setIsExpanded((current) => !current);
        }}
        aria-expanded={isExpanded}
      >
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0 transition-transform duration-150",
            !isExpanded && "-rotate-90",
          )}
        />
        <span className={cn(reasoning.streaming && "shimmer shimmer-spread-200")}>
          {reasoning.streaming ? "Thinking" : "Thought"}
        </span>
      </button>
      {isExpanded && (
        <div className="mt-1">
          {hasContent ? (
            <div className="max-h-32 overflow-y-auto pr-2">
              <ChatMarkdown
                text={reasoning.text}
                cwd={markdownCwd}
                isStreaming={reasoning.streaming}
                className="text-foreground/55"
              />
            </div>
          ) : (
            <p className={cn(CHAT_THREAD_BODY_CLASS, "pr-2 text-foreground/50")}>
              {placeholderText}
            </p>
          )}
        </div>
      )}
    </div>
  );
});

function isStatusUpdateEntry(entry: TimelineWorkEntry): boolean {
  return entry.label.trim().toLowerCase() === "status update";
}

function statusUpdateText(entry: TimelineWorkEntry): string | null {
  const detail = entry.detail?.trim() || entry.command?.trim() || "";
  if (detail.length > 0) {
    const normalized = detail.replace(/^status update[:\s-]*/i, "").trim();
    return normalized.length > 0 ? normalized : null;
  }
  return null;
}

const StatusUpdateEntry = memo(function StatusUpdateEntry(props: {
  workEntry: TimelineWorkEntry;
  markdownCwd: string | undefined;
}) {
  const text = statusUpdateText(props.workEntry);
  if (!text) {
    return null;
  }

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ChatMarkdown
        text={text}
        cwd={props.markdownCwd}
        isStreaming={Boolean(props.workEntry.running)}
      />
    </div>
  );
});

function formatMinimalEntry(entry: TimelineWorkEntry): { action: string; detail: string | null } {
  const formattedEntry = formatWorkEntry(entry);
  return {
    action: formattedEntry.action,
    detail: formattedEntry.detail,
  };
}

const WorkEntryDetail = memo(function WorkEntryDetail(props: {
  detail: string;
  monospace?: boolean;
}) {
  const { detail, monospace = false } = props;

  return (
    <span className={cn(monospace ? "font-mono text-muted-foreground/80" : "text-foreground/90")}>
      {" "}
      {detail}
    </span>
  );
});

const MinimalWorkEntry = memo(function MinimalWorkEntry(props: {
  workEntry: TimelineWorkEntry;
  indented?: boolean;
  asListItem?: boolean;
}) {
  const { workEntry, indented = true, asListItem = false } = props;
  const { action, detail } = formatMinimalEntry(workEntry);
  const formattedEntry = formatWorkEntry(workEntry);
  const detailUsesMono = formattedEntry.monospace;
  const isFileChange = formattedEntry.kind === "edit";
  const Component = asListItem ? "li" : "p";

  return (
    <Component
      className={cn(
        CHAT_THREAD_BODY_CLASS,
        "list-none truncate py-0.5 text-foreground/80",
        indented ? "pl-4" : "pl-1",
        workEntry.running && "shimmer shimmer-spread-200",
      )}
      title={detail ? `${action} ${detail}` : action}
    >
      <span>{action}</span>
      {detail && (
        <WorkEntryDetail
          detail={isFileChange ? extractBasename(detail) : detail}
          monospace={detailUsesMono}
        />
      )}
    </Component>
  );
});

const AnimatedWorkGroupShell = memo(function AnimatedWorkGroupShell(props: {
  children: ReactNode;
}) {
  const shouldReduceMotion = useReducedMotion();
  const motionProps = shouldReduceMotion
    ? { initial: false as const }
    : {
        initial: { opacity: 0, y: 2 },
        animate: { opacity: 1, y: 0 },
      };

  return (
    <m.div {...motionProps} transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}>
      {props.children}
    </m.div>
  );
});

/** Animates a panel open/close via grid-template-rows transition. */
function AnimatedExpandPanel({
  open,
  children,
  className,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-200 ease-out",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface CommandExecutionActionSummary {
  label: string;
  detail: string | null;
}

interface CommandExecutionOutputSummary {
  command: string | null;
  cwd: string | null;
  status: string | null;
  processId: string | null;
  source: string | null;
  stdout: string | null;
  stderr: string | null;
  actions: ReadonlyArray<CommandExecutionActionSummary>;
}

interface WorkflowToolSummaryField {
  label: string;
  value: string;
  monospace?: boolean;
}

interface WorkflowToolSummary {
  kind: "skill" | "subagent";
  title: string;
  summary: string | null;
  fields: ReadonlyArray<WorkflowToolSummaryField>;
}

function normalizeToolResultErrorText(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value
    .replace(/<tool_use_error>/gi, "")
    .replace(/<\/tool_use_error>/gi, "")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function extractToolErrorText(output: unknown): string | null {
  const record = asObject(output);
  if (!record) {
    return null;
  }

  const result = asObject(record.result) ?? asObject(asObject(record.item)?.result);
  if (!result) {
    return null;
  }

  if (result.is_error === true) {
    return normalizeToolResultErrorText(asNonEmptyString(result.content));
  }
  return null;
}

function extractCommandExecutionSummary(output: unknown): CommandExecutionOutputSummary | null {
  const record = asObject(output);
  if (!record) {
    return null;
  }

  const item = asObject(record.item) ?? record;
  const itemType = asNonEmptyString(item.type) ?? asNonEmptyString(item.kind);
  const looksLikeCommandExecution =
    itemType?.toLowerCase().includes("command") === true ||
    "commandActions" in item ||
    "processId" in item ||
    "cwd" in item;

  if (!looksLikeCommandExecution) {
    return null;
  }

  const result = asObject(item.result);
  const stdout = asNonEmptyString(result?.stdout) ?? asNonEmptyString(record.stdout);
  const stderr = asNonEmptyString(result?.stderr) ?? asNonEmptyString(record.stderr);
  const actions =
    (Array.isArray(item.commandActions) ? item.commandActions : [])
      .map((value) => {
        const action = asObject(value);
        if (!action) {
          return null;
        }
        const label =
          asNonEmptyString(action.label) ??
          asNonEmptyString(action.title) ??
          asNonEmptyString(action.name) ??
          asNonEmptyString(action.kind) ??
          asNonEmptyString(action.type);
        if (!label) {
          return null;
        }

        return {
          label,
          detail:
            asNonEmptyString(action.description) ??
            asNonEmptyString(action.prompt) ??
            asNonEmptyString(action.value) ??
            asNonEmptyString(action.command),
        };
      })
      .filter((action): action is CommandExecutionActionSummary => action !== null) ?? [];

  return {
    command:
      asNonEmptyString(item.command) ??
      asNonEmptyString(asObject(item.input)?.command) ??
      asNonEmptyString(result?.command),
    cwd: asNonEmptyString(item.cwd) ?? asNonEmptyString(result?.cwd),
    status: asNonEmptyString(item.status) ?? asNonEmptyString(result?.status),
    processId: asNonEmptyString(item.processId) ?? asNonEmptyString(result?.processId),
    source: asNonEmptyString(item.source) ?? asNonEmptyString(result?.source),
    stdout,
    stderr,
    actions,
  };
}

function extractWorkflowToolSummary(output: unknown): WorkflowToolSummary | null {
  const record = asObject(output);
  if (!record) {
    return null;
  }

  const item = asObject(record.item);
  const toolNameRaw =
    asNonEmptyString(record.toolName) ??
    asNonEmptyString(item?.toolName) ??
    asNonEmptyString(item?.name) ??
    asNonEmptyString(record.name);
  const toolName = toolNameRaw?.trim().toLowerCase() ?? null;
  const input = asObject(record.input) ?? asObject(item?.input);
  const result = asObject(record.result) ?? asObject(item?.result);

  if (toolName === "skill") {
    const skillName =
      asNonEmptyString(input?.skill) ??
      asNonEmptyString(input?.skillName) ??
      asNonEmptyString(result?.tool_use_id);
    const launchSummary =
      asNonEmptyString(result?.content) ?? asNonEmptyString(result?.type) ?? null;
    const fields: WorkflowToolSummaryField[] = [];
    if (skillName) {
      fields.push({ label: "Skill", value: skillName });
    }
    if (asNonEmptyString(result?.type)) {
      fields.push({ label: "Result type", value: asNonEmptyString(result?.type)! });
    }
    if (asNonEmptyString(result?.tool_use_id)) {
      fields.push({
        label: "Tool use",
        value: asNonEmptyString(result?.tool_use_id)!,
        monospace: true,
      });
    }
    return {
      kind: "skill",
      title: "Skill workflow",
      summary: launchSummary,
      fields,
    };
  }

  const subagentType =
    asNonEmptyString(input?.subagent_type) ??
    asNonEmptyString(input?.subagentType) ??
    asNonEmptyString(input?.agent_type) ??
    asNonEmptyString(input?.agentType);
  if (toolName === "agent" || toolName === "task" || subagentType) {
    const description =
      asNonEmptyString(input?.description) ??
      asNonEmptyString(input?.task) ??
      asNonEmptyString(input?.name);
    const prompt = asNonEmptyString(input?.prompt);
    const fields: WorkflowToolSummaryField[] = [];
    if (subagentType) {
      fields.push({ label: "Agent type", value: subagentType });
    }
    if (description) {
      fields.push({ label: "Task", value: description });
    }
    if (prompt) {
      fields.push({ label: "Prompt", value: prompt });
    }
    if (input?.run_in_background === true) {
      fields.push({ label: "Mode", value: "Background" });
    }
    return {
      kind: "subagent",
      title: "Delegated agent",
      summary: description ?? subagentType ?? null,
      fields,
    };
  }

  return null;
}

function formatToolOutput(output: unknown): string | null {
  if (output == null) return null;
  if (typeof output === "string") return output || null;
  if (typeof output === "object" && !Array.isArray(output)) {
    const record = output as Record<string, unknown>;
    if (extractCommandExecutionSummary(record)) {
      return null;
    }
    if (typeof record.content === "string") {
      return record.content || null;
    }
    if ("entries" in record && Array.isArray(record.entries)) {
      const entries = record.entries as Array<{ name?: string; kind?: string }>;
      if (entries.length === 0) return "(empty directory)";
      return entries
        .map((e) => {
          const suffix = e.kind === "directory" ? "/" : "";
          return `${e.name ?? "?"}${suffix}`;
        })
        .join("\n");
    }
    const stdout = typeof record.stdout === "string" ? record.stdout.trimEnd() : "";
    const stderr = typeof record.stderr === "string" ? record.stderr.trimEnd() : "";
    if (stdout || stderr) {
      if (stdout && stderr) {
        return `${stdout}\n\n${stderr}`;
      }
      return stdout || stderr || null;
    }
    if (typeof record.bytesWritten === "number" && typeof record.path === "string") {
      return `Wrote ${record.bytesWritten} bytes to ${record.path}`;
    }
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return null;
  }
}

function countWorkOutputLines(outputText: string): number {
  return Math.max(1, outputText.split(/\r?\n/g).length);
}

interface ExpandableWorkEntryProps {
  workEntry: TimelineWorkEntry;
  isExpanded: boolean;
  onToggle: () => void;
  onHeightChange?: () => void;
}

const ExpandableWorkEntry = memo(function ExpandableWorkEntry(props: ExpandableWorkEntryProps) {
  const { workEntry, isExpanded, onToggle, onHeightChange } = props;
  const { action, detail } = formatMinimalEntry(workEntry);
  const formattedEntry = formatWorkEntry(workEntry);
  const commandExecutionSummary = useMemo(
    () => extractCommandExecutionSummary(workEntry.output),
    [workEntry.output],
  );
  const workflowToolSummary = useMemo(
    () => extractWorkflowToolSummary(workEntry.output),
    [workEntry.output],
  );
  const toolErrorText = useMemo(() => extractToolErrorText(workEntry.output), [workEntry.output]);
  const detailUsesMono = formattedEntry.monospace;
  const outputText = formatToolOutput(workEntry.output);
  const [isOutputExpanded, setIsOutputExpanded] = useState(false);
  const expandedContentId = `work-entry-details-${workEntry.id}`;

  const isFileChange = formattedEntry.kind === "edit";
  const parsedDiff = useMemo(
    () => (isFileChange ? parseEditDiff(workEntry.output, workEntry.detail) : null),
    [isFileChange, workEntry.output, workEntry.detail],
  );

  const shouldClampOutput = useMemo(
    () =>
      !parsedDiff &&
      typeof outputText === "string" &&
      countWorkOutputLines(outputText) > COLLAPSED_WORK_OUTPUT_LINE_THRESHOLD,
    [parsedDiff, outputText],
  );

  useEffect(() => {
    if (!isExpanded) {
      setIsOutputExpanded(false);
    }
  }, [isExpanded]);

  useLayoutEffect(() => {
    onHeightChange?.();
  }, [isExpanded, isOutputExpanded, onHeightChange]);

  return (
    <div className="tool-ui-mono-muted">
      <button
        type="button"
        aria-controls={expandedContentId}
        aria-expanded={isExpanded}
        className={cn(
          CHAT_THREAD_BODY_CLASS,
          "flex w-full min-w-0 cursor-pointer items-center gap-1 rounded-sm border-0 bg-transparent py-0.5 text-left text-foreground/80 transition-colors duration-150 hover:text-foreground/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
        )}
        onClick={onToggle}
      >
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0 transition-transform duration-150",
            !isExpanded && "-rotate-90",
          )}
        />
        <span className="truncate" title={detail ? `${action} ${detail}` : action}>
          <span>{action}</span>
          {detail && (
            <WorkEntryDetail
              detail={isFileChange ? extractBasename(detail) : detail}
              monospace={detailUsesMono}
            />
          )}
          {parsedDiff && hasNonZeroStat(parsedDiff) && (
            <span className={cn(CHAT_THREAD_BODY_CLASS, "ml-1 tabular-nums")}>
              <DiffStatLabel additions={parsedDiff.additions} deletions={parsedDiff.deletions} />
            </span>
          )}
        </span>
      </button>

      <AnimatedExpandPanel open={isExpanded}>
        <div id={expandedContentId}>
          {workflowToolSummary && (
            <div className="mt-1 space-y-2 pl-4">
              <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                <p className={cn(CHAT_THREAD_BODY_CLASS, "font-medium text-foreground/75")}>
                  {workflowToolSummary.title}
                </p>
                {workflowToolSummary.summary && (
                  <p className={cn(CHAT_THREAD_BODY_CLASS, "mt-1 text-foreground/85")}>
                    {workflowToolSummary.summary}
                  </p>
                )}
                {workflowToolSummary.fields.length > 0 && (
                  <dl
                    className={cn(
                      CHAT_THREAD_BODY_CLASS,
                      "mt-2 grid gap-1 text-foreground/65 sm:grid-cols-[auto_1fr] sm:items-start sm:gap-x-3",
                    )}
                  >
                    {workflowToolSummary.fields.map((field) => (
                      <Fragment key={`${field.label}:${field.value}`}>
                        <dt className="font-medium text-foreground/55">{field.label}</dt>
                        <dd className={cn(field.monospace && "font-mono", "text-foreground/75")}>
                          {field.value}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                )}
              </div>
            </div>
          )}

          {commandExecutionSummary && (
            <div className="mt-1 space-y-2 pl-4">
              <dl
                className={cn(
                  CHAT_THREAD_BODY_CLASS,
                  "grid gap-1 text-foreground/65 sm:grid-cols-[auto_1fr] sm:items-start sm:gap-x-3",
                )}
              >
                {commandExecutionSummary.command && (
                  <>
                    <dt className="font-medium text-foreground/55">Command</dt>
                    <dd className="font-mono text-foreground/75">
                      {commandExecutionSummary.command}
                    </dd>
                  </>
                )}
                {commandExecutionSummary.cwd && (
                  <>
                    <dt className="font-medium text-foreground/55">Directory</dt>
                    <dd className="font-mono text-foreground/75">{commandExecutionSummary.cwd}</dd>
                  </>
                )}
                {commandExecutionSummary.status && (
                  <>
                    <dt className="font-medium text-foreground/55">Status</dt>
                    <dd>{commandExecutionSummary.status}</dd>
                  </>
                )}
                {commandExecutionSummary.processId && (
                  <>
                    <dt className="font-medium text-foreground/55">PID</dt>
                    <dd className="font-mono text-foreground/75">
                      {commandExecutionSummary.processId}
                    </dd>
                  </>
                )}
                {commandExecutionSummary.source && (
                  <>
                    <dt className="font-medium text-foreground/55">Source</dt>
                    <dd>{commandExecutionSummary.source}</dd>
                  </>
                )}
              </dl>
              {commandExecutionSummary.actions.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {commandExecutionSummary.actions.map((commandAction) => (
                    <span
                      key={`${commandAction.label}:${commandAction.detail ?? ""}`}
                      className={cn(
                        CHAT_THREAD_BODY_CLASS,
                        "rounded-full border border-border/70 px-2 py-0.5 text-foreground/60",
                      )}
                      title={commandAction.detail ?? undefined}
                    >
                      {commandAction.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Inline diff for file changes */}
          {parsedDiff && (
            <div className="mt-1 pl-4">
              <InlineEditDiff diff={parsedDiff} />
            </div>
          )}

          {toolErrorText && (
            <div className="mt-1 pl-4">
              <p
                className={cn(
                  CHAT_THREAD_BODY_CLASS,
                  "rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2 text-destructive/85",
                )}
              >
                {toolErrorText}
              </p>
            </div>
          )}

          {!parsedDiff && !toolErrorText && commandExecutionSummary?.stdout && (
            <div className="mt-0.5 pl-4">
              <pre
                className={cn(
                  CHAT_THREAD_BODY_CLASS,
                  "overflow-x-auto whitespace-pre text-foreground/60",
                )}
              >
                {commandExecutionSummary.stdout}
              </pre>
            </div>
          )}

          {!parsedDiff &&
            !toolErrorText &&
            !commandExecutionSummary?.stdout &&
            commandExecutionSummary?.stderr && (
              <div className="mt-0.5 pl-4">
                <pre
                  className={cn(
                    CHAT_THREAD_BODY_CLASS,
                    "overflow-x-auto whitespace-pre text-foreground/60",
                  )}
                >
                  {commandExecutionSummary.stderr}
                </pre>
              </div>
            )}

          {/* Fallback: raw text output */}
          {!parsedDiff && !workflowToolSummary && !toolErrorText && outputText && (
            <div className="mt-0.5 pl-4">
              <div className="relative">
                <pre
                  className={cn(
                    CHAT_THREAD_BODY_CLASS,
                    "overflow-x-auto whitespace-pre text-foreground/60",
                    shouldClampOutput && !isOutputExpanded
                      ? "max-h-48 overflow-y-hidden"
                      : "overflow-y-visible",
                  )}
                  style={
                    shouldClampOutput && !isOutputExpanded
                      ? {
                          maskImage:
                            "linear-gradient(to bottom, black calc(100% - 3rem), transparent 100%)",
                        }
                      : undefined
                  }
                >
                  {outputText}
                </pre>
                {shouldClampOutput && !isOutputExpanded && (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background via-background/85 to-transparent"
                  />
                )}
              </div>
              {shouldClampOutput && (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className={cn(
                    CHAT_THREAD_BODY_CLASS,
                    "mt-1 h-auto px-0 py-0 text-foreground/65 hover:bg-transparent hover:text-foreground/85",
                  )}
                  onClick={() => {
                    setIsOutputExpanded((current) => !current);
                  }}
                >
                  {isOutputExpanded ? "Show less" : "Show more"}
                </Button>
              )}
            </div>
          )}
        </div>
      </AnimatedExpandPanel>
    </div>
  );
});

const GroupedWorkEntries = memo(function GroupedWorkEntries(props: {
  entries: ReadonlyArray<TimelineWorkEntry>;
  groupItemsId: string;
  isExpanded: boolean;
  isInProgress: boolean;
  summary: string;
  onToggleGroup: () => void;
  onHeightChange?: () => void;
}) {
  const {
    entries,
    groupItemsId,
    isExpanded,
    isInProgress,
    onHeightChange,
    onToggleGroup,
    summary,
  } = props;
  const [showAllEntries, setShowAllEntries] = useState(false);
  const displayedEntries = useMemo(() => getDisplayedWorkEntries(entries), [entries]);
  const hiddenEntryCount = Math.max(displayedEntries.length - MAX_VISIBLE_WORK_LOG_ENTRIES, 0);
  const visibleEntries =
    isExpanded && !showAllEntries
      ? displayedEntries.slice(0, MAX_VISIBLE_WORK_LOG_ENTRIES)
      : displayedEntries;
  const shouldShowMoreToggle = isExpanded && hiddenEntryCount > 0;

  useEffect(() => {
    if (!isExpanded) {
      setShowAllEntries(false);
    }
  }, [isExpanded]);

  useLayoutEffect(() => {
    onHeightChange?.();
  }, [isExpanded, onHeightChange, showAllEntries]);

  return (
    <div>
      <button
        type="button"
        aria-controls={groupItemsId}
        aria-expanded={isExpanded}
        className={cn(
          CHAT_THREAD_BODY_CLASS,
          "flex w-full min-w-0 cursor-pointer items-center gap-1 rounded-sm border-0 bg-transparent py-0.5 text-left text-foreground/80 transition-colors duration-150 hover:text-foreground/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
        )}
        onClick={onToggleGroup}
      >
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0 transition-transform duration-150",
            !isExpanded && "-rotate-90",
          )}
        />
        <span className={cn(isInProgress && "shimmer shimmer-spread-200")}>{summary}</span>
      </button>
      <AnimatedExpandPanel open={isExpanded}>
        <div id={groupItemsId} className="mt-0.5">
          <ul>
            {visibleEntries.map((workEntry) => (
              <MinimalWorkEntry key={`work-row:${workEntry.id}`} workEntry={workEntry} asListItem />
            ))}
          </ul>
          {shouldShowMoreToggle ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className={cn(
                CHAT_THREAD_BODY_CLASS,
                "mt-1 h-auto px-4 py-0 text-foreground/65 hover:bg-transparent hover:text-foreground/85",
              )}
              onClick={() => {
                setShowAllEntries((current) => !current);
              }}
            >
              {showAllEntries ? "Show fewer" : `Show ${hiddenEntryCount} more`}
            </Button>
          ) : null}
        </div>
      </AnimatedExpandPanel>
    </div>
  );
});
