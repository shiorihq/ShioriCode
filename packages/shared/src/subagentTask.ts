import type { ToolLifecycleItemType } from "contracts";

/**
 * Canonical tool-lifecycle item type for delegated ("subagent") work.
 *
 * Codex/ACP providers emit subagent activity as `item.*` lifecycle events that
 * already carry this item type. Providers that instead report subagent progress
 * through `task.*` runtime events (Claude's `task_started` / `task_progress` /
 * `task_notification` SDK messages) are projected with the same item type so a
 * single rendering pipeline handles both.
 */
export const SUBAGENT_TASK_ITEM_TYPE = "collab_agent_tool_call" satisfies ToolLifecycleItemType;

/**
 * Stable synthetic item id for a `task.*` lifecycle chain.
 *
 * Task lifecycle events have no provider item id of their own, so the task id is
 * namespaced to keep started -> progress -> completed collapsible into a single
 * work log entry without colliding with real provider item ids.
 */
export function subagentTaskItemId(taskId: string): string {
  return `task:${taskId}`;
}
