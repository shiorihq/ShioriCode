import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  MessageId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  type ProviderKind,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  type ThreadId,
  type TurnId,
} from "contracts";
import {
  classifyProviderToolRequestKind,
  extractStructuredProviderToolData,
  normalizeProviderToolName,
  summarizeProviderToolInvocation,
} from "./providerTool";

import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  Thread,
  ThreadSession,
  TurnDiffSummary,
} from "./orchestrationClientTypes";

export type ProviderPickerKind = ProviderKind;

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
}> = [
  { value: "shiori", label: "Shiori", available: true },
  { value: "kimiCode", label: "Kimi", available: true },
  { value: "gemini", label: "Gemini", available: true },
  { value: "cursor", label: "Cursor", available: true },
  { value: "codex", label: "Codex", available: true },
  { value: "claudeAgent", label: "Claude", available: true },
];

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  label: string;
  itemId?: string;
  parentItemId?: string;
  detail?: string;
  command?: string;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  running?: boolean;
  /** Structured output from a completed tool (e.g. directory listing). */
  output?: unknown;
}

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
  lifecycleStatus?: "inProgress" | "completed" | "failed" | "declined";
}

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: "command" | "file-read" | "file-change";
  createdAt: string;
  detail?: string;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface ReasoningEntry {
  id: string;
  createdAt: string;
  completedAt?: string;
  text: string;
  streaming: boolean;
  turnId: TurnId | null;
}

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

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
  turnId: TurnId | null;
  source: string;
  items: ReadonlyArray<ActiveTaskListItem>;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "reasoning";
      createdAt: string;
      reasoning: ReasoningEntry;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };

const orderedActivitiesCache = new WeakMap<
  ReadonlyArray<OrchestrationThreadActivity>,
  ReadonlyArray<OrchestrationThreadActivity>
>();

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

type LatestTurnTiming = Pick<OrchestrationLatestTurn, "turnId" | "startedAt" | "completedAt">;
type SessionActivityState = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;

export function isSessionActivelyRunningTurn(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!session || session.orchestrationStatus !== "running") return false;
  if (!latestTurn) return true;

  const activeTurnId = session.activeTurnId;
  if (activeTurnId === undefined) {
    return latestTurn.completedAt === null;
  }
  if (latestTurn.turnId !== activeTurnId) {
    return true;
  }
  return true;
}

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  return !isSessionActivelyRunningTurn(latestTurn, session);
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

function requestKindFromRequestType(requestType: unknown): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

function isStalePendingRequestFailureDetail(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("unknown pending user-input request")
  );
}

function getOrderedActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const cached = orderedActivitiesCache.get(activities);
  if (cached) {
    return cached;
  }

  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  orderedActivitiesCache.set(activities, ordered);
  return ordered;
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();
  const ordered = getOrderedActivities(activities);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    const requestKind =
      payload &&
      (payload.requestKind === "command" ||
        payload.requestKind === "file-read" ||
        payload.requestKind === "file-change")
        ? payload.requestKind
        : payload
          ? requestKindFromRequestType(payload.requestType)
          : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
      continue;
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      if (options.length === 0) {
        return null;
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();
  const ordered = getOrderedActivities(activities);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "user-input.requested" && requestId) {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActivePlanState | null {
  const ordered = getOrderedActivities(activities);
  const candidates = ordered.filter((activity) => {
    if (activity.kind !== "turn.plan.updated") {
      return false;
    }
    if (!latestTurnId) {
      return true;
    }
    return activity.turnId === latestTurnId;
  });
  const latest = candidates.at(-1);
  if (!latest) {
    return null;
  }
  const payload =
    latest.payload && typeof latest.payload === "object"
      ? (latest.payload as Record<string, unknown>)
      : null;
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps = rawPlan
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.step !== "string") {
        return null;
      }
      const status =
        record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
      return {
        step: record.step,
        status,
      };
    })
    .filter(
      (
        step,
      ): step is {
        step: string;
        status: "pending" | "inProgress" | "completed";
      } => step !== null,
    );
  if (steps.length === 0) {
    return null;
  }
  return {
    createdAt: latest.createdAt,
    turnId: latest.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    steps,
  };
}

