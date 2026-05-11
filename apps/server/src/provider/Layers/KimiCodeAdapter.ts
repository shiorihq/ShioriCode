import { createHash, randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type ExternalTool,
  extractBrief,
  forkSession,
  formatContentOutput,
  type InitializeResult,
  parseConfig,
  parseSessionEvents,
  ProtocolClient,
  type ApprovalRequestPayload,
  type ContentPart,
  type HookRequest,
  type QuestionRequest,
  type RunResult,
  type StreamEvent,
  type ToolCall,
  type ToolResult,
} from "@moonshot-ai/kimi-agent-sdk";
import {
  EventId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderTurnStartResult,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "contracts";
import { Effect, FileSystem, Layer, Option, PubSub, Ref, Stream } from "effect";
import {
  classifyProviderToolLifecycleItemType,
  classifyProviderToolRequestKind,
  isTodoListToolName,
  normalizeProviderToolName,
  providerToolTitle,
  summarizeProviderToolInvocation,
} from "shared/providerTool";

import { buildAssistantSettingsAppendix } from "../../assistantPersonality.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { makeGoalProviderToolRuntime } from "../../goals/providerTools.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  buildProviderMcpToolRuntime,
  loadEffectiveMcpServersForProvider,
  type ProviderMcpToolRuntime,
} from "../mcpServers.ts";
import { buildShioriSkillToolRuntime, type ProviderSkillRuntime } from "../skills.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { KimiCodeAdapter, type KimiCodeAdapterShape } from "../Services/KimiCodeAdapter.ts";
import { normalizeUserInputAnswersByQuestionText } from "../userInputAnswers.ts";

const PROVIDER = "kimiCode" as const;
const DEFAULT_MODEL = "kimi-code/kimi-for-coding";
const KIMI_REASONING_ITEM_TITLE = "Reasoning";
const KIMI_ASSISTANT_ITEM_TITLE = "Assistant response";
const DEFAULT_KIMI_MAX_STEPS_PER_TURN = 64;
const DEFAULT_KIMI_MAX_RETRIES_PER_STEP = 2;
const DEFAULT_KIMI_MAX_TOOL_CALLS_PER_TURN = 32;
const DEFAULT_KIMI_MAX_SHELL_CALLS_PER_TURN = 24;
const DEFAULT_KIMI_EXTERNAL_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_KIMI_TURN_WATCHDOG_TIMEOUT_MS = 10 * 60_000;
const KIMI_LOOP_GUARD_HOOK_ID = "shioricode-kimi-tool-loop-guard";

type KimiResumeCursor = {
  readonly sessionId: string;
  readonly fingerprint?: KimiSessionFingerprint;
};

type KimiSessionFingerprint = {
  readonly version: 1;
  readonly agentSignature: string;
  readonly workDir: string;
  readonly shareDir?: string;
  readonly cliVersion?: string;
  readonly wireVersion?: string;
  readonly capabilities?: unknown;
  readonly hooks?: unknown;
};

type KimiQuestionOption = {
  readonly label: string;
  readonly description?: string;
};

type KimiQuestion = {
  readonly header?: string;
  readonly question: string;
  readonly options: ReadonlyArray<KimiQuestionOption>;
  readonly multi_select?: boolean;
};

type KimiTextContentPart = {
  readonly type: "text";
  readonly text: string;
};

type KimiThinkContentPart = {
  readonly type: "think";
  readonly think: string;
};

type KimiTodoItem = {
  readonly title: string;
  readonly status: "pending" | "in_progress" | "done";
};

type KimiTodoBlock = {
  readonly type: "todo";
  readonly items: ReadonlyArray<KimiTodoItem>;
};

type PendingApproval = {
  readonly requestId: string;
  readonly requestType: Extract<
    ProviderRuntimeEvent,
    { type: "request.opened" }
  >["payload"]["requestType"];
};

type PendingQuestion = {
  readonly requestId: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
};

type ToolInFlight = {
  readonly toolCallId: string;
  readonly itemId: string;
  readonly itemType: Extract<ProviderRuntimeEvent, { type: "item.started" }>["payload"]["itemType"];
  readonly toolName: string;
  readonly title: string;
  argumentsJson: string;
};

type ActiveTurnState = {
  readonly turnId: TurnId;
  readonly assistantItemId: string;
  readonly reasoningItemId: string;
  readonly items: Array<unknown>;
  readonly toolCalls: Map<string, ToolInFlight>;
  readonly lastToolCallIdByParent: Map<string, string>;
  pendingAssistantText: string;
  toolCallSeen: boolean;
  assistantStarted: boolean;
  assistantCompleted: boolean;
  assistantTextSeen: boolean;
  reasoningStarted: boolean;
  reasoningCompleted: boolean;
  toolGuardToolCallCount: number;
  toolGuardShellCallCount: number;
  toolGuardMaxToolCallsPerTurn: number;
  toolGuardMaxShellCallsPerTurn: number;
  toolGuardToolsDisabledReason: string | undefined;
  toolGuardTriggered: boolean;
  toolGuardWarningEmitted: boolean;
  toolGuardCancelRequested: boolean;
  toolGuardReason: string | undefined;
};

type KimiSessionContext = {
  session: ProviderSession;
  sessionId: string;
  client: ProtocolClient;
  workDir: string;
  executablePath: string;
  shareDir: string | undefined;
  model: string | undefined;
  thinking: boolean;
  resumeFingerprint: KimiSessionFingerprint;
  yoloMode: boolean;
  planMode: boolean;
  agentFilePath: string | undefined;
  externalTools: ReadonlyArray<ExternalTool>;
  toolRuntime: {
    readonly mcp: ProviderMcpToolRuntime;
    readonly skill: ProviderSkillRuntime;
    readonly signature: string;
  } | null;
  stopped: boolean;
  interrupting: boolean;
  pendingApprovals: Map<string, PendingApproval>;
  pendingQuestions: Map<string, PendingQuestion>;
  activeTurn: ActiveTurnState | null;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
};

