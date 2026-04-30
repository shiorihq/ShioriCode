import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { type KanbanItem, type KanbanItemId, type KanbanItemStatus } from "contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { SortableKanbanCard } from "./KanbanCard";
import { STATUS_THEME } from "./kanbanShared";

interface KanbanColumnProps {
  status: KanbanItemStatus;
  items: KanbanItem[];
  selectedItemId: KanbanItemId | null;
  onSelectItem: (itemId: KanbanItemId) => void;
  onQuickAdd: ((title: string) => void) | null;
}

export function KanbanColumn({
  status,
  items,
  selectedItemId,
  onSelectItem,
  onQuickAdd,
}: KanbanColumnProps) {
  const theme = STATUS_THEME[status];
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const [composerOpen, setComposerOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (composerOpen) {
      inputRef.current?.focus();
    }
  }, [composerOpen]);

  const submit = () => {
    const trimmed = draftTitle.trim();
    if (trimmed.length === 0 || !onQuickAdd) return;
    onQuickAdd(trimmed);
    setDraftTitle("");
    setComposerOpen(false);
  };

  return (
    <section
      ref={setNodeRef}
      data-status={status}
      data-over={isOver || undefined}
      className={cn(
        "group/column relative flex min-h-0 min-w-[16rem] flex-col rounded-xl border border-border/45 bg-muted/[0.18] transition-colors",
        "data-[over]:border-foreground/25",
        isOver && theme.hoverGlow,
      )}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/40 px-3">
        <span className={cn("size-1.5 shrink-0 rounded-full", theme.dot)} aria-hidden />
        <span className="text-[12px] font-semibold tracking-tight text-foreground/85">
          {theme.label}
        </span>
        <span className="ml-1 text-[11px] tabular-nums text-muted-foreground/55">
          {items.length}
        </span>
        {onQuickAdd ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`Add task to ${theme.label}`}
            className={cn(
              "ml-auto size-5 text-muted-foreground/50 opacity-0 transition-opacity hover:text-foreground",
              "group-hover/column:opacity-100 focus-visible:opacity-100",
              composerOpen && "opacity-100",
            )}
            onClick={() => setComposerOpen((value) => !value)}
          >
            {composerOpen ? (
              <XIcon className="size-3" aria-hidden />
            ) : (
              <PlusIcon className="size-3" aria-hidden />
            )}
          </Button>
        ) : null}
      </header>

      <SortableContext
        id={status}
        items={items.map((item) => item.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2 py-2">
          {items.length === 0 && !composerOpen ? (
            <div className="flex flex-1 items-center justify-center px-2 py-6 text-center text-[11.5px] text-muted-foreground/40">
              {isOver ? "Drop here" : "—"}
            </div>
          ) : (
            items.map((item) => (
              <SortableKanbanCard
                key={item.id}
                item={item}
                selected={selectedItemId === item.id}
                onSelect={onSelectItem}
              />
            ))
          )}
        </div>
      </SortableContext>

      {composerOpen && onQuickAdd ? (
        <div className="border-t border-border/40 bg-background/60 p-2">
          <textarea
            ref={inputRef}
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setComposerOpen(false);
                setDraftTitle("");
              }
            }}
            rows={2}
            placeholder={`New ${theme.label.toLowerCase()} task…`}
            className={cn(
              "w-full resize-none rounded-md border border-border/60 bg-background px-2 py-1.5 text-[12.5px] leading-snug text-foreground",
              "placeholder:text-muted-foreground/50 focus:border-foreground/30 focus:outline-none",
            )}
          />
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground/55">
              Enter to add · Esc to cancel
            </span>
            <Button
              type="button"
              size="xs"
              disabled={draftTitle.trim().length === 0}
              onClick={submit}
            >
              Add
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
