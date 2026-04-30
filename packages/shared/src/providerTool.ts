import type { ToolLifecycleItemType } from "contracts";

export type ProviderToolRequestKind = "command" | "file-read" | "file-change";

const COMMAND_TOOL_NAMES = new Set([
  "bash",
  "command",
  "exec command",
  "exec_command",
  "execute command",
  "shell",
  "terminal",
]);

const FILE_CHANGE_TOOL_NAMES = new Set([
  "apply patch",
  "apply_patch",
  "create file",
  "create_file",
  "delete file",
  "delete_file",
  "edit",
  "file write",
  "multi edit",
  "multiedit",
  "notebook edit",
  "notebookedit",
  "replace",
  "str replace file",
  "update file",
  "write",
  "write file",
  "write_file",
]);

const FILE_READ_TOOL_NAMES = new Set([
  "cat",
  "find",
  "glob",
  "grep",
  "list directory",
  "ls",
  "read",
  "read file",
  "rg",
  "ripgrep",
  "search",
  "view",
]);

const SUBAGENT_TOOL_NAMES = new Set([
  "agent",
  "close agent",
  "resume agent",
  "send input",
  "send message",
  "spawn agent",
  "subagent",
  "task",
  "wait",
  "wait agent",
]);
const USER_INPUT_TOOL_NAMES = new Set(["ask user", "request user input"]);
const TODO_LIST_TOOL_NAMES = new Set([
  "set todo list",
  "todo write",
  "todowrite",
  "update todo list",
  "update todos",
]);
const MAX_SNAPSHOT_STRING_LENGTH = 20_000;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  try {
    return asObject(JSON.parse(value));
  } catch {
    return null;
  }
}

function toTitleCase(value: string): string {
  return value.replace(/\b\w/g, (character) => character.toUpperCase());
}

function truncate(value: string, maxLength = 400): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function firstQuestionPrompt(input: Record<string, unknown> | null): string | null {
  const directQuestion = asTrimmedString(input?.question);
  if (directQuestion) {
    return directQuestion;
  }

  const questions = Array.isArray(input?.questions) ? input.questions : null;
  const firstQuestion = questions?.[0] ? asObject(questions[0]) : null;
  return asTrimmedString(firstQuestion?.question);
}

function joinedTargets(input: Record<string, unknown> | null): string | null {
  const directTarget =
    asTrimmedString(input?.target) ??
    asTrimmedString(input?.task_id) ??
    asTrimmedString(input?.taskId);
  if (directTarget) {
    return directTarget;
  }

  const targets = Array.isArray(input?.targets) ? input.targets : null;
  if (!targets || targets.length === 0) {
    return null;
  }

  const normalized = targets
    .map((target) => asTrimmedString(target))
    .filter((target): target is string => target !== null);
  return normalized.length > 0 ? normalized.join(", ") : null;
}

function inferTopLevelToolName(record: Record<string, unknown>): string | null {
  const type = asTrimmedString(record.type);
  if (!type) {
    return null;
  }

  const normalizedType = normalizeProviderToolName(type);
  if (normalizedType === "web search") {
    return type;
  }

  return null;
}

function buildTopLevelToolInput(
  record: Record<string, unknown>,
  toolName: string,
): Record<string, unknown> | null {
  const normalizedToolName = normalizeProviderToolName(toolName);

  if (normalizedToolName === "web search") {
    const query = asTrimmedString(record.query);
    const action = asObject(record.action);
    const actionType = asTrimmedString(action?.type);
    const actionValue = asTrimmedString(action?.value);

    if (!query && !action && !actionType && !actionValue) {
      return null;
    }

    return {
      ...(query ? { query } : {}),
      ...(action ? { action } : {}),
      ...(actionType ? { action_type: actionType } : {}),
      ...(actionValue ? { action_value: actionValue } : {}),
    };
  }

  return null;
}

function snapshotUnknown(value: unknown, depth = 0): unknown {
  if (depth >= 6) {
    return "[truncated]";
  }

  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "string") {
    if (value.length <= MAX_SNAPSHOT_STRING_LENGTH) {
      return value;
    }

    return `${value.slice(0, MAX_SNAPSHOT_STRING_LENGTH)}[truncated ${value.length - MAX_SNAPSHOT_STRING_LENGTH} chars]`;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => snapshotUnknown(entry, depth + 1));
  }

  const record = asObject(value);
  if (!record) {
    return String(value);
  }

  const next: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(record).slice(0, 100)) {
    next[key] = snapshotUnknown(entryValue, depth + 1);
  }
  return next;
}

export interface StructuredProviderToolData {
  readonly toolName: string;
  readonly input: Record<string, unknown> | null;
  readonly result?: unknown;
  readonly item?: Record<string, unknown> | null;
}

