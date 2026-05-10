import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { spawn, spawnSync, type ChildProcess as ChildProcessHandle } from "node:child_process";
import path from "node:path";

import {
  ApprovalRequestId,
  type ChatAttachment,
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  type UserInputQuestion,
  type McpServerEntry,
  type CanonicalItemType,
  RuntimeItemId,
  RuntimeRequestId,
  type ShioriModelOptions,
  type AssistantPersonality,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "contracts";
import {
  parseJsonEventStream,
  type ProviderMetadata,
  type UIMessage,
  type UIMessageChunk,
  uiMessageChunkSchema,
} from "ai";
import { Duration, Effect, Layer, Option, PubSub, Ref, Schema, Stream } from "effect";
import {
  classifyProviderToolLifecycleItemType,
  classifyProviderToolRequestKind,
  providerToolTitle,
  summarizeProviderToolInvocation,
} from "shared/providerTool";
import { resolveModelSlugForProvider } from "shared/model";
import {
  HOSTED_SHIORI_DEVELOPMENT_CONVEX_URL,
  hostedShioriAuthTokenMatchesConvexUrl,
  resolveHostedShioriConvexUrl,
} from "shared/hostedShioriConvex";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { buildAssistantSettingsAppendix } from "../../assistantPersonality.ts";
import { ServerConfig } from "../../config.ts";
import { HostedShioriAuthTokenStore } from "../../hostedShioriAuthTokenStore.ts";
import { makeKanbanProviderToolRuntime } from "../../kanban/providerTools.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { WorkspaceEntries } from "../../workspace/Services/WorkspaceEntries.ts";
import { isSimpleApprovalDecision } from "../providerApprovalDecision.ts";
import {
  buildProviderMcpToolRuntime,
  builtInShioriMcpServers,
  loadEffectiveMcpServersForProvider,
  type ProviderMcpToolExecutor,
  type ProviderMcpToolRuntime,
} from "../mcpServers.ts";
import { buildShioriSkillToolRuntime, type ProviderSkillRuntime } from "../skills.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { executeShioriWebSearch } from "../shioriWebSearch.ts";
import {
  fetchShioriCodeBootstrap,
  type ShioriCodeBootstrapConfig,
  type ShioriCodeBootstrapProbe,
} from "../shioriCodeBootstrap.ts";
import { ShioriAdapter, type ShioriAdapterShape } from "../Services/ShioriAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";

const PROVIDER = "shiori" as const;
const SHIORI_ASSISTANT_ITEM_PREFIX = "assistant";
const SHIORI_REASONING_ITEM_PREFIX = "reasoning";
export const SHIORI_WORKSPACE_RULES = [
  [
    "# ShioriCode System Prompt",
    "",
    "## Identity",
    "You are ShioriCode, a coding assistant running inside a local desktop runtime.",
    "You are the assistant for this product and session.",
    "You are not Codex, Claude, or ChatGPT unless the user explicitly asks for a comparison.",
    "Do not describe yourself as being in a generic or tool-less chat environment when local tools are available.",
    "",
    "## Mission",
    "Help the user complete real coding and desktop tasks accurately and efficiently.",
    "Prefer direct action over explanation when a tool can safely do the work.",
    "Optimize for correctness, useful progress, and concrete outcomes.",
    "When the user asks for something actionable, try to do it instead of only describing how to do it.",
    "",
    "## Operating Priorities",
    "1. Tell the truth about the current environment and observed results.",
    "2. Use available tools to gather evidence before making claims.",
    "3. Complete the requested task with the lightest safe path.",
    "4. Keep responses concise, concrete, and technically precise.",
    "",
    "## Capabilities",
    "You have full access to the user's local machine through the tools exposed in this session.",
    "This includes the ability to read and write arbitrary files, execute shell commands, browse the filesystem, and launch applications — you are not sandboxed or limited to a single workspace directory.",
    "Use only the tools actually exposed in this session.",
    "If local tools such as exec_command, read_file, write_file, or edit are available, treat them as real capabilities of your current environment.",
    "Do not claim you lack local machine, workspace, file, or application-launch access when an available tool can perform the action.",
    "Do not describe a limitation unless it is supported by the actual tool surface or by an observed tool failure.",
    "",
    "## Tool Grounding",
    "Ground every claim about commands, file changes, launches, and tool availability in actual tool results from this session.",
    "Never contradict a successful tool call.",
    "If a command fails or is ambiguous, say so plainly and use the observed exit code, stdout, stderr, or other tool output.",
    "If a tool result is incomplete or uncertain, state exactly what is known and what remains unverified.",
    "",
    "## Tool Use Policy",
    "Inspect local context before guessing.",
    "Prefer reading files, checking logs, or running commands over inventing explanations.",
    "Do not ask the user to manually perform an action that an available tool can perform directly.",
    "Do not summarize a command result in a way that changes its meaning.",
    "When a tool completes a user request, acknowledge completion directly.",
    "",
    "## Coding Behavior",
    "When working with code, prefer minimal, targeted changes that preserve existing behavior unless the user asked for a broader refactor.",
    "Base technical explanations on the code, configuration, and tool output available in the workspace.",
    "If you changed files or ran commands, report the outcome accurately.",
    "",
    "## Local Launch Actions",
    "If the user asks to open a file, URL, or app and a local tool can do it, do the action instead of claiming you cannot.",
    "After attempting a launch, report success or failure based on the actual command result.",
    "Do not claim to have visually verified something unless a tool actually provided that verification.",
    "",
    "## Uncertainty And Honesty",
    "Do not invent missing permissions, tool limitations, file contents, command results, or user actions.",
    "If the correct next step is unclear, inspect the local context before guessing.",
    "When uncertainty remains, be explicit about what is known, what is inferred, and what remains unverified.",
    "",
    "## Response Style",
    "Be concise, direct, and technically precise.",
    "Use Markdown formatting for normal text responses when it improves clarity.",
    "Prefer real Markdown structure such as headings, bullets, numbered lists, tables, and fenced code blocks instead of plain-text pseudo-formatting.",
    "Do not force Markdown for very short acknowledgements or single-line replies that are clearer without it.",
    "Prefer concrete outcomes and next actions over generic reassurance.",
    "Do not produce role confusion, brand confusion, or generic fallback disclaimers that conflict with the actual environment.",
  ].join("\n"),
] as const;

interface ShioriRuntimePromptContext {
  readonly cwd?: string | undefined;
  readonly now?: Date | undefined;
  readonly hostname?: string | undefined;
  readonly username?: string | undefined;
  readonly platform?: NodeJS.Platform | string | undefined;
  readonly arch?: string | undefined;
  readonly timeZone?: string | undefined;
  readonly personality?: AssistantPersonality | undefined;
  readonly generateMemories?: boolean | undefined;
  readonly interactionMode?: "default" | "plan" | undefined;
  readonly skillPrompt?: string | undefined;
  readonly browserUseEnabled?: boolean | undefined;
  readonly computerUseEnabled?: boolean | undefined;
}

function resolveLocalTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
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

export function buildShioriWorkspaceRules(
  input: ShioriRuntimePromptContext = {},
): ReadonlyArray<string> {
  const now = input.now ?? new Date();
  const hostname = input.hostname ?? os.hostname();
  const username = input.username ?? os.userInfo().username;
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const timeZone = input.timeZone ?? resolveLocalTimeZone();
  const assistantSettingsAppendix = buildAssistantSettingsAppendix({
    personality: input.personality,
    generateMemories: input.generateMemories,
  });

  return [
    ...SHIORI_WORKSPACE_RULES,
    ...(input.interactionMode === "plan"
      ? [
          [
            "## Plan Mode",
            "You are currently in plan mode.",
            "Stay in planning unless the user explicitly asks you to implement.",
            "Inspect local context and code when needed, but do not make code or file changes in this mode.",
            "Use the `update_plan` tool to keep the client-visible plan current as your understanding improves.",
            "If you are blocked on a user choice, use the `request_user_input` tool instead of asking in freeform text.",
            "When you are ready to present the final answer, reply with only the final plan in Markdown.",
            "Start the final plan with a heading and keep it implementation-oriented.",
          ].join("\n"),
        ]
      : []),
    ...(input.browserUseEnabled
      ? [
          [
            "## Browser Use",
            "Browser use is enabled for this session.",
            "If the user asks to open or inspect a browser page and an available browser tool can perform the action, use it.",
            "If a browser-opening command such as open, start, or xdg-open exits with code 0 and does not report an error, treat the open request as completed.",
            "This does not override explicit Computer Use requests.",
          ].join("\n"),
        ]
      : []),
    ...(input.computerUseEnabled
      ? [
          [
            "## Computer Use",
            "Computer Use means the ShioriCode desktop-control tools whose names end with computer_screenshot, computer_click, computer_move, computer_type, computer_key, and computer_scroll.",
            "When the user explicitly asks to use Computer Use, satisfy that request with those Computer Use tools.",
            "Do not substitute shell commands such as open, osascript, screencapture, xdotool, cliclick, or browser automation for an explicit Computer Use request.",
            "If the Computer Use tools are not exposed in the current tool surface, say Computer Use is unavailable or gated in this session instead of simulating it with shell commands.",
            "Use computer_screenshot before claiming what is visible on the desktop or choosing screen coordinates.",
            "Do not claim to have visually verified desktop state unless a Computer Use screenshot or another tool result provided that evidence.",
          ].join("\n"),
        ]
      : []),
    ...(input.skillPrompt ? [input.skillPrompt] : []),
    ...(assistantSettingsAppendix ? [assistantSettingsAppendix] : []),
    [
      "## Runtime Context",
      "The following local context describes the user's machine and current local time for this session.",
      "Treat it as current unless later tool results or the user provide newer information.",
      `- Local date: ${formatLocalDate(now)}`,
      `- Local weekday: ${formatLocalWeekday(now)}`,
      `- Local time: ${formatLocalTime(now)}`,
      `- Local timezone: ${timeZone}`,
      `- Machine hostname: ${hostname}`,
      `- Local username: ${username}`,
      `- Platform: ${platform}`,
      `- Architecture: ${arch}`,
      `- Workspace root: ${input.cwd ?? "unknown"}`,
      "",
      "Use this context when the user asks about today, local paths, local environment assumptions, or anything tied to their machine.",
    ].join("\n"),
  ];
}
const MAX_PERSISTED_MESSAGES = 48;
const JWT_LIKE_TOKEN_PATTERN = /^[^.]+\.[^.]+\.[^.]+$/;
const LOCAL_TOOL_COMMAND_TIMEOUT_MS = 60_000;
const MAX_TOOL_FILE_CHARS = 20_000;
const MAX_TOOL_COMMAND_OUTPUT_CHARS = 12_000;
const MAX_SUBAGENT_TOOL_ROUNDS = 16;
const HOSTED_BOOTSTRAP_CACHE_TTL_MS = 60_000;
const SUBAGENT_NOTIFICATION_OPEN_TAG = "<subagent_notification>";
const SUBAGENT_NOTIFICATION_CLOSE_TAG = "</subagent_notification>";
const INTERNAL_HOSTED_TOOL_NAMES = new Set(["wait_for_response"]);
const SUBAGENT_TOOL_NAMES = new Set([
  "spawn_agent",
  "send_input",
  "wait_agent",
  "close_agent",
  "agent",
  "send_message",
]);
const KANBAN_TOOL_PREFIX = "kanban_";
export const CONSERVATIVE_SHIORI_BOOTSTRAP: ShioriCodeBootstrapConfig = {
  approvalPolicies: {
    fileWrite: "ask",
    shellCommand: "ask",
    destructiveChange: "ask",
    networkCommand: "ask",
    mcpSideEffect: "ask",
    outsideWorkspace: "ask",
  },
  protectedPaths: [
    ".git",
    ".env",
    ".env.*",
    "~/.ssh",
    "~/.aws",
    "~/.config/gcloud",
    "~/.shioricode",
  ],
  browserUse: { enabled: false },
  computerUse: { enabled: false },
  mobileApp: { enabled: false },
  kanban: { enabled: false },
  subagents: {
    enabled: false,
    profiles: {},
  },
};

export type ApprovalRequestKind = "command" | "file-read" | "file-change";
type HostedDescriptorRequestKind = ApprovalRequestKind | "mcp-side-effect";

type HostedShioriMessage = UIMessage;

interface ShioriTurnState {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
  readonly messageCount: number;
}

type ShioriResumeCursor = {
  readonly messages: ReadonlyArray<HostedShioriMessage>;
  readonly turns: ReadonlyArray<{
    readonly id: string;
    readonly items?: ReadonlyArray<unknown>;
    readonly messageCount: number;
  }>;
  readonly runtime?: {
    readonly activeTurn?: {
      readonly turnId: string;
      readonly interactionMode: "default" | "plan";
      readonly modelSettings?: HostedShioriModelSettings;
    };
    readonly pendingApprovals?: ReadonlyArray<{
      readonly requestId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: Record<string, unknown>;
      readonly assistantMessageId: string;
      readonly approvalId?: string;
      readonly requestKind?: ApprovalRequestKind;
      readonly callProviderMetadata?: unknown;
    }>;
    readonly pendingUserInputs?: ReadonlyArray<{
      readonly requestId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: Record<string, unknown>;
      readonly assistantMessageId: string;
      readonly callProviderMetadata?: unknown;
    }>;
    readonly allowedRequestKinds?: ReadonlyArray<ApprovalRequestKind>;
    readonly subagents?: ReadonlyArray<{
      readonly id: string;
      readonly taskName: string;
      readonly nickname?: string | null;
      readonly toolStyle: "codex" | "claude";
      readonly description: string;
      readonly subagentType?: string | null;
      readonly modelId: string;
      readonly status: ShioriSubagentLifecycleStatus;
      readonly queuedInputs?: ReadonlyArray<{
        readonly id: string;
        readonly prompt: string;
        readonly submittedAt: string;
      }>;
      readonly history?: ReadonlyArray<HostedShioriMessage>;
      readonly terminalSequence?: number;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly parentTurnId?: string;
      readonly parentToolUseId?: string;
      readonly lastSummary?: string;
      readonly lastError?: string;
    }>;
    readonly pendingSubagentNotifications?: ReadonlyArray<string>;
  };
};

interface ActiveTurnState {
  readonly turnId: TurnId;
  readonly controller: AbortController;
  readonly assistantItemId: RuntimeItemId;
  readonly interactionMode: "default" | "plan";
  readonly mcpToolDescriptors: ReadonlyArray<HostedToolDescriptor>;
  readonly mcpTools: ReadonlyMap<string, ProviderMcpToolExecutor>;
  readonly closeMcpTools: () => Promise<void>;
  readonly skillPrompt?: string | undefined;
  readonly modelSettings?: HostedShioriModelSettings | undefined;
  hostedBootstrap?: ShioriCodeBootstrapConfig | null;
  assistantText: string;
  assistantFinalText: string;
  assistantActiveItemId: RuntimeItemId | null;
  assistantStarted: boolean;
  commentaryCount: number;
  reasoningBlocks: Map<
    string,
    {
      itemId: RuntimeItemId;
      text: string;
      providerMetadata: ProviderMetadata | undefined;
      completed: boolean;
      includedInHistory: boolean;
      visibleStarted: boolean;
    }
  >;
  reasoningBlockOrder: string[];
}

type ShioriSessionToolRuntime = ProviderSkillRuntime;

interface HostedShioriModelSettings {
  readonly reasoningEnabled?: boolean;
  readonly reasoningEffort?: "low" | "medium" | "high";
}

export interface HostedToolDescriptor {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface HostedToolContext {
  allowedRequestKinds: Set<ApprovalRequestKind>;
  session: Pick<ProviderSession, "runtimeMode">;
  interactionMode?: "default" | "plan";
  mcpToolDescriptors?: ReadonlyArray<HostedToolDescriptor>;
  hostedBootstrap?: ShioriCodeBootstrapConfig | null;
}

interface PendingToolCall {
  requestId: ApprovalRequestId;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  assistantMessageId: string;
  approvalId?: string;
  requestKind?: ApprovalRequestKind;
  callProviderMetadata?: unknown;
  reasoningBlockIds?: string[];
}

interface DecodedShioriResumeState {
  readonly messages: HostedShioriMessage[];
  readonly turns: ShioriTurnState[];
  readonly activeTurnSnapshot: {
    readonly turnId: TurnId;
    readonly interactionMode: "default" | "plan";
    readonly modelSettings?: HostedShioriModelSettings;
  } | null;
  readonly pendingApprovals: ReadonlyArray<PendingToolCall>;
  readonly pendingUserInputs: ReadonlyArray<PendingToolCall>;
  readonly allowedRequestKinds: ReadonlyArray<ApprovalRequestKind>;
  readonly subagents: ReadonlyArray<ShioriSubagentState>;
  readonly pendingSubagentNotifications: ReadonlyArray<string>;
}

type ShioriSubagentLifecycleStatus =
  | "pending_init"
  | "running"
  | "completed"
  | "failed"
  | "shutdown";

interface ShioriSubagentQueuedInput {
  id: string;
  prompt: string;
  submittedAt: string;
}

interface ShioriSubagentState {
  id: string;
  taskName: string;
  nickname: string | null;
  toolStyle: "codex" | "claude";
  description: string;
  subagentType: string | null;
  modelId: string;
  status: ShioriSubagentLifecycleStatus;
  queuedInputs: ReadonlyArray<ShioriSubagentQueuedInput>;
  history: ReadonlyArray<HostedShioriMessage>;
  runnerActive: boolean;
  terminalSequence: number;
  createdAt: string;
  updatedAt: string;
  parentTurnId?: TurnId;
  parentToolUseId?: string;
  currentRun?:
    | {
        inputId: string;
        controller: AbortController;
      }
    | undefined;
  lastSummary?: string;
  lastError?: string;
}

interface ShioriSessionContext {
  session: ProviderSession;
  messages: HostedShioriMessage[];
  turns: ShioriTurnState[];
  activeTurn: ActiveTurnState | null;
  hostedBootstrap?: ShioriCodeBootstrapConfig | null;
  hostedBootstrapFetchedAt?: number;
  toolRuntime: ShioriSessionToolRuntime | null;
  pendingApprovals: Map<ApprovalRequestId, PendingToolCall>;
  pendingUserInputs: Map<ApprovalRequestId, PendingToolCall>;
  allowedRequestKinds: Set<ApprovalRequestKind>;
  subagents: Map<string, ShioriSubagentState>;
  subagentSequence: number;
  pendingSubagentNotifications: string[];
}

export interface ShioriAdapterLiveOptions {
  readonly buildMcpToolRuntime?: (input: {
    readonly provider: "shiori";
    readonly servers: ReadonlyArray<McpServerEntry>;
    readonly cwd?: string;
  }) => Promise<ProviderMcpToolRuntime>;
  readonly buildSkillToolRuntime?: (input: {
    readonly cwd?: string;
  }) => Promise<ProviderSkillRuntime>;
  readonly fetchBootstrapProbe?: (input: {
    readonly apiBaseUrl: string;
    readonly authToken: string | null;
  }) => Effect.Effect<ShioriCodeBootstrapProbe>;
  // Max retry attempts for transient hosted-stream failures (default 3). Set to 0
  // to disable retries. Tests typically override this to produce deterministic
  // attempt counts.
  readonly maxFetchRetries?: number;
  // Delay before the nth retry attempt (1-indexed). Default is exponential backoff
  // starting at 250ms. Tests commonly override this to () => 0.
  readonly fetchRetryDelayMs?: (attempt: number) => number;
  // Overridable stream-read timeout. Tests can shorten this to exercise the timeout
  // path without waiting 5 minutes.
  readonly streamReadTimeout?: Duration.Input;
  // Overridable response-header timeout. This guards the period before fetch resolves
  // with a Response, which is separate from streaming body reads.
  readonly hostedFetchResponseTimeout?: Duration.Input;
  // Overridable payload byte cap. Tests can lower this to force an overflow error.
  readonly maxStreamBytes?: number;
  // Overridable local command timeout. Tests can shorten this without changing the
  // production command deadline.
  readonly localToolCommandTimeoutMs?: number;
}

function buildHostedModelSettings(
  modelOptions: ShioriModelOptions | null | undefined,
): HostedShioriModelSettings | undefined {
  const settings: HostedShioriModelSettings = {
    ...(typeof modelOptions?.thinking === "boolean"
      ? { reasoningEnabled: modelOptions.thinking }
      : {}),
    ...(modelOptions?.reasoningEffort ? { reasoningEffort: modelOptions.reasoningEffort } : {}),
  };
  return Object.keys(settings).length > 0 ? settings : undefined;
}

function ensureProvider(operation: string, provider: string | undefined) {
  if (provider !== undefined && provider !== PROVIDER) {
    return new ProviderAdapterValidationError({
      provider: PROVIDER,
      operation,
      issue: `Expected provider '${PROVIDER}' but received '${provider}'.`,
    });
  }
  return null;
}

function requestError(
  method: string,
  detail: string,
  cause?: unknown,
): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function resolveApiBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function isJwtLikeToken(token: string | null | undefined): token is string {
  return typeof token === "string" && JWT_LIKE_TOKEN_PATTERN.test(token.trim());
}

function isExpectedHostedShioriAuthToken(token: string | null | undefined): token is string {
  return (
    isJwtLikeToken(token) &&
    hostedShioriAuthTokenMatchesConvexUrl({
      token,
      convexUrl: hostedShioriConvexUrl,
    })
  );
}

function describeToken(token: string | null | undefined) {
  return {
    present: typeof token === "string",
    jwtLike: isJwtLikeToken(token),
    expectedDeployment: isExpectedHostedShioriAuthToken(token),
  };
}

const SHIORI_API_VERSION = "1" as const;
const hostedShioriConvexUrl = resolveHostedShioriConvexUrl(
  process.env.VITE_CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL,
  process.env.VITE_DEV_SERVER_URL ? HOSTED_SHIORI_DEVELOPMENT_CONVEX_URL : undefined,
);
// 300s is the remote Next.js maxDuration; allow 15s buffer for the final chunk / close.
const STREAM_READ_TIMEOUT = Duration.seconds(315);
// Deadline for the hosted fetch to resolve with response headers. Stream body reads keep
// their own longer timeout once the response exists.
const HOSTED_FETCH_RESPONSE_TIMEOUT = Duration.seconds(30);
// Hard cap on the total bytes the adapter will consume from the hosted stream. Matches
// remote practice of ~16 MiB max response and protects against runaway/malformed bodies.
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
// Exponential backoff: 250ms, 500ms, 1s — up to 3 retries (4 attempts total).
const FETCH_RETRY_MAX_ATTEMPTS = 3;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function isRetryableCause(cause: unknown): boolean {
  if (cause === undefined || cause === null) {
    return false;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  const needle = message.toLowerCase();
  return (
    needle.includes("econnreset") ||
    needle.includes("econnrefused") ||
    needle.includes("eai_again") ||
    needle.includes("etimedout") ||
    needle.includes("enetunreach") ||
    needle.includes("socket hang up") ||
    needle.includes("network error") ||
    needle.includes("fetch failed") ||
    needle.includes("terminated") ||
    needle.includes("other side closed")
  );
}

function isAbortCause(cause: unknown): boolean {
  if (cause instanceof Error && cause.name === "AbortError") {
    return true;
  }
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  return message.toLowerCase().includes("aborted");
}

interface HostedFetchFailure {
  readonly kind: "http" | "network" | "timeout";
  readonly status?: number;
  readonly detail: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

function makeHostedFetchResponseTimeoutError(timeout: Duration.Duration): Error {
  const error = new Error(
    `Shiori API request timed out waiting for response headers after ${Duration.format(timeout)}.`,
  );
  error.name = "HostedFetchResponseTimeoutError";
  return error;
}

function isHostedFetchResponseTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "HostedFetchResponseTimeoutError";
}

function fetchHostedStreamResponse(input: {
  readonly url: string;
  readonly requestBody: Buffer;
  readonly authToken: string;
  readonly signal: AbortSignal;
  readonly responseTimeout: Duration.Input;
}): Promise<Response> {
  const responseTimeout = Duration.fromInputUnsafe(input.responseTimeout);
  const responseTimeoutMs = Math.max(1, Duration.toMillis(responseTimeout));
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const abortForCaller = () => {
    controller.abort(input.signal.reason);
  };

  if (input.signal.aborted) {
    abortForCaller();
  } else {
    input.signal.addEventListener("abort", abortForCaller, { once: true });
  }

  const timeoutPromise = new Promise<Response>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = makeHostedFetchResponseTimeoutError(responseTimeout);
      controller.abort(error);
      reject(error);
    }, responseTimeoutMs);
  });

  const fetchPromise = fetch(input.url, {
    method: "POST",
    headers: buildShioriRequestHeaders({
      authToken: input.authToken,
      contentLength: input.requestBody.byteLength,
    }),
    body: input.requestBody,
    signal: controller.signal,
  });

  return Promise.race([fetchPromise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    input.signal.removeEventListener("abort", abortForCaller);
  });
}

function buildShioriRequestHeaders(input: {
  authToken: string;
  contentLength: number;
}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Content-Length": String(input.contentLength),
    "X-Convex-Auth-Token": input.authToken,
    "X-Shiori-Client": "electron",
    "X-ShioriCode-Api-Version": SHIORI_API_VERSION,
    "User-Agent": "ShioriCode-macOS/1.0",
  };
}

// Wrap a byte stream with a running size cap. If the cap is exceeded, the stream errors
// so the downstream reader surfaces the failure instead of the adapter silently OOMing.
function boundStreamSize(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let bytesSeen = 0;
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytesSeen += chunk.byteLength;
      if (bytesSeen > maxBytes) {
        controller.error(
          new Error(
            `Shiori stream exceeded maximum size (${maxBytes} bytes); aborting to avoid runaway memory use.`,
          ),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return body.pipeThrough(transform);
}

function extractHostedFailureDetailFromObject(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const metadata =
    record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : null;
  const errorType = typeof metadata?.error_type === "string" ? metadata.error_type.trim() : null;
  const candidate =
    typeof record.error === "string"
      ? record.error.trim()
      : typeof record.message === "string"
        ? record.message.trim()
        : typeof record.detail === "string"
          ? record.detail.trim()
          : null;

  if (!candidate) {
    return null;
  }

  if (!errorType || errorType.length === 0) {
    return candidate;
  }

  if (errorType === "provider_unavailable") {
    return `${candidate} (provider unavailable)`;
  }

  return `${candidate} (${errorType})`;
}

function normalizeHostedFailureDetail(rawDetail: string, fallback: string): string {
  const trimmed = rawDetail.trim();
  if (trimmed.length === 0) {
    return fallback;
  }

  const parseJsonCandidate = (candidate: string): string | null => {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === "string") {
        return normalizeHostedFailureDetail(parsed, fallback);
      }
      return extractHostedFailureDetailFromObject(parsed);
    } catch {
      return null;
    }
  };

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    const parsed = parseJsonCandidate(trimmed);
    if (parsed) {
      return parsed;
    }
  }

  return trimmed;
}

// Read a failure body once the hosted API returns a non-2xx response. Prefer JSON error
// objects, fall back to plain text, and never let the response body read itself throw.
const readHostedFailureDetail = (response: Response) =>
  Effect.tryPromise({
    try: async () =>
      normalizeHostedFailureDetail(
        await response.text(),
        `Shiori API returned ${response.status} ${response.statusText}`.trim(),
      ),
    catch: () => `Shiori API returned ${response.status} ${response.statusText}`.trim(),
  }).pipe(Effect.orElseSucceed(() => `Shiori API returned ${response.status}`.trim()));

