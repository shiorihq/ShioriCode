import { type MessageId } from "contracts";
import { type TimelineEntry, type WorkLogEntry } from "../../session-logic";
import { buildTurnDiffTree, type TurnDiffTreeNode } from "../../lib/turnDiffTree";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { estimateTimelineMessageHeight } from "../timelineHeight";
import { parseEditDiff } from "./InlineEditDiff";
import { summarizeToolOutput } from "./toolOutput";
import {
  extractStructuredProviderToolData,
  getProviderToolInputPath,
  getProviderToolInputQuery,
  isSubagentToolName,
  isUserInputToolName,
  normalizeProviderToolName,
} from "shared/providerTool";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 5;

export type WorkEntryDisplayKind = "read" | "list" | "search" | "edit" | "command" | "other";

export interface FormattedWorkEntry {
  kind: WorkEntryDisplayKind;
  action: string;
  detail: string | null;
  monospace: boolean;
  dedupeKey: string | null;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export interface WorkTimelineRow {
  kind: "work";
  id: string;
  createdAt: string;
  groupedEntries: WorkLogEntry[];
  stickyInProgress: boolean;
  childRows: WorkTimelineRow[];
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
  const explicit = expandedWorkGroups?.[row.id];
  if (explicit !== undefined) {
    return explicit;
  }
  // Default: always collapsed.  The summary header shows a shimmer when
  // in-progress so the user can tell work is happening without being forced
  // to watch every streaming item.  They can expand manually if curious.
  return false;
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

function normalizeWorkEntryTitle(entry: WorkLogEntry): string {
  return normalizeCompactToolLabel(entry.toolTitle ?? entry.label)
    .replace(/[._-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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
  if (!detail) {
    return null;
  }

  const match = /^([A-Za-z][A-Za-z0-9 _-]{1,48}):\s*[[{"]/u.exec(detail.trim());
  return normalizeProviderToolName(match?.[1] ?? null);
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
  const directToolName = normalizeProviderToolName(
    extractStructuredProviderToolData(entry.output)?.toolName ?? null,
  );
  if (directToolName) {
    return directToolName;
  }

  return parseToolNameFromDetail(entry.detail);
}

function getEntryToolInput(entry: WorkLogEntry): Record<string, unknown> | null {
  const directInput = extractStructuredProviderToolData(entry.output)?.input ?? null;
  if (directInput) {
    return directInput;
  }

  return parseToolInputFromDetail(entry.detail);
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
    return null;
  }

  const normalizedTargets = targets
    .map((target) => asTrimmedString(target))
    .filter((target): target is string => target !== null);
  return normalizedTargets.length > 0 ? normalizedTargets.join(", ") : null;
}

const COMMAND_TOKEN_PATTERN = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`|[^\s]+/g;
const SEARCH_COMMANDS = new Set(["ack", "ag", "fd", "find", "grep", "rg"]);
const READ_COMMANDS = new Set(["bat", "cat", "head", "less", "more", "read", "sed", "tail"]);
const LIST_COMMANDS = new Set(["dir", "ls", "pwd", "stat", "tree"]);

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
  const subagentTaskDetail = formatSubagentTaskDetail(providerToolInput);
  const skillToolDetail = formatSkillToolDetail(providerToolInput);
  const userInputToolDetail = formatUserInputToolDetail(providerToolInput);
  const planToolDetail = formatPlanToolDetail(providerToolInput);
  const agentTargetDetail = formatAgentTargetDetail(providerToolInput);

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
      action: running ? "Launching skill" : "Launched skill",
      detail: skillToolDetail ?? explicitDetail,
      monospace: false,
      dedupeKey: null,
    };
  }

  if (providerToolName === "wait agent") {
    return {
      kind: "other",
      action: running ? "Waiting for agent" : "Waited for agent",
      detail: agentTargetDetail ?? explicitDetail,
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

  if (providerToolName && isUserInputToolName(providerToolName)) {
    return {
      kind: "other",
      action: running ? "Requesting input" : "Requested input",
      detail: userInputToolDetail ?? explicitDetail,
      monospace: false,
      dedupeKey: null,
    };
  }

  if (providerToolName === "write") {
    return {
      kind: "edit",
      action: running ? "Writing" : "Wrote",
      detail: providerToolPath ?? explicitDetail,
      monospace: true,
      dedupeKey: providerToolPath ? `write:${providerToolPath}` : null,
    };
  }

  if (entry.requestKind === "file-change" || entry.itemType === "file_change") {
    return {
      kind: "edit",
      action: running ? "Editing" : "Edited",
      detail: explicitDetail,
      monospace: true,
      dedupeKey: null,
    };
  }

  if (entry.itemType === "web_search") {
    return {
      kind: "search",
      action: running ? "Searching for" : "Searched for",
      detail: explicitDetail || entry.command || null,
      monospace: false,
      dedupeKey: null,
    };
  }

  if (providerToolKind === "list") {
    return {
      kind: "list",
      action: running ? "Listing" : "Listed",
      detail: providerToolPath ?? explicitDetail,
      monospace: true,
      dedupeKey: null,
    };
  }

  if (providerToolKind === "read") {
    return {
      kind: "read",
      action: running ? "Reading" : "Read",
      detail: providerToolPath ?? explicitDetail,
      monospace: true,
      dedupeKey: providerToolPath
        ? `read:${providerToolPath}`
        : explicitDetail
          ? `read:${explicitDetail}`
          : null,
    };
  }

  if (providerToolKind === "search") {
    const providerSearchDetail =
      providerToolQuery && providerToolPath
        ? `${providerToolQuery} in ${providerToolPath}`
        : (providerToolQuery ?? providerToolPath ?? explicitDetail ?? entry.command ?? null);
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
    detail: entry.command || explicitDetail || null,
    monospace: false,
    dedupeKey: null,
  };
}

function pluralizeCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function getDisplayedWorkEntries(entries: ReadonlyArray<WorkLogEntry>): WorkLogEntry[] {
  if (entries.length <= 1 || deriveWorkEntryGroupKey(entries[0]!) !== "explore") {
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

export function buildWorkGroupSummary(
  entries: ReadonlyArray<WorkLogEntry>,
  stickyInProgress: boolean,
): string {
  const primaryGroupKey = deriveWorkEntryGroupKey(entries[0]!);
  const isInProgress = entries.some((entry) => entry.running) || stickyInProgress;

  switch (primaryGroupKey) {
    case "edit": {
      const editedFiles = new Set<string>();
      let unknownFileCount = 0;

      for (const entry of entries) {
        const formattedEntry = formatWorkEntry(entry);
        if (formattedEntry.detail) {
          editedFiles.add(formattedEntry.detail);
        } else {
          unknownFileCount += 1;
        }
      }

      const editedFileCount = editedFiles.size + unknownFileCount;
      if (editedFileCount === 0) {
        return isInProgress ? "Editing" : "Edited";
      }

      return `${isInProgress ? "Editing" : "Edited"} ${pluralizeCount(editedFileCount, "file")}`;
    }
    case "command": {
      const commandCount = getDisplayedWorkEntries(entries).length;
      const commandLabel =
        commandCount <= 1
          ? isInProgress
            ? "Executing command"
            : "Executed command"
          : `${isInProgress ? "Executing" : "Executed"} ${pluralizeCount(commandCount, "command")}`;
      return commandLabel;
    }
    case "explore": {
      const displayedEntries = getDisplayedWorkEntries(entries);
      const readKeys = new Set<string>();
      let searchCount = 0;
      let listCount = 0;

      for (const entry of displayedEntries) {
        const formattedEntry = formatWorkEntry(entry);
        if (formattedEntry.kind === "read") {
          readKeys.add(formattedEntry.dedupeKey ?? `entry:${entry.id}`);
          continue;
        }
        if (formattedEntry.kind === "search") {
          searchCount += 1;
          continue;
        }
        if (formattedEntry.kind === "list") {
          listCount += 1;
        }
      }

      const countParts: string[] = [];
      if (readKeys.size > 0) {
        countParts.push(pluralizeCount(readKeys.size, "file"));
      }
      if (searchCount > 0) {
        countParts.push(pluralizeCount(searchCount, "search"));
      }
      if (listCount > 0) {
        countParts.push(pluralizeCount(listCount, "list"));
      }

      if (countParts.length === 0 || (isInProgress && displayedEntries.length === 1)) {
        return isInProgress ? "Exploring" : "Explored";
      }

      return `${isInProgress ? "Exploring" : "Explored"} ${countParts.join(", ")}`;
    }
    default:
      return isInProgress ? "Working" : "Worked";
  }
}

export function deriveWorkEntryGroupKey(entry: WorkLogEntry): string | null {
  if (entry.label.trim().toLowerCase() === "status update") {
    return null;
  }
  if (entry.requestKind === "file-change" || entry.itemType === "file_change") {
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

    switch (timelineEntry.kind) {
      case "work": {
        let cursor = index + 1;
        const workEntries = [timelineEntry.entry];
        while (cursor < input.timelineEntries.length) {
          const nextEntry = input.timelineEntries[cursor];
          if (!nextEntry || nextEntry.kind !== "work") break;
          workEntries.push(nextEntry.entry);
          cursor += 1;
        }
        nextRows.push(
          ...deriveNestedWorkRows(workEntries, {
            stickyTailInProgress: input.isWorking && cursor >= input.timelineEntries.length,
          }),
        );
        index = cursor - 1;
        continue;
      }
      case "proposed-plan":
        nextRows.push({
          kind: "proposed-plan",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          proposedPlan: timelineEntry.proposedPlan,
        });
        continue;
      case "reasoning":
        nextRows.push({
          kind: "reasoning",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          reasoning: timelineEntry.reasoning,
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

  for (let index = 0; index < topLevelEntries.length; index += 1) {
    const entry = topLevelEntries[index]!;
    const groupedEntries = [entry];
    const groupKey = deriveWorkEntryGroupKey(entry);
    const hasNestedChildren =
      typeof entry.itemId === "string" &&
      (childrenByParentItemId.get(entry.itemId)?.length ?? 0) > 0;

    let cursor = index + 1;
    if (!hasNestedChildren) {
      while (cursor < topLevelEntries.length) {
        const nextEntry = topLevelEntries[cursor];
        if (!nextEntry) {
          break;
        }
        if (groupKey === null || deriveWorkEntryGroupKey(nextEntry) !== groupKey) {
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
    allDirectoriesExpandedByTurnId?: Readonly<Record<string, boolean>>;
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
        estimate += estimateChangedFilesCardHeight(
          turnDiffSummary,
          input.allDirectoriesExpandedByTurnId?.[turnDiffSummary.turnId] ?? false,
        );
      }
      return estimate;
    }
  }
}

function estimateReasoningRowHeight(text: string): number {
  const lineCount = Math.max(1, text.split(/\r?\n/g).length);
  return 36 + Math.min(lineCount * 14, 140);
}

function estimateWorkRowHeight(
  row: WorkTimelineRow,
  input: {
    expandedWorkGroups?: Readonly<Record<string, boolean>>;
  },
): number {
  const estimateExpandedWorkEntryHeight = (entry: WorkLogEntry): number => {
    const isFileChange = entry.requestKind === "file-change" || entry.itemType === "file_change";
    const diff = isFileChange ? parseEditDiff(entry.output, entry.detail) : null;
    if (diff) {
      // header (28px) + lines (20px each) + border/padding (8px) + outer margin
      return 16 + 26 + 28 + diff.lines.length * 20 + 8;
    }
    const outputLines = estimateOutputLineCount(entry.output);
    // max-h-48 = 192px cap in the UI
    return 16 + 26 + Math.min(Math.max(outputLines, 1) * 18, 192);
  };

  const nestedRowsHeight = (childRows: ReadonlyArray<WorkTimelineRow>): number =>
    childRows.reduce((total, childRow) => total + estimateWorkRowHeight(childRow, input) + 6, 0);

  if (row.childRows.length > 0) {
    const isExpanded = isWorkRowExpanded(row, input.expandedWorkGroups);
    return 16 + 26 + (isExpanded ? nestedRowsHeight(row.childRows) + 8 : 0);
  }

  const displayedEntries = getDisplayedWorkEntries(row.groupedEntries);
  const entryCount = displayedEntries.length;

  if (entryCount === 1) {
    const entry = displayedEntries[0]!;
    if (!entry.running) {
      const isExpanded = input.expandedWorkGroups?.[row.id] ?? false;
      if (isExpanded) {
        return estimateExpandedWorkEntryHeight(entry);
      }
      return 16 + 26;
    }
    return 16 + 24;
  }

  const isExpanded = isWorkRowExpanded(row, input.expandedWorkGroups);
  const visibleEntries = isExpanded ? displayedEntries.slice(0, MAX_VISIBLE_WORK_LOG_ENTRIES) : [];
  const showMoreToggleHeight = isExpanded && entryCount > MAX_VISIBLE_WORK_LOG_ENTRIES ? 24 : 0;
  const visibleEntriesHeight = visibleEntries.reduce((total, entry) => {
    if (entry.running) {
      return total + 22;
    }
    const isEntryExpanded =
      input.expandedWorkGroups?.[getGroupedWorkEntryExpansionKey(entry.id)] ?? false;
    return total + (isEntryExpanded ? estimateExpandedWorkEntryHeight(entry) : 26);
  }, 0);
  return 16 + 26 + visibleEntriesHeight + showMoreToggleHeight;
}

function estimateOutputLineCount(output: unknown): number {
  return summarizeToolOutput(output).lineCount;
}

function estimateTimelineProposedPlanHeight(proposedPlan: ProposedPlan): number {
  const estimatedLines = Math.max(1, Math.ceil(proposedPlan.planMarkdown.length / 72));
  return 120 + Math.min(estimatedLines * 22, 880);
}

function estimateChangedFilesCardHeight(
  turnDiffSummary: TurnDiffSummary,
  allDirectoriesExpanded: boolean,
): number {
  const treeNodes = buildTurnDiffTree(turnDiffSummary.files);
  const visibleNodeCount = countVisibleTurnDiffTreeNodes(treeNodes, allDirectoriesExpanded);

  // Card chrome: top/bottom padding, header row, and tree spacing.
  return 60 + visibleNodeCount * 25;
}

function countVisibleTurnDiffTreeNodes(
  nodes: ReadonlyArray<TurnDiffTreeNode>,
  allDirectoriesExpanded: boolean,
): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.kind === "directory" && allDirectoriesExpanded) {
      count += countVisibleTurnDiffTreeNodes(node.children, allDirectoriesExpanded);
    }
  }
  return count;
}
