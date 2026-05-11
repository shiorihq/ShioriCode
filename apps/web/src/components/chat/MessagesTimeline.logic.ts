import { type MessageId } from "contracts";
import { type TimelineEntry, type WorkLogEntry } from "../../session-logic";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { estimateTimelineMessageHeight } from "../timelineHeight";
import { parseEditDiff } from "./InlineEditDiff";
import { summarizeToolOutput } from "./toolOutput";
import {
  classifyProviderToolRequestKind,
  extractStructuredProviderToolData,
  getProviderToolInputActionType,
  getProviderToolInputActionValue,
  getProviderToolInputPath,
  getProviderToolInputQuery,
  isSubagentToolName,
  isTodoListToolName,
  isUserInputToolName,
  normalizeProviderToolName,
} from "shared/providerTool";

export type WorkEntryDisplayKind = "read" | "list" | "search" | "edit" | "command" | "other";
export type WorkGroupIconKind =
  | "agent"
  | "command"
  | "edit"
  | "file"
  | "list"
  | "search"
  | "skill"
  | "todo"
  | "tool"
  | "web-search"
  | "work";

export interface FormattedWorkEntry {
  kind: WorkEntryDisplayKind;
  action: string;
  detail: string | null;
  monospace: boolean;
  dedupeKey: string | null;
}

type FileChangeOperation = "create" | "edit" | "delete";

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export interface WorkTimelineRow {
  kind: "work";
  id: string;
  expansionId: string;
  createdAt: string;
  groupedEntries: WorkLogEntry[];
  inlineEntries?: ReadonlyArray<
    | {
        kind: "work";
        id: string;
        entry: WorkLogEntry;
      }
    | {
        kind: "reasoning";
        id: string;
        reasoning: Extract<TimelineEntry, { kind: "reasoning" }>["reasoning"];
      }
  >;
  stickyInProgress: boolean;
  childRows: WorkTimelineRow[];
}

function deriveWorkRowExpansionId(entry: WorkLogEntry): string {
  const itemId = entry.itemId?.trim();
  return itemId && itemId.length > 0 ? `work-item:${itemId}` : entry.id;
}

function readExplicitWorkGroupVisibility(
  row: Pick<WorkTimelineRow, "id" | "expansionId">,
  expandedWorkGroups: Readonly<Record<string, boolean>> | undefined,
): boolean | undefined {
  const explicit = expandedWorkGroups?.[row.expansionId];
  if (explicit !== undefined) {
    return explicit;
  }
  return expandedWorkGroups?.[row.id];
}

export function isWorkRowInProgress(row: WorkTimelineRow): boolean {
  if (row.groupedEntries.some((entry) => entry.running) || row.stickyInProgress) {
    return true;
  }
  return row.childRows.some((childRow) => isWorkRowInProgress(childRow));
}

export function isWorkRowExpanded(
  row: WorkTimelineRow,
  expandedWorkGroups: Readonly<Record<string, boolean>> | undefined,
): boolean {
  // Respect explicit user preference (collapse/expand) even while in-progress.
  const explicit = readExplicitWorkGroupVisibility(row, expandedWorkGroups);
  if (explicit !== undefined) {
    return explicit;
  }
  // Default: active work stays open so the header and nested tool activity are
  // visible while the group is streaming, then falls back to collapsed once the
  // work settles.
  return isWorkRowInProgress(row);
}

export function isStandaloneWorkEntryExpanded(
  row: WorkTimelineRow,
  expandedWorkGroups: Readonly<Record<string, boolean>> | undefined,
): boolean {
  return readExplicitWorkGroupVisibility(row, expandedWorkGroups) ?? false;
}

export function shouldRenderFlatWorkRowAsGroup(
  row: Pick<WorkTimelineRow, "groupedEntries" | "inlineEntries">,
): boolean {
  if (row.groupedEntries.length > 1 || (row.inlineEntries?.length ?? 0) > 0) {
    return true;
  }

  const singleEntry = row.groupedEntries[0];
  return Boolean(singleEntry?.running && !isExplorationWorkEntry(singleEntry));
}

export function getGroupedWorkEntryExpansionKey(entryId: string): string {
  return `work-entry:${entryId}`;
}

export type MessagesTimelineRow =
  | WorkTimelineRow
  | {
      kind: "reasoning";
      id: string;
      createdAt: string;
      reasoning: Extract<TimelineEntry, { kind: "reasoning" }>["reasoning"];
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showCompletionDivider: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | { kind: "working"; id: string; createdAt: string | null };

export const DEFAULT_UNVIRTUALIZED_TAIL_ROW_COUNT = 8;

export function deriveFirstUnvirtualizedTimelineRowIndex(input: {
  rows: ReadonlyArray<MessagesTimelineRow>;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  tailRowCount?: number;
}): number {
  const tailRowCount = Math.max(0, input.tailRowCount ?? DEFAULT_UNVIRTUALIZED_TAIL_ROW_COUNT);
  const firstTailRowIndex = Math.max(input.rows.length - tailRowCount, 0);
  const activeTurnStartedAtMs =
    typeof input.activeTurnStartedAt === "string"
      ? Date.parse(input.activeTurnStartedAt)
      : Number.NaN;
  let firstCurrentTurnRowIndex = -1;

  if (!Number.isNaN(activeTurnStartedAtMs)) {
    firstCurrentTurnRowIndex = input.rows.findIndex((row) => {
      if (row.kind === "working") return true;
      if (!row.createdAt) return false;
      const rowCreatedAtMs = Date.parse(row.createdAt);
      return !Number.isNaN(rowCreatedAtMs) && rowCreatedAtMs >= activeTurnStartedAtMs;
    });
  }

  if (firstCurrentTurnRowIndex < 0 && input.activeTurnInProgress) {
    firstCurrentTurnRowIndex = input.rows.findIndex((row) => {
      if (row.kind === "working") return true;
      return row.kind === "message" && row.message.streaming;
    });
  }

  if (firstCurrentTurnRowIndex < 0) {
    return firstTailRowIndex;
  }

  for (let index = firstCurrentTurnRowIndex - 1; index >= 0; index -= 1) {
    const previousRow = input.rows[index];
    if (!previousRow || previousRow.kind !== "message") continue;
    if (previousRow.message.role === "user") {
      return Math.min(index, firstTailRowIndex);
    }
    if (previousRow.message.role === "assistant" && !previousRow.message.streaming) {
      break;
    }
  }

  return Math.min(firstCurrentTurnRowIndex, firstTailRowIndex);
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:start|started|complete|completed)\s*$/i, "").trim();
}

const EXPLORATION_TOOL_TITLES = new Set(["read file", "list directory"]);
const TOOL_NAME_READ_ALIASES = new Set(["read", "read file", "view"]);
const TOOL_NAME_LIST_ALIASES = new Set(["list", "list directory", "ls"]);
const TOOL_NAME_SEARCH_ALIASES = new Set([
  "ack",
  "ag",
  "fd",
  "find",
  "glob",
  "grep",
  "rg",
  "ripgrep",
  "search",
  "web search",
]);
const TOOL_NAME_CREATE_ALIASES = new Set(["create file"]);
const TOOL_NAME_DELETE_ALIASES = new Set(["delete file"]);
const EXPLORATION_COMMAND_PREFIXES = [
  "cat",
  "fd",
  "find",
  "grep",
  "head",
  "less",
  "ls",
  "pwd",
  "read",
  "rg",
  "sed",
  "stat",
  "tail",
  "tree",
];
const CREATE_SENTINEL_PATH_KEYS = new Set(["oldPath", "old_path", "prevPath", "prev_path"]);
const DELETE_SENTINEL_PATH_KEYS = new Set(["newPath", "new_path"]);
const CREATED_FILE_PATCH_PATTERN = /(^new file mode\b|^--- \/dev\/null$)/m;
const DELETED_FILE_PATCH_PATTERN = /(^deleted file mode\b|^\+\+\+ \/dev\/null$)/m;
const DEV_NULL_PATH = "/dev/null";