function requestKimiLoopGuardCancel(context: KimiSessionContext, turn: ActiveTurnState): void {
  if (turn.toolGuardCancelRequested) {
    return;
  }
  turn.toolGuardCancelRequested = true;
  context.interrupting = true;
  queueMicrotask(() => {
    void context.client.sendCancel().catch(() => undefined);
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function nextEventId(): EventId {
  return EventId.makeUnsafe(randomUUID());
}

function trimOrUndefined(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePositiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

export function resolveKimiExternalToolTimeoutMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parsePositiveIntegerEnv(
    env.SHIORICODE_KIMI_EXTERNAL_TOOL_TIMEOUT_MS,
    DEFAULT_KIMI_EXTERNAL_TOOL_TIMEOUT_MS,
  );
}

export function resolveKimiTurnWatchdogTimeoutMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parsePositiveIntegerEnv(
    env.SHIORICODE_KIMI_TURN_WATCHDOG_MS ?? env.SHIORICODE_KIMI_TURN_WATCHDOG_TIMEOUT_MS,
    DEFAULT_KIMI_TURN_WATCHDOG_TIMEOUT_MS,
  );
}

export function resolveKimiLoopControlFromEnv(env: NodeJS.ProcessEnv = process.env): {
  readonly maxStepsPerTurn: number;
  readonly maxRetriesPerStep: number;
  readonly maxToolCallsPerTurn: number;
  readonly maxShellCallsPerTurn: number;
} {
  return {
    maxStepsPerTurn: parsePositiveIntegerEnv(
      env.SHIORICODE_KIMI_MAX_STEPS_PER_TURN,
      DEFAULT_KIMI_MAX_STEPS_PER_TURN,
    ),
    maxRetriesPerStep: parsePositiveIntegerEnv(
      env.SHIORICODE_KIMI_MAX_RETRIES_PER_STEP,
      DEFAULT_KIMI_MAX_RETRIES_PER_STEP,
    ),
    maxToolCallsPerTurn: parsePositiveIntegerEnv(
      env.SHIORICODE_KIMI_MAX_TOOL_CALLS_PER_TURN,
      DEFAULT_KIMI_MAX_TOOL_CALLS_PER_TURN,
    ),
    maxShellCallsPerTurn: parsePositiveIntegerEnv(
      env.SHIORICODE_KIMI_MAX_SHELL_CALLS_PER_TURN,
      DEFAULT_KIMI_MAX_SHELL_CALLS_PER_TURN,
    ),
  };
}

function isKimiShellToolName(toolName: string): boolean {
  const normalized = normalizeProviderToolName(toolName);
  return normalized === "shell" || normalized === "bash" || normalized === "terminal";
}

export function shouldAvoidKimiToolsForUserInput(input: string | undefined): boolean {
  const normalized = trimOrUndefined(input)?.toLowerCase();
  if (!normalized) {
    return false;
  }

  if (normalized === "??" || normalized === "?" || normalized === "stop") {
    return true;
  }

  if (normalized.length > 240) {
    return false;
  }

  return (
    normalized.includes("stop running") ||
    normalized.includes("too many commands") ||
    normalized.includes("so many commands") ||
    normalized.includes("what are you doing")
  );
}

export function evaluateKimiToolLoopGuard(input: {
  readonly toolName: string;
  readonly toolCallCount: number;
  readonly shellCallCount: number;
  readonly maxToolCallsPerTurn: number;
  readonly maxShellCallsPerTurn: number;
  readonly toolsDisabledReason?: string;
}): {
  readonly toolCallCount: number;
  readonly shellCallCount: number;
  readonly shouldBlock: boolean;
  readonly shouldCancel: boolean;
  readonly reason?: string;
  readonly trigger: "tools_disabled" | "tool_call_limit" | "shell_call_limit" | null;
} {
  const toolCallCount = input.toolCallCount + 1;
  const shellCallCount = input.shellCallCount + (isKimiShellToolName(input.toolName) ? 1 : 0);

  if (input.toolsDisabledReason) {
    return {
      toolCallCount,
      shellCallCount,
      shouldBlock: true,
      shouldCancel: false,
      reason: input.toolsDisabledReason,
      trigger: "tools_disabled",
    };
  }

  if (shellCallCount > input.maxShellCallsPerTurn) {
    return {
      toolCallCount,
      shellCallCount,
      shouldBlock: true,
      shouldCancel: true,
      reason: `Kimi Code tried to run too many shell commands in one turn (${shellCallCount}/${input.maxShellCallsPerTurn}).`,
      trigger: "shell_call_limit",
    };
  }

  if (toolCallCount > input.maxToolCallsPerTurn) {
    return {
      toolCallCount,
      shellCallCount,
      shouldBlock: true,
      shouldCancel: true,
      reason: `Kimi Code tried to call too many tools in one turn (${toolCallCount}/${input.maxToolCallsPerTurn}).`,
      trigger: "tool_call_limit",
    };
  }

  return {
    toolCallCount,
    shellCallCount,
    shouldBlock: false,
    shouldCancel: false,
    trigger: null,
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildKimiExecutableWrapperScript(executablePath: string): string {
  return [
    "#!/bin/sh",
    "set -eu",
    `max_steps="\${SHIORICODE_KIMI_MAX_STEPS_PER_TURN:-${DEFAULT_KIMI_MAX_STEPS_PER_TURN}}"`,
    `max_retries="\${SHIORICODE_KIMI_MAX_RETRIES_PER_STEP:-${DEFAULT_KIMI_MAX_RETRIES_PER_STEP}}"`,
    `case "$max_steps" in ""|*[!0-9]*|0) max_steps="${DEFAULT_KIMI_MAX_STEPS_PER_TURN}" ;; esac`,
    `case "$max_retries" in ""|*[!0-9]*|0) max_retries="${DEFAULT_KIMI_MAX_RETRIES_PER_STEP}" ;; esac`,
    `exec ${shellSingleQuote(executablePath)} \\`,
    '  --max-steps-per-turn "$max_steps" \\',
    '  --max-retries-per-step "$max_retries" \\',
    '  "$@"',
    "",
  ].join("\n");
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
}

function parseJsonMaybe(value: string | null | undefined): unknown {
  if (!value || value.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? trimOrUndefined(value) : undefined;
}

function firstString(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function extractKimiHookToolName(request: HookRequest): string {
  const inputData = asRecord(request.input_data);
  const toolInput =
    asRecord(inputData?.tool_input) ??
    asRecord(inputData?.toolInput) ??
    asRecord(inputData?.input) ??
    asRecord(inputData?.tool);
  return (
    trimOrUndefined(request.target) ??
    firstString(
      inputData?.tool_name,
      inputData?.toolName,
      inputData?.name,
      inputData?.tool,
      toolInput?.tool_name,
      toolInput?.toolName,
      toolInput?.name,
    ) ??
    "tool"
  );
}

function normalizeExternalToolResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  return JSON.stringify(result, null, 2);
}

function formatKimiToolTimeoutMessage(toolName: string, timeoutMs: number): string {
  return `Kimi external tool '${toolName}' timed out after ${timeoutMs}ms. ShioriCode stopped waiting for the tool so the turn can continue.`;
}

export async function runKimiExternalToolWithTimeout(input: {
  readonly toolName: string;
  readonly timeoutMs: number;
  readonly execute: () => Promise<{ output: string; message: string }>;
  readonly onTimeout?: (message: string) => void | Promise<void>;
}): Promise<{ output: string; message: string }> {
  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<{ output: string; message: string }>((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      const message = formatKimiToolTimeoutMessage(input.toolName, input.timeoutMs);
      Promise.resolve(input.onTimeout?.(message))
        .catch(() => undefined)
        .finally(() => {
          resolve({
            output: message,
            message: `Tool '${input.toolName}' timed out.`,
          });
        });
    }, input.timeoutMs);
  });

  try {
    return await Promise.race([input.execute(), timeoutPromise]);
  } finally {
    if (!timedOut && timeout) {
      clearTimeout(timeout);
    }
  }
}

function formatLocalDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function formatLocalTime(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value);
}

function formatLocalWeekday(value: Date): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(value);
}

async function readWorkspaceAgentsFiles(
  cwd?: string,
): Promise<ReadonlyArray<{ path: string; content: string }>> {
  if (!cwd) {
    return [];
  }

  const discovered: Array<{ path: string; content: string }> = [];
  let current = path.resolve(cwd);
  const seen = new Set<string>();

  while (true) {
    const candidate = path.join(current, "AGENTS.md");
    if (!seen.has(candidate)) {
      try {
        const content = await import("node:fs/promises").then((fs) =>
          fs.readFile(candidate, "utf8"),
        );
        discovered.push({ path: candidate, content });
      } catch {
        // ignore missing AGENTS.md files
      }
      seen.add(candidate);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return discovered.toReversed();
}

async function buildKimiAgentFileContents(input: {
  readonly cwd: string;
  readonly personalityAppendix?: string;
  readonly skillPrompt?: string;
  readonly externalTools: ReadonlyArray<ExternalTool>;
  readonly agents?: ReadonlyArray<{ path: string; content: string }>;
}): Promise<string> {
  const now = new Date();
  const agents = input.agents ?? (await readWorkspaceAgentsFiles(input.cwd));
  const toolList =
    input.externalTools.length > 0
      ? [
          "## ShioriCode External Tools",
          "The following extra tools are available in addition to Kimi Code's native local tooling.",
          "Prefer native local tools for shell/file work when they are suitable.",
          "Use external tools when they expose ShioriCode-specific integrations such as MCP bridges or skill loading.",
          ...input.externalTools
            .slice(0, 80)
            .map((tool) => `- \`${tool.name}\`: ${tool.description}`),
        ].join("\n")
      : undefined;

  const agentsSection =
    agents.length > 0
      ? [
          "## Workspace Instructions",
          "The following instructions come from AGENTS.md files that govern this workspace. Follow them unless a higher-priority instruction conflicts.",
          ...agents.map((entry) => `### ${entry.path}\n\n${entry.content.trim()}`),
        ].join("\n\n")
      : undefined;

  const sections = [
    [
      "# ShioriCode System Prompt",
      "",
      "## Identity",
      "You are ShioriCode running through Kimi Code CLI inside a local desktop coding environment.",
      "You are the assistant for this product and session.",
      "Do not describe yourself as a generic chat assistant when local tools and repository context are available.",
      "",
      "## Mission",
      "Help the user complete real coding tasks accurately and efficiently.",
      "Prefer direct action over explanation when local tooling can safely do the work.",
      "Inspect the repository and local environment before making claims.",
      "",
      "## Loop Avoidance",
      "Avoid repetitive reasoning or repeated tool calls. If you notice you are revisiting the same step, summarize what is known, choose the next concrete action, and move forward.",
      "If you are blocked, state the blocker once with the relevant evidence instead of retrying the same failed approach indefinitely.",
      "Keep command sweeps small. Do not enumerate many files, routes, pages, or commands one by one when a focused sample and summary would answer the user.",
      "After roughly a dozen shell commands without a clear result, pause and summarize what you found before continuing.",
      "If the user asks you to stop, complains about too many commands, asks what you are doing, or sends a short confusion message such as '??', answer directly in prose and do not call tools unless they explicitly ask for a concrete local action.",
      "",
      "## Tooling Expectations",
      "You have Kimi Code's native local tools available for code, files, and shell work in this workspace.",
      "When the user asks to review code, inspect the actual repository state instead of asking them to paste a diff unless you truly cannot access it.",
      "If a request references the current codebase, try to open files, inspect git state, and use available tools before asking follow-up questions.",
      "If a tool is unavailable or a command fails, state that plainly and use the observed error.",
      "",
      "## Review Behavior",
      "When the user asks for a review, default to a code review mindset.",
      "Prioritize bugs, regressions, missing tests, and risky behavior over summaries.",
      "Present findings first, then open questions, then a brief summary.",
      "",
      "## Runtime Context",
      `- Workspace root: ${input.cwd}`,
      `- Local date: ${formatLocalDate(now)}`,
      `- Local weekday: ${formatLocalWeekday(now)}`,
      `- Local time: ${formatLocalTime(now)}`,
      `- Local timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}`,
      `- Machine hostname: ${os.hostname()}`,
      `- Local username: ${os.userInfo().username}`,
      `- Platform: ${process.platform}`,
      `- Architecture: ${process.arch}`,
    ].join("\n"),
    toolList,
    input.skillPrompt,
    input.personalityAppendix,
    agentsSection,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  return sections.join("\n\n");
}

function buildKimiAgentYaml(): string {
  return [
    "version: 1",
    "agent:",
    "  extend: default",
    '  name: "shioricode-kimi"',
    "  system_prompt_path: ./system.md",
  ].join("\n");
}

function asKimiSessionFingerprint(value: unknown): KimiSessionFingerprint | undefined {
  const record = asRecord(value);
  if (!record || record.version !== 1) {
    return undefined;
  }
  const agentSignature = asString(record.agentSignature);
  const workDir = asString(record.workDir);
  if (!agentSignature || !workDir) {
    return undefined;
  }
  const shareDir = asString(record.shareDir);
  const cliVersion = asString(record.cliVersion);
  const wireVersion = asString(record.wireVersion);
  return {
    version: 1,
    agentSignature,
    workDir,
    ...(shareDir ? { shareDir } : {}),
    ...(cliVersion ? { cliVersion } : {}),
    ...(wireVersion ? { wireVersion } : {}),
    ...(record.capabilities !== undefined ? { capabilities: record.capabilities } : {}),
    ...(record.hooks !== undefined ? { hooks: record.hooks } : {}),
  };
}

function parseResumeCursor(value: unknown): KimiResumeCursor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const sessionId = "sessionId" in record ? record.sessionId : undefined;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return undefined;
  }
  const fingerprint = asKimiSessionFingerprint(record.fingerprint);
  return {
    sessionId: sessionId.trim(),
    ...(fingerprint ? { fingerprint } : {}),
  };
}

function buildResumeCursor(
  sessionId: string,
  fingerprint: KimiSessionFingerprint | undefined,
): KimiResumeCursor {
  return {
    sessionId,
    ...(fingerprint ? { fingerprint } : {}),
  };
}

export function buildKimiSessionFingerprint(input: {
  readonly agentSignature: string;
  readonly workDir: string;
  readonly shareDir?: string;
  readonly initializeResult?: InitializeResult;
}): KimiSessionFingerprint {
  return {
    version: 1,
    agentSignature: input.agentSignature,
    workDir: input.workDir,
    ...(input.shareDir ? { shareDir: input.shareDir } : {}),
    ...(input.initializeResult?.server.version
      ? { cliVersion: input.initializeResult.server.version }
      : {}),
    ...(input.initializeResult?.protocol_version
      ? { wireVersion: input.initializeResult.protocol_version }
      : {}),
    ...(input.initializeResult?.capabilities !== undefined
      ? { capabilities: input.initializeResult.capabilities }
      : {}),
    ...(input.initializeResult?.hooks !== undefined ? { hooks: input.initializeResult.hooks } : {}),
  };
}

export function findKimiResumeFingerprintMismatch(input: {
  readonly previous: KimiSessionFingerprint | undefined;
  readonly next: KimiSessionFingerprint;
  readonly compareRuntime?: boolean;
}): string | undefined {
  const previous = input.previous;
  if (!previous) {
    return undefined;
  }

  const comparisons: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ["workDir", previous.workDir, input.next.workDir],
    ["shareDir", previous.shareDir, input.next.shareDir],
    ["agentSignature", previous.agentSignature, input.next.agentSignature],
    ...(input.compareRuntime
      ? ([
          ["cliVersion", previous.cliVersion, input.next.cliVersion],
          ["wireVersion", previous.wireVersion, input.next.wireVersion],
        ] as const)
      : []),
  ];

  for (const [name, before, after] of comparisons) {
    if (before !== undefined && after !== undefined && before !== after) {
      return name;
    }
  }
  return undefined;
}

function contextResumeCursor(context: KimiSessionContext): KimiResumeCursor {
  return buildResumeCursor(context.sessionId, context.resumeFingerprint);
}

export function normalizeKimiQuestionAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  answers: Record<string, unknown>,
): Record<string, string> {
  return normalizeUserInputAnswersByQuestionText(questions, answers);
}

