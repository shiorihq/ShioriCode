import {
  IconArrowUpOutline24 as ArrowUpIcon,
  IconChevronDownOutline24 as ChevronDownIcon,
  IconChevronUpOutline24 as ChevronUpIcon,
  IconDotsOutline24 as MoreHorizontalIcon,
  IconPencilOutline24 as PencilIcon,
  IconTrash2Outline24 as Trash2Icon,
} from "nucleo-core-outline-24";
import { useEffect, useMemo, useRef, useState } from "react";
import { stripInlineTerminalContextPlaceholders } from "../../lib/terminalContext";
import { cn } from "../../lib/utils";
import { type QueuedTurnDraft } from "../../queuedTurnsStore";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

interface QueuedMessagesPanelProps {
  queuedTurns: ReadonlyArray<QueuedTurnDraft>;
  onDeleteQueuedTurn: (queuedTurnId: string) => void;
  onEditQueuedTurn: (queuedTurnId: string) => void;
}

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

function QueuedMessageRow({
  queuedTurn,
  onDeleteQueuedTurn,
  onEditQueuedTurn,
}: {
  queuedTurn: QueuedTurnDraft;
  onDeleteQueuedTurn: (queuedTurnId: string) => void;
  onEditQueuedTurn: (queuedTurnId: string) => void;
}) {
  const previewText = useMemo(() => buildQueuedMessagePreview(queuedTurn), [queuedTurn]);
  const isSending = queuedTurn.status === "sending";
  const isFailed = queuedTurn.status === "failed";
  const tooltipText = isFailed && queuedTurn.errorMessage ? queuedTurn.errorMessage : previewText;

  return (
    <div className="group flex min-w-0 items-center justify-between gap-2 py-0.5 text-sm">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <ArrowUpIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0",
            isSending
              ? "animate-pulse text-foreground/70"
              : isFailed
                ? "text-amber-500"
                : "text-muted-foreground/55",
          )}
        />
        <p
          className={cn(
            "min-w-0 flex-1 truncate leading-snug",
            isFailed ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
          )}
          title={tooltipText}
        >
          {previewText}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Delete queued message"
          disabled={isSending}
          onClick={() => onDeleteQueuedTurn(queuedTurn.id)}
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
            <MenuItem onClick={() => onEditQueuedTurn(queuedTurn.id)}>
              <PencilIcon className="size-4" />
              Edit message
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

export function QueuedMessagesPanel({
  queuedTurns,
  onDeleteQueuedTurn,
  onEditQueuedTurn,
}: QueuedMessagesPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [fadeTop, setFadeTop] = useState(false);
  const [fadeBottom, setFadeBottom] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || isCollapsed) return;
    const update = () => {
      const canScrollUp = el.scrollTop > 1;
      const canScrollDown = el.scrollHeight - el.clientHeight - el.scrollTop > 1;
      setFadeTop(canScrollUp);
      setFadeBottom(canScrollDown);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, [queuedTurns.length, isCollapsed]);

  if (queuedTurns.length === 0) {
    return null;
  }

  const count = queuedTurns.length;

  return (
    <div className="rounded-t-[19px] border-b border-border/65 bg-muted/15 px-4 py-1.5 backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setIsCollapsed((prev) => !prev)}
        aria-expanded={!isCollapsed}
        aria-label={isCollapsed ? "Show queued messages" : "Hide queued messages"}
        className="group/queue-header flex w-fit cursor-pointer items-center gap-1.5 py-1 text-xs font-semibold text-muted-foreground/80 transition-colors hover:text-foreground"
      >
        <span>Queued</span>
        <span className="text-[11px] font-normal text-muted-foreground/55 tabular-nums">
          {count}
        </span>
        <span
          className={cn(
            "flex size-4 items-center justify-center transition-opacity",
            isCollapsed
              ? "opacity-100"
              : "opacity-0 group-hover/queue-header:opacity-100 group-focus-visible/queue-header:opacity-100",
          )}
          aria-hidden
        >
          {isCollapsed ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronUpIcon className="size-3.5" />
          )}
        </span>
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
          isCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
        )}
        aria-hidden={isCollapsed}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            ref={scrollRef}
            data-fade-top={fadeTop || undefined}
            data-fade-bottom={fadeBottom || undefined}
            className="queue-scroll flex max-h-[6rem] flex-col gap-px overflow-y-auto"
          >
            {queuedTurns.map((queuedTurn) => (
              <QueuedMessageRow
                key={queuedTurn.id}
                queuedTurn={queuedTurn}
                onDeleteQueuedTurn={onDeleteQueuedTurn}
                onEditQueuedTurn={onEditQueuedTurn}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
