import type { ToolLifecycleItemType } from "contracts";

type ProviderToolRequestKind = "command" | "file-read" | "file-change";

const COMMAND_TOOL_NAMES = new Set([
  "bash",
  "command",
  "exec command",
  "execute command",
  "shell",
  "terminal",
]);

const FILE_CHANGE_TOOL_NAMES = new Set([
  "apply patch",
  "create file",
  "delete file",
  "edit",
  "replace",
  "update file",
  "write",
  "write file",
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

const SUBAGENT_TOOL_NAMES = new Set(["agent", "spawn agent", "subagent", "task"]);
const USER_INPUT_TOOL_NAMES = new Set(["ask user", "request user input"]);

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

  const normalized = value.replace(/[._-]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
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

export function getProviderToolInputPath(input: Record<string, unknown> | null): string | null {
  return (
    asTrimmedString(input?.file_path) ??
    asTrimmedString(input?.path) ??
    asTrimmedString(input?.filePath) ??
    asTrimmedString(input?.relativePath) ??
    asTrimmedString(input?.filename)
  );
}

export function getProviderToolInputQuery(input: Record<string, unknown> | null): string | null {
  return (
    asTrimmedString(input?.query) ??
    asTrimmedString(input?.pattern) ??
    asTrimmedString(input?.q) ??
    asTrimmedString(input?.search)
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
    asTrimmedString(record.name);
  if (!toolName) {
    return null;
  }

  const input =
    asObject(record.input) ??
    asObject(item?.input) ??
    parseJsonObject(asTrimmedString(record.arguments) ?? asTrimmedString(item?.arguments));
  const result = record.result ?? item?.result;

  return {
    toolName,
    input,
    ...(result !== undefined ? { result } : {}),
    ...(item ? { item } : {}),
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
  if (normalized === "web search" || normalized === "websearch") {
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
    case "read file":
      return "Read file";
    case "send input":
    case "send message":
      return "Send input";
    case "update plan":
      return "Update plan";
    case "wait agent":
      return "Wait for subagent";
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

  if (normalized === "send input" || normalized === "send message" || normalized === "wait agent") {
    const targets = joinedTargets(input);
    if (targets) {
      return `${providerToolTitle(normalized)}: ${targets}`;
    }
  }

  const query = getProviderToolInputQuery(input);
  const path = getProviderToolInputPath(input);

  if (query && path) {
    return `${providerToolTitle(normalized)}: ${truncate(`${query} in ${path}`)}`;
  }
  if (query) {
    return `${providerToolTitle(normalized)}: ${truncate(query)}`;
  }
  if (path) {
    return `${providerToolTitle(normalized)}: ${truncate(path)}`;
  }

  const serialized = input ? truncate(JSON.stringify(input)) : undefined;
  return serialized
    ? `${providerToolTitle(normalized)}: ${serialized}`
    : providerToolTitle(normalized);
}
