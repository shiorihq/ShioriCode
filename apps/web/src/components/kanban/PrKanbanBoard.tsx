import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  type KanbanItem,
  type KanbanItemId,
  type KanbanItemStatus,
  type ProjectId,
  type ProviderKind,
} from "contracts";
import { KanbanIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { useStore } from "~/store";

import { KanbanCardBody } from "./KanbanCard";
import { KanbanColumn } from "./KanbanColumn";
import {
  dispatchKanbanCommand,
  keyBetween,
  newId,
  newSortKey,
  sortKanbanItems,
  STATUSES,
} from "./kanbanShared";
import { NewTaskDialog } from "./NewTaskDialog";
import { TaskDetailSheet } from "./TaskDetailSheet";

export type KanbanAgentFilter = "any" | "unassigned" | ProviderKind;

interface PrKanbanBoardProps {
  projectId: ProjectId | null;
  pullRequest?: {
    number: number;
    title: string;
    url: string;
  } | null;
  /** Optional controlled filter values. Default: no filter applied. */
  searchQuery?: string;
  agentFilter?: KanbanAgentFilter;
  blockedOnly?: boolean;
  /** Optional controlled composer state. If `onComposerOpenChange` is provided,
   * the board's internal new-task trigger is hidden — the parent owns the trigger. */
  composerOpen?: boolean;
  onComposerOpenChange?: (open: boolean) => void;
}

interface MoveOverride {
  status: KanbanItemStatus;
  sortKey: string;
}

const STATUS_SET = new Set<KanbanItemStatus>(STATUSES.map((entry) => entry.status));

const collisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) return pointerCollisions;
  return rectIntersection(args);
};