function readExplicitKimiThinking(
  modelSelection: ProviderSendTurnInput["modelSelection"] | undefined,
): boolean | undefined {
  if (modelSelection?.provider !== PROVIDER) {
    return undefined;
  }
  const options = asRecord(modelSelection.options);
  return typeof options?.thinking === "boolean" ? options.thinking : undefined;
}

export function resolveKimiThinking(input: {
  readonly modelSelection?: ProviderSendTurnInput["modelSelection"];
  readonly shareDir?: string;
  readonly fallback?: boolean;
}): boolean {
  const explicitThinking = readExplicitKimiThinking(input.modelSelection);
  if (explicitThinking !== undefined) {
    return explicitThinking;
  }
  if (input.modelSelection?.provider === PROVIDER || input.fallback === undefined) {
    return parseConfig(input.shareDir).defaultThinking;
  }
  return input.fallback;
}

export function shouldFlushKimiPendingTextAsAssistantAnswer(input: {
  readonly turnFinished: boolean;
  readonly toolCallSeen: boolean;
}): boolean {
  void input;
  return true;
}

export function shouldOmitKimiCompletedToolData(input: {
  readonly toolName: string;
  readonly isError: boolean;
}): boolean {
  if (input.isError) {
    return false;
  }
  const normalized = normalizeProviderToolName(input.toolName);
  return normalized === "read" || normalized === "read file" || normalized === "view";
}

function mapRequestKindToCanonical(
  kind: ReturnType<typeof classifyProviderToolRequestKind>,
): Extract<ProviderRuntimeEvent, { type: "request.opened" }>["payload"]["requestType"] {
  switch (kind) {
    case "command":
      return "exec_command_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function buildQuestionItems(payload: QuestionRequest): ReadonlyArray<UserInputQuestion> {
  const questions = payload.questions as ReadonlyArray<KimiQuestion>;
  return questions.map((question, index) => {
    const baseQuestion = {
      id: `${payload.id}:${index + 1}`,
      header: trimOrUndefined(question.header) ?? `Q${index + 1}`,
      question: question.question,
      options: question.options.map((option) => ({
        label: option.label,
        description: trimOrUndefined(option.description) ?? option.label,
      })),
    };
    if (question.multi_select) {
      return {
        id: baseQuestion.id,
        header: baseQuestion.header,
        question: baseQuestion.question,
        options: baseQuestion.options,
        multiSelect: true,
      };
    }
    return baseQuestion;
  });
}

function isKimiTodoBlock(block: unknown): block is KimiTodoBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    block.type === "todo" &&
    "items" in block &&
    Array.isArray(block.items)
  );
}

function isTextContentPart(part: unknown): part is KimiTextContentPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
  );
}

function isThinkContentPart(part: unknown): part is KimiThinkContentPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "think" &&
    "think" in part &&
    typeof part.think === "string"
  );
}

export function kimiAssistantDeltaFromContentPart(part: unknown): string | undefined {
  return isTextContentPart(part) ? part.text : undefined;
}

function rawEvent(messageType: string, payload: unknown): NonNullable<ProviderRuntimeEvent["raw"]> {
  return {
    source: "kimi.sdk.wire",
    messageType,
    payload,
  };
}

