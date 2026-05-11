import { type OrchestrationThreadActivity, type ProviderKind } from "contracts";
import {
  IconChevronDownOutline24 as ChevronDownIcon,
  IconChevronUpOutline24 as ChevronUpIcon,
} from "nucleo-core-outline-24";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { CHAT_THREAD_BODY_CLASS } from "../../chatTypography";
import { deriveWorkLogEntries, type WorkLogEntry } from "../../session-logic";
import { cn } from "~/lib/utils";
import { AnimatedExpandPanel } from "../ui/AnimatedExpandPanel";
import { MaskedScrollViewport } from "../ui/masked-scroll-viewport";
import { MinimalWorkEntry } from "./MessagesTimeline";
import { deriveBackgroundSubagentRows, type CodexBackgroundSubagentRow } from "./subagentDetail";

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

interface BackgroundSubagentsPanelProps {
  provider: ProviderKind;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const BackgroundSubagentRow = memo(function BackgroundSubagentRow(props: {
  row: CodexBackgroundSubagentRow;
  index: number;
}) {
  const { row, index } = props;
  const [expanded, setExpanded] = useState(false);
  const hasChildren = row.childEntries.length > 0;
  const statusLabel = row.status === "active" ? "is working" : "is awaiting instruction";
  const headingContent = (
    <>
      <span className="min-w-0 truncate">
        <span className={cn("font-medium", backgroundSubagentNameClass(index))}>
          {row.displayName}
        </span>
        {row.agentRole && <span className="text-foreground/50"> ({row.agentRole})</span>}
        <span
          className={cn(
            "text-foreground/60",
            row.status === "active" && "shimmer shimmer-spread-200",
          )}
        >
          {" "}
          {statusLabel}
        </span>
      </span>
      {hasChildren ? (
        <span
          data-testid={`background-subagent-row-chevron-${row.id}`}
          className="inline-flex size-4 shrink-0 translate-y-[1px] items-center justify-center rounded-sm text-foreground/35 opacity-0 transition-[opacity,color,transform] duration-150 group-hover:opacity-100 group-focus-within:opacity-100 group-hover:text-foreground group-focus-within:text-foreground"
        >
          <ChevronDownIcon
            className={cn("size-3 transition-transform duration-150", !expanded && "-rotate-90")}
            aria-hidden="true"
          />
        </span>
      ) : null}
    </>
  );

  return (
    <div
      className="group border-border/55 border-t first:border-t-0"
      data-background-subagent-row="true"
      data-testid={`background-subagent-row-${row.id}`}
    >
      <div className="px-3 py-2">
        <div className="min-w-0 flex-1">
          {hasChildren ? (
            <button
              type="button"
              data-background-subagent-row-toggle="true"
              data-testid={`background-subagent-row-toggle-${row.id}`}
              className={cn(
                CHAT_THREAD_BODY_CLASS,
                "flex w-full min-w-0 items-center gap-1 text-left text-foreground/70 transition-colors duration-150 hover:text-foreground focus-visible:text-foreground focus-visible:outline-none",
                !row.hasContents && "opacity-75",
              )}
              aria-expanded={expanded}
              onClick={() => {
                setExpanded((current) => !current);
              }}
            >
              {headingContent}
            </button>
          ) : (
            <div
              className={cn(
                CHAT_THREAD_BODY_CLASS,
                "flex min-w-0 items-center gap-1 text-left text-foreground/70",
                !row.hasContents && "opacity-75",
              )}
            >
              {headingContent}
            </div>
          )}
          {row.instruction && <p className="truncate text-foreground/45">{row.instruction}</p>}
          {!row.hasContents ? <p className="truncate text-foreground/35">No contents</p> : null}
        </div>
      </div>
      {hasChildren ? (
        <AnimatedExpandPanel open={expanded}>
          <MaskedScrollViewport
            dependencyKey={row.childEntries.length}
            data-background-subagent-activity-list="true"
            className="max-h-40 space-y-0.5 overflow-y-auto overscroll-contain px-3 pb-2 pr-2"
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

const MAX_VISIBLE_BACKGROUND_SUBAGENTS = 3;
const BACKGROUND_SUBAGENTS_MASK_FADE = "1.5rem";

export function BackgroundSubagentsPanel(props: BackgroundSubagentsPanelProps) {
  const workEntries = useMemo<WorkLogEntry[]>(
    () => deriveWorkLogEntries(props.activities, undefined),
    [props.activities],
  );
  const rows = useMemo(
    () =>
      deriveBackgroundSubagentRows({
        provider: props.provider,
        workEntries,
        activities: props.activities,
      }),
    [props.activities, props.provider, workEntries],
  );
  const [internalOpen, setInternalOpen] = useState(true);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const open = props.open ?? internalOpen;

  const needsScroll = rows.length > MAX_VISIBLE_BACKGROUND_SUBAGENTS;

  useLayoutEffect(() => {
    if (!open || !needsScroll) {
      setMaxHeight(undefined);
      return;
    }
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    const measure = () => {
      const children = Array.from(container.children) as HTMLElement[];
      if (children.length <= MAX_VISIBLE_BACKGROUND_SUBAGENTS) {
        setMaxHeight(undefined);
        return;
      }
      const firstTop = children[0]!.offsetTop;
      const lastVisible = children[MAX_VISIBLE_BACKGROUND_SUBAGENTS - 1]!;
      const height = lastVisible.offsetTop + lastVisible.offsetHeight - firstTop;
      setMaxHeight(height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [needsScroll, open, rows]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!open || !container || !needsScroll) {
      setAtTop(true);
      setAtBottom(true);
      return;
    }
    const update = () => {
      const { scrollTop, clientHeight, scrollHeight } = container;
      setAtTop(scrollTop <= 1);
      setAtBottom(scrollTop + clientHeight >= scrollHeight - 1);
    };
    update();
    container.addEventListener("scroll", update, { passive: true });
    return () => container.removeEventListener("scroll", update);
  }, [maxHeight, needsScroll, open, rows.length]);

  if (rows.length === 0) {
    return null;
  }

  const setOpen = (nextOpen: boolean) => {
    if (props.open === undefined) {
      setInternalOpen(nextOpen);
    }
    props.onOpenChange?.(nextOpen);
  };

  const scrollStyle: React.CSSProperties | undefined = needsScroll
    ? (() => {
        const style: React.CSSProperties = { maxHeight };
        if (!atTop || !atBottom) {
          const topStop = atTop ? "black 0" : `black ${BACKGROUND_SUBAGENTS_MASK_FADE}`;
          const bottomStop = atBottom
            ? "black 100%"
            : `black calc(100% - ${BACKGROUND_SUBAGENTS_MASK_FADE})`;
          const mask = `linear-gradient(to bottom, transparent 0, ${topStop}, ${bottomStop}, transparent 100%)`;
          style.maskImage = mask;
          style.WebkitMaskImage = mask;
        }
        return style;
      })()
    : undefined;

  return (
    <div
      className="relative z-0 mx-auto w-[calc(100%-1rem)] max-w-[41rem] min-w-0 sm:w-[calc(100%-2rem)]"
      data-chat-background-subagents-panel="true"
    >
      <div className="relative overflow-hidden rounded-t-[19px] border border-b-0 border-border/65 bg-muted/15 px-4 py-1.5 backdrop-blur-sm">
        <button
          type="button"
          className="group/bg-agents-header flex w-fit cursor-pointer items-center gap-1.5 py-1 text-xs font-semibold text-muted-foreground/80 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={open ? "Hide background agents" : "Show background agents"}
        >
          <span>Background agents</span>
          <span className="text-[11px] font-normal text-muted-foreground/55 tabular-nums">
            {rows.length}
          </span>
          <span
            className={cn(
              "flex size-4 items-center justify-center transition-opacity",
              open
                ? "opacity-0 group-hover/bg-agents-header:opacity-100 group-focus-visible/bg-agents-header:opacity-100"
                : "opacity-100",
            )}
            aria-hidden
          >
            {open ? (
              <ChevronUpIcon className="size-3.5" />
            ) : (
              <ChevronDownIcon className="size-3.5" />
            )}
          </span>
        </button>
        <AnimatedExpandPanel open={open}>
          <div
            ref={scrollContainerRef}
            className={cn(
              needsScroll &&
                "overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            )}
            style={scrollStyle}
          >
            {rows.map((row, index) => (
              <BackgroundSubagentRow key={row.id} row={row} index={index} />
            ))}
          </div>
        </AnimatedExpandPanel>
      </div>
    </div>
  );
}
