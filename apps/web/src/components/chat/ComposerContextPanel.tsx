import {
  ArrowUpIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleIcon,
  CircleSlashIcon,
  ClockIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { memo, type ComponentType, type ReactNode, type SVGProps, useMemo, useState } from "react";

import { stripInlineTerminalContextPlaceholders } from "../../lib/terminalContext";
import type {
  ActiveTaskListItem,
  ActiveTaskListState,
  TaskListItemStatus,
} from "../../session-logic";
import { type QueuedTurnDraft } from "../../queuedTurnsStore";
import { cn } from "~/lib/utils";
import { AnimatedExpandPanel } from "../ui/AnimatedExpandPanel";
import { Button } from "../ui/button";
import { MaskedScrollViewport } from "../ui/masked-scroll-viewport";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { MinimalWorkEntry } from "./MessagesTimeline";
import { type CodexBackgroundSubagentRow } from "./subagentDetail";

const FADE_LIST_MASK_IMAGE =
  "linear-gradient(to bottom, transparent 0, black 0.75rem, black calc(100% - 0.75rem), transparent 100%)";

function FadedListViewport(props: {
  scrollable: boolean;
  ariaLabel?: string;
  children: ReactNode;
}) {
  return (
    <div
      className="border-t border-border/45"
      style={{ maskImage: FADE_LIST_MASK_IMAGE, WebkitMaskImage: FADE_LIST_MASK_IMAGE }}
      aria-label={props.ariaLabel}
    >
      <div
        className={cn(
          "overscroll-contain",
          props.scrollable &&
            "max-h-56 overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        {props.children}
      </div>
    </div>
  );
}

interface ComposerContextPanelProps {
  taskList: ActiveTaskListState | null;
  taskListOpen: boolean;
  backgroundSubagents: ReadonlyArray<CodexBackgroundSubagentRow>;
  backgroundSubagentsOpen: boolean;
  queuedTurns: ReadonlyArray<QueuedTurnDraft>;
  queuedOpen: boolean;
  onTaskListOpenChange: (open: boolean) => void;
  onBackgroundSubagentsOpenChange: (open: boolean) => void;
  onQueuedOpenChange: (open: boolean) => void;
  onDeleteQueuedTurn: (queuedTurnId: string) => void;
  onEditQueuedTurn: (queuedTurnId: string) => void;
}

const MAX_VISIBLE_TASK_ROWS = 5;
const MAX_VISIBLE_BACKGROUND_SUBAGENTS = 3;
const MAX_VISIBLE_QUEUED = 4;

function buildQueuedMessagePreview(queuedTurn: QueuedTurnDraft): string {
  const strippedPrompt = stripInlineTerminalContextPlaceholders(
    queuedTurn.composerSnapshot.prompt,
  ).trim();
  if (strippedPrompt.length > 0) {
    return strippedPrompt;
  }
  const imageCount = queuedTurn.composerSnapshot.persistedAttachments.length;
  const terminalContextCount = queuedTurn.composerSnapshot.terminalContexts.length;
  if (imageCount > 0 || terminalContextCount > 0) {
    return "Attachments only";
  }
  return "Queued follow-up";
}

const ComposerQueuedRow = memo(function ComposerQueuedRow(props: {
  queuedTurn: QueuedTurnDraft;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
}) {
  const { queuedTurn } = props;
  const previewText = useMemo(() => buildQueuedMessagePreview(queuedTurn), [queuedTurn]);
  const isSending = queuedTurn.status === "sending";
  const isFailed = queuedTurn.status === "failed";
  const tooltipText = isFailed && queuedTurn.errorMessage ? queuedTurn.errorMessage : previewText;

  return (
    <div className="group/queued-row flex min-w-0 items-center gap-2.5 border-t border-border/35 px-4 py-2 first:border-t-0">
      <ArrowUpIcon
        aria-hidden
        className={cn(
          "size-3 shrink-0",
          isSending
            ? "animate-pulse text-foreground/70"
            : isFailed
              ? "text-amber-500"
              : "text-muted-foreground/60",
        )}
      />
      <p
        className={cn(
          "min-w-0 flex-1 truncate text-[12.5px] leading-snug",
          isFailed ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
        )}
        title={tooltipText}
      >
        {previewText}
      </p>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/queued-row:opacity-100 focus-within:opacity-100">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Delete queued message"
          disabled={isSending}
          onClick={() => props.onDelete(queuedTurn.id)}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Queued message actions"
                disabled={isSending}
              />
            }
          >
            <MoreHorizontalIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="bottom">
            <MenuItem onClick={() => props.onEdit(queuedTurn.id)}>
              <PencilIcon className="size-4" />
              Edit message
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
});

function isCompleteStatus(status: TaskListItemStatus): boolean {
  return status === "completed";
}

function statusTone(status: TaskListItemStatus): string {
  switch (status) {
    case "completed":
      return "text-emerald-500/90";
    case "inProgress":
      return "text-sky-500";
    case "failed":
    case "stopped":
      return "text-destructive";
    case "pending":
      return "text-muted-foreground/40";
  }
}

function statusLabel(status: TaskListItemStatus): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "inProgress":
      return "In progress";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    case "pending":
      return "Pending";
  }
}

const TaskStatusIcon = memo(function TaskStatusIcon(props: { status: TaskListItemStatus }) {
  const className = cn("size-[14px] shrink-0 [stroke-width:2.25]", statusTone(props.status));
  switch (props.status) {
    case "completed":
      return <CheckIcon className={className} aria-hidden="true" />;
    case "inProgress":
      return <LoaderCircleIcon className={cn(className, "animate-spin")} aria-hidden="true" />;
    case "failed":
    case "stopped":
      return <CircleSlashIcon className={className} aria-hidden="true" />;
    case "pending":
      return <CircleIcon className={className} aria-hidden="true" />;
  }
});

const ComposerTaskListRow = memo(function ComposerTaskListRow(props: { item: ActiveTaskListItem }) {
  const { item } = props;
  const active = item.status === "inProgress";
  const completed = item.status === "completed";
  return (
    <div
      className={cn(
        "group/task-row border-t border-border/35 px-4 py-2 first:border-t-0",
        completed && "opacity-55",
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          className="mt-[3px] inline-flex size-3 shrink-0 items-center justify-center"
          title={statusLabel(item.status)}
        >
          <TaskStatusIcon status={item.status} />
        </span>
        <div className="min-w-0 flex-1 leading-snug">
          <div
            className={cn(
              "truncate text-[12.5px] font-medium text-foreground",
              active && "shimmer shimmer-spread-200",
            )}
          >
            {item.title}
          </div>
          {item.detail ? (
            <div className="mt-px truncate text-[11.5px] text-muted-foreground/65">
              {item.detail}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});

const BACKGROUND_SUBAGENT_NAME_CLASSES = [
  "text-orange-500",
  "text-emerald-500",
  "text-sky-500",
  "text-fuchsia-500",
  "text-amber-500",
  "text-lime-500",
] as const;

function backgroundSubagentNameClass(index: number): string {
  return BACKGROUND_SUBAGENT_NAME_CLASSES[index % BACKGROUND_SUBAGENT_NAME_CLASSES.length]!;
}

const BackgroundSubagentRow = memo(function BackgroundSubagentRow(props: {
  row: CodexBackgroundSubagentRow;
  index: number;
}) {
  const { row, index } = props;
  const [expanded, setExpanded] = useState(false);
  const hasChildren = row.childEntries.length > 0;
  const statusText = row.status === "active" ? "working" : "waiting";

  return (
    <div className="border-t border-border/35 px-4 py-2 first:border-t-0">
      <button
        type={hasChildren ? "button" : undefined}
        className={cn(
          "flex w-full min-w-0 items-start gap-2.5 text-left",
          hasChildren && "cursor-pointer focus-visible:outline-none",
        )}
        onClick={hasChildren ? () => setExpanded((current) => !current) : undefined}
        aria-expanded={hasChildren ? expanded : undefined}
      >
        <div className="min-w-0 flex-1 leading-snug">
          <div className="truncate text-[12.5px] font-medium text-foreground">
            <span className={backgroundSubagentNameClass(index)}>{row.displayName}</span>
            {row.agentRole ? (
              <span className="font-normal text-muted-foreground/70"> ({row.agentRole})</span>
            ) : null}
            <span
              className={cn(
                "font-normal text-muted-foreground/80",
                row.status === "active" && "shimmer shimmer-spread-200",
              )}
            >
              {" "}
              {statusText}
            </span>
          </div>
          {row.instruction ? (
            <p className="mt-px truncate text-[11.5px] text-muted-foreground/65">
              {row.instruction}
            </p>
          ) : null}
          {!row.hasContents ? (
            <p className="mt-px truncate text-[11.5px] text-muted-foreground/50">No contents</p>
          ) : null}
        </div>
        {hasChildren ? (
          <span
            className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground/55"
            aria-hidden
          >
            {expanded ? (
              <ChevronUpIcon className="size-4" />
            ) : (
              <ChevronDownIcon className="size-4" />
            )}
          </span>
        ) : null}
      </button>
      {hasChildren ? (
        <AnimatedExpandPanel open={expanded}>
          <MaskedScrollViewport
            dependencyKey={row.childEntries.length}
            className="max-h-40 overflow-y-auto overscroll-contain pt-2"
          >
            {row.childEntries.map((entry) => (
              <MinimalWorkEntry key={entry.id} workEntry={entry} indented={false} />
            ))}
          </MaskedScrollViewport>
        </AnimatedExpandPanel>
      ) : null}
    </div>
  );
});

type SectionIcon = ComponentType<SVGProps<SVGSVGElement>>;

const ComposerContextSection = memo(function ComposerContextSection(props: {
  title: string;
  icon: SectionIcon;
  count?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const { title, icon: Icon, count, open, onOpenChange, children } = props;

  return (
    <div className="border-t border-border/40 first:border-t-0">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2.5 px-4 py-2.5 text-left focus-visible:outline-none"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="text-[12.5px] font-medium text-foreground/85">{title}</span>
          {count ? (
            <span className="text-[12px] font-normal tabular-nums text-muted-foreground/60">
              {count}
            </span>
          ) : null}
        </div>
        <span
          className="inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground/70"
          aria-hidden
        >
          {open ? <ChevronUpIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
        </span>
      </button>
      <AnimatedExpandPanel open={open}>
        <div className="pb-1">{children}</div>
      </AnimatedExpandPanel>
    </div>
  );
});

export const ComposerContextPanel = memo(function ComposerContextPanel(
  props: ComposerContextPanelProps,
) {
  const taskList = props.taskList && props.taskList.items.length > 0 ? props.taskList : null;
  const backgroundSubagents =
    props.backgroundSubagents.length > 0 ? props.backgroundSubagents : null;
  const queuedTurns = props.queuedTurns.length > 0 ? props.queuedTurns : null;

  if (!taskList && !backgroundSubagents && !queuedTurns) {
    return null;
  }

  const taskSummary = taskList
    ? (() => {
        const total = taskList.items.length;
        const completed = taskList.items.filter((item) => isCompleteStatus(item.status)).length;
        return { completed, total };
      })()
    : null;

  return (
    <div className="relative z-0">
      <div
        className={cn(
          "mx-auto w-[calc(100%-3rem)] max-w-[39rem] min-w-0 overflow-hidden rounded-t-[16px] rounded-b-none border border-b-0 border-border bg-card sm:w-[calc(100%-4rem)]",
        )}
        data-chat-composer-context-panel="true"
      >
        {queuedTurns ? (
          <ComposerContextSection
            title="Queued"
            icon={ClockIcon}
            count={String(queuedTurns.length)}
            open={props.queuedOpen}
            onOpenChange={props.onQueuedOpenChange}
          >
            <FadedListViewport
              scrollable={queuedTurns.length > MAX_VISIBLE_QUEUED}
              ariaLabel="Queued messages list"
            >
              {queuedTurns.map((queuedTurn) => (
                <ComposerQueuedRow
                  key={queuedTurn.id}
                  queuedTurn={queuedTurn}
                  onDelete={props.onDeleteQueuedTurn}
                  onEdit={props.onEditQueuedTurn}
                />
              ))}
            </FadedListViewport>
          </ComposerContextSection>
        ) : null}
        {taskList && taskSummary ? (
          <ComposerContextSection
            title="Tasks"
            icon={ListChecksIcon}
            count={`${taskSummary.completed}/${taskSummary.total}`}
            open={props.taskListOpen}
            onOpenChange={props.onTaskListOpenChange}
          >
            <FadedListViewport
              scrollable={taskList.items.length > MAX_VISIBLE_TASK_ROWS}
              ariaLabel="Tasks list"
            >
              {taskList.items.map((item) => (
                <ComposerTaskListRow key={item.id} item={item} />
              ))}
            </FadedListViewport>
          </ComposerContextSection>
        ) : null}
        {backgroundSubagents ? (
          <ComposerContextSection
            title="Background agents"
            icon={BotIcon}
            count={String(backgroundSubagents.length)}
            open={props.backgroundSubagentsOpen}
            onOpenChange={props.onBackgroundSubagentsOpenChange}
          >
            <FadedListViewport
              scrollable={backgroundSubagents.length > MAX_VISIBLE_BACKGROUND_SUBAGENTS}
              ariaLabel="Background agents list"
            >
              {backgroundSubagents.map((row, index) => (
                <BackgroundSubagentRow key={row.id} row={row} index={index} />
              ))}
            </FadedListViewport>
          </ComposerContextSection>
        ) : null}
      </div>
    </div>
  );
});