function normalizeTaskListItemStatus(value: unknown): TaskListItemStatus {
  switch (value) {
    case "inProgress":
    case "in_progress":
      return "inProgress";
    case "completed":
    case "done":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "stopped":
    case "cancelled":
    case "canceled":
      return "stopped";
    case "pending":
    default:
      return "pending";
  }
}

export function deriveActiveTaskListState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActiveTaskListState | null {
  const ordered = getOrderedActivities(activities);
  const candidates = ordered.filter((activity) => {
    if (activity.kind !== "turn.tasks.updated") {
      return false;
    }
    if (!latestTurnId) {
      return true;
    }
    return activity.turnId === latestTurnId;
  });
  const latest = candidates.at(-1);
  if (!latest) {
    return null;
  }
  const payload =
    latest.payload && typeof latest.payload === "object"
      ? (latest.payload as Record<string, unknown>)
      : null;
  const rawItems = payload?.items;
  if (!Array.isArray(rawItems)) {
    return null;
  }
  const items = rawItems
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.title !== "string" || record.title.trim().length === 0) {
        return null;
      }
      const item: ActiveTaskListItem = {
        id:
          typeof record.id === "string" && record.id.trim().length > 0
            ? record.id
            : `${latest.id}:${index}`,
        title: record.title,
        status: normalizeTaskListItemStatus(record.status),
      };
      if (typeof record.detail === "string" && record.detail.trim().length > 0) {
        item.detail = record.detail;
      }
      if (typeof record.source === "string" && record.source.trim().length > 0) {
        item.source = record.source;
      }
      return item;
    })
    .filter((item): item is ActiveTaskListItem => item !== null);
  if (items.length === 0) {
    return null;
  }
  return {
    createdAt: latest.createdAt,
    turnId: latest.turnId,
    source: typeof payload?.source === "string" ? payload.source : "tasks",
    items,
  };
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return toLatestProposedPlanState(matchingTurnPlan);
    }
  }

  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return null;
  }

  return toLatestProposedPlanState(latestPlan);
}

export function findSidebarProposedPlan(input: {
  threads: ReadonlyArray<Pick<Thread, "id" | "proposedPlans">>;
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "sourceProposedPlan"> | null;
  latestTurnSettled: boolean;
  threadId: ThreadId | string | null | undefined;
}): LatestProposedPlanState | null {
  const activeThreadPlans =
    input.threads.find((thread) => thread.id === input.threadId)?.proposedPlans ?? [];

  if (!input.latestTurnSettled) {
    const sourceProposedPlan = input.latestTurn?.sourceProposedPlan;
    if (sourceProposedPlan) {
      const sourcePlan = input.threads
        .find((thread) => thread.id === sourceProposedPlan.threadId)
        ?.proposedPlans.find((plan) => plan.id === sourceProposedPlan.planId);
      if (sourcePlan) {
        return toLatestProposedPlanState(sourcePlan);
      }
    }
  }

  return findLatestProposedPlan(activeThreadPlans, input.latestTurn?.turnId ?? null);
}

export function hasActionableProposedPlan(
  proposedPlan: LatestProposedPlanState | Pick<ProposedPlan, "implementedAt"> | null,
): boolean {
  return proposedPlan !== null && proposedPlan.implementedAt === null;
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): WorkLogEntry[] {
  const ordered = getOrderedActivities(activities);
  const entries = ordered
    .filter((activity) => (latestTurnId ? activity.turnId === latestTurnId : true))
    .filter((activity) => !isReasoningActivity(activity) && !isReasoningProgressActivity(activity))
    .filter((activity) => !isHiddenTaskLifecycleActivity(activity))
    .filter((activity) => activity.kind !== "context-window.updated")
    .filter((activity) => activity.summary !== "Checkpoint captured")
    .filter((activity) => activity.kind !== "runtime.warning")
    .filter((activity) => !isPlanBoundaryToolActivity(activity))
    .map(toDerivedWorkLogEntry);
  const collapsed = collapseDerivedWorkLogEntries(entries);
  const result: WorkLogEntry[] = [];
  for (const { activityKind, collapseKey: _collapseKey, lifecycleStatus, ...entry } of collapsed) {
    result.push({
      ...entry,
      running: isDerivedWorkLogEntryRunning(activityKind, lifecycleStatus),
    });
  }
  return result;
}

