import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { type KanbanItem, type KanbanItemId } from "contracts";
import {
  BotIcon,
  GitPullRequestIcon,
  Loader2Icon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";
import { useStore } from "~/store";

import { providerLabel } from "./kanbanShared";

interface KanbanCardBodyProps {
  item: KanbanItem;
  selected?: boolean;
  isDraggingOriginal?: boolean;
  className?: string;
  onClick?: () => void;
}

export function KanbanCardBody({
  item,
  selected = false,
  isDraggingOriginal = false,
  className,
  onClick,
}: KanbanCardBodyProps) {
  const sidebarThreadsById = useStore((state) => state.sidebarThreadsById);
  const showFooter =
    item.blockedReason ||
    item.assignees.length > 0 ||
    item.pullRequest ||
    item.promptStatus !== "idle";

  return (
    <div
      data-active={selected || undefined}
      data-dragging-original={isDraggingOriginal || undefined}
      className={cn(
        "group/card relative overflow-hidden rounded-[10px] border bg-card text-left",
        "border-border/55 shadow-[0_1px_0_rgba(0,0,0,0.02)] transition-all duration-150",
        "hover:border-foreground/20 hover:shadow-[0_2px_8px_-4px_rgba(0,0,0,0.1)]",
        "dark:hover:shadow-[0_4px_16px_-6px_rgba(0,0,0,0.5)]",
        "data-[active=true]:border-foreground/35 data-[active=true]:shadow-[0_2px_8px_-3px_rgba(0,0,0,0.15)]",
        "data-[dragging-original=true]:opacity-35 data-[dragging-original=true]:shadow-none",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick?.();
        }
      }}
    >
      <div className="flex min-w-0 flex-col gap-1.5 px-3 py-2.5">
        <p className="line-clamp-2 text-pretty text-[13px] font-medium leading-snug text-foreground">
          {item.title}
        </p>
        {item.description.trim().length > 0 ? (
          <p className="line-clamp-1 text-pretty text-[11.5px] leading-relaxed text-muted-foreground/80">
            {item.description}
          </p>
        ) : null}
        {showFooter ? (
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            {item.blockedReason ? (
              <span className="inline-flex h-[18px] items-center gap-1 rounded-[4px] border border-destructive/35 bg-destructive/8 px-1.5 text-[9.5px] font-medium uppercase tracking-[0.08em] text-destructive">
                <TriangleAlertIcon className="size-2.5" aria-hidden />
                Blocked
              </span>
            ) : null}
            {item.pullRequest ? (
              <span className="inline-flex h-[18px] items-center gap-1 rounded-[4px] border border-border/55 px-1.5 text-[10px] tabular-nums text-muted-foreground/85">
                <GitPullRequestIcon className="size-2.5" aria-hidden />#{item.pullRequest.number}
              </span>
            ) : null}
            {item.promptStatus === "generating" ? (
              <span className="inline-flex h-[18px] items-center gap-1 rounded-[4px] border border-border/55 px-1.5 text-[10px] font-medium text-muted-foreground/85">
                <Loader2Icon className="size-2.5 animate-spin" aria-hidden />
                Prompt
              </span>
            ) : item.promptStatus === "ready" ? (
              <span className="inline-flex h-[18px] items-center gap-1 rounded-[4px] border border-emerald-500/25 bg-emerald-500/10 px-1.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                <SparklesIcon className="size-2.5" aria-hidden />
                Prompt
              </span>
            ) : item.promptStatus === "failed" ? (
              <span className="inline-flex h-[18px] items-center gap-1 rounded-[4px] border border-destructive/30 bg-destructive/8 px-1.5 text-[10px] font-medium text-destructive">
                <TriangleAlertIcon className="size-2.5" aria-hidden />
                Prompt
              </span>
            ) : null}
            {item.assignees.map((assignee) => (
              <span
                key={assignee.id}
                className="inline-flex h-[18px] items-center gap-1 rounded-[4px] border border-border/55 px-1.5 text-[10px] font-medium tracking-[0.01em] text-muted-foreground/90"
              >
                <BotIcon className="size-2.5" aria-hidden />
                <span className="max-w-28 truncate">
                  {assignee.threadId
                    ? (sidebarThreadsById[String(assignee.threadId)]?.title ??
                      providerLabel(assignee.provider))
                    : providerLabel(assignee.provider)}
                </span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface SortableKanbanCardProps {
  item: KanbanItem;
  selected: boolean;
  onSelect: (itemId: KanbanItemId) => void;
}

export function SortableKanbanCard({ item, selected, onSelect }: SortableKanbanCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className="touch-none">
      <KanbanCardBody
        item={item}
        selected={selected}
        isDraggingOriginal={isDragging}
        className={cn(isDragging ? "cursor-grabbing" : "cursor-grab", "active:cursor-grabbing")}
        onClick={() => onSelect(item.id)}
      />
    </div>
  );
}