export function normalizeProviderToolName(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function isSubagentToolName(toolName: string | null | undefined): boolean {
  const normalized = normalizeProviderToolName(toolName);
  if (!normalized) {
    return false;
  }

  return (
    SUBAGENT_TOOL_NAMES.has(normalized) ||
    normalized.includes("subagent") ||
    normalized.includes("agent task")
  );
}

export function isUserInputToolName(toolName: string | null | undefined): boolean {
  const normalized = normalizeProviderToolName(toolName);
  return normalized ? USER_INPUT_TOOL_NAMES.has(normalized) : false;
}

export function isTodoListToolName(toolName: string | null | undefined): boolean {
  const normalized = normalizeProviderToolName(toolName);
  return normalized ? TODO_LIST_TOOL_NAMES.has(normalized) : false;
}

export function getProviderToolInputPath(input: Record<string, unknown> | null): string | null {
  return (
    asTrimmedString(input?.file_path) ??
    asTrimmedString(input?.path) ??
    asTrimmedString(input?.filePath) ??
    asTrimmedString(input?.relativePath) ??
    asTrimmedString(input?.filename) ??
    asTrimmedString(input?.notebook_path) ??
    asTrimmedString(input?.notebookPath)
  );
}

export function getProviderToolInputQuery(input: Record<string, unknown> | null): string | null {
  const explicitQuery =
    asTrimmedString(input?.query) ??
    asTrimmedString(input?.pattern) ??
    asTrimmedString(input?.q) ??
    asTrimmedString(input?.search);
  if (explicitQuery) {
    return explicitQuery;
  }

  return getProviderToolInputActionType(input) === "search"
    ? getProviderToolInputActionValue(input)
    : null;
}

export function getProviderToolInputActionType(
  input: Record<string, unknown> | null,
): string | null {
  return (
    asTrimmedString(input?.action_type) ??
    asTrimmedString(input?.actionType) ??
    asTrimmedString(asObject(input?.action)?.type)
  );
}

export function getProviderToolInputActionValue(
  input: Record<string, unknown> | null,
): string | null {
  return (
    asTrimmedString(input?.action_value) ??
    asTrimmedString(input?.actionValue) ??
    asTrimmedString(asObject(input?.action)?.value)
  );
}

export function extractStructuredProviderToolData(
  value: unknown,
): StructuredProviderToolData | null {
  const record = asObject(value);
  if (!record) {
    return null;
  }

  const item = asObject(record.item);
  const toolName =
    asTrimmedString(record.toolName) ??
    asTrimmedString(item?.toolName) ??
    asTrimmedString(item?.name) ??
    asTrimmedString(record.name) ??
    inferTopLevelToolName(record);
  if (!toolName) {
    return null;
  }

  const input =
    asObject(record.input) ??
    asObject(item?.input) ??
    parseJsonObject(asTrimmedString(record.arguments) ?? asTrimmedString(item?.arguments)) ??
    buildTopLevelToolInput(record, toolName);
  const result = record.result ?? item?.result;

  return {
    toolName,
    input,
    ...(result !== undefined ? { result } : {}),
    ...(item ? { item } : { item: record }),
  };
}

export function classifyProviderToolLifecycleItemType(
  toolName: string | null | undefined,
): ToolLifecycleItemType {
  const normalized = normalizeProviderToolName(toolName);
  if (!normalized) {
    return "dynamic_tool_call";
  }

  if (normalized.startsWith("mcp ")) {
    return "mcp_tool_call";
  }
  if (normalized === "web search") {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (isSubagentToolName(normalized)) {
    return "collab_agent_tool_call";
  }
  if (COMMAND_TOOL_NAMES.has(normalized)) {
    return "command_execution";
  }
  if (FILE_CHANGE_TOOL_NAMES.has(normalized)) {
    return "file_change";
  }
  return "dynamic_tool_call";
}

export function classifyProviderToolRequestKind(
  toolName: string | null | undefined,
): ProviderToolRequestKind | undefined {
  const normalized = normalizeProviderToolName(toolName);
  if (!normalized) {
    return undefined;
  }

  if (COMMAND_TOOL_NAMES.has(normalized)) {
    return "command";
  }
  if (FILE_CHANGE_TOOL_NAMES.has(normalized)) {
    return "file-change";
  }
  if (
    FILE_READ_TOOL_NAMES.has(normalized) ||
    normalized.startsWith("mcp ") ||
    normalized === "image view"
  ) {
    return "file-read";
  }
  return undefined;
}

export function providerToolTitle(toolName: string | null | undefined): string {
  const normalized = normalizeProviderToolName(toolName);
  if (!normalized) {
    return "Tool call";
  }

  switch (normalized) {
    case "close agent":
      return "Close subagent";
    case "resume agent":
      return "Resume subagent";
    case "agent":
    case "spawn agent":
    case "subagent":
    case "task":
      return "Subagent task";
    case "ask user":
    case "request user input":
      return "Ask user";
    case "apply patch":
      return "Apply patch";
    case "exec command":
    case "execute command":
      return "Run command";
    case "list directory":
      return "List directory";
    case "multi edit":
    case "str replace file":
      return "Edit file";
    case "notebook edit":
      return "Edit notebook";
    case "read file":
      return "Read file";
    case "send input":
    case "send message":
      return "Send input";
    case "update plan":
      return "Update plan";
    case "set todo list":
    case "todo write":
    case "todowrite":
    case "update todo list":
    case "update todos":
      return "Update todo list";
    case "wait":
    case "wait agent":
      return "Wait for subagent";
    case "web search":
      return "Web Search";
    case "file write":
    case "write":
    case "write file":
      return "Write file";
    default:
      break;
  }

  if (normalized.startsWith("mcp ")) {
    return "MCP tool call";
  }

  return toTitleCase(normalized);
}

export function summarizeProviderToolInvocation(
  toolName: string | null | undefined,
  input: Record<string, unknown> | null,
): string | undefined {
  const normalized = normalizeProviderToolName(toolName);
  if (!normalized) {
    return undefined;
  }

  const command = asTrimmedString(input?.command) ?? asTrimmedString(input?.cmd);
  if (command) {
    return `${providerToolTitle(normalized)}: ${truncate(command)}`;
  }

  if (normalized === "web search") {
    const actionType = getProviderToolInputActionType(input);
    const actionValue = getProviderToolInputActionValue(input);
    const query = getProviderToolInputQuery(input);
    if (actionType === "open_page" && actionValue) {
      return `${providerToolTitle(normalized)}: ${truncate(actionValue)}`;
    }
    if (query) {
      return `${providerToolTitle(normalized)}: ${truncate(query)}`;
    }
    if (actionValue) {
      return `${providerToolTitle(normalized)}: ${truncate(actionValue)}`;
    }
  }

  if (isTodoListToolName(normalized)) {
    const todos = Array.isArray(input?.todos) ? input.todos : null;
    const todoCount =
      todos?.filter((entry) => {
        const record = asObject(entry);
        return (
          asTrimmedString(record?.content) ??
          asTrimmedString(record?.activeForm) ??
          asTrimmedString(record?.text) ??
          asTrimmedString(record?.title)
        );
      }).length ?? 0;
    return todoCount > 0
      ? `${providerToolTitle(normalized)}: ${todoCount} ${todoCount === 1 ? "task" : "tasks"}`
      : providerToolTitle(normalized);
  }

  if (isSubagentToolName(normalized)) {
    const description =
      asTrimmedString(input?.description) ??
      asTrimmedString(input?.task) ??
      asTrimmedString(input?.title) ??
      asTrimmedString(input?.prompt);
    if (description) {
      return `${providerToolTitle(normalized)}: ${truncate(description)}`;
    }
  }

  if (normalized === "update plan") {
    const plan = Array.isArray(input?.plan) ? input.plan : null;
    const planCount = plan?.length ?? 0;
    const explanation = asTrimmedString(input?.explanation);
    if (planCount > 0) {
      return explanation
        ? `Update plan: ${truncate(explanation)} (${planCount} steps)`
        : `Update plan: ${planCount} steps`;
    }
    if (explanation) {
      return `Update plan: ${truncate(explanation)}`;
    }
  }

  if (isUserInputToolName(normalized)) {
    const question = firstQuestionPrompt(input);
    if (question) {
      return `${providerToolTitle(normalized)}: ${truncate(question)}`;
    }
  }

  if (
    normalized === "close agent" ||
    normalized === "resume agent" ||
    normalized === "send input" ||
    normalized === "send message" ||
    normalized === "wait" ||
    normalized === "wait agent"
  ) {
    const targets = joinedTargets(input);
    if (targets) {
      return `${providerToolTitle(normalized)}: ${targets}`;
    }
  }

  const path = getProviderToolInputPath(input);
  if (path) {
    return `${providerToolTitle(normalized)}: ${truncate(path)}`;
  }

  const query = getProviderToolInputQuery(input);
  if (query) {
    return `${providerToolTitle(normalized)}: ${truncate(query)}`;
  }

  const serialized = input ? truncate(JSON.stringify(input)) : undefined;
  return serialized
    ? `${providerToolTitle(normalized)}: ${serialized}`
    : providerToolTitle(normalized);
}

export function snapshotProviderToolData(data: unknown): unknown {
  return snapshotUnknown(extractStructuredProviderToolData(data) ?? data);
}