function isTaskLifecycleActivity(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.kind === "task.started" ||
    activity.kind === "task.progress" ||
    activity.kind === "task.completed"
  );
}

function isTaskLifecycleActivityKind(activityKind: OrchestrationThreadActivity["kind"]): boolean {
  return (
    activityKind === "task.started" ||
    activityKind === "task.progress" ||
    activityKind === "task.completed"
  );
}

function hasTaskParentItemId(activity: OrchestrationThreadActivity): boolean {
  if (!isTaskLifecycleActivity(activity)) {
    return false;
  }
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return asTrimmedString(payload?.parentItemId) !== null;
}

function isHiddenTaskLifecycleActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "task.started" && activity.kind !== "task.completed") {
    return false;
  }
  return !hasTaskParentItemId(activity);
}

function isDerivedWorkLogEntryRunning(
  activityKind: OrchestrationThreadActivity["kind"],
  lifecycleStatus: DerivedWorkLogEntry["lifecycleStatus"],
): boolean {
  if (activityKind === "tool.started") {
    return (
      lifecycleStatus !== "completed" &&
      lifecycleStatus !== "failed" &&
      lifecycleStatus !== "declined"
    );
  }
  if (activityKind === "task.started" || activityKind === "task.progress") {
    return (
      lifecycleStatus === "inProgress" ||
      (lifecycleStatus !== "completed" &&
        lifecycleStatus !== "failed" &&
        lifecycleStatus !== "declined")
    );
  }
  if (activityKind !== "tool.updated") {
    return false;
  }
  if (!lifecycleStatus) {
    return true;
  }
  return lifecycleStatus === "inProgress";
}

function isReasoningActivity(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.kind === "reasoning.started" ||
    activity.kind === "reasoning.delta" ||
    activity.kind === "reasoning.completed"
  );
}

function isReasoningProgressActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "task.progress") {
    return false;
  }

  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (payload?.displayAs === "reasoning") {
    return true;
  }

  // Backward compatibility for older persisted Codex activities before
  // `displayAs` was projected. Claude subagent task progress also used the
  // generic "Reasoning update" summary, but those task ids do not match the
  // canonical turn id.
  return (
    activity.summary === "Reasoning update" &&
    typeof payload?.taskId === "string" &&
    activity.turnId !== null &&
    payload.taskId === activity.turnId
  );
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:");
}

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const command = extractToolCommand(payload);
  const changedFiles = extractChangedFiles(payload);
  const lastToolName = asTrimmedString(payload?.lastToolName);
  const title = extractToolTitle(payload) ?? lastToolName;
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    label: activity.summary,
    tone: activity.tone === "approval" ? "info" : activity.tone,
    activityKind: activity.kind,
  };
  const parentItemId = asTrimmedString(payload?.parentItemId);
  const taskItemId = deriveTaskLifecycleWorkItemId(activity.kind, payload, parentItemId);
  const lifecycleStatus =
    normalizeToolLifecycleStatus(payload?.status) ??
    (taskItemId ? inferTaskLifecycleStatus(activity.kind) : undefined);
  const itemId = asTrimmedString(payload?.itemId) ?? taskItemId;
  if (itemId) {
    entry.itemId = itemId;
  }
  if (parentItemId) {
    entry.parentItemId = parentItemId;
  }
  if (lifecycleStatus) {
    entry.lifecycleStatus = lifecycleStatus;
  }
  const itemType = extractWorkLogItemType(payload);
  const requestKind =
    extractWorkLogRequestKind(payload) ??
    (lastToolName ? classifyProviderToolRequestKind(lastToolName) : undefined);
  if (payload && typeof payload.detail === "string" && payload.detail.length > 0) {
    const detail = stripTrailingExitCode(payload.detail).output;
    if (detail) {
      entry.detail = detail;
    }
  }
  if (
    (activity.kind === "runtime.warning" || activity.kind === "runtime.error") &&
    typeof payload?.message === "string" &&
    payload.message.length > 0
  ) {
    entry.detail = payload.message;
  }
  if (command) {
    entry.command = command;
  }
  if (changedFiles.length > 0) {
    entry.changedFiles = changedFiles;
  }
  if (title) {
    entry.toolTitle = title;
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  if (payload && payload.data !== undefined) {
    entry.output = payload.data;
  }
  const collapseKey = deriveToolLifecycleCollapseKey(entry);
  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }
  return entry;
}

