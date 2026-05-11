import {
  DEFAULT_RUNTIME_MODE,
  type ClientOrchestrationCommand,
  GoalItemCommandType,
  type GoalItem,
  type GoalItemAssigneeRole,
  type GoalItemId,
  type ModelSelection,
  type ProviderKind,
  type ThreadId,
} from "contracts";
import { derivePendingApprovals, derivePendingUserInputs } from "~/session-logic";
import { DEFAULT_INTERACTION_MODE, type Project, type Thread } from "~/types";
import { newCommandId, newMessageId, newThreadId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";

export type Goal = GoalItem;
export type GoalId = GoalItemId;
export type GoalAgentFilter = "any" | "unassigned" | ProviderKind;
export type GoalStatus = "draft" | "ready" | "running" | "needs_approval" | "blocked" | "completed";

export const GOAL_STATUS_ORDER: readonly GoalStatus[] = [
  "running",
  "needs_approval",
  "blocked",
  "ready",
  "draft",
  "completed",
];

export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  draft: "Draft",
  ready: "Ready",
  running: "Running",
  needs_approval: "Needs Approval",
  blocked: "Blocked",
  completed: "Completed",
};

export const GOAL_STATUS_THEME: Record<
  GoalStatus,
  {
    dot: string;
    text: string;
    surface: string;
    border: string;
  }
> = {
  draft: {
    dot: "bg-zinc-400",
    text: "text-muted-foreground",
    surface: "bg-muted/30",
    border: "border-border/55",
  },
  ready: {
    dot: "bg-sky-500",
    text: "text-sky-700 dark:text-sky-300",
    surface: "bg-sky-500/[0.07]",
    border: "border-sky-500/25",
  },
  running: {
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-300",
    surface: "bg-amber-500/[0.08]",
    border: "border-amber-500/30",
  },
  needs_approval: {
    dot: "bg-violet-500",
    text: "text-violet-700 dark:text-violet-300",
    surface: "bg-violet-500/[0.08]",
    border: "border-violet-500/30",
  },
  blocked: {
    dot: "bg-destructive",
    text: "text-destructive",
    surface: "bg-destructive/[0.07]",
    border: "border-destructive/30",
  },
  completed: {
    dot: "bg-emerald-500",
    text: "text-emerald-700 dark:text-emerald-300",
    surface: "bg-emerald-500/[0.08]",
    border: "border-emerald-500/25",
  },
};

export const PROVIDERS: ReadonlyArray<{ provider: ProviderKind; label: string }> = [
  { provider: "codex", label: "Codex" },
  { provider: "claudeAgent", label: "Claude" },
  { provider: "kimiCode", label: "Kimi" },
  { provider: "gemini", label: "Gemini" },
  { provider: "cursor", label: "Cursor" },
  { provider: "shiori", label: "Shiori" },
];

const ASSIGNEE_ROLE: GoalItemAssigneeRole = "owner";

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function newSortKey(): string {
  return `${Date.now().toString().padStart(13, "0")}_${crypto.randomUUID()}`;
}

export function providerLabel(provider: ProviderKind): string {
  return PROVIDERS.find((entry) => entry.provider === provider)?.label ?? provider;
}