function normalizeWorkEntryTitle(entry: WorkLogEntry): string {
  return normalizeCompactToolLabel(entry.toolTitle ?? entry.label)
    .replace(/[._-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isRuntimeDiagnosticWorkEntry(entry: WorkLogEntry): boolean {
  const normalizedLabel = normalizeWorkEntryTitle(entry);
  return normalizedLabel === "runtime warning" || normalizedLabel === "runtime error";
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

function parseToolNameFromDetail(detail: string | undefined): string | null {
  const rawToolName = parseRawToolNameFromDetail(detail);
  return normalizeProviderToolName(rawToolName);
}

function parseRawToolNameFromDetail(detail: string | undefined): string | null {
  if (!detail) {
    return null;
  }

  const match = /^([A-Za-z][A-Za-z0-9 _-]{1,48}):\s*[[{"]/u.exec(detail.trim());
  return asTrimmedString(match?.[1]);
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

function getEntryToolName(entry: WorkLogEntry): string | null {
  const directToolName = normalizeProviderToolName(getEntryRawToolName(entry));
  if (directToolName) {
    return directToolName;
  }

  return parseToolNameFromDetail(entry.detail);
}

function getEntryRawToolName(entry: WorkLogEntry): string | null {
  return (
    asTrimmedString(extractStructuredProviderToolData(entry.output)?.toolName) ??
    asTrimmedString(entry.toolTitle) ??
    parseRawToolNameFromDetail(entry.detail)
  );
}

function getEntryToolInput(entry: WorkLogEntry): Record<string, unknown> | null {
  const directInput = extractStructuredProviderToolData(entry.output)?.input ?? null;
  if (directInput) {
    return directInput;
  }

  return parseToolInputFromDetail(entry.detail);
}

function isMcpToolEntry(entry: WorkLogEntry, normalizedToolName: string | null): boolean {
  return (
    entry.itemType === "mcp_tool_call" ||
    normalizedToolName?.startsWith("mcp ") === true ||
    normalizeWorkEntryTitle(entry) === "mcp tool call"
  );
}

export function isMcpToolWorkEntry(entry: WorkLogEntry): boolean {
  return isMcpToolEntry(entry, getEntryToolName(entry));
}

function humanizeMcpToolNameSegment(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function formatMcpToolDisplayName(entry: WorkLogEntry): string {
  const rawToolName = getEntryRawToolName(entry);
  if (rawToolName) {
    const prefixedMatch = /^mcp__([^_]+(?:_[^_]+)*)__([\s\S]+)$/u.exec(rawToolName);
    const toolSegment = prefixedMatch?.[2] ?? rawToolName.replace(/^mcp[_\s-]+/iu, "");
    const humanized = humanizeMcpToolNameSegment(toolSegment);
    if (humanized.length > 0 && humanized !== "tool call") {
      return humanized;
    }
  }

  const normalizedTitle = normalizeWorkEntryTitle(entry);
  if (normalizedTitle !== "mcp tool call" && normalizedTitle.length > 0) {
    return normalizedTitle;
  }

  return "tool";
}

function recordContainsSentinelPath(value: unknown, keys: ReadonlySet<string>, depth = 0): boolean {
  if (depth > 5) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => recordContainsSentinelPath(entry, keys, depth + 1));
  }

  const record = asRecord(value);
  if (!record) {
    return false;
  }

  for (const [key, nestedValue] of Object.entries(record)) {
    if (keys.has(key) && asTrimmedString(nestedValue) === DEV_NULL_PATH) {
      return true;
    }
    if (recordContainsSentinelPath(nestedValue, keys, depth + 1)) {
      return true;
    }
  }

  return false;
}

function recordContainsPatchMarker(value: unknown, pattern: RegExp, depth = 0): boolean {
  if (depth > 5 || value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return pattern.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => recordContainsPatchMarker(entry, pattern, depth + 1));
  }

  const record = asRecord(value);
  return record
    ? Object.values(record).some((nestedValue) =>
        recordContainsPatchMarker(nestedValue, pattern, depth + 1),
      )
    : false;
}

function classifyFileChangeOperation(entry: WorkLogEntry): FileChangeOperation | null {
  const toolName = getEntryToolName(entry);
  if (toolName && TOOL_NAME_CREATE_ALIASES.has(toolName)) {
    return "create";
  }
  if (toolName && TOOL_NAME_DELETE_ALIASES.has(toolName)) {
    return "delete";
  }

  if (
    recordContainsSentinelPath(entry.output, CREATE_SENTINEL_PATH_KEYS) ||
    recordContainsPatchMarker(entry.output, CREATED_FILE_PATCH_PATTERN)
  ) {
    return "create";
  }
  if (
    recordContainsSentinelPath(entry.output, DELETE_SENTINEL_PATH_KEYS) ||
    recordContainsPatchMarker(entry.output, DELETED_FILE_PATCH_PATTERN)
  ) {
    return "delete";
  }

  if (
    entry.requestKind === "file-change" ||
    entry.itemType === "file_change" ||
    classifyProviderToolRequestKind(toolName) === "file-change"
  ) {
    return "edit";
  }

  return null;
}

export function isFileChangeWorkEntry(entry: WorkLogEntry): boolean {
  return classifyFileChangeOperation(entry) !== null;
}

export function isSkillWorkEntry(entry: WorkLogEntry): boolean {
  return getEntryToolName(entry) === "skill";
}

function actionForFileChangeOperation(input: {
  operation: FileChangeOperation;
  running: boolean;
  providerToolName: string | null;
}): string {
  switch (input.operation) {
    case "create":
      return input.running ? "Creating" : "Created";
    case "delete":
      return input.running ? "Deleting" : "Deleted";
    case "edit":
      if (
        input.providerToolName === "write" ||
        input.providerToolName === "write file" ||
        input.providerToolName === "file write"
      ) {
        return input.running ? "Writing" : "Wrote";
      }
      if (input.providerToolName === "apply patch") {
        return input.running ? "Applying patch" : "Applied patch";
      }
      return input.running ? "Editing" : "Edited";
  }
}

function classifyToolName(toolName: string | null): WorkEntryDisplayKind | null {
  if (!toolName) {
    return null;
  }
  if (TOOL_NAME_READ_ALIASES.has(toolName)) {
    return "read";
  }
  if (TOOL_NAME_LIST_ALIASES.has(toolName)) {
    return "list";
  }
  if (TOOL_NAME_SEARCH_ALIASES.has(toolName)) {
    return "search";
  }
  return null;
}

function isTodoWriteToolName(toolName: string | null): boolean {
  return isTodoListToolName(toolName);
}

function isEmptyStructuredToolDetail(detail: string | null | undefined): boolean {
  if (!detail) {
    return false;
  }
  const trimmed = detail.trim();
  return /^[A-Za-z][A-Za-z0-9 _-]{1,48}:\s*\{\s*\}$/u.test(trimmed);
}

function getExplicitDetail(entry: WorkLogEntry): string | null {
  const detail = entry.detail ?? entry.changedFiles?.[0] ?? null;
  if (!detail) {
    return null;
  }
  return isEmptyStructuredToolDetail(detail) ? null : detail;
}

function normalizeRedundantDetailText(value: string): string {
  return value.replace(/[._-]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function coalesceRedundantDetail(action: string, detail: string | null): string | null {
  if (!detail) {
    return null;
  }

  return normalizeRedundantDetailText(action) === normalizeRedundantDetailText(detail)
    ? null
    : detail;
}

function stripStatusToolActionPrefix(
  kind: WorkEntryDisplayKind,
  detail: string | null,
): string | null {
  if (!detail) {
    return null;
  }

  const trimmed = detail.trim();
  const strip = (pattern: RegExp): string | null => {
    const stripped = trimmed.replace(pattern, "").trim();
    return stripped.length > 0 ? stripped : null;
  };

  switch (kind) {
    case "read":
      return strip(/^(?:read|reading)\s+/iu) ?? trimmed;
    case "list":
      return strip(/^(?:listed|listing|list)\s+/iu) ?? trimmed;
    case "search":
      return strip(/^(?:found|finding|searched(?:\s+for)?|searching(?:\s+for)?)\s+/iu) ?? trimmed;
    default:
      return trimmed;
  }
}

function stripFileChangeDetailPrefix(detail: string): string | null {
  const trimmed = detail.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const stripped = trimmed
    .replace(/^(?:write file|file write|str replace file|edit file|apply patch)\s*:\s*/iu, "")
    .replace(/^(?:write|edit|replace)\s+(?=\d+\s+files?\b)/iu, "")
    .trim();

  if (stripped.length === 0 || normalizeRedundantDetailText(stripped) === "file") {
    return null;
  }

  return stripped;
}

function fileChangeDetailFallback(input: {
  action: string;
  explicitDetail: string | null;
  providerToolPath: string | null;
}): string | null {
  if (input.providerToolPath) {
    return input.providerToolPath;
  }
  const coalesced = coalesceRedundantDetail(input.action, input.explicitDetail);
  return coalesced ? stripFileChangeDetailPrefix(coalesced) : null;
}

function normalizeWorkEntryCommand(entry: WorkLogEntry): string {
  return (entry.command ?? entry.detail ?? "").trim().toLowerCase();
}

function isExplorationCommand(entry: WorkLogEntry): boolean {
  const normalizedCommand = normalizeWorkEntryCommand(entry);
  if (normalizedCommand.length === 0) return false;
  return normalizedCommand
    .split(/&&|\|\||[;|]/g)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .some((segment) =>
      EXPLORATION_COMMAND_PREFIXES.some(
        (prefix) => segment === prefix || segment.startsWith(`${prefix} `),
      ),
    );
}

export function isExplorationWorkEntry(entry: WorkLogEntry): boolean {
  if (entry.requestKind === "file-read" || entry.itemType === "image_view") return true;
  if (entry.itemType === "web_search") return true;

  const normalizedTitle = normalizeWorkEntryTitle(entry);
  if (EXPLORATION_TOOL_TITLES.has(normalizedTitle) || normalizedTitle.includes("search")) {
    return true;
  }

  if (classifyToolName(getEntryToolName(entry)) !== null) {
    return true;
  }

  if (entry.requestKind === "command" || entry.itemType === "command_execution") {
    return isExplorationCommand(entry);
  }

  return false;
}

function formatSubagentTaskDetail(input: Record<string, unknown> | null): string | null {
  if (!input) {
    return null;
  }

  const description =
    asTrimmedString(input.description) ??
    asTrimmedString(input.task) ??
    asTrimmedString(input.title) ??
    asTrimmedString(input.prompt);
  const subagentType =
    asTrimmedString(input.subagent_type) ??
    asTrimmedString(input.subagentType) ??
    asTrimmedString(input.agent_type) ??
    asTrimmedString(input.agentType);

  if (description && subagentType) {
    return `${description} (${subagentType})`;
  }
  return description ?? subagentType ?? null;
}

function formatSkillToolDetail(input: Record<string, unknown> | null): string | null {
  if (!input) {
    return null;
  }

  return (
    asTrimmedString(input.skill) ??
    asTrimmedString(input.skill_name) ??
    asTrimmedString(input.skillName) ??
    asTrimmedString(input.name)
  );
}

function extractToolUseId(result: Record<string, unknown> | null): string | null {
  return asTrimmedString(result?.tool_use_id) ?? asTrimmedString(result?.toolUseId);
}

function extractResultContentText(result: Record<string, unknown> | null): string | null {
  if (!result) {
    return null;
  }
  const direct = asTrimmedString(result.content);
  if (direct) {
    return direct;
  }
  if (Array.isArray(result.content)) {
    const text = result.content
      .map((block) => asTrimmedString(asRecord(block)?.text))
      .filter((value): value is string => value !== null)
      .join("\n\n");
    return text.length > 0 ? text : null;
  }
  return null;
}

export interface SkillWorkflowCard {
  skillName: string | null;
  skillPath: string | null;
  skillMarkdown: string | null;
  toolUseId: string | null;
  resultText: string | null;
}

function extractResultRecord(
  result: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!result) {
    return null;
  }

  return asRecord(result.content) ?? result;
}

export function extractSkillWorkflowCard(entry: WorkLogEntry): SkillWorkflowCard | null {
  const toolName = getEntryToolName(entry);
  if (toolName !== "skill") {
    return null;
  }
  const input = getEntryToolInput(entry);
  const result = asRecord(extractStructuredProviderToolData(entry.output)?.result);
  const payload = extractResultRecord(result);
  return {
    skillName:
      formatSkillToolDetail(input) ??
      asTrimmedString(payload?.skill) ??
      asTrimmedString(payload?.name),
    skillPath: asTrimmedString(payload?.path),
    skillMarkdown: asTrimmedString(payload?.content),
    toolUseId: extractToolUseId(result),
    resultText: extractResultContentText(result),
  };
}

export interface DelegatedAgentWorkflowCard {
  description: string | null;
  prompt: string | null;
  agentRole: string | null;
  runInBackground: boolean;
  toolUseId: string | null;
  resultText: string | null;
}

export function extractDelegatedAgentWorkflowCard(
  entry: WorkLogEntry,
): DelegatedAgentWorkflowCard | null {
  if (entry.itemType !== "collab_agent_tool_call") {
    return null;
  }
  const input = getEntryToolInput(entry);
  if (!input) {
    return null;
  }
  const structured = extractStructuredProviderToolData(entry.output);
  const result = asRecord(structured?.result);
  const description =
    asTrimmedString(input.description) ??
    asTrimmedString(input.task) ??
    asTrimmedString(input.title);
  const prompt = asTrimmedString(input.prompt) ?? asTrimmedString(input.message);
  const agentRole =
    asTrimmedString(input.subagent_type) ??
    asTrimmedString(input.subagentType) ??
    asTrimmedString(input.agent_type) ??
    asTrimmedString(input.agentType);
  if (!description && !prompt && !agentRole) {
    return null;
  }
  return {
    description,
    prompt,
    agentRole,
    runInBackground: input.run_in_background === true || input.runInBackground === true,
    toolUseId: extractToolUseId(result),
    resultText: extractResultContentText(result),
  };
}

function formatUserInputToolDetail(input: Record<string, unknown> | null): string | null {
  if (!input) {
    return null;
  }

  const directQuestion = asTrimmedString(input.question);
  if (directQuestion) {
    return directQuestion;
  }

  const questions = Array.isArray(input.questions) ? input.questions : null;
  const firstQuestion = questions?.[0] ? asRecord(questions[0]) : null;
  return asTrimmedString(firstQuestion?.question);
}

function formatPlanToolDetail(input: Record<string, unknown> | null): string | null {
  if (!input) {
    return null;
  }

  const explanation = asTrimmedString(input.explanation);
  const stepCount = Array.isArray(input.plan) ? input.plan.length : 0;
  if (explanation && stepCount > 0) {
    return `${explanation} (${stepCount} steps)`;
  }
  if (explanation) {
    return explanation;
  }
  if (stepCount > 0) {
    return `${stepCount} steps`;
  }
  return null;
}

function formatTodoWriteSummary(input: Record<string, unknown> | null): string | null {
  if (!input) {
    return null;
  }

  const todos = Array.isArray(input.todos) ? input.todos : null;
  const todoCount =
    todos?.filter((entry) => {
      const record = asRecord(entry);
      return (
        asTrimmedString(record?.content) ??
        asTrimmedString(record?.activeForm) ??
        asTrimmedString(record?.text) ??
        asTrimmedString(record?.title)
      );
    }).length ?? 0;

  if (todoCount <= 0) {
    return "todo list";
  }

  return `todo list (${todoCount} ${todoCount === 1 ? "task" : "tasks"})`;
}

function formatAgentTargetDetail(input: Record<string, unknown> | null): string | null {
  if (!input) {
    return null;
  }

  const directTarget =
    asTrimmedString(input.target) ??
    asTrimmedString(input.task_id) ??
    asTrimmedString(input.taskId);
  if (directTarget) {
    return directTarget;
  }

  const targets = Array.isArray(input.targets) ? input.targets : null;
  if (!targets || targets.length === 0) {
    const agentsStates = asRecord(input.agentsStates);
    if (!agentsStates) {
      return null;
    }
    const ids = Object.keys(agentsStates).filter((id) => id.trim().length > 0);
    return ids.length > 0 ? ids.join(", ") : null;
  }

  const normalizedTargets = targets
    .map((target) => asTrimmedString(target))
    .filter((target): target is string => target !== null);
  return normalizedTargets.length > 0 ? normalizedTargets.join(", ") : null;
}

function formatWebSearchWorkEntry(input: {
  providerToolInput: Record<string, unknown> | null;
  running: boolean;
  fallbackDetail: string | null;
}): FormattedWorkEntry {
  const query = getProviderToolInputQuery(input.providerToolInput);
  const actionType = getProviderToolInputActionType(input.providerToolInput);
  const actionValue = getProviderToolInputActionValue(input.providerToolInput);
  const detail = query ?? actionValue ?? input.fallbackDetail;

  if (actionType === "open_page") {
    return {
      kind: "search",
      action: input.running ? "Opening page" : "Opened page",
      detail,
      monospace: false,
      dedupeKey: null,
    };
  }

  if (actionType === "find_in_page") {
    return {
      kind: "search",
      action: input.running ? "Searching in page" : "Searched in page",
      detail,
      monospace: false,
      dedupeKey: null,
    };
  }

  if (actionType === "search") {
    return {
      kind: "search",
      action: input.running ? "Searching for" : "Searched for",
      detail,
      monospace: false,
      dedupeKey: null,
    };
  }

  return {
    kind: "search",
    action: detail
      ? input.running
        ? "Searching web for"
        : "Searched web for"
      : input.running
        ? "Searching web"
        : "Searched web",
    detail,
    monospace: false,
    dedupeKey: null,
  };
}

const COMMAND_TOKEN_PATTERN = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`|[^\s]+/g;
const SEARCH_COMMANDS = new Set(["ack", "ag", "fd", "find", "grep", "rg"]);
const READ_COMMANDS = new Set(["bat", "cat", "head", "less", "more", "read", "sed", "tail"]);
const LIST_COMMANDS = new Set(["dir", "ls", "pwd", "stat", "tree"]);
const SHELL_OUTPUT_HELPER_COMMANDS = new Set([
  "awk",
  "cat",
  "cut",
  "grep",
  "head",
  "jq",
  "sed",
  "sort",
  "tail",
  "tr",
  "uniq",
  "wc",
]);

function unquoteCommandToken(token: string): string {
  if (token.length < 2) {
    return token;
  }

  const quote = token[0];
  if ((quote !== '"' && quote !== "'" && quote !== "`") || token[token.length - 1] !== quote) {
    return token;
  }

  return token
    .slice(1, -1)
    .replace(/\\(["'`\\])/g, "$1")
    .trim();
}

function tokenizeCommand(command: string): string[] {
  const matches = command.match(COMMAND_TOKEN_PATTERN);
  if (!matches) {
    return [];
  }

  return matches.map(unquoteCommandToken).filter((token) => token.length > 0);
}

function commandName(token: string | undefined): string {
  if (!token) {
    return "";
  }

  const normalized = token.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return (segments.at(-1) ?? normalized).toLowerCase();
}

function findFirstPositionalToken(tokens: readonly string[]): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (token === "--") {
      return tokens[index + 1] ?? null;
    }
    if (!token.startsWith("-")) {
      return token;
    }
  }
  return null;
}

function findLastPositionalToken(tokens: readonly string[]): string | null {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (!token || token === "--" || token.startsWith("-")) {
      continue;
    }
    return token;
  }
  return null;
}

function parseExplorationCommand(
  command: string,
): Pick<FormattedWorkEntry, "kind" | "action" | "detail" | "monospace" | "dedupeKey"> | null {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) {
    return null;
  }

  const normalizedName = commandName(tokens[0]);
  const args = tokens.slice(1);

  if (normalizedName === "find") {
    for (let index = 0; index < args.length - 1; index += 1) {
      const token = args[index];
      if (
        token === "-name" ||
        token === "-iname" ||
        token === "-path" ||
        token === "-ipath" ||
        token === "-regex"
      ) {
        const query = args[index + 1];
        if (query) {
          return {
            kind: "search",
            action: "Searched for",
            detail: query,
            monospace: false,
            dedupeKey: null,
          };
        }
      }
    }

    const path = findFirstPositionalToken(args);
    return {
      kind: "list",
      action: "Listed",
      detail: path,
      monospace: true,
      dedupeKey: null,
    };
  }

  if (SEARCH_COMMANDS.has(normalizedName)) {
    const query = findFirstPositionalToken(args);
    return {
      kind: "search",
      action: "Searched for",
      detail: query,
      monospace: false,
      dedupeKey: null,
    };
  }

  if (READ_COMMANDS.has(normalizedName)) {
    const path = findLastPositionalToken(args);
    return {
      kind: "read",
      action: "Read",
      detail: path,
      monospace: true,
      dedupeKey: path ? `read:${path}` : null,
    };
  }

  if (LIST_COMMANDS.has(normalizedName)) {
    const path =
      normalizedName === "pwd"
        ? null
        : (findLastPositionalToken(args) ?? findFirstPositionalToken(args));
    return {
      kind: "list",
      action: "Listed",
      detail: path,
      monospace: true,
      dedupeKey: null,
    };
  }

  return null;
}

function isPlainStatusUpdateEntry(entry: WorkLogEntry): boolean {
  return entry.label.trim().toLowerCase() === "status update";
}

function isBareShellOutputHelper(detail: string | null): boolean {
  if (!detail) {
    return false;
  }

  const tokens = tokenizeCommand(detail);
  if (tokens.length === 0) {
    return false;
  }

  const firstCommand = commandName(tokens[0]);
  if (!SHELL_OUTPUT_HELPER_COMMANDS.has(firstCommand)) {
    return false;
  }

  return !tokens.some(
    (token) =>
      token === "--" ||
      token.includes("/") ||
      token.includes("\\") ||
      token.startsWith(".") ||
      token.startsWith("~"),
  );
}

function runningActionForKind(kind: WorkEntryDisplayKind): string {
  switch (kind) {
    case "read":
      return "Reading";
    case "list":
      return "Listing";
    case "search":
      return "Searching for";
    case "edit":
      return "Editing";
    case "command":
      return "Running";
    default:
      return "Working";
  }
}

export function formatWorkEntry(entry: WorkLogEntry): FormattedWorkEntry {
  const normalizedLabel = normalizeWorkEntryTitle(entry);
  const explicitDetail = getExplicitDetail(entry);
  const running = entry.running === true;
  const providerToolInput = getEntryToolInput(entry);
  const providerToolName = getEntryToolName(entry);
  const providerToolKind = classifyToolName(providerToolName);
  const providerToolPath = getProviderToolInputPath(providerToolInput);
  const providerToolQuery = getProviderToolInputQuery(providerToolInput);
  const fileChangeOperation = classifyFileChangeOperation(entry);
  const subagentTaskDetail = formatSubagentTaskDetail(providerToolInput);
  const skillToolDetail = formatSkillToolDetail(providerToolInput);
  const userInputToolDetail = formatUserInputToolDetail(providerToolInput);
  const planToolDetail = formatPlanToolDetail(providerToolInput);
  const todoWriteSummary = formatTodoWriteSummary(providerToolInput);
  const agentTargetDetail = formatAgentTargetDetail(providerToolInput);

  if (isRuntimeDiagnosticWorkEntry(entry)) {
    return {
      kind: "other",
      action: normalizedLabel === "runtime error" ? "Runtime error" : "Runtime warning",
      detail: null,
      monospace: false,
      dedupeKey: null,
    };
  }

  if (isMcpToolEntry(entry, providerToolName)) {
    return {
      kind: "other",
      action: running ? "Using MCP" : "Used MCP",
      detail: formatMcpToolDisplayName(entry),
      monospace: false,
      dedupeKey: null,
    };
  }

  if (providerToolName === "wait agent" || providerToolName === "wait") {
    return {
      kind: "other",
      action: running ? "Waiting for agent" : "Waited for agent",
      detail: agentTargetDetail ?? explicitDetail,
      monospace: false,
      dedupeKey: null,
    };
  }

  if (providerToolName === "close agent") {
    return {
      kind: "other",
      action: running ? "Closing agent" : "Closed agent",
      detail: agentTargetDetail ?? explicitDetail,
      monospace: false,
      dedupeKey: null,
    };
  }

  if (entry.itemType === "collab_agent_tool_call") {
    return {
      kind: "other",
      action: "",
      detail: subagentTaskDetail ?? explicitDetail,
      monospace: false,
      dedupeKey: null,
    };
  }

  if (providerToolName && isSubagentToolName(providerToolName)) {
    return {
      kind: "other",
      action: "",
      detail: subagentTaskDetail ?? explicitDetail,
      monospace: false,
      dedupeKey: null,
    };
  }

  if (providerToolName === "skill") {
    return {
      kind: "other",
      action: running ? "Using Skill" : "Used Skill",
      detail: skillToolDetail ?? explicitDetail,
      monospace: false,
      dedupeKey: null,
    };
  }

  if (providerToolName === "send input" || providerToolName === "send message") {
    return {
      kind: "other",
      action: running ? "Sending input" : "Sent input",
      detail: agentTargetDetail ?? explicitDetail,
      monospace: false,
      dedupeKey: null,
    };
  }

  if (providerToolName === "update plan") {
    return {
      kind: "other",
      action: running ? "Updating plan" : "Updated plan",
      detail: planToolDetail ?? explicitDetail,
      monospace: false,
      dedupeKey: null,
    };
  }

  if (isTodoWriteToolName(providerToolName)) {
    return {
      kind: "other",
      action: running ? "Updating" : "Updated",
      detail: todoWriteSummary,
      monospace: false,
      dedupeKey: null,
    };
  }

  if (providerToolName && isUserInputToolName(providerToolName)) {
    return {
      kind: "other",
      action: running ? "Requesting input" : "Requested input",
      detail: userInputToolDetail ?? explicitDetail,
      monospace: false,
      dedupeKey: null,
    };
  }

  if (fileChangeOperation) {
    const action = actionForFileChangeOperation({
      operation: fileChangeOperation,
      running,
      providerToolName,
    });
    return {
      kind: "edit",
      action,
      detail: fileChangeDetailFallback({ action, explicitDetail, providerToolPath }),
      monospace: true,
      dedupeKey: null,
    };
  }

  if (entry.itemType === "web_search") {
    return formatWebSearchWorkEntry({
      providerToolInput,
      running,
      fallbackDetail: explicitDetail || entry.command || null,
    });
  }

  if (providerToolKind === "list") {
    const statusDetail = stripStatusToolActionPrefix("list", explicitDetail);
    if (
      providerToolPath === null &&
      isPlainStatusUpdateEntry(entry) &&
      isBareShellOutputHelper(statusDetail)
    ) {
      return {
        kind: "command",
        action: running ? "Running" : "Ran",
        detail: statusDetail,
        monospace: true,
        dedupeKey: null,
      };
    }

    return {
      kind: "list",
      action: running ? "Listing" : "Listed",
      detail: providerToolPath ?? statusDetail,
      monospace: true,
      dedupeKey: null,
    };
  }

  if (providerToolKind === "read") {
    const statusDetail = stripStatusToolActionPrefix("read", explicitDetail);
    if (
      providerToolPath === null &&
      isPlainStatusUpdateEntry(entry) &&
      isBareShellOutputHelper(statusDetail)
    ) {
      return {
        kind: "command",
        action: running ? "Running" : "Ran",
        detail: statusDetail,
        monospace: true,
        dedupeKey: null,
      };
    }

    return {
      kind: "read",
      action: running ? "Reading" : "Read",
      detail: providerToolPath ?? statusDetail,
      monospace: true,
      dedupeKey: providerToolPath
        ? `read:${providerToolPath}`
        : statusDetail
          ? `read:${statusDetail}`
          : null,
    };
  }

  if (providerToolKind === "search") {
    const strippedSearchDetail = stripStatusToolActionPrefix("search", explicitDetail);
    const providerSearchDetail =
      providerToolQuery && providerToolPath
        ? `${providerToolQuery} in ${providerToolPath}`
        : (providerToolQuery ?? providerToolPath ?? strippedSearchDetail ?? entry.command ?? null);
    return {
      kind: "search",
      action: running ? "Searching for" : "Searched for",
      detail: providerSearchDetail,
      monospace: false,
      dedupeKey: null,
    };
  }

  if (normalizedLabel === "list directory") {
    return {
      kind: "list",
      action: running ? "Listing" : "Listed",
      detail: explicitDetail,
      monospace: true,
      dedupeKey: null,
    };
  }

  if (
    entry.requestKind === "file-read" ||
    entry.itemType === "image_view" ||
    normalizedLabel === "read file"
  ) {
    const statusDetail = stripStatusToolActionPrefix("read", explicitDetail);
    if (isPlainStatusUpdateEntry(entry) && isBareShellOutputHelper(statusDetail)) {
      return {
        kind: "command",
        action: running ? "Running" : "Ran",
        detail: statusDetail,
        monospace: true,
        dedupeKey: null,
      };
    }

    return {
      kind: "read",
      action: running ? "Reading" : "Read",
      detail: explicitDetail,
      monospace: true,
      dedupeKey: explicitDetail ? `read:${explicitDetail}` : null,
    };
  }

  if (normalizedLabel.includes("search")) {
    return {
      kind: "search",
      action: running ? "Searching for" : "Searched for",
      detail: explicitDetail || entry.command || null,
      monospace: false,
      dedupeKey: null,
    };
  }

  if (isExplorationWorkEntry(entry)) {
    const parsedCommand = parseExplorationCommand(entry.command ?? entry.detail ?? "");
    if (parsedCommand) {
      if (running) {
        return { ...parsedCommand, action: runningActionForKind(parsedCommand.kind) };
      }
      return parsedCommand;
    }
  }

  if (entry.requestKind === "command" || entry.itemType === "command_execution") {
    return {
      kind: "command",
      action: running ? "Running" : "Ran",
      detail: entry.command || explicitDetail || null,
      monospace: true,
      dedupeKey: null,
    };
  }

  const raw = entry.toolTitle
    ? normalizeCompactToolLabel(entry.toolTitle)
    : normalizeCompactToolLabel(entry.label);
  const heading = raw.length > 0 ? `${raw.charAt(0).toUpperCase()}${raw.slice(1)}` : raw;
  return {
    kind: "other",
    action: heading,
    detail: coalesceRedundantDetail(heading, entry.command || explicitDetail || null),
    monospace: false,
    dedupeKey: null,
  };
}

function pluralizeCount(
  count: number,
  singular: string,
  plural = pluralizeEnglishNoun(singular),
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function pluralizeEnglishNoun(singular: string): string {
  if (/(?:s|x|z|ch|sh)$/i.test(singular)) {
    return `${singular}es`;
  }
  if (/[^aeiou]y$/i.test(singular)) {
    return `${singular.slice(0, -1)}ies`;
  }
  return `${singular}s`;
}

type WorkGroupSegment = {
  leadingVerb: string;
  leadingRest: string;
  trailing: string;
};

function workGroupTextSegment(input: {
  count: number;
  leadingVerb: string;
  trailingVerb: string;
  singular: string;
  plural?: string;
}): WorkGroupSegment | null {
  if (input.count <= 0) {
    return null;
  }
  const label = pluralizeCount(input.count, input.singular, input.plural);
  return {
    leadingVerb: input.leadingVerb,
    leadingRest: label,
    trailing: `${input.trailingVerb} ${label}`,
  };
}

function joinWorkGroupSummarySegments(segments: ReadonlyArray<WorkGroupSegment>): {
  leadingVerb: string;
  rest: string;
} {
  const [first, ...tail] = segments;
  if (!first) {
    return { leadingVerb: "", rest: "" };
  }
  const restParts: string[] = [];
  if (first.leadingRest.length > 0) {
    restParts.push(first.leadingRest);
  }
  for (const segment of tail) {
    restParts.push(segment.trailing);
  }
  return { leadingVerb: first.leadingVerb, rest: restParts.join(", ") };
}

export type WorkGroupSummaryParts = {
  leadingVerb: string;
  rest: string;
};

function joinSummaryParts({ leadingVerb, rest }: WorkGroupSummaryParts): string {
  return rest.length > 0 ? `${leadingVerb} ${rest}` : leadingVerb;
}

export function getDisplayedWorkEntries(entries: ReadonlyArray<WorkLogEntry>): WorkLogEntry[] {
  if (entries.length <= 1) {
    return [...entries];
  }

  const seenReadKeys = new Set<string>();
  const displayedEntries: WorkLogEntry[] = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const formattedEntry = formatWorkEntry(entry);
    if (formattedEntry.kind === "read" && formattedEntry.dedupeKey) {
      if (seenReadKeys.has(formattedEntry.dedupeKey)) {
        continue;
      }
      seenReadKeys.add(formattedEntry.dedupeKey);
    }
    displayedEntries.push(entry);
  }

  displayedEntries.reverse();
  return displayedEntries;
}

export function deriveWorkGroupIconKind(entries: ReadonlyArray<WorkLogEntry>): WorkGroupIconKind {
  let hasAgent = false;
  let hasCommand = false;
  let hasEdit = false;
  let hasFile = false;
  let hasList = false;
  let hasSearch = false;
  let hasSkill = false;
  let hasTodo = false;
  let hasTool = false;
  let hasWebSearch = false;

  for (const entry of getDisplayedWorkEntries(entries)) {
    const toolName = getEntryToolName(entry);
    const formattedEntry = formatWorkEntry(entry);

    if (isMcpToolEntry(entry, toolName)) {
      hasTool = true;
      continue;
    }
    if (entry.itemType === "web_search") {
      hasWebSearch = true;
      continue;
    }
    if (entry.itemType === "collab_agent_tool_call" || (toolName && isSubagentToolName(toolName))) {
      hasAgent = true;
      continue;
    }
    if (toolName === "skill") {
      hasSkill = true;
      continue;
    }
    if (isTodoWriteToolName(toolName)) {
      hasTodo = true;
      continue;
    }
    if (classifyFileChangeOperation(entry)) {
      hasEdit = true;
      continue;
    }
    if (formattedEntry.kind === "search") {
      hasSearch = true;
      continue;
    }
    if (formattedEntry.kind === "read") {
      hasFile = true;
      continue;
    }
    if (formattedEntry.kind === "list") {
      hasList = true;
      continue;
    }
    if (entry.requestKind === "command" || entry.itemType === "command_execution") {
      hasCommand = true;
      continue;
    }
    if (entry.tone === "tool" && deriveWorkEntryGroupKey(entry) !== null) {
      hasTool = true;
    }
  }

  if (hasAgent) return "agent";
  if (hasSkill) return "skill";
  if (hasTodo) return "todo";
  if (hasWebSearch) return "web-search";
  if (hasEdit) return "edit";
  if (hasSearch) return "search";
  if (hasFile) return "file";
  if (hasList) return "list";
  if (hasCommand) return "command";
  if (hasTool) return "tool";
  return "work";
}

export function buildWorkGroupSummary(
  entries: ReadonlyArray<WorkLogEntry>,
  stickyInProgress: boolean,
): string {
  return joinSummaryParts(buildWorkGroupSummaryParts(entries, stickyInProgress));
}

export function buildWorkGroupSummaryParts(
  entries: ReadonlyArray<WorkLogEntry>,
  stickyInProgress: boolean,
): WorkGroupSummaryParts {
  const isInProgress = entries.some((entry) => entry.running) || stickyInProgress;
  const createdFiles = new Set<string>();
  const editedFiles = new Set<string>();
  const deletedFiles = new Set<string>();
  const exploredReadKeys = new Set<string>();
  let unknownCreatedFileCount = 0;
  let unknownEditedFileCount = 0;
  let unknownDeletedFileCount = 0;
  let searchCount = 0;
  let listCount = 0;
  let commandCount = 0;
  let genericToolCallCount = 0;
  let todoWriteCount = 0;
  const todoWriteDetails: string[] = [];
  let webSearchCount = 0;

  for (const entry of getDisplayedWorkEntries(entries)) {
    if (entry.itemType === "web_search") {
      webSearchCount += 1;
      continue;
    }

    const formattedEntry = formatWorkEntry(entry);
    const toolName = getEntryToolName(entry);
    const fileChangeOperation = classifyFileChangeOperation(entry);
    if (fileChangeOperation) {
      if (formattedEntry.detail) {
        if (fileChangeOperation === "create") {
          createdFiles.add(formattedEntry.detail);
          continue;
        }
        if (fileChangeOperation === "delete") {
          deletedFiles.add(formattedEntry.detail);
          continue;
        }
        editedFiles.add(formattedEntry.detail);
        continue;
      }

      if (fileChangeOperation === "create") {
        unknownCreatedFileCount += 1;
        continue;
      }
      if (fileChangeOperation === "delete") {
        unknownDeletedFileCount += 1;
        continue;
      }
      unknownEditedFileCount += 1;
      continue;
    }

    if (isExplorationWorkEntry(entry)) {
      if (formattedEntry.kind === "read") {
        exploredReadKeys.add(formattedEntry.dedupeKey ?? `entry:${entry.id}`);
        continue;
      }
      if (formattedEntry.kind === "search") {
        searchCount += 1;
        continue;
      }
      if (formattedEntry.kind === "list") {
        listCount += 1;
        continue;
      }
    }

    if (isTodoWriteToolName(toolName)) {
      todoWriteCount += 1;
      if (formattedEntry.detail) {
        todoWriteDetails.push(formattedEntry.detail);
      }
      continue;
    }

    if (entry.requestKind === "command" || entry.itemType === "command_execution") {
      commandCount += 1;
      continue;
    }

    if (
      (entry.tone === "tool" || toolName !== null) &&
      entry.itemType !== "collab_agent_tool_call" &&
      deriveWorkEntryGroupKey(entry) !== null
    ) {
      genericToolCallCount += 1;
    }
  }

  const summarySegments = [
    workGroupTextSegment({
      count: createdFiles.size + unknownCreatedFileCount,
      leadingVerb: isInProgress ? "Creating" : "Created",
      trailingVerb: isInProgress ? "creating" : "created",
      singular: "file",
    }),
    workGroupTextSegment({
      count: editedFiles.size + unknownEditedFileCount,
      leadingVerb: isInProgress ? "Editing" : "Edited",
      trailingVerb: isInProgress ? "editing" : "edited",
      singular: "file",
    }),
    workGroupTextSegment({
      count: deletedFiles.size + unknownDeletedFileCount,
      leadingVerb: isInProgress ? "Deleting" : "Deleted",
      trailingVerb: isInProgress ? "deleting" : "deleted",
      singular: "file",
    }),
  ].filter((segment): segment is WorkGroupSegment => segment !== null);

  const explorationParts: string[] = [];
  if (exploredReadKeys.size > 0) {
    explorationParts.push(pluralizeCount(exploredReadKeys.size, "file"));
  }
  if (searchCount > 0) {
    explorationParts.push(pluralizeCount(searchCount, "search"));
  }
  if (listCount > 0) {
    explorationParts.push(pluralizeCount(listCount, "list"));
  }
  if (explorationParts.length > 0) {
    const details = explorationParts.join(", ");
    summarySegments.push({
      leadingVerb: isInProgress ? "Exploring" : "Explored",
      leadingRest: details,
      trailing: `${isInProgress ? "exploring" : "explored"} ${details}`,
    });
  }

  const commandSegment = workGroupTextSegment({
    count: commandCount,
    leadingVerb: isInProgress ? "Running" : "Ran",
    trailingVerb: isInProgress ? "running" : "ran",
    singular: "command",
  });
  if (commandSegment) {
    summarySegments.push(commandSegment);
  }

  const toolCallSegment = workGroupTextSegment({
    count: genericToolCallCount,
    leadingVerb: isInProgress ? "Calling" : "Called",
    trailingVerb: isInProgress ? "calling" : "called",
    singular: "tool",
  });
  if (toolCallSegment) {
    summarySegments.push(toolCallSegment);
  }

  if (todoWriteCount > 0) {
    const todoLabel =
      todoWriteCount === 1 ? (todoWriteDetails[0] ?? "todo list") : `${todoWriteCount} todo lists`;
    summarySegments.push({
      leadingVerb: isInProgress ? "Updating" : "Updated",
      leadingRest: todoLabel,
      trailing: `${isInProgress ? "updating" : "updated"} ${todoLabel}`,
    });
  }

  const webSearchSegment = workGroupTextSegment({
    count: webSearchCount,
    leadingVerb: isInProgress ? "Searching web" : "Searched web",
    trailingVerb: isInProgress ? "searching web" : "searched web",
    singular: "time",
    plural: "times",
  });
  if (webSearchSegment) {
    summarySegments.push(webSearchSegment);
  }

  if (summarySegments.length > 0) {
    return joinWorkGroupSummarySegments(summarySegments);
  }

  if (entries.length === 1) {
    const formattedEntry = formatWorkEntry(entries[0]!);
    const action = formattedEntry.action;
    const detail = formattedEntry.detail ?? "";
    if ((action + detail).trim().length > 0) {
      return { leadingVerb: action, rest: detail };
    }
  }

  return { leadingVerb: isInProgress ? "Working" : "Worked", rest: "" };
}

export function deriveWorkEntryGroupKey(entry: WorkLogEntry): string | null {
  const isPlainStatusUpdate = entry.label.trim().toLowerCase() === "status update";
  const toolName = getEntryToolName(entry);
  if (entry.itemType === "web_search") {
    return "web-search";
  }
  if (isFileChangeWorkEntry(entry)) {
    return "edit";
  }
  if (isExplorationWorkEntry(entry)) {
    return "explore";
  }
  if (entry.requestKind === "command" || entry.itemType === "command_execution") {
    return "command";
  }
  if (entry.itemType === "collab_agent_tool_call") {
    const formatted = formatWorkEntry(entry);
    return formatted.detail ? `subagent:${formatted.detail}` : `subagent:${entry.id}`;
  }
  if (entry.itemType === "mcp_tool_call" || entry.itemType === "dynamic_tool_call") {
    return "tool";
  }
  if (isPlainStatusUpdate && toolName) {
    return "tool";
  }
  if (isPlainStatusUpdate) {
    return null;
  }

  const normalized = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  return normalized.length > 0 ? `other:${normalized.toLowerCase()}` : null;
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  completionDividerBeforeEntryId: string | null;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work" || timelineEntry.kind === "reasoning") {
      let cursor = index + 1;
      const mixedEntries: Array<
        Extract<TimelineEntry, { kind: "work" }> | Extract<TimelineEntry, { kind: "reasoning" }>
      > = [timelineEntry];
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (!nextEntry || (nextEntry.kind !== "work" && nextEntry.kind !== "reasoning")) {
          break;
        }
        mixedEntries.push(nextEntry);
        cursor += 1;
      }
      nextRows.push(
        ...deriveMixedWorkAndReasoningRows(mixedEntries, {
          stickyTailInProgress: input.isWorking && cursor >= input.timelineEntries.length,
        }),
      );
      index = cursor - 1;
      continue;
    }

    switch (timelineEntry.kind) {
      case "proposed-plan":
        nextRows.push({
          kind: "proposed-plan",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          proposedPlan: timelineEntry.proposedPlan,
        });
        continue;
      case "message":
        nextRows.push({
          kind: "message",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          message: timelineEntry.message,
          durationStart:
            durationStartByMessageId.get(timelineEntry.message.id) ??
            timelineEntry.message.createdAt,
          showCompletionDivider:
            timelineEntry.message.role === "assistant" &&
            input.completionDividerBeforeEntryId === timelineEntry.id,
        });
        continue;
    }
  }

  if (input.isWorking) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

function deriveMixedWorkAndReasoningRows(
  entries: ReadonlyArray<
    Extract<TimelineEntry, { kind: "work" }> | Extract<TimelineEntry, { kind: "reasoning" }>
  >,
  options: {
    stickyTailInProgress: boolean;
  },
): MessagesTimelineRow[] {
  const workEntries = entries.flatMap((entry) => (entry.kind === "work" ? [entry.entry] : []));
  const hasReasoningEntries = entries.some((entry) => entry.kind === "reasoning");
  if (workEntries.length === 0) {
    return entries.flatMap((entry) =>
      entry.kind === "reasoning"
        ? [
            {
              kind: "reasoning" as const,
              id: entry.id,
              createdAt: entry.createdAt,
              reasoning: entry.reasoning,
            },
          ]
        : [],
    );
  }

  const workRows = deriveNestedWorkRows(workEntries, options);
  if (hasReasoningEntries && workRows.every((row) => row.childRows.length === 0)) {
    type InlineRowEntry = NonNullable<WorkTimelineRow["inlineEntries"]>[number];
    const workEntryRowIndex = new Map<string, number>();
    for (let rowIndex = 0; rowIndex < workRows.length; rowIndex += 1) {
      const workRow = workRows[rowIndex];
      if (!workRow) {
        continue;
      }
      for (const workEntry of workRow.groupedEntries) {
        workEntryRowIndex.set(workEntry.id, rowIndex);
      }
    }

    const inlineEntriesByRow = workRows.map(() => [] as InlineRowEntry[]);
    let pendingReasoningEntries: InlineRowEntry[] = [];
    let lastRowIndex: number | null = null;

    for (const entry of entries) {
      if (entry.kind === "reasoning") {
        pendingReasoningEntries.push({
          kind: "reasoning",
          id: entry.id,
          reasoning: entry.reasoning,
        });
        continue;
      }

      const rowIndex = workEntryRowIndex.get(entry.entry.id);
      if (rowIndex === undefined) {
        continue;
      }
      if (pendingReasoningEntries.length > 0) {
        inlineEntriesByRow[rowIndex]?.push(...pendingReasoningEntries);
        pendingReasoningEntries = [];
      }
      inlineEntriesByRow[rowIndex]?.push({
        kind: "work",
        id: entry.id,
        entry: entry.entry,
      });
      lastRowIndex = rowIndex;
    }

    if (pendingReasoningEntries.length > 0 && lastRowIndex !== null) {
      inlineEntriesByRow[lastRowIndex]?.push(...pendingReasoningEntries);
    }

    return workRows.map((workRow, rowIndex) => {
      const inlineEntries = inlineEntriesByRow[rowIndex];
      if (!inlineEntries || inlineEntries.length === 0) {
        return workRow;
      }
      return Object.assign({}, workRow, { inlineEntries });
    });
  }

  const fallbackRows: MessagesTimelineRow[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    if (entry.kind === "reasoning") {
      fallbackRows.push({
        kind: "reasoning",
        id: entry.id,
        createdAt: entry.createdAt,
        reasoning: entry.reasoning,
      });
      continue;
    }

    let cursor = index + 1;
    const contiguousWorkEntries = [entry.entry];
    while (cursor < entries.length) {
      const nextEntry = entries[cursor];
      if (!nextEntry || nextEntry.kind !== "work") {
        break;
      }
      contiguousWorkEntries.push(nextEntry.entry);
      cursor += 1;
    }
    fallbackRows.push(
      ...deriveNestedWorkRows(contiguousWorkEntries, {
        stickyTailInProgress: options.stickyTailInProgress && cursor >= entries.length,
      }),
    );
    index = cursor - 1;
  }
  return fallbackRows;
}

function deriveNestedWorkRows(
  entries: ReadonlyArray<WorkLogEntry>,
  options: {
    stickyTailInProgress: boolean;
  },
): WorkTimelineRow[] {
  if (entries.length === 0) {
    return [];
  }

  const parentItemIds = new Set(
    entries
      .map((entry) => entry.itemId)
      .filter((itemId): itemId is string => typeof itemId === "string" && itemId.length > 0),
  );
  const childEntryIds = new Set<string>();
  const childrenByParentItemId = new Map<string, WorkLogEntry[]>();

  for (const entry of entries) {
    if (!entry.parentItemId || !parentItemIds.has(entry.parentItemId)) {
      continue;
    }
    childEntryIds.add(entry.id);
    const siblings = childrenByParentItemId.get(entry.parentItemId);
    if (siblings) {
      siblings.push(entry);
    } else {
      childrenByParentItemId.set(entry.parentItemId, [entry]);
    }
  }

  const topLevelEntries = entries.filter((entry) => !childEntryIds.has(entry.id));
  const rows: WorkTimelineRow[] = [];

  const hasNestedChildren = (entry: WorkLogEntry): boolean =>
    typeof entry.itemId === "string" && (childrenByParentItemId.get(entry.itemId)?.length ?? 0) > 0;

  const contiguousTopLevelToolGroupKey = (entry: WorkLogEntry): "tool" | null => {
    if (
      entry.itemType === "collab_agent_tool_call" ||
      hasNestedChildren(entry) ||
      (entry.tone !== "tool" && deriveWorkEntryGroupKey(entry) === null)
    ) {
      return null;
    }
    return "tool";
  };

  for (let index = 0; index < topLevelEntries.length; index += 1) {
    const entry = topLevelEntries[index]!;
    const groupedEntries = [entry];
    const groupKey = contiguousTopLevelToolGroupKey(entry);

    let cursor = index + 1;
    if (groupKey !== null) {
      while (cursor < topLevelEntries.length) {
        const nextEntry = topLevelEntries[cursor];
        if (!nextEntry) {
          break;
        }
        if (contiguousTopLevelToolGroupKey(nextEntry) !== groupKey) {
          break;
        }
        groupedEntries.push(nextEntry);
        cursor += 1;
      }
    }

    const primaryEntry = groupedEntries[0]!;
    const childEntries =
      groupedEntries.length === 1 && primaryEntry.itemId
        ? (childrenByParentItemId.get(primaryEntry.itemId) ?? [])
        : [];

    rows.push({
      kind: "work",
      id: primaryEntry.id,
      expansionId: deriveWorkRowExpansionId(primaryEntry),
      createdAt: primaryEntry.createdAt,
      groupedEntries,
      stickyInProgress: options.stickyTailInProgress && cursor >= topLevelEntries.length,
      childRows: deriveNestedWorkRows(childEntries, { stickyTailInProgress: false }),
    });

    index = cursor - 1;
  }

  return rows;
}

export function estimateMessagesTimelineRowHeight(
  row: MessagesTimelineRow,
  input: {
    timelineWidthPx: number | null;
    expandedWorkGroups?: Readonly<Record<string, boolean>>;
    turnDiffSummaryByAssistantMessageId?: ReadonlyMap<MessageId, TurnDiffSummary>;
  },
): number {
  switch (row.kind) {
    case "work":
      return estimateWorkRowHeight(row, input);
    case "proposed-plan":
      return estimateTimelineProposedPlanHeight(row.proposedPlan);
    case "reasoning":
      return estimateReasoningRowHeight(row.reasoning.text);
    case "working":
      return 40;
    case "message": {
      let estimate = estimateTimelineMessageHeight(row.message, {
        timelineWidthPx: input.timelineWidthPx,
      });
      const turnDiffSummary = input.turnDiffSummaryByAssistantMessageId?.get(row.message.id);
      if (turnDiffSummary && turnDiffSummary.files.length > 0) {
        estimate += estimateChangedFilesCardHeight(turnDiffSummary);
      }
      return estimate;
    }
  }
}

function estimateReasoningRowHeight(text: string): number {
  const lineCount = Math.max(1, text.split(/\r?\n/g).length);
  return 36 + Math.min(lineCount * 14, 140);
}

export const MAX_RENDERED_WORK_GROUP_ITEMS = 80;

function estimateWorkRowHeight(
  row: WorkTimelineRow,
  input: {
    expandedWorkGroups?: Readonly<Record<string, boolean>>;
  },
): number {
  const estimateExpandedWorkEntryHeight = (entry: WorkLogEntry): number => {
    const isFileChange = isFileChangeWorkEntry(entry);
    const diff = isFileChange ? parseEditDiff(entry.output, entry.detail) : null;
    if (diff) {
      // header (28px) + lines (20px each) + border/padding (8px) + outer margin
      return 16 + 26 + 28 + diff.lines.length * 20 + 8;
    }
    const outputLines = estimateOutputLineCount(entry.output);
    // max-h-48 = 192px cap in the UI for a single entry's output
    return 16 + 26 + Math.min(Math.max(outputLines, 1) * 18, 192);
  };

  const nestedRowsHeight = (childRows: ReadonlyArray<WorkTimelineRow>): number =>
    childRows.reduce((total, childRow) => total + estimateWorkRowHeight(childRow, input) + 6, 0);

  const estimateGroupedWorkListEntryHeight = (entry: WorkLogEntry): number => {
    if (entry.running) {
      return 22;
    }
    if (entry.itemType === "web_search") {
      return 26;
    }
    const isEntryExpanded =
      input.expandedWorkGroups?.[getGroupedWorkEntryExpansionKey(entry.id)] ?? false;
    return isEntryExpanded ? estimateExpandedWorkEntryHeight(entry) : 26;
  };

  const estimateGroupedInlineItemsHeight = (
    inlineEntries: NonNullable<WorkTimelineRow["inlineEntries"]>,
  ): number =>
    inlineEntries.reduce((total, item) => {
      if (item.kind === "reasoning") {
        return total + estimateReasoningRowHeight(item.reasoning.text) + 6;
      }
      return total + estimateGroupedWorkListEntryHeight(item.entry);
    }, 0);

  if (row.childRows.length > 0) {
    const isExpanded = isWorkRowExpanded(row, input.expandedWorkGroups);
    if (!isExpanded) {
      return 16 + 26;
    }
    const visibleChildRows = row.childRows.slice(-MAX_RENDERED_WORK_GROUP_ITEMS);
    return 16 + 26 + nestedRowsHeight(visibleChildRows) + 8;
  }

  const displayedEntries = getDisplayedWorkEntries(row.groupedEntries);
  const entryCount = displayedEntries.length;

  if (!shouldRenderFlatWorkRowAsGroup(row) && entryCount === 1) {
    const entry = displayedEntries[0]!;
    if (!entry.running) {
      const isExpanded = isStandaloneWorkEntryExpanded(row, input.expandedWorkGroups);
      if (isExpanded) {
        return estimateExpandedWorkEntryHeight(entry);
      }
      return 16 + 26;
    }
    return 16 + 24;
  }

  const isExpanded =
    entryCount === 1 && !row.inlineEntries
      ? isStandaloneWorkEntryExpanded(row, input.expandedWorkGroups)
      : isWorkRowExpanded(row, input.expandedWorkGroups);
  if (!isExpanded) {
    return 16 + 26;
  }

  if (row.inlineEntries) {
    const visibleInlineEntries = row.inlineEntries.slice(-MAX_RENDERED_WORK_GROUP_ITEMS);
    return 16 + 26 + estimateGroupedInlineItemsHeight(visibleInlineEntries) + 8;
  }

  const visibleEntries = displayedEntries.slice(-MAX_RENDERED_WORK_GROUP_ITEMS);
  const visibleEntriesHeight = visibleEntries.reduce((total, entry) => {
    return total + estimateGroupedWorkListEntryHeight(entry);
  }, 0);
  return 16 + 26 + visibleEntriesHeight + 8;
}

function estimateOutputLineCount(output: unknown): number {
  return summarizeToolOutput(output).lineCount;
}

function estimateTimelineProposedPlanHeight(proposedPlan: ProposedPlan): number {
  const estimatedLines = Math.max(1, Math.ceil(proposedPlan.planMarkdown.length / 72));
  return 120 + Math.min(estimatedLines * 22, 880);
}

const CHANGED_FILES_COLLAPSED_LIMIT = 5;

function estimateChangedFilesCardHeight(turnDiffSummary: TurnDiffSummary): number {
  // Card chrome (header + borders + padding) plus a flat row per visible file.
  // When the file list exceeds the pagination limit, default to the collapsed
  // height (limit rows + a "Show all Files" toggle row); the virtualizer
  // re-measures after expansion.
  const totalFiles = turnDiffSummary.files.length;
  if (totalFiles > CHANGED_FILES_COLLAPSED_LIMIT) {
    return 68 + CHANGED_FILES_COLLAPSED_LIMIT * 24 + 24;
  }
  return 68 + totalFiles * 24;
}