function deriveTaskLifecycleWorkItemId(
  activityKind: OrchestrationThreadActivity["kind"],
  payload: Record<string, unknown> | null,
  parentItemId: string | null,
): string | null {
  if (!parentItemId || !isTaskLifecycleActivityKind(activityKind)) {
    return null;
  }
  const taskId = asTrimmedString(payload?.taskId);
  return taskId ? `task:${taskId}` : null;
}

function inferTaskLifecycleStatus(
  activityKind: OrchestrationThreadActivity["kind"],
): DerivedWorkLogEntry["lifecycleStatus"] | undefined {
  if (activityKind === "task.started" || activityKind === "task.progress") {
    return "inProgress";
  }
  if (activityKind === "task.completed") {
    return "completed";
  }
  return undefined;
}

function isCollapsibleLifecycleActivityKind(
  activityKind: OrchestrationThreadActivity["kind"],
): boolean {
  return (
    activityKind === "tool.started" ||
    activityKind === "tool.updated" ||
    activityKind === "tool.completed" ||
    isTaskLifecycleActivityKind(activityKind)
  );
}

function isLifecycleUpdateOrCompletionActivityKind(
  activityKind: OrchestrationThreadActivity["kind"],
): boolean {
  return (
    activityKind === "tool.updated" ||
    activityKind === "tool.completed" ||
    activityKind === "task.progress" ||
    activityKind === "task.completed"
  );
}

function isLifecycleCompletionActivityKind(
  activityKind: OrchestrationThreadActivity["kind"],
): boolean {
  return activityKind === "tool.completed" || activityKind === "task.completed";
}

