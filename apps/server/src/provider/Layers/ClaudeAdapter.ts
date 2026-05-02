/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import path from "node:path";

import {
  AbortError,
  type CanUseTool,
  query,
  type Options as ClaudeQueryOptions,
  type McpServerConfig as ClaudeMcpServerConfig,
  type McpStdioServerConfig,
  type McpSSEServerConfig,
  type McpHttpServerConfig,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKResultMessage,
  type SettingSource,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  type ProviderApprovalDecision,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  type RuntimeContentStreamKind,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
  ClaudeCodeEffort,
  type McpServerEntry,
} from "contracts";
import {
  applyClaudePromptEffortPrefix,
  resolveApiModelId,
  resolveEffort,
  trimOrNull,
} from "shared/model";
import {
  classifyProviderToolLifecycleItemType,
  classifyProviderToolRequestKind,
  providerToolTitle,
  summarizeProviderToolInvocation,
} from "shared/providerTool";
import {
  Cause,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Queue,
  Random,
  Ref,
  Stream,
} from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { buildAssistantSettingsAppendix } from "../../assistantPersonality.ts";
import { ServerConfig } from "../../config.ts";
import { fetchClaudeUsageSnapshot } from "../claudeUsage.ts";
import { isSimpleApprovalDecision } from "../providerApprovalDecision.ts";
import { isClaudeMissingConversationErrorMessage } from "../claudeConversationErrors.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { getClaudeModelCapabilities } from "./ClaudeProvider.ts";
import { filterMcpServersForProvider, materializeMcpServersForRuntime } from "../mcpServers.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { ClaudeAdapter, type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import type { ClaudeUsageSnapshot } from "../Services/ProviderUsage.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "claudeAgent" as const;
type ClaudeTextStreamKind = Extract<RuntimeContentStreamKind, "assistant_text" | "reasoning_text">;
type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  "command_output" | "file_change_output"
>;

type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

interface ClaudeResumeState {
  readonly threadId?: ThreadId;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
}

interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly items: Array<unknown>;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>;
  readonly capturedProposedPlanKeys: Set<string>;
  nextSyntheticAssistantBlockIndex: number;
  // Captured from the first user-type SDKMessage we see on this turn when
  // file checkpointing is enabled. Used as the checkpoint id for rewindFiles.
  checkpointUuid?: string;
}

interface AssistantTextBlockState {
  readonly itemId: string;
  readonly blockIndex: number;
  readonly streamKind: ClaudeTextStreamKind;
  readonly runtimeItemType: "assistant_message" | "reasoning";
  readonly title: string;
  emittedTextDelta: boolean;
  fallbackText: string;
  streamClosed: boolean;
  completionEmitted: boolean;
}

interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface ToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
  readonly partialInputJson: string;
  readonly lastEmittedInputFingerprint?: string;
}

interface SubagentToolCandidate {
  readonly itemId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

interface ClaudeSessionContext {
  session: ProviderSession;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  readonly basePermissionMode: PermissionMode | undefined;
  currentApiModelId: string | undefined;
  resumeSessionId: string | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{
    id: TurnId;
    items: Array<unknown>;
    // First user message UUID observed for this turn. Used as the checkpoint
    // id for SDK file-rewind when file checkpointing is enabled.
    checkpointUuid?: string;
  }>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  readonly subagentToolCandidates: Map<string, SubagentToolCandidate>;
  readonly subagentTaskParentToolIds: Map<string, string>;
  turnState: ClaudeTurnState | undefined;
  lastKnownContextWindow: number | undefined;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  stopped: boolean;
  // Set before calling query.interrupt() and before tearing a session down so
  // late approval/user-input responders can fail fast instead of racing with
  // teardown. Same reason applies to unblocking canUseTool deferreds.
  interrupting: boolean;
}

interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly close: () => void;
  readonly rewindFiles?: (userMessageUuid: string) => Promise<unknown>;
}

export interface ClaudeAdapterLiveOptions {
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly fetchUsage?: (input?: { readonly signal?: AbortSignal }) => Promise<ClaudeUsageSnapshot>;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  // Max time a canUseTool approval or user-input question can wait for the UI
  // before we auto-decline / auto-answer-empty. Prevents pending deferreds from
  // leaking forever when the UI disconnects mid-request.
  readonly approvalWaitTimeout?: Duration.Input;
  // Max time to wait for `context.query.close()` to resolve before we log a
  // warning and move on. Prevents a hung SDK child from stalling session stop.
  readonly queryCloseTimeout?: Duration.Input;
  // Opt-in: enable SDK file checkpointing so rollbackThread can call
  // rewindFiles and keep on-disk state in sync with the in-memory turn trim.
  // Off by default to avoid surprising users who don't expect their files to
  // be mutated on rollback.
  readonly enableFileCheckpointing?: boolean;
}

function translateToClaudeMcpConfig(
  entry: McpServerEntry,
): McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig {
  switch (entry.transport) {
    case "stdio":
      return {
        type: "stdio",
        command: entry.command ?? "",
        ...(entry.args ? { args: [...entry.args] } : {}),
        ...(entry.env ? { env: { ...entry.env } } : {}),
      } satisfies McpStdioServerConfig;
    case "sse":
      return {
        type: "sse",
        url: entry.url ?? "",
        ...(entry.headers ? { headers: { ...entry.headers } } : {}),
      } satisfies McpSSEServerConfig;
    case "http":
      return {
        type: "http",
        url: entry.url ?? "",
        ...(entry.headers ? { headers: { ...entry.headers } } : {}),
      } satisfies McpHttpServerConfig;
  }
}

function buildClaudeMcpServers(
  servers: readonly McpServerEntry[],
): Record<string, ClaudeMcpServerConfig> | undefined {
  const result: Record<string, ClaudeMcpServerConfig> = {};
  for (const server of filterMcpServersForProvider("claudeAgent", servers)) {
    result[server.name] = translateToClaudeMcpConfig(server);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSyntheticClaudeThreadId(value: string): boolean {
  return value.startsWith("claude-thread-");
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(toMessage(cause, fallback));
}

function normalizeClaudeStreamMessages(cause: Cause.Cause<Error>): ReadonlyArray<string> {
  const errors = Cause.prettyErrors(cause)
    .map((error) => error.message.trim())
    .filter((message) => message.length > 0);
  if (errors.length > 0) {
    return errors;
  }

  const squashed = toMessage(Cause.squash(cause), "").trim();
  return squashed.length > 0 ? [squashed] : [];
}

function getEffectiveClaudeCodeEffort(
  effort: ClaudeCodeEffort | null | undefined,
): Exclude<ClaudeCodeEffort, "ultrathink"> | null {
  if (!effort) {
    return null;
  }
  return effort === "ultrathink" ? null : effort;
}

function isClaudeInterruptedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("all fibers interrupted without error") ||
    normalized.includes("request was aborted") ||
    normalized.includes("interrupted by user")
  );
}

// Prefer the SDK's typed AbortError so we can distinguish a real user interrupt
// from a coincidental error message containing the word "interrupted".
function causeContainsAbortError(cause: Cause.Cause<Error>): boolean {
  const squashed = Cause.squash(cause);
  if (squashed instanceof AbortError) {
    return true;
  }
  for (const error of Cause.prettyErrors(cause)) {
    if (error instanceof AbortError) {
      return true;
    }
    const nested = (error as Error & { cause?: unknown }).cause;
    if (nested instanceof AbortError) {
      return true;
    }
  }
  return false;
}

function isClaudeInterruptedCause(cause: Cause.Cause<Error>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) ||
    causeContainsAbortError(cause) ||
    normalizeClaudeStreamMessages(cause).some(isClaudeInterruptedMessage)
  );
}

// Errors that look like a transient hiccup the UI should be able to retry
// (network drops, gateway timeouts, rate limits) rather than a permanent
// provider failure. We use this to flag `recoverable: true` on session exit
// so the UI can reopen the session against the same resume cursor instead of
// showing a fatal error.
function isTransientClaudeFailureMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("econnreset") ||
    normalized.includes("econnrefused") ||
    normalized.includes("etimedout") ||
    normalized.includes("enetunreach") ||
    normalized.includes("socket hang up") ||
    normalized.includes("fetch failed") ||
    normalized.includes("network error") ||
    normalized.includes("overloaded") ||
    normalized.includes("rate_limit") ||
    normalized.includes("rate limit") ||
    normalized.includes("timeout") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("server_error")
  );
}

function isTransientClaudeFailureCause(cause: Cause.Cause<Error>): boolean {
  return normalizeClaudeStreamMessages(cause).some(isTransientClaudeFailureMessage);
}

function messageFromClaudeStreamCause(cause: Cause.Cause<Error>, fallback: string): string {
  return normalizeClaudeStreamMessages(cause)[0] ?? fallback;
}

function interruptionMessageFromClaudeCause(cause: Cause.Cause<Error>): string {
  const message = messageFromClaudeStreamCause(cause, "Claude runtime interrupted.");
  return isClaudeInterruptedMessage(message) ? "Claude runtime interrupted." : message;
}

function resultErrorsText(result: SDKResultMessage): string {
  return "errors" in result && Array.isArray(result.errors)
    ? result.errors.join(" ").toLowerCase()
    : "";
}

function isInterruptedResult(result: SDKResultMessage): boolean {
  const errors = resultErrorsText(result);
  if (errors.includes("interrupt")) {
    return true;
  }

  if (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    result.stop_reason === "tool_use"
  ) {
    return true;
  }

  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    (errors.includes("request was aborted") ||
      errors.includes("interrupted by user") ||
      errors.includes("aborted"))
  );
}

function shouldSuppressResultErrorMessage(result: SDKResultMessage): boolean {
  const errors = resultErrorsText(result);
  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    result.stop_reason === "tool_use" &&
    (errors.includes("ede_diagnostic") || errors.includes("lede_diagnostic"))
  );
}

function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(value);
}