function nowIso() {
  return new Date().toISOString();
}

function runtimeEventBase(input: { threadId: ThreadId; turnId?: TurnId; itemId?: RuntimeItemId }) {
  return {
    eventId: EventId.makeUnsafe(crypto.randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
  };
}

function assistantMessageWithParts(input: {
  messageId: string;
  text: string;
  reasoningParts?: ReadonlyArray<HostedShioriMessage["parts"][number]>;
  extraParts?: ReadonlyArray<HostedShioriMessage["parts"][number]>;
}): HostedShioriMessage {
  return {
    id: input.messageId,
    role: "assistant",
    parts: [
      ...(input.reasoningParts ?? []),
      ...(input.text.trim().length > 0
        ? [
            {
              type: "text" as const,
              text: input.text,
            },
          ]
        : []),
      ...(input.extraParts ?? []),
    ],
  };
}

function hasMessageParts(message: HostedShioriMessage): boolean {
  return Array.isArray(message.parts) && message.parts.length > 0;
}

function buildAssistantToolPart(input: {
  messageId: string;
  text: string;
  reasoningParts?: ReadonlyArray<HostedShioriMessage["parts"][number]>;
  toolName: string;
  toolCallId: string;
  toolInput: Record<string, unknown>;
  state:
    | "input-available"
    | "approval-requested"
    | "output-available"
    | "output-denied"
    | "output-error";
  approvalId?: string;
  approved?: boolean;
  output?: unknown;
  errorText?: string;
  callProviderMetadata?: unknown;
  resultProviderMetadata?: unknown;
}): HostedShioriMessage["parts"][number] {
  const toolPart: any = {
    type: "dynamic-tool",
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    state: input.state,
    input: input.toolInput,
  };
  if (input.callProviderMetadata !== undefined) {
    toolPart.callProviderMetadata = input.callProviderMetadata;
  }
  if (input.state === "approval-requested" && input.approvalId) {
    toolPart.approval = { id: input.approvalId };
  }
  if (input.state === "output-available") {
    toolPart.output = input.output;
    if (input.resultProviderMetadata !== undefined) {
      toolPart.resultProviderMetadata = input.resultProviderMetadata;
    }
    if (input.approvalId) {
      toolPart.approval = { id: input.approvalId, approved: true };
    }
  }
  if (input.state === "output-denied" && input.approvalId) {
    toolPart.approval = { id: input.approvalId, approved: false };
  }
  if (input.state === "output-error") {
    toolPart.errorText = input.errorText ?? "Tool execution failed.";
    if (input.resultProviderMetadata !== undefined) {
      toolPart.resultProviderMetadata = input.resultProviderMetadata;
    }
    if (input.approvalId) {
      toolPart.approval = { id: input.approvalId, approved: true };
    }
  }
  return toolPart;
}

function assistantToolMessage(input: {
  messageId: string;
  text: string;
  reasoningParts?: ReadonlyArray<HostedShioriMessage["parts"][number]>;
  toolName: string;
  toolCallId: string;
  toolInput: Record<string, unknown>;
  state:
    | "input-available"
    | "approval-requested"
    | "output-available"
    | "output-denied"
    | "output-error";
  approvalId?: string;
  approved?: boolean;
  output?: unknown;
  errorText?: string;
  callProviderMetadata?: unknown;
  resultProviderMetadata?: unknown;
}): HostedShioriMessage {
  return assistantMessageWithParts({
    messageId: input.messageId,
    text: input.text,
    ...(input.reasoningParts ? { reasoningParts: input.reasoningParts } : {}),
    extraParts: [buildAssistantToolPart(input)],
  });
}

function replaceToolPartInMessage(input: {
  message: HostedShioriMessage;
  toolCallId: string;
  nextToolPart: HostedShioriMessage["parts"][number];
}): HostedShioriMessage {
  if (!Array.isArray(input.message.parts)) {
    return input.message;
  }

  let changed = false;
  const nextParts = input.message.parts.map((part) => {
    if (
      part &&
      typeof part === "object" &&
      part.type === "dynamic-tool" &&
      part.toolCallId === input.toolCallId
    ) {
      changed = true;
      return input.nextToolPart;
    }
    return part;
  });

  return changed ? { ...input.message, parts: nextParts } : input.message;
}

export function toolRequestKind(toolName: string): ApprovalRequestKind | undefined {
  return classifyProviderToolRequestKind(toolName);
}

function hostedDescriptorRequestKindFromSchema(
  inputSchema: Record<string, unknown>,
): HostedDescriptorRequestKind | undefined {
  const requestKind = inputSchema["x-shioricode-request-kind"];
  switch (requestKind) {
    case "command":
    case "file-read":
    case "file-change":
      return requestKind;
    case "side-effect":
    case "mcp-side-effect":
    case "mcp_side_effect":
      return "mcp-side-effect";
    default:
      return undefined;
  }
}

function approvalRequestKindForHostedDescriptor(
  requestKind: HostedDescriptorRequestKind | undefined,
): ApprovalRequestKind | undefined {
  if (requestKind === "mcp-side-effect") {
    return "command";
  }
  return requestKind;
}

function isSubagentToolName(toolName: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(toolName);
}

function isInternalHostedToolName(toolName: string): boolean {
  return INTERNAL_HOSTED_TOOL_NAMES.has(toolName);
}

function sanitizeTaskName(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const normalized = raw
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0
    ? normalized.slice(0, 48)
    : `agent_${crypto.randomUUID().slice(0, 8)}`;
}

function formatSubagentNotificationPayload(input: {
  agentPath: string;
  status: ShioriSubagentLifecycleStatus;
  summary?: string;
}): string {
  const payload = JSON.stringify({
    agent_path: input.agentPath,
    status: input.status,
    ...(input.summary && input.summary.trim().length > 0 ? { summary: input.summary } : {}),
  });
  return `${SUBAGENT_NOTIFICATION_OPEN_TAG}${payload}${SUBAGENT_NOTIFICATION_CLOSE_TAG}`;
}

function isSubagentTerminalStatus(status: ShioriSubagentLifecycleStatus): boolean {
  return status === "completed" || status === "failed" || status === "shutdown";
}

function extractAssistantTextFromMessage(message: HostedShioriMessage | null | undefined): string {
  if (!message || !Array.isArray(message.parts)) {
    return "";
  }
  return message.parts
    .flatMap((part) =>
      part && typeof part === "object" && "type" in part && part.type === "text"
        ? [typeof (part as { text?: unknown }).text === "string" ? part.text : ""]
        : [],
    )
    .join("")
    .trim();
}

function normalizeSubagentSummary(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}...` : trimmed;
}

function clampSubagentWaitTimeout(value: unknown): number {
  const fallback = 30_000;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(120_000, Math.round(value)));
}

function effectiveShioriBootstrap(
  bootstrap: ShioriCodeBootstrapConfig | null | undefined,
): ShioriCodeBootstrapConfig {
  return bootstrap ?? CONSERVATIVE_SHIORI_BOOTSTRAP;
}

function hostedPolicyAsks(
  bootstrap: ShioriCodeBootstrapConfig | null | undefined,
  ...keys: ReadonlyArray<keyof ShioriCodeBootstrapConfig["approvalPolicies"]>
): boolean {
  const resolvedBootstrap = effectiveShioriBootstrap(bootstrap);
  return keys.some((key) => resolvedBootstrap.approvalPolicies[key] === "ask");
}

function canUseHostedSubagentTool(
  bootstrap: ShioriCodeBootstrapConfig | null | undefined,
  toolName: string,
): boolean {
  const resolvedBootstrap = effectiveShioriBootstrap(bootstrap);
  if (!resolvedBootstrap.subagents?.enabled) {
    return false;
  }

  return Object.values(resolvedBootstrap.subagents.profiles).some(
    (profile) => profile?.supported === true && profile.tools.includes(toolName),
  );
}

function canUseHostedKanbanTools(bootstrap: ShioriCodeBootstrapConfig | null | undefined): boolean {
  return effectiveShioriBootstrap(bootstrap).kanban.enabled;
}

function runtimePromptFeatureGates(
  bootstrap: ShioriCodeBootstrapConfig | null | undefined,
): Pick<ShioriRuntimePromptContext, "browserUseEnabled" | "computerUseEnabled"> {
  const resolvedBootstrap = effectiveShioriBootstrap(bootstrap);
  return {
    browserUseEnabled: resolvedBootstrap.browserUse.enabled,
    computerUseEnabled: resolvedBootstrap.computerUse.enabled,
  };
}

function isHostedApprovalRequired(input: {
  toolName: string;
  requestKind: ApprovalRequestKind | undefined;
  runtimeMode: ProviderSession["runtimeMode"];
  allowedRequestKinds: ReadonlySet<ApprovalRequestKind>;
  bootstrap: ShioriCodeBootstrapConfig | null | undefined;
}): boolean {
  const runtimeRequiresApproval =
    input.requestKind !== undefined &&
    input.runtimeMode !== "full-access" &&
    !input.allowedRequestKinds.has(input.requestKind);
  if (runtimeRequiresApproval) {
    return true;
  }

  switch (input.toolName) {
    case "write_file":
    case "edit":
    case "apply_patch":
      return hostedPolicyAsks(input.bootstrap, "fileWrite", "destructiveChange");
    case "exec_command":
      return hostedPolicyAsks(
        input.bootstrap,
        "shellCommand",
        "networkCommand",
        "outsideWorkspace",
      );
    default:
      return false;
  }
}

function canPersistSessionApproval(input: {
  toolName: string;
  requestKind: ApprovalRequestKind | undefined;
  bootstrap: ShioriCodeBootstrapConfig | null | undefined;
}): boolean {
  if (input.requestKind === undefined) {
    return false;
  }

  switch (input.toolName) {
    case "write_file":
    case "edit":
    case "apply_patch":
      return !hostedPolicyAsks(input.bootstrap, "fileWrite", "destructiveChange");
    case "exec_command":
      return !hostedPolicyAsks(
        input.bootstrap,
        "shellCommand",
        "networkCommand",
        "outsideWorkspace",
      );
    default:
      return true;
  }
}

function withHostedToolApproval(
  descriptor: HostedToolDescriptor,
  bootstrap: ShioriCodeBootstrapConfig | null | undefined,
): HostedToolDescriptor {
  const schema = { ...descriptor.inputSchema };
  const requestKind = hostedDescriptorRequestKindFromSchema(schema);
  const alreadyNeedsApproval = schema["x-shioricode-needs-approval"] === true;
  const mcpNeedsApproval =
    requestKind !== undefined &&
    requestKind !== "file-read" &&
    hostedPolicyAsks(bootstrap, "mcpSideEffect");

  if (!alreadyNeedsApproval && !mcpNeedsApproval) {
    return descriptor;
  }

  return {
    ...descriptor,
    inputSchema: {
      ...schema,
      ...(requestKind === "mcp-side-effect"
        ? { "x-shioricode-request-kind": "mcp-side-effect" }
        : {}),
      "x-shioricode-needs-approval": alreadyNeedsApproval || mcpNeedsApproval,
    },
  };
}

export function buildHostedToolDescriptors(input: HostedToolContext): HostedToolDescriptor[] {
  const runtimeMode = input.session.runtimeMode;
  const requiresApproval = (toolName: string, kind: ApprovalRequestKind | undefined) =>
    isHostedApprovalRequired({
      toolName,
      requestKind: kind,
      runtimeMode,
      allowedRequestKinds: input.allowedRequestKinds,
      bootstrap: input.hostedBootstrap,
    });

  const descriptors: HostedToolDescriptor[] = [
    {
      name: "list_directory",
      title: "List directory",
      description:
        "List files and directories inside a workspace-relative directory while hiding generated clutter.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path relative to the current workspace root. Defaults to '.'.",
          },
        },
        additionalProperties: false,
        "x-shioricode-request-kind": "file-read",
        "x-shioricode-needs-approval": requiresApproval("list_directory", "file-read"),
      },
    },
    {
      name: "read_file",
      title: "Read file",
      description: "Read the contents of a local file from the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the current workspace root." },
        },
        required: ["path"],
        additionalProperties: false,
        "x-shioricode-request-kind": "file-read",
        "x-shioricode-needs-approval": requiresApproval("read_file", "file-read"),
      },
    },
    {
      name: "write_file",
      title: "Write file",
      description: "Create or overwrite a local file in the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the current workspace root." },
          content: { type: "string", description: "Full UTF-8 file contents to write." },
        },
        required: ["path", "content"],
        additionalProperties: false,
        "x-shioricode-request-kind": "file-change",
        "x-shioricode-needs-approval": requiresApproval("write_file", "file-change"),
      },
    },
    {
      name: "edit",
      title: "Edit files",
      description: "Edit workspace files by applying a unified diff patch.",
      inputSchema: {
        type: "object",
        properties: {
          patch: { type: "string", description: "Unified diff patch text." },
        },
        required: ["patch"],
        additionalProperties: false,
        "x-shioricode-request-kind": "file-change",
        "x-shioricode-needs-approval": requiresApproval("edit", "file-change"),
      },
    },
    {
      name: "exec_command",
      title: "Execute command",
      description:
        "Run a shell command inside the local workspace. Do not use this as a substitute when the user explicitly asks for Computer Use desktop interaction; use the Computer Use tools instead, or report that those tools are unavailable.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run." },
        },
        required: ["command"],
        additionalProperties: false,
        "x-shioricode-request-kind": "command",
        "x-shioricode-needs-approval": requiresApproval("exec_command", "command"),
      },
    },
    {
      name: "web_search",
      title: "Web search",
      description:
        "Search the public web for up-to-date information and return ranked results with snippets.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query to run on the public web.",
          },
          max_results: {
            type: "number",
            description: "Optional maximum number of results to return. Defaults to 5.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "ask_user",
      title: "Ask user",
      description:
        "Ask the user a blocking question when local context is insufficient or a choice is required.",
      inputSchema: {
        type: "object",
        properties: {
          header: { type: "string" },
          question: { type: "string" },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                description: { type: "string" },
              },
              required: ["label", "description"],
              additionalProperties: false,
            },
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
    ...(canUseHostedSubagentTool(input.hostedBootstrap, "spawn_agent")
      ? [
          {
            name: "spawn_agent",
            title: "Spawn agent",
            description:
              "Spawn a background subagent for a scoped task. Returns a stable task name that can be used with send_input, wait_agent, and close_agent.",
            inputSchema: {
              type: "object",
              properties: {
                task_name: {
                  type: "string",
                  description:
                    "Optional canonical task name. Use lowercase letters, digits, and underscores.",
                },
                message: {
                  type: "string",
                  description: "Initial task prompt for the new subagent.",
                },
                agent_type: {
                  type: "string",
                  description: "Optional role label, such as researcher or verifier.",
                },
              },
              required: ["message"],
              additionalProperties: false,
            },
          },
        ]
      : []),
    ...(canUseHostedSubagentTool(input.hostedBootstrap, "send_input")
      ? [
          {
            name: "send_input",
            title: "Send input",
            description:
              "Queue a follow-up message for an existing subagent. The target can be an agent id or task name.",
            inputSchema: {
              type: "object",
              properties: {
                target: {
                  type: "string",
                  description: "Agent id or task name returned by spawn_agent.",
                },
                message: {
                  type: "string",
                  description: "Follow-up prompt to queue for that subagent.",
                },
              },
              required: ["target", "message"],
              additionalProperties: false,
            },
          },
        ]
      : []),
    ...(canUseHostedSubagentTool(input.hostedBootstrap, "wait_agent")
      ? [
          {
            name: "wait_agent",
            title: "Wait agent",
            description:
              "Wait for one or more subagents to finish. Returns final statuses keyed by target.",
            inputSchema: {
              type: "object",
              properties: {
                targets: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Optional list of agent ids or task names. If omitted, waits for any tracked subagent.",
                },
                timeout_ms: {
                  type: "number",
                  description: "Optional timeout in milliseconds. Defaults to 30000.",
                },
              },
              additionalProperties: false,
            },
          },
        ]
      : []),
    ...(canUseHostedSubagentTool(input.hostedBootstrap, "close_agent")
      ? [
          {
            name: "close_agent",
            title: "Close agent",
            description:
              "Stop a subagent and mark it as closed. Use after completion to release resources.",
            inputSchema: {
              type: "object",
              properties: {
                target: {
                  type: "string",
                  description: "Agent id or task name returned by spawn_agent.",
                },
              },
              required: ["target"],
              additionalProperties: false,
            },
          },
        ]
      : []),
    ...(canUseHostedSubagentTool(input.hostedBootstrap, "agent")
      ? [
          {
            name: "agent",
            title: "Agent",
            description:
              "Claude-style agent spawn. Starts a subagent for the provided prompt and description.",
            inputSchema: {
              type: "object",
              properties: {
                description: {
                  type: "string",
                  description: "Short summary of the delegated task.",
                },
                prompt: { type: "string", description: "Detailed delegated prompt." },
                subagent_type: {
                  type: "string",
                  description: "Optional agent type label, such as explore or code-reviewer.",
                },
                run_in_background: {
                  type: "boolean",
                  description:
                    "When true (default), return immediately after launch. When false, wait for completion.",
                },
                name: {
                  type: "string",
                  description: "Optional stable task name for follow-up messages.",
                },
              },
              required: ["description", "prompt"],
              additionalProperties: false,
            },
          },
        ]
      : []),
    ...(canUseHostedSubagentTool(input.hostedBootstrap, "send_message")
      ? [
          {
            name: "send_message",
            title: "Send message",
            description:
              "Claude-style follow-up for a running subagent. Equivalent to send_input with fields to/message.",
            inputSchema: {
              type: "object",
              properties: {
                to: { type: "string", description: "Agent id or task name." },
                message: { type: "string", description: "Follow-up prompt." },
              },
              required: ["to", "message"],
              additionalProperties: false,
            },
          },
        ]
      : []),
  ];

  if (input.interactionMode === "plan") {
    descriptors.push(
      {
        name: "request_user_input",
        title: "Request user input",
        description:
          "Ask the user one to three short multiple-choice questions when a planning decision is blocked.",
        inputSchema: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: {
                type: "object",
                properties: {
                  header: { type: "string" },
                  id: { type: "string" },
                  question: { type: "string" },
                  options: {
                    type: "array",
                    minItems: 2,
                    maxItems: 3,
                    items: {
                      type: "object",
                      properties: {
                        label: { type: "string" },
                        description: { type: "string" },
                      },
                      required: ["label", "description"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["header", "id", "question", "options"],
                additionalProperties: false,
              },
            },
          },
          required: ["questions"],
          additionalProperties: false,
        },
      },
      {
        name: "update_plan",
        title: "Update plan",
        description:
          "Publish the current plan state so the client can show structured progress while you investigate and refine the plan.",
        inputSchema: {
          type: "object",
          properties: {
            explanation: {
              type: "string",
              description: "Optional short explanation of what changed in the plan.",
            },
            plan: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  step: { type: "string" },
                  status: {
                    type: "string",
                    enum: ["pending", "in_progress", "inProgress", "completed"],
                  },
                },
                required: ["step", "status"],
                additionalProperties: false,
              },
            },
          },
          required: ["plan"],
          additionalProperties: false,
        },
      },
    );
  }

  if (input.mcpToolDescriptors && input.mcpToolDescriptors.length > 0) {
    descriptors.push(
      ...input.mcpToolDescriptors
        .filter(
          (descriptor) =>
            canUseHostedKanbanTools(input.hostedBootstrap) ||
            !descriptor.name.startsWith(KANBAN_TOOL_PREFIX),
        )
        .map((descriptor) => withHostedToolApproval(descriptor, input.hostedBootstrap)),
    );
  }

  return descriptors;
}

function isUserInputToolName(toolName: string): boolean {
  return toolName === "ask_user" || toolName === "request_user_input";
}

function normalizePlanStepStatus(value: unknown): "pending" | "inProgress" | "completed" {
  switch (value) {
    case "completed":
      return "completed";
    case "in_progress":
    case "inProgress":
      return "inProgress";
    default:
      return "pending";
  }
}

function extractPlanUpdatePayload(input: Record<string, unknown>): {
  explanation?: string;
  plan: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
} | null {
  const rawPlan = Array.isArray(input.plan) ? input.plan : [];
  const plan = rawPlan.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const step = typeof entry.step === "string" ? entry.step.trim() : "";
    if (step.length === 0) {
      return [];
    }
    return [
      {
        step,
        status: normalizePlanStepStatus((entry as { status?: unknown }).status),
      },
    ];
  });

  if (plan.length === 0) {
    return null;
  }

  const explanation =
    typeof input.explanation === "string" && input.explanation.trim().length > 0
      ? input.explanation.trim()
      : undefined;

  return {
    ...(explanation ? { explanation } : {}),
    plan,
  };
}

function extractUserInputQuestions(toolInput: Record<string, unknown>): UserInputQuestion[] {
  const rawQuestions = Array.isArray(toolInput.questions)
    ? (toolInput.questions as Array<Record<string, unknown>>)
    : null;
  if (rawQuestions && rawQuestions.length > 0) {
    return rawQuestions.flatMap((question, index) => {
      const prompt =
        typeof question.question === "string" && question.question.trim().length > 0
          ? question.question
          : "";
      if (prompt.length === 0) {
        return [];
      }
      const options = Array.isArray(question.options)
        ? question.options.flatMap((option) =>
            typeof option?.label === "string" && typeof option?.description === "string"
              ? [{ label: option.label, description: option.description }]
              : [],
          )
        : [];

      return [
        {
          id:
            typeof question.id === "string" && question.id.trim().length > 0
              ? question.id
              : `shiori-user-input-${index + 1}`,
          header:
            typeof question.header === "string" && question.header.trim().length > 0
              ? question.header
              : `Question ${index + 1}`,
          question: prompt,
          options,
          multiSelect: false,
        },
      ];
    });
  }

  const rawOptions = Array.isArray(toolInput.options)
    ? (toolInput.options as Array<Record<string, unknown>>)
    : [];
  return [
    {
      id: "shiori-user-input",
      header:
        typeof toolInput.header === "string" && toolInput.header.trim().length > 0
          ? toolInput.header
          : "Question",
      question:
        typeof toolInput.question === "string" && toolInput.question.trim().length > 0
          ? toolInput.question
          : "Please provide the requested input.",
      options: rawOptions.flatMap((option) =>
        typeof option.label === "string" && typeof option.description === "string"
          ? [{ label: option.label, description: option.description }]
          : [],
      ),
      multiSelect: false,
    },
  ];
}

function closeActiveTurnMcpTools(activeTurn: ActiveTurnState | null): Promise<void> {
  if (!activeTurn) {
    return Promise.resolve();
  }
  return activeTurn.closeMcpTools();
}

function trimHostedMessageHistory(
  messages: ReadonlyArray<HostedShioriMessage>,
): HostedShioriMessage[] {
  return messages.length <= MAX_PERSISTED_MESSAGES
    ? [...messages]
    : messages.slice(-MAX_PERSISTED_MESSAGES);
}

function stripMessageForResume(message: HostedShioriMessage): HostedShioriMessage | null {
  if (!Array.isArray(message.parts)) {
    return null;
  }
  return {
    id: message.id,
    role: message.role,
    parts: message.parts,
  };
}

function serializeSubagentState(
  state: ShioriSubagentState,
): NonNullable<NonNullable<ShioriResumeCursor["runtime"]>["subagents"]>[number] {
  return {
    id: state.id,
    taskName: state.taskName,
    ...(state.nickname !== null ? { nickname: state.nickname } : {}),
    toolStyle: state.toolStyle,
    description: state.description,
    ...(state.subagentType !== null ? { subagentType: state.subagentType } : {}),
    modelId: state.modelId,
    status: state.status,
    ...(state.queuedInputs.length > 0 ? { queuedInputs: [...state.queuedInputs] } : {}),
    ...(state.history.length > 0
      ? {
          history: trimHostedMessageHistory(state.history)
            .map(stripMessageForResume)
            .filter((message): message is HostedShioriMessage => message !== null),
        }
      : {}),
    ...(state.terminalSequence > 0 ? { terminalSequence: state.terminalSequence } : {}),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    ...(state.parentTurnId ? { parentTurnId: String(state.parentTurnId) } : {}),
    ...(state.parentToolUseId ? { parentToolUseId: state.parentToolUseId } : {}),
    ...(state.lastSummary ? { lastSummary: state.lastSummary } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
  };
}

function decodeHostedMessages(input: unknown): HostedShioriMessage[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((message) => {
    if (!message || typeof message !== "object") {
      return [];
    }
    const record = message as { id?: unknown; role?: unknown; parts?: unknown };
    if (
      typeof record.id !== "string" ||
      (record.role !== "user" && record.role !== "assistant" && record.role !== "system") ||
      !Array.isArray(record.parts)
    ) {
      return [];
    }
    return [
      {
        id: record.id,
        role: record.role,
        parts: record.parts,
      } satisfies HostedShioriMessage,
    ];
  });
}

function decodeSubagentState(input: unknown): ShioriSubagentState | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const record = input as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.taskName !== "string" ||
    (record.toolStyle !== "codex" && record.toolStyle !== "claude") ||
    typeof record.description !== "string" ||
    typeof record.modelId !== "string" ||
    (record.status !== "pending_init" &&
      record.status !== "running" &&
      record.status !== "completed" &&
      record.status !== "failed" &&
      record.status !== "shutdown") ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    return null;
  }

  const queuedInputs = Array.isArray(record.queuedInputs)
    ? record.queuedInputs.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return [];
        }
        const queuedInput = entry as Record<string, unknown>;
        if (
          typeof queuedInput.id !== "string" ||
          typeof queuedInput.prompt !== "string" ||
          typeof queuedInput.submittedAt !== "string"
        ) {
          return [];
        }
        return [
          {
            id: queuedInput.id,
            prompt: queuedInput.prompt,
            submittedAt: queuedInput.submittedAt,
          } satisfies ShioriSubagentQueuedInput,
        ];
      })
    : [];

  return {
    id: record.id,
    taskName: record.taskName,
    nickname: typeof record.nickname === "string" ? record.nickname : null,
    toolStyle: record.toolStyle,
    description: record.description,
    subagentType: typeof record.subagentType === "string" ? record.subagentType : null,
    modelId: record.modelId,
    status: record.status,
    queuedInputs,
    history: decodeHostedMessages(record.history),
    runnerActive: false,
    terminalSequence:
      typeof record.terminalSequence === "number" && Number.isFinite(record.terminalSequence)
        ? Math.max(0, Math.round(record.terminalSequence))
        : 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(typeof record.parentTurnId === "string"
      ? { parentTurnId: TurnId.makeUnsafe(record.parentTurnId) }
      : {}),
    ...(typeof record.parentToolUseId === "string"
      ? { parentToolUseId: record.parentToolUseId }
      : {}),
    ...(typeof record.lastSummary === "string" ? { lastSummary: record.lastSummary } : {}),
    ...(typeof record.lastError === "string" ? { lastError: record.lastError } : {}),
  };
}

function encodeResumeCursor(
  context: Pick<
    ShioriSessionContext,
    | "messages"
    | "turns"
    | "activeTurn"
    | "pendingApprovals"
    | "pendingUserInputs"
    | "allowedRequestKinds"
    | "subagents"
    | "pendingSubagentNotifications"
  >,
): ShioriResumeCursor {
  const sanitizedMessages = context.messages
    .map(stripMessageForResume)
    .filter((message): message is HostedShioriMessage => message !== null);

  const defaultSliceStart = Math.max(0, sanitizedMessages.length - MAX_PERSISTED_MESSAGES);
  const sliceStart =
    context.turns.length === 0
      ? defaultSliceStart
      : context.turns.reduce((currentStart, turn, index) => {
          const previousMessageCount =
            index === 0 ? 0 : (context.turns[index - 1]?.messageCount ?? 0);
          return sanitizedMessages.length - previousMessageCount <= MAX_PERSISTED_MESSAGES
            ? previousMessageCount
            : currentStart;
        }, defaultSliceStart);

  const hasRecoverablePendingRequest =
    context.pendingApprovals.size > 0 || context.pendingUserInputs.size > 0;
  const runtime =
    hasRecoverablePendingRequest ||
    context.allowedRequestKinds.size > 0 ||
    context.subagents.size > 0 ||
    context.pendingSubagentNotifications.length > 0
      ? {
          ...(context.activeTurn && hasRecoverablePendingRequest
            ? {
                activeTurn: {
                  turnId: String(context.activeTurn.turnId),
                  interactionMode: context.activeTurn.interactionMode,
                  ...(context.activeTurn.modelSettings
                    ? { modelSettings: context.activeTurn.modelSettings }
                    : {}),
                },
              }
            : {}),
          ...(context.pendingApprovals.size > 0
            ? {
                pendingApprovals: Array.from(context.pendingApprovals.values()).map(
                  serializePendingToolCall,
                ),
              }
            : {}),
          ...(context.pendingUserInputs.size > 0
            ? {
                pendingUserInputs: Array.from(context.pendingUserInputs.values()).map(
                  serializePendingToolCall,
                ),
              }
            : {}),
          ...(context.allowedRequestKinds.size > 0
            ? {
                allowedRequestKinds: Array.from(context.allowedRequestKinds.values()),
              }
            : {}),
          ...(context.subagents.size > 0
            ? {
                subagents: Array.from(context.subagents.values()).map(serializeSubagentState),
              }
            : {}),
          ...(context.pendingSubagentNotifications.length > 0
            ? {
                pendingSubagentNotifications: [...context.pendingSubagentNotifications],
              }
            : {}),
        }
      : undefined;

  return {
    messages: sanitizedMessages.slice(sliceStart),
    turns: context.turns.flatMap((turn) =>
      turn.messageCount <= sliceStart
        ? []
        : [
            {
              id: String(turn.id),
              items: turn.items,
              messageCount: turn.messageCount - sliceStart,
            },
          ],
    ),
    ...(runtime ? { runtime } : {}),
  };
}

function decodeResumeCursor(value: unknown): DecodedShioriResumeState {
  if (!value || typeof value !== "object") {
    return {
      messages: [],
      turns: [],
      activeTurnSnapshot: null,
      pendingApprovals: [],
      pendingUserInputs: [],
      allowedRequestKinds: [],
      subagents: [],
      pendingSubagentNotifications: [],
    };
  }
  const messages = (value as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return {
      messages: [],
      turns: [],
      activeTurnSnapshot: null,
      pendingApprovals: [],
      pendingUserInputs: [],
      allowedRequestKinds: [],
      subagents: [],
      pendingSubagentNotifications: [],
    };
  }

  const decodedMessages = decodeHostedMessages(messages);

  const rawTurns = Array.isArray((value as { turns?: unknown }).turns)
    ? ((value as { turns: unknown[] }).turns ?? [])
    : [];

  const decodedTurns = rawTurns.flatMap((turn) => {
    if (!turn || typeof turn !== "object") {
      return [];
    }
    const record = turn as { id?: unknown; items?: unknown; messageCount?: unknown };
    if (typeof record.id !== "string") {
      return [];
    }
    if (!Number.isInteger(record.messageCount) || Number(record.messageCount) < 0) {
      return [];
    }
    return [
      {
        id: TurnId.makeUnsafe(record.id),
        items: Array.isArray(record.items) ? record.items : [],
        messageCount: Math.min(Number(record.messageCount), decodedMessages.length),
      } satisfies ShioriTurnState,
    ];
  });

  const runtime =
    "runtime" in (value as Record<string, unknown>) &&
    typeof (value as { runtime?: unknown }).runtime === "object" &&
    (value as { runtime?: unknown }).runtime !== null
      ? ((value as { runtime: Record<string, unknown> }).runtime ?? {})
      : undefined;

  const decodePendingToolCalls = (
    input: unknown,
    options?: { includeApprovalFields?: boolean },
  ): ReadonlyArray<PendingToolCall> =>
    Array.isArray(input)
      ? input.flatMap((entry) => {
          if (!entry || typeof entry !== "object") {
            return [];
          }
          const record = entry as Record<string, unknown>;
          if (
            typeof record.requestId !== "string" ||
            typeof record.toolCallId !== "string" ||
            typeof record.toolName !== "string" ||
            typeof record.assistantMessageId !== "string" ||
            !record.input ||
            typeof record.input !== "object" ||
            Array.isArray(record.input)
          ) {
            return [];
          }

          const requestKind =
            record.requestKind === "command" ||
            record.requestKind === "file-read" ||
            record.requestKind === "file-change"
              ? record.requestKind
              : undefined;
          const approvalId =
            options?.includeApprovalFields === true && typeof record.approvalId === "string"
              ? record.approvalId
              : undefined;

          return [
            {
              requestId: ApprovalRequestId.makeUnsafe(record.requestId),
              toolCallId: record.toolCallId,
              toolName: record.toolName,
              input: record.input as Record<string, unknown>,
              assistantMessageId: record.assistantMessageId,
              ...(approvalId ? { approvalId } : {}),
              ...(requestKind ? { requestKind } : {}),
              ...(record.callProviderMetadata !== undefined
                ? { callProviderMetadata: record.callProviderMetadata }
                : {}),
            } satisfies PendingToolCall,
          ];
        })
      : [];

  const allowedRequestKinds = Array.isArray(runtime?.allowedRequestKinds)
    ? runtime.allowedRequestKinds.flatMap((entry) =>
        entry === "command" || entry === "file-read" || entry === "file-change" ? [entry] : [],
      )
    : [];
  const pendingSubagentNotifications = Array.isArray(runtime?.pendingSubagentNotifications)
    ? runtime.pendingSubagentNotifications.flatMap((entry) =>
        typeof entry === "string" ? [entry] : [],
      )
    : [];
  const pendingApprovals = decodePendingToolCalls(runtime?.pendingApprovals, {
    includeApprovalFields: true,
  });
  const pendingUserInputs = decodePendingToolCalls(runtime?.pendingUserInputs);
  const subagents = Array.isArray(runtime?.subagents)
    ? runtime.subagents
        .map(decodeSubagentState)
        .filter((state): state is ShioriSubagentState => state !== null)
    : [];
  const activeTurnRecord =
    runtime?.activeTurn &&
    typeof runtime.activeTurn === "object" &&
    !Array.isArray(runtime.activeTurn)
      ? (runtime.activeTurn as Record<string, unknown>)
      : null;
  const activeTurnSnapshot =
    activeTurnRecord &&
    typeof activeTurnRecord.turnId === "string" &&
    (activeTurnRecord.interactionMode === "default" || activeTurnRecord.interactionMode === "plan")
      ? {
          turnId: TurnId.makeUnsafe(activeTurnRecord.turnId),
          interactionMode: activeTurnRecord.interactionMode as "default" | "plan",
          ...(activeTurnRecord.modelSettings &&
          typeof activeTurnRecord.modelSettings === "object" &&
          !Array.isArray(activeTurnRecord.modelSettings)
            ? {
                modelSettings: activeTurnRecord.modelSettings as HostedShioriModelSettings,
              }
            : {}),
        }
      : null;

  return {
    messages: decodedMessages,
    turns: decodedTurns,
    activeTurnSnapshot,
    pendingApprovals,
    pendingUserInputs,
    allowedRequestKinds,
    subagents,
    pendingSubagentNotifications,
  };
}

function computeResumeCursor(
  context: Pick<
    ShioriSessionContext,
    | "messages"
    | "turns"
    | "activeTurn"
    | "pendingApprovals"
    | "pendingUserInputs"
    | "allowedRequestKinds"
    | "subagents"
    | "pendingSubagentNotifications"
  >,
): ShioriResumeCursor | undefined {
  const resumeCursor = encodeResumeCursor(context);
  return resumeCursor.messages.length > 0 || resumeCursor.turns.length > 0
    ? resumeCursor
    : resumeCursor.runtime !== undefined
      ? resumeCursor
      : undefined;
}

function withResumeCursor(context: ShioriSessionContext): ShioriSessionContext {
  const resumeCursor = computeResumeCursor(context);
  const { resumeCursor: _resumeCursor, ...sessionWithoutCursor } = context.session;

  return {
    ...context,
    session: {
      ...sessionWithoutCursor,
      ...(resumeCursor ? { resumeCursor } : {}),
    },
  };
}

function extractAssistantToolReplayState(input: {
  messages: ReadonlyArray<HostedShioriMessage>;
  assistantMessageId: string;
}): {
  text: string;
  reasoningParts: ReadonlyArray<HostedShioriMessage["parts"][number]>;
} {
  const message = input.messages.find((entry) => entry.id === input.assistantMessageId);
  if (!message || !Array.isArray(message.parts)) {
    return {
      text: "",
      reasoningParts: [],
    };
  }

  const reasoningParts: HostedShioriMessage["parts"] = [];
  let text = "";
  for (const part of message.parts) {
    if (!part || typeof part !== "object") {
      continue;
    }
    if (part.type === "reasoning" && typeof part.text === "string") {
      reasoningParts.push(part);
      continue;
    }
    if (part.type === "text" && typeof part.text === "string") {
      text += part.text;
    }
  }

  return {
    text,
    reasoningParts,
  };
}

function serializePendingToolCall(pending: PendingToolCall) {
  return Object.assign(
    {
      requestId: String(pending.requestId),
      toolCallId: pending.toolCallId,
      toolName: pending.toolName,
      input: pending.input,
      assistantMessageId: pending.assistantMessageId,
    },
    pending.approvalId ? { approvalId: pending.approvalId } : {},
    pending.requestKind ? { requestKind: pending.requestKind } : {},
    pending.callProviderMetadata !== undefined
      ? { callProviderMetadata: pending.callProviderMetadata }
      : {},
  );
}

function resolveSubagentTarget(
  context: ShioriSessionContext,
  target: unknown,
): ShioriSubagentState | null {
  const value = typeof target === "string" ? target.trim() : "";
  if (value.length === 0) {
    return null;
  }
  const byId = context.subagents.get(value);
  if (byId) {
    return byId;
  }
  for (const state of context.subagents.values()) {
    if (state.taskName === value) {
      return state;
    }
  }
  return null;
}

function subagentWaitSnapshot(
  state: ShioriSubagentState,
  target: string,
): {
  target: string;
  id: string;
  task_name: string;
  status: ShioriSubagentLifecycleStatus;
  summary?: string;
  error?: string;
} {
  return {
    target,
    id: state.id,
    task_name: state.taskName,
    status: state.status,
    ...(state.lastSummary ? { summary: state.lastSummary } : {}),
    ...(state.lastError ? { error: state.lastError } : {}),
  };
}

async function attachmentToFilePart(
  attachment: ChatAttachment,
  attachmentsDir: string,
): Promise<{ type: "file"; mediaType: string; filename: string; url: string }> {
  const resolvedPath = resolveAttachmentPath({
    attachmentsDir,
    attachment,
  });
  if (!resolvedPath) {
    throw new Error(`Attachment '${attachment.id}' could not be resolved.`);
  }
  const bytes = await readFile(resolvedPath);
  const base64 = Buffer.from(bytes).toString("base64");

  return {
    type: "file",
    mediaType: attachment.mimeType,
    filename: attachment.name,
    url: `data:${attachment.mimeType};base64,${base64}`,
  };
}

function resolveWorkspacePath(rootCwd: string | undefined, requestedPath: unknown): string {
  const root = rootCwd?.trim();
  const relativePath = typeof requestedPath === "string" ? requestedPath.trim() : "";
  if (!root || relativePath.length === 0) {
    throw new Error("A workspace root and relative path are required.");
  }

  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Requested path must stay within the workspace root.");
  }
  return resolvedPath;
}

function normalizeWorkspaceRelativePathForProtection(relativePath: string): string {
  return relativePath
    .split(path.sep)
    .join("/")
    .replace(/^\.\/+/, "");
}

function matchesProtectedWorkspacePattern(relativePath: string, pattern: string): boolean {
  const normalizedPath = normalizeWorkspaceRelativePathForProtection(relativePath);
  const normalizedPattern = pattern.replace(/^~\//, "").replace(/^\/+/, "");
  if (normalizedPattern.length === 0 || normalizedPattern.startsWith(".config/")) {
    return false;
  }
  if (normalizedPattern.includes("/")) {
    return (
      normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`)
    );
  }
  const rootEntry = normalizedPath.split("/")[0] ?? normalizedPath;
  if (normalizedPattern.endsWith(".*")) {
    const base = normalizedPattern.slice(0, -2);
    return rootEntry === base || rootEntry.startsWith(`${base}.`);
  }
  return rootEntry === normalizedPattern;
}