function isTerminalLifecycleEntry(entry: DerivedWorkLogEntry): boolean {
  return (
    isLifecycleCompletionActivityKind(entry.activityKind) ||
    entry.lifecycleStatus === "completed" ||
    entry.lifecycleStatus === "failed" ||
    entry.lifecycleStatus === "declined"
  );
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  const openLifecycleIndexByItemId = new Map<string, number>();
  for (const entry of entries) {
    if (entry.itemId) {
      const openIndex = openLifecycleIndexByItemId.get(entry.itemId);
      if (openIndex !== undefined) {
        const previous = collapsed[openIndex];
        if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
          const merged = mergeDerivedWorkLogEntries(previous, entry);
          collapsed[openIndex] = merged;
          if (isTerminalLifecycleEntry(merged)) {
            openLifecycleIndexByItemId.delete(entry.itemId);
          }
          continue;
        }
      }
    }

    const previous = collapsed.at(-1);
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      collapsed[collapsed.length - 1] = mergeDerivedWorkLogEntries(previous, entry);
      const merged = collapsed[collapsed.length - 1]!;
      if (merged.itemId) {
        if (isTerminalLifecycleEntry(merged)) {
          openLifecycleIndexByItemId.delete(merged.itemId);
        } else {
          openLifecycleIndexByItemId.set(merged.itemId, collapsed.length - 1);
        }
      }
      continue;
    }
    collapsed.push(entry);
    if (entry.itemId && !isTerminalLifecycleEntry(entry)) {
      openLifecycleIndexByItemId.set(entry.itemId, collapsed.length - 1);
    }
  }
  return collapsed;
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (!isCollapsibleLifecycleActivityKind(previous.activityKind)) {
    return false;
  }
  if (!isLifecycleUpdateOrCompletionActivityKind(next.activityKind)) {
    return false;
  }
  if (isLifecycleCompletionActivityKind(previous.activityKind)) {
    return false;
  }
  return previous.collapseKey !== undefined && previous.collapseKey === next.collapseKey;
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const changedFiles = mergeChangedFiles(previous.changedFiles, next.changedFiles);
  const detail = next.detail ?? previous.detail;
  const command = next.command ?? previous.command;
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const itemType = next.itemType ?? previous.itemType;
  const parentItemId = next.parentItemId ?? previous.parentItemId;
  const requestKind = next.requestKind ?? previous.requestKind;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const lifecycleStatus = next.lifecycleStatus ?? previous.lifecycleStatus;
  const output = mergeWorkLogOutput(previous.output, next.output);
  return {
    ...next,
    id: previous.id,
    createdAt: previous.createdAt,
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(parentItemId ? { parentItemId } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(lifecycleStatus ? { lifecycleStatus } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

function mergeWorkLogOutput(previous: unknown, next: unknown): unknown {
  if (next === undefined) {
    return previous;
  }
  if (previous === undefined) {
    return next;
  }

  const previousRecord = asRecord(previous);
  const nextRecord = asRecord(next);
  if (previousRecord && nextRecord && !Array.isArray(previous) && !Array.isArray(next)) {
    return {
      ...previousRecord,
      ...nextRecord,
    };
  }

  return next;
}

function mergeChangedFiles(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): string[] {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return [];
  }
  return [...new Set(merged)];
}

function deriveToolLifecycleCollapseKey(entry: DerivedWorkLogEntry): string | undefined {
  if (!isCollapsibleLifecycleActivityKind(entry.activityKind)) {
    return undefined;
  }
  if (entry.itemId) {
    return `item:${entry.itemId}`;
  }
  if (isTaskLifecycleActivityKind(entry.activityKind)) {
    return undefined;
  }
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const normalizedCommand = normalizeCommandValue(entry.command ?? entry.detail) ?? "";
  const detail = entry.detail?.trim() ?? "";
  const structuredLifecycleIdentity = deriveStructuredToolLifecycleIdentity(entry);
  const itemType = entry.itemType ?? "";
  const parentItemId = entry.parentItemId ?? "";
  const lifecycleIdentity =
    entry.itemType === "command_execution" || entry.requestKind === "command"
      ? normalizedCommand || structuredLifecycleIdentity || detail
      : structuredLifecycleIdentity || detail || normalizedCommand;
  if (
    normalizedLabel.length === 0 &&
    lifecycleIdentity.length === 0 &&
    itemType.length === 0 &&
    parentItemId.length === 0
  ) {
    return undefined;
  }
  return [parentItemId, itemType, normalizedLabel, lifecycleIdentity].join("\u001f");
}

function deriveStructuredToolLifecycleIdentity(entry: DerivedWorkLogEntry): string {
  const structured = extractStructuredProviderToolData(entry.output);
  if (!structured) {
    return "";
  }

  const normalizedToolName = normalizeProviderToolName(structured.toolName) ?? "";
  const summary = summarizeProviderToolInvocation(structured.toolName, structured.input);
  const normalizedSummary = summary ? summary.replace(/\s+/g, " ").trim().toLowerCase() : "";

  if (normalizedToolName.length === 0) {
    return normalizedSummary;
  }
  if (normalizedSummary.length === 0) {
    return normalizedToolName;
  }
  return `${normalizedToolName}\u001f${normalizedSummary}`;
}

function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:start|started|complete|completed)\s*$/i, "").trim();
}

