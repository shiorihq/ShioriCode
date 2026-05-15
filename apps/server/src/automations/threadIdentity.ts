import type { OrchestrationThread } from "contracts";

export const AUTOMATION_THREAD_TAG = "automation";
const AUTOMATION_THREAD_ID_PREFIX = "automation-thread:";

export function isAutomationThread(thread: Pick<OrchestrationThread, "id" | "tag">): boolean {
  return thread.tag === AUTOMATION_THREAD_TAG || thread.id.startsWith(AUTOMATION_THREAD_ID_PREFIX);
}

export function hasActiveAutomationTurn(
  thread: Pick<OrchestrationThread, "latestTurn" | "session">,
): boolean {
  if (thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined) {
    return true;
  }

  return (
    thread.latestTurn !== null &&
    thread.latestTurn.startedAt !== null &&
    thread.latestTurn.completedAt === null
  );
}
