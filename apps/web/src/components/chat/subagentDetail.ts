import { type OrchestrationThreadActivity, type ProviderKind } from "contracts";
import type { WorkLogEntry } from "../../session-logic";
import { extractStructuredProviderToolData, normalizeProviderToolName } from "shared/providerTool";

function uniqueStrings(values: ReadonlyArray<string>): string[] {
  return values.filter((value, index, array) => array.indexOf(value) === index);
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

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => asTrimmedString(entry))
        .filter((entry): entry is string => entry !== null)
    : [];
}

const CODEX_BACKGROUND_SUBAGENT_NAMES = [
  "Harvey",
  "Plato",
  "Euclid",
  "Planck",
  "Curie",
  "Ada",
  "Turing",
  "Noether",
  "Gauss",
  "Kepler",
  "Faraday",
  "Hopper",
  "Pascal",
  "Darwin",
  "Tesla",
  "Lovelace",
  "Maxwell",
  "Euler",
  "Ramanujan",
  "Huygens",
  "Poincare",
  "Riemann",
  "Feynman",
  "Bohr",
  "Archimedes",
  "Sagan",
  "Mendel",
  "Herschel",
  "Leibniz",
  "Sophie",
  "Bayes",
  "Volta",
] as const;

function stableStringHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function friendlyCodexBackgroundSubagentNameFromId(providerThreadId: string | null): string | null {
  if (!providerThreadId) {
    return null;
  }

  return (
    CODEX_BACKGROUND_SUBAGENT_NAMES[
      stableStringHash(providerThreadId) % CODEX_BACKGROUND_SUBAGENT_NAMES.length
    ] ?? null
  );
}

export function isSubagentWorkEntry(entry: WorkLogEntry): boolean {
  return entry.itemType === "collab_agent_tool_call" && typeof entry.itemId === "string";
}

export function findSubagentRootEntry(
  workEntries: ReadonlyArray<WorkLogEntry>,
  rootItemId: string | null | undefined,
): WorkLogEntry | null {
  if (!rootItemId) {
    return null;
  }
  return (
    workEntries.find(
      (entry) => entry.itemId === rootItemId && entry.itemType === "collab_agent_tool_call",
    ) ?? null
  );
}

export function collectSubagentDescendantEntries(
  workEntries: ReadonlyArray<WorkLogEntry>,
  rootItemId: string | null | undefined,
): WorkLogEntry[] {
  if (!rootItemId) {
    return [];
  }

  const descendantItemIds = new Set<string>([rootItemId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of workEntries) {
      if (!entry.itemId || !entry.parentItemId) {
        continue;
      }
      if (descendantItemIds.has(entry.parentItemId) && !descendantItemIds.has(entry.itemId)) {
        descendantItemIds.add(entry.itemId);
        changed = true;
      }
    }
  }

  return workEntries.filter(
    (entry) =>
      entry.itemId !== rootItemId &&
      ((entry.itemId && descendantItemIds.has(entry.itemId)) ||
        (entry.parentItemId && descendantItemIds.has(entry.parentItemId))),
  );
}

export function extractCodexProviderThreadIdsFromWorkEntry(entry: WorkLogEntry): string[] {
  const output = asRecord(entry.output);
  const item = asRecord(output?.item) ?? output;
  const result = asRecord(output?.result);
  return uniqueStrings([
    ...asStringArray(item?.receiverThreadIds),
    ...asStringArray(output?.receiverThreadIds),
    ...asStringArray(result?.receiverThreadIds),
  ]);
}

export function extractSubagentResultSummary(entry: WorkLogEntry): string | null {
  const output = asRecord(entry.output);
  const result = asRecord(output?.result);
  const directContent = asTrimmedString(result?.content) ?? asTrimmedString(result?.summary);
  if (directContent) {
    return directContent;
  }

  if (Array.isArray(result?.content)) {
    const text = result.content
      .map((block) => asTrimmedString(asRecord(block)?.text))
      .filter((value): value is string => value !== null)
      .join("\n\n");
    return text.length > 0 ? text : null;
  }

  return null;
}