function toLatestProposedPlanState(proposedPlan: ProposedPlan): LatestProposedPlanState {
  return {
    id: proposedPlan.id,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeToolLifecycleStatus(
  value: unknown,
): DerivedWorkLogEntry["lifecycleStatus"] | undefined {
  const normalized = asTrimmedString(value)
    ?.replace(/[_\s-]+/g, "")
    .toLowerCase();
  switch (normalized) {
    case "inprogress":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "declined":
      return "declined";
    default:
      return undefined;
  }
}

function unwrapShellCommand(value: string): string {
  const trimmed = value.trim();
  const match =
    /^(?:\/usr\/bin\/env\s+)?(?:\/bin\/)?(?:bash|zsh|sh)\s+-lc\s+(['"])([\s\S]*)\1$/.exec(trimmed);
  if (!match) {
    return trimmed;
  }
  const innerCommand = match[2];
  return innerCommand ? innerCommand.replace(/\\(["'`\\$])/g, "$1").trim() : trimmed;
}

function normalizeCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return unwrapShellCommand(direct);
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? unwrapShellCommand(parts.join(" ")) : null;
}

function extractToolCommand(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
  ];
  return candidates.find((candidate) => candidate !== null) ?? null;
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): WorkLogEntry["itemType"] | undefined {
  if (typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)) {
    return payload.itemType;
  }
  return undefined;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogEntry["requestKind"] | undefined {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.notebook_path);
  pushChangedFile(target, seen, record.notebookPath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  collectChangedFiles(asRecord(payload?.data), changedFiles, seen, 0);
  return changedFiles;
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  const lifecycleRankComparison =
    compareActivityLifecycleRank(left.kind) - compareActivityLifecycleRank(right.kind);
  if (lifecycleRankComparison !== 0) {
    return lifecycleRankComparison;
  }

  return left.id.localeCompare(right.id);
}

function compareActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
}

export function hasToolActivityForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  return activities.some((activity) => activity.turnId === turnId && activity.tone === "tool");
}

function getReasoningActivityItemId(activity: OrchestrationThreadActivity): string | null {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return asTrimmedString(payload?.itemId);
}

function getReasoningTaskId(activity: OrchestrationThreadActivity): string | null {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return asTrimmedString(payload?.taskId);
}

function getReasoningSummaryIndex(activity: OrchestrationThreadActivity): number | null {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const value = payload?.summaryIndex;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function joinReasoningBlocks(existingText: string, nextChunk: string): string {
  if (existingText.length === 0) {
    return nextChunk;
  }
  const trailingNewlines = existingText.match(/\n+$/)?.[0].length ?? 0;
  const leadingNewlines = nextChunk.match(/^\n+/)?.[0].length ?? 0;
  const missingNewlines = Math.max(0, 2 - trailingNewlines - leadingNewlines);
  return `${existingText}${"\n".repeat(missingNewlines)}${nextChunk}`;
}

function appendReasoningText(existingText: string, nextChunk: string): string {
  if (existingText.length === 0) {
    return nextChunk;
  }
  if (existingText.includes(nextChunk)) {
    return existingText;
  }
  return joinReasoningBlocks(existingText, nextChunk);
}

function appendReasoningDelta(
  existingText: string,
  nextChunk: string,
  options: { forceBlockBreak: boolean },
): string {
  if (!options.forceBlockBreak) {
    return `${existingText}${nextChunk}`;
  }
  return joinReasoningBlocks(existingText, nextChunk);
}

export function deriveReasoningEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReasoningEntry[] {
  const ordered = getOrderedActivities(activities);
  const entriesById = new Map<string, ReasoningEntry>();
  const orderedIds: string[] = [];
  const lastSummaryIndexByEntryId = new Map<string, number>();
  const pendingBlockBreakEntryIds = new Set<string>();

  for (const activity of ordered) {
    const reasoningProgress = isReasoningProgressActivity(activity);
    const taskId = getReasoningTaskId(activity);
    const reasoningTaskCompleted =
      activity.kind === "task.completed" &&
      taskId !== null &&
      entriesById.has(`reasoning-task:${taskId}`);

    if (!isReasoningActivity(activity) && !reasoningProgress && !reasoningTaskCompleted) {
      continue;
    }

    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const itemId = getReasoningActivityItemId(activity);
    const entryId =
      itemId !== null
        ? `reasoning:${itemId}`
        : taskId !== null
          ? `reasoning-task:${taskId}`
          : `reasoning:${activity.id}`;
    const existing = entriesById.get(entryId);
    const nextEntry: ReasoningEntry =
      existing ??
      ({
        id: entryId,
        createdAt: activity.createdAt,
        text: "",
        streaming: activity.kind !== "reasoning.completed" && activity.kind !== "task.completed",
        turnId: activity.turnId ?? null,
      } satisfies ReasoningEntry);

    if (!existing) {
      entriesById.set(entryId, nextEntry);
      orderedIds.push(entryId);
    }

    if (activity.kind === "reasoning.started") {
      if (existing && nextEntry.text.length > 0) {
        pendingBlockBreakEntryIds.add(entryId);
      }
      nextEntry.streaming = true;
      continue;
    }

    if (activity.kind === "reasoning.delta" && typeof payload?.delta === "string") {
      const summaryIndex = getReasoningSummaryIndex(activity);
      const lastSummaryIndex = lastSummaryIndexByEntryId.get(entryId);
      const summaryBlockChanged =
        summaryIndex !== null &&
        lastSummaryIndex !== undefined &&
        summaryIndex !== lastSummaryIndex;
      const forceBlockBreak =
        summaryBlockChanged ||
        pendingBlockBreakEntryIds.has(entryId) ||
        (!nextEntry.streaming && nextEntry.text.length > 0);
      nextEntry.text = appendReasoningDelta(nextEntry.text, payload.delta, { forceBlockBreak });
      if (summaryIndex !== null) {
        lastSummaryIndexByEntryId.set(entryId, summaryIndex);
      }
      pendingBlockBreakEntryIds.delete(entryId);
      nextEntry.streaming = true;
      continue;
    }

    if (reasoningProgress) {
      const detail =
        typeof payload?.detail === "string"
          ? payload.detail
          : typeof payload?.summary === "string"
            ? payload.summary
            : null;
      if (detail && detail.length > 0) {
        nextEntry.text = appendReasoningText(nextEntry.text, detail);
      }
      nextEntry.streaming = true;
      continue;
    }

    if (activity.kind === "task.completed") {
      nextEntry.streaming = false;
      nextEntry.completedAt = activity.createdAt;
      continue;
    }

    if (activity.kind === "reasoning.completed") {
      if (
        nextEntry.text.length === 0 &&
        typeof payload?.detail === "string" &&
        payload.detail.length > 0
      ) {
        nextEntry.text = payload.detail;
      }
      nextEntry.streaming = false;
      nextEntry.completedAt = activity.createdAt;
    }
  }

  return orderedIds
    .map((id) => entriesById.get(id))
    .filter((entry): entry is ReasoningEntry => !!entry)
    .filter((entry) => entry.text.trim().length > 0);
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  reasoningEntries: ReasoningEntry[],
  proposedPlans: ProposedPlan[],
  workEntries: WorkLogEntry[],
): TimelineEntry[] {
  const messageRows: TimelineEntry[] = messages.map((message) => ({
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message,
  }));
  const reasoningRows: TimelineEntry[] = reasoningEntries.map((reasoning) => ({
    id: reasoning.id,
    kind: "reasoning",
    createdAt: reasoning.createdAt,
    reasoning,
  }));
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  const workRows: TimelineEntry[] = workEntries.map((entry) => ({
    id: entry.id,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));
  return [...messageRows, ...reasoningRows, ...proposedPlanRows, ...workRows].toSorted(
    compareTimelineEntryOrder,
  );
}

function timelineEntrySortTimestamp(entry: TimelineEntry): string {
  if (entry.kind === "message" && entry.message.role === "assistant") {
    // Use completion time when available so providers that begin streaming
    // assistant text before the turn's trailing tool activity settles still
    // keep that activity above the final answer in the completed timeline.
    return entry.message.completedAt ?? entry.message.createdAt;
  }

  return entry.createdAt;
}

function timelineEntryOrderRank(entry: TimelineEntry): number {
  if (entry.kind === "message") {
    switch (entry.message.role) {
      case "user":
        return 0;
      case "system":
        return 1;
      case "assistant":
        return 4;
    }

    return 2;
  }

  switch (entry.kind) {
    case "reasoning":
      return 1;
    case "work":
      return 2;
    case "proposed-plan":
      return 3;
  }
}

function compareTimelineEntryOrder(left: TimelineEntry, right: TimelineEntry): number {
  const sortTimestampComparison = timelineEntrySortTimestamp(left).localeCompare(
    timelineEntrySortTimestamp(right),
  );
  if (sortTimestampComparison !== 0) {
    return sortTimestampComparison;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return timelineEntryOrderRank(left) - timelineEntryOrderRank(right);
}

export function deriveVisibleTimelineMessages(
  messages: ReadonlyArray<ChatMessage>,
  session: Pick<ThreadSession, "activeTurnId" | "orchestrationStatus"> | null,
  options?: {
    readonly preserveCompletedAssistantMessages?: boolean;
  },
): ChatMessage[] {
  const latestAssistantMessageIdByTurnId = new Map<TurnId, MessageId>();
  const assistantMessageCountByTurnId = new Map<TurnId, number>();

  for (const message of messages) {
    if (message.role !== "assistant" || message.turnId == null) {
      continue;
    }
    latestAssistantMessageIdByTurnId.set(message.turnId, message.id);
    assistantMessageCountByTurnId.set(
      message.turnId,
      (assistantMessageCountByTurnId.get(message.turnId) ?? 0) + 1,
    );
  }

  const activeTurnId =
    session?.orchestrationStatus === "running" ? (session.activeTurnId ?? null) : null;
  const preserveCompletedAssistantMessages = options?.preserveCompletedAssistantMessages === true;

  return messages.filter((message) => {
    if (message.role !== "assistant" || message.turnId == null) {
      return true;
    }

    const assistantMessageCount = assistantMessageCountByTurnId.get(message.turnId) ?? 0;
    if (assistantMessageCount <= 1) {
      return true;
    }

    if (activeTurnId !== null && message.turnId === activeTurnId) {
      return true;
    }

    if (preserveCompletedAssistantMessages) {
      return true;
    }

    return latestAssistantMessageIdByTurnId.get(message.turnId) === message.id;
  });
}

export function deriveCompletionDividerBeforeEntryId(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  latestTurn: Pick<
    OrchestrationLatestTurn,
    "assistantMessageId" | "startedAt" | "completedAt"
  > | null,
): string | null {
  if (!latestTurn?.startedAt || !latestTurn.completedAt) {
    return null;
  }

  if (latestTurn.assistantMessageId) {
    const exactMatch = timelineEntries.find(
      (timelineEntry) =>
        timelineEntry.kind === "message" &&
        timelineEntry.message.role === "assistant" &&
        timelineEntry.message.id === latestTurn.assistantMessageId,
    );
    if (exactMatch) {
      return exactMatch.id;
    }
  }

  const turnStartedAt = Date.parse(latestTurn.startedAt);
  const turnCompletedAt = Date.parse(latestTurn.completedAt);
  if (Number.isNaN(turnStartedAt) || Number.isNaN(turnCompletedAt)) {
    return null;
  }

  let inRangeMatch: string | null = null;
  let fallbackMatch: string | null = null;
  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message" || timelineEntry.message.role !== "assistant") {
      continue;
    }
    const messageAt = Date.parse(timelineEntry.message.createdAt);
    if (Number.isNaN(messageAt) || messageAt < turnStartedAt) {
      continue;
    }
    fallbackMatch = timelineEntry.id;
    if (messageAt <= turnCompletedAt) {
      inRangeMatch = timelineEntry.id;
    }
  }
  return inRangeMatch ?? fallbackMatch;
}

export function inferCheckpointTurnCountByTurnId(
  summaries: TurnDiffSummary[],
): Record<TurnId, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<TurnId, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}
