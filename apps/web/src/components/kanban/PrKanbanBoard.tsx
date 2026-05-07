import { closestCorners, DndContext, type DragEndEvent } from "@dnd-kit/core";
import {
  type KanbanItem,
  type KanbanItemId,
  type KanbanItemStatus,
  type ProjectId,
  type ProviderKind,
} from "contracts";
import { KanbanIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Button } from "~/components/ui/button";
import { useStore } from "~/store";

import { KanbanColumn } from "./KanbanColumn";
import { NewTaskDialog } from "./NewTaskDialog";
import { TaskDetailSheet } from "./TaskDetailSheet";
import {
  dispatchKanbanCommand,
  newId,
  newSortKey,
  sortKanbanItems,
  STATUSES,
} from "./kanbanShared";

export type KanbanAgentFilter = "any" | "unassigned" | ProviderKind;

interface PrKanbanBoardProps {
  projectId: ProjectId | null;
  pullRequest: KanbanItem["pullRequest"] | null;
  searchQuery?: string;
  agentFilter?: KanbanAgentFilter;
  blockedOnly?: boolean;
  composerOpen?: boolean;
  onComposerOpenChange?: (open: boolean) => void;
}

export function PrKanbanBoard({
  projectId,
  pullRequest,
  searchQuery = "",
  agentFilter = "any",
  blockedOnly = false,
  composerOpen,
  onComposerOpenChange,
}: PrKanbanBoardProps) {
  const projects = useStore((state) => state.projects);
  const items = useStore((state) => state.kanbanItems ?? []);
  const bootstrapComplete = useStore((state) => state.bootstrapComplete);
  const [selectedItemId, setSelectedItemId] = useState<KanbanItemId | null>(null);
  const [internalComposerOpen, setInternalComposerOpen] = useState(false);
  const [draftProjectId, setDraftProjectId] = useState<ProjectId | null>(projectId);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftPrompt, setDraftPrompt] = useState("");

  const newTaskOpen = composerOpen ?? internalComposerOpen;
  const setNewTaskOpen = onComposerOpenChange ?? setInternalComposerOpen;

  useEffect(() => {
    setDraftProjectId(projectId ?? (projects[0]?.id as ProjectId | undefined) ?? null);
  }, [projectId, projects]);

  const filteredItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return sortKanbanItems(
      items.filter((item) => {
        if (item.deletedAt !== null) return false;
        if (projectId && item.projectId !== projectId) return false;
        if (pullRequest) {
          if (!item.pullRequest) return false;
          if (item.pullRequest.url !== pullRequest.url) return false;
        }
        if (blockedOnly && !item.blockedReason) return false;
        if (agentFilter === "unassigned" && item.assignees.length > 0) return false;
        if (
          agentFilter !== "any" &&
          agentFilter !== "unassigned" &&
          !item.assignees.some((assignee) => assignee.provider === agentFilter)
        ) {
          return false;
        }
        if (!query) return true;
        const searchable = `${item.title}\n${item.description}\n${item.prompt}`.toLowerCase();
        return searchable.includes(query);
      }),
    );
  }, [agentFilter, blockedOnly, items, projectId, pullRequest, searchQuery]);

  const itemsByStatus = useMemo(() => {
    const grouped = new Map<KanbanItemStatus, KanbanItem[]>();
    for (const { status } of STATUSES) {
      grouped.set(status, []);
    }
    for (const item of filteredItems) {
      grouped.get(item.status)?.push(item);
    }
    return grouped;
  }, [filteredItems]);

  const selectedItem = selectedItemId
    ? (items.find((item) => item.id === selectedItemId && item.deletedAt === null) ?? null)
    : null;

  useEffect(() => {
    if (!selectedItemId) return;
    if (!filteredItems.some((item) => item.id === selectedItemId)) {
      setSelectedItemId(null);
    }
  }, [filteredItems, selectedItemId]);

  const createTask = useCallback(
    (input: {
      title: string;
      description?: string;
      prompt?: string;
      status?: KanbanItemStatus;
      projectId?: ProjectId | null;
    }) => {
      const targetProjectId = input.projectId ?? projectId ?? draftProjectId;
      if (!targetProjectId) return;
      const now = new Date().toISOString();
      void dispatchKanbanCommand({
        type: "kanbanItem.create",
        commandId: newId("cmd") as never,
        itemId: newId("kanban_item") as never,
        projectId: targetProjectId,
        pullRequest,
        title: input.title.trim(),
        description: input.description?.trim() ?? "",
        prompt: input.prompt?.trim() ?? "",
        status: input.status ?? "backlog",
        sortKey: newSortKey(),
        createdAt: now,
      });
    },
    [draftProjectId, projectId, pullRequest],
  );

  const submitDialog = useCallback(() => {
    if (draftTitle.trim().length === 0) return;
    createTask({
      title: draftTitle,
      description: draftDescription,
      prompt: draftPrompt,
      projectId: draftProjectId,
    });
    setDraftTitle("");
    setDraftDescription("");
    setDraftPrompt("");
    setNewTaskOpen(false);
  }, [createTask, draftDescription, draftProjectId, draftPrompt, draftTitle, setNewTaskOpen]);

  const moveItem = useCallback((itemId: KanbanItemId, status: KanbanItemStatus) => {
    const now = new Date().toISOString();
    void dispatchKanbanCommand({
      type: "kanbanItem.move",
      commandId: newId("cmd") as never,
      itemId,
      status,
      sortKey: newSortKey(),
      movedAt: now,
    });
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeId = String(event.active.id) as KanbanItemId;
      const overId = event.over?.id ? String(event.over.id) : null;
      if (!overId) return;
      const draggedItem = filteredItems.find((item) => item.id === activeId);
      if (!draggedItem) return;
      const statusFromColumn = STATUSES.find((entry) => entry.status === overId)?.status ?? null;
      const statusFromCard =
        filteredItems.find((item) => String(item.id) === overId)?.status ?? null;
      const nextStatus = statusFromColumn ?? statusFromCard;
      if (!nextStatus || nextStatus === draggedItem.status) return;
      moveItem(activeId, nextStatus);
    },
    [filteredItems, moveItem],
  );

  if (!bootstrapComplete) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6 text-sm text-muted-foreground">
        Loading board…
      </div>
    );
  }

  const hasAnyItems = filteredItems.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {hasAnyItems ? (
        <DndContext collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
          <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-3">
            {STATUSES.map(({ status }) => (
              <KanbanColumn
                key={status}
                status={status}
                items={itemsByStatus.get(status) ?? []}
                selectedItemId={selectedItemId}
                onSelectItem={setSelectedItemId}
                onQuickAdd={
                  projectId || draftProjectId
                    ? (title) =>
                        createTask({ title, status, projectId: projectId ?? draftProjectId })
                    : null
                }
              />
            ))}
          </div>
        </DndContext>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <KanbanIcon />
              </EmptyMedia>
              <EmptyTitle>No tasks yet</EmptyTitle>
              <EmptyDescription className="text-pretty">
                Create a task to start planning work for this board.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                type="button"
                size="sm"
                onClick={() => setNewTaskOpen(true)}
                disabled={projects.length === 0}
              >
                <PlusIcon className="size-3.5" aria-hidden />
                New task
              </Button>
            </EmptyContent>
          </Empty>
        </div>
      )}

      <NewTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        title={draftTitle}
        description={draftDescription}
        prompt={draftPrompt}
        projectId={draftProjectId}
        projects={projects.map((project) => ({ id: project.id, name: project.name }))}
        projectLocked={projectId !== null || pullRequest !== null}
        onTitleChange={setDraftTitle}
        onDescriptionChange={setDraftDescription}
        onPromptChange={setDraftPrompt}
        onProjectIdChange={setDraftProjectId}
        onSubmit={submitDialog}
        isCreating={false}
      />
      <TaskDetailSheet
        item={selectedItem}
        onOpenChange={(open) => !open && setSelectedItemId(null)}
      />
    </div>
  );
}