export function PrKanbanBoard({
  projectId,
  pullRequest,
  searchQuery = "",
  agentFilter = "any",
  blockedOnly = false,
  composerOpen: composerOpenProp,
  onComposerOpenChange,
}: PrKanbanBoardProps) {
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const kanbanItems = useStore((store) => store.kanbanItems ?? []);
  const projects = useStore((store) => store.projects);
  const projectOptions = useMemo(
    () => projects.map((project) => ({ id: project.id, name: project.name })),
    [projects],
  );

  const composerControlled = onComposerOpenChange !== undefined;
  const [internalComposerOpen, setInternalComposerOpen] = useState(false);
  const composerOpen = composerControlled ? (composerOpenProp ?? false) : internalComposerOpen;
  const setComposerOpen = useCallback(
    (open: boolean) => {
      if (composerControlled) {
        onComposerOpenChange?.(open);
      } else {
        setInternalComposerOpen(open);
      }
    },
    [composerControlled, onComposerOpenChange],
  );

  const [composerTitle, setComposerTitle] = useState("");
  const [composerDescription, setComposerDescription] = useState("");
  const [composerPrompt, setComposerPrompt] = useState("");
  const [composerProjectId, setComposerProjectId] = useState<ProjectId | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<KanbanItemId | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [overrides, setOverrides] = useState<ReadonlyMap<KanbanItemId, MoveOverride>>(new Map());
  const [activeDragId, setActiveDragId] = useState<KanbanItemId | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const itemsWithOverrides = useMemo(() => {
    if (overrides.size === 0) return kanbanItems;
    return kanbanItems.map((item) => {
      const override = overrides.get(item.id);
      if (!override) return item;
      return { ...item, status: override.status, sortKey: override.sortKey };
    });
  }, [kanbanItems, overrides]);

  useEffect(() => {
    if (overrides.size === 0) return;
    let changed = false;
    const next = new Map(overrides);
    for (const [itemId, override] of overrides) {
      const item = kanbanItems.find((entry) => entry.id === itemId);
      if (!item) {
        next.delete(itemId);
        changed = true;
      } else if (item.status === override.status && item.sortKey === override.sortKey) {
        next.delete(itemId);
        changed = true;
      }
    }
    if (changed) setOverrides(next);
  }, [kanbanItems, overrides]);

  const linkedItems = useMemo(
    () =>
      sortKanbanItems(
        itemsWithOverrides.filter(
          (item) =>
            (projectId === null || item.projectId === projectId) &&
            item.deletedAt === null &&
            (pullRequest ? item.pullRequest?.number === pullRequest.number : true),
        ),
      ),
    [itemsWithOverrides, projectId, pullRequest],
  );

  const filteredItems = useMemo(() => {
    const trimmed = searchQuery.trim().toLowerCase();
    return linkedItems.filter((item) => {
      if (blockedOnly && !item.blockedReason) return false;
      if (agentFilter === "unassigned") {
        if (item.assignees.length > 0) return false;
      } else if (agentFilter !== "any") {
        if (!item.assignees.some((assignee) => assignee.provider === agentFilter)) {
          return false;
        }
      }
      if (trimmed.length > 0) {
        const haystack = `${item.title} ${item.description}`.toLowerCase();
        if (!haystack.includes(trimmed)) return false;
      }
      return true;
    });
  }, [agentFilter, blockedOnly, linkedItems, searchQuery]);

  const itemsByStatus = useMemo(() => {
    const byStatus = new Map<KanbanItemStatus, KanbanItem[]>(
      STATUSES.map((entry) => [entry.status, []]),
    );
    for (const item of filteredItems) {
      byStatus.get(item.status)?.push(item);
    }
    return byStatus;
  }, [filteredItems]);

  const selectedItem =
    (selectedItemId !== null
      ? itemsWithOverrides.find((item) => item.id === selectedItemId)
      : null) ?? null;

  const resetComposer = useCallback(() => {
    setComposerTitle("");
    setComposerDescription("");
    setComposerPrompt("");
    setComposerOpen(false);
  }, [setComposerOpen]);

  // Initialize the composer's project selection whenever the dialog opens.
  useEffect(() => {
    if (!composerOpen) return;
    setComposerProjectId(
      (prev) => prev ?? projectId ?? (projects[0]?.id as ProjectId | undefined) ?? null,
    );
  }, [composerOpen, projectId, projects]);

  const openComposer = useCallback(() => {
    setComposerOpen(true);
  }, [setComposerOpen]);

  const createTask = useCallback(() => {
    if (!composerProjectId || composerTitle.trim().length === 0) return;
    const now = new Date().toISOString();
    setIsCreating(true);
    void dispatchKanbanCommand({
      type: "kanbanItem.create",
      commandId: newId("cmd") as never,
      itemId: newId("kanban_item") as never,
      projectId: composerProjectId,
      pullRequest: pullRequest
        ? {
            number: pullRequest.number,
            title: pullRequest.title,
            url: pullRequest.url,
          }
        : null,
      title: composerTitle.trim(),
      description: composerDescription.trim(),
      prompt: composerPrompt.trim(),
      status: "backlog",
      sortKey: newSortKey(),
      createdAt: now,
    }).finally(() => {
      setIsCreating(false);
      resetComposer();
    });
  }, [
    composerDescription,
    composerProjectId,
    composerPrompt,
    composerTitle,
    pullRequest,
    resetComposer,
  ]);

  const quickAddProjectId =
    projectId ??
    (projects.length === 1 ? ((projects[0]?.id as ProjectId | undefined) ?? null) : null);

  const handleQuickAdd = useCallback(
    (status: KanbanItemStatus, title: string) => {
      if (!quickAddProjectId) return;
      const now = new Date().toISOString();
      void dispatchKanbanCommand({
        type: "kanbanItem.create",
        commandId: newId("cmd") as never,
        itemId: newId("kanban_item") as never,
        projectId: quickAddProjectId,
        pullRequest: pullRequest
          ? {
              number: pullRequest.number,
              title: pullRequest.title,
              url: pullRequest.url,
            }
          : null,
        title,
        description: "",
        status,
        sortKey: newSortKey(),
        createdAt: now,
      });
    },
    [pullRequest, quickAddProjectId],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id) as KanbanItemId);
  }, []);

  const handleDragCancel = useCallback(() => {
    setActiveDragId(null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const activeId = String(event.active.id) as KanbanItemId;
      const overId = event.over ? String(event.over.id) : null;
      if (!overId || activeId === overId) return;
      const activeItem = linkedItems.find((item) => item.id === activeId);
      if (!activeItem) return;

      let targetStatus: KanbanItemStatus;
      let targetSortKey: string;

      if (STATUS_SET.has(overId as KanbanItemStatus)) {
        targetStatus = overId as KanbanItemStatus;
        const columnItems = linkedItems.filter(
          (item) => item.status === targetStatus && item.id !== activeId,
        );
        const last = columnItems[columnItems.length - 1];
        targetSortKey = last ? keyBetween(last.sortKey, null) : newSortKey();
      } else {
        const overItem = linkedItems.find((item) => item.id === overId);
        if (!overItem) return;
        targetStatus = overItem.status;
        const columnItems = linkedItems.filter((item) => item.status === targetStatus);
        const overIndex = columnItems.findIndex((item) => item.id === overId);
        if (overIndex < 0) return;

        const sameColumn = activeItem.status === targetStatus;
        const activeIndex = sameColumn ? columnItems.findIndex((item) => item.id === activeId) : -1;
        const insertAfter = sameColumn && activeIndex >= 0 && activeIndex < overIndex;

        if (insertAfter) {
          // Skip the active item when picking the upper bound.
          let nextItem = columnItems[overIndex + 1];
          if (nextItem && nextItem.id === activeId) nextItem = columnItems[overIndex + 2];
          targetSortKey = keyBetween(overItem.sortKey, nextItem?.sortKey ?? null);
        } else {
          let prevItem = overIndex > 0 ? columnItems[overIndex - 1] : undefined;
          if (prevItem && prevItem.id === activeId) {
            prevItem = overIndex >= 2 ? columnItems[overIndex - 2] : undefined;
          }
          targetSortKey = keyBetween(prevItem?.sortKey ?? null, overItem.sortKey);
        }
      }

      if (targetStatus === activeItem.status && targetSortKey === activeItem.sortKey) return;

      const now = new Date().toISOString();
      setOverrides((prev) => {
        const next = new Map(prev);
        next.set(activeId, { status: targetStatus, sortKey: targetSortKey });
        return next;
      });
      void dispatchKanbanCommand({
        type: "kanbanItem.move",
        commandId: newId("cmd") as never,
        itemId: activeItem.id,
        status: targetStatus,
        sortKey: targetSortKey,
        movedAt: now,
      });
    },
    [linkedItems],
  );

  const isEmpty = linkedItems.length === 0;
  const isFilterEmpty = !isEmpty && filteredItems.length === 0;
  const canCreate = projects.length > 0;
  const isLoading = !bootstrapComplete;
  const draggingItem =
    activeDragId !== null
      ? (itemsWithOverrides.find((item) => item.id === activeDragId) ?? null)
      : null;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-gradient-to-b from-background via-background to-muted/[0.12]">
      <NewTaskDialog
        open={composerOpen}
        onOpenChange={(next) => {
          if (!next) {
            resetComposer();
          } else {
            openComposer();
          }
        }}
        title={composerTitle}
        description={composerDescription}
        prompt={composerPrompt}
        projectId={composerProjectId}
        projects={projectOptions}
        projectLocked={pullRequest !== null && pullRequest !== undefined}
        onProjectIdChange={setComposerProjectId}
        onTitleChange={setComposerTitle}
        onDescriptionChange={setComposerDescription}
        onPromptChange={setComposerPrompt}
        onSubmit={createTask}
        isCreating={isCreating}
      />

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" aria-hidden />
            <span>Loading board…</span>
          </div>
        </div>
      ) : isEmpty ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <KanbanIcon />
              </EmptyMedia>
              <EmptyTitle className="text-balance">No tasks yet</EmptyTitle>
              <EmptyDescription className="text-pretty">
                {pullRequest
                  ? "Create a task to plan work for this pull request."
                  : "Create your first task to start tracking work on this board."}
              </EmptyDescription>
            </EmptyHeader>
            <Button type="button" size="sm" disabled={!canCreate} onClick={openComposer}>
              <PlusIcon className="size-3.5" aria-hidden />
              New task
            </Button>
          </Empty>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          onDragStart={handleDragStart}
          onDragCancel={handleDragCancel}
          onDragEnd={handleDragEnd}
        >
          {isFilterEmpty ? (
            <div className="flex items-center justify-center px-4 py-2">
              <p className="text-[12px] text-muted-foreground/65">
                No tasks match the current filters.
              </p>
            </div>
          ) : null}
          <div className="grid min-h-0 flex-1 auto-cols-[minmax(16rem,1fr)] grid-flow-col grid-cols-[repeat(4,minmax(16rem,1fr))] gap-3 overflow-x-auto p-4">
            {STATUSES.map((column) => {
              const items = itemsByStatus.get(column.status) ?? [];
              return (
                <KanbanColumn
                  key={column.status}
                  status={column.status}
                  items={items}
                  selectedItemId={selectedItemId}
                  onSelectItem={setSelectedItemId}
                  onQuickAdd={
                    quickAddProjectId ? (title) => handleQuickAdd(column.status, title) : null
                  }
                />
              );
            })}
          </div>
          {typeof document !== "undefined"
            ? createPortal(
                <DragOverlay
                  dropAnimation={{
                    duration: 180,
                    easing: "cubic-bezier(0.19, 1, 0.22, 1)",
                  }}
                >
                  {draggingItem ? (
                    <div
                      className="rotate-[-1.4deg] cursor-grabbing"
                      style={{
                        boxShadow:
                          "0 18px 32px -16px rgba(0,0,0,0.35), 0 4px 10px -4px rgba(0,0,0,0.25)",
                      }}
                    >
                      <KanbanCardBody item={draggingItem} />
                    </div>
                  ) : null}
                </DragOverlay>,
                document.body,
              )
            : null}
        </DndContext>
      )}

      <TaskDetailSheet
        item={selectedItem}
        onOpenChange={(open) => {
          if (!open) setSelectedItemId(null);
        }}
      />
    </div>
  );
}