function assertWorkspacePathAllowed(input: {
  rootCwd: string | undefined;
  resolvedPath: string;
  bootstrap: ShioriCodeBootstrapConfig | null | undefined;
  toolName: string;
}): void {
  const bootstrap = effectiveShioriBootstrap(input.bootstrap);
  if (!input.rootCwd || bootstrap.protectedPaths.length === 0) {
    return;
  }

  const relativePath = path.relative(path.resolve(input.rootCwd), input.resolvedPath);
  if (
    bootstrap.protectedPaths.some((pattern) =>
      matchesProtectedWorkspacePattern(relativePath, pattern),
    )
  ) {
    throw new Error(`Tool '${input.toolName}' cannot access protected path '${relativePath}'.`);
  }
}

function extractPatchTargetPaths(patch: string): string[] {
  return patch.split(/\r?\n/u).flatMap((line) => {
    const codexMatch = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/u.exec(line);
    if (codexMatch?.[1]) {
      return [codexMatch[1].trim()];
    }
    const codexMoveMatch = /^\*\*\* Move to: (.+)$/u.exec(line);
    if (codexMoveMatch?.[1]) {
      return [codexMoveMatch[1].trim()];
    }
    if (line.startsWith("+++ b/") || line.startsWith("--- a/")) {
      const candidate = line.slice(6).trim();
      return candidate === "/dev/null" ? [] : [candidate];
    }
    if (line.startsWith("rename to ") || line.startsWith("rename from ")) {
      const candidate = line.replace(/^rename (?:to|from) /u, "").trim();
      return candidate === "/dev/null" ? [] : [candidate];
    }
    return [];
  });
}

type CodexPatchHunk = {
  oldLines: string[];
  newLines: string[];
};

type CodexPatchOperation =
  | {
      kind: "add";
      path: string;
      lines: string[];
    }
  | {
      kind: "delete";
      path: string;
    }
  | {
      kind: "update";
      path: string;
      moveTo?: string | undefined;
      hunks: CodexPatchHunk[];
    };

function isCodexApplyPatch(patch: string): boolean {
  return /^\s*\*\*\* Begin Patch\b/u.test(patch);
}

function parseCodexApplyPatch(patch: string): CodexPatchOperation[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length && lines[index]?.trim() === "") {
    index += 1;
  }
  if (lines[index] !== "*** Begin Patch") {
    throw new Error("Codex patch must start with '*** Begin Patch'.");
  }
  index += 1;

  const operations: CodexPatchOperation[] = [];
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line === "*** End Patch") {
      return operations;
    }
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const addMatch = /^\*\*\* Add File: (.+)$/u.exec(line);
    if (addMatch?.[1]) {
      const filePath = addMatch[1].trim();
      index += 1;
      const addedLines: string[] = [];
      while (index < lines.length && !lines[index]!.startsWith("*** ")) {
        const addLine = lines[index] ?? "";
        if (!addLine.startsWith("+")) {
          throw new Error(`Invalid add-file patch line for '${filePath}'.`);
        }
        addedLines.push(addLine.slice(1));
        index += 1;
      }
      operations.push({ kind: "add", path: filePath, lines: addedLines });
      continue;
    }

    const deleteMatch = /^\*\*\* Delete File: (.+)$/u.exec(line);
    if (deleteMatch?.[1]) {
      operations.push({ kind: "delete", path: deleteMatch[1].trim() });
      index += 1;
      continue;
    }

    const updateMatch = /^\*\*\* Update File: (.+)$/u.exec(line);
    if (updateMatch?.[1]) {
      const filePath = updateMatch[1].trim();
      index += 1;
      let moveTo: string | undefined;
      const hunks: CodexPatchHunk[] = [];
      let currentHunk: CodexPatchHunk | null = null;

      while (
        index < lines.length &&
        !/^\*\*\* (?:Add|Update|Delete|End Patch)\b/u.test(lines[index] ?? "")
      ) {
        const patchLine = lines[index] ?? "";
        const moveMatch = /^\*\*\* Move to: (.+)$/u.exec(patchLine);
        if (moveMatch?.[1]) {
          moveTo = moveMatch[1].trim();
          index += 1;
          continue;
        }
        if (patchLine.startsWith("@@")) {
          currentHunk = { oldLines: [], newLines: [] };
          hunks.push(currentHunk);
          index += 1;
          continue;
        }
        if (patchLine === "*** End of File") {
          index += 1;
          continue;
        }
        if (!currentHunk) {
          currentHunk = { oldLines: [], newLines: [] };
          hunks.push(currentHunk);
        }
        if (patchLine.startsWith(" ")) {
          const content = patchLine.slice(1);
          currentHunk.oldLines.push(content);
          currentHunk.newLines.push(content);
        } else if (patchLine.startsWith("-")) {
          currentHunk.oldLines.push(patchLine.slice(1));
        } else if (patchLine.startsWith("+")) {
          currentHunk.newLines.push(patchLine.slice(1));
        } else if (patchLine.trim() === "") {
          currentHunk.oldLines.push("");
          currentHunk.newLines.push("");
        } else {
          throw new Error(`Invalid update patch line for '${filePath}'.`);
        }
        index += 1;
      }

      operations.push({ kind: "update", path: filePath, ...(moveTo ? { moveTo } : {}), hunks });
      continue;
    }

    throw new Error(`Unsupported Codex patch directive: ${line}`);
  }

  throw new Error("Codex patch is missing '*** End Patch'.");
}

function splitPatchContent(content: string): {
  lines: string[];
  newline: string;
  hasTrailingNewline: boolean;
} {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n/g, "\n");
  const hasTrailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  return { lines, newline, hasTrailingNewline };
}

function joinPatchContent(input: {
  lines: string[];
  newline: string;
  hasTrailingNewline: boolean;
}): string {
  const joined = input.lines.join(input.newline);
  return input.hasTrailingNewline ? `${joined}${input.newline}` : joined;
}