function buildSession(
  input: {
    readonly threadId: ThreadId;
    readonly workDir: string;
    readonly sessionId: string;
    readonly fingerprint?: KimiSessionFingerprint;
    readonly runtimeMode: ProviderSession["runtimeMode"];
    readonly model?: string;
  },
  timestamp: string,
): ProviderSession {
  return {
    provider: PROVIDER,
    status: "ready",
    runtimeMode: input.runtimeMode,
    cwd: input.workDir,
    ...(input.model ? { model: input.model } : {}),
    threadId: input.threadId,
    resumeCursor: buildResumeCursor(input.sessionId, input.fingerprint),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function turnSnapshotFromEvents(
  threadId: ThreadId,
  sessionId: string,
  events: ReadonlyArray<StreamEvent>,
): ProviderThreadSnapshot {
  const turns: Array<{ id: TurnId; items: Array<unknown> }> = [];
  let currentTurn: { id: TurnId; items: Array<unknown> } | null = null;
  let turnIndex = 0;

  for (const event of events) {
    if (event.type === "TurnBegin") {
      turnIndex += 1;
      currentTurn = {
        id: TurnId.makeUnsafe(`kimi:${sessionId}:turn:${turnIndex}`),
        items: [event],
      };
      turns.push(currentTurn);
      continue;
    }

    if (currentTurn) {
      currentTurn.items.push(event);
      if (event.type === "TurnEnd" || event.type === "StepInterrupted") {
        currentTurn = null;
      }
    }
  }

  return {
    threadId,
    turns,
  };
}

function toolParentKey(parentToolCallId: string | undefined): string {
  return parentToolCallId ?? "__root__";
}

function isKimiModelConfigEqual(input: {
  readonly model: string | undefined;
  readonly thinking: boolean;
  readonly yoloMode: boolean;
  readonly executablePath: string;
  readonly shareDir: string | undefined;
  readonly toolSignature: string | undefined;
  readonly nextModel: string | undefined;
  readonly nextThinking: boolean;
  readonly nextYoloMode: boolean;
  readonly nextExecutablePath: string;
  readonly nextShareDir: string | undefined;
  readonly nextToolSignature: string | undefined;
}): boolean {
  return (
    input.model === input.nextModel &&
    input.thinking === input.nextThinking &&
    input.yoloMode === input.nextYoloMode &&
    input.executablePath === input.nextExecutablePath &&
    input.shareDir === input.nextShareDir &&
    input.toolSignature === input.nextToolSignature
  );
}

const makeKimiCodeAdapter = Effect.fn("makeKimiCodeAdapter")(function* () {
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverSettingsService = yield* ServerSettingsService;
  const orchestrationEngineOption = yield* Effect.serviceOption(OrchestrationEngineService);
  const runtimeEvents = yield* Effect.acquireRelease(
    PubSub.unbounded<ProviderRuntimeEvent>(),
    PubSub.shutdown,
  );
  const sessionsRef = yield* Ref.make(new Map<ThreadId, KimiSessionContext>());

  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);

  const getSessions = () => Ref.get(sessionsRef);

  const setSessions = (sessions: Map<ThreadId, KimiSessionContext>) =>
    Ref.set(sessionsRef, sessions);

  const requireSession = Effect.fn("requireSession")(function* (threadId: ThreadId) {
    const sessions = yield* getSessions();
    const context = sessions.get(threadId);
    if (!context) {
      return yield* new ProviderAdapterSessionNotFoundError({
        provider: PROVIDER,
        threadId,
      });
    }
    return context;
  });

  const persistSession = Effect.fn("persistSession")(function* (context: KimiSessionContext) {
    const sessions = yield* getSessions();
    const next = new Map(sessions);
    next.set(context.session.threadId, context);
    yield* setSessions(next);
  });

  const removeSession = Effect.fn("removeSession")(function* (threadId: ThreadId) {
    const sessions = yield* getSessions();
    if (!sessions.has(threadId)) {
      return;
    }
    const next = new Map(sessions);
    next.delete(threadId);
    yield* setSessions(next);
  });

  const closeSessionResources = Effect.fn("closeSessionResources")(function* (
    context: KimiSessionContext,
  ) {
    if (context.toolRuntime) {
      yield* Effect.promise(async () => {
        await Promise.allSettled([
          context.toolRuntime?.mcp.close(),
          context.toolRuntime?.skill.close(),
        ]);
      }).pipe(Effect.ignore({ log: true }));
      context.toolRuntime = null;
      context.externalTools = [];
    }

    if (context.agentFilePath) {
      yield* fileSystem
        .remove(path.dirname(context.agentFilePath), { recursive: true, force: true })
        .pipe(Effect.ignore({ log: true }));
      context.agentFilePath = undefined;
    }
  });

  const prepareKimiExecutable = Effect.fn("prepareKimiExecutable")(function* (input: {
    readonly threadId: ThreadId;
    readonly executablePath: string;
  }) {
    const wrapperHash = createHash("sha256")
      .update(input.executablePath)
      .digest("hex")
      .slice(0, 16);
    const wrapperPath = path.join(
      serverConfig.providerLogsDir,
      `kimi-loop-guard-${wrapperHash}.sh`,
    );
    const script = buildKimiExecutableWrapperScript(input.executablePath);

    yield* fileSystem.makeDirectory(serverConfig.providerLogsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to prepare Kimi Code loop guard directory."),
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(wrapperPath, script).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to write Kimi Code loop guard executable."),
            cause,
          }),
      ),
    );
    yield* Effect.tryPromise({
      try: () => chmod(wrapperPath, 0o755),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: toMessage(cause, "Failed to mark Kimi Code loop guard executable."),
          cause,
        }),
    });

    return wrapperPath;
  });

  const buildSessionResources = Effect.fn("buildSessionResources")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
  }) {
    const settings = yield* serverSettingsService.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to load Kimi Code settings."),
            cause,
          }),
      ),
    );

    const effectiveMcpServers = yield* Effect.tryPromise({
      try: () =>
        loadEffectiveMcpServersForProvider({
          provider: PROVIDER,
          settings,
          cwd: input.cwd,
        }),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: toMessage(cause, "Failed to resolve Kimi MCP servers."),
          cause,
        }),
    });

    const mcpRuntime = yield* Effect.tryPromise({
      try: () =>
        buildProviderMcpToolRuntime(
          {
            provider: PROVIDER,
            servers: effectiveMcpServers.servers,
            cwd: input.cwd,
          },
          {
            oauthStorageDir: path.join(serverConfig.stateDir, "mcp-oauth"),
          },
        ),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: toMessage(cause, "Failed to initialize Kimi MCP tool runtime."),
          cause,
        }),
    });
    const goalRuntime = settings.goals.enabled
      ? Option.match(orchestrationEngineOption, {
          onSome: (orchestrationEngine) =>
            makeGoalProviderToolRuntime({
              orchestrationEngine,
              provider: PROVIDER,
              threadId: input.threadId,
            }),
          onNone: () =>
            ({
              descriptors: [],
              executors: new Map(),
              warnings: [],
              close: async () => undefined,
            }) satisfies ProviderMcpToolRuntime,
        })
      : ({
          descriptors: [],
          executors: new Map(),
          warnings: [],
          close: async () => undefined,
        } satisfies ProviderMcpToolRuntime);
    const mergedMcpRuntime: ProviderMcpToolRuntime = {
      descriptors: [...mcpRuntime.descriptors, ...goalRuntime.descriptors],
      executors: new Map([...mcpRuntime.executors, ...goalRuntime.executors]),
      warnings: [...mcpRuntime.warnings, ...goalRuntime.warnings],
      close: async () => {
        await Promise.allSettled([mcpRuntime.close(), goalRuntime.close()]);
      },
    };

    const skillRuntime = yield* Effect.tryPromise({
      try: () => buildShioriSkillToolRuntime({ cwd: input.cwd }),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: toMessage(cause, "Failed to initialize Kimi skill runtime."),
          cause,
        }),
    });

    const externalTools: ExternalTool[] = [
      ...mergedMcpRuntime.descriptors.map((descriptor) => ({
        name: descriptor.name,
        description: descriptor.description,
        parameters: descriptor.inputSchema,
        handler: async (params: Record<string, unknown>) => {
          const executor = mergedMcpRuntime.executors.get(descriptor.name);
          if (!executor) {
            return {
              output: `Missing executor for tool ${descriptor.name}`,
              message: `Tool '${descriptor.name}' is unavailable.`,
            };
          }
          return runKimiExternalToolWithTimeout({
            toolName: descriptor.name,
            timeoutMs: resolveKimiExternalToolTimeoutMsFromEnv(),
            execute: async () => {
              const result = await executor.execute(params);
              return {
                output: normalizeExternalToolResult(result),
                message: executor.title,
              };
            },
            onTimeout: (message) =>
              Effect.runPromise(
                publish({
                  type: "runtime.warning",
                  eventId: nextEventId(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  createdAt: nowIso(),
                  payload: {
                    message,
                    detail: {
                      toolName: descriptor.name,
                      timeoutMs: resolveKimiExternalToolTimeoutMsFromEnv(),
                    },
                  },
                  providerRefs: {},
                }),
              ),
          });
        },
      })),
      ...skillRuntime.descriptors.map((descriptor) => ({
        name: descriptor.name,
        description: descriptor.description,
        parameters: descriptor.inputSchema,
        handler: async (params: Record<string, unknown>) => {
          const executor = skillRuntime.executors.get(descriptor.name);
          if (!executor) {
            return {
              output: `Missing executor for tool ${descriptor.name}`,
              message: `Tool '${descriptor.name}' is unavailable.`,
            };
          }
          return runKimiExternalToolWithTimeout({
            toolName: descriptor.name,
            timeoutMs: resolveKimiExternalToolTimeoutMsFromEnv(),
            execute: async () => {
              const result = await executor.execute(params);
              return {
                output: normalizeExternalToolResult(result),
                message: executor.title,
              };
            },
            onTimeout: (message) =>
              Effect.runPromise(
                publish({
                  type: "runtime.warning",
                  eventId: nextEventId(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  createdAt: nowIso(),
                  payload: {
                    message,
                    detail: {
                      toolName: descriptor.name,
                      timeoutMs: resolveKimiExternalToolTimeoutMsFromEnv(),
                    },
                  },
                  providerRefs: {},
                }),
              ),
          });
        },
      })),
    ];

    const personalityAppendix = buildAssistantSettingsAppendix({
      personality: settings.assistantPersonality,
      generateMemories: settings.generateMemories,
    });
    const agents = yield* Effect.tryPromise({
      try: () => readWorkspaceAgentsFiles(input.cwd),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: toMessage(cause, "Failed to read Kimi workspace instructions."),
          cause,
        }),
    });
    const agentFileContents = yield* Effect.tryPromise({
      try: () =>
        buildKimiAgentFileContents({
          cwd: input.cwd,
          ...(personalityAppendix ? { personalityAppendix } : {}),
          ...(skillRuntime.skillPrompt ? { skillPrompt: skillRuntime.skillPrompt } : {}),
          externalTools,
          agents,
        }),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: toMessage(cause, "Failed to build Kimi agent instructions."),
          cause,
        }),
    });

    const agentBundleDir = path.join(
      serverConfig.providerLogsDir,
      `kimi-agent-${input.threadId}-${randomUUID()}`,
    );
    const systemPromptPath = path.join(agentBundleDir, "system.md");
    const agentFilePath = path.join(agentBundleDir, "agent.yaml");
    yield* fileSystem.makeDirectory(agentBundleDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to prepare Kimi agent file directory."),
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(systemPromptPath, agentFileContents).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to write Kimi system prompt file."),
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(agentFilePath, buildKimiAgentYaml()).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to write Kimi agent config file."),
            cause,
          }),
      ),
    );

    const signature = JSON.stringify({
      cwd: input.cwd,
      tools: externalTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      personalityAppendix: personalityAppendix ?? "",
      skillPrompt: skillRuntime.skillPrompt ?? "",
      agents,
    });

    return {
      agentFilePath,
      externalTools,
      toolRuntime: {
        mcp: mergedMcpRuntime,
        skill: skillRuntime,
        signature,
      },
    };
  });

  const publishKimiToolLoopGuardWarning = Effect.fn("publishKimiToolLoopGuardWarning")(
    function* (input: {
      readonly context: KimiSessionContext;
      readonly turn: ActiveTurnState;
      readonly toolName: string;
      readonly trigger: "tools_disabled" | "tool_call_limit" | "shell_call_limit" | null;
      readonly reason: string;
      readonly request: HookRequest;
    }) {
      if (input.turn.toolGuardWarningEmitted) {
        return;
      }
      input.turn.toolGuardWarningEmitted = true;
      yield* publish({
        type: "runtime.warning",
        eventId: nextEventId(),
        provider: PROVIDER,
        threadId: input.context.session.threadId,
        createdAt: nowIso(),
        turnId: input.turn.turnId,
        payload: {
          message: `Kimi Code tool loop guard blocked ${input.toolName}: ${input.reason}`,
          detail: {
            toolName: input.toolName,
            trigger: input.trigger,
            toolCalls: input.turn.toolGuardToolCallCount,
            shellCalls: input.turn.toolGuardShellCallCount,
            maxToolCallsPerTurn: input.turn.toolGuardMaxToolCallsPerTurn,
            maxShellCallsPerTurn: input.turn.toolGuardMaxShellCallsPerTurn,
          },
        },
        providerRefs: {
          providerTurnId: input.context.sessionId,
        },
        raw: rawEvent("HookRequest", input.request),
      });
    },
  );

  const handleKimiToolLoopGuardHook = Effect.fn("handleKimiToolLoopGuardHook")(function* (
    context: KimiSessionContext,
    request: HookRequest,
  ) {
    if (request.event !== "PreToolUse") {
      return { action: "allow" as const };
    }

    const turn = context.activeTurn;
    if (!turn) {
      return { action: "allow" as const };
    }

    if (turn.toolGuardTriggered) {
      return {
        action: "block" as const,
        reason: turn.toolGuardReason ?? "ShioriCode already stopped this tool loop.",
      };
    }

    const toolName = extractKimiHookToolName(request);
    const decision = evaluateKimiToolLoopGuard({
      toolName,
      toolCallCount: turn.toolGuardToolCallCount,
      shellCallCount: turn.toolGuardShellCallCount,
      maxToolCallsPerTurn: turn.toolGuardMaxToolCallsPerTurn,
      maxShellCallsPerTurn: turn.toolGuardMaxShellCallsPerTurn,
      ...(turn.toolGuardToolsDisabledReason
        ? { toolsDisabledReason: turn.toolGuardToolsDisabledReason }
        : {}),
    });
    turn.toolGuardToolCallCount = decision.toolCallCount;
    turn.toolGuardShellCallCount = decision.shellCallCount;

    if (!decision.shouldBlock) {
      return { action: "allow" as const };
    }

    const reason = decision.reason ?? "ShioriCode blocked a runaway Kimi Code tool loop.";
    turn.toolGuardTriggered = true;
    turn.toolGuardReason = reason;
    yield* publishKimiToolLoopGuardWarning({
      context,
      turn,
      toolName,
      trigger: decision.trigger,
      reason,
      request,
    });
    if (decision.shouldCancel) {
      requestKimiLoopGuardCancel(context, turn);
    }
    return {
      action: "block" as const,
      reason,
    };
  });

  const buildKimiToolLoopGuardHook = (context: KimiSessionContext) => ({
    id: KIMI_LOOP_GUARD_HOOK_ID,
    event: "PreToolUse",
    matcher: "",
    timeout: 2,
    handler: (request: HookRequest) =>
      Effect.runPromise(handleKimiToolLoopGuardHook(context, request)),
  });

  const startClient = Effect.fn("startClient")(function* (
    context: KimiSessionContext,
    options?: {
      readonly emitLifecycle?: boolean;
      readonly resumePayload?: unknown;
    },
  ) {
    if (context.client.isRunning) {
      yield* Effect.tryPromise({
        try: () => context.client.stop(),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: context.session.threadId,
            detail: toMessage(cause, "Failed to stop existing Kimi Code runtime."),
            cause,
          }),
      });
    }

    context.client = new ProtocolClient();
    const initializeResult = yield* Effect.tryPromise({
      try: () =>
        context.client.start({
          sessionId: context.sessionId,
          workDir: context.workDir,
          ...(context.model ? { model: context.model } : {}),
          thinking: context.thinking,
          yoloMode: context.yoloMode,
          executablePath: context.executablePath,
          externalTools: [...context.externalTools],
          hooks: [buildKimiToolLoopGuardHook(context)],
          ...(context.agentFilePath ? { agentFile: context.agentFilePath } : {}),
          ...(context.shareDir
            ? { environmentVariables: { KIMI_SHARE_DIR: context.shareDir } }
            : {}),
        }),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: toMessage(cause, "Failed to start Kimi Code runtime session."),
          cause,
        }),
    });
    context.resumeFingerprint = buildKimiSessionFingerprint({
      agentSignature: context.toolRuntime?.signature ?? context.resumeFingerprint.agentSignature,
      workDir: context.workDir,
      ...(context.shareDir ? { shareDir: context.shareDir } : {}),
      initializeResult,
    });

    const timestamp = nowIso();
    context.session = {
      ...context.session,
      status: "ready",
      ...(context.model ? { model: context.model } : {}),
      resumeCursor: contextResumeCursor(context),
      updatedAt: timestamp,
      lastError: undefined,
    };
    yield* persistSession(context);

    if (options?.emitLifecycle !== false) {
      yield* publish({
        type: "session.started",
        eventId: nextEventId(),
        provider: PROVIDER,
        threadId: context.session.threadId,
        createdAt: timestamp,
        payload: options?.resumePayload !== undefined ? { resume: options.resumePayload } : {},
        providerRefs: {},
      });
      yield* publish({
        type: "session.configured",
        eventId: nextEventId(),
        provider: PROVIDER,
        threadId: context.session.threadId,
        createdAt: timestamp,
        payload: {
          config: {
            workDir: context.workDir,
            sessionId: context.sessionId,
            ...(context.model ? { model: context.model } : {}),
            thinking: context.thinking,
            yoloMode: context.yoloMode,
            ...(initializeResult.server.version
              ? { cliVersion: initializeResult.server.version }
              : {}),
            ...(initializeResult.protocol_version
              ? { wireVersion: initializeResult.protocol_version }
              : {}),
            ...(initializeResult.capabilities !== undefined
              ? { capabilities: initializeResult.capabilities }
              : {}),
          },
        },
        providerRefs: {},
      });
      yield* publish({
        type: "thread.started",
        eventId: nextEventId(),
        provider: PROVIDER,
        threadId: context.session.threadId,
        createdAt: timestamp,
        payload: {
          providerThreadId: context.sessionId,
        },
        providerRefs: {
          providerTurnId: context.sessionId,
        },
      });
      yield* publish({
        type: "session.state.changed",
        eventId: nextEventId(),
        provider: PROVIDER,
        threadId: context.session.threadId,
        createdAt: timestamp,
        payload: {
          state: "ready",
        },
        providerRefs: {},
      });
    }
  });

  const restartClientIfNeeded = Effect.fn("restartClientIfNeeded")(function* (
    context: KimiSessionContext,
    nextConfig: {
      readonly model: string | undefined;
      readonly thinking: boolean;
      readonly yoloMode: boolean;
      readonly executablePath: string;
      readonly shareDir: string | undefined;
      readonly agentFilePath: string | undefined;
      readonly externalTools: ReadonlyArray<ExternalTool>;
      readonly toolRuntime: KimiSessionContext["toolRuntime"];
    },
  ) {
    if (
      isKimiModelConfigEqual({
        model: context.model,
        thinking: context.thinking,
        yoloMode: context.yoloMode,
        executablePath: context.executablePath,
        shareDir: context.shareDir,
        toolSignature: context.toolRuntime?.signature,
        nextModel: nextConfig.model,
        nextThinking: nextConfig.thinking,
        nextYoloMode: nextConfig.yoloMode,
        nextExecutablePath: nextConfig.executablePath,
        nextShareDir: nextConfig.shareDir,
        nextToolSignature: nextConfig.toolRuntime?.signature,
      })
    ) {
      if (nextConfig.toolRuntime && nextConfig.toolRuntime !== context.toolRuntime) {
        yield* Effect.promise(async () => {
          await Promise.allSettled([
            nextConfig.toolRuntime?.mcp.close(),
            nextConfig.toolRuntime?.skill.close(),
          ]);
        }).pipe(Effect.ignore({ log: true }));
      }
      if (nextConfig.agentFilePath && nextConfig.agentFilePath !== context.agentFilePath) {
        yield* fileSystem
          .remove(path.dirname(nextConfig.agentFilePath), { recursive: true, force: true })
          .pipe(Effect.ignore({ log: true }));
      }
      return;
    }

    yield* closeSessionResources(context);
    context.model = nextConfig.model;
    context.thinking = nextConfig.thinking;
    context.yoloMode = nextConfig.yoloMode;
    context.executablePath = nextConfig.executablePath;
    context.shareDir = nextConfig.shareDir;
    context.agentFilePath = nextConfig.agentFilePath;
    context.externalTools = [...nextConfig.externalTools];
    context.toolRuntime = nextConfig.toolRuntime;
    yield* startClient(context, { emitLifecycle: false });
    if (context.planMode) {
      yield* Effect.tryPromise({
        try: () => context.client.sendSetPlanMode(true),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/set_plan_mode",
            detail: toMessage(cause, "Failed to restore Kimi Code plan mode after restart."),
            cause,
          }),
      });
    }
  });

  const emitReasoningStarted = Effect.fn("emitReasoningStarted")(function* (
    context: KimiSessionContext,
    turn: ActiveTurnState,
  ) {
    if (turn.reasoningStarted) {
      return;
    }
    turn.reasoningStarted = true;
    yield* publish({
      type: "item.started",
      eventId: nextEventId(),
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: nowIso(),
      turnId: turn.turnId,
      itemId: RuntimeItemId.makeUnsafe(turn.reasoningItemId),
      payload: {
        itemType: "reasoning",
        title: KIMI_REASONING_ITEM_TITLE,
      },
      providerRefs: {
        providerItemId: ProviderItemId.makeUnsafe(turn.reasoningItemId),
      },
      raw: rawEvent("ContentPart", { type: "think" }),
    });
  });

  const emitReasoningCompleted = Effect.fn("emitReasoningCompleted")(function* (
    context: KimiSessionContext,
    turn: ActiveTurnState,
  ) {
    if (!turn.reasoningStarted || turn.reasoningCompleted) {
      return;
    }
    turn.reasoningCompleted = true;
    yield* publish({
      type: "item.completed",
      eventId: nextEventId(),
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: nowIso(),
      turnId: turn.turnId,
      itemId: RuntimeItemId.makeUnsafe(turn.reasoningItemId),
      payload: {
        itemType: "reasoning",
        title: KIMI_REASONING_ITEM_TITLE,
      },
      providerRefs: {
        providerItemId: ProviderItemId.makeUnsafe(turn.reasoningItemId),
      },
      raw: rawEvent("ContentPart", { type: "think" }),
    });
  });

  const emitAssistantStarted = Effect.fn("emitAssistantStarted")(function* (
    context: KimiSessionContext,
    turn: ActiveTurnState,
  ) {
    if (turn.assistantStarted) {
      return;
    }
    turn.assistantStarted = true;
    yield* publish({
      type: "item.started",
      eventId: nextEventId(),
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: nowIso(),
      turnId: turn.turnId,
      itemId: RuntimeItemId.makeUnsafe(turn.assistantItemId),
      payload: {
        itemType: "assistant_message",
        title: KIMI_ASSISTANT_ITEM_TITLE,
      },
      providerRefs: {
        providerItemId: ProviderItemId.makeUnsafe(turn.assistantItemId),
      },
      raw: rawEvent("ContentPart", { type: "text" }),
    });
  });

  const emitAssistantCompleted = Effect.fn("emitAssistantCompleted")(function* (
    context: KimiSessionContext,
    turn: ActiveTurnState,
  ) {
    if (!turn.assistantStarted || turn.assistantCompleted) {
      return;
    }
    turn.assistantCompleted = true;
    yield* publish({
      type: "item.completed",
      eventId: nextEventId(),
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: nowIso(),
      turnId: turn.turnId,
      itemId: RuntimeItemId.makeUnsafe(turn.assistantItemId),
      payload: {
        itemType: "assistant_message",
        title: KIMI_ASSISTANT_ITEM_TITLE,
      },
      providerRefs: {
        providerItemId: ProviderItemId.makeUnsafe(turn.assistantItemId),
      },
      raw: rawEvent("ContentPart", { type: "text" }),
    });
  });

  const emitAssistantText = Effect.fn("emitAssistantText")(function* (
    context: KimiSessionContext,
    turn: ActiveTurnState,
    text: string,
  ) {
    const trimmed = trimOrUndefined(text);
    if (!trimmed) {
      return;
    }
    yield* emitReasoningCompleted(context, turn);
    yield* emitAssistantStarted(context, turn);
    turn.assistantTextSeen = true;
    yield* publish({
      type: "content.delta",
      eventId: nextEventId(),
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: nowIso(),
      turnId: turn.turnId,
      itemId: RuntimeItemId.makeUnsafe(turn.assistantItemId),
      payload: {
        streamKind: "assistant_text",
        delta: text,
      },
      providerRefs: {
        providerItemId: ProviderItemId.makeUnsafe(turn.assistantItemId),
      },
      raw: rawEvent("ContentPart", { type: "text", text }),
    });
  });

  const flushPendingAssistantTextAsAnswer = Effect.fn("flushPendingAssistantTextAsAnswer")(
    function* (context: KimiSessionContext, turn: ActiveTurnState) {
      const text = turn.pendingAssistantText;
      turn.pendingAssistantText = "";
      yield* emitAssistantText(context, turn, text);
    },
  );

  const emitToolCallStarted = Effect.fn("emitToolCallStarted")(function* (input: {
    readonly context: KimiSessionContext;
    readonly turn: ActiveTurnState;
    readonly payload: ToolCall;
    readonly parentToolCallId?: string;
  }) {
    if (!input.parentToolCallId) {
      yield* flushPendingAssistantTextAsAnswer(input.context, input.turn);
    }
    input.turn.toolCallSeen = true;
    const toolName = input.payload.function.name;
    const itemType = isTodoListToolName(toolName)
      ? "plan"
      : (classifyProviderToolLifecycleItemType(toolName) ??
        (toolName.toLowerCase() === "agent" || toolName.toLowerCase() === "task"
          ? "collab_agent_tool_call"
          : "dynamic_tool_call"));
    const title = providerToolTitle(toolName);
    const itemId = input.payload.id;
    const toolInFlight: ToolInFlight = {
      toolCallId: input.payload.id,
      itemId,
      itemType,
      toolName,
      title,
      argumentsJson: input.payload.function.arguments ?? "",
    };
    input.turn.toolCalls.set(itemId, toolInFlight);
    input.turn.lastToolCallIdByParent.set(toolParentKey(input.parentToolCallId), itemId);
    const parsedArguments = parseJsonMaybe(input.payload.function.arguments);
    const summaryInput = asRecord(parsedArguments);
    const summary = summarizeProviderToolInvocation(toolName, summaryInput);
    yield* publish({
      type: "item.started",
      eventId: nextEventId(),
      provider: PROVIDER,
      threadId: input.context.session.threadId,
      createdAt: nowIso(),
      turnId: input.turn.turnId,
      itemId: RuntimeItemId.makeUnsafe(itemId),
      payload: {
        itemType,
        title,
        ...(trimOrUndefined(summary) ? { detail: trimOrUndefined(summary) } : {}),
        data: {
          toolName,
          ...(parsedArguments !== null ? { input: parsedArguments } : {}),
        },
      },
      providerRefs: {
        providerItemId: ProviderItemId.makeUnsafe(itemId),
      },
      raw: rawEvent("ToolCall", {
        ...input.payload,
        ...(input.parentToolCallId ? { parent_tool_call_id: input.parentToolCallId } : {}),
      }),
    });
  });

  const emitToolCallCompleted = Effect.fn("emitToolCallCompleted")(function* (input: {
    readonly context: KimiSessionContext;
    readonly turn: ActiveTurnState;
    readonly payload: ToolResult;
    readonly parentToolCallId?: string;
  }) {
    const tool = input.turn.toolCalls.get(input.payload.tool_call_id);
    const toolName = tool?.toolName ?? "tool";
    const parsedArguments =
      tool?.argumentsJson && tool.argumentsJson.trim().length > 0
        ? (() => {
            try {
              return JSON.parse(tool.argumentsJson);
            } catch {
              return tool.argumentsJson;
            }
          })()
        : null;
    const omitCompletedData = shouldOmitKimiCompletedToolData({
      toolName,
      isError: input.payload.return_value.is_error,
    });
    const invocationSummary = trimOrUndefined(
      summarizeProviderToolInvocation(toolName, parsedArguments) ?? undefined,
    );
    const detail = omitCompletedData
      ? invocationSummary
      : (trimOrUndefined(extractBrief(input.payload.return_value.display)) ??
        trimOrUndefined(input.payload.return_value.message) ??
        invocationSummary);

    const todoBlock = input.payload.return_value.display.find(isKimiTodoBlock);
    if (todoBlock) {
      yield* publish({
        type: "turn.tasks.updated",
        eventId: nextEventId(),
        provider: PROVIDER,
        threadId: input.context.session.threadId,
        createdAt: nowIso(),
        turnId: input.turn.turnId,
        payload: {
          source: toolName,
          items: todoBlock.items.map((item: KimiTodoItem, index: number) => ({
            id: `${input.payload.tool_call_id}:${index}`,
            title: item.title,
            status:
              item.status === "in_progress"
                ? "inProgress"
                : item.status === "done"
                  ? "completed"
                  : "pending",
            source: toolName,
          })),
        },
        providerRefs: {},
        raw: rawEvent("ToolResult", input.payload),
      });
    }

    input.turn.toolCalls.delete(input.payload.tool_call_id);
    yield* publish({
      type: "item.completed",
      eventId: nextEventId(),
      provider: PROVIDER,
      threadId: input.context.session.threadId,
      createdAt: nowIso(),
      turnId: input.turn.turnId,
      itemId: RuntimeItemId.makeUnsafe(tool?.itemId ?? input.payload.tool_call_id),
      payload: {
        itemType: tool?.itemType ?? "dynamic_tool_call",
        ...(tool?.title ? { title: tool.title } : {}),
        ...(detail ? { detail } : {}),
        ...(input.payload.return_value.is_error ? { status: "failed" } : { status: "completed" }),
        ...(!omitCompletedData
          ? {
              data: {
                toolName,
                ...(parsedArguments !== null ? { input: parsedArguments } : {}),
                result: {
                  isError: input.payload.return_value.is_error,
                  output: formatContentOutput(input.payload.return_value.output),
                  message: input.payload.return_value.message,
                  display: input.payload.return_value.display,
                },
              },
            }
          : {}),
      },
      providerRefs: {
        providerItemId: ProviderItemId.makeUnsafe(tool?.itemId ?? input.payload.tool_call_id),
      },
      raw: rawEvent("ToolResult", {
        ...input.payload,
        ...(input.parentToolCallId ? { parent_tool_call_id: input.parentToolCallId } : {}),
      }),
    });
  });

  const emitApprovalRequest = Effect.fn("emitApprovalRequest")(function* (input: {
    readonly context: KimiSessionContext;
    readonly turn: ActiveTurnState;
    readonly payload: ApprovalRequestPayload;
  }) {
    const requestType = mapRequestKindToCanonical(
      classifyProviderToolRequestKind(input.payload.sender),
    );
    input.context.pendingApprovals.set(input.payload.id, {
      requestId: input.payload.id,
      requestType,
    });
    yield* publish({
      type: "request.opened",
      eventId: nextEventId(),
      provider: PROVIDER,
      threadId: input.context.session.threadId,
      createdAt: nowIso(),
      turnId: input.turn.turnId,
      requestId: RuntimeRequestId.makeUnsafe(input.payload.id),
      payload: {
        requestType,
        ...(trimOrUndefined(input.payload.description)
          ? { detail: input.payload.description }
          : {}),
        args: {
          sender: input.payload.sender,
          action: input.payload.action,
          display: input.payload.display ?? [],
        },
      },
      providerRefs: {
        providerRequestId: input.payload.id,
      },
      raw: rawEvent("ApprovalRequest", input.payload),
    });
  });

  const emitApprovalResolved = Effect.fn("emitApprovalResolved")(function* (input: {
    readonly context: KimiSessionContext;
    readonly turn: ActiveTurnState;
    readonly requestId: string;
    readonly response: "approve" | "approve_for_session" | "reject";
  }) {
    const pending = input.context.pendingApprovals.get(input.requestId);
    input.context.pendingApprovals.delete(input.requestId);
    const decision =
      input.response === "approve"
        ? "accept"
        : input.response === "approve_for_session"
          ? "acceptForSession"
          : "decline";
    yield* publish({
      type: "request.resolved",
      eventId: nextEventId(),
      provider: PROVIDER,
      threadId: input.context.session.threadId,
      createdAt: nowIso(),
      turnId: input.turn.turnId,
      requestId: RuntimeRequestId.makeUnsafe(input.requestId),
      payload: {
        requestType: pending?.requestType ?? "unknown",
        decision,
      },
      providerRefs: {
        providerRequestId: input.requestId,
      },
      raw: rawEvent("ApprovalResponse", {
        request_id: input.requestId,
        response: input.response,
      }),
    });
  });

  const emitQuestionRequest = Effect.fn("emitQuestionRequest")(function* (input: {
    readonly context: KimiSessionContext;
    readonly turn: ActiveTurnState;
    readonly payload: QuestionRequest;
  }) {
    const questions = buildQuestionItems(input.payload);
    input.context.pendingQuestions.set(input.payload.id, {
      requestId: input.payload.id,
      questions,
    });
    yield* publish({
      type: "user-input.requested",
      eventId: nextEventId(),
      provider: PROVIDER,
      threadId: input.context.session.threadId,
      createdAt: nowIso(),
      turnId: input.turn.turnId,
      requestId: RuntimeRequestId.makeUnsafe(input.payload.id),
      payload: {
        questions,
      },
      providerRefs: {
        providerRequestId: input.payload.id,
      },
      raw: rawEvent("QuestionRequest", input.payload),
    });
  });

  const handleStatusUpdate = Effect.fn("handleStatusUpdate")(function* (input: {
    readonly context: KimiSessionContext;
    readonly turn: ActiveTurnState;
    readonly payload: Extract<StreamEvent, { type: "StatusUpdate" }>["payload"];
  }) {
    const payload = input.payload;
    if (payload.plan_mode !== undefined && payload.plan_mode !== null) {
      input.context.planMode = payload.plan_mode;
    }
    if (payload.token_usage) {
      const usedTokens =
        payload.token_usage.input_other +
        payload.token_usage.output +
        payload.token_usage.input_cache_read +
        payload.token_usage.input_cache_creation;
      if (usedTokens > 0) {
        yield* publish({
          type: "thread.token-usage.updated",
          eventId: nextEventId(),
          provider: PROVIDER,
          threadId: input.context.session.threadId,
          createdAt: nowIso(),
          turnId: input.turn.turnId,
          payload: {
            usage: {
              usedTokens,
              inputTokens: payload.token_usage.input_other,
              cachedInputTokens: payload.token_usage.input_cache_read,
              outputTokens: payload.token_usage.output,
              lastUsedTokens: usedTokens,
              lastInputTokens: payload.token_usage.input_other,
              lastCachedInputTokens: payload.token_usage.input_cache_read,
              lastOutputTokens: payload.token_usage.output,
            },
          },
          providerRefs: {},
          raw: rawEvent("StatusUpdate", payload),
        });
      }
    }
  });

  const handleContentPart = Effect.fn("handleContentPart")(function* (input: {
    readonly context: KimiSessionContext;
    readonly turn: ActiveTurnState;
    readonly payload: ContentPart;
    readonly parentToolCallId?: string;
  }) {
    if (input.parentToolCallId) {
      return;
    }

    const payload = input.payload;

    if (isThinkContentPart(payload)) {
      yield* emitReasoningStarted(input.context, input.turn);
      yield* publish({
        type: "content.delta",
        eventId: nextEventId(),
        provider: PROVIDER,
        threadId: input.context.session.threadId,
        createdAt: nowIso(),
        turnId: input.turn.turnId,
        itemId: RuntimeItemId.makeUnsafe(input.turn.reasoningItemId),
        payload: {
          streamKind: "reasoning_text",
          delta: payload.think,
        },
        providerRefs: {
          providerItemId: ProviderItemId.makeUnsafe(input.turn.reasoningItemId),
        },
        raw: rawEvent("ContentPart", payload),
      });
      return;
    }

    const assistantDelta = kimiAssistantDeltaFromContentPart(payload);
    if (assistantDelta === undefined) {
      return;
    }

    yield* emitAssistantText(input.context, input.turn, assistantDelta);
  });

  const handleStreamEvent: (input: {
    readonly context: KimiSessionContext;
    readonly turn: ActiveTurnState;
    readonly event: StreamEvent;
    readonly parentToolCallId?: string;
  }) => Effect.Effect<void, never, never> = Effect.fn("handleStreamEvent")(function* (input) {
    const { context, turn, event, parentToolCallId } = input;
    turn.items.push(event);

    switch (event.type) {
      case "ContentPart":
        yield* handleContentPart({
          context,
          turn,
          payload: event.payload,
          ...(parentToolCallId ? { parentToolCallId } : {}),
        });
        break;
      case "ToolCall":
        yield* emitToolCallStarted({
          context,
          turn,
          payload: event.payload,
          ...(parentToolCallId ? { parentToolCallId } : {}),
        });
        break;
      case "ToolCallPart": {
        const lastToolId = turn.lastToolCallIdByParent.get(toolParentKey(parentToolCallId));
        const lastTool = lastToolId ? turn.toolCalls.get(lastToolId) : undefined;
        if (lastTool && event.payload.arguments_part) {
          lastTool.argumentsJson += event.payload.arguments_part;
        }
        break;
      }
      case "ToolResult":
        yield* emitToolCallCompleted({
          context,
          turn,
          payload: event.payload,
          ...(parentToolCallId ? { parentToolCallId } : {}),
        });
        break;
      case "ApprovalRequest":
        yield* emitApprovalRequest({
          context,
          turn,
          payload: event.payload,
        });
        break;
      case "ApprovalResponse":
        yield* emitApprovalResolved({
          context,
          turn,
          requestId: event.payload.request_id,
          response: event.payload.response,
        });
        break;
      case "QuestionRequest":
        yield* emitQuestionRequest({
          context,
          turn,
          payload: event.payload,
        });
        break;
      case "StatusUpdate":
        yield* handleStatusUpdate({
          context,
          turn,
          payload: event.payload,
        });
        break;
      case "CompactionBegin":
        yield* publish({
          type: "thread.state.changed",
          eventId: nextEventId(),
          provider: PROVIDER,
          threadId: context.session.threadId,
          createdAt: nowIso(),
          turnId: turn.turnId,
          payload: {
            state: "compacted",
          },
          providerRefs: {},
          raw: rawEvent("CompactionBegin", event.payload),
        });
        break;
      case "SubagentEvent":
        switch (event.payload.event.type) {
          case "ToolCall":
          case "ToolCallPart":
          case "ToolResult":
            yield* handleStreamEvent({
              context,
              turn,
              event: event.payload.event,
              parentToolCallId: event.payload.parent_tool_call_id,
            });
            break;
          default:
            break;
        }
        break;
      case "ParseError":
        yield* publish({
          type: "runtime.warning",
          eventId: nextEventId(),
          provider: PROVIDER,
          threadId: context.session.threadId,
          createdAt: nowIso(),
          turnId: turn.turnId,
          payload: {
            message: event.payload.message,
            detail: {
              code: event.payload.code,
              rawType: event.payload.rawType,
            },
          },
          providerRefs: {},
          raw: rawEvent("ParseError", event.payload),
        });
        break;
      default:
        break;
    }
  });

  const completeTurn = Effect.fn("completeTurn")(function* (input: {
    readonly context: KimiSessionContext;
    readonly turn: ActiveTurnState;
    readonly result: RunResult;
  }) {
    yield* emitReasoningCompleted(input.context, input.turn);
    if (
      shouldFlushKimiPendingTextAsAssistantAnswer({
        turnFinished: input.result.status === "finished",
        toolCallSeen: input.turn.toolCallSeen,
      })
    ) {
      yield* flushPendingAssistantTextAsAnswer(input.context, input.turn);
    }
    if (input.turn.assistantTextSeen) {
      yield* emitAssistantCompleted(input.context, input.turn);
    }

    input.context.turns.push({
      id: input.turn.turnId,
      items: [...input.turn.items],
    });
    input.context.pendingApprovals.clear();
    input.context.pendingQuestions.clear();
    const guardStopReason = input.turn.toolGuardTriggered
      ? input.turn.toolGuardCancelRequested
        ? "tool_loop_guard"
        : "tool_use_blocked"
      : undefined;
    const turnState =
      input.result.status === "cancelled"
        ? input.context.interrupting
          ? "interrupted"
          : "cancelled"
        : input.result.status === "max_steps_reached"
          ? "failed"
          : "completed";
    input.context.activeTurn = null;
    input.context.session = {
      ...input.context.session,
      status: "ready",
      updatedAt: nowIso(),
    };
    yield* persistSession(input.context);
    input.context.interrupting = false;

    if (input.result.status === "max_steps_reached") {
      const loopControl = resolveKimiLoopControlFromEnv();
      const steps = input.result.steps ?? loopControl.maxStepsPerTurn;
      yield* publish({
        type: "runtime.warning",
        eventId: nextEventId(),
        provider: PROVIDER,
        threadId: input.context.session.threadId,
        createdAt: nowIso(),
        turnId: input.turn.turnId,
        payload: {
          message: `Kimi Code stopped after reaching the ShioriCode turn step limit (${steps}/${loopControl.maxStepsPerTurn}).`,
          detail: {
            maxStepsPerTurn: loopControl.maxStepsPerTurn,
            maxRetriesPerStep: loopControl.maxRetriesPerStep,
            maxToolCallsPerTurn: loopControl.maxToolCallsPerTurn,
            maxShellCallsPerTurn: loopControl.maxShellCallsPerTurn,
            status: input.result.status,
          },
        },
        providerRefs: {
          providerTurnId: input.context.sessionId,
        },
        raw: rawEvent("TurnEnd", input.result),
      });
    }

    yield* publish({
      type: "turn.completed",
      eventId: nextEventId(),
      provider: PROVIDER,
      threadId: input.context.session.threadId,
      createdAt: nowIso(),
      turnId: input.turn.turnId,
      payload: {
        state: turnState,
        ...(guardStopReason
          ? { stopReason: guardStopReason }
          : input.result.status === "max_steps_reached"
            ? { stopReason: "max_steps_reached" }
            : {}),
      },
      providerRefs: {
        providerTurnId: input.context.sessionId,
      },
      raw: rawEvent("TurnEnd", input.result),
    });
  });

  const failTurn = Effect.fn("failTurn")(function* (input: {
    readonly context: KimiSessionContext;
    readonly turn: ActiveTurnState;
    readonly cause: unknown;
  }) {
    const message = toMessage(input.cause, "Kimi Code turn failed.");
    yield* emitReasoningCompleted(input.context, input.turn);
    if (
      shouldFlushKimiPendingTextAsAssistantAnswer({
        turnFinished: false,
        toolCallSeen: input.turn.toolCallSeen,
      })
    ) {
      yield* flushPendingAssistantTextAsAnswer(input.context, input.turn);
    }
    if (input.turn.assistantTextSeen) {
      yield* emitAssistantCompleted(input.context, input.turn);
    }
    input.context.activeTurn = null;
    input.context.interrupting = false;
    input.context.pendingApprovals.clear();
    input.context.pendingQuestions.clear();
    input.context.session = {
      ...input.context.session,
      status: "error",
      lastError: message,
      updatedAt: nowIso(),
    };
    yield* persistSession(input.context);
    yield* publish({
      type: "runtime.error",
      eventId: nextEventId(),
      provider: PROVIDER,
      threadId: input.context.session.threadId,
      createdAt: nowIso(),
      turnId: input.turn.turnId,
      payload: {
        message,
        class: "provider_error",
      },
      providerRefs: {},
    });
    yield* publish({
      type: "turn.completed",
      eventId: nextEventId(),
      provider: PROVIDER,
      threadId: input.context.session.threadId,
      createdAt: nowIso(),
      turnId: input.turn.turnId,
      payload: {
        state: "failed",
        errorMessage: message,
      },
      providerRefs: {
        providerTurnId: input.context.sessionId,
      },
    });
  });

  const runTurn = (
    context: KimiSessionContext,
    turn: ActiveTurnState,
    stream: {
      readonly events: AsyncIterable<StreamEvent>;
      readonly result: Promise<RunResult>;
    },
  ) =>
    Effect.promise(async () => {
      const watchdogTimeoutMs = resolveKimiTurnWatchdogTimeoutMsFromEnv();
      let timeout: NodeJS.Timeout | undefined;
      let timedOut = false;
      const consumeTurn = (async () => {
        for await (const event of stream.events) {
          await Effect.runPromise(
            handleStreamEvent({
              context,
              turn,
              event,
            }),
          );
        }
        return stream.result;
      })();
      const watchdog = new Promise<RunResult>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          void context.client.sendCancel().catch(() => undefined);
          reject(
            new Error(
              `Kimi Code turn timed out after ${watchdogTimeoutMs}ms. ShioriCode cancelled the turn so the session can accept new input.`,
            ),
          );
        }, watchdogTimeoutMs);
      });

      try {
        const result = await Promise.race([consumeTurn, watchdog]);
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        await Effect.runPromise(
          completeTurn({
            context,
            turn,
            result,
          }),
        );
      } catch (cause) {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        consumeTurn.catch(() => undefined);
        if (timedOut) {
          await Effect.runPromise(
            publish({
              type: "runtime.warning",
              eventId: nextEventId(),
              provider: PROVIDER,
              threadId: context.session.threadId,
              createdAt: nowIso(),
              turnId: turn.turnId,
              payload: {
                message: toMessage(cause, "Kimi Code turn timed out."),
                detail: {
                  timeoutMs: watchdogTimeoutMs,
                },
              },
              providerRefs: {
                providerTurnId: context.sessionId,
              },
            }),
          );
        }
        await Effect.runPromise(
          failTurn({
            context,
            turn,
            cause,
          }),
        );
      }
    });

  const resolveAttachment = Effect.fn("resolveAttachment")(function* (
    input: ProviderSendTurnInput,
    attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
  ) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }

    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: toMessage(cause, "Failed to read attachment file."),
            cause,
          }),
      ),
    );

    return {
      type: "image_url" as const,
      image_url: {
        url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
        id: attachment.id,
      },
    } satisfies ContentPart;
  });

  const startSession: KimiCodeAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      const settings = yield* serverSettingsService.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to load Kimi Code settings."),
              cause,
            }),
        ),
      );
      const kimiSettings = settings.providers.kimiCode;
      const workDir = trimOrUndefined(input.cwd) ?? serverConfig.cwd;
      const resumeCursor = parseResumeCursor(input.resumeCursor);
      const model =
        input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : DEFAULT_MODEL;
      const yoloMode = input.runtimeMode === "full-access";
      const timestamp = nowIso();
      const executablePath = yield* prepareKimiExecutable({
        threadId: input.threadId,
        executablePath: trimOrUndefined(kimiSettings.binaryPath) ?? "kimi",
      });
      const resources = yield* buildSessionResources({
        threadId: input.threadId,
        cwd: workDir,
      });
      const shareDir = trimOrUndefined(kimiSettings.shareDir);
      const thinking = resolveKimiThinking({
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        ...(shareDir ? { shareDir } : {}),
      });
      const baseFingerprint = buildKimiSessionFingerprint({
        agentSignature: resources.toolRuntime?.signature ?? "",
        workDir,
        ...(shareDir ? { shareDir } : {}),
      });
      const fingerprintMismatch = findKimiResumeFingerprintMismatch({
        previous: resumeCursor?.fingerprint,
        next: baseFingerprint,
      });
      const shouldResume = resumeCursor !== undefined && fingerprintMismatch === undefined;
      const sessionId = shouldResume ? resumeCursor.sessionId : randomUUID();
      const hydratedSnapshot =
        shouldResume && resumeCursor
          ? yield* Effect.tryPromise({
              try: () => parseSessionEvents(workDir, resumeCursor.sessionId),
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/resume",
                  detail: toMessage(cause, "Failed to hydrate Kimi Code session history."),
                  cause,
                }),
            }).pipe(
              Effect.map((events) => turnSnapshotFromEvents(input.threadId, sessionId, events)),
            )
          : {
              threadId: input.threadId,
              turns: [],
            };
      const context: KimiSessionContext = {
        session: buildSession(
          {
            threadId: input.threadId,
            workDir,
            sessionId,
            fingerprint: baseFingerprint,
            runtimeMode: input.runtimeMode,
            model,
          },
          timestamp,
        ),
        sessionId,
        client: new ProtocolClient(),
        workDir,
        executablePath,
        shareDir,
        model,
        thinking,
        resumeFingerprint: baseFingerprint,
        yoloMode,
        planMode: false,
        agentFilePath: resources.agentFilePath,
        externalTools: resources.externalTools,
        toolRuntime: resources.toolRuntime,
        stopped: false,
        interrupting: false,
        pendingApprovals: new Map(),
        pendingQuestions: new Map(),
        activeTurn: null,
        turns: hydratedSnapshot.turns.map((turn) => ({
          id: turn.id,
          items: [...turn.items],
        })),
      };

      if (shouldResume) {
        yield* startClient(context, { resumePayload: input.resumeCursor });
      } else {
        yield* startClient(context);
      }
      if (fingerprintMismatch) {
        yield* publish({
          type: "runtime.warning",
          eventId: nextEventId(),
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt: nowIso(),
          payload: {
            message:
              "Kimi Code resume metadata changed; ShioriCode started a fresh session instead of reusing incompatible history.",
            detail: {
              changedField: fingerprintMismatch,
              previousSessionId: resumeCursor?.sessionId,
              nextSessionId: sessionId,
            },
          },
          providerRefs: {},
        });
      } else if (resumeCursor?.fingerprint) {
        const runtimeMismatch = findKimiResumeFingerprintMismatch({
          previous: resumeCursor.fingerprint,
          next: context.resumeFingerprint,
          compareRuntime: true,
        });
        if (runtimeMismatch) {
          yield* publish({
            type: "runtime.warning",
            eventId: nextEventId(),
            provider: PROVIDER,
            threadId: input.threadId,
            createdAt: nowIso(),
            payload: {
              message: "Kimi Code runtime metadata changed since the saved session was created.",
              detail: {
                changedField: runtimeMismatch,
                sessionId,
              },
            },
            providerRefs: {},
          });
        }
      }
      return context.session;
    },
  );

  const sendTurn: KimiCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    if (context.activeTurn) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "turn/start",
        issue: "A Kimi Code turn is already in progress.",
      });
    }

    const settings = yield* serverSettingsService.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to load Kimi Code settings."),
            cause,
          }),
      ),
    );
    const kimiSettings = settings.providers.kimiCode;
    const model =
      input.modelSelection?.provider === PROVIDER
        ? input.modelSelection.model
        : (context.model ?? DEFAULT_MODEL);
    const yoloMode = context.session.runtimeMode === "full-access";
    const executablePath = yield* prepareKimiExecutable({
      threadId: input.threadId,
      executablePath: trimOrUndefined(kimiSettings.binaryPath) ?? "kimi",
    });
    const shareDir = trimOrUndefined(kimiSettings.shareDir);
    const thinking = resolveKimiThinking({
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(shareDir ? { shareDir } : {}),
      fallback: context.thinking,
    });
    const resources = yield* buildSessionResources({
      threadId: input.threadId,
      cwd: context.workDir,
    });

    yield* restartClientIfNeeded(context, {
      model,
      thinking,
      yoloMode,
      executablePath,
      shareDir,
      agentFilePath: resources.agentFilePath,
      externalTools: resources.externalTools,
      toolRuntime: resources.toolRuntime,
    });

    const desiredPlanMode =
      input.interactionMode === "plan"
        ? true
        : input.interactionMode === "default"
          ? false
          : context.planMode;
    if (context.planMode !== desiredPlanMode) {
      const result = yield* Effect.tryPromise({
        try: () => context.client.sendSetPlanMode(desiredPlanMode),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/set_plan_mode",
            detail: toMessage(cause, "Failed to update Kimi Code plan mode."),
            cause,
          }),
      });
      context.planMode = result.plan_mode;
    }

    const parts: ContentPart[] = [];
    if (trimOrUndefined(input.input)) {
      parts.push({
        type: "text",
        text: input.input!,
      });
    }
    const attachmentParts = yield* Effect.forEach(
      input.attachments ?? [],
      (attachment) => resolveAttachment(input, attachment),
      { concurrency: 1 },
    );
    parts.push(...attachmentParts);
    if (parts.length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "turn/start",
        issue: "Kimi Code turns require input text or at least one attachment.",
      });
    }

    const turnId = TurnId.makeUnsafe(randomUUID());
    const loopControl = resolveKimiLoopControlFromEnv();
    const toolsDisabledReason = shouldAvoidKimiToolsForUserInput(input.input)
      ? "The user is asking about excessive command usage or asking Kimi Code to stop; answer directly without tools."
      : undefined;
    const turn: ActiveTurnState = {
      turnId,
      assistantItemId: `assistant:${turnId}`,
      reasoningItemId: `reasoning:${turnId}`,
      items: [],
      toolCalls: new Map(),
      lastToolCallIdByParent: new Map(),
      pendingAssistantText: "",
      toolCallSeen: false,
      assistantStarted: false,
      assistantCompleted: false,
      assistantTextSeen: false,
      reasoningStarted: false,
      reasoningCompleted: false,
      toolGuardToolCallCount: 0,
      toolGuardShellCallCount: 0,
      toolGuardMaxToolCallsPerTurn: loopControl.maxToolCallsPerTurn,
      toolGuardMaxShellCallsPerTurn: loopControl.maxShellCallsPerTurn,
      toolGuardToolsDisabledReason: toolsDisabledReason,
      toolGuardTriggered: false,
      toolGuardWarningEmitted: false,
      toolGuardCancelRequested: false,
      toolGuardReason: undefined,
    };
    context.activeTurn = turn;
    context.session = {
      ...context.session,
      status: "running",
      ...(model ? { model } : {}),
      updatedAt: nowIso(),
    };
    yield* persistSession(context);

    yield* publish({
      type: "turn.started",
      eventId: nextEventId(),
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: nowIso(),
      turnId,
      payload: model ? { model } : {},
      providerRefs: {
        providerTurnId: context.sessionId,
      },
    });

    const firstPart = parts[0];
    const promptContent: string | ContentPart[] =
      parts.length === 1 && isTextContentPart(firstPart) ? firstPart.text : parts;

    const stream = yield* Effect.try({
      try: () => context.client.sendPrompt(promptContent),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: toMessage(cause, "Failed to start Kimi Code turn."),
          cause,
        }),
    });

    return yield* Effect.sync(
      () => (
        void Effect.runPromise(runTurn(context, turn, stream)),
        {
          threadId: input.threadId,
          turnId,
          resumeCursor: contextResumeCursor(context),
        } satisfies ProviderTurnStartResult
      ),
    );
  });

  const interruptTurn: KimiCodeAdapterShape["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      context.interrupting = true;
      yield* Effect.tryPromise({
        try: () => context.client.sendCancel(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/cancel",
            detail: toMessage(cause, "Failed to interrupt Kimi Code turn."),
            cause,
          }),
      });
    });

  const respondToRequest: KimiCodeAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      if (!context.pendingApprovals.has(requestId)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "request/respond",
          detail: `Unknown Kimi Code approval request '${requestId}'.`,
        });
      }

      const approvalResponse =
        decision === "accept"
          ? "approve"
          : decision === "acceptForSession"
            ? "approve_for_session"
            : decision === "decline" || decision === "cancel"
              ? "reject"
              : null;
      if (!approvalResponse) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "request/respond",
          issue: "Kimi Code only supports simple approval responses.",
        });
      }

      yield* Effect.tryPromise({
        try: () => context.client.sendApproval(requestId, approvalResponse),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "request/respond",
            detail: toMessage(cause, "Failed to respond to Kimi Code approval request."),
            cause,
          }),
      });
    });

  const respondToUserInput: KimiCodeAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const pending = context.pendingQuestions.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "user-input/respond",
          detail: `Unknown Kimi Code question request '${requestId}'.`,
        });
      }

      const normalizedAnswers = normalizeKimiQuestionAnswers(pending.questions, answers);

      yield* Effect.tryPromise({
        try: () => context.client.sendQuestionResponse(requestId, requestId, normalizedAnswers),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "user-input/respond",
            detail: toMessage(cause, "Failed to respond to Kimi Code question request."),
            cause,
          }),
      });

      context.pendingQuestions.delete(requestId);
      yield* publish({
        type: "user-input.resolved",
        eventId: nextEventId(),
        provider: PROVIDER,
        threadId: threadId,
        createdAt: nowIso(),
        ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
        requestId: RuntimeRequestId.makeUnsafe(requestId),
        payload: {
          answers: normalizedAnswers,
        },
        providerRefs: {
          providerRequestId: requestId,
        },
      });
    });

  const stopSession: KimiCodeAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      context.stopped = true;
      context.pendingApprovals.clear();
      context.pendingQuestions.clear();
      yield* closeSessionResources(context);
      if (context.client.isRunning) {
        yield* Effect.tryPromise({
          try: () => context.client.stop(),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: toMessage(cause, "Failed to stop Kimi Code runtime."),
              cause,
            }),
        });
      }
      context.session = {
        ...context.session,
        status: "closed",
        updatedAt: nowIso(),
      };
      yield* publish({
        type: "session.exited",
        eventId: nextEventId(),
        provider: PROVIDER,
        threadId,
        createdAt: nowIso(),
        payload: {
          reason: "Session stopped",
          recoverable: false,
          exitKind: "graceful",
        },
        providerRefs: {},
      });
      yield* removeSession(threadId);
    });

  const listSessions: KimiCodeAdapterShape["listSessions"] = () =>
    getSessions().pipe(
      Effect.map((sessions) => [...sessions.values()].map((context) => context.session)),
    );

  const hasSession: KimiCodeAdapterShape["hasSession"] = (threadId) =>
    getSessions().pipe(Effect.map((sessions) => sessions.has(threadId)));

  const readThread: KimiCodeAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const events = yield* Effect.tryPromise({
        try: () => parseSessionEvents(context.workDir, context.sessionId),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "thread/read",
            detail: toMessage(cause, "Failed to read Kimi Code session history."),
            cause,
          }),
      });
      if (events.length === 0 && context.turns.length > 0) {
        return {
          threadId,
          turns: context.turns,
        };
      }
      return turnSnapshotFromEvents(threadId, context.sessionId, events);
    });

  const rollbackThread: KimiCodeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const before = yield* readThread(threadId);
      const keepTurns = Math.max(0, before.turns.length - numTurns);

      if (keepTurns === before.turns.length) {
        return before;
      }

      if (context.client.isRunning) {
        yield* Effect.tryPromise({
          try: () => context.client.stop(),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: toMessage(cause, "Failed to stop Kimi Code runtime before rollback."),
              cause,
            }),
        });
      }

      const nextSessionId =
        keepTurns <= 0
          ? randomUUID()
          : (yield* Effect.tryPromise({
              try: () =>
                forkSession({
                  workDir: context.workDir,
                  sourceSessionId: context.sessionId,
                  turnIndex: keepTurns - 1,
                }),
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "thread/rollback",
                  detail: toMessage(cause, "Failed to fork Kimi Code session during rollback."),
                  cause,
                }),
            })).sessionId;

      context.sessionId = nextSessionId;
      context.client = new ProtocolClient();
      context.turns =
        keepTurns <= 0
          ? []
          : before.turns.slice(0, keepTurns).map((turn) => ({
              id: turn.id,
              items: [...turn.items],
            }));
      context.activeTurn = null;
      context.pendingApprovals.clear();
      context.pendingQuestions.clear();
      yield* closeSessionResources(context);
      const resources = yield* buildSessionResources({
        threadId,
        cwd: context.workDir,
      });
      context.resumeFingerprint = buildKimiSessionFingerprint({
        agentSignature: resources.toolRuntime?.signature ?? "",
        workDir: context.workDir,
        ...(context.shareDir ? { shareDir: context.shareDir } : {}),
      });
      context.session = {
        ...context.session,
        status: "ready",
        resumeCursor: contextResumeCursor(context),
        updatedAt: nowIso(),
        lastError: undefined,
      };
      context.agentFilePath = resources.agentFilePath;
      context.externalTools = resources.externalTools;
      context.toolRuntime = resources.toolRuntime;

      yield* startClient(context, {
        emitLifecycle: true,
        resumePayload: contextResumeCursor(context),
      });

      return keepTurns <= 0
        ? {
            threadId,
            turns: [],
          }
        : yield* readThread(threadId);
    });

  const stopAll: KimiCodeAdapterShape["stopAll"] = () =>
    Effect.gen(function* () {
      const sessions = yield* getSessions();
      yield* Effect.forEach([...sessions.keys()], (threadId) => stopSession(threadId), {
        concurrency: 1,
      }).pipe(Effect.asVoid);
    });

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "restart-session",
      recovery: {
        supportsResumeCursor: true,
        supportsAdoptActiveSession: false,
      },
      observability: {
        emitsStructuredSessionExit: true,
        emitsRuntimeDiagnostics: true,
      },
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEvents);
    },
  } satisfies KimiCodeAdapterShape;
});

export const KimiCodeAdapterLive = Layer.effect(KimiCodeAdapter, makeKimiCodeAdapter());