function parseToolInputFromDetail(detail: string | undefined): Record<string, unknown> | null {
  if (!detail) {
    return null;
  }

  const match = /^[A-Za-z][A-Za-z0-9 _-]{1,48}:\s*(\{[\s\S]*\})\s*$/u.exec(detail.trim());
  if (!match?.[1]) {
    return null;
  }

  try {
    return asRecord(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

function getSubagentStructuredInput(entry: WorkLogEntry): Record<string, unknown> | null {
  return (
    extractStructuredProviderToolData(entry.output)?.input ?? parseToolInputFromDetail(entry.detail)
  );
}

function getSubagentStructuredToolName(entry: WorkLogEntry): string | null {
  return normalizeProviderToolName(
    extractStructuredProviderToolData(entry.output)?.toolName ?? null,
  );
}

function getSubagentTargets(input: Record<string, unknown> | null): string[] {
  const targets = Array.isArray(input?.targets)
    ? input.targets
    : Array.isArray(input?.receiverThreadIds)
      ? input.receiverThreadIds
      : null;
  if (!targets) {
    return [];
  }

  return targets
    .map((target) => asTrimmedString(target))
    .filter((target): target is string => target !== null);
}

function isCodexCloseSubagentEntry(entry: WorkLogEntry): boolean {
  if (entry.itemType !== "collab_agent_tool_call") {
    return false;
  }
  const toolName = getSubagentStructuredToolName(entry);
  return toolName === "close agent";
}

export type CodexBackgroundSubagentStatus = "active" | "waiting";

export interface CodexBackgroundSubagentRow {
  id: string;
  rootItemId: string;
  provider: ProviderKind;
  displayName: string;
  mentionName: string;
  hasContents: boolean;
  agentRole: string | null;
  instruction: string | null;
  providerThreadIds: string[];
  taskIds: string[];
  status: CodexBackgroundSubagentStatus;
  childEntries: WorkLogEntry[];
}

function toMentionHandle(value: string): string {
  const trimmed = value.trim().replace(/^@+/, "");
  const normalized = trimmed
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "agent";
}

function activityPayload(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return activity.payload && typeof activity.payload === "object"
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function activityParentItemId(activity: OrchestrationThreadActivity): string | null {
  return asTrimmedString(activityPayload(activity)?.parentItemId);
}

function activityTaskId(activity: OrchestrationThreadActivity): string | null {
  return asTrimmedString(activityPayload(activity)?.taskId);
}

function collectSubagentTaskActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  rootItemId: string,
): OrchestrationThreadActivity[] {
  return activities.filter((activity) => {
    if (
      activity.kind !== "task.started" &&
      activity.kind !== "task.progress" &&
      activity.kind !== "task.completed"
    ) {
      return false;
    }
    return activityParentItemId(activity) === rootItemId;
  });
}

function collectDistinctTaskIds(
  taskActivities: ReadonlyArray<OrchestrationThreadActivity>,
): string[] {
  return taskActivities
    .map((activity) => activityTaskId(activity))
    .filter(
      (taskId, index, array): taskId is string =>
        taskId !== null && array.indexOf(taskId) === index,
    );
}

function normalizeIdentifier(value: string | null | undefined): string | null {
  const trimmed = asTrimmedString(value);
  return trimmed ? trimmed.toLowerCase() : null;
}

function deriveSubagentStatus(input: {
  childEntries: ReadonlyArray<WorkLogEntry>;
  taskActivities: ReadonlyArray<OrchestrationThreadActivity>;
}): CodexBackgroundSubagentStatus {
  if (input.childEntries.some((entry) => entry.running)) {
    return "active";
  }

  const latestActivityByTaskId = new Map<string, OrchestrationThreadActivity>();
  for (const activity of input.taskActivities) {
    const taskId = activityTaskId(activity);
    if (!taskId) {
      continue;
    }
    latestActivityByTaskId.set(taskId, activity);
  }

  for (const latestActivity of latestActivityByTaskId.values()) {
    if (latestActivity.kind !== "task.completed") {
      return "active";
    }
  }

  return "waiting";
}

function getSubagentStructuredResult(entry: WorkLogEntry): Record<string, unknown> | null {
  return (
    asRecord(extractStructuredProviderToolData(entry.output)?.result) ??
    asRecord(asRecord(entry.output)?.result)
  );
}

function isSubagentLaunchToolName(toolName: string | null): boolean {
  return (
    toolName === "spawn agent" ||
    toolName === "agent" ||
    toolName === "task" ||
    toolName === "subagent"
  );
}

function isBackgroundSubagentRootEntry(input: {
  provider: ProviderKind;
  entry: WorkLogEntry;
  taskActivities: ReadonlyArray<OrchestrationThreadActivity>;
  providerThreadIds: ReadonlyArray<string>;
}): boolean {
  if (!isSubagentWorkEntry(input.entry)) {
    return false;
  }

  const toolName = getSubagentStructuredToolName(input.entry);
  if (!isSubagentLaunchToolName(toolName)) {
    return false;
  }

  const structuredInput = getSubagentStructuredInput(input.entry);
  const structuredResult = getSubagentStructuredResult(input.entry);
  if (
    structuredInput?.run_in_background === false ||
    structuredResult?.run_in_background === false
  ) {
    return false;
  }

  return (
    toolName === "spawn agent" ||
    structuredInput?.run_in_background === true ||
    structuredResult?.run_in_background === true ||
    input.providerThreadIds.length > 0 ||
    input.taskActivities.length > 0 ||
    input.provider === "codex"
  );
}

function collectSubagentAliases(input: {
  displayName: string;
  explicitName: string | null;
  providerThreadIds: ReadonlyArray<string>;
  taskIds: ReadonlyArray<string>;
}): string[] {
  return [
    input.displayName,
    ...(input.explicitName ? [input.explicitName] : []),
    ...input.providerThreadIds,
    ...input.taskIds,
  ]
    .map((value) => normalizeIdentifier(value))
    .filter(
      (value, index, array): value is string => value !== null && array.indexOf(value) === index,
    );
}

export function deriveBackgroundSubagentRows(input: {
  provider: ProviderKind;
  workEntries: ReadonlyArray<WorkLogEntry>;
  activities?: ReadonlyArray<OrchestrationThreadActivity>;
}): CodexBackgroundSubagentRow[] {
  const closedTargets = new Set<string>();
  for (const entry of input.workEntries) {
    if (!isCodexCloseSubagentEntry(entry)) {
      continue;
    }

    const toolInput = getSubagentStructuredInput(entry);
    for (const target of getSubagentTargets(toolInput)) {
      const normalized = normalizeIdentifier(target);
      if (normalized) {
        closedTargets.add(normalized);
      }
    }
  }

  const visibleNameCounts = new Map<string, number>();
  return input.workEntries.flatMap((entry) => {
    if (!entry.itemId) {
      return [];
    }

    const taskActivities = input.activities
      ? collectSubagentTaskActivities(input.activities, entry.itemId)
      : [];
    const taskIds = collectDistinctTaskIds(taskActivities);
    const providerThreadIds = extractCodexProviderThreadIdsFromWorkEntry(entry);
    if (
      !isBackgroundSubagentRootEntry({
        provider: input.provider,
        entry,
        taskActivities,
        providerThreadIds,
      })
    ) {
      return [];
    }

    const toolInput = getSubagentStructuredInput(entry);
    const toolResult = getSubagentStructuredResult(entry);
    const explicitName =
      asTrimmedString(toolInput?.name) ??
      asTrimmedString(toolInput?.task_name) ??
      asTrimmedString(toolResult?.name) ??
      asTrimmedString(toolResult?.task_name) ??
      null;
    const stableFallbackId = providerThreadIds[0] ?? taskIds[0] ?? entry.itemId;
    const baseDisplayName =
      explicitName ?? friendlyCodexBackgroundSubagentNameFromId(stableFallbackId) ?? "Agent";
    const nextVisibleNameCount = (visibleNameCounts.get(baseDisplayName) ?? 0) + 1;
    visibleNameCounts.set(baseDisplayName, nextVisibleNameCount);
    const displayName =
      nextVisibleNameCount > 1 ? `${baseDisplayName} ${nextVisibleNameCount}` : baseDisplayName;
    const mentionName =
      nextVisibleNameCount > 1
        ? `${toMentionHandle(baseDisplayName)}-${nextVisibleNameCount}`
        : toMentionHandle(displayName);
    const aliases = collectSubagentAliases({
      displayName,
      explicitName,
      providerThreadIds,
      taskIds,
    });
    if (aliases.some((alias) => closedTargets.has(alias))) {
      return [];
    }

    const childEntries = collectSubagentDescendantEntries(input.workEntries, entry.itemId);
    const agentRole =
      asTrimmedString(toolInput?.agent_type) ??
      asTrimmedString(toolInput?.subagent_type) ??
      asTrimmedString(toolInput?.agentType) ??
      asTrimmedString(toolInput?.subagentType) ??
      null;
    const instruction =
      asTrimmedString(toolInput?.description) ??
      asTrimmedString(toolInput?.prompt) ??
      asTrimmedString(toolInput?.task) ??
      asTrimmedString(toolInput?.message) ??
      asTrimmedString(toolResult?.summary) ??
      null;
    const status = deriveSubagentStatus({
      childEntries,
      taskActivities,
    });
    const hasContents =
      childEntries.length > 0 ||
      taskActivities.length > 0 ||
      providerThreadIds.length > 0 ||
      Boolean(toolResult?.summary) ||
      Boolean(toolResult?.outputFile) ||
      Boolean(toolResult?.output_file);

    return [
      {
        id: entry.id,
        rootItemId: entry.itemId,
        provider: input.provider,
        displayName,
        mentionName,
        hasContents,
        agentRole,
        instruction,
        providerThreadIds,
        taskIds,
        status,
        childEntries,
      } satisfies CodexBackgroundSubagentRow,
    ];
  });
}

export function deriveCodexBackgroundSubagentRows(
  workEntries: ReadonlyArray<WorkLogEntry>,
): CodexBackgroundSubagentRow[] {
  return deriveBackgroundSubagentRows({
    provider: "codex",
    workEntries,
  });
}
