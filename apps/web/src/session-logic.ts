export * from "shared/orchestrationSession";

export type TaskListItemStatus = "pending" | "inProgress" | "completed" | "failed" | "stopped";

export interface ActiveTaskListItem {
  id: string;
  title: string;
  status: TaskListItemStatus;
  detail?: string;
  source?: string;
}

export interface ActiveTaskListState {
  createdAt: string;
  turnId: string | null;
  source: string;
  items: ReadonlyArray<ActiveTaskListItem>;
}