function findPatchHunkIndex(
  lines: ReadonlyArray<string>,
  oldLines: ReadonlyArray<string>,
  startIndex: number,
): number {
  if (oldLines.length === 0) {
    return startIndex;
  }

  for (let index = startIndex; index <= lines.length - oldLines.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < oldLines.length; offset += 1) {
      if (lines[index + offset] !== oldLines[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return index;
    }
  }
  return -1;
}

function applyCodexHunks(
  content: string,
  hunks: ReadonlyArray<CodexPatchHunk>,
  filePath: string,
): string {
  const split = splitPatchContent(content);
  const nextLines = [...split.lines];
  let cursor = 0;

  for (const hunk of hunks) {
    const hunkIndex = findPatchHunkIndex(nextLines, hunk.oldLines, cursor);
    if (hunkIndex < 0) {
      throw new Error(`Patch hunk did not match '${filePath}'.`);
    }
    nextLines.splice(hunkIndex, hunk.oldLines.length, ...hunk.newLines);
    cursor = hunkIndex + hunk.newLines.length;
  }

  return joinPatchContent({
    lines: nextLines,
    newline: split.newline,
    hasTrailingNewline: split.hasTrailingNewline,
  });
}

async function applyCodexApplyPatch(
  patch: string,
  cwd: string,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const operations = parseCodexApplyPatch(patch);
  for (const operation of operations) {
    if (operation.kind === "add") {
      const filePath = path.resolve(cwd, operation.path);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${operation.lines.join("\n")}\n`, "utf8");
      continue;
    }

    if (operation.kind === "delete") {
      await unlink(path.resolve(cwd, operation.path));
      continue;
    }

    const filePath = path.resolve(cwd, operation.path);
    const current = await readFile(filePath, "utf8");
    const next = applyCodexHunks(current, operation.hunks, operation.path);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, next, "utf8");
    if (operation.moveTo) {
      const movedPath = path.resolve(cwd, operation.moveTo);
      await mkdir(path.dirname(movedPath), { recursive: true });
      await rename(filePath, movedPath);
    }
  }

  return { stdout: "", stderr: "", exitCode: 0 };
}

function killChildProcessTree(
  child: ChildProcessHandle,
  killSignal: NodeJS.Signals = "SIGTERM",
): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      child.kill(killSignal);
      return;
    }
  }
  try {
    process.kill(-child.pid, killSignal);
    return;
  } catch {
    child.kill(killSignal);
  }
}

function execShellCommand(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = LOCAL_TOOL_COMMAND_TIMEOUT_MS,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return new Promise((resolve, reject) => {
    const child =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/d", "/s", "/c", command], { cwd })
        : spawn("/bin/sh", ["-lc", command], { cwd, detached: true });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | undefined;
    const finalize = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (onAbort) {
        signal?.removeEventListener("abort", onAbort);
      }
      callback();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      killChildProcessTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        killChildProcessTree(child, "SIGKILL");
      }, 1_000);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      finalize(() => {
        reject(error);
      });
    });
    onAbort = () => {
      aborted = true;
      killChildProcessTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        killChildProcessTree(child, "SIGKILL");
      }, 1_000);
      finalize(() => {
        reject(new Error("Interrupted"));
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code, closeSignal) => {
      finalize(() => {
        const timeoutStderr = timedOut ? `Command timed out after ${timeoutMs}ms.` : "";
        const nextStderr =
          timeoutStderr.length > 0
            ? stderr.trim().length > 0
              ? `${stderr.replace(/\s*$/u, "")}\n${timeoutStderr}\n`
              : `${timeoutStderr}\n`
            : stderr;
        resolve({
          stdout,
          stderr: nextStderr,
          exitCode: timedOut ? 124 : (code ?? (aborted || closeSignal ? 1 : 0)),
        });
      });
    });
  });
}

async function applyUnifiedPatch(patch: string, cwd: string, signal?: AbortSignal) {
  return await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve, reject) => {
      const child = spawn("git", ["apply", "--whitespace=nowarn", "-"], {
        cwd,
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let onAbort: (() => void) | undefined;
      const finalize = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (onAbort) {
          signal?.removeEventListener("abort", onAbort);
        }
        callback();
      };

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      onAbort = () => {
        killChildProcessTree(child, "SIGTERM");
        finalize(() => {
          reject(new Error("Interrupted"));
        });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error) => {
        finalize(() => {
          reject(error);
        });
      });
      child.on("close", (code) => {
        finalize(() => {
          resolve({
            stdout,
            stderr,
            exitCode: code ?? 0,
          });
        });
      });
      child.stdin.write(patch);
      child.stdin.end();
    },
  );
}

function truncateToolText(value: string, limit: number) {
  if (value.length <= limit) {
    return value;
  }
  const omitted = value.length - limit;
  return `${value.slice(0, limit)}\n...[truncated ${omitted} chars]`;
}

function sanitizeToolOutput(toolName: string, output: unknown): unknown {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return output;
  }

  const record = { ...(output as Record<string, unknown>) };
  if (toolName === "read_file" && typeof record.content === "string") {
    record.content = truncateToolText(record.content, MAX_TOOL_FILE_CHARS);
  }
  if (toolName === "exec_command") {
    if (typeof record.stdout === "string") {
      record.stdout = truncateToolText(record.stdout, MAX_TOOL_COMMAND_OUTPUT_CHARS);
    }
    if (typeof record.stderr === "string") {
      record.stderr = truncateToolText(record.stderr, MAX_TOOL_COMMAND_OUTPUT_CHARS);
    }
  }
  return record;
}

function buildUserMessageText(input: ProviderSendTurnInput): string {
  return input.input?.trim() ?? "";
}

function buildAssistantCompletionEvent(input: {
  threadId: ThreadId;
  turnId: TurnId;
  itemId: RuntimeItemId;
  detail?: string;
}): ProviderRuntimeEvent {
  return {
    ...runtimeEventBase({
      threadId: input.threadId,
      turnId: input.turnId,
      itemId: input.itemId,
    }),
    type: "item.completed",
    payload: {
      itemType: "assistant_message",
      status: "completed",
      ...(input.detail && input.detail.trim().length > 0 ? { detail: input.detail } : {}),
    },
  } satisfies ProviderRuntimeEvent;
}

const HOSTED_COMMENTARY_PREFIXES = [
  "i'll start",
  "i will start",
  "i'll begin",
  "i will begin",
  "i'll search",
  "i will search",
  "i'll search the web",
  "i will search the web",
  "i’m going to ",
  "i am going to ",
  "let me ",
  "now let me ",
  "first, let me ",
  "next, let me ",
  "i should ",
  "i need to ",
] as const;

const HOSTED_COMMENTARY_VERBS = [
  "check",
  "look",
  "see",
  "examine",
  "review",
  "inspect",
  "search",
  "open",
  "read",
  "scan",
  "explore",
  "exploring",
  "launch",
  "investigate",
  "take a look",
] as const;

const HOSTED_COMMENTARY_PROBE_MAX_CHARS = 96;

function normalizeHostedCommentarySourceText(text: string): string {
  return text.trim().replace(/\s+/g, " ").replaceAll("’", "'").toLowerCase();
}

function hasHostedCommentaryPrefix(normalized: string): boolean {
  return HOSTED_COMMENTARY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function hasHostedCommentaryVerb(normalized: string): boolean {
  return HOSTED_COMMENTARY_VERBS.some((verb) => normalized.includes(verb));
}

function shouldProbeHostedCommentaryText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > HOSTED_COMMENTARY_PROBE_MAX_CHARS) {
    return false;
  }

  const normalized = normalizeHostedCommentarySourceText(trimmed);
  if (hasHostedCommentaryVerb(normalized)) {
    return false;
  }

  return HOSTED_COMMENTARY_PREFIXES.some((prefix) => prefix.startsWith(normalized));
}

function normalizeHostedCommentaryText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 240) {
    return null;
  }
  const normalized = normalizeHostedCommentarySourceText(trimmed);
  return hasHostedCommentaryPrefix(normalized) && hasHostedCommentaryVerb(normalized)
    ? trimmed
    : null;
}

function buildCommentaryAssistantCompletionEvent(input: {
  threadId: ThreadId;
  turnId: TurnId;
  itemId: RuntimeItemId;
  detail: string;
}): ProviderRuntimeEvent {
  return {
    ...runtimeEventBase({
      threadId: input.threadId,
      turnId: input.turnId,
      itemId: input.itemId,
    }),
    type: "item.completed",
    payload: {
      itemType: "assistant_message",
      status: "completed",
      detail: input.detail,
      data: {
        item: {
          id: String(input.itemId),
          phase: "commentary",
          text: input.detail,
        },
      },
    },
  } satisfies ProviderRuntimeEvent;
}

function buildTurnCompletedEvent(input: {
  threadId: ThreadId;
  turnId: TurnId;
  state: "completed" | "failed" | "cancelled" | "interrupted";
  errorMessage?: string;
}): ProviderRuntimeEvent {
  return {
    ...runtimeEventBase({
      threadId: input.threadId,
      turnId: input.turnId,
    }),
    type: "turn.completed",
    payload: {
      state: input.state,
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    },
  } satisfies ProviderRuntimeEvent;
}

export function buildInterruptedTurnEvents(input: {
  threadId: ThreadId;
  turnId: TurnId;
  assistantItemId: RuntimeItemId | null;
  assistantStarted: boolean;
  openReasoningItemIds: ReadonlyArray<RuntimeItemId>;
}): ReadonlyArray<ProviderRuntimeEvent> {
  const events: ProviderRuntimeEvent[] = [];

  for (const reasoningItemId of input.openReasoningItemIds) {
    events.push({
      ...runtimeEventBase({
        threadId: input.threadId,
        turnId: input.turnId,
        itemId: reasoningItemId,
      }),
      type: "item.completed",
      payload: {
        itemType: "reasoning",
        status: "completed",
      },
    } satisfies ProviderRuntimeEvent);
  }

  if (input.assistantStarted && input.assistantItemId) {
    events.push(
      buildAssistantCompletionEvent({
        threadId: input.threadId,
        turnId: input.turnId,
        itemId: input.assistantItemId,
      }),
    );
  }

  events.push(
    buildTurnCompletedEvent({
      threadId: input.threadId,
      turnId: input.turnId,
      state: "interrupted",
    }),
  );

  return events;
}

function runtimeItemTypeForTool(toolName: string): CanonicalItemType {
  return classifyProviderToolLifecycleItemType(toolName);
}

function assistantTextItemId(turnId: TurnId, textId: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(`${SHIORI_ASSISTANT_ITEM_PREFIX}:${String(turnId)}:${textId}`);
}

function toolTitle(toolName: string): string {
  return providerToolTitle(toolName);
}

function toolLifecycleDetail(
  toolName: string,
  toolInput: Record<string, unknown>,
): string | undefined {
  const summary = summarizeProviderToolInvocation(toolName, toolInput);
  if (!summary) {
    return undefined;
  }

  const titlePrefix = `${providerToolTitle(toolName)}: `;
  if (summary.startsWith(titlePrefix)) {
    return summary.slice(titlePrefix.length);
  }

  return summary === providerToolTitle(toolName) ? undefined : summary;
}

function ensureReasoningBlock(
  activeTurn: ActiveTurnState,
  chunkId: string,
): {
  itemId: RuntimeItemId;
  text: string;
  providerMetadata: ProviderMetadata | undefined;
  completed: boolean;
  includedInHistory: boolean;
  visibleStarted: boolean;
} {
  const existing = activeTurn.reasoningBlocks.get(chunkId);
  if (existing) {
    return existing;
  }
  const created = {
    itemId: RuntimeItemId.makeUnsafe(
      `${SHIORI_REASONING_ITEM_PREFIX}:${String(activeTurn.turnId)}:${chunkId}`,
    ),
    text: "",
    providerMetadata: undefined,
    completed: false,
    includedInHistory: false,
    visibleStarted: false,
  };
  activeTurn.reasoningBlocks.set(chunkId, created);
  activeTurn.reasoningBlockOrder.push(chunkId);
  return created;
}

function buildReasoningPartsForBlockIds(
  activeTurn: ActiveTurnState,
  blockIds: ReadonlyArray<string>,
): HostedShioriMessage["parts"] {
  return blockIds.flatMap((blockId) => {
    const block = activeTurn.reasoningBlocks.get(blockId);
    if (!block || !hasReplayableReasoningBlock(block)) {
      return [];
    }
    return [
      {
        type: "reasoning" as const,
        text: block.text,
        ...(block.providerMetadata != null ? { providerMetadata: block.providerMetadata } : {}),
      },
    ];
  });
}

function hasReasoningProviderMetadata(providerMetadata: ProviderMetadata | undefined): boolean {
  return providerMetadata != null && Object.keys(providerMetadata).length > 0;
}

function hasReplayableReasoningBlock(block: {
  text: string;
  providerMetadata: ProviderMetadata | undefined;
}): boolean {
  return block.text.trim().length > 0 || hasReasoningProviderMetadata(block.providerMetadata);
}

function takeUnconsumedReasoningBlockIds(activeTurn: ActiveTurnState): string[] {
  const selected: string[] = [];
  for (const blockId of activeTurn.reasoningBlockOrder) {
    const block = activeTurn.reasoningBlocks.get(blockId);
    if (!block || block.includedInHistory || !hasReplayableReasoningBlock(block)) {
      continue;
    }
    block.includedInHistory = true;
    selected.push(blockId);
  }
  return selected;
}

const makeShioriAdapter = (options?: ShioriAdapterLiveOptions) =>
  Layer.effect(
    ShioriAdapter,
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const hostedAuthTokenStore = yield* HostedShioriAuthTokenStore;
      const orchestrationEngineOption = yield* Effect.serviceOption(OrchestrationEngineService);
      const directory = yield* ProviderSessionDirectory;
      const workspaceEntries = yield* WorkspaceEntries;
      const sessionsRef = yield* Ref.make(new Map<string, ShioriSessionContext>());
      const finalizedTurnIdsRef = yield* Ref.make(new Set<string>());
      const eventsPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const toolRuntimeLoads = new Map<string, Promise<ShioriSessionToolRuntime>>();

      const emit = (event: ProviderRuntimeEvent) =>
        PubSub.publish(eventsPubSub, event).pipe(Effect.asVoid);

      const emitSessionExited = (input: {
        threadId: ThreadId;
        reason?: string;
        exitKind?: "graceful" | "error";
        recoverable?: boolean;
      }) =>
        emit({
          ...runtimeEventBase({
            threadId: input.threadId,
          }),
          type: "session.exited",
          payload: {
            ...(input.reason ? { reason: input.reason } : {}),
            ...(input.exitKind ? { exitKind: input.exitKind } : {}),
            ...(input.recoverable !== undefined ? { recoverable: input.recoverable } : {}),
          },
        } satisfies ProviderRuntimeEvent);

      const markTurnFinalized = (turnId: TurnId) =>
        Ref.update(finalizedTurnIdsRef, (existing) => {
          const next = new Set(existing);
          next.add(String(turnId));
          return next;
        }).pipe(Effect.asVoid);

      const isTurnFinalized = (turnId: TurnId) =>
        Ref.get(finalizedTurnIdsRef).pipe(Effect.map((existing) => existing.has(String(turnId))));

      const updateContext = (
        threadId: ThreadId,
        updater: (context: ShioriSessionContext) => ShioriSessionContext,
      ) =>
        Ref.update(sessionsRef, (sessions) => {
          const next = new Map(sessions);
          const existing = next.get(String(threadId));
          if (!existing) {
            return sessions;
          }
          next.set(String(threadId), updater(existing));
          return next;
        }).pipe(Effect.asVoid);

      const persistContext = (context: ShioriSessionContext) =>
        directory
          .upsert({
            threadId: context.session.threadId,
            provider: PROVIDER,
            status: context.activeTurn ? "running" : "stopped",
            ...(computeResumeCursor(context) ? { resumeCursor: computeResumeCursor(context) } : {}),
            runtimePayload: {
              ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
              ...(context.session.model
                ? { modelSelection: { provider: PROVIDER, model: context.session.model } }
                : {}),
              activeTurnId: context.activeTurn?.turnId ?? null,
              lastRuntimeEventAt: nowIso(),
              lastRuntimeEvent: context.activeTurn
                ? "shiori.turn.running"
                : "shiori.turn.completed",
            },
          })
          .pipe(
            Effect.mapError((error) =>
              requestError(
                `shiori.persist:${String(context.session.threadId)}`,
                "Failed to persist Shiori session state.",
                error,
              ),
            ),
          );

      const getContext = (threadId: ThreadId) =>
        Ref.get(sessionsRef).pipe(
          Effect.flatMap((sessions) => {
            const context = sessions.get(String(threadId));
            return context
              ? Effect.succeed(context)
              : Effect.fail(
                  new ProviderAdapterSessionNotFoundError({
                    provider: PROVIDER,
                    threadId,
                  }),
                );
          }),
        );

      const setContext = (threadId: ThreadId, nextContext: ShioriSessionContext) =>
        Ref.update(sessionsRef, (sessions) => {
          const next = new Map(sessions);
          next.set(String(threadId), nextContext);
          return next;
        }).pipe(Effect.asVoid);

      const updateContextAndPersist = (
        threadId: ThreadId,
        updater: (context: ShioriSessionContext) => ShioriSessionContext,
      ) =>
        Effect.gen(function* () {
          yield* updateContext(threadId, updater);
          const updatedContext = yield* getContext(threadId);
          yield* persistContext(updatedContext);
          return updatedContext;
        });

      // Single attempt at the hosted stream endpoint. Converts network failures and
      // non-2xx responses into a classified HostedFetchFailure so the retry schedule
      // can decide whether another attempt makes sense. Success returns the open
      // Response with its streamable body.
      const attemptHostedStreamFetch = Effect.fn("attemptHostedStreamFetch")(function* (input: {
        method: string;
        apiBaseUrl: string;
        authToken: string;
        requestBody: Buffer;
        signal: AbortSignal;
        responseTimeout: Duration.Input;
      }) {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetchHostedStreamResponse({
              url: `${input.apiBaseUrl}/api/shiori-code/agent/stream`,
              requestBody: input.requestBody,
              authToken: input.authToken,
              signal: input.signal,
              responseTimeout: input.responseTimeout,
            }),
          catch: (error): HostedFetchFailure =>
            isHostedFetchResponseTimeoutError(error)
              ? {
                  kind: "timeout",
                  detail: toMessage(error),
                  retryable: true,
                  cause: error,
                }
              : {
                  kind: "network",
                  detail: toMessage(error),
                  retryable: !isAbortCause(error) && isRetryableCause(error),
                  cause: error,
                },
        });

        if (response.ok && response.body) {
          return response;
        }

        const detail = yield* readHostedFailureDetail(response);
        const httpFailure: HostedFetchFailure = {
          kind: "http",
          status: response.status,
          detail,
          retryable: isRetryableStatus(response.status),
        };
        return yield* Effect.fail(httpFailure);
      });

      const effectiveMaxRetries = options?.maxFetchRetries ?? FETCH_RETRY_MAX_ATTEMPTS;
      const effectiveRetryDelayMs =
        options?.fetchRetryDelayMs ?? ((attempt: number) => 250 * 2 ** (attempt - 1));
      const effectiveStreamReadTimeout: Duration.Input =
        options?.streamReadTimeout ?? STREAM_READ_TIMEOUT;
      const effectiveHostedFetchResponseTimeout: Duration.Input =
        options?.hostedFetchResponseTimeout ?? HOSTED_FETCH_RESPONSE_TIMEOUT;
      const effectiveMaxStreamBytes = options?.maxStreamBytes ?? MAX_STREAM_BYTES;
      const effectiveLocalToolCommandTimeoutMs =
        options?.localToolCommandTimeoutMs ?? LOCAL_TOOL_COMMAND_TIMEOUT_MS;

      // Perform the hosted stream fetch with exponential backoff. 401 responses clear
      // the cached Shiori token so the UI prompts for a fresh sign-in instead of
      // hammering the endpoint with the same expired credential.
      const performHostedStreamFetch = Effect.fn("performHostedStreamFetch")(function* (input: {
        method: string;
        apiBaseUrl: string;
        authToken: string;
        requestBody: Buffer;
        signal: AbortSignal;
        logLabel: string;
      }) {
        // Manual retry loop: Effect v4's schedule+while combination for typed failures
        // is finicky, and we want deterministic attempt counts and classification.
        let lastFailure: HostedFetchFailure = {
          kind: "network",
          detail: "Shiori fetch was aborted before a response was received.",
          retryable: false,
        };
        for (let attempt = 0; attempt <= effectiveMaxRetries; attempt += 1) {
          if (input.signal.aborted) {
            break;
          }
          const attemptResult = yield* Effect.result(
            attemptHostedStreamFetch({
              method: input.method,
              apiBaseUrl: input.apiBaseUrl,
              authToken: input.authToken,
              requestBody: input.requestBody,
              signal: input.signal,
              responseTimeout: effectiveHostedFetchResponseTimeout,
            }),
          );
          if (attemptResult._tag === "Success") {
            return attemptResult.success;
          }
          lastFailure = attemptResult.failure;
          yield* Effect.logDebug("shiori hosted fetch attempt failed", {
            label: input.logLabel,
            attempt: attempt + 1,
            kind: lastFailure.kind,
            ...(lastFailure.status !== undefined ? { status: lastFailure.status } : {}),
            retryable: lastFailure.retryable,
            detail: lastFailure.detail,
          });
          if (!lastFailure.retryable || attempt >= effectiveMaxRetries) {
            break;
          }
          const delayMs = effectiveRetryDelayMs(attempt);
          if (delayMs > 0) {
            yield* Effect.sleep(Duration.millis(delayMs));
          }
        }

        const failure = lastFailure;
        if (failure.kind === "http" && failure.status === 401) {
          const tokenMatchesExpectedDeployment = isExpectedHostedShioriAuthToken(input.authToken);
          yield* Effect.logWarning("shiori hosted fetch 401", {
            label: input.logLabel,
            detail: failure.detail,
            tokenMatchesExpectedDeployment,
          });
          if (tokenMatchesExpectedDeployment) {
            yield* hostedAuthTokenStore.setToken(null);
          }
          return yield* Effect.fail(
            requestError(
              input.logLabel,
              "Shiori rejected the hosted session (401). Sign out and sign back in to continue.",
            ),
          );
        }

        if (failure.kind === "http" && failure.status === 403) {
          return yield* Effect.fail(
            requestError(
              input.logLabel,
              "Shiori rejected the hosted session (403). Verify your subscription and plan access.",
            ),
          );
        }

        yield* Effect.logWarning("shiori hosted fetch failed", {
          label: input.logLabel,
          kind: failure.kind,
          ...(failure.status !== undefined ? { status: failure.status } : {}),
          retryable: failure.retryable,
          detail: failure.detail,
        });
        return yield* Effect.fail(
          requestError(
            input.logLabel,
            failure.kind === "http"
              ? failure.detail
              : `Shiori API request failed: ${failure.detail}`,
            failure.cause,
          ),
        );
      });

      const emptyToolRuntime = {
        descriptors: [],
        executors: new Map(),
        warnings: [],
        skillPrompt: undefined,
        close: async () => undefined,
      } satisfies ProviderSkillRuntime;

      const buildMcpRuntimeForCwd = Effect.fn("buildMcpRuntimeForCwd")(function* (input: {
        readonly threadId: ThreadId;
        readonly cwd: string | undefined;
      }) {
        const currentSettings = yield* serverSettings.getSettings.pipe(
          Effect.mapError((error) =>
            requestError(
              "shiori.mcp.runtime",
              "Failed to load server settings while preparing MCP tools.",
              error,
            ),
          ),
        );

        const mcpRuntime = yield* Effect.tryPromise(() =>
          loadEffectiveMcpServersForProvider({
            provider: PROVIDER,
            settings: currentSettings,
            ...(input.cwd ? { cwd: input.cwd } : {}),
          }).then(async (effectiveServers) => {
            const builtInServers = builtInShioriMcpServers({
              settings: currentSettings,
              browserPanel: {
                config: serverConfig,
                threadId: input.threadId,
              },
              exposeComputerWhenApprovalRequired: true,
            });
            const runtime = options?.buildMcpToolRuntime
              ? await options.buildMcpToolRuntime({
                  provider: PROVIDER,
                  servers: [...effectiveServers.servers, ...builtInServers],
                  ...(input.cwd ? { cwd: input.cwd } : {}),
                })
              : await buildProviderMcpToolRuntime(
                  {
                    provider: PROVIDER,
                    servers: [...effectiveServers.servers, ...builtInServers],
                    ...(input.cwd ? { cwd: input.cwd } : {}),
                  },
                  {
                    oauthStorageDir: path.join(serverConfig.stateDir, "mcp-oauth"),
                  },
                );
            return {
              ...runtime,
              warnings: [...effectiveServers.warnings, ...runtime.warnings],
            };
          }),
        ).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* Effect.logWarning(
                "shiori mcp runtime initialization failed; continuing without MCP tools",
              );
              yield* Effect.logWarning(
                toMessage(error).trim().length > 0
                  ? toMessage(error)
                  : "Failed to initialize MCP servers for Shiori.",
              );
              return emptyToolRuntime satisfies ProviderMcpToolRuntime;
            }),
          ),
        );
        const kanbanRuntime = Option.match(orchestrationEngineOption, {
          onSome: (orchestrationEngine) =>
            makeKanbanProviderToolRuntime({
              orchestrationEngine,
              provider: PROVIDER,
              threadId: input.threadId,
            }),
          onNone: () => emptyToolRuntime satisfies ProviderMcpToolRuntime,
        });
        const mergedMcpRuntime: ProviderMcpToolRuntime = {
          descriptors: [...mcpRuntime.descriptors, ...kanbanRuntime.descriptors],
          executors: new Map([...mcpRuntime.executors, ...kanbanRuntime.executors]),
          warnings: [...mcpRuntime.warnings, ...kanbanRuntime.warnings],
          close: async () => {
            await Promise.allSettled([mcpRuntime.close(), kanbanRuntime.close()]);
          },
        };

        const skillRuntime = yield* Effect.tryPromise(() =>
          input.cwd
            ? (options?.buildSkillToolRuntime ?? buildShioriSkillToolRuntime)({ cwd: input.cwd })
            : (options?.buildSkillToolRuntime ?? buildShioriSkillToolRuntime)({}),
        ).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* Effect.logWarning(
                "shiori skill runtime initialization failed; continuing without skill tools",
              );
              yield* Effect.logWarning(
                toMessage(error).trim().length > 0
                  ? toMessage(error)
                  : "Failed to initialize skills for Shiori.",
              );
              return emptyToolRuntime;
            }),
          ),
        );

        const runtime = {
          descriptors: [...mergedMcpRuntime.descriptors, ...skillRuntime.descriptors],
          executors: new Map([...mergedMcpRuntime.executors, ...skillRuntime.executors]),
          warnings: [...mergedMcpRuntime.warnings, ...skillRuntime.warnings],
          skillPrompt: skillRuntime.skillPrompt,
          close: async () => {
            await Promise.allSettled([mergedMcpRuntime.close(), skillRuntime.close()]);
          },
        } satisfies ProviderSkillRuntime;

        for (const warning of runtime.warnings) {
          yield* Effect.logWarning("shiori tool runtime warning", {
            cwd: input.cwd,
            warning,
          });
        }

        return runtime;
      });

      const loadSessionToolRuntime = (input: { threadId: ThreadId; cwd: string | undefined }) => {
        const key = String(input.threadId);
        const existing = toolRuntimeLoads.get(key);
        if (existing) {
          return existing;
        }

        const load = Effect.runPromise(
          buildMcpRuntimeForCwd({ threadId: input.threadId, cwd: input.cwd }),
        )
          .then(async (runtime) => {
            const shouldClose = await Effect.runPromise(
              Ref.modify(sessionsRef, (sessions) => {
                const context = sessions.get(key);
                if (!context) {
                  return [true, sessions] as const;
                }

                if (context.toolRuntime === null) {
                  context.toolRuntime = runtime;
                }

                return [false, sessions] as const;
              }),
            );

            if (shouldClose) {
              await runtime.close();
            }

            return runtime;
          })
          .finally(() => {
            toolRuntimeLoads.delete(key);
          });

        toolRuntimeLoads.set(key, load);
        return load;
      };

      const prewarmSessionToolRuntime = Effect.fn("prewarmSessionToolRuntime")(function* (
        threadId: ThreadId,
        cwd: string | undefined,
      ) {
        yield* Effect.sync(() => {
          void loadSessionToolRuntime({ threadId, cwd });
        });
      });

      const prewarmHostedBootstrapForContext = Effect.fn("prewarmHostedBootstrapForContext")(
        function* (input: { threadId: ThreadId; authToken: string }) {
          yield* Effect.sync(() => {
            void Effect.runPromise(
              fetchHostedBootstrapForToken(input.authToken).pipe(
                Effect.flatMap((bootstrap) =>
                  Ref.update(sessionsRef, (sessions) => {
                    const next = new Map(sessions);
                    const context = next.get(String(input.threadId));
                    if (!context) {
                      return next;
                    }

                    const warmedContext = {
                      ...context,
                      hostedBootstrap: bootstrap,
                      hostedBootstrapFetchedAt: Date.now(),
                      ...(context.activeTurn
                        ? {
                            activeTurn: {
                              ...context.activeTurn,
                              hostedBootstrap: bootstrap,
                            },
                          }
                        : {}),
                    } satisfies ShioriSessionContext;

                    next.set(String(input.threadId), warmedContext);
                    return next;
                  }),
                ),
                Effect.catch(() => Effect.void),
              ),
            );
          });
        },
      );

      const fetchHostedBootstrapForToken = Effect.fn("fetchHostedBootstrapForToken")(function* (
        authToken: string,
      ) {
        if (!isExpectedHostedShioriAuthToken(authToken)) {
          yield* Effect.logWarning("shiori hosted bootstrap skipped for invalid deployment token", {
            token: describeToken(authToken),
          });
          return CONSERVATIVE_SHIORI_BOOTSTRAP;
        }
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError((error) =>
            requestError(
              "shiori.bootstrap",
              "Failed to load server settings while preparing hosted bootstrap policy.",
              error,
            ),
          ),
        );
        const probe = yield* (options?.fetchBootstrapProbe ?? fetchShioriCodeBootstrap)({
          apiBaseUrl: settings.providers.shiori.apiBaseUrl,
          authToken,
        });
        if (probe.message) {
          yield* Effect.logWarning("shiori hosted bootstrap unavailable", {
            message: probe.message,
          });
        }
        return effectiveShioriBootstrap(probe.bootstrap);
      });

      const resolveHostedBootstrapForContext = Effect.fn("resolveHostedBootstrapForContext")(
        function* (input: { threadId: ThreadId; authToken: string }) {
          const context = yield* getContext(input.threadId);
          const existing = context.hostedBootstrap ?? context.activeTurn?.hostedBootstrap;
          const fetchedAt = context.hostedBootstrapFetchedAt ?? 0;
          if (existing !== undefined && Date.now() - fetchedAt < HOSTED_BOOTSTRAP_CACHE_TTL_MS) {
            return existing;
          }

          const bootstrap = yield* fetchHostedBootstrapForToken(input.authToken);
          context.hostedBootstrap = bootstrap;
          context.hostedBootstrapFetchedAt = Date.now();
          if (context.activeTurn) {
            context.activeTurn.hostedBootstrap = bootstrap;
          }
          return bootstrap;
        },
      );

      const getFreshHostedBootstrapForContext = (
        context: ShioriSessionContext,
      ): ShioriCodeBootstrapConfig | null | undefined => {
        const existing = context.hostedBootstrap ?? context.activeTurn?.hostedBootstrap;
        const fetchedAt = context.hostedBootstrapFetchedAt ?? 0;
        return existing !== undefined && Date.now() - fetchedAt < HOSTED_BOOTSTRAP_CACHE_TTL_MS
          ? existing
          : undefined;
      };

      const getOrCreateSessionToolRuntime = Effect.fn("getOrCreateSessionToolRuntime")(function* (
        context: ShioriSessionContext,
      ) {
        if (context.toolRuntime) {
          return context.toolRuntime;
        }

        const runtime = yield* Effect.tryPromise({
          try: () =>
            loadSessionToolRuntime({
              threadId: context.session.threadId,
              cwd: context.session.cwd,
            }),
          catch: (error) =>
            requestError("shiori.mcp.runtime", "Failed to initialize MCP tools for Shiori.", error),
        });
        context.toolRuntime = runtime;
        return runtime;
      });

      const closeSessionToolRuntime = (context: ShioriSessionContext | null | undefined) => {
        if (!context?.toolRuntime) {
          return Effect.void;
        }

        return Effect.promise(() => context.toolRuntime!.close()).pipe(
          Effect.ignore({ log: false }),
        );
      };

      const restoreRecoverableActiveTurn = (input: {
        session: ProviderSession;
        snapshot: NonNullable<DecodedShioriResumeState["activeTurnSnapshot"]>;
        messages: ReadonlyArray<HostedShioriMessage>;
        pendingApprovals: ReadonlyArray<PendingToolCall>;
        pendingUserInputs: ReadonlyArray<PendingToolCall>;
        toolRuntime: ShioriSessionToolRuntime;
      }): ActiveTurnState => {
        const latestPending =
          [...input.pendingApprovals, ...input.pendingUserInputs].at(-1) ?? null;
        const replayState = latestPending
          ? extractAssistantToolReplayState({
              messages: input.messages,
              assistantMessageId: latestPending.assistantMessageId,
            })
          : { text: "", reasoningParts: [] };

        return {
          turnId: input.snapshot.turnId,
          controller: new AbortController(),
          assistantItemId: RuntimeItemId.makeUnsafe(
            `${SHIORI_ASSISTANT_ITEM_PREFIX}:${String(input.snapshot.turnId)}`,
          ),
          interactionMode: input.snapshot.interactionMode,
          mcpToolDescriptors: input.toolRuntime.descriptors,
          mcpTools: input.toolRuntime.executors,
          closeMcpTools: async () => undefined,
          skillPrompt: input.toolRuntime.skillPrompt,
          ...(input.snapshot.modelSettings ? { modelSettings: input.snapshot.modelSettings } : {}),
          assistantText: replayState.text,
          assistantFinalText: replayState.text,
          assistantActiveItemId: null,
          assistantStarted: false,
          commentaryCount: 0,
          reasoningBlocks: new Map(),
          reasoningBlockOrder: [],
        };
      };

      const emitApprovalRequest = Effect.fn("emitApprovalRequest")(function* (input: {
        threadId: ThreadId;
        turnId: TurnId;
        requestId: ApprovalRequestId;
        toolName: string;
        toolInput: Record<string, unknown>;
        requestKind: ApprovalRequestKind;
      }) {
        const detail =
          input.requestKind === "command"
            ? String(input.toolInput.command ?? input.toolName)
            : String(input.toolInput.path ?? input.toolName);
        yield* emit({
          ...runtimeEventBase({
            threadId: input.threadId,
            turnId: input.turnId,
            itemId: RuntimeItemId.makeUnsafe(`tool:${input.toolName}:${String(input.turnId)}`),
          }),
          requestId: RuntimeRequestId.makeUnsafe(input.requestId),
          type: "request.opened",
          payload: {
            requestType:
              input.requestKind === "command"
                ? "exec_command_approval"
                : input.toolName === "apply_patch"
                  ? "apply_patch_approval"
                  : input.requestKind === "file-read"
                    ? "file_read_approval"
                    : "file_change_approval",
            detail,
            args: {
              toolName: input.toolName,
              input: input.toolInput,
            },
          },
        } satisfies ProviderRuntimeEvent);
      });

      const emitApprovalResolved = (input: {
        threadId: ThreadId;
        turnId: TurnId;
        requestId: ApprovalRequestId;
        toolName: string;
        requestKind?: ApprovalRequestKind;
        decision: ProviderApprovalDecision;
      }) => {
        const resolvedDecision = isSimpleApprovalDecision(input.decision)
          ? input.decision
          : "decline";
        return emit({
          ...runtimeEventBase({
            threadId: input.threadId,
            turnId: input.turnId,
          }),
          requestId: RuntimeRequestId.makeUnsafe(input.requestId),
          type: "request.resolved",
          payload: {
            requestType:
              input.toolName === "exec_command"
                ? "exec_command_approval"
                : input.toolName === "apply_patch"
                  ? "apply_patch_approval"
                  : input.requestKind === "file-read"
                    ? "file_read_approval"
                    : "file_change_approval",
            decision: resolvedDecision,
          },
        } satisfies ProviderRuntimeEvent);
      };

      const emitUserInputRequest = Effect.fn("emitUserInputRequest")(function* (input: {
        threadId: ThreadId;
        turnId: TurnId;
        requestId: ApprovalRequestId;
        toolInput: Record<string, unknown>;
      }) {
        const questions = extractUserInputQuestions(input.toolInput);
        yield* emit({
          ...runtimeEventBase({
            threadId: input.threadId,
            turnId: input.turnId,
          }),
          requestId: RuntimeRequestId.makeUnsafe(input.requestId),
          type: "user-input.requested",
          payload: {
            questions,
          },
        } satisfies ProviderRuntimeEvent);
      });

      const emitUserInputResolved = (input: {
        threadId: ThreadId;
        turnId: TurnId;
        requestId: ApprovalRequestId;
        answers: ProviderUserInputAnswers;
      }) =>
        emit({
          ...runtimeEventBase({
            threadId: input.threadId,
            turnId: input.turnId,
          }),
          requestId: RuntimeRequestId.makeUnsafe(input.requestId),
          type: "user-input.resolved",
          payload: {
            answers: input.answers,
          },
        } satisfies ProviderRuntimeEvent);

      const finalizeInterruptedTurn = Effect.fn("finalizeInterruptedTurn")(function* (
        context: ShioriSessionContext,
        options?: {
          resolvePendingRequests?: boolean;
        },
      ) {
        const activeTurn = context.activeTurn;
        if (!activeTurn) {
          return;
        }

        const resolvePendingRequests = options?.resolvePendingRequests === true;
        if (resolvePendingRequests) {
          for (const pending of context.pendingApprovals.values()) {
            yield* emitApprovalResolved({
              threadId: context.session.threadId,
              turnId: activeTurn.turnId,
              requestId: pending.requestId,
              toolName: pending.toolName,
              ...(pending.requestKind ? { requestKind: pending.requestKind } : {}),
              decision: "cancel",
            });
          }

          for (const pending of context.pendingUserInputs.values()) {
            yield* emitUserInputResolved({
              threadId: context.session.threadId,
              turnId: activeTurn.turnId,
              requestId: pending.requestId,
              answers: {},
            });
          }
        }

        const interruptedContext = withResumeCursor({
          ...context,
          activeTurn: null,
          pendingApprovals: resolvePendingRequests ? new Map() : context.pendingApprovals,
          pendingUserInputs: resolvePendingRequests ? new Map() : context.pendingUserInputs,
          session: {
            ...context.session,
            status: "ready",
            activeTurnId: undefined,
            updatedAt: nowIso(),
          },
        });

        yield* setContext(context.session.threadId, interruptedContext);
        yield* markTurnFinalized(activeTurn.turnId);
        if (!activeTurn.controller.signal.aborted) {
          activeTurn.controller.abort();
        }
        yield* Effect.promise(() => closeActiveTurnMcpTools(activeTurn)).pipe(
          Effect.ignore({ log: false }),
        );
        yield* persistContext(interruptedContext);
        yield* Effect.forEach(
          buildInterruptedTurnEvents({
            threadId: context.session.threadId,
            turnId: activeTurn.turnId,
            assistantItemId: activeTurn.assistantActiveItemId,
            assistantStarted: activeTurn.assistantStarted,
            openReasoningItemIds: activeTurn.reasoningBlockOrder.flatMap((blockId) => {
              const block = activeTurn.reasoningBlocks.get(blockId);
              return block && block.visibleStarted && !block.completed ? [block.itemId] : [];
            }),
          }),
          emit,
          { concurrency: 1 },
        ).pipe(Effect.asVoid);
      });

      const failTurn = Effect.fn("failTurn")(function* (input: {
        context: ShioriSessionContext;
        detail: string;
      }) {
        const activeTurn = input.context.activeTurn;
        if (!activeTurn) {
          return;
        }

        const failedContext = withResumeCursor({
          ...input.context,
          activeTurn: null,
          pendingApprovals: new Map(),
          pendingUserInputs: new Map(),
          session: {
            ...input.context.session,
            status: "ready",
            activeTurnId: undefined,
            updatedAt: nowIso(),
            lastError: input.detail,
          },
        });
        yield* setContext(input.context.session.threadId, failedContext);
        yield* Effect.promise(() => closeActiveTurnMcpTools(activeTurn)).pipe(
          Effect.ignore({ log: false }),
        );
        yield* persistContext(failedContext);
        yield* markTurnFinalized(activeTurn.turnId);
        yield* emit({
          ...runtimeEventBase({
            threadId: input.context.session.threadId,
            turnId: activeTurn.turnId,
          }),
          type: "runtime.error",
          payload: {
            message: input.detail,
            class: "provider_error",
          },
        } satisfies ProviderRuntimeEvent);
        yield* emit(
          buildTurnCompletedEvent({
            threadId: input.context.session.threadId,
            turnId: activeTurn.turnId,
            state: "failed",
            errorMessage: input.detail,
          }),
        );
      });

      // Last-resort handler for failures that escape runHostedTurn's own try/catch
      // (for example, a fetch rejected before the stream-read loop started). Without
      // this, a background fork can fail silently and leave the UI stuck waiting for
      // a turn.completed event.
      const finalizeFailedBackgroundTurn = Effect.fn("finalizeFailedBackgroundTurn")(
        function* (input: { threadId: ThreadId; turnId: TurnId; error: unknown }) {
          const detail = toMessage(input.error);
          const finalized = yield* isTurnFinalized(input.turnId);
          if (finalized) {
            return;
          }
          const context = yield* Ref.get(sessionsRef).pipe(
            Effect.map((sessions) => sessions.get(String(input.threadId)) ?? null),
          );
          if (context?.activeTurn && context.activeTurn.turnId === input.turnId) {
            yield* failTurn({ context, detail });
            return;
          }
          // No activeTurn to own the failure; surface the event anyway so the UI moves on.
          yield* markTurnFinalized(input.turnId);
          yield* emit({
            ...runtimeEventBase({
              threadId: input.threadId,
              turnId: input.turnId,
            }),
            type: "runtime.error",
            payload: {
              message: detail,
              class: "provider_error",
            },
          } satisfies ProviderRuntimeEvent);
          yield* emit(
            buildTurnCompletedEvent({
              threadId: input.threadId,
              turnId: input.turnId,
              state: "failed",
              errorMessage: detail,
            }),
          );
        },
      );

      const emitToolStarted = (input: {
        threadId: ThreadId;
        turnId: TurnId;
        toolName: string;
        toolCallId: string;
        toolInput: Record<string, unknown>;
        title?: string;
        detail?: string;
      }) =>
        emit({
          ...runtimeEventBase({
            threadId: input.threadId,
            turnId: input.turnId,
            itemId: RuntimeItemId.makeUnsafe(`tool:${input.toolCallId}`),
          }),
          type: "item.started",
          payload: {
            itemType: runtimeItemTypeForTool(input.toolName),
            status: "inProgress",
            title: input.title ?? toolTitle(input.toolName),
            detail:
              input.detail ??
              (input.toolName === "exec_command"
                ? String(input.toolInput.command ?? input.toolName)
                : typeof input.toolInput.path === "string"
                  ? input.toolInput.path
                  : toolLifecycleDetail(input.toolName, input.toolInput)),
            data: {
              toolName: input.toolName,
              input: input.toolInput,
              ...(typeof input.toolInput.command === "string"
                ? { command: input.toolInput.command }
                : {}),
            },
          },
        } satisfies ProviderRuntimeEvent);

      const emitToolCompleted = (input: {
        threadId: ThreadId;
        turnId: TurnId;
        toolName: string;
        toolCallId: string;
        toolInput: Record<string, unknown>;
        status?: "completed" | "failed";
        detail?: string;
        data?: unknown;
        title?: string;
      }) =>
        emit({
          ...runtimeEventBase({
            threadId: input.threadId,
            turnId: input.turnId,
            itemId: RuntimeItemId.makeUnsafe(`tool:${input.toolCallId}`),
          }),
          type: "item.completed",
          payload: {
            itemType: runtimeItemTypeForTool(input.toolName),
            status: input.status ?? "completed",
            title: input.title ?? toolTitle(input.toolName),
            ...(input.detail ? { detail: input.detail } : {}),
            ...(input.data !== undefined ? { data: input.data } : {}),
          },
        } satisfies ProviderRuntimeEvent);

      const allocateSubagentTaskName = (
        context: ShioriSessionContext,
        preferred: unknown,
      ): string => {
        const base = sanitizeTaskName(preferred);
        const existing = new Set(
          Array.from(context.subagents.values()).map((state) => state.taskName),
        );
        if (!existing.has(base)) {
          return base;
        }
        for (let index = 2; index <= 999; index += 1) {
          const candidate = `${base}_${index}`;
          if (!existing.has(candidate)) {
            return candidate;
          }
        }
        return `${base}_${crypto.randomUUID().slice(0, 6)}`;
      };

      const appendSubagentNotification = (input: {
        threadId: ThreadId;
        agentPath: string;
        status: ShioriSubagentLifecycleStatus;
        summary?: string;
      }) =>
        updateContextAndPersist(input.threadId, (context) => ({
          ...context,
          pendingSubagentNotifications: [
            ...context.pendingSubagentNotifications,
            formatSubagentNotificationPayload({
              agentPath: input.agentPath,
              status: input.status,
              ...(input.summary ? { summary: input.summary } : {}),
            }),
          ],
        })).pipe(Effect.asVoid);

      const emitSubagentTaskStarted = (input: {
        threadId: ThreadId;
        taskId: string;
        turnId?: TurnId;
        description?: string;
        taskType?: string;
        toolUseId?: string;
      }) =>
        emit({
          ...runtimeEventBase({
            threadId: input.threadId,
            ...(input.turnId ? { turnId: input.turnId } : {}),
          }),
          type: "task.started",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(input.taskId),
            ...(input.description ? { description: input.description } : {}),
            ...(input.taskType ? { taskType: input.taskType } : {}),
          },
          raw: {
            source: "shiori.hosted",
            method: "shiori/subagent/task_started",
            payload: {
              task_id: input.taskId,
              ...(input.toolUseId ? { tool_use_id: input.toolUseId } : {}),
            },
          },
        } satisfies ProviderRuntimeEvent);

      const emitSubagentTaskProgress = (input: {
        threadId: ThreadId;
        taskId: string;
        turnId?: TurnId;
        description: string;
        summary?: string;
        toolUseId?: string;
      }) =>
        emit({
          ...runtimeEventBase({
            threadId: input.threadId,
            ...(input.turnId ? { turnId: input.turnId } : {}),
          }),
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(input.taskId),
            description: input.description,
            ...(input.summary ? { summary: input.summary } : {}),
          },
          raw: {
            source: "shiori.hosted",
            method: "shiori/subagent/task_progress",
            payload: {
              task_id: input.taskId,
              ...(input.toolUseId ? { tool_use_id: input.toolUseId } : {}),
            },
          },
        } satisfies ProviderRuntimeEvent);

      const emitSubagentTaskCompleted = (input: {
        threadId: ThreadId;
        taskId: string;
        turnId?: TurnId;
        status: "completed" | "failed" | "stopped";
        summary?: string;
        toolUseId?: string;
      }) =>
        emit({
          ...runtimeEventBase({
            threadId: input.threadId,
            ...(input.turnId ? { turnId: input.turnId } : {}),
          }),
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(input.taskId),
            status: input.status,
            ...(input.summary ? { summary: input.summary } : {}),
          },
          raw: {
            source: "shiori.hosted",
            method: "shiori/subagent/task_completed",
            payload: {
              task_id: input.taskId,
              status: input.status,
              ...(input.toolUseId ? { tool_use_id: input.toolUseId } : {}),
            },
          },
        } satisfies ProviderRuntimeEvent);

      const waitForSubagents = Effect.fn("waitForSubagents")(function* (input: {
        threadId: ThreadId;
        targets: ReadonlyArray<string>;
        timeoutMs: number;
      }) {
        const normalizedTargets = Array.from(
          new Set(
            input.targets.map((target) => target.trim()).filter((target) => target.length > 0),
          ),
        );
        const deadline = Date.now() + input.timeoutMs;

        for (;;) {
          const context = yield* getContext(input.threadId);
          if (normalizedTargets.length === 0) {
            const statuses = Array.from(context.subagents.values()).map((state) =>
              subagentWaitSnapshot(state, state.taskName),
            );
            const hasTerminal = statuses.some((status) => isSubagentTerminalStatus(status.status));
            if (statuses.length === 0 || hasTerminal) {
              return {
                timeout: false,
                statuses,
              };
            }
          } else {
            const statuses = normalizedTargets.flatMap((target) => {
              const state = resolveSubagentTarget(context, target);
              if (!state) {
                return [];
              }
              return [subagentWaitSnapshot(state, target)];
            });
            if (
              statuses.length > 0 &&
              statuses.every((status) => isSubagentTerminalStatus(status.status))
            ) {
              return {
                timeout: false,
                statuses,
              };
            }
          }

          if (Date.now() >= deadline) {
            const context = yield* getContext(input.threadId);
            const statuses =
              normalizedTargets.length === 0
                ? Array.from(context.subagents.values()).map((state) =>
                    subagentWaitSnapshot(state, state.taskName),
                  )
                : normalizedTargets.flatMap((target) => {
                    const state = resolveSubagentTarget(context, target);
                    return state ? [subagentWaitSnapshot(state, target)] : [];
                  });
            return {
              timeout: true,
              statuses,
            };
          }

          yield* Effect.sleep("100 millis");
        }
      });

      const runSubagentHostedRequest = Effect.fn("runSubagentHostedRequest")(function* (input: {
        threadId: ThreadId;
        modelId: string;
        requestMessages: ReadonlyArray<HostedShioriMessage>;
        authToken: string;
        signal: AbortSignal;
      }) {
        const settings = yield* serverSettings.getSettings;
        const apiBaseUrl = resolveApiBaseUrl(settings.providers.shiori.apiBaseUrl);
        const sessionContext = yield* getContext(input.threadId);
        const hostedBootstrap = yield* resolveHostedBootstrapForContext({
          threadId: input.threadId,
          authToken: input.authToken,
        });
        const requestBody = JSON.stringify({
          sessionId: `${String(input.threadId)}:subagent`,
          turnId: crypto.randomUUID(),
          messages: input.requestMessages,
          model: {
            provider: PROVIDER,
            modelId: input.modelId,
          },
          workspaceContext: {
            rules: buildShioriWorkspaceRules({
              cwd: sessionContext.session.cwd,
              personality: settings.assistantPersonality,
              generateMemories: settings.generateMemories,
              skillPrompt: sessionContext.activeTurn?.skillPrompt,
              ...runtimePromptFeatureGates(hostedBootstrap),
            }),
          },
          tools: buildHostedToolDescriptors({
            ...sessionContext,
            interactionMode: "default",
            mcpToolDescriptors: sessionContext.activeTurn?.mcpToolDescriptors ?? [],
            hostedBootstrap,
          })
            .filter((descriptor) => descriptor.name !== "request_user_input")
            .map((descriptor) =>
              Object.assign(
                {
                  name: descriptor.name,
                  description: descriptor.description,
                  inputSchema: descriptor.inputSchema,
                },
                descriptor.title ? { title: descriptor.title } : {},
              ),
            ),
        });

        const response = yield* performHostedStreamFetch({
          method: "POST",
          apiBaseUrl,
          authToken: input.authToken,
          requestBody: Buffer.from(requestBody, "utf8"),
          signal: input.signal,
          logLabel: `shiori.subagent.start:${String(input.threadId)}`,
        });

        const reader = parseJsonEventStream({
          stream: boundStreamSize(response.body!, effectiveMaxStreamBytes),
          schema: uiMessageChunkSchema,
        }).getReader();

        let assistantText = "";
        let nextToolCall:
          | {
              toolCallId: string;
              toolName: string;
              toolInput: Record<string, unknown>;
            }
          | undefined;

        try {
          for (;;) {
            const next = yield* Effect.tryPromise({
              try: () => reader.read(),
              catch: (error) =>
                requestError(
                  `shiori.subagent.stream:${String(input.threadId)}`,
                  toMessage(error),
                  error,
                ),
            }).pipe(
              Effect.timeoutOrElse({
                duration: effectiveStreamReadTimeout,
                orElse: () =>
                  Effect.fail(
                    requestError(
                      `shiori.subagent.stream:${String(input.threadId)}`,
                      `Shiori subagent stream stalled for more than ${Duration.format(Duration.fromInputUnsafe(effectiveStreamReadTimeout))}; closing to recover.`,
                    ),
                  ),
              }),
            );
            if (next.done) {
              break;
            }
            if (!next.value.success) {
              return yield* Effect.fail(
                requestError(
                  `shiori.subagent.stream:${String(input.threadId)}`,
                  next.value.error.message,
                  next.value.error,
                ),
              );
            }

            const chunk = next.value.value as UIMessageChunk;
            switch (chunk.type) {
              case "text-delta":
                assistantText += chunk.delta;
                break;
              case "tool-input-available": {
                nextToolCall = {
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  toolInput:
                    chunk.input && typeof chunk.input === "object" && !Array.isArray(chunk.input)
                      ? (chunk.input as Record<string, unknown>)
                      : {},
                };
                break;
              }
              case "tool-input-error":
                return yield* Effect.fail(
                  requestError(
                    `shiori.subagent.stream:${String(input.threadId)}`,
                    `Invalid tool input for ${chunk.toolName}: ${chunk.errorText}`,
                  ),
                );
              case "error":
                return yield* Effect.fail(
                  requestError(
                    `shiori.subagent.stream:${String(input.threadId)}`,
                    normalizeHostedFailureDetail(
                      chunk.errorText,
                      "Shiori subagent stream emitted an error.",
                    ),
                  ),
                );
              default:
                break;
            }
          }
          return {
            assistantText,
            nextToolCall,
          };
        } finally {
          yield* Effect.tryPromise({
            try: () => reader.cancel(),
            catch: (error) =>
              requestError(
                `shiori.subagent.stream:${String(input.threadId)}`,
                toMessage(error),
                error,
              ),
          }).pipe(
            Effect.catch((error) =>
              Effect.logDebug("shiori subagent reader cancel failed", {
                threadId: input.threadId,
                detail: toMessage(error),
              }),
            ),
          );
        }
      });

      const runSubagentInput = Effect.fn("runSubagentInput")(function* (input: {
        threadId: ThreadId;
        subagentId: string;
        parentTurnId?: TurnId;
        modelId: string;
        signal: AbortSignal;
      }) {
        const context = yield* getContext(input.threadId);
        const subagent = context.subagents.get(input.subagentId);
        if (!subagent) {
          return yield* Effect.fail(
            requestError(
              "shiori.subagent.run",
              `Unknown subagent '${input.subagentId}' for thread '${String(input.threadId)}'.`,
            ),
          );
        }

        const queuedInput = subagent.queuedInputs[0];
        if (!queuedInput) {
          return {
            state: "idle" as const,
          };
        }

        const authToken = yield* hostedAuthTokenStore.getToken;
        if (!isExpectedHostedShioriAuthToken(authToken)) {
          return yield* Effect.fail(
            requestError(
              "shiori.subagent.run",
              "Shiori account token is unavailable or invalid. Sign out and sign back in to continue.",
            ),
          );
        }

        const startUserMessage: HostedShioriMessage = {
          id: `subagent-user-${crypto.randomUUID()}`,
          role: "user",
          parts: [
            {
              type: "text",
              text: queuedInput.prompt,
            },
          ],
        };
        let requestMessages: HostedShioriMessage[] = trimHostedMessageHistory([
          ...subagent.history,
          startUserMessage,
        ]);
        let rounds = 0;

        for (;;) {
          if (input.signal.aborted) {
            return yield* Effect.fail(requestError("shiori.subagent.run", "Interrupted"));
          }
          if (rounds >= MAX_SUBAGENT_TOOL_ROUNDS) {
            return yield* Effect.fail(
              requestError(
                "shiori.subagent.run",
                `Subagent exceeded maximum tool rounds (${MAX_SUBAGENT_TOOL_ROUNDS}).`,
              ),
            );
          }

          const step = yield* runSubagentHostedRequest({
            threadId: input.threadId,
            modelId: input.modelId,
            requestMessages,
            authToken,
            signal: input.signal,
          });

          const assistantPrefixText = step.assistantText.trim();
          if (!step.nextToolCall) {
            const assistantMessage = assistantMessageWithParts({
              messageId: `subagent-assistant-${crypto.randomUUID()}`,
              text: assistantPrefixText,
            });
            const nextHistory = hasMessageParts(assistantMessage)
              ? trimHostedMessageHistory([...requestMessages, assistantMessage])
              : trimHostedMessageHistory(requestMessages);
            return {
              state: "completed" as const,
              history: nextHistory,
              summary:
                normalizeSubagentSummary(assistantPrefixText) ??
                normalizeSubagentSummary(extractAssistantTextFromMessage(nextHistory.at(-1))) ??
                "Delegated task completed.",
            };
          }

          rounds += 1;
          const execution = yield* executeSubagentToolForTurn({
            threadId: input.threadId,
            ...(input.parentTurnId ? { turnId: input.parentTurnId } : {}),
            toolCallId: step.nextToolCall.toolCallId,
            toolName: step.nextToolCall.toolName,
            toolInput: step.nextToolCall.toolInput,
            selectedModel: input.modelId,
            hostedBootstrap: yield* resolveHostedBootstrapForContext({
              threadId: input.threadId,
              authToken,
            }),
            signal: input.signal,
          });
          const assistantMessage = assistantToolMessage({
            messageId: `subagent-tool-${crypto.randomUUID()}`,
            text: assistantPrefixText,
            toolName: step.nextToolCall.toolName,
            toolCallId: step.nextToolCall.toolCallId,
            toolInput: step.nextToolCall.toolInput,
            state: execution.state,
            ...(execution.state === "output-available"
              ? { output: execution.output }
              : { errorText: execution.errorText }),
          });
          requestMessages = trimHostedMessageHistory([...requestMessages, assistantMessage]);
        }
      });

      const runSubagentRunner = Effect.fn("runSubagentRunner")(function* (input: {
        threadId: ThreadId;
        subagentId: string;
      }) {
        for (;;) {
          const contextResult = yield* Effect.result(getContext(input.threadId));
          if (contextResult._tag === "Failure") {
            return;
          }
          const context = contextResult.success;
          const state = context.subagents.get(input.subagentId);
          if (!state) {
            return;
          }
          if (state.status === "shutdown") {
            yield* updateContextAndPersist(input.threadId, (current) => {
              const currentState = current.subagents.get(input.subagentId);
              if (!currentState) {
                return current;
              }
              const nextSubagents = new Map(current.subagents);
              nextSubagents.set(input.subagentId, {
                ...currentState,
                runnerActive: false,
                currentRun: undefined,
                updatedAt: nowIso(),
              });
              return {
                ...current,
                subagents: nextSubagents,
              };
            });
            return;
          }

          if (state.queuedInputs.length === 0) {
            yield* updateContextAndPersist(input.threadId, (current) => {
              const currentState = current.subagents.get(input.subagentId);
              if (!currentState) {
                return current;
              }
              const nextSubagents = new Map(current.subagents);
              nextSubagents.set(input.subagentId, {
                ...currentState,
                runnerActive: false,
                currentRun: undefined,
                status: isSubagentTerminalStatus(currentState.status)
                  ? currentState.status
                  : "completed",
                updatedAt: nowIso(),
              });
              return {
                ...current,
                subagents: nextSubagents,
              };
            });
            return;
          }

          const runController = new AbortController();
          const nextInput = state.queuedInputs[0];
          const queuedSummary = normalizeSubagentSummary(nextInput?.prompt);
          yield* updateContextAndPersist(input.threadId, (current) => {
            const currentState = current.subagents.get(input.subagentId);
            if (!currentState || currentState.queuedInputs.length === 0) {
              return current;
            }
            const nextSubagents = new Map(current.subagents);
            nextSubagents.set(input.subagentId, {
              ...currentState,
              status: "running",
              currentRun: {
                inputId: currentState.queuedInputs[0]!.id,
                controller: runController,
              },
              updatedAt: nowIso(),
            });
            return {
              ...current,
              subagents: nextSubagents,
            };
          });

          yield* emitSubagentTaskProgress({
            threadId: input.threadId,
            taskId: state.id,
            ...(state.parentTurnId ? { turnId: state.parentTurnId } : {}),
            description: "Running delegated task",
            ...(queuedSummary ? { summary: queuedSummary } : {}),
            ...(state.parentToolUseId ? { toolUseId: state.parentToolUseId } : {}),
          });

          const attempt = yield* Effect.result(
            runSubagentInput({
              threadId: input.threadId,
              subagentId: input.subagentId,
              ...(state.parentTurnId ? { parentTurnId: state.parentTurnId } : {}),
              modelId: state.modelId,
              signal: runController.signal,
            }),
          );

          if (attempt._tag === "Failure") {
            const detail = toMessage(attempt.failure);
            const aborted = runController.signal.aborted;
            const updatedAt = nowIso();
            yield* updateContextAndPersist(input.threadId, (current) => {
              const currentState = current.subagents.get(input.subagentId);
              if (!currentState) {
                return current;
              }
              const nextSubagents = new Map(current.subagents);
              nextSubagents.set(input.subagentId, {
                ...currentState,
                runnerActive: false,
                currentRun: undefined,
                status: aborted ? "shutdown" : "failed",
                lastError: detail,
                updatedAt,
              });
              return {
                ...current,
                subagents: nextSubagents,
              };
            });

            if (!aborted) {
              yield* emitSubagentTaskCompleted({
                threadId: input.threadId,
                taskId: state.id,
                ...(state.parentTurnId ? { turnId: state.parentTurnId } : {}),
                status: "failed",
                summary: detail,
                ...(state.parentToolUseId ? { toolUseId: state.parentToolUseId } : {}),
              });
              yield* appendSubagentNotification({
                threadId: input.threadId,
                agentPath: state.taskName,
                status: "failed",
                summary: detail,
              });
            }
            return;
          }

          if (attempt.success.state === "idle") {
            continue;
          }

          const completedAttempt = attempt.success;
          if (completedAttempt.state !== "completed") {
            continue;
          }

          const runSummary = normalizeSubagentSummary(completedAttempt.summary);
          let queuedInputCount = 0;
          yield* updateContextAndPersist(input.threadId, (current) => {
            const currentState = current.subagents.get(input.subagentId);
            if (!currentState) {
              return current;
            }
            const remainingQueue = currentState.queuedInputs.slice(1);
            queuedInputCount = remainingQueue.length;
            const { lastError: _lastError, ...stateWithoutLastError } = currentState;
            const nextSubagents = new Map(current.subagents);
            nextSubagents.set(input.subagentId, {
              ...stateWithoutLastError,
              history: completedAttempt.history,
              queuedInputs: remainingQueue,
              currentRun: undefined,
              status: remainingQueue.length === 0 ? "completed" : "running",
              ...(runSummary ? { lastSummary: runSummary } : {}),
              runnerActive: remainingQueue.length > 0,
              updatedAt: nowIso(),
            });
            return {
              ...current,
              subagents: nextSubagents,
            };
          });

          if (queuedInputCount > 0) {
            yield* emitSubagentTaskProgress({
              threadId: input.threadId,
              taskId: state.id,
              ...(state.parentTurnId ? { turnId: state.parentTurnId } : {}),
              description: "Delegated task progressing",
              ...(runSummary ? { summary: runSummary } : {}),
              ...(state.parentToolUseId ? { toolUseId: state.parentToolUseId } : {}),
            });
            continue;
          }

          yield* emitSubagentTaskCompleted({
            threadId: input.threadId,
            taskId: state.id,
            ...(state.parentTurnId ? { turnId: state.parentTurnId } : {}),
            status: "completed",
            ...(runSummary ? { summary: runSummary } : {}),
            ...(state.parentToolUseId ? { toolUseId: state.parentToolUseId } : {}),
          });
          yield* appendSubagentNotification({
            threadId: input.threadId,
            agentPath: state.taskName,
            status: "completed",
            ...(runSummary ? { summary: runSummary } : {}),
          });
          return;
        }
      });

      const ensureSubagentRunner = (threadId: ThreadId, subagentId: string) =>
        Effect.gen(function* () {
          const updatedContext = yield* updateContextAndPersist(threadId, (context) => {
            const state = context.subagents.get(subagentId);
            if (
              !state ||
              state.runnerActive ||
              state.status === "shutdown" ||
              state.queuedInputs.length === 0
            ) {
              return context;
            }
            const nextSubagents = new Map(context.subagents);
            nextSubagents.set(subagentId, {
              ...state,
              runnerActive: true,
              status:
                state.status === "pending_init" ||
                state.status === "completed" ||
                state.status === "failed"
                  ? "running"
                  : state.status,
              updatedAt: nowIso(),
            });
            return {
              ...context,
              subagents: nextSubagents,
            };
          });
          const updatedState = updatedContext.subagents.get(subagentId);
          const shouldStart =
            updatedState !== undefined &&
            updatedState.runnerActive &&
            updatedState.status !== "shutdown" &&
            updatedState.queuedInputs.length > 0;
          if (!shouldStart) {
            return;
          }
          void Effect.runFork(
            runSubagentRunner({
              threadId,
              subagentId,
            }),
          );
        });

      const executeSubagentToolForTurn = Effect.fn("executeSubagentToolForTurn")(function* (input: {
        threadId: ThreadId;
        turnId?: TurnId;
        toolCallId: string;
        toolName: string;
        toolInput: Record<string, unknown>;
        selectedModel: string;
        hostedBootstrap: ShioriCodeBootstrapConfig | null | undefined;
        signal?: AbortSignal;
      }) {
        const toolName = input.toolName;
        if (
          isSubagentToolName(toolName) &&
          !canUseHostedSubagentTool(input.hostedBootstrap, toolName)
        ) {
          return {
            state: "output-error" as const,
            errorText: `Tool '${toolName}' is disabled by the hosted ShioriCode policy.`,
          };
        }
        if (toolName === "update_plan") {
          return {
            state: "output-available" as const,
            output: { ok: true },
          };
        }
        if (isUserInputToolName(toolName)) {
          return {
            state: "output-error" as const,
            errorText: "User input tools are unavailable inside subagents.",
          };
        }

        if (toolName === "wait_agent") {
          const targetList = Array.isArray(input.toolInput.targets)
            ? input.toolInput.targets.flatMap((target) =>
                typeof target === "string" ? [target] : [],
              )
            : typeof input.toolInput.target === "string"
              ? [input.toolInput.target]
              : [];
          if (targetList.length > 0) {
            const context = yield* getContext(input.threadId);
            const missingTargets = targetList.filter(
              (target) => resolveSubagentTarget(context, target) === null,
            );
            if (missingTargets.length > 0) {
              return {
                state: "output-error" as const,
                errorText: `Unknown subagent target(s): ${missingTargets.join(", ")}`,
              };
            }
          }
          const timeoutMs = clampSubagentWaitTimeout(input.toolInput.timeout_ms);
          const waitResult = yield* waitForSubagents({
            threadId: input.threadId,
            targets: targetList,
            timeoutMs,
          });
          return {
            state: "output-available" as const,
            output: {
              timeout: waitResult.timeout,
              statuses: waitResult.statuses,
            },
          };
        }

        if (toolName === "close_agent") {
          const context = yield* getContext(input.threadId);
          const targetValue =
            typeof input.toolInput.target === "string" ? input.toolInput.target : "";
          const state = resolveSubagentTarget(context, targetValue);
          if (!state) {
            return {
              state: "output-error" as const,
              errorText: `Unknown subagent target '${targetValue}'.`,
            };
          }
          state.currentRun?.controller.abort();
          yield* updateContextAndPersist(input.threadId, (current) => {
            const currentState = current.subagents.get(state.id);
            if (!currentState) {
              return current;
            }
            const nextSubagents = new Map(current.subagents);
            nextSubagents.delete(state.id);
            return {
              ...current,
              subagents: nextSubagents,
            };
          });
          yield* emitSubagentTaskCompleted({
            threadId: input.threadId,
            taskId: state.id,
            ...(state.parentTurnId ? { turnId: state.parentTurnId } : {}),
            status: "stopped",
            summary: "Subagent closed by parent.",
            ...(state.parentToolUseId ? { toolUseId: state.parentToolUseId } : {}),
          });
          yield* appendSubagentNotification({
            threadId: input.threadId,
            agentPath: state.taskName,
            status: "shutdown",
            summary: "Subagent closed by parent.",
          });
          return {
            state: "output-available" as const,
            output: {
              closed: true,
              id: state.id,
              task_name: state.taskName,
              status: "shutdown",
            },
          };
        }

        if (toolName === "send_input" || toolName === "send_message") {
          const context = yield* getContext(input.threadId);
          const targetValue =
            typeof input.toolInput.target === "string"
              ? input.toolInput.target
              : typeof input.toolInput.to === "string"
                ? input.toolInput.to
                : "";
          const message =
            typeof input.toolInput.message === "string" ? input.toolInput.message.trim() : "";
          const state = resolveSubagentTarget(context, targetValue);
          if (!state) {
            return {
              state: "output-error" as const,
              errorText: `Unknown subagent target '${targetValue}'.`,
            };
          }
          if (message.length === 0) {
            return {
              state: "output-error" as const,
              errorText: "Subagent message must be a non-empty string.",
            };
          }

          const queuedInput: ShioriSubagentQueuedInput = {
            id: crypto.randomUUID(),
            prompt: message,
            submittedAt: nowIso(),
          };

          // Atomically check the subagent status and queue the input in a single CAS
          // so a concurrent close_agent cannot slip in between the status check and
          // the write.
          const enqueueOutcome = yield* Ref.modify(sessionsRef, (sessions) => {
            const existing = sessions.get(String(input.threadId));
            if (!existing) {
              return ["missing" as const, sessions];
            }
            const currentState = existing.subagents.get(state.id);
            if (!currentState) {
              return ["missing" as const, sessions];
            }
            if (currentState.status === "shutdown") {
              return ["shutdown" as const, sessions];
            }
            const nextSubagents = new Map(existing.subagents);
            nextSubagents.set(state.id, {
              ...currentState,
              queuedInputs: [...currentState.queuedInputs, queuedInput],
              status:
                currentState.status === "failed" || currentState.status === "completed"
                  ? "running"
                  : currentState.status,
              updatedAt: nowIso(),
            });
            const nextSessions = new Map(sessions);
            nextSessions.set(String(input.threadId), {
              ...existing,
              subagents: nextSubagents,
            });
            return ["queued" as const, nextSessions];
          });

          if (enqueueOutcome === "shutdown") {
            return {
              state: "output-error" as const,
              errorText: `Subagent '${state.taskName}' is closed and cannot accept new input.`,
            };
          }
          if (enqueueOutcome === "missing") {
            return {
              state: "output-error" as const,
              errorText: `Unknown subagent target '${targetValue}'.`,
            };
          }

          // Persist after the atomic state update lands.
          const updatedContext = yield* getContext(input.threadId);
          yield* persistContext(updatedContext);
          yield* ensureSubagentRunner(input.threadId, state.id);
          return {
            state: "output-available" as const,
            output: {
              accepted: true,
              id: state.id,
              task_name: state.taskName,
              queued: true,
            },
          };
        }

        if (toolName === "spawn_agent" || toolName === "agent") {
          const context = yield* getContext(input.threadId);
          const now = nowIso();
          const prompt =
            toolName === "agent"
              ? typeof input.toolInput.prompt === "string"
                ? input.toolInput.prompt.trim()
                : ""
              : typeof input.toolInput.message === "string"
                ? input.toolInput.message.trim()
                : "";
          if (prompt.length === 0) {
            return {
              state: "output-error" as const,
              errorText: "Subagent prompt must be a non-empty string.",
            };
          }

          const description =
            toolName === "agent"
              ? typeof input.toolInput.description === "string" &&
                input.toolInput.description.trim().length > 0
                ? input.toolInput.description.trim()
                : "Delegated task"
              : prompt;
          const preferredTaskName =
            toolName === "agent"
              ? (input.toolInput.name ?? description)
              : (input.toolInput.task_name ?? description);
          const taskName = allocateSubagentTaskName(context, preferredTaskName);
          const state: ShioriSubagentState = {
            id: `task-${crypto.randomUUID()}`,
            taskName,
            nickname:
              typeof input.toolInput.agent_type === "string"
                ? input.toolInput.agent_type
                : typeof input.toolInput.subagent_type === "string"
                  ? input.toolInput.subagent_type
                  : null,
            toolStyle: toolName === "agent" ? "claude" : "codex",
            description,
            subagentType:
              typeof input.toolInput.subagent_type === "string"
                ? input.toolInput.subagent_type
                : typeof input.toolInput.agent_type === "string"
                  ? input.toolInput.agent_type
                  : null,
            modelId: input.selectedModel,
            status: "pending_init",
            queuedInputs: [
              {
                id: crypto.randomUUID(),
                prompt,
                submittedAt: now,
              },
            ],
            history: [],
            runnerActive: false,
            terminalSequence: 0,
            createdAt: now,
            updatedAt: now,
            ...(input.turnId ? { parentTurnId: input.turnId } : {}),
            parentToolUseId: input.toolCallId,
          };
          yield* updateContextAndPersist(input.threadId, (current) => ({
            ...current,
            subagentSequence: current.subagentSequence + 1,
            subagents: new Map(current.subagents).set(state.id, state),
          }));
          const startedDescription = normalizeSubagentSummary(description);
          yield* emitSubagentTaskStarted({
            threadId: input.threadId,
            taskId: state.id,
            ...(state.parentTurnId ? { turnId: state.parentTurnId } : {}),
            ...(startedDescription ? { description: startedDescription } : {}),
            taskType: state.subagentType ?? state.toolStyle,
            ...(state.parentToolUseId ? { toolUseId: state.parentToolUseId } : {}),
          });
          yield* ensureSubagentRunner(input.threadId, state.id);

          if (toolName === "agent" && input.toolInput.run_in_background === false) {
            const waited = yield* waitForSubagents({
              threadId: input.threadId,
              targets: [state.id],
              timeoutMs: clampSubagentWaitTimeout(input.toolInput.timeout_ms),
            });
            const status = waited.statuses[0];
            return {
              state: "output-available" as const,
              output: {
                task_id: state.id,
                name: state.taskName,
                run_in_background: false,
                ...(status ? { result: status } : {}),
              },
            };
          }

          return {
            state: "output-available" as const,
            output:
              toolName === "agent"
                ? {
                    task_id: state.id,
                    name: state.taskName,
                    run_in_background: true,
                  }
                : {
                    id: state.id,
                    task_name: state.taskName,
                    status: state.status,
                  },
          };
        }

        const context = yield* getContext(input.threadId);
        const requestKind = toolRequestKind(toolName);
        const mcpDescriptor = context.activeTurn?.mcpToolDescriptors.find(
          (descriptor) => descriptor.name === toolName,
        );
        const mcpDescriptorRequestKind = mcpDescriptor
          ? hostedDescriptorRequestKindFromSchema(mcpDescriptor.inputSchema)
          : undefined;
        const mcpDescriptorNeedsApproval =
          mcpDescriptor?.inputSchema["x-shioricode-needs-approval"] === true;
        const effectiveRequestKind =
          requestKind ??
          (mcpDescriptorNeedsApproval
            ? (approvalRequestKindForHostedDescriptor(mcpDescriptorRequestKind) ?? "command")
            : undefined);
        if (
          (effectiveRequestKind !== undefined &&
            isHostedApprovalRequired({
              toolName,
              requestKind: effectiveRequestKind,
              runtimeMode: context.session.runtimeMode,
              allowedRequestKinds: context.allowedRequestKinds,
              bootstrap: context.activeTurn?.hostedBootstrap,
            })) ||
          mcpDescriptorNeedsApproval
        ) {
          return {
            state: "output-error" as const,
            errorText: `Tool '${toolName}' requires explicit user approval in the current runtime mode.`,
          };
        }
        return yield* executeLocalToolForTurn({
          toolName,
          toolInput: input.toolInput,
          cwd: context.session.cwd,
          hostedBootstrap: context.activeTurn?.hostedBootstrap,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      });

      const executeLocalToolForTurn = Effect.fn("executeLocalToolForTurn")(function* (input: {
        toolName: string;
        toolInput: Record<string, unknown>;
        cwd: string | undefined;
        hostedBootstrap: ShioriCodeBootstrapConfig | null | undefined;
        signal?: AbortSignal;
      }) {
        const execution = yield* Effect.result(executeLocalTool(input));
        if (execution._tag === "Success") {
          return {
            state: "output-available" as const,
            output: execution.success,
          };
        }
        if (input.signal?.aborted) {
          return yield* execution.failure;
        }
        return {
          state: "output-error" as const,
          errorText: Schema.is(ProviderAdapterRequestError)(execution.failure)
            ? execution.failure.detail
            : toMessage(execution.failure),
        };
      });

      const executeLocalTool = Effect.fn("executeLocalTool")(function* (input: {
        toolName: string;
        toolInput: Record<string, unknown>;
        cwd: string | undefined;
        hostedBootstrap: ShioriCodeBootstrapConfig | null | undefined;
        signal?: AbortSignal;
      }) {
        switch (input.toolName) {
          case "list_directory": {
            const cwd = input.cwd?.trim();
            if (!cwd) {
              return yield* requestError(
                `shiori.tool.${input.toolName}`,
                "A workspace root is required to list a directory.",
              );
            }
            const relativePath =
              typeof input.toolInput.path === "string" && input.toolInput.path.trim().length > 0
                ? input.toolInput.path.trim()
                : ".";
            const result = yield* workspaceEntries
              .listDirectory({ cwd, relativePath })
              .pipe(
                Effect.mapError((error) =>
                  requestError(`shiori.tool.${input.toolName}`, "Failed to list directory.", error),
                ),
              );
            return {
              path: result.directoryPath,
              entries: result.entries.map((entry) => ({
                name: path.posix.basename(entry.path),
                kind: entry.kind,
                path: entry.path,
              })),
              truncated: result.truncated,
            };
          }
          case "read_file": {
            const resolvedPath = yield* Effect.try({
              try: () => resolveWorkspacePath(input.cwd, input.toolInput.path),
              catch: (error) =>
                requestError(`shiori.tool.${input.toolName}`, toMessage(error), error),
            });
            yield* Effect.try({
              try: () =>
                assertWorkspacePathAllowed({
                  rootCwd: input.cwd,
                  resolvedPath,
                  bootstrap: input.hostedBootstrap,
                  toolName: input.toolName,
                }),
              catch: (error) =>
                requestError(`shiori.tool.${input.toolName}`, toMessage(error), error),
            });
            const content = yield* Effect.tryPromise({
              try: () => readFile(resolvedPath, "utf8"),
              catch: (error) =>
                requestError(`shiori.tool.${input.toolName}`, "Failed to read file.", error),
            });
            return {
              path: path.relative(input.cwd ?? process.cwd(), resolvedPath),
              content: truncateToolText(content, MAX_TOOL_FILE_CHARS),
            };
          }
          case "write_file": {
            const resolvedPath = yield* Effect.try({
              try: () => resolveWorkspacePath(input.cwd, input.toolInput.path),
              catch: (error) =>
                requestError(`shiori.tool.${input.toolName}`, toMessage(error), error),
            });
            const content =
              typeof input.toolInput.content === "string" ? input.toolInput.content : "";
            yield* Effect.try({
              try: () =>
                assertWorkspacePathAllowed({
                  rootCwd: input.cwd,
                  resolvedPath,
                  bootstrap: input.hostedBootstrap,
                  toolName: input.toolName,
                }),
              catch: (error) =>
                requestError(`shiori.tool.${input.toolName}`, toMessage(error), error),
            });
            yield* Effect.tryPromise({
              try: async () => {
                await mkdir(path.dirname(resolvedPath), { recursive: true });
                await writeFile(resolvedPath, content, "utf8");
              },
              catch: (error) =>
                requestError(`shiori.tool.${input.toolName}`, "Failed to write file.", error),
            });
            return {
              path: path.relative(input.cwd ?? process.cwd(), resolvedPath),
              bytesWritten: Buffer.byteLength(content),
            };
          }
          case "edit":
          case "apply_patch": {
            const patchText =
              typeof input.toolInput.patch === "string" ? input.toolInput.patch : "";
            yield* Effect.try({
              try: () => {
                for (const targetPath of extractPatchTargetPaths(patchText)) {
                  const resolvedPath = resolveWorkspacePath(input.cwd, targetPath);
                  assertWorkspacePathAllowed({
                    rootCwd: input.cwd,
                    resolvedPath,
                    bootstrap: input.hostedBootstrap,
                    toolName: input.toolName,
                  });
                }
              },
              catch: (error) =>
                requestError(`shiori.tool.${input.toolName}`, toMessage(error), error),
            });
            const result = yield* Effect.tryPromise({
              try: () =>
                isCodexApplyPatch(patchText)
                  ? applyCodexApplyPatch(patchText, input.cwd ?? process.cwd())
                  : applyUnifiedPatch(patchText, input.cwd ?? process.cwd(), input.signal),
              catch: (error) =>
                requestError(`shiori.tool.${input.toolName}`, "Failed to apply patch.", error),
            });
            if (result.exitCode !== 0) {
              return yield* requestError(
                `shiori.tool.${input.toolName}`,
                result.stderr.trim() || "git apply failed.",
              );
            }
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
            };
          }
          case "exec_command": {
            const command =
              typeof input.toolInput.command === "string" ? input.toolInput.command : "";
            const result = yield* Effect.tryPromise({
              try: () =>
                execShellCommand(
                  command,
                  input.cwd ?? process.cwd(),
                  input.signal,
                  effectiveLocalToolCommandTimeoutMs,
                ),
              catch: (error) =>
                requestError(`shiori.tool.${input.toolName}`, "Failed to run command.", error),
            });
            return sanitizeToolOutput(input.toolName, result);
          }
          case "web_search":
            return yield* Effect.tryPromise({
              try: () =>
                executeShioriWebSearch({
                  toolInput: input.toolInput,
                  ...(input.signal ? { signal: input.signal } : {}),
                }),
              catch: (error) =>
                requestError(`shiori.tool.${input.toolName}`, "Failed to search the web.", error),
            });
          default:
            return yield* requestError(
              `shiori.tool.${input.toolName}`,
              `Unsupported Shiori tool '${input.toolName}'.`,
            );
        }
      });

      const _replaceMessageInContext = (
        threadId: ThreadId,
        messageId: string,
        nextMessage: HostedShioriMessage,
      ) =>
        Effect.gen(function* () {
          const context = yield* getContext(threadId);
          const nextMessages = context.messages.map((message) =>
            message.id === messageId ? nextMessage : message,
          );
          const nextContext = withResumeCursor({
            ...context,
            messages: nextMessages,
          });
          yield* setContext(threadId, nextContext);
          yield* persistContext(nextContext);
          return nextContext;
        });

      const replaceToolPartInContext = (input: {
        threadId: ThreadId;
        messageId: string;
        toolCallId: string;
        nextToolPart: HostedShioriMessage["parts"][number];
        dropApprovalRequestId?: ApprovalRequestId;
        dropUserInputRequestId?: ApprovalRequestId;
      }) =>
        Effect.gen(function* () {
          const context = yield* getContext(input.threadId);
          const nextMessages = context.messages.map((message) =>
            message.id === input.messageId
              ? replaceToolPartInMessage({
                  message,
                  toolCallId: input.toolCallId,
                  nextToolPart: input.nextToolPart,
                })
              : message,
          );
          const nextPendingApprovals = new Map(context.pendingApprovals);
          const nextPendingUserInputs = new Map(context.pendingUserInputs);
          if (input.dropApprovalRequestId) {
            nextPendingApprovals.delete(input.dropApprovalRequestId);
          }
          if (input.dropUserInputRequestId) {
            nextPendingUserInputs.delete(input.dropUserInputRequestId);
          }
          const nextContext = withResumeCursor({
            ...context,
            messages: nextMessages,
            pendingApprovals: nextPendingApprovals,
            pendingUserInputs: nextPendingUserInputs,
          });
          yield* setContext(input.threadId, nextContext);
          yield* persistContext(nextContext);
          return nextContext;
        });

      const runHostedTurn: (input: {
        context: ShioriSessionContext;
        turnId: TurnId;
        requestMessages: HostedShioriMessage[];
        selectedModel: string;
        authToken: string;
        controller: AbortController;
        assistantItemId: RuntimeItemId;
        resumeExistingTurn?: boolean;
      }) => Effect.Effect<void, any> = Effect.fn("runHostedTurn")(function* (input) {
        const settings = yield* serverSettings.getSettings;
        const apiBaseUrl = resolveApiBaseUrl(settings.providers.shiori.apiBaseUrl);
        const interactionMode = input.context.activeTurn?.interactionMode ?? "default";
        const hostedBootstrap =
          input.context.activeTurn?.hostedBootstrap ??
          (yield* resolveHostedBootstrapForContext({
            threadId: input.context.session.threadId,
            authToken: input.authToken,
          }));
        const tools = buildHostedToolDescriptors({
          ...input.context,
          interactionMode,
          mcpToolDescriptors: input.context.activeTurn?.mcpToolDescriptors ?? [],
          hostedBootstrap,
        }).map((descriptor) =>
          Object.assign(
            {
              name: descriptor.name,
              description: descriptor.description,
              inputSchema: descriptor.inputSchema,
            },
            descriptor.title ? { title: descriptor.title } : {},
          ),
        );
        const modelSettings = input.context.activeTurn?.modelSettings;
        const requestBody = JSON.stringify({
          sessionId: String(input.context.session.threadId),
          turnId: input.turnId,
          messages: input.requestMessages,
          model: {
            provider: PROVIDER,
            modelId: input.selectedModel,
            ...(modelSettings ? { settings: modelSettings } : {}),
          },
          workspaceContext: {
            rules: buildShioriWorkspaceRules({
              cwd: input.context.session.cwd,
              personality: settings.assistantPersonality,
              generateMemories: settings.generateMemories,
              interactionMode,
              skillPrompt: input.context.activeTurn?.skillPrompt,
              ...runtimePromptFeatureGates(hostedBootstrap),
            }),
          },
          tools,
        });
        yield* Effect.logInfo("shiori turn request starting", {
          threadId: input.context.session.threadId,
          turnId: input.turnId,
          apiBaseUrl,
          model: input.selectedModel,
          messageCount: input.requestMessages.length,
          toolCount: tools.length,
          requestBodyBytes: Buffer.byteLength(requestBody),
          token: describeToken(input.authToken),
        });
        if (input.resumeExistingTurn !== true) {
          yield* emit({
            ...runtimeEventBase({
              threadId: input.context.session.threadId,
              turnId: input.turnId,
            }),
            type: "turn.started",
            payload: {
              model: input.selectedModel,
            },
          } satisfies ProviderRuntimeEvent);
        }
        const response = yield* performHostedStreamFetch({
          method: "POST",
          apiBaseUrl,
          authToken: input.authToken,
          requestBody: Buffer.from(requestBody, "utf8"),
          signal: input.controller.signal,
          logLabel: `shiori.turn.start:${String(input.context.session.threadId)}`,
        });

        yield* Effect.logInfo("shiori turn request accepted", {
          threadId: input.context.session.threadId,
          turnId: input.turnId,
          status: response.status,
        });

        const reader = parseJsonEventStream({
          stream: boundStreamSize(response.body!, effectiveMaxStreamBytes),
          schema: uiMessageChunkSchema,
        }).getReader();

        let assistantText = "";
        let assistantTextProbeActive = false;
        let assistantTextEmittedLength = 0;
        let assistantCompletionText = input.context.activeTurn?.assistantText ?? "";
        let assistantFinalText = input.context.activeTurn?.assistantFinalText ?? "";
        let assistantActiveItemId = input.context.activeTurn?.assistantActiveItemId ?? null;
        let assistantStarted = input.context.activeTurn?.assistantStarted ?? false;
        let persistedMessages = input.requestMessages;
        const pendingToolInputAvailableChunks: Array<
          Extract<UIMessageChunk, { type: "tool-input-available" }>
        > = [];
        const ignoredToolCallIds = new Set<string>();
        const hostedToolExecutions = new Map<
          string,
          | {
              state: "output-available";
              output: unknown;
              resultProviderMetadata?: unknown;
            }
          | {
              state: "output-error";
              errorText: string;
              resultProviderMetadata?: unknown;
            }
          | {
              state: "output-denied";
            }
        >();

        const syncAssistantStreamingState = () => {
          if (!input.context.activeTurn) {
            return;
          }
          input.context.activeTurn.assistantStarted = assistantStarted;
          input.context.activeTurn.assistantActiveItemId =
            assistantStarted && assistantActiveItemId ? assistantActiveItemId : null;
        };

        const flushVisibleAssistantSegment = Effect.fn("flushVisibleAssistantSegment")(function* (
          segmentText: string,
        ) {
          if (interactionMode === "plan" || segmentText.length === 0 || !assistantActiveItemId) {
            return;
          }
          if (!assistantStarted) {
            assistantStarted = true;
            syncAssistantStreamingState();
            yield* emit({
              ...runtimeEventBase({
                threadId: input.context.session.threadId,
                turnId: input.turnId,
                itemId: assistantActiveItemId,
              }),
              type: "item.started",
              payload: {
                itemType: "assistant_message",
                status: "inProgress",
                title: "Assistant message",
              },
            } satisfies ProviderRuntimeEvent);
          }
          assistantCompletionText += segmentText;
          assistantFinalText += segmentText;
          if (input.context.activeTurn) {
            input.context.activeTurn.assistantText = assistantCompletionText;
            input.context.activeTurn.assistantFinalText = assistantFinalText;
          }
          yield* emit({
            ...runtimeEventBase({
              threadId: input.context.session.threadId,
              turnId: input.turnId,
              itemId: assistantActiveItemId,
            }),
            type: "content.delta",
            payload: {
              streamKind: "assistant_text",
              delta: segmentText,
            },
          } satisfies ProviderRuntimeEvent);
        });

        const flushPendingAssistantText = Effect.fn("flushPendingAssistantText")(function* () {
          const pendingText = assistantText.slice(assistantTextEmittedLength);
          if (pendingText.length === 0) {
            return;
          }
          yield* flushVisibleAssistantSegment(pendingText);
          assistantTextEmittedLength = assistantText.length;
        });

        const resetAssistantTextBlock = () => {
          assistantText = "";
          assistantTextProbeActive = false;
          assistantTextEmittedLength = 0;
          assistantActiveItemId = null;
          assistantStarted = false;
          syncAssistantStreamingState();
        };

        const startAssistantTextBlock = (blockId: string) => {
          assistantText = "";
          assistantTextProbeActive = interactionMode !== "plan";
          assistantTextEmittedLength = 0;
          assistantActiveItemId = assistantTextItemId(input.turnId, blockId);
          assistantStarted = false;
          syncAssistantStreamingState();
        };

        const completeAssistantTextBlock = Effect.fn("completeAssistantTextBlock")(function* () {
          if (interactionMode === "plan" || !assistantStarted || !assistantActiveItemId) {
            resetAssistantTextBlock();
            return;
          }

          yield* emit(
            buildAssistantCompletionEvent({
              threadId: input.context.session.threadId,
              turnId: input.turnId,
              itemId: assistantActiveItemId,
            }),
          );
          resetAssistantTextBlock();
        });

        const processPendingToolStep = Effect.fn("processPendingToolStep")(function* () {
          if (pendingToolInputAvailableChunks.length === 0) {
            return false;
          }

          const stepToolChunks = pendingToolInputAvailableChunks.splice(
            0,
            pendingToolInputAvailableChunks.length,
          );
          const reasoningBlockIds =
            input.context.activeTurn !== null
              ? takeUnconsumedReasoningBlockIds(input.context.activeTurn)
              : [];
          const reasoningParts =
            input.context.activeTurn && reasoningBlockIds.length > 0
              ? buildReasoningPartsForBlockIds(input.context.activeTurn, reasoningBlockIds)
              : undefined;
          const commentaryText =
            interactionMode === "plan" ? null : normalizeHostedCommentaryText(assistantText);

          if (commentaryText && !assistantStarted && input.context.activeTurn) {
            input.context.activeTurn.commentaryCount += 1;
            const commentaryItemId = RuntimeItemId.makeUnsafe(
              `commentary:${String(input.turnId)}:${input.context.activeTurn.commentaryCount}`,
            );
            yield* emit(
              buildCommentaryAssistantCompletionEvent({
                threadId: input.context.session.threadId,
                turnId: input.turnId,
                itemId: commentaryItemId,
                detail: commentaryText,
              }),
            );
            resetAssistantTextBlock();
          } else {
            yield* flushPendingAssistantText();
            yield* completeAssistantTextBlock();
          }

          const latestContext = yield* getContext(input.context.session.threadId);
          const nextPendingApprovals = new Map(latestContext.pendingApprovals);
          const nextPendingUserInputs = new Map(latestContext.pendingUserInputs);
          const assistantMessageId =
            stepToolChunks.length === 1
              ? `assistant-tool:${stepToolChunks[0]?.toolCallId ?? String(input.turnId)}`
              : `assistant-tools:${String(input.turnId)}`;
          const toolParts: HostedShioriMessage["parts"] = [];
          const pendingRequestEvents: Array<
            | {
                kind: "approval";
                requestId: ApprovalRequestId;
                toolName: string;
                toolInput: Record<string, unknown>;
                requestKind: ApprovalRequestKind;
              }
            | {
                kind: "user-input";
                requestId: ApprovalRequestId;
                toolInput: Record<string, unknown>;
              }
          > = [];
          let waitingOnUser = false;
          let requiresContinuation = false;

          for (const chunk of stepToolChunks) {
            const toolName = chunk.toolName;
            const toolInput =
              chunk.input && typeof chunk.input === "object" && !Array.isArray(chunk.input)
                ? (chunk.input as Record<string, unknown>)
                : {};
            const hostedExecution = hostedToolExecutions.get(chunk.toolCallId) ?? null;
            hostedToolExecutions.delete(chunk.toolCallId);
            const requestKind = toolRequestKind(toolName);
            const mcpTool = input.context.activeTurn?.mcpTools.get(toolName);
            const mcpDescriptor = input.context.activeTurn?.mcpToolDescriptors.find(
              (descriptor) => descriptor.name === toolName,
            );
            const mcpDescriptorRequestKind = mcpDescriptor
              ? hostedDescriptorRequestKindFromSchema(mcpDescriptor.inputSchema)
              : undefined;
            const mcpDescriptorNeedsApproval =
              mcpDescriptor?.inputSchema["x-shioricode-needs-approval"] === true;
            const mcpPolicyRequiresApproval =
              mcpTool !== undefined &&
              (mcpDescriptorNeedsApproval ||
                (mcpDescriptorRequestKind !== undefined &&
                  mcpDescriptorRequestKind !== "file-read" &&
                  hostedPolicyAsks(input.context.activeTurn?.hostedBootstrap, "mcpSideEffect")));
            const effectiveRequestKind =
              requestKind ??
              (mcpPolicyRequiresApproval
                ? (approvalRequestKindForHostedDescriptor(mcpDescriptorRequestKind) ?? "command")
                : undefined);
            const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
            const approvalRequired =
              (effectiveRequestKind !== undefined &&
                input.context.session.runtimeMode !== "full-access" &&
                !input.context.allowedRequestKinds.has(effectiveRequestKind)) ||
              mcpPolicyRequiresApproval;

            if (toolName === "update_plan") {
              const planUpdate = extractPlanUpdatePayload(toolInput);
              if (!planUpdate) {
                const detail =
                  "Invalid tool input for update_plan: expected at least one plan step.";
                yield* Effect.logWarning("shiori stream emitted invalid update_plan payload", {
                  threadId: input.context.session.threadId,
                  turnId: input.turnId,
                  toolCallId: chunk.toolCallId,
                  toolInput,
                });
                yield* failTurn({
                  context: yield* getContext(input.context.session.threadId),
                  detail,
                });
                return true;
              }

              yield* emit({
                ...runtimeEventBase({
                  threadId: input.context.session.threadId,
                  turnId: input.turnId,
                }),
                type: "turn.plan.updated",
                payload: planUpdate,
              } satisfies ProviderRuntimeEvent);

              toolParts.push(
                buildAssistantToolPart({
                  messageId: assistantMessageId,
                  text: assistantCompletionText,
                  ...(reasoningParts ? { reasoningParts } : {}),
                  toolName,
                  toolCallId: chunk.toolCallId,
                  toolInput,
                  state: "output-available",
                  output: { ok: true },
                  ...(chunk.providerMetadata !== undefined
                    ? { callProviderMetadata: chunk.providerMetadata }
                    : {}),
                }),
              );
              requiresContinuation = true;
              continue;
            }

            if (hostedExecution || chunk.providerExecuted) {
              toolParts.push(
                buildAssistantToolPart({
                  messageId: assistantMessageId,
                  text: assistantCompletionText,
                  ...(reasoningParts ? { reasoningParts } : {}),
                  toolName,
                  toolCallId: chunk.toolCallId,
                  toolInput,
                  state: hostedExecution?.state ?? "input-available",
                  ...(hostedExecution?.state === "output-available"
                    ? {
                        output: hostedExecution.output,
                        ...(hostedExecution.resultProviderMetadata !== undefined
                          ? {
                              resultProviderMetadata: hostedExecution.resultProviderMetadata,
                            }
                          : {}),
                      }
                    : hostedExecution?.state === "output-error"
                      ? {
                          errorText: hostedExecution.errorText,
                          ...(hostedExecution.resultProviderMetadata !== undefined
                            ? {
                                resultProviderMetadata: hostedExecution.resultProviderMetadata,
                              }
                            : {}),
                        }
                      : {}),
                  ...(chunk.providerMetadata !== undefined
                    ? { callProviderMetadata: chunk.providerMetadata }
                    : {}),
                }),
              );

              if (hostedExecution?.state === "output-available") {
                yield* emitToolCompleted({
                  threadId: input.context.session.threadId,
                  turnId: input.turnId,
                  toolName,
                  toolCallId: chunk.toolCallId,
                  toolInput,
                  ...(mcpTool ? { title: mcpTool.title } : {}),
                  detail:
                    toolName === "exec_command"
                      ? String(toolInput.command ?? "")
                      : typeof toolInput.path === "string"
                        ? toolInput.path
                        : (toolLifecycleDetail(toolName, toolInput) ?? toolTitle(toolName)),
                  data: hostedExecution.output,
                });
              } else if (hostedExecution?.state === "output-error") {
                yield* emitToolCompleted({
                  threadId: input.context.session.threadId,
                  turnId: input.turnId,
                  toolName,
                  toolCallId: chunk.toolCallId,
                  toolInput,
                  status: "failed",
                  ...(mcpTool ? { title: mcpTool.title } : {}),
                  detail: hostedExecution.errorText,
                  data: { errorText: hostedExecution.errorText },
                });
              } else if (hostedExecution?.state === "output-denied") {
                yield* emitToolCompleted({
                  threadId: input.context.session.threadId,
                  turnId: input.turnId,
                  toolName,
                  toolCallId: chunk.toolCallId,
                  toolInput,
                  status: "failed",
                  ...(mcpTool ? { title: mcpTool.title } : {}),
                  detail: "Tool output denied.",
                  data: { errorText: "Tool output denied." },
                });
              } else {
                yield* Effect.logWarning(
                  "shiori stream step ended before hosted tool result arrived",
                  {
                    threadId: input.context.session.threadId,
                    turnId: input.turnId,
                    toolCallId: chunk.toolCallId,
                    toolName,
                  },
                );
              }

              continue;
            }

            if (isUserInputToolName(toolName)) {
              nextPendingUserInputs.set(requestId, {
                requestId,
                toolCallId: chunk.toolCallId,
                toolName,
                input: toolInput,
                assistantMessageId,
                ...(reasoningBlockIds.length > 0 ? { reasoningBlockIds } : {}),
                ...(chunk.providerMetadata !== undefined
                  ? { callProviderMetadata: chunk.providerMetadata }
                  : {}),
              });
              toolParts.push(
                buildAssistantToolPart({
                  messageId: assistantMessageId,
                  text: assistantCompletionText,
                  ...(reasoningParts ? { reasoningParts } : {}),
                  toolName,
                  toolCallId: chunk.toolCallId,
                  toolInput,
                  state: "input-available",
                  ...(chunk.providerMetadata !== undefined
                    ? { callProviderMetadata: chunk.providerMetadata }
                    : {}),
                }),
              );
              pendingRequestEvents.push({
                kind: "user-input",
                requestId,
                toolInput,
              });
              waitingOnUser = true;
              continue;
            }

            if (approvalRequired && effectiveRequestKind) {
              nextPendingApprovals.set(requestId, {
                requestId,
                toolCallId: chunk.toolCallId,
                toolName,
                input: toolInput,
                assistantMessageId,
                approvalId: requestId,
                requestKind: effectiveRequestKind,
                ...(reasoningBlockIds.length > 0 ? { reasoningBlockIds } : {}),
                ...(chunk.providerMetadata !== undefined
                  ? { callProviderMetadata: chunk.providerMetadata }
                  : {}),
              });
              toolParts.push(
                buildAssistantToolPart({
                  messageId: assistantMessageId,
                  text: assistantCompletionText,
                  ...(reasoningParts ? { reasoningParts } : {}),
                  toolName,
                  toolCallId: chunk.toolCallId,
                  toolInput,
                  state: "approval-requested",
                  approvalId: requestId,
                  ...(chunk.providerMetadata !== undefined
                    ? { callProviderMetadata: chunk.providerMetadata }
                    : {}),
                }),
              );
              pendingRequestEvents.push({
                kind: "approval",
                requestId,
                toolName,
                toolInput,
                requestKind: effectiveRequestKind,
              });
              waitingOnUser = true;
              continue;
            }

            const execution =
              mcpTool &&
              toolName.startsWith(KANBAN_TOOL_PREFIX) &&
              !canUseHostedKanbanTools(input.context.activeTurn?.hostedBootstrap)
                ? {
                    state: "output-error" as const,
                    errorText: "Kanban tools are disabled for this ShioriCode deployment.",
                  }
                : mcpTool
                  ? yield* Effect.promise(async () => {
                      try {
                        return {
                          state: "output-available" as const,
                          output: await mcpTool.execute(toolInput),
                        };
                      } catch (error) {
                        return {
                          state: "output-error" as const,
                          errorText: toMessage(error) || `MCP tool '${toolName}' failed.`,
                        };
                      }
                    })
                  : isSubagentToolName(toolName)
                    ? yield* executeSubagentToolForTurn({
                        threadId: input.context.session.threadId,
                        turnId: input.turnId,
                        toolCallId: chunk.toolCallId,
                        toolName,
                        toolInput,
                        selectedModel: input.selectedModel,
                        hostedBootstrap: input.context.activeTurn?.hostedBootstrap,
                        signal: input.controller.signal,
                      })
                    : yield* executeLocalToolForTurn({
                        toolName,
                        toolInput,
                        cwd: input.context.session.cwd,
                        hostedBootstrap: input.context.activeTurn?.hostedBootstrap,
                        signal: input.controller.signal,
                      });

            toolParts.push(
              buildAssistantToolPart({
                messageId: assistantMessageId,
                text: assistantCompletionText,
                ...(reasoningParts ? { reasoningParts } : {}),
                toolName,
                toolCallId: chunk.toolCallId,
                toolInput,
                state: execution.state,
                ...(execution.state === "output-available"
                  ? { output: execution.output }
                  : { errorText: execution.errorText }),
                ...(chunk.providerMetadata !== undefined
                  ? { callProviderMetadata: chunk.providerMetadata }
                  : {}),
              }),
            );
            yield* emitToolCompleted({
              threadId: input.context.session.threadId,
              turnId: input.turnId,
              toolName,
              toolCallId: chunk.toolCallId,
              toolInput,
              status: execution.state === "output-error" ? "failed" : "completed",
              ...(mcpTool ? { title: mcpTool.title } : {}),
              detail:
                execution.state === "output-error"
                  ? execution.errorText
                  : toolName === "exec_command"
                    ? String(toolInput.command ?? "")
                    : typeof toolInput.path === "string"
                      ? toolInput.path
                      : (toolLifecycleDetail(toolName, toolInput) ?? toolTitle(toolName)),
              data:
                execution.state === "output-available"
                  ? execution.output
                  : { errorText: execution.errorText },
            });
            requiresContinuation = true;
          }

          const nextMessage = assistantMessageWithParts({
            messageId: assistantMessageId,
            text: assistantCompletionText,
            ...(reasoningParts ? { reasoningParts } : {}),
            extraParts: toolParts,
          });
          const latestContextAfterTools = yield* getContext(input.context.session.threadId);
          const nextContext = withResumeCursor({
            ...latestContextAfterTools,
            messages: [...persistedMessages, nextMessage],
            pendingApprovals: nextPendingApprovals,
            pendingUserInputs: nextPendingUserInputs,
          });
          persistedMessages = nextContext.messages;
          yield* setContext(input.context.session.threadId, nextContext);
          yield* persistContext(nextContext);
          for (const pendingRequestEvent of pendingRequestEvents) {
            if (pendingRequestEvent.kind === "user-input") {
              yield* emitUserInputRequest({
                threadId: input.context.session.threadId,
                turnId: input.turnId,
                requestId: pendingRequestEvent.requestId,
                toolInput: pendingRequestEvent.toolInput,
              });
              continue;
            }

            yield* emitApprovalRequest({
              threadId: input.context.session.threadId,
              turnId: input.turnId,
              requestId: pendingRequestEvent.requestId,
              toolName: pendingRequestEvent.toolName,
              toolInput: pendingRequestEvent.toolInput,
              requestKind: pendingRequestEvent.requestKind,
            });
          }
          if (waitingOnUser) {
            return true;
          }
          if (requiresContinuation) {
            if (input.controller.signal.aborted || (yield* isTurnFinalized(input.turnId))) {
              return yield* Effect.fail(
                requestError(
                  `shiori.turn.start:${String(input.context.session.threadId)}`,
                  "Interrupted",
                ),
              );
            }
            const continuedController = new AbortController();
            yield* updateContext(input.context.session.threadId, (context) => ({
              ...context,
              activeTurn: context.activeTurn
                ? {
                    ...context.activeTurn,
                    controller: continuedController,
                  }
                : context.activeTurn,
            }));
            const refreshedContext = yield* getContext(input.context.session.threadId);
            if (yield* isTurnFinalized(input.turnId)) {
              return true;
            }
            return yield* runHostedTurn({
              ...input,
              context: refreshedContext,
              requestMessages: refreshedContext.messages,
              controller: continuedController,
              resumeExistingTurn: true,
            }).pipe(Effect.as(true));
          }

          assistantCompletionText = "";
          assistantFinalText = "";
          return false;
        });

        try {
          for (;;) {
            const next = yield* Effect.tryPromise({
              try: () => reader.read(),
              catch: (error) =>
                requestError(
                  `shiori.turn.start:${String(input.context.session.threadId)}`,
                  toMessage(error),
                  error,
                ),
            }).pipe(
              Effect.timeoutOrElse({
                duration: effectiveStreamReadTimeout,
                orElse: () =>
                  Effect.fail(
                    requestError(
                      `shiori.turn.start:${String(input.context.session.threadId)}`,
                      `Shiori turn stream stalled for more than ${Duration.format(Duration.fromInputUnsafe(effectiveStreamReadTimeout))}; closing to recover.`,
                    ),
                  ),
              }),
            );
            if (next.done) {
              break;
            }

            const turnFinalized = yield* isTurnFinalized(input.turnId);
            if (input.controller.signal.aborted || turnFinalized) {
              return yield* Effect.fail(
                requestError(
                  `shiori.turn.start:${String(input.context.session.threadId)}`,
                  "Interrupted",
                ),
              );
            }

            if (!next.value.success) {
              yield* Effect.logWarning("shiori stream parse failure", {
                threadId: input.context.session.threadId,
                turnId: input.turnId,
                message: next.value.error.message,
              });
              return yield* Effect.fail(
                requestError(
                  `shiori.turn.start:${String(input.context.session.threadId)}`,
                  next.value.error.message,
                  next.value.error,
                ),
              );
            }

            const chunk = next.value.value as UIMessageChunk;
            switch (chunk.type) {
              case "text-start": {
                startAssistantTextBlock(chunk.id);
                break;
              }
              case "text-delta": {
                assistantText += chunk.delta;
                if (interactionMode === "plan") {
                  assistantCompletionText += chunk.delta;
                  if (input.context.activeTurn) {
                    input.context.activeTurn.assistantText = assistantCompletionText;
                  }
                  yield* emit({
                    ...runtimeEventBase({
                      threadId: input.context.session.threadId,
                      turnId: input.turnId,
                    }),
                    type: "turn.proposed.delta",
                    payload: {
                      delta: chunk.delta,
                    },
                  } satisfies ProviderRuntimeEvent);
                  break;
                }
                if (assistantTextProbeActive) {
                  if (
                    shouldProbeHostedCommentaryText(assistantText) ||
                    normalizeHostedCommentaryText(assistantText) !== null
                  ) {
                    break;
                  }
                  assistantTextProbeActive = false;
                  yield* flushPendingAssistantText();
                  break;
                }
                yield* flushVisibleAssistantSegment(chunk.delta);
                assistantTextEmittedLength = assistantText.length;
                break;
              }
              case "text-end": {
                yield* flushPendingAssistantText();
                yield* completeAssistantTextBlock();
                break;
              }
              case "reasoning-start": {
                if (input.context.activeTurn) {
                  const block = ensureReasoningBlock(input.context.activeTurn, chunk.id);
                  if (chunk.providerMetadata !== undefined) {
                    block.providerMetadata = chunk.providerMetadata;
                  }
                }
                break;
              }
              case "reasoning-delta": {
                if (input.context.activeTurn) {
                  const block = ensureReasoningBlock(input.context.activeTurn, chunk.id);
                  block.text += chunk.delta;
                  if (chunk.providerMetadata !== undefined) {
                    block.providerMetadata = chunk.providerMetadata;
                  }
                  if (chunk.delta.length === 0) {
                    break;
                  }
                  if (!block.visibleStarted) {
                    block.visibleStarted = true;
                    yield* emit({
                      ...runtimeEventBase({
                        threadId: input.context.session.threadId,
                        turnId: input.turnId,
                        itemId: block.itemId,
                      }),
                      type: "item.started",
                      payload: {
                        itemType: "reasoning",
                        status: "inProgress",
                        title: "Reasoning",
                      },
                    } satisfies ProviderRuntimeEvent);
                  }
                  yield* emit({
                    ...runtimeEventBase({
                      threadId: input.context.session.threadId,
                      turnId: input.turnId,
                      itemId: block.itemId,
                    }),
                    type: "content.delta",
                    payload: {
                      streamKind: "reasoning_text",
                      delta: chunk.delta,
                    },
                  } satisfies ProviderRuntimeEvent);
                }
                break;
              }
              case "reasoning-end": {
                if (input.context.activeTurn) {
                  const block = ensureReasoningBlock(input.context.activeTurn, chunk.id);
                  if (chunk.providerMetadata !== undefined) {
                    block.providerMetadata = chunk.providerMetadata;
                  }
                  if (block.completed) {
                    break;
                  }
                  block.completed = true;
                  if (!block.visibleStarted) {
                    break;
                  }
                  yield* emit({
                    ...runtimeEventBase({
                      threadId: input.context.session.threadId,
                      turnId: input.turnId,
                      itemId: block.itemId,
                    }),
                    type: "item.completed",
                    payload: {
                      itemType: "reasoning",
                      status: "completed",
                    },
                  } satisfies ProviderRuntimeEvent);
                }
                break;
              }
              case "tool-input-available": {
                if (isInternalHostedToolName(chunk.toolName)) {
                  ignoredToolCallIds.add(chunk.toolCallId);
                  break;
                }
                pendingToolInputAvailableChunks.push(chunk);
                if (chunk.toolName !== "update_plan") {
                  const toolInput =
                    chunk.input && typeof chunk.input === "object" && !Array.isArray(chunk.input)
                      ? (chunk.input as Record<string, unknown>)
                      : {};
                  const mcpTool = input.context.activeTurn?.mcpTools.get(chunk.toolName);
                  yield* emitToolStarted({
                    threadId: input.context.session.threadId,
                    turnId: input.turnId,
                    toolName: chunk.toolName,
                    toolCallId: chunk.toolCallId,
                    toolInput,
                    ...(mcpTool ? { title: mcpTool.title } : {}),
                  });
                }
                break;
              }
              case "tool-output-available": {
                if (ignoredToolCallIds.has(chunk.toolCallId)) {
                  ignoredToolCallIds.delete(chunk.toolCallId);
                  break;
                }
                hostedToolExecutions.set(chunk.toolCallId, {
                  state: "output-available",
                  output: chunk.output,
                  ...(chunk.providerMetadata !== undefined
                    ? { resultProviderMetadata: chunk.providerMetadata }
                    : {}),
                });
                break;
              }
              case "tool-output-error": {
                if (ignoredToolCallIds.has(chunk.toolCallId)) {
                  ignoredToolCallIds.delete(chunk.toolCallId);
                  break;
                }
                hostedToolExecutions.set(chunk.toolCallId, {
                  state: "output-error",
                  errorText: chunk.errorText,
                  ...(chunk.providerMetadata !== undefined
                    ? { resultProviderMetadata: chunk.providerMetadata }
                    : {}),
                });
                break;
              }
              case "tool-output-denied": {
                if (ignoredToolCallIds.has(chunk.toolCallId)) {
                  ignoredToolCallIds.delete(chunk.toolCallId);
                  break;
                }
                hostedToolExecutions.set(chunk.toolCallId, {
                  state: "output-denied",
                });
                break;
              }
              case "tool-input-error": {
                const toolInput =
                  chunk.input && typeof chunk.input === "object" && !Array.isArray(chunk.input)
                    ? (chunk.input as Record<string, unknown>)
                    : {};
                const detail = `Invalid tool input for ${chunk.toolName}: ${chunk.errorText}`;
                yield* Effect.logWarning("shiori stream emitted invalid tool input", {
                  threadId: input.context.session.threadId,
                  turnId: input.turnId,
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  errorText: chunk.errorText,
                });
                yield* emitToolStarted({
                  threadId: input.context.session.threadId,
                  turnId: input.turnId,
                  toolName: chunk.toolName,
                  toolCallId: chunk.toolCallId,
                  toolInput,
                });
                yield* emitToolCompleted({
                  threadId: input.context.session.threadId,
                  turnId: input.turnId,
                  toolName: chunk.toolName,
                  toolCallId: chunk.toolCallId,
                  toolInput,
                  status: "failed",
                  detail: chunk.errorText,
                  data: {
                    errorText: chunk.errorText,
                  },
                });
                yield* failTurn({
                  context: yield* getContext(input.context.session.threadId),
                  detail,
                });
                return;
              }
              case "error": {
                const errorDetail = normalizeHostedFailureDetail(
                  chunk.errorText,
                  "Shiori stream emitted an error.",
                );
                yield* Effect.logWarning("shiori stream emitted error chunk", {
                  threadId: input.context.session.threadId,
                  turnId: input.turnId,
                  errorText: errorDetail,
                });
                return yield* Effect.fail(
                  requestError(
                    `shiori.turn.start:${String(input.context.session.threadId)}`,
                    errorDetail,
                  ),
                );
              }
              case "finish-step": {
                const didStop = yield* processPendingToolStep();
                if (didStop) {
                  return;
                }
                break;
              }
              default:
                break;
            }
          }

          if (pendingToolInputAvailableChunks.length > 0) {
            const didStop = yield* processPendingToolStep();
            if (didStop) {
              return;
            }
          }

          const turnFinalizedAfterStream = yield* isTurnFinalized(input.turnId);
          if (input.controller.signal.aborted || turnFinalizedAfterStream) {
            if (input.controller.signal.aborted && !turnFinalizedAfterStream) {
              return yield* Effect.fail(
                requestError(
                  `shiori.turn.start:${String(input.context.session.threadId)}`,
                  "Interrupted",
                ),
              );
            }
            return;
          }

          if (interactionMode !== "plan") {
            yield* flushPendingAssistantText();
            yield* completeAssistantTextBlock();
          }

          if (interactionMode === "plan" && assistantCompletionText.trim().length > 0) {
            yield* emit({
              ...runtimeEventBase({
                threadId: input.context.session.threadId,
                turnId: input.turnId,
              }),
              type: "turn.proposed.completed",
              payload: {
                planMarkdown: assistantCompletionText,
              },
            } satisfies ProviderRuntimeEvent);
          }

          const assistantMessage = assistantMessageWithParts({
            messageId: `assistant-${String(input.turnId)}`,
            text: assistantFinalText,
            ...(input.context.activeTurn
              ? {
                  reasoningParts: buildReasoningPartsForBlockIds(
                    input.context.activeTurn,
                    takeUnconsumedReasoningBlockIds(input.context.activeTurn),
                  ),
                }
              : {}),
          });
          if (yield* isTurnFinalized(input.turnId)) {
            return;
          }
          yield* Effect.logInfo("shiori turn completed", {
            threadId: input.context.session.threadId,
            turnId: input.turnId,
            assistantChars: assistantFinalText.length,
          });
          const finalizedMessages = hasMessageParts(assistantMessage)
            ? [...persistedMessages, assistantMessage]
            : persistedMessages;

          yield* updateContext(input.context.session.threadId, (context) =>
            withResumeCursor({
              ...context,
              messages: finalizedMessages,
              turns: [
                ...context.turns,
                { id: input.turnId, items: [], messageCount: finalizedMessages.length },
              ],
              activeTurn: null,
              session: {
                ...context.session,
                status: "ready",
                activeTurnId: undefined,
                updatedAt: nowIso(),
              },
            }),
          );

          const updatedContext = yield* getContext(input.context.session.threadId);
          yield* Effect.promise(() => closeActiveTurnMcpTools(input.context.activeTurn)).pipe(
            Effect.ignore({ log: false }),
          );
          yield* persistContext(updatedContext);
          yield* markTurnFinalized(input.turnId);
          yield* emit(
            buildTurnCompletedEvent({
              threadId: input.context.session.threadId,
              turnId: input.turnId,
              state: "completed",
            }),
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const aborted = input.controller.signal.aborted;
          const alreadyFinalized = yield* isTurnFinalized(input.turnId);

          if (alreadyFinalized) {
            return;
          }

          // Preserve whatever assistant text we managed to stream before the failure
          // so the user sees partial output instead of a blank "failed" turn.
          const partialAssistantMessage =
            assistantFinalText.trim().length > 0
              ? assistantMessageWithParts({
                  messageId: `assistant-${String(input.turnId)}`,
                  text: assistantFinalText,
                  ...(input.context.activeTurn
                    ? {
                        reasoningParts: buildReasoningPartsForBlockIds(
                          input.context.activeTurn,
                          takeUnconsumedReasoningBlockIds(input.context.activeTurn),
                        ),
                      }
                    : {}),
                })
              : null;

          yield* updateContext(input.context.session.threadId, (context) => {
            const nextMessages =
              partialAssistantMessage && hasMessageParts(partialAssistantMessage)
                ? [...context.messages, partialAssistantMessage]
                : context.messages;
            return withResumeCursor({
              ...context,
              messages: nextMessages,
              activeTurn: null,
              session: {
                ...context.session,
                status: "ready",
                activeTurnId: undefined,
                updatedAt: nowIso(),
                ...(aborted ? {} : { lastError: detail }),
              },
            });
          });
          const updatedContext = yield* getContext(input.context.session.threadId);
          yield* persistContext(updatedContext);

          if (aborted && !alreadyFinalized) {
            yield* markTurnFinalized(input.turnId);
            yield* Effect.forEach(
              buildInterruptedTurnEvents({
                threadId: input.context.session.threadId,
                turnId: input.turnId,
                assistantItemId: assistantActiveItemId,
                assistantStarted,
                openReasoningItemIds:
                  input.context.activeTurn !== null
                    ? input.context.activeTurn.reasoningBlockOrder.flatMap((blockId) => {
                        const block = input.context.activeTurn?.reasoningBlocks.get(blockId);
                        return block && block.visibleStarted && !block.completed
                          ? [block.itemId]
                          : [];
                      })
                    : [],
              }),
              emit,
              { concurrency: 1 },
            ).pipe(Effect.asVoid);
          } else {
            yield* markTurnFinalized(input.turnId);
            yield* emit({
              ...runtimeEventBase({
                threadId: input.context.session.threadId,
                turnId: input.turnId,
              }),
              type: "runtime.error",
              payload: {
                message: detail,
                class: "provider_error",
              },
            } satisfies ProviderRuntimeEvent);
            yield* emit(
              buildTurnCompletedEvent({
                threadId: input.context.session.threadId,
                turnId: input.turnId,
                state: "failed",
                errorMessage: detail,
              }),
            );
          }
        } finally {
          yield* Effect.tryPromise({
            try: () => reader.cancel(),
            catch: (error) =>
              requestError(
                `shiori.turn.start:${String(input.context.session.threadId)}`,
                toMessage(error),
                error,
              ),
          }).pipe(
            Effect.catch((error) =>
              Effect.logDebug("shiori turn reader cancel failed", {
                threadId: input.context.session.threadId,
                turnId: input.turnId,
                detail: toMessage(error),
              }),
            ),
          );
        }
      });

      return {
        provider: PROVIDER,
        capabilities: {
          sessionModelSwitch: "in-session",
          recovery: {
            supportsResumeCursor: true,
            supportsAdoptActiveSession: true,
          },
          observability: {
            emitsStructuredSessionExit: true,
            emitsRuntimeDiagnostics: true,
          },
        },
        startSession: Effect.fn("startSession")(function* (input) {
          const providerError = ensureProvider("startSession", input.provider);
          if (providerError) {
            return yield* Effect.fail(providerError);
          }

          const now = nowIso();
          const restoredState = decodeResumeCursor(input.resumeCursor);
          const pendingApprovals = new Map(
            restoredState.pendingApprovals.map((pending) => [pending.requestId, pending] as const),
          );
          const pendingUserInputs = new Map(
            restoredState.pendingUserInputs.map((pending) => [pending.requestId, pending] as const),
          );
          const provisionalSession: ProviderSession = {
            provider: PROVIDER,
            status:
              restoredState.activeTurnSnapshot &&
              (pendingApprovals.size > 0 || pendingUserInputs.size > 0)
                ? "running"
                : "ready",
            runtimeMode: input.runtimeMode,
            threadId: input.threadId,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
            ...(restoredState.activeTurnSnapshot &&
            (pendingApprovals.size > 0 || pendingUserInputs.size > 0)
              ? { activeTurnId: restoredState.activeTurnSnapshot.turnId }
              : {}),
            createdAt: now,
            updatedAt: now,
          };
          const toolRuntime =
            restoredState.activeTurnSnapshot &&
            (pendingApprovals.size > 0 || pendingUserInputs.size > 0)
              ? yield* buildMcpRuntimeForCwd({
                  threadId: provisionalSession.threadId,
                  cwd: provisionalSession.cwd,
                })
              : null;
          const activeTurn =
            restoredState.activeTurnSnapshot &&
            (pendingApprovals.size > 0 || pendingUserInputs.size > 0)
              ? restoreRecoverableActiveTurn({
                  session: provisionalSession,
                  snapshot: restoredState.activeTurnSnapshot,
                  messages: restoredState.messages,
                  pendingApprovals: restoredState.pendingApprovals,
                  pendingUserInputs: restoredState.pendingUserInputs,
                  toolRuntime: toolRuntime!,
                })
              : null;
          const restoredSubagents = new Map(
            restoredState.subagents.map((state) => [state.id, state] as const),
          );
          const contextWithoutCursor: ShioriSessionContext = {
            session: provisionalSession,
            messages: restoredState.messages,
            turns: restoredState.turns,
            activeTurn,
            toolRuntime,
            pendingApprovals,
            pendingUserInputs,
            allowedRequestKinds: new Set(restoredState.allowedRequestKinds),
            subagents: restoredSubagents,
            subagentSequence: restoredSubagents.size,
            pendingSubagentNotifications: [...restoredState.pendingSubagentNotifications],
          };
          const context = withResumeCursor(contextWithoutCursor);

          yield* Ref.update(sessionsRef, (sessions) => {
            const next = new Map(sessions);
            next.set(String(input.threadId), context);
            return next;
          });

          if (!context.toolRuntime) {
            yield* prewarmSessionToolRuntime(input.threadId, provisionalSession.cwd);
          }
          const authToken = yield* hostedAuthTokenStore.getToken;
          if (
            isExpectedHostedShioriAuthToken(authToken) &&
            context.hostedBootstrap === undefined &&
            context.activeTurn === null
          ) {
            yield* prewarmHostedBootstrapForContext({
              threadId: input.threadId,
              authToken,
            });
          }
          for (const subagent of context.subagents.values()) {
            if (
              subagent.status !== "shutdown" &&
              subagent.queuedInputs.length > 0 &&
              !subagent.runnerActive
            ) {
              yield* ensureSubagentRunner(input.threadId, subagent.id);
            }
          }

          return context.session;
        }) as ShioriAdapterShape["startSession"],
        sendTurn: (input) =>
          Effect.gen(function* () {
            const context = yield* getContext(input.threadId);
            yield* Effect.logInfo("shiori adapter sendTurn invoked", {
              threadId: input.threadId,
              hasActiveTurn: context.activeTurn !== null,
              selectedModel:
                input.modelSelection?.provider === PROVIDER
                  ? input.modelSelection.model
                  : (context.session.model ?? null),
              token: describeToken(yield* hostedAuthTokenStore.getToken),
              attachmentCount: input.attachments?.length ?? 0,
              inputChars: input.input?.length ?? 0,
            });
            if (context.activeTurn) {
              return yield* Effect.fail(
                requestError(
                  `shiori.turn.start:${String(input.threadId)}`,
                  "A Shiori turn is already running for this thread.",
                ),
              );
            }

            const authToken = yield* hostedAuthTokenStore.getToken;
            if (!isExpectedHostedShioriAuthToken(authToken)) {
              return yield* Effect.fail(
                requestError(
                  `shiori.turn.start:${String(input.threadId)}`,
                  "Shiori account token is unavailable or invalid. Sign out and sign back in to continue.",
                ),
              );
            }

            const selectedModel = resolveModelSlugForProvider(
              PROVIDER,
              input.modelSelection?.provider === PROVIDER
                ? input.modelSelection.model
                : context.session.model,
            );
            const modelSettings =
              input.modelSelection?.provider === PROVIDER
                ? buildHostedModelSettings(input.modelSelection.options)
                : undefined;
            const attachments = input.attachments ?? [];
            const text = buildUserMessageText(input);
            const attachmentParts = yield* Effect.tryPromise({
              try: () =>
                Promise.all(
                  attachments.map((attachment) =>
                    attachmentToFilePart(attachment as ChatAttachment, serverConfig.attachmentsDir),
                  ),
                ),
              catch: (error) =>
                requestError(
                  `shiori.turn.start:${String(input.threadId)}`,
                  "Failed to load attachments.",
                  error,
                ),
            });
            const userMessage: HostedShioriMessage = {
              id: `user-${crypto.randomUUID()}`,
              role: "user",
              parts: [
                ...(text.length > 0
                  ? [
                      {
                        type: "text" as const,
                        text,
                      },
                    ]
                  : []),
                ...attachmentParts,
              ],
            };
            const notificationMessages = context.pendingSubagentNotifications.map((message) => ({
              id: `user-subagent-notification-${crypto.randomUUID()}`,
              role: "user" as const,
              parts: [
                {
                  type: "text" as const,
                  text: message,
                },
              ],
            }));
            const requestMessages = [...context.messages, ...notificationMessages, userMessage];
            const turnId = TurnId.makeUnsafe(crypto.randomUUID());
            const assistantItemId = RuntimeItemId.makeUnsafe(
              `${SHIORI_ASSISTANT_ITEM_PREFIX}:${String(turnId)}`,
            );
            const controller = new AbortController();
            const toolRuntime = yield* getOrCreateSessionToolRuntime(context);
            const hostedBootstrap =
              getFreshHostedBootstrapForContext(context) ?? CONSERVATIVE_SHIORI_BOOTSTRAP;

            const runningContext = withResumeCursor({
              ...context,
              messages: requestMessages,
              pendingSubagentNotifications: [],
              hostedBootstrap,
              hostedBootstrapFetchedAt: Date.now(),
              activeTurn: {
                turnId,
                controller,
                assistantItemId,
                interactionMode: input.interactionMode ?? "default",
                mcpToolDescriptors: toolRuntime.descriptors,
                mcpTools: toolRuntime.executors,
                closeMcpTools: async () => undefined,
                skillPrompt: toolRuntime.skillPrompt,
                ...(modelSettings ? { modelSettings } : {}),
                hostedBootstrap,
                assistantText: "",
                assistantFinalText: "",
                assistantActiveItemId: null,
                assistantStarted: false,
                commentaryCount: 0,
                reasoningBlocks: new Map(),
                reasoningBlockOrder: [],
              },
              toolRuntime,
              session: {
                ...context.session,
                model: selectedModel,
                status: "running",
                activeTurnId: turnId,
                updatedAt: nowIso(),
              },
            });
            yield* Ref.update(sessionsRef, (sessions) => {
              const next = new Map(sessions);
              next.set(String(input.threadId), runningContext);
              return next;
            });

            yield* persistContext(runningContext);

            const turnResult: ProviderTurnStartResult = {
              threadId: input.threadId,
              turnId,
            };

            const background = runHostedTurn({
              context: runningContext,
              turnId,
              requestMessages,
              selectedModel,
              authToken,
              controller,
              assistantItemId,
            });
            void Effect.runFork(
              background.pipe(
                Effect.catch((error) =>
                  finalizeFailedBackgroundTurn({
                    threadId: runningContext.session.threadId,
                    turnId,
                    error,
                  }),
                ),
              ),
            );

            return turnResult;
          }),
        interruptTurn: (threadId, _turnId) =>
          Effect.gen(function* () {
            const context = yield* getContext(threadId);
            if (!context.activeTurn) {
              return;
            }
            yield* finalizeInterruptedTurn(context, {
              resolvePendingRequests:
                context.pendingApprovals.size > 0 || context.pendingUserInputs.size > 0,
            });
          }),
        respondToRequest: (threadId, requestId, decision) =>
          Effect.gen(function* () {
            const context = yield* getContext(threadId);
            const pending = context.pendingApprovals.get(requestId);
            if (!pending || !context.activeTurn) {
              return yield* Effect.fail(
                requestError(
                  "shiori.respondToRequest",
                  `Unknown pending approval request: ${requestId}`,
                ),
              );
            }
            const activeTurn = context.activeTurn;
            const bootstrapAuthToken = yield* hostedAuthTokenStore.getToken;
            if (!isExpectedHostedShioriAuthToken(bootstrapAuthToken)) {
              return yield* Effect.fail(
                requestError(
                  "shiori.respondToRequest",
                  "Shiori account token is unavailable or invalid. Sign out and sign back in to continue.",
                ),
              );
            }
            const hostedBootstrap = yield* resolveHostedBootstrapForContext({
              threadId,
              authToken: bootstrapAuthToken,
            });
            yield* emitApprovalResolved({
              threadId,
              turnId: activeTurn.turnId,
              requestId,
              toolName: pending.toolName,
              ...(pending.requestKind ? { requestKind: pending.requestKind } : {}),
              decision,
            });

            if (decision === "cancel") {
              yield* finalizeInterruptedTurn(context, { resolvePendingRequests: true });
              return;
            }

            if (
              decision === "acceptForSession" &&
              pending.requestKind &&
              canPersistSessionApproval({
                toolName: pending.toolName,
                requestKind: pending.requestKind,
                bootstrap: hostedBootstrap,
              })
            ) {
              context.allowedRequestKinds.add(pending.requestKind);
            }

            const execution =
              decision === "decline"
                ? { state: "output-denied" as const }
                : yield* Effect.gen(function* () {
                    const mcpTool = activeTurn.mcpTools.get(pending.toolName);
                    if (mcpTool) {
                      return yield* Effect.promise(async () => {
                        try {
                          return {
                            state: "output-available" as const,
                            output: await mcpTool.execute(pending.input),
                          };
                        } catch (error) {
                          return {
                            state: "output-error" as const,
                            errorText: toMessage(error) || `MCP tool '${pending.toolName}' failed.`,
                          };
                        }
                      });
                    }
                    const attempt = yield* Effect.result(
                      executeLocalToolForTurn({
                        toolName: pending.toolName,
                        toolInput: pending.input,
                        cwd: context.session.cwd,
                        hostedBootstrap,
                        signal: activeTurn.controller.signal,
                      }),
                    );
                    if (attempt._tag === "Success") {
                      return attempt.success;
                    }
                    if (activeTurn.controller.signal.aborted) {
                      yield* finalizeInterruptedTurn(context);
                      return { state: "interrupted" as const };
                    }
                    return yield* Effect.fail(attempt.failure);
                  });

            if (execution.state === "interrupted") {
              return;
            }

            const nextToolPart = buildAssistantToolPart({
              messageId: pending.assistantMessageId,
              text: "",
              toolName: pending.toolName,
              toolCallId: pending.toolCallId,
              toolInput: pending.input,
              state: execution.state,
              ...(pending.approvalId ? { approvalId: pending.approvalId } : {}),
              ...(pending.callProviderMetadata !== undefined
                ? { callProviderMetadata: pending.callProviderMetadata }
                : {}),
              ...(execution.state === "output-available"
                ? { output: execution.output }
                : execution.state === "output-error"
                  ? { errorText: execution.errorText }
                  : {}),
            });
            yield* emitToolCompleted({
              threadId,
              turnId: context.activeTurn.turnId,
              toolName: pending.toolName,
              toolCallId: pending.toolCallId,
              toolInput: pending.input,
              status: execution.state === "output-error" ? "failed" : "completed",
              detail:
                execution.state === "output-error"
                  ? execution.errorText
                  : decision === "decline"
                    ? "Execution denied"
                    : pending.toolName === "exec_command"
                      ? String(pending.input.command ?? "")
                      : typeof pending.input.path === "string"
                        ? pending.input.path
                        : toolTitle(pending.toolName),
              data:
                execution.state === "output-available"
                  ? execution.output
                  : execution.state === "output-error"
                    ? { errorText: execution.errorText }
                    : undefined,
            });

            const updatedContext = yield* replaceToolPartInContext({
              threadId,
              messageId: pending.assistantMessageId,
              toolCallId: pending.toolCallId,
              nextToolPart,
              dropApprovalRequestId: requestId,
            });
            if (context.activeTurn.controller.signal.aborted) {
              yield* finalizeInterruptedTurn(yield* getContext(threadId));
              return;
            }
            if (
              updatedContext.pendingApprovals.size > 0 ||
              updatedContext.pendingUserInputs.size > 0
            ) {
              return;
            }
            const continuedController = new AbortController();
            yield* updateContext(threadId, (latest) => ({
              ...latest,
              activeTurn: latest.activeTurn
                ? {
                    ...latest.activeTurn,
                    controller: continuedController,
                  }
                : latest.activeTurn,
            }));
            const continuedContext = yield* getContext(threadId);
            // If an interrupt landed between the update above and this point, the turn
            // is already finalized. Skip the fork instead of spawning a duplicate stream.
            if (
              !continuedContext.activeTurn ||
              continuedController.signal.aborted ||
              (yield* isTurnFinalized(context.activeTurn.turnId))
            ) {
              return;
            }
            const continuedAuthToken = yield* hostedAuthTokenStore.getToken;
            if (!isExpectedHostedShioriAuthToken(continuedAuthToken)) {
              const detail =
                "Shiori account token is unavailable or invalid. Sign out and sign back in to continue.";
              yield* failTurn({
                context: continuedContext,
                detail,
              });
              return yield* Effect.fail(requestError("shiori.respondToRequest", detail));
            }
            const continuedTurnId = context.activeTurn.turnId;
            void Effect.runFork(
              runHostedTurn({
                context: continuedContext,
                turnId: continuedTurnId,
                requestMessages: updatedContext.messages,
                selectedModel: context.session.model ?? "openai/gpt-5.4",
                authToken: continuedAuthToken,
                controller: continuedController,
                assistantItemId: context.activeTurn.assistantItemId,
                resumeExistingTurn: true,
              }).pipe(
                Effect.catch((error) =>
                  finalizeFailedBackgroundTurn({
                    threadId,
                    turnId: continuedTurnId,
                    error,
                  }),
                ),
              ),
            );
          }),
        respondToUserInput: (threadId, requestId, answers) =>
          Effect.gen(function* () {
            const context = yield* getContext(threadId);
            const pending = context.pendingUserInputs.get(requestId);
            if (!pending || !context.activeTurn) {
              return yield* Effect.fail(
                requestError(
                  "shiori.respondToUserInput",
                  `Unknown pending user-input request: ${requestId}`,
                ),
              );
            }
            yield* emitUserInputResolved({
              threadId,
              turnId: context.activeTurn.turnId,
              requestId,
              answers,
            });
            const output = {
              answers,
            };
            const nextToolPart = buildAssistantToolPart({
              messageId: pending.assistantMessageId,
              text: "",
              toolName: pending.toolName,
              toolCallId: pending.toolCallId,
              toolInput: pending.input,
              state: "output-available",
              ...(pending.callProviderMetadata !== undefined
                ? { callProviderMetadata: pending.callProviderMetadata }
                : {}),
              output,
            });
            yield* emitToolCompleted({
              threadId,
              turnId: context.activeTurn.turnId,
              toolName: pending.toolName,
              toolCallId: pending.toolCallId,
              toolInput: pending.input,
              detail:
                typeof pending.input.question === "string" ? pending.input.question : "User input",
              data: output,
            });
            const updatedContext = yield* replaceToolPartInContext({
              threadId,
              messageId: pending.assistantMessageId,
              toolCallId: pending.toolCallId,
              nextToolPart,
              dropUserInputRequestId: requestId,
            });
            if (context.activeTurn.controller.signal.aborted) {
              yield* finalizeInterruptedTurn(yield* getContext(threadId));
              return;
            }
            if (
              updatedContext.pendingApprovals.size > 0 ||
              updatedContext.pendingUserInputs.size > 0
            ) {
              return;
            }
            const continuedController = new AbortController();
            yield* updateContext(threadId, (latest) => ({
              ...latest,
              activeTurn: latest.activeTurn
                ? {
                    ...latest.activeTurn,
                    controller: continuedController,
                  }
                : latest.activeTurn,
            }));
            const continuedContext = yield* getContext(threadId);
            // If an interrupt landed between the update above and this point, the turn
            // is already finalized. Skip the fork instead of spawning a duplicate stream.
            if (
              !continuedContext.activeTurn ||
              continuedController.signal.aborted ||
              (yield* isTurnFinalized(context.activeTurn.turnId))
            ) {
              return;
            }
            const continuedAuthToken = yield* hostedAuthTokenStore.getToken;
            if (!isExpectedHostedShioriAuthToken(continuedAuthToken)) {
              const detail =
                "Shiori account token is unavailable or invalid. Sign out and sign back in to continue.";
              yield* failTurn({
                context: continuedContext,
                detail,
              });
              return yield* Effect.fail(requestError("shiori.respondToUserInput", detail));
            }
            const continuedUserTurnId = context.activeTurn.turnId;
            void Effect.runFork(
              runHostedTurn({
                context: continuedContext,
                turnId: continuedUserTurnId,
                requestMessages: updatedContext.messages,
                selectedModel: context.session.model ?? "openai/gpt-5.4",
                authToken: continuedAuthToken,
                controller: continuedController,
                assistantItemId: context.activeTurn.assistantItemId,
                resumeExistingTurn: true,
              }).pipe(
                Effect.catch((error) =>
                  finalizeFailedBackgroundTurn({
                    threadId,
                    turnId: continuedUserTurnId,
                    error,
                  }),
                ),
              ),
            );
          }),
        stopSession: (threadId) =>
          Effect.gen(function* () {
            const context = yield* Ref.get(sessionsRef).pipe(
              Effect.map((sessions) => sessions.get(String(threadId)) ?? null),
            );
            if (context?.activeTurn) {
              yield* finalizeInterruptedTurn(context, { resolvePendingRequests: true });
            }
            if (context) {
              for (const subagent of context.subagents.values()) {
                subagent.currentRun?.controller.abort();
                if (!isSubagentTerminalStatus(subagent.status)) {
                  yield* emitSubagentTaskCompleted({
                    threadId,
                    taskId: subagent.id,
                    ...(subagent.parentTurnId ? { turnId: subagent.parentTurnId } : {}),
                    status: "stopped",
                    summary: "Session stopped.",
                    ...(subagent.parentToolUseId ? { toolUseId: subagent.parentToolUseId } : {}),
                  });
                }
              }
            }
            if (context) {
              yield* emitSessionExited({
                threadId,
                reason: "Session stopped.",
                exitKind: "graceful",
                recoverable: true,
              });
            }
            yield* closeSessionToolRuntime(context);
            yield* Ref.update(sessionsRef, (sessions) => {
              const next = new Map(sessions);
              next.delete(String(threadId));
              return next;
            });
          }),
        listSessions: () =>
          Ref.get(sessionsRef).pipe(
            Effect.map((sessions) =>
              Array.from(sessions.values()).map((context) => {
                const resumeCursor = computeResumeCursor(context);
                return resumeCursor
                  ? Object.assign({}, context.session, { resumeCursor })
                  : context.session;
              }),
            ),
          ),
        hasSession: (threadId) =>
          Ref.get(sessionsRef).pipe(Effect.map((sessions) => sessions.has(String(threadId)))),
        readThread: (threadId) =>
          getContext(threadId).pipe(
            Effect.map((context) => ({
              threadId,
              turns: context.turns.map(({ id, items }) => ({ id, items })),
            })),
          ),
        rollbackThread: (threadId, numTurns) =>
          Effect.gen(function* () {
            if (!Number.isInteger(numTurns) || numTurns < 1) {
              return yield* Effect.fail(
                new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "rollbackThread",
                  issue: "numTurns must be an integer >= 1.",
                }),
              );
            }

            const context = yield* getContext(threadId);
            if (context.activeTurn) {
              return yield* Effect.fail(
                requestError(
                  "shiori.rollbackThread",
                  "Cannot rollback a Shiori thread while a turn is still running.",
                ),
              );
            }
            const nextTurns = context.turns.slice(0, Math.max(0, context.turns.length - numTurns));
            const nextMessageCount =
              nextTurns.length === 0
                ? 0
                : Math.min(
                    nextTurns[nextTurns.length - 1]?.messageCount ?? 0,
                    context.messages.length,
                  );
            const nextContext = withResumeCursor({
              ...context,
              messages: context.messages.slice(0, nextMessageCount),
              turns: nextTurns,
              session: {
                ...context.session,
                updatedAt: nowIso(),
              },
            });
            yield* setContext(threadId, nextContext);
            yield* persistContext(nextContext);
            return {
              threadId,
              turns: nextContext.turns.map(({ id, items }) => ({ id, items })),
            };
          }),
        stopAll: () =>
          Effect.gen(function* () {
            const contexts = Array.from((yield* Ref.get(sessionsRef)).values());
            yield* Effect.forEach(contexts, (context) =>
              context.activeTurn
                ? finalizeInterruptedTurn(context, { resolvePendingRequests: true })
                : Effect.void,
            ).pipe(Effect.asVoid);
            yield* Effect.forEach(contexts, (context) =>
              Effect.forEach(Array.from(context.subagents.values()), (subagent) =>
                Effect.gen(function* () {
                  subagent.currentRun?.controller.abort();
                  if (!isSubagentTerminalStatus(subagent.status)) {
                    yield* emitSubagentTaskCompleted({
                      threadId: context.session.threadId,
                      taskId: subagent.id,
                      ...(subagent.parentTurnId ? { turnId: subagent.parentTurnId } : {}),
                      status: "stopped",
                      summary: "All sessions stopped.",
                      ...(subagent.parentToolUseId ? { toolUseId: subagent.parentToolUseId } : {}),
                    });
                  }
                }),
              ),
            ).pipe(Effect.asVoid);
            yield* Effect.forEach(contexts, (context) =>
              emitSessionExited({
                threadId: context.session.threadId,
                reason: "All sessions stopped.",
                exitKind: "graceful",
                recoverable: true,
              }),
            ).pipe(Effect.asVoid);
            yield* Effect.forEach(contexts, (context) => closeSessionToolRuntime(context)).pipe(
              Effect.asVoid,
            );
            yield* Ref.set(sessionsRef, new Map()).pipe(Effect.asVoid);
          }),
        streamEvents: Stream.fromPubSub(eventsPubSub),
      };
    }),
  );

export const ShioriAdapterLive = makeShioriAdapter();

export function makeShioriAdapterLive(options?: ShioriAdapterLiveOptions) {
  return makeShioriAdapter(options);
}

function toMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
}