function maxClaudeContextWindowFromModelUsage(modelUsage: unknown): number | undefined {
  if (!modelUsage || typeof modelUsage !== "object") {
    return undefined;
  }

  let maxContextWindow: number | undefined;
  for (const value of Object.values(modelUsage as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const contextWindow = (value as { contextWindow?: unknown }).contextWindow;
    if (
      typeof contextWindow !== "number" ||
      !Number.isFinite(contextWindow) ||
      contextWindow <= 0
    ) {
      continue;
    }
    maxContextWindow = Math.max(maxContextWindow ?? 0, contextWindow);
  }

  return maxContextWindow;
}

function normalizeClaudeTokenUsage(
  usage: unknown,
  contextWindow?: number,
): ThreadTokenUsageSnapshot | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const record = usage as Record<string, unknown>;
  const directUsedTokens =
    typeof record.total_tokens === "number" && Number.isFinite(record.total_tokens)
      ? record.total_tokens
      : undefined;
  const inputTokens =
    (typeof record.input_tokens === "number" && Number.isFinite(record.input_tokens)
      ? record.input_tokens
      : 0) +
    (typeof record.cache_creation_input_tokens === "number" &&
    Number.isFinite(record.cache_creation_input_tokens)
      ? record.cache_creation_input_tokens
      : 0) +
    (typeof record.cache_read_input_tokens === "number" &&
    Number.isFinite(record.cache_read_input_tokens)
      ? record.cache_read_input_tokens
      : 0);
  const outputTokens =
    typeof record.output_tokens === "number" && Number.isFinite(record.output_tokens)
      ? record.output_tokens
      : 0;
  const derivedUsedTokens = inputTokens + outputTokens;
  const usedTokens = directUsedTokens ?? (derivedUsedTokens > 0 ? derivedUsedTokens : undefined);
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? { maxTokens: contextWindow }
      : {}),
    ...(typeof record.tool_uses === "number" && Number.isFinite(record.tool_uses)
      ? { toolUses: record.tool_uses }
      : {}),
    ...(typeof record.duration_ms === "number" && Number.isFinite(record.duration_ms)
      ? { durationMs: record.duration_ms }
      : {}),
  };
}

function asCanonicalTurnId(value: TurnId): TurnId {
  return value;
}

function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(value);
}

function readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as {
    threadId?: unknown;
    resume?: unknown;
    sessionId?: unknown;
    resumeSessionAt?: unknown;
    turnCount?: unknown;
  };

  const threadIdCandidate = typeof cursor.threadId === "string" ? cursor.threadId : undefined;
  const threadId =
    threadIdCandidate && !isSyntheticClaudeThreadId(threadIdCandidate)
      ? ThreadId.makeUnsafe(threadIdCandidate)
      : undefined;
  const resumeCandidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;
  const resume = resumeCandidate && isUuid(resumeCandidate) ? resumeCandidate : undefined;
  const resumeSessionAt =
    typeof cursor.resumeSessionAt === "string" ? cursor.resumeSessionAt : undefined;
  const turnCountValue = typeof cursor.turnCount === "number" ? cursor.turnCount : undefined;

  return {
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnCountValue !== undefined && Number.isInteger(turnCountValue) && turnCountValue >= 0
      ? { turnCount: turnCountValue }
      : {}),
  };
}

function classifyToolItemType(toolName: string): CanonicalItemType {
  return classifyProviderToolLifecycleItemType(toolName);
}

function classifyRequestType(toolName: string): CanonicalRequestType {
  const requestKind = classifyProviderToolRequestKind(toolName);
  return requestKind === "file-read"
    ? "file_read_approval"
    : requestKind === "command"
      ? "command_execution_approval"
      : requestKind === "file-change"
        ? "file_change_approval"
        : "dynamic_tool_call";
}

function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  return summarizeProviderToolInvocation(toolName, input) ?? providerToolTitle(toolName);
}

function asTrimmedUnknownString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isSubagentToolCandidate(tool: ToolInFlight): boolean {
  return tool.itemType === "collab_agent_tool_call";
}

function subagentToolTaskType(input: Record<string, unknown>): string | undefined {
  return (
    asTrimmedUnknownString(input.subagent_type) ??
    asTrimmedUnknownString(input.subagentType) ??
    asTrimmedUnknownString(input.agent_type) ??
    asTrimmedUnknownString(input.agentType)
  );
}

function subagentToolDescription(input: Record<string, unknown>): string | undefined {
  return (
    asTrimmedUnknownString(input.description) ??
    asTrimmedUnknownString(input.task) ??
    asTrimmedUnknownString(input.title) ??
    asTrimmedUnknownString(input.prompt) ??
    asTrimmedUnknownString(input.message)
  );
}

function normalizeMatchString(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function scoreSubagentToolCandidate(candidate: SubagentToolCandidate, message: SDKMessage): number {
  if (message.type !== "system") {
    return 0;
  }

  const record = message as unknown as Record<string, unknown>;
  const messageTaskType = normalizeMatchString(asTrimmedUnknownString(record.task_type));
  const messageDescription = normalizeMatchString(asTrimmedUnknownString(record.description));
  const candidateTaskType = normalizeMatchString(subagentToolTaskType(candidate.input));
  const candidateDescription = normalizeMatchString(subagentToolDescription(candidate.input));
  let score = 0;

  if (messageTaskType && candidateTaskType && messageTaskType === candidateTaskType) {
    score += 4;
  }
  if (messageDescription && candidateDescription && messageDescription === candidateDescription) {
    score += 6;
  }

  return score;
}

function inferClaudeTaskParentToolUseId(
  context: ClaudeSessionContext,
  message: SDKMessage,
): string | undefined {
  if (message.type !== "system") {
    return undefined;
  }

  const record = message as unknown as Record<string, unknown>;
  const explicitToolUseId =
    asTrimmedUnknownString(record.tool_use_id) ?? asTrimmedUnknownString(record.parent_tool_use_id);
  const taskId = asTrimmedUnknownString(record.task_id);
  if (explicitToolUseId) {
    if (taskId) {
      context.subagentTaskParentToolIds.set(taskId, explicitToolUseId);
    }
    return explicitToolUseId;
  }

  if (taskId) {
    const cached = context.subagentTaskParentToolIds.get(taskId);
    if (cached) {
      return cached;
    }
  }

  let bestCandidate: SubagentToolCandidate | undefined;
  let bestScore = 0;
  for (const candidate of context.subagentToolCandidates.values()) {
    const score = scoreSubagentToolCandidate(candidate, message);
    if (score > bestScore) {
      bestCandidate = candidate;
      bestScore = score;
    }
  }

  const inferred =
    bestCandidate && bestScore > 0
      ? bestCandidate.itemId
      : context.subagentToolCandidates.size === 1
        ? Array.from(context.subagentToolCandidates.values())[0]?.itemId
        : undefined;
  if (taskId && inferred) {
    context.subagentTaskParentToolIds.set(taskId, inferred);
  }
  return inferred;
}

function withClaudeTaskParentToolUseId(
  message: SDKMessage,
  parentToolUseId: string | undefined,
): SDKMessage | Record<string, unknown> {
  if (!parentToolUseId || typeof message !== "object" || message === null) {
    return message;
  }
  return {
    ...(message as unknown as Record<string, unknown>),
    tool_use_id: parentToolUseId,
  };
}

function inferClaudeTaskType(
  context: ClaudeSessionContext,
  message: SDKMessage,
  parentToolUseId: string | undefined,
): string | undefined {
  if (message.type !== "system") {
    return undefined;
  }
  const record = message as unknown as Record<string, unknown>;
  return (
    asTrimmedUnknownString(record.task_type) ??
    (parentToolUseId
      ? subagentToolTaskType(context.subagentToolCandidates.get(parentToolUseId)?.input ?? {})
      : undefined)
  );
}

function titleForTool(itemType: CanonicalItemType, toolName?: string): string {
  if (toolName) {
    return providerToolTitle(toolName);
  }

  switch (itemType) {
    case "command_execution":
      return "Run command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const CLAUDE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

function buildPromptText(input: ProviderSendTurnInput): string {
  const rawEffort =
    input.modelSelection?.provider === "claudeAgent" ? input.modelSelection.options?.effort : null;
  const claudeModel =
    input.modelSelection?.provider === "claudeAgent" ? input.modelSelection.model : undefined;
  const caps = getClaudeModelCapabilities(claudeModel);

  // For prompt injection, we check if the raw effort is a prompt-injected level (e.g. "ultrathink").
  // resolveEffort strips prompt-injected values (returning the default instead), so we check the raw value directly.
  const trimmedEffort = trimOrNull(rawEffort);
  const promptEffort =
    trimmedEffort && caps.promptInjectedEffortLevels.includes(trimmedEffort) ? trimmedEffort : null;
  return applyClaudePromptEffortPrefix(input.input?.trim() ?? "", promptEffort);
}

function buildUserMessage(input: {
  readonly sdkContent: Array<Record<string, unknown>>;
}): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: input.sdkContent as unknown as SDKUserMessage["message"]["content"],
    },
  } as SDKUserMessage;
}

function buildClaudeImageContentBlock(input: {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): Record<string, unknown> {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: input.mimeType,
      data: Buffer.from(input.bytes).toString("base64"),
    },
  };
}

