import type { KanbanItem, OrchestrationReadModel, ThreadId } from "contracts";

export function incompleteKanbanItemsAssignedToThread(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): ReadonlyArray<KanbanItem> {
  return (readModel.kanbanItems ?? []).filter(
    (item) =>
      item.deletedAt === null &&
      item.status !== "done" &&
      item.assignees.some(
        (assignee) => assignee.threadId !== null && String(assignee.threadId) === String(threadId),
      ),
  );
}

export const newGoalCompletionSortKey = () =>
  `${Date.now().toString().padStart(13, "0")}_${crypto.randomUUID()}`;