export function sortGoals(goals: readonly Goal[]): Goal[] {
  return [...goals].toSorted(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.createdAt.localeCompare(left.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

export function planStepsFromMarkdown(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) =>
      line
        .replace(/^[-*•]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .trim(),
    )
    .filter((line) => line.length > 0);
}

export function markdownFromPlanSteps(steps: readonly string[]): string {
  return steps
    .map((step) => step.trim())
    .filter((step) => step.length > 0)
    .map((step) => `- ${step}`)
    .join("\n");
}

export function fallbackPlanForGoal(title: string): string {
  return markdownFromPlanSteps([
    `Clarify the current implementation related to ${title}`,
    "Identify the smallest reliable implementation path",
    "Make the scoped code changes",
    "Validate behavior with checks or focused tests",
    "Summarize changes, risks, and follow-up work",
  ]);
}

export function buildGoalRunPrompt(goal: Goal): string {
  const plan =
    goal.prompt.trim() || goal.generatedPrompt?.trim() || fallbackPlanForGoal(goal.title);
  const sections = [
    `Goal: ${goal.title}`,
    goal.description.trim().length > 0 ? `Description and constraints:\n${goal.description}` : null,
    `Plan:\n${plan}`,
    [
      "Execute this goal step by step.",
      "Keep changes scoped to the goal.",
      "Update progress as you learn new information.",
      "Ask for approval before risky changes.",
      "When finished, summarize what changed, validation performed, and remaining risks.",
    ].join("\n"),
  ].filter((section): section is string => section !== null);
  return sections.join("\n\n");
}

export function findGoalRunThread(goal: Goal, threads: readonly Thread[]): Thread | null {
  for (const assignee of goal.assignees.toReversed()) {
    if (!assignee.threadId) continue;
    const thread = threads.find((entry) => entry.id === assignee.threadId);
    if (thread && thread.archivedAt === null) {
      return thread;
    }
  }
  return null;
}

export function deriveGoalStatus(goal: Goal, threads: readonly Thread[]): GoalStatus {
  const runThread = findGoalRunThread(goal, threads);
  const orchestrationStatus = runThread?.session?.orchestrationStatus ?? null;
  const hasPendingInput =
    runThread &&
    runThread.session?.status === "running" &&
    (derivePendingApprovals(runThread.activities).length > 0 ||
      derivePendingUserInputs(runThread.activities).length > 0);

  if (goal.completedAt !== null || goal.status === "done") return "completed";
  if (
    goal.blockedReason ||
    orchestrationStatus === "error" ||
    runThread?.latestTurn?.state === "error"
  ) {
    return "blocked";
  }
  if (hasPendingInput) return "needs_approval";
  if (
    orchestrationStatus === "running" ||
    runThread?.session?.status === "running" ||
    runThread?.latestTurn?.state === "running" ||
    goal.status === "in_progress"
  ) {
    return "running";
  }
  if (planStepsFromMarkdown(goal.prompt).length > 0 || goal.generatedPrompt) return "ready";
  return "draft";
}

export function dispatchGoalCommand(command: ClientOrchestrationCommand) {
  const api = readNativeApi();
  if (!api) return Promise.resolve({ sequence: 0 });
  return api.orchestration.dispatchCommand(command).catch((error) => {
    console.warn("Failed to dispatch goal command.", error);
    return { sequence: 0 };
  });
}

export async function runGoal(input: {
  goal: Goal;
  project: Project;
  threads: readonly Thread[];
  fallbackModelSelection: ModelSelection | null;
}): Promise<ThreadId> {
  const api = readNativeApi();
  if (!api) {
    throw new Error("Native API is unavailable.");
  }

  const existingThread = findGoalRunThread(input.goal, input.threads);
  const modelSelection =
    existingThread?.modelSelection ??
    input.project.defaultModelSelection ??
    input.fallbackModelSelection;

  if (!modelSelection) {
    throw new Error("Select a default model for this project before running the goal.");
  }

  const now = new Date().toISOString();
  const threadId = existingThread?.id ?? newThreadId();

  if (!existingThread) {
    await api.orchestration.dispatchCommand({
      type: "thread.create",
      commandId: newCommandId(),
      threadId,
      projectId: input.goal.projectId,
      title: input.goal.title,
      modelSelection,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_INTERACTION_MODE,
      parentThreadId: null,
      branchSourceTurnId: null,
      branch: null,
      worktreePath: null,
      createdAt: now,
    });

    await api.orchestration.dispatchCommand({
      type: GoalItemCommandType.assign,
      commandId: newCommandId(),
      itemId: input.goal.id,
      assignee: {
        id: newId("goal_assignee") as never,
        provider: modelSelection.provider,
        model: modelSelection.model,
        role: ASSIGNEE_ROLE,
        status: "assigned",
        threadId,
        assignedAt: now,
        updatedAt: now,
      },
      createdAt: now,
    });
  }

  await api.orchestration.dispatchCommand({
    type: GoalItemCommandType.move,
    commandId: newCommandId(),
    itemId: input.goal.id,
    status: "in_progress",
    sortKey: input.goal.sortKey,
    movedAt: now,
  });

  await api.orchestration.dispatchCommand({
    type: "thread.turn.start",
    commandId: newCommandId(),
    threadId,
    message: {
      messageId: newMessageId(),
      role: "user",
      text: buildGoalRunPrompt(input.goal),
      attachments: [],
    },
    modelSelection,
    titleSeed: input.goal.title,
    runtimeMode: existingThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: existingThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
    createdAt: now,
  });

  return threadId;
}