const buildUserMessageEffect = Effect.fn("buildUserMessageEffect")(function* (
  input: ProviderSendTurnInput,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly attachmentsDir: string;
  },
) {
  const text = buildPromptText(input);
  const sdkContent: Array<Record<string, unknown>> = [];

  if (text.length > 0) {
    sdkContent.push({ type: "text", text });
  }

  for (const attachment of input.attachments ?? []) {
    if (attachment.type !== "image") {
      continue;
    }

    if (!SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Unsupported Claude image attachment type '${attachment.mimeType}'.`,
      });
    }

    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: dependencies.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }

    const bytes = yield* dependencies.fileSystem.readFile(attachmentPath).pipe(
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

    sdkContent.push(
      buildClaudeImageContentBlock({
        mimeType: attachment.mimeType,
        bytes,
      }),
    );
  }

  return buildUserMessage({ sdkContent });
});

function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus {
  if (result.subtype === "success") {
    return "completed";
  }

  const errors = resultErrorsText(result);
  if (isInterruptedResult(result)) {
    return "interrupted";
  }
  if (errors.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

function streamKindFromDeltaType(deltaType: string): ClaudeTextStreamKind {
  return deltaType.includes("thinking") ? "reasoning_text" : "assistant_text";
}

function nativeProviderRefs(
  _context: ClaudeSessionContext,
  options?: {
    readonly providerItemId?: string | undefined;
  },
): NonNullable<ProviderRuntimeEvent["providerRefs"]> {
  if (options?.providerItemId) {
    return {
      providerItemId: ProviderItemId.makeUnsafe(options.providerItemId),
    };
  }
  return {};
}

function extractAssistantTextBlocks(message: SDKMessage): Array<string> {
  if (message.type !== "assistant") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const fragments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (
      candidate.type === "text" &&
      typeof candidate.text === "string" &&
      candidate.text.length > 0
    ) {
      fragments.push(candidate.text);
    }
  }

  return fragments;
}

function extractContentBlockText(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }

  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => extractTextContent(entry)).join("");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    content?: unknown;
  };

  if (typeof record.text === "string") {
    return record.text;
  }

  return extractTextContent(record.content);
}

function extractExitPlanModePlan(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    plan?: unknown;
  };
  return typeof record.plan === "string" && record.plan.trim().length > 0
    ? record.plan.trim()
    : undefined;
}

function exitPlanCaptureKey(input: {
  readonly toolUseId?: string | undefined;
  readonly planMarkdown: string;
}): string {
  return input.toolUseId && input.toolUseId.length > 0
    ? `tool:${input.toolUseId}`
    : `plan:${input.planMarkdown}`;
}

function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function toolInputFingerprint(input: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(input);
  } catch {
    return undefined;
  }
}

function toolResultStreamKind(itemType: CanonicalItemType): ClaudeToolResultStreamKind | undefined {
  switch (itemType) {
    case "command_execution":
      return "command_output";
    case "file_change":
      return "file_change_output";
    default:
      return undefined;
  }
}

function toolResultBlocksFromUserMessage(message: SDKMessage): Array<{
  readonly toolUseId: string;
  readonly block: Record<string, unknown>;
  readonly text: string;
  readonly isError: boolean;
}> {
  if (message.type !== "user") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: Array<{
    readonly toolUseId: string;
    readonly block: Record<string, unknown>;
    readonly text: string;
    readonly isError: boolean;
  }> = [];

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const block = entry as Record<string, unknown>;
    if (block.type !== "tool_result") {
      continue;
    }

    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    if (!toolUseId) {
      continue;
    }

    blocks.push({
      toolUseId,
      block,
      text: extractTextContent(block.content),
      isError: block.is_error === true,
    });
  }

  return blocks;
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function sdkMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { type?: unknown };
  return typeof record.type === "string" ? record.type : undefined;
}

function sdkMessageSubtype(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { subtype?: unknown };
  return typeof record.subtype === "string" ? record.subtype : undefined;
}

function sdkNativeMethod(message: SDKMessage): string {
  const subtype = sdkMessageSubtype(message);
  if (subtype) {
    return `claude/${message.type}/${subtype}`;
  }

  if (message.type === "stream_event") {
    const streamType = sdkMessageType(message.event);
    if (streamType) {
      const deltaType =
        streamType === "content_block_delta"
          ? sdkMessageType((message.event as { delta?: unknown }).delta)
          : undefined;
      if (deltaType) {
        return `claude/${message.type}/${streamType}/${deltaType}`;
      }
      return `claude/${message.type}/${streamType}`;
    }
  }

  return `claude/${message.type}`;
}

function sdkNativeItemId(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    const maybeId = (message.message as { id?: unknown }).id;
    if (typeof maybeId === "string") {
      return maybeId;
    }
    return undefined;
  }

  if (message.type === "user") {
    return toolResultBlocksFromUserMessage(message)[0]?.toolUseId;
  }

  if (message.type === "stream_event") {
    const event = message.event as {
      type?: unknown;
      content_block?: { id?: unknown };
    };
    if (event.type === "content_block_start" && typeof event.content_block?.id === "string") {
      return event.content_block.id;
    }
  }

  return undefined;
}

const makeClaudeAdapter = Effect.fn("makeClaudeAdapter")(function* (
  options?: ClaudeAdapterLiveOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);

  const createQuery =
    options?.createQuery ??
    ((input: {
      readonly prompt: AsyncIterable<SDKUserMessage>;
      readonly options: ClaudeQueryOptions;
    }) => query({ prompt: input.prompt, options: input.options }) as ClaudeQueryRuntime);

  // 10 minutes default: long enough for a human to pick up the tab and click
  // approve, short enough that an abandoned tab doesn't leak a deferred forever.
  const approvalWaitTimeout: Duration.Input = options?.approvalWaitTimeout ?? "10 minutes";
  // 5 seconds default for SDK query.close() before we log and move on.
  const queryCloseTimeout: Duration.Input = options?.queryCloseTimeout ?? "5 seconds";
  const fileCheckpointingEnabled = options?.enableFileCheckpointing === true;

  const sessions = new Map<ThreadId, ClaudeSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const serverSettingsService = yield* ServerSettingsService;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const logNativeSdkMessage = Effect.fn("logNativeSdkMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (!nativeEventLogger) {
      return;
    }

    const observedAt = new Date().toISOString();
    const itemId = sdkNativeItemId(message);

    yield* nativeEventLogger.write(
      {
        observedAt,
        event: {
          id:
            "uuid" in message && typeof message.uuid === "string"
              ? message.uuid
              : crypto.randomUUID(),
          kind: "notification",
          provider: PROVIDER,
          createdAt: observedAt,
          method: sdkNativeMethod(message),
          ...(typeof message.session_id === "string"
            ? { providerThreadId: message.session_id }
            : {}),
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          ...(itemId ? { itemId: ProviderItemId.makeUnsafe(itemId) } : {}),
          payload: message,
        },
      },
      context.session.threadId,
    );
  });

  const snapshotThread = Effect.fn("snapshotThread")(function* (context: ClaudeSessionContext) {
    const threadId = context.session.threadId;
    if (!threadId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "readThread",
        issue: "Session thread id is not initialized yet.",
      });
    }
    return {
      threadId,
      turns: context.turns.map((turn) => ({
        id: turn.id,
        items: [...turn.items],
      })),
    };
  });

  const updateResumeCursor = Effect.fn("updateResumeCursor")(function* (
    context: ClaudeSessionContext,
  ) {
    const threadId = context.session.threadId;
    if (!threadId) return;

    const resumeCursor = {
      threadId,
      ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
      ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
      turnCount: context.turns.length,
    };

    context.session = {
      ...context.session,
      resumeCursor,
      updatedAt: yield* nowIso,
    };
  });

  const ensureAssistantTextBlock = Effect.fn("ensureAssistantTextBlock")(function* (
    context: ClaudeSessionContext,
    blockIndex: number,
    options?: {
      readonly fallbackText?: string;
      readonly streamClosed?: boolean;
      readonly streamKind?: ClaudeTextStreamKind;
      readonly runtimeItemType?: "assistant_message" | "reasoning";
      readonly title?: string;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState) {
      return undefined;
    }

    const existing = turnState.assistantTextBlocks.get(blockIndex);
    if (existing && !existing.completionEmitted) {
      if (existing.fallbackText.length === 0 && options?.fallbackText) {
        existing.fallbackText = options.fallbackText;
      }
      if (options?.streamClosed) {
        existing.streamClosed = true;
      }
      return { blockIndex, block: existing };
    }

    const block: AssistantTextBlockState = {
      itemId: yield* Random.nextUUIDv4,
      blockIndex,
      streamKind: options?.streamKind ?? "assistant_text",
      runtimeItemType: options?.runtimeItemType ?? "assistant_message",
      title: options?.title ?? "Assistant message",
      emittedTextDelta: false,
      fallbackText: options?.fallbackText ?? "",
      streamClosed: options?.streamClosed ?? false,
      completionEmitted: false,
    };
    turnState.assistantTextBlocks.set(blockIndex, block);
    turnState.assistantTextBlockOrder.push(block);
    return { blockIndex, block };
  });

  const createSyntheticAssistantTextBlock = Effect.fn("createSyntheticAssistantTextBlock")(
    function* (context: ClaudeSessionContext, fallbackText: string) {
      const turnState = context.turnState;
      if (!turnState) {
        return undefined;
      }

      const blockIndex = turnState.nextSyntheticAssistantBlockIndex;
      turnState.nextSyntheticAssistantBlockIndex -= 1;
      return yield* ensureAssistantTextBlock(context, blockIndex, {
        fallbackText,
        streamClosed: true,
      });
    },
  );

  const completeAssistantTextBlock = Effect.fn("completeAssistantTextBlock")(function* (
    context: ClaudeSessionContext,
    block: AssistantTextBlockState,
    options?: {
      readonly force?: boolean;
      readonly rawMethod?: string;
      readonly rawPayload?: unknown;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState || block.completionEmitted) {
      return;
    }

    if (!options?.force && !block.streamClosed) {
      return;
    }

    if (!block.emittedTextDelta && block.fallbackText.length > 0) {
      const deltaStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "content.delta",
        eventId: deltaStamp.eventId,
        provider: PROVIDER,
        createdAt: deltaStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(block.itemId),
        payload: {
          streamKind: block.streamKind,
          delta: block.fallbackText,
        },
        providerRefs: nativeProviderRefs(context),
        ...(options?.rawMethod || options?.rawPayload
          ? {
              raw: {
                source: "claude.sdk.message" as const,
                ...(options.rawMethod ? { method: options.rawMethod } : {}),
                payload: options?.rawPayload,
              },
            }
          : {}),
      });
    }

    block.completionEmitted = true;
    if (turnState.assistantTextBlocks.get(block.blockIndex) === block) {
      turnState.assistantTextBlocks.delete(block.blockIndex);
    }

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "item.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      itemId: asRuntimeItemId(block.itemId),
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        itemType: block.runtimeItemType,
        status: "completed",
        title: block.title,
        ...(block.fallbackText.length > 0 ? { detail: block.fallbackText } : {}),
      },
      providerRefs: nativeProviderRefs(context),
      ...(options?.rawMethod || options?.rawPayload
        ? {
            raw: {
              source: "claude.sdk.message" as const,
              ...(options.rawMethod ? { method: options.rawMethod } : {}),
              payload: options?.rawPayload,
            },
          }
        : {}),
    });
  });

  const backfillAssistantTextBlocksFromSnapshot = Effect.fn(
    "backfillAssistantTextBlocksFromSnapshot",
  )(function* (context: ClaudeSessionContext, message: SDKMessage) {
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }

    const snapshotTextBlocks = extractAssistantTextBlocks(message);
    if (snapshotTextBlocks.length === 0) {
      return;
    }

    const orderedBlocks = turnState.assistantTextBlockOrder
      .filter((block) => block.runtimeItemType === "assistant_message")
      .map((block) => ({
        blockIndex: block.blockIndex,
        block,
      }));

    for (const [position, text] of snapshotTextBlocks.entries()) {
      const existingEntry = orderedBlocks[position];
      const entry =
        existingEntry ??
        (yield* createSyntheticAssistantTextBlock(context, text).pipe(
          Effect.map((created) => {
            if (!created) {
              return undefined;
            }
            orderedBlocks.push(created);
            return created;
          }),
        ));
      if (!entry) {
        continue;
      }

      if (entry.block.fallbackText.length === 0) {
        entry.block.fallbackText = text;
      }

      if (entry.block.streamClosed && !entry.block.completionEmitted) {
        yield* completeAssistantTextBlock(context, entry.block, {
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
      }
    }
  });

  const ensureThreadId = Effect.fn("ensureThreadId")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (
      message.type !== "system" ||
      message.subtype !== "init" ||
      typeof message.session_id !== "string" ||
      message.session_id.length === 0
    ) {
      return;
    }
    const nextThreadId = message.session_id;
    context.resumeSessionId = message.session_id;
    yield* updateResumeCursor(context);

    if (context.lastThreadStartedId !== nextThreadId) {
      context.lastThreadStartedId = nextThreadId;
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "thread.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          providerThreadId: nextThreadId,
        },
        providerRefs: {},
        raw: {
          source: "claude.sdk.message",
          method: "claude/thread/started",
          payload: {
            session_id: message.session_id,
          },
        },
      });
    }
  });

  const emitRuntimeError = Effect.fn("emitRuntimeError")(function* (
    context: ClaudeSessionContext,
    message: string,
    cause?: unknown,
  ) {
    if (cause !== undefined) {
      void cause;
    }
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "runtime.error",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        class: "provider_error",
        ...(cause !== undefined ? { detail: cause } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitRuntimeWarning = Effect.fn("emitRuntimeWarning")(function* (
    context: ClaudeSessionContext,
    message: string,
    detail?: unknown,
  ) {
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "runtime.warning",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        ...(detail !== undefined ? { detail } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitProposedPlanCompleted = Effect.fn("emitProposedPlanCompleted")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly planMarkdown: string;
      readonly toolUseId?: string | undefined;
      readonly rawSource: "claude.sdk.message" | "claude.sdk.permission";
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) {
    const turnState = context.turnState;
    const planMarkdown = input.planMarkdown.trim();
    if (!turnState || planMarkdown.length === 0) {
      return;
    }

    const captureKey = exitPlanCaptureKey({
      toolUseId: input.toolUseId,
      planMarkdown,
    });
    if (turnState.capturedProposedPlanKeys.has(captureKey)) {
      return;
    }
    turnState.capturedProposedPlanKeys.add(captureKey);

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        planMarkdown,
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: input.toolUseId,
      }),
      raw: {
        source: input.rawSource,
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    });
  });

  const completeTurn = Effect.fn("completeTurn")(function* (
    context: ClaudeSessionContext,
    status: ProviderRuntimeTurnStatus,
    errorMessage?: string,
    result?: SDKResultMessage,
  ) {
    const resultUsage =
      result?.usage && typeof result.usage === "object" ? { ...result.usage } : undefined;
    const resultContextWindow = maxClaudeContextWindowFromModelUsage(result?.modelUsage);
    if (resultContextWindow !== undefined) {
      context.lastKnownContextWindow = resultContextWindow;
    }

    // The SDK result.usage contains *accumulated* totals across all API calls
    // (input_tokens, cache_read_input_tokens, etc. summed over every request).
    // This does NOT represent the current context window size.
    // Instead, use the last known context-window-accurate usage from task_progress
    // events and treat the accumulated total as totalProcessedTokens.
    const accumulatedSnapshot = normalizeClaudeTokenUsage(
      resultUsage,
      resultContextWindow ?? context.lastKnownContextWindow,
    );
    const lastGoodUsage = context.lastKnownTokenUsage;
    const maxTokens = resultContextWindow ?? context.lastKnownContextWindow;
    const usageSnapshot: ThreadTokenUsageSnapshot | undefined = lastGoodUsage
      ? {
          ...lastGoodUsage,
          ...(typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
            ? { maxTokens }
            : {}),
          ...(accumulatedSnapshot && accumulatedSnapshot.usedTokens > lastGoodUsage.usedTokens
            ? { totalProcessedTokens: accumulatedSnapshot.usedTokens }
            : {}),
        }
      : accumulatedSnapshot;

    const turnState = context.turnState;
    if (!turnState) {
      if (usageSnapshot) {
        const usageStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "thread.token-usage.updated",
          eventId: usageStamp.eventId,
          provider: PROVIDER,
          createdAt: usageStamp.createdAt,
          threadId: context.session.threadId,
          payload: {
            usage: usageSnapshot,
          },
          providerRefs: {},
        });
      }

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          state: status,
          ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
          ...(result?.usage ? { usage: result.usage } : {}),
          ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
          ...(typeof result?.total_cost_usd === "number"
            ? { totalCostUsd: result.total_cost_usd }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
        providerRefs: {},
      });
      return;
    }

    for (const [index, tool] of context.inFlightTools.entries()) {
      const toolStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: toolStamp.eventId,
        provider: PROVIDER,
        createdAt: toolStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: status === "completed" ? "completed" : "failed",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: {
            toolName: tool.toolName,
            input: tool.input,
          },
        },
        providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/result",
          payload: result ?? { status },
        },
      });
      context.inFlightTools.delete(index);
    }
    // Clear any remaining stale entries (e.g. from interrupted content blocks)
    context.inFlightTools.clear();

    for (const block of turnState.assistantTextBlockOrder) {
      yield* completeAssistantTextBlock(context, block, {
        force: true,
        rawMethod: "claude/result",
        rawPayload: result ?? { status },
      });
    }

    // On failure/interruption the SDK's `assistant` snapshot may never arrive.
    // If we have accumulated any text on blocks, synthesize a partial assistant
    // message so readThread / resume don't silently drop the content the user
    // already saw stream in.
    const finalItems: Array<unknown> =
      status !== "completed" && turnState.items.length === 0
        ? (() => {
            const parts = turnState.assistantTextBlockOrder
              .filter((block) => block.runtimeItemType === "assistant_message")
              .map((block) => block.fallbackText)
              .filter((text) => text.length > 0);
            if (parts.length === 0) {
              return [...turnState.items];
            }
            return [
              {
                id: `synthetic:${String(turnState.turnId)}`,
                type: "message",
                role: "assistant",
                ...(context.currentApiModelId ? { model: context.currentApiModelId } : {}),
                content: parts.map((text) => ({ type: "text", text })),
                stop_reason: status === "interrupted" ? "end_turn" : "end_turn",
                partial: true,
              },
              ...turnState.items,
            ];
          })()
        : [...turnState.items];

    context.turns.push({
      id: turnState.turnId,
      items: finalItems,
      ...(turnState.checkpointUuid ? { checkpointUuid: turnState.checkpointUuid } : {}),
    });

    if (usageSnapshot) {
      const usageStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "thread.token-usage.updated",
        eventId: usageStamp.eventId,
        provider: PROVIDER,
        createdAt: usageStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: {
          usage: usageSnapshot,
        },
        providerRefs: nativeProviderRefs(context),
      });
    }

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        state: status,
        ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
        ...(result?.usage ? { usage: result.usage } : {}),
        ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
        ...(typeof result?.total_cost_usd === "number"
          ? { totalCostUsd: result.total_cost_usd }
          : {}),
        ...(errorMessage ? { errorMessage } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });

    const updatedAt = yield* nowIso;
    context.turnState = undefined;
    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt,
      ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
    };
    yield* updateResumeCursor(context);
  });

  const handleStreamEvent = Effect.fn("handleStreamEvent")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "stream_event") {
      return;
    }

    const { event } = message;

    if (event.type === "content_block_delta") {
      if (
        (event.delta.type === "text_delta" || event.delta.type === "thinking_delta") &&
        context.turnState
      ) {
        const deltaText =
          event.delta.type === "text_delta"
            ? event.delta.text
            : typeof event.delta.thinking === "string"
              ? event.delta.thinking
              : "";
        if (deltaText.length === 0) {
          return;
        }
        const streamKind = streamKindFromDeltaType(event.delta.type);
        const assistantBlockEntry =
          event.delta.type === "text_delta"
            ? yield* ensureAssistantTextBlock(context, event.index, {
                streamKind: "assistant_text",
                runtimeItemType: "assistant_message",
                title: "Assistant message",
              })
            : yield* ensureAssistantTextBlock(context, event.index, {
                streamKind: "reasoning_text",
                runtimeItemType: "reasoning",
                title: "Thinking",
              });
        if (assistantBlockEntry?.block) {
          assistantBlockEntry.block.emittedTextDelta = true;
          // Accumulate each delta into fallbackText so a crash before the SDK
          // emits its `assistant` snapshot still leaves the partial reply
          // recoverable via the block state.
          assistantBlockEntry.block.fallbackText += deltaText;
        }
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "content.delta",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          ...(assistantBlockEntry?.block
            ? { itemId: asRuntimeItemId(assistantBlockEntry.block.itemId) }
            : {}),
          payload: {
            streamKind,
            delta: deltaText,
          },
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta",
            payload: message,
          },
        });
        return;
      }

      if (event.delta.type === "input_json_delta") {
        const tool = context.inFlightTools.get(event.index);
        if (!tool || typeof event.delta.partial_json !== "string") {
          return;
        }

        const partialInputJson = tool.partialInputJson + event.delta.partial_json;
        const parsedInput = tryParseJsonRecord(partialInputJson);
        const detail = parsedInput ? summarizeToolRequest(tool.toolName, parsedInput) : tool.detail;
        let nextTool: ToolInFlight = {
          ...tool,
          partialInputJson,
          ...(parsedInput ? { input: parsedInput } : {}),
          ...(detail ? { detail } : {}),
        };

        const nextFingerprint =
          parsedInput && Object.keys(parsedInput).length > 0
            ? toolInputFingerprint(parsedInput)
            : undefined;
        context.inFlightTools.set(event.index, nextTool);
        if (isSubagentToolCandidate(nextTool)) {
          context.subagentToolCandidates.set(nextTool.itemId, {
            itemId: nextTool.itemId,
            toolName: nextTool.toolName,
            input: nextTool.input,
          });
        }

        if (
          !parsedInput ||
          !nextFingerprint ||
          tool.lastEmittedInputFingerprint === nextFingerprint
        ) {
          return;
        }

        nextTool = {
          ...nextTool,
          lastEmittedInputFingerprint: nextFingerprint,
        };
        context.inFlightTools.set(event.index, nextTool);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          itemId: asRuntimeItemId(nextTool.itemId),
          payload: {
            itemType: nextTool.itemType,
            status: "inProgress",
            title: nextTool.title,
            ...(nextTool.detail ? { detail: nextTool.detail } : {}),
            data: {
              toolName: nextTool.toolName,
              input: nextTool.input,
            },
          },
          providerRefs: nativeProviderRefs(context, { providerItemId: nextTool.itemId }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta/input_json_delta",
            payload: message,
          },
        });
      }
      return;
    }

    if (event.type === "content_block_start") {
      const { index, content_block: block } = event;
      if (block.type === "text") {
        yield* ensureAssistantTextBlock(context, index, {
          fallbackText: extractContentBlockText(block),
          streamKind: "assistant_text",
          runtimeItemType: "assistant_message",
          title: "Assistant message",
        });
        return;
      }
      if (block.type === "thinking") {
        yield* ensureAssistantTextBlock(context, index, {
          fallbackText: typeof block.thinking === "string" ? block.thinking : "",
          streamKind: "reasoning_text",
          runtimeItemType: "reasoning",
          title: "Thinking",
        });
        return;
      }
      if (
        block.type !== "tool_use" &&
        block.type !== "server_tool_use" &&
        block.type !== "mcp_tool_use"
      ) {
        return;
      }

      const toolName = block.name;
      const itemType = classifyToolItemType(toolName);
      const toolInput =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      const itemId = block.id;
      const detail = summarizeToolRequest(toolName, toolInput);
      const inputFingerprint =
        Object.keys(toolInput).length > 0 ? toolInputFingerprint(toolInput) : undefined;

      const tool: ToolInFlight = {
        itemId,
        itemType,
        toolName,
        title: titleForTool(itemType, toolName),
        detail,
        input: toolInput,
        partialInputJson: "",
        ...(inputFingerprint ? { lastEmittedInputFingerprint: inputFingerprint } : {}),
      };
      context.inFlightTools.set(index, tool);
      if (isSubagentToolCandidate(tool)) {
        context.subagentToolCandidates.set(tool.itemId, {
          itemId: tool.itemId,
          toolName: tool.toolName,
          input: tool.input,
        });
      }

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: "inProgress",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: {
            toolName: tool.toolName,
            input: toolInput,
          },
        },
        providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/stream_event/content_block_start",
          payload: message,
        },
      });
      return;
    }

    if (event.type === "content_block_stop") {
      const { index } = event;
      const assistantBlock = context.turnState?.assistantTextBlocks.get(index);
      if (assistantBlock) {
        assistantBlock.streamClosed = true;
        yield* completeAssistantTextBlock(context, assistantBlock, {
          rawMethod: "claude/stream_event/content_block_stop",
          rawPayload: message,
        });
        return;
      }
      const tool = context.inFlightTools.get(index);
      if (!tool) {
        return;
      }
    }
  });

  const handleUserMessage = Effect.fn("handleUserMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "user") {
      return;
    }

    if (context.turnState) {
      context.turnState.items.push(message.message);
      // Capture the first user-message uuid as the turn's checkpoint id so
      // rollbackThread can hand it to SDK.rewindFiles when file checkpointing
      // is enabled. Only the first one matters — subsequent user messages in
      // the same turn (e.g. tool-result injections) share the same checkpoint.
      if (
        !context.turnState.checkpointUuid &&
        "uuid" in message &&
        typeof message.uuid === "string"
      ) {
        context.turnState.checkpointUuid = message.uuid;
      }
    }

    for (const toolResult of toolResultBlocksFromUserMessage(message)) {
      const toolEntry = Array.from(context.inFlightTools.entries()).find(
        ([, tool]) => tool.itemId === toolResult.toolUseId,
      );
      if (!toolEntry) {
        continue;
      }

      const [index, tool] = toolEntry;
      const itemStatus = toolResult.isError ? "failed" : "completed";
      const toolData = {
        toolName: tool.toolName,
        input: tool.input,
        result: toolResult.block,
      };

      const updatedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.updated",
        eventId: updatedStamp.eventId,
        provider: PROVIDER,
        createdAt: updatedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: toolResult.isError ? "failed" : "inProgress",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: message,
        },
      });

      const streamKind = toolResultStreamKind(tool.itemType);
      if (streamKind && toolResult.text.length > 0 && context.turnState) {
        const deltaStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "content.delta",
          eventId: deltaStamp.eventId,
          provider: PROVIDER,
          createdAt: deltaStamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          itemId: asRuntimeItemId(tool.itemId),
          payload: {
            streamKind,
            delta: toolResult.text,
          },
          providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/user",
            payload: message,
          },
        });
      }

      const completedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: completedStamp.eventId,
        provider: PROVIDER,
        createdAt: completedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: itemStatus,
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: message,
        },
      });

      context.inFlightTools.delete(index);
    }
  });

  const handleAssistantMessage = Effect.fn("handleAssistantMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "assistant") {
      return;
    }

    // Auto-start a synthetic turn for assistant messages that arrive without
    // an active turn (e.g., background agent/subagent responses between user prompts).
    if (!context.turnState) {
      const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
      const startedAt = yield* nowIso;
      context.turnState = {
        turnId,
        startedAt,
        items: [],
        assistantTextBlocks: new Map(),
        assistantTextBlockOrder: [],
        capturedProposedPlanKeys: new Set(),
        nextSyntheticAssistantBlockIndex: -1,
      };
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: startedAt,
      };
      const turnStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.started",
        eventId: turnStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: turnStartedStamp.createdAt,
        threadId: context.session.threadId,
        turnId,
        payload: {},
        providerRefs: {
          ...nativeProviderRefs(context),
          providerTurnId: turnId,
        },
        raw: {
          source: "claude.sdk.message",
          method: "claude/synthetic-turn-start",
          payload: {},
        },
      });
    }

    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const toolUse = block as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          input?: unknown;
        };
        if (toolUse.type !== "tool_use" || toolUse.name !== "ExitPlanMode") {
          continue;
        }
        const planMarkdown = extractExitPlanModePlan(toolUse.input);
        if (!planMarkdown) {
          continue;
        }
        yield* emitProposedPlanCompleted(context, {
          planMarkdown,
          toolUseId: typeof toolUse.id === "string" ? toolUse.id : undefined,
          rawSource: "claude.sdk.message",
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
      }
    }

    if (context.turnState) {
      context.turnState.items.push(message.message);
      yield* backfillAssistantTextBlocksFromSnapshot(context, message);
    }

    context.lastAssistantUuid = message.uuid;
    yield* updateResumeCursor(context);
  });

  const handleResultMessage = Effect.fn("handleResultMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "result") {
      return;
    }

    const status = turnStatusFromResult(message);
    const errorMessage =
      message.subtype === "success" || shouldSuppressResultErrorMessage(message)
        ? undefined
        : message.errors[0];

    if (status === "failed") {
      yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
    }

    yield* completeTurn(context, status, errorMessage, message);

    if (status === "failed" && isClaudeMissingConversationErrorMessage(errorMessage)) {
      // The SDK reports the stored conversation is gone (e.g. deleted on the
      // backend or compacted away). Invalidate the resume cursor so the next
      // start won't loop on a poisoned sessionId.
      context.resumeSessionId = undefined;
      context.lastAssistantUuid = undefined;
      yield* updateResumeCursor(context);
      yield* Effect.forkDetach(
        stopSessionInternal(context, {
          emitExitEvent: true,
          ...(errorMessage !== undefined ? { reason: errorMessage } : {}),
          exitKind: "graceful",
          recoverable: true,
          interruptStreamFiber: false,
        }),
      );
    }
  });

  const handleSystemMessage = Effect.fn("handleSystemMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "system") {
      return;
    }

    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: `${message.type}:${message.subtype}`,
        payload: message,
      },
    };

    switch (message.subtype) {
      case "init":
        // Session configuration is emitted at adapter startup from the local
        // query options; `system.init` is used to confirm the provider
        // session_id and should not duplicate `session.configured`.
        return;
      case "status":
        yield* offerRuntimeEvent({
          ...base,
          type: "session.state.changed",
          payload: {
            state: message.status === "compacting" ? "waiting" : "running",
            reason: `status:${message.status ?? "active"}`,
            detail: message,
          },
        });
        return;
      case "compact_boundary":
        yield* offerRuntimeEvent({
          ...base,
          type: "thread.state.changed",
          payload: {
            state: "compacted",
            detail: message,
          },
        });
        return;
      case "hook_started":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.started",
          payload: {
            hookId: message.hook_id,
            hookName: message.hook_name,
            hookEvent: message.hook_event,
          },
        });
        return;
      case "hook_progress":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.progress",
          payload: {
            hookId: message.hook_id,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
          },
        });
        return;
      case "hook_response":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.completed",
          payload: {
            hookId: message.hook_id,
            outcome: message.outcome,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
            ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
          },
        });
        return;
      case "task_started": {
        const parentToolUseId = inferClaudeTaskParentToolUseId(context, message);
        const taskType = inferClaudeTaskType(context, message, parentToolUseId);
        yield* offerRuntimeEvent({
          ...base,
          raw: {
            ...base.raw,
            payload: withClaudeTaskParentToolUseId(message, parentToolUseId),
          },
          type: "task.started",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(message.task_id),
            description: message.description,
            ...(taskType ? { taskType } : {}),
          },
        });
        return;
      }
      case "task_progress": {
        const parentToolUseId = inferClaudeTaskParentToolUseId(context, message);
        if (message.usage) {
          const normalizedUsage = normalizeClaudeTokenUsage(
            message.usage,
            context.lastKnownContextWindow,
          );
          if (normalizedUsage) {
            context.lastKnownTokenUsage = normalizedUsage;
            const usageStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              ...base,
              eventId: usageStamp.eventId,
              createdAt: usageStamp.createdAt,
              raw: {
                ...base.raw,
                payload: withClaudeTaskParentToolUseId(message, parentToolUseId),
              },
              type: "thread.token-usage.updated",
              payload: {
                usage: normalizedUsage,
              },
            });
          }
        }
        yield* offerRuntimeEvent({
          ...base,
          raw: {
            ...base.raw,
            payload: withClaudeTaskParentToolUseId(message, parentToolUseId),
          },
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(message.task_id),
            description: message.description,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
          },
        });
        return;
      }
      case "task_notification": {
        const parentToolUseId = inferClaudeTaskParentToolUseId(context, message);
        if (message.usage) {
          const normalizedUsage = normalizeClaudeTokenUsage(
            message.usage,
            context.lastKnownContextWindow,
          );
          if (normalizedUsage) {
            context.lastKnownTokenUsage = normalizedUsage;
            const usageStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              ...base,
              eventId: usageStamp.eventId,
              createdAt: usageStamp.createdAt,
              raw: {
                ...base.raw,
                payload: withClaudeTaskParentToolUseId(message, parentToolUseId),
              },
              type: "thread.token-usage.updated",
              payload: {
                usage: normalizedUsage,
              },
            });
          }
        }
        yield* offerRuntimeEvent({
          ...base,
          raw: {
            ...base.raw,
            payload: withClaudeTaskParentToolUseId(message, parentToolUseId),
          },
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(message.task_id),
            status: message.status,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.output_file ? { outputFile: message.output_file } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
          },
        });
        return;
      }
      case "files_persisted":
        yield* offerRuntimeEvent({
          ...base,
          type: "files.persisted",
          payload: {
            files: Array.isArray(message.files)
              ? message.files.map((file: { filename: string; file_id: string }) => ({
                  filename: file.filename,
                  fileId: file.file_id,
                }))
              : [],
            ...(Array.isArray(message.failed)
              ? {
                  failed: message.failed.map((entry: { filename: string; error: string }) => ({
                    filename: entry.filename,
                    error: entry.error,
                  })),
                }
              : {}),
          },
        });
        return;
      default:
        yield* emitRuntimeWarning(
          context,
          `Unhandled Claude system message subtype '${message.subtype}'.`,
          message,
        );
        return;
    }
  });

  const handleSdkTelemetryMessage = Effect.fn("handleSdkTelemetryMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: message.type,
        payload: message,
      },
    };

    if (message.type === "tool_progress") {
      yield* offerRuntimeEvent({
        ...base,
        type: "tool.progress",
        payload: {
          toolUseId: message.tool_use_id,
          toolName: message.tool_name,
          elapsedSeconds: message.elapsed_time_seconds,
          ...(message.task_id ? { summary: `task:${message.task_id}` } : {}),
        },
      });
      return;
    }

    if (message.type === "tool_use_summary") {
      yield* offerRuntimeEvent({
        ...base,
        type: "tool.summary",
        payload: {
          summary: message.summary,
          ...(message.preceding_tool_use_ids.length > 0
            ? { precedingToolUseIds: message.preceding_tool_use_ids }
            : {}),
        },
      });
      return;
    }

    if (message.type === "auth_status") {
      yield* offerRuntimeEvent({
        ...base,
        type: "auth.status",
        payload: {
          isAuthenticating: message.isAuthenticating,
          output: message.output,
          ...(message.error ? { error: message.error } : {}),
        },
      });
      return;
    }

    if (message.type === "rate_limit_event") {
      yield* offerRuntimeEvent({
        ...base,
        type: "account.rate-limits.updated",
        payload: {
          rateLimits: message,
        },
      });
      return;
    }
  });

  const handleSdkMessage = Effect.fn("handleSdkMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    yield* logNativeSdkMessage(context, message);
    yield* ensureThreadId(context, message);

    switch (message.type) {
      case "stream_event":
        yield* handleStreamEvent(context, message);
        return;
      case "user":
        yield* handleUserMessage(context, message);
        return;
      case "assistant":
        yield* handleAssistantMessage(context, message);
        return;
      case "result":
        yield* handleResultMessage(context, message);
        return;
      case "system":
        yield* handleSystemMessage(context, message);
        return;
      case "tool_progress":
      case "tool_use_summary":
      case "auth_status":
      case "rate_limit_event":
        yield* handleSdkTelemetryMessage(context, message);
        return;
      default:
        yield* emitRuntimeWarning(
          context,
          `Unhandled Claude SDK message type '${message.type}'.`,
          message,
        );
        return;
    }
  });

  const runSdkStream = (context: ClaudeSessionContext): Effect.Effect<void, Error> =>
    Stream.fromAsyncIterable(context.query, (cause) =>
      toError(cause, "Claude runtime stream failed."),
    ).pipe(
      Stream.takeWhile(() => !context.stopped),
      Stream.runForEach((message) => handleSdkMessage(context, message)),
    );

  const handleStreamExit = Effect.fn("handleStreamExit")(function* (
    context: ClaudeSessionContext,
    exit: Exit.Exit<void, Error>,
  ) {
    if (context.stopped) {
      return;
    }

    if (Exit.isFailure(exit)) {
      if (isClaudeInterruptedCause(exit.cause)) {
        if (context.turnState) {
          yield* completeTurn(
            context,
            "interrupted",
            interruptionMessageFromClaudeCause(exit.cause),
          );
        }
        yield* stopSessionInternal(context, {
          emitExitEvent: true,
          reason: "Claude runtime interrupted.",
          exitKind: "graceful",
        });
      } else {
        const message = messageFromClaudeStreamCause(exit.cause, "Claude runtime stream failed.");
        const transient = isTransientClaudeFailureCause(exit.cause);
        yield* emitRuntimeError(context, message, Cause.pretty(exit.cause));
        yield* completeTurn(context, "failed", message);
        yield* stopSessionInternal(context, {
          emitExitEvent: true,
          reason: message,
          exitKind: "error",
          // Flag transient failures as recoverable so the UI can reopen against
          // the same resume cursor instead of showing a fatal error for a
          // network blip / rate limit / SDK timeout.
          recoverable: transient,
        });
      }
    } else if (context.turnState) {
      yield* completeTurn(context, "interrupted", "Claude runtime stream ended.");
      yield* stopSessionInternal(context, {
        emitExitEvent: true,
        reason: "Claude runtime stream ended.",
        exitKind: "graceful",
      });
      return;
    }
    if (!context.turnState) {
      yield* stopSessionInternal(context, {
        emitExitEvent: true,
      });
    }
  });

  // Cancel every pending approval + user-input for this session. Called from both
  // interruptTurn (before query.interrupt()) and stopSessionInternal so that a
  // late-clicking user never races a teardown.
  const drainPendingDeferreds = Effect.fn("drainPendingDeferreds")(function* (
    context: ClaudeSessionContext,
    options: { readonly reason: "cancel" | "stopped" },
  ) {
    for (const [requestId, pending] of context.pendingApprovals) {
      yield* Deferred.succeed(pending.decision, "cancel");
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "request.resolved",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: {
          requestType: pending.requestType,
          decision: "cancel",
        },
        providerRefs: nativeProviderRefs(context),
        raw: {
          source: "claude.sdk.permission",
          method: `drain/${options.reason}`,
          payload: { reason: options.reason },
        },
      });
    }
    context.pendingApprovals.clear();

    for (const [requestId, pending] of context.pendingUserInputs) {
      yield* Deferred.succeed(pending.answers, {} as ProviderUserInputAnswers);
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "user-input.resolved",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: { answers: {} as ProviderUserInputAnswers },
        providerRefs: nativeProviderRefs(context),
        raw: {
          source: "claude.sdk.permission",
          method: `drain/${options.reason}`,
          payload: { reason: options.reason },
        },
      });
    }
    context.pendingUserInputs.clear();
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    context: ClaudeSessionContext,
    options?: {
      readonly emitExitEvent?: boolean;
      readonly reason?: string;
      readonly exitKind?: "graceful" | "error";
      readonly recoverable?: boolean;
      readonly interruptStreamFiber?: boolean;
    },
  ) {
    if (context.stopped) return;

    context.stopped = true;
    context.interrupting = true;

    yield* drainPendingDeferreds(context, { reason: "stopped" });

    if (context.turnState) {
      yield* completeTurn(context, "interrupted", "Session stopped.");
    }

    yield* Queue.shutdown(context.promptQueue);

    const streamFiber = context.streamFiber;
    context.streamFiber = undefined;
    if (
      options?.interruptStreamFiber !== false &&
      streamFiber &&
      streamFiber.pollUnsafe() === undefined
    ) {
      yield* Fiber.interrupt(streamFiber);
    }

    // Close the SDK query runtime under a bounded timeout so a hung child
    // process never stalls session teardown indefinitely. `query.close()` is
    // documented as synchronous, but we wrap it in Effect.tryPromise to catch
    // any async cleanup the SDK may schedule internally and to get a timeout
    // hook. On timeout or thrown error we log and move on; the stream fiber
    // is already interrupted above.
    // @effect-diagnostics-next-line globalErrorInEffectCatch:off
    yield* Effect.tryPromise({
      try: async () => {
        context.query.close();
      },
      catch: (cause) => toError(cause, "Failed to close Claude runtime query."),
    }).pipe(
      Effect.timeoutOrElse({
        duration: queryCloseTimeout,
        orElse: () =>
          emitRuntimeError(
            context,
            `Claude runtime close() did not complete within ${Duration.format(Duration.fromInputUnsafe(queryCloseTimeout))}; continuing teardown.`,
          ),
      }),
      Effect.catch((cause) =>
        emitRuntimeError(context, "Failed to close Claude runtime query.", cause),
      ),
    );

    const updatedAt = yield* nowIso;
    context.session = {
      ...context.session,
      status: "closed",
      activeTurnId: undefined,
      updatedAt,
    };

    if (options?.emitExitEvent !== false) {
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.exited",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          reason: options?.reason ?? "Session stopped",
          exitKind: options?.exitKind ?? "graceful",
          ...(options?.recoverable !== undefined ? { recoverable: options.recoverable } : {}),
        },
        providerRefs: {},
      });
    }

    sessions.delete(context.session.threadId);
  });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> => {
    const context = sessions.get(threadId);
    if (!context) {
      return Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    if (context.stopped || context.session.status === "closed") {
      return Effect.fail(
        new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    return Effect.succeed(context);
  };

  const startSession: ClaudeAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const startedAt = yield* nowIso;
      const resumeState = readClaudeResumeState(input.resumeCursor);
      const threadId = input.threadId;
      const existingResumeSessionId = resumeState?.resume;

      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);
      const runPromise = Effect.runPromiseWith(services);

      const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
      const prompt = Stream.fromQueue(promptQueue).pipe(
        Stream.filter((item) => item.type === "message"),
        Stream.map((item) => item.message),
        Stream.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
        ),
        Stream.toAsyncIterable,
      );

      const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
      const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
      const inFlightTools = new Map<number, ToolInFlight>();

      const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);

      /**
       * Handle AskUserQuestion tool calls by emitting a `user-input.requested`
       * runtime event and waiting for the user to respond via `respondToUserInput`.
       */
      const handleAskUserQuestion = Effect.fn("handleAskUserQuestion")(function* (
        context: ClaudeSessionContext,
        toolInput: Record<string, unknown>,
        callbackOptions: { readonly signal: AbortSignal; readonly toolUseID?: string },
      ) {
        const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);

        // Parse questions from the SDK's AskUserQuestion input.
        const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
        const questions: Array<UserInputQuestion> = rawQuestions.map(
          (q: Record<string, unknown>, idx: number) => ({
            id: typeof q.header === "string" ? q.header : `q-${idx}`,
            header: typeof q.header === "string" ? q.header : `Question ${idx + 1}`,
            question: typeof q.question === "string" ? q.question : "",
            options: Array.isArray(q.options)
              ? q.options.map((opt: Record<string, unknown>) => ({
                  label: typeof opt.label === "string" ? opt.label : "",
                  description: typeof opt.description === "string" ? opt.description : "",
                }))
              : [],
            multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : false,
          }),
        );

        const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
        let aborted = false;
        const pendingInput: PendingUserInput = {
          questions,
          answers: answersDeferred,
        };

        // Emit user-input.requested so the UI can present the questions.
        const requestedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "user-input.requested",
          eventId: requestedStamp.eventId,
          provider: PROVIDER,
          createdAt: requestedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: { questions },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/AskUserQuestion",
            payload: { toolName: "AskUserQuestion", input: toolInput },
          },
        });

        pendingUserInputs.set(requestId, pendingInput);

        // Handle abort (e.g. turn interrupted while waiting for user input).
        const onAbort = () => {
          if (!pendingUserInputs.has(requestId)) {
            return;
          }
          aborted = true;
          pendingUserInputs.delete(requestId);
          runFork(Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers));
        };
        callbackOptions.signal.addEventListener("abort", onAbort, { once: true });

        // Block until the user provides answers. Bounded timeout protects
        // against a disconnected UI leaving the deferred and the map entry
        // hanging around forever.
        const awaitAnswers = Deferred.await(answersDeferred).pipe(
          Effect.timeoutOrElse({
            duration: approvalWaitTimeout,
            orElse: () =>
              Effect.sync(() => {
                aborted = true;
                pendingUserInputs.delete(requestId);
                return {} as ProviderUserInputAnswers;
              }),
          }),
        );
        const answers = yield* awaitAnswers;
        pendingUserInputs.delete(requestId);
        // If the session was interrupted or stopped while we were waiting,
        // treat this as aborted so the SDK receives a deny instead of empty
        // answers. Without this check, drainPendingDeferreds would resolve
        // the deferred and the handler would silently allow the tool.
        if (context.interrupting || context.stopped) {
          aborted = true;
        }

        // Emit user-input.resolved so the UI knows the interaction completed.
        // Skip when drainPendingDeferreds already emitted it during interrupt /
        // stop so the UI doesn't see two resolved events for one request.
        if (!context.interrupting && !context.stopped) {
          const resolvedStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "user-input.resolved",
            eventId: resolvedStamp.eventId,
            provider: PROVIDER,
            createdAt: resolvedStamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: { answers },
            providerRefs: nativeProviderRefs(context, {
              providerItemId: callbackOptions.toolUseID,
            }),
            raw: {
              source: "claude.sdk.permission",
              method: "canUseTool/AskUserQuestion/resolved",
              payload: { answers },
            },
          });
        }

        if (aborted) {
          return {
            behavior: "deny",
            message: "User cancelled tool execution.",
          } satisfies PermissionResult;
        }

        // Return the answers to the SDK in the expected format:
        // { questions: [...], answers: { questionText: selectedLabel } }
        return {
          behavior: "allow",
          updatedInput: {
            questions: toolInput.questions,
            answers,
          },
        } satisfies PermissionResult;
      });

      const canUseToolEffect = Effect.fn("canUseTool")(function* (
        toolName: Parameters<CanUseTool>[0],
        toolInput: Parameters<CanUseTool>[1],
        callbackOptions: Parameters<CanUseTool>[2],
      ) {
        const context = yield* Ref.get(contextRef);
        if (!context) {
          return {
            behavior: "deny",
            message: "Claude session context is unavailable.",
          } satisfies PermissionResult;
        }

        // Handle AskUserQuestion: surface clarifying questions to the
        // user via the user-input runtime event channel, regardless of
        // runtime mode (plan mode relies on this heavily).
        if (toolName === "AskUserQuestion") {
          return yield* handleAskUserQuestion(context, toolInput, callbackOptions);
        }

        if (toolName === "ExitPlanMode") {
          const planMarkdown = extractExitPlanModePlan(toolInput);
          if (planMarkdown) {
            yield* emitProposedPlanCompleted(context, {
              planMarkdown,
              toolUseId: callbackOptions.toolUseID,
              rawSource: "claude.sdk.permission",
              rawMethod: "canUseTool/ExitPlanMode",
              rawPayload: {
                toolName,
                input: toolInput,
              },
            });
          }

          return {
            behavior: "deny",
            message:
              "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
          } satisfies PermissionResult;
        }

        const runtimeMode = input.runtimeMode ?? "full-access";
        if (runtimeMode === "full-access") {
          return {
            behavior: "allow",
            updatedInput: toolInput,
          } satisfies PermissionResult;
        }

        const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
        const requestType = classifyRequestType(toolName);
        const detail = summarizeToolRequest(toolName, toolInput);
        const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
        const pendingApproval: PendingApproval = {
          requestType,
          detail,
          decision: decisionDeferred,
          ...(callbackOptions.suggestions ? { suggestions: callbackOptions.suggestions } : {}),
        };

        const requestedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "request.opened",
          eventId: requestedStamp.eventId,
          provider: PROVIDER,
          createdAt: requestedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: {
            requestType,
            detail,
            args: {
              toolName,
              input: toolInput,
              ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
            },
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/request",
            payload: {
              toolName,
              input: toolInput,
            },
          },
        });

        pendingApprovals.set(requestId, pendingApproval);

        const onAbort = () => {
          if (!pendingApprovals.has(requestId)) {
            return;
          }
          pendingApprovals.delete(requestId);
          runFork(Deferred.succeed(decisionDeferred, "cancel"));
        };

        callbackOptions.signal.addEventListener("abort", onAbort, {
          once: true,
        });

        // Bounded wait so a disconnected UI can't leave the deferred pending
        // forever. On timeout we auto-decline and surface a runtime warning.
        const decisionWithTimeout = Deferred.await(decisionDeferred).pipe(
          Effect.timeoutOrElse({
            duration: approvalWaitTimeout,
            orElse: () =>
              Effect.sync(() => {
                if (pendingApprovals.has(requestId)) {
                  pendingApprovals.delete(requestId);
                }
                return "decline" as ProviderApprovalDecision;
              }),
          }),
        );
        const decision = yield* decisionWithTimeout;
        pendingApprovals.delete(requestId);
        const resolvedDecision = isSimpleApprovalDecision(decision) ? decision : "decline";

        // If interrupt / stop drained the deferred, drainPendingDeferreds already
        // emitted request.resolved. Skip the second emit here to avoid a
        // duplicate event — but still return a deny result to the SDK.
        if (!context.interrupting && !context.stopped) {
          const resolvedStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "request.resolved",
            eventId: resolvedStamp.eventId,
            provider: PROVIDER,
            createdAt: resolvedStamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: {
              requestType,
              decision: resolvedDecision,
            },
            providerRefs: nativeProviderRefs(context, {
              providerItemId: callbackOptions.toolUseID,
            }),
            raw: {
              source: "claude.sdk.permission",
              method: "canUseTool/decision",
              payload: {
                decision,
              },
            },
          });
        }

        if (resolvedDecision === "accept" || resolvedDecision === "acceptForSession") {
          return {
            behavior: "allow",
            updatedInput: toolInput,
            ...(resolvedDecision === "acceptForSession" && pendingApproval.suggestions
              ? { updatedPermissions: [...pendingApproval.suggestions] }
              : {}),
          } satisfies PermissionResult;
        }

        return {
          behavior: "deny",
          message:
            resolvedDecision === "cancel"
              ? "User cancelled tool execution."
              : "User declined tool execution.",
        } satisfies PermissionResult;
      });

      const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
        runPromise(canUseToolEffect(toolName, toolInput, callbackOptions));

      const serverSettings = yield* serverSettingsService.getSettings.pipe(
        Effect.mapError(
          (error) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: error.message,
              cause: error,
            }),
        ),
      );
      const claudeSettings = serverSettings.providers.claudeAgent;
      const claudeBinaryPath = claudeSettings.binaryPath;
      const runtimeMcpServers = yield* Effect.tryPromise(() =>
        materializeMcpServersForRuntime({
          servers: serverSettings.mcpServers.servers,
          oauthStorageDir: path.join(serverConfig.stateDir, "mcp-oauth"),
        }),
      ).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(
              "claude mcp OAuth materialization failed; continuing with static MCP config",
            );
            yield* Effect.logWarning(toMessage(cause, "Failed to materialize Claude MCP auth."));
            return serverSettings.mcpServers.servers;
          }),
        ),
      );
      const claudeMcpServers = buildClaudeMcpServers(runtimeMcpServers);
      const assistantSettingsAppendix = buildAssistantSettingsAppendix({
        personality: serverSettings.assistantPersonality,
        generateMemories: serverSettings.generateMemories,
      });
      const modelSelection =
        input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;
      const caps = getClaudeModelCapabilities(modelSelection?.model);
      const apiModelId = modelSelection ? resolveApiModelId(modelSelection) : undefined;
      const effort = (resolveEffort(caps, modelSelection?.options?.effort) ??
        null) as ClaudeCodeEffort | null;
      const fastMode = modelSelection?.options?.fastMode === true && caps.supportsFastMode;
      const thinking =
        typeof modelSelection?.options?.thinking === "boolean" && caps.supportsThinkingToggle
          ? modelSelection.options.thinking
          : undefined;
      const effectiveEffort = getEffectiveClaudeCodeEffort(effort);
      const permissionMode: PermissionMode =
        input.runtimeMode === "full-access" ? "bypassPermissions" : "default";
      const settings = {
        ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
        ...(fastMode ? { fastMode: true } : {}),
      };

      const queryOptions: ClaudeQueryOptions = {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(apiModelId ? { model: apiModelId } : {}),
        pathToClaudeCodeExecutable: claudeBinaryPath,
        settingSources: [...CLAUDE_SETTING_SOURCES],
        ...(effectiveEffort ? { effort: effectiveEffort } : {}),
        permissionMode,
        ...(permissionMode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
        ...(assistantSettingsAppendix
          ? {
              systemPrompt: {
                type: "preset" as const,
                preset: "claude_code" as const,
                append: assistantSettingsAppendix,
              },
            }
          : {}),
        // Do not pin a fresh session to an app-generated resume id before the
        // SDK confirms a real conversation exists. Prewarmed Claude sessions can
        // be started before the first user turn, and persisting a provisional id
        // there causes later restarts to try resuming conversations that never
        // actually existed.
        ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
        includePartialMessages: true,
        canUseTool,
        env: {
          ...process.env,
          ...(fileCheckpointingEnabled ? { CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "1" } : {}),
        },
        ...(fileCheckpointingEnabled
          ? {
              enableFileCheckpointing: true,
              extraArgs: { "replay-user-messages": null },
            }
          : {}),
        ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
        ...(claudeMcpServers ? { mcpServers: claudeMcpServers } : {}),
      };

      const queryRuntime = yield* Effect.try({
        try: () =>
          createQuery({
            prompt,
            options: queryOptions,
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: toMessage(cause, "Failed to start Claude runtime session."),
            cause,
          }),
      });

      const session: ProviderSession = {
        threadId,
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(modelSelection?.model ? { model: modelSelection.model } : {}),
        ...(threadId ? { threadId } : {}),
        resumeCursor: {
          ...(threadId ? { threadId } : {}),
          ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
          ...(resumeState?.resumeSessionAt ? { resumeSessionAt: resumeState.resumeSessionAt } : {}),
          turnCount: resumeState?.turnCount ?? 0,
        },
        createdAt: startedAt,
        updatedAt: startedAt,
      };

      const context: ClaudeSessionContext = {
        session,
        promptQueue,
        query: queryRuntime,
        streamFiber: undefined,
        startedAt,
        basePermissionMode: permissionMode,
        currentApiModelId: apiModelId,
        resumeSessionId: existingResumeSessionId,
        pendingApprovals,
        pendingUserInputs,
        turns: [],
        inFlightTools,
        subagentToolCandidates: new Map(),
        subagentTaskParentToolIds: new Map(),
        turnState: undefined,
        lastKnownContextWindow: undefined,
        lastKnownTokenUsage: undefined,
        lastAssistantUuid: resumeState?.resumeSessionAt,
        lastThreadStartedId: undefined,
        stopped: false,
        interrupting: false,
      };
      yield* Ref.set(contextRef, context);
      sessions.set(threadId, context);

      const sessionStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.started",
        eventId: sessionStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: sessionStartedStamp.createdAt,
        threadId,
        payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
        providerRefs: {},
      });

      const configuredStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.configured",
        eventId: configuredStamp.eventId,
        provider: PROVIDER,
        createdAt: configuredStamp.createdAt,
        threadId,
        payload: {
          config: {
            ...(apiModelId ? { model: apiModelId } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(effectiveEffort ? { effort: effectiveEffort } : {}),
            ...(permissionMode ? { permissionMode } : {}),
            ...(fastMode ? { fastMode: true } : {}),
          },
        },
        providerRefs: {},
      });

      const readyStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.state.changed",
        eventId: readyStamp.eventId,
        provider: PROVIDER,
        createdAt: readyStamp.createdAt,
        threadId,
        payload: {
          state: "ready",
        },
        providerRefs: {},
      });

      let streamFiber: Fiber.Fiber<void, never>;
      streamFiber = runFork(
        Effect.exit(runSdkStream(context)).pipe(
          Effect.flatMap((exit) => {
            if (context.stopped) {
              return Effect.void;
            }
            if (context.streamFiber === streamFiber) {
              context.streamFiber = undefined;
            }
            return handleStreamExit(context, exit);
          }),
        ),
      );
      context.streamFiber = streamFiber;
      streamFiber.addObserver(() => {
        if (context.streamFiber === streamFiber) {
          context.streamFiber = undefined;
        }
      });

      return {
        ...session,
      };
    },
  );

  const sendTurn: ClaudeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    const modelSelection =
      input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;

    if (context.turnState) {
      // Auto-close a stale synthetic turn (from background agent responses
      // between user prompts) to prevent blocking the user's next turn.
      yield* completeTurn(context, "completed");
    }

    if (modelSelection?.model) {
      const apiModelId = resolveApiModelId(modelSelection);
      if (context.currentApiModelId !== apiModelId) {
        yield* Effect.tryPromise({
          try: () => context.query.setModel(apiModelId),
          catch: (cause) => toRequestError(input.threadId, "turn/setModel", cause),
        });
        context.currentApiModelId = apiModelId;
      }
      context.session = {
        ...context.session,
        model: modelSelection.model,
      };
    }

    // Apply interaction mode by switching the SDK's permission mode.
    // "plan" maps directly to the SDK's "plan" permission mode;
    // "default" restores the session's original permission mode.
    // When interactionMode is absent we leave the current mode unchanged.
    if (input.interactionMode === "plan") {
      yield* Effect.tryPromise({
        try: () => context.query.setPermissionMode("plan"),
        catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
      });
    } else if (input.interactionMode === "default") {
      yield* Effect.tryPromise({
        try: () => context.query.setPermissionMode(context.basePermissionMode ?? "default"),
        catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
      });
    }

    const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
    const turnState: ClaudeTurnState = {
      turnId,
      startedAt: yield* nowIso,
      items: [],
      assistantTextBlocks: new Map(),
      assistantTextBlockOrder: [],
      capturedProposedPlanKeys: new Set(),
      nextSyntheticAssistantBlockIndex: -1,
    };

    const updatedAt = yield* nowIso;
    context.turnState = turnState;
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt,
    };

    const turnStartedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.started",
      eventId: turnStartedStamp.eventId,
      provider: PROVIDER,
      createdAt: turnStartedStamp.createdAt,
      threadId: context.session.threadId,
      turnId,
      payload: modelSelection?.model ? { model: modelSelection.model } : {},
      providerRefs: {},
    });

    const message = yield* buildUserMessageEffect(input, {
      fileSystem,
      attachmentsDir: serverConfig.attachmentsDir,
    });

    yield* Queue.offer(context.promptQueue, {
      type: "message",
      message,
    }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)));

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const interruptTurn: ClaudeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId, _turnId) {
      const context = yield* requireSession(threadId);
      // Flip the flag BEFORE touching the SDK so late responders see it.
      context.interrupting = true;
      yield* drainPendingDeferreds(context, { reason: "cancel" });
      yield* Effect.tryPromise({
        try: () => context.query.interrupt(),
        catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
      });
    },
  );

  const readThread: ClaudeAdapterShape["readThread"] = Effect.fn("readThread")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      return yield* snapshotThread(context);
    },
  );

  const rollbackThread: ClaudeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns) {
      const context = yield* requireSession(threadId);
      const nextLength = Math.max(0, context.turns.length - numTurns);
      // Capture the checkpoint for the earliest turn we're rolling back to so
      // we can ask the SDK to restore files to that state. The SDK rewinds
      // files associated with messages AFTER the checkpointed user message,
      // which is exactly what we want when trimming those turns.
      const firstRemovedTurn = context.turns[nextLength];
      const checkpointUuid = firstRemovedTurn?.checkpointUuid;
      context.turns.splice(nextLength);
      yield* updateResumeCursor(context);

      const rewindFiles = context.query.rewindFiles;
      if (fileCheckpointingEnabled && rewindFiles && checkpointUuid) {
        // @effect-diagnostics-next-line globalErrorInEffectCatch:off
        yield* Effect.tryPromise({
          try: () => rewindFiles(checkpointUuid),
          catch: (cause) => toError(cause, "Failed to rewind files for rollback."),
        }).pipe(
          Effect.catch((cause) =>
            emitRuntimeError(context, "File rewind on rollback failed.", cause),
          ),
        );
      }

      return yield* snapshotThread(context);
    },
  );

  const respondToRequest: ClaudeAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, requestId, decision) {
      const context = yield* requireSession(threadId);
      // If an interrupt or session stop landed after the UI dispatched a
      // decision, the deferred has already been drained. Treat as a no-op so
      // a double-emit of request.resolved doesn't fire.
      if (context.interrupting || context.stopped) {
        return;
      }
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "item/requestApproval/decision",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }

      context.pendingApprovals.delete(requestId);
      yield* Deferred.succeed(pending.decision, decision);
    },
  );

  const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (threadId, requestId, answers) {
    const context = yield* requireSession(threadId);
    if (context.interrupting || context.stopped) {
      return;
    }
    const pending = context.pendingUserInputs.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/tool/respondToUserInput",
        detail: `Unknown pending user-input request: ${requestId}`,
      });
    }

    context.pendingUserInputs.delete(requestId);
    yield* Deferred.succeed(pending.answers, answers);
  });

  const stopSession: ClaudeAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      yield* stopSessionInternal(context, {
        emitExitEvent: true,
      });
    },
  );

  const readUsage: ClaudeAdapterShape["readUsage"] = () =>
    Effect.tryPromise({
      try: () => (options?.fetchUsage ?? fetchClaudeUsageSnapshot)(),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "usage/read",
          detail: toMessage(cause, "Failed to read Claude usage."),
          cause,
        }),
    });

  const listSessions: ClaudeAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopAll: ClaudeAdapterShape["stopAll"] = () =>
    Effect.forEach(
      sessions,
      ([, context]) =>
        stopSessionInternal(context, {
          emitExitEvent: true,
        }),
      { discard: true },
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      sessions,
      ([, context]) =>
        stopSessionInternal(context, {
          emitExitEvent: false,
        }),
      { discard: true },
    ).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
  );

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
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    readUsage,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } satisfies ClaudeAdapterShape;
});

export const ClaudeAdapterLive = Layer.effect(ClaudeAdapter, makeClaudeAdapter());

export function makeClaudeAdapterLive(options?: ClaudeAdapterLiveOptions) {
  return Layer.effect(ClaudeAdapter, makeClaudeAdapter(options));
}
