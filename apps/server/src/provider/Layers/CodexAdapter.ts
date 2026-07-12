/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps `CodexAppServerManager` behind the `CodexAdapter` service contract and
 * maps manager failures into the shared `ProviderAdapterError` algebra.
 *
 * @module CodexAdapterLive
 */
import { Buffer } from "node:buffer";
import path from "node:path";

import {
  type CanonicalItemType,
  type CanonicalRequestType,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  type ThreadGoal,
  type ThreadGoalStatus,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ProviderItemId,
  ThreadId,
  TurnId,
  ProviderSendTurnInput,
} from "contracts";
import { Effect, FileSystem, Layer, Queue, Ref, ServiceMap, Stream } from "effect";
import {
  classifyProviderToolLifecycleItemType,
  extractStructuredProviderToolData,
  providerToolTitle,
  summarizeProviderToolInvocation,
} from "shared/providerTool";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { CodexAdapter, type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import {
  CodexAppServerManager,
  type CodexAppServerStartSessionInput,
} from "../../codexAppServerManager.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { probeCodexUsage } from "../codexAppServer.ts";
import { fetchCodexOAuthUsageSnapshot } from "../codexUsage.ts";
import {
  loadCodexManagedMcpServers,
  prepareCodexHomeWithManagedMcpServers,
} from "../mcpServers.ts";
import {
  resolvePreferredCodexBinaryPath,
  supportsCodexReasoningSummary,
} from "../codexBinaryPath.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import type { CodexUsageSnapshot } from "../Services/ProviderUsage.ts";
import { normalizeProviderApprovalDecision } from "../providerApprovalDecision.ts";

const PROVIDER = "codex" as const;

export interface CodexAdapterLiveOptions {
  readonly manager?: CodexAppServerManager;
  readonly makeManager?: (services?: ServiceMap.ServiceMap<never>) => CodexAppServerManager;
  readonly probeUsage?: (input: {
    readonly binaryPath: string;
    readonly homePath?: string;
    readonly signal?: AbortSignal;
  }) => Promise<CodexUsageSnapshot>;
  readonly fetchOAuthUsage?: (
    input:
      | {
          readonly homePath?: string;
          readonly signal?: AbortSignal;
        }
      | undefined,
  ) => Promise<CodexUsageSnapshot | null>;
  readonly loadManagedMcpServers?: typeof loadCodexManagedMcpServers;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("unknown provider session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("session is closed")) {
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

function capDiagnostic(value: string, limit = 4_000): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}... (${value.length - limit} chars truncated)`;
}

function usageDiagnostic(input: {
  readonly probeError?: unknown;
  readonly oauthError?: unknown;
  readonly oauthReturnedEmpty: boolean;
}): string {
  const details = [
    input.probeError
      ? `app-server probe failed: ${toMessage(input.probeError, "unknown error")}`
      : undefined,
    input.oauthError
      ? `direct OAuth fallback failed: ${toMessage(input.oauthError, "unknown error")}`
      : input.oauthReturnedEmpty
        ? "direct OAuth fallback did not return usage; your Codex login may be expired"
        : undefined,
  ].filter((detail): detail is string => detail !== undefined);

  return capDiagnostic(
    details.length > 0
      ? `Failed to read Codex account usage (${details.join("; ")}).`
      : "Failed to read Codex account usage.",
  );
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asNonEmptyStringArray(value: unknown): string[] {
  return (
    asArray(value)
      ?.flatMap((entry) => {
        const text = asString(entry)?.trim();
        return text ? [text] : [];
      })
      .filter((entry, index, entries) => entries.indexOf(entry) === index) ?? []
  );
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  const number = asNumber(value);
  return number !== undefined && Number.isInteger(number) && number >= 0 ? number : undefined;
}

function decodeBase64Text(value: unknown): string | undefined {
  const encoded = asString(value);
  if (!encoded || encoded.length === 0) {
    return undefined;
  }
  try {
    return Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

const FATAL_CODEX_STDERR_SNIPPETS = ["failed to connect to websocket"];

function isFatalCodexProcessStderrMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return FATAL_CODEX_STDERR_SNIPPETS.some((snippet) => normalized.includes(snippet));
}

function normalizeCodexTokenUsage(value: unknown): ThreadTokenUsageSnapshot | undefined {
  const usage = asObject(value);
  const totalUsage = asObject(usage?.total_token_usage ?? usage?.total);
  const lastUsage = asObject(usage?.last_token_usage ?? usage?.last);

  const totalProcessedTokens =
    asNumber(totalUsage?.total_tokens) ?? asNumber(totalUsage?.totalTokens);
  const usedTokens =
    asNumber(lastUsage?.total_tokens) ?? asNumber(lastUsage?.totalTokens) ?? totalProcessedTokens;
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens = asNumber(usage?.model_context_window) ?? asNumber(usage?.modelContextWindow);
  const inputTokens = asNumber(lastUsage?.input_tokens) ?? asNumber(lastUsage?.inputTokens);
  const cachedInputTokens =
    asNumber(lastUsage?.cached_input_tokens) ?? asNumber(lastUsage?.cachedInputTokens);
  const outputTokens = asNumber(lastUsage?.output_tokens) ?? asNumber(lastUsage?.outputTokens);
  const reasoningOutputTokens =
    asNumber(lastUsage?.reasoning_output_tokens) ?? asNumber(lastUsage?.reasoningOutputTokens);

  return {
    usedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(usedTokens !== undefined ? { lastUsedTokens: usedTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    compactsAutomatically: true,
  };
}

function normalizeCodexGoalTimestamp(value: unknown): string | undefined {
  const text = asString(value)?.trim();
  if (text) {
    const timestamp = Date.parse(text);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
  }

  const number = asNumber(value);
  if (number === undefined || number < 0) {
    return undefined;
  }

  const milliseconds = number > 10_000_000_000 ? number : number * 1000;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function toThreadGoalStatus(value: unknown): ThreadGoalStatus | undefined {
  switch (value) {
    case "active":
    case "paused":
    case "blocked":
    case "usageLimited":
    case "budgetLimited":
    case "complete":
      return value;
    default:
      return undefined;
  }
}

function normalizeCodexThreadGoal(
  value: unknown,
  fallbackThreadId: ThreadId,
): ThreadGoal | undefined {
  const goal = asObject(value);
  if (!goal) {
    return undefined;
  }

  const objective = asString(goal.objective)?.trim();
  const status = toThreadGoalStatus(goal.status);
  const tokensUsed = asNonNegativeInteger(goal.tokensUsed ?? goal.tokens_used);
  const timeUsedSeconds = asNonNegativeInteger(goal.timeUsedSeconds ?? goal.time_used_seconds);
  const createdAt = normalizeCodexGoalTimestamp(goal.createdAt ?? goal.created_at);
  const updatedAt = normalizeCodexGoalTimestamp(goal.updatedAt ?? goal.updated_at);

  if (
    !objective ||
    !status ||
    tokensUsed === undefined ||
    timeUsedSeconds === undefined ||
    !createdAt ||
    !updatedAt
  ) {
    return undefined;
  }

  const tokenBudgetValue = goal.tokenBudget ?? goal.token_budget;
  const tokenBudget =
    tokenBudgetValue === null ? null : (asNonNegativeInteger(tokenBudgetValue) ?? null);

  return {
    threadId: ThreadId.makeUnsafe(
      asString(goal.threadId ?? goal.thread_id) ?? String(fallbackThreadId),
    ),
    objective,
    status,
    tokenBudget,
    tokensUsed,
    timeUsedSeconds,
    createdAt,
    updatedAt,
  };
}

function toTurnId(value: string | undefined): TurnId | undefined {
  return value?.trim() ? TurnId.makeUnsafe(value) : undefined;
}

function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return value?.trim() ? ProviderItemId.makeUnsafe(value) : undefined;
}

function toTurnStatus(value: unknown): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

function normalizeItemType(raw: unknown): string {
  const type = asString(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toCanonicalItemType(raw: unknown): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("entered review") || type.includes("review entered")) return "review_entered";
  if (type.includes("exited review") || type.includes("review exited")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

function itemTitle(itemType: CanonicalItemType): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "review_entered":
      return "Review started";
    case "review_exited":
      return "Review completed";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

function normalizedCodexToolData(input: {
  item: Record<string, unknown>;
  payload: Record<string, unknown>;
  itemType: CanonicalItemType;
}) {
  const directToolData =
    extractStructuredProviderToolData(input.item) ??
    extractStructuredProviderToolData(input.payload);
  if (directToolData && input.itemType !== "collab_agent_tool_call") {
    return {
      toolName: directToolData.toolName,
      input: directToolData.input,
      ...(directToolData.result !== undefined ? { result: directToolData.result } : {}),
      item: input.item,
    };
  }

  if (input.itemType === "command_execution") {
    const explicitResult =
      asObject(input.item.result) ??
      asObject(input.payload.result) ??
      asObject(asObject(input.payload.item)?.result);
    const stdout = asString(input.item.stdout) ?? asString(input.payload.stdout);
    const stderr = asString(input.item.stderr) ?? asString(input.payload.stderr);
    const output = asString(input.item.output) ?? asString(input.payload.output);
    const result =
      explicitResult ??
      (stdout || stderr || output
        ? {
            ...(stdout ? { stdout } : {}),
            ...(stderr ? { stderr } : {}),
            ...(output ? { output } : {}),
          }
        : undefined);
    const command =
      asString(input.item.command) ?? asString(result?.command) ?? asString(input.payload.command);
    if (command) {
      return {
        toolName: "exec_command",
        input: { command },
        ...(result ? { result } : {}),
        item: input.item,
      };
    }
  }

  if (input.itemType === "collab_agent_tool_call") {
    const tool =
      asString(input.item.tool) ??
      asString(input.payload.tool) ??
      asString(asObject(input.payload.item)?.tool);
    const prompt = asString(input.item.prompt) ?? asString(input.payload.prompt);
    const description =
      asString(input.item.summary) ?? asString(input.item.title) ?? asString(input.item.text);
    const receiverThreadIds =
      asArray(input.item.receiverThreadIds)?.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ) ?? [];
    const agentsStates = asObject(input.item.agentsStates) ?? asObject(input.payload.agentsStates);
    const targets =
      receiverThreadIds.length > 0
        ? receiverThreadIds
        : agentsStates
          ? Object.keys(agentsStates).filter((value) => value.trim().length > 0)
          : [];
    return {
      toolName: tool ?? "spawnAgent",
      input: {
        ...(description ? { description } : {}),
        ...(prompt ? { prompt } : {}),
        ...(targets.length > 0 ? { targets } : {}),
        ...(receiverThreadIds.length > 0 ? { receiverThreadIds } : {}),
        ...(agentsStates ? { agentsStates } : {}),
      },
      ...(directToolData?.result !== undefined ? { result: directToolData.result } : {}),
      item: input.item,
    };
  }

  return null;
}

function itemDetail(
  item: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | undefined {
  const nestedResult = asObject(item.result);
  const candidates = [
    asString(item.command),
    asString(item.title),
    asString(item.summary),
    asString(item.text),
    asString(item.review),
    asString(item.path),
    asString(item.prompt),
    asString(nestedResult?.command),
    asString(payload.command),
    asString(payload.message),
    asString(payload.prompt),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return undefined;
}

function fileChangePatchDetail(payload: Record<string, unknown>): string | undefined {
  const item = asObject(payload.item);
  const source = item ?? payload;
  const changes = asArray(source.changes) ?? asArray(payload.changes);
  const paths =
    changes
      ?.flatMap((entry) => {
        const change = asObject(entry);
        const path = asString(change?.path)?.trim();
        return path ? [path] : [];
      })
      .filter((path, index, allPaths) => allPaths.indexOf(path) === index) ?? [];

  if (paths.length === 1) {
    return paths[0];
  }
  if (paths.length > 1) {
    return `${paths.length} file changes`;
  }

  return asString(source.path)?.trim() ?? asString(payload.path)?.trim();
}

function extractTextDelta(
  event: ProviderEvent,
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const content = asObject(payload?.content);
  const item = asObject(payload?.item);
  const summary = asObject(payload?.summary);
  const summaryPart = asObject(payload?.summaryPart) ?? asObject(payload?.summary_part);
  const part = asObject(payload?.part);
  const msg = codexEventMessage(payload);
  const candidates = [
    event.textDelta,
    asString(payload?.delta),
    asString(payload?.text),
    asString(payload?.textDelta),
    asString(payload?.text_delta),
    decodeBase64Text(payload?.deltaBase64),
    decodeBase64Text(payload?.delta_base64),
    asString(content?.delta),
    asString(content?.text),
    asString(content?.textDelta),
    asString(content?.text_delta),
    asString(item?.delta),
    asString(item?.text),
    asString(summary?.delta),
    asString(summary?.text),
    asString(summaryPart?.delta),
    asString(summaryPart?.text),
    asString(part?.delta),
    asString(part?.text),
    asString(msg?.delta),
    asString(msg?.text),
    asString(msg?.text_delta),
  ];
  return candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0);
}

function extractSummaryIndex(payload: Record<string, unknown> | undefined): number | undefined {
  const summaryPart = asObject(payload?.summaryPart) ?? asObject(payload?.summary_part);
  const summary = asObject(payload?.summary);
  const msg = codexEventMessage(payload);
  return (
    asNumber(payload?.summaryIndex) ??
    asNumber(payload?.summary_index) ??
    asNumber(summaryPart?.summaryIndex) ??
    asNumber(summaryPart?.summary_index) ??
    asNumber(summaryPart?.index) ??
    asNumber(summary?.summaryIndex) ??
    asNumber(summary?.summary_index) ??
    asNumber(summary?.index) ??
    asNumber(msg?.summary_index)
  );
}

function outputStreamFromPayload(
  payload: Record<string, unknown> | undefined,
): "stdout" | "stderr" | undefined {
  const stream = asString(payload?.stream);
  return stream === "stdout" || stream === "stderr" ? stream : undefined;
}

function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/permissions/requestApproval":
    case "permissions/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
    case "tool/requestUserInput":
    case "mcpServer/elicitation/request":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    case "attestation/generate":
      return "attestation_generate";
    default:
      return "unknown";
  }
}

function toRequestTypeFromKind(kind: unknown): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    case "computer-use":
      return "computer_use_approval";
    default:
      return "unknown";
  }
}

function toRequestTypeFromPayload(
  payload: Record<string, unknown> | undefined,
): CanonicalRequestType {
  const request = asObject(payload?.request);
  const method =
    asString(request?.method) ??
    asString(request?.requestMethod) ??
    asString(request?.request_method) ??
    asString(payload?.method) ??
    asString(payload?.requestMethod) ??
    asString(payload?.request_method);
  if (method) {
    return toRequestTypeFromMethod(method);
  }
  const requestKind =
    asString(request?.kind) ??
    asString(request?.requestKind) ??
    asString(request?.request_kind) ??
    asString(payload?.requestKind) ??
    asString(payload?.request_kind) ??
    asString(payload?.kind);
  if (requestKind) {
    return toRequestTypeFromKind(requestKind);
  }
  return "unknown";
}

function requestIdFromPayload(payload: Record<string, unknown> | undefined): string | undefined {
  const request = asObject(payload?.request);
  return (
    asString(payload?.requestId) ??
    asString(payload?.request_id) ??
    asString(request?.id) ??
    asString(request?.requestId) ??
    asString(request?.request_id)
  );
}

function toRequestTypeFromEvent(event: ProviderEvent): CanonicalRequestType {
  const payloadRequestType = toRequestTypeFromPayload(asObject(event.payload));
  if (payloadRequestType !== "unknown") {
    return payloadRequestType;
  }
  if (event.requestKind !== undefined) {
    return toRequestTypeFromKind(event.requestKind);
  }
  return toRequestTypeFromMethod(event.method);
}

function toCanonicalUserInputAnswers(
  answers: ProviderUserInputAnswers | undefined,
): ProviderUserInputAnswers {
  if (!answers) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(answers).flatMap(([questionId, value]) => {
      if (typeof value === "string") {
        return [[questionId, value] as const];
      }

      if (Array.isArray(value)) {
        const normalized = value.filter((entry): entry is string => typeof entry === "string");
        return [[questionId, normalized.length === 1 ? normalized[0] : normalized] as const];
      }

      const answerObject = asObject(value);
      const answerList = asArray(answerObject?.answers)?.filter(
        (entry): entry is string => typeof entry === "string",
      );
      if (!answerList) {
        return [];
      }
      return [[questionId, answerList.length === 1 ? answerList[0] : answerList] as const];
    }),
  );
}

function toUserInputQuestions(payload: Record<string, unknown> | undefined) {
  const questions = asArray(payload?.questions);
  if (!questions) {
    return undefined;
  }

  const parsedQuestions = questions
    .map((entry) => {
      const question = asObject(entry);
      if (!question) return undefined;
      const id = asString(question.id ?? question.name)?.trim();
      if (!id) {
        return undefined;
      }
      const header = asString(question.header)?.trim() ?? asString(question.title)?.trim() ?? id;
      const prompt =
        asString(question.question)?.trim() ??
        asString(question.prompt)?.trim() ??
        asString(question.description)?.trim() ??
        header;
      const parsedOptions =
        asArray(question.options)
          ?.map((option) => {
            const directLabel = asString(option)?.trim();
            if (directLabel) {
              return { label: directLabel, description: directLabel };
            }

            const optionRecord = asObject(option);
            if (!optionRecord) return undefined;
            const label =
              asString(optionRecord.label)?.trim() ??
              asString(optionRecord.title)?.trim() ??
              asString(optionRecord.value)?.trim() ??
              asString(optionRecord.id)?.trim();
            if (!label) {
              return undefined;
            }
            return {
              label,
              description: asString(optionRecord.description)?.trim() ?? label,
            };
          })
          .filter(
            (option): option is { label: string; description: string } => option !== undefined,
          ) ?? [];
      const options =
        parsedOptions.length > 0 ? parsedOptions : [{ label: "Respond", description: prompt }];
      const multiSelect =
        typeof question.multiSelect === "boolean"
          ? question.multiSelect
          : typeof question.multi_select === "boolean"
            ? question.multi_select
            : undefined;
      const normalizedQuestion = {
        id,
        header,
        question: prompt,
        options,
      };
      if (multiSelect !== undefined) {
        return Object.assign(normalizedQuestion, { multiSelect });
      }
      return normalizedQuestion;
    })
    .filter(
      (
        question,
      ): question is {
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description: string }>;
        multiSelect?: boolean;
      } => question !== undefined,
    );

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

function toThreadState(
  value: unknown,
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  const status = asObject(value);
  if (status) {
    return toThreadState(status.type);
  }

  switch (value) {
    case "idle":
      return "idle";
    case "notLoaded":
      return "closed";
    case "archived":
      return "archived";
    case "closed":
      return "closed";
    case "compacted":
      return "compacted";
    case "error":
    case "failed":
    case "systemError":
      return "error";
    default:
      return "active";
  }
}

function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "command/exec/outputDelta":
    case "process/outputDelta":
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

const PROPOSED_PLAN_BLOCK_REGEX = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;

function extractProposedPlanMarkdown(text: string | undefined): string | undefined {
  const match = text ? PROPOSED_PLAN_BLOCK_REGEX.exec(text) : null;
  const planMarkdown = match?.[1]?.trim();
  return planMarkdown && planMarkdown.length > 0 ? planMarkdown : undefined;
}

function asRuntimeItemId(itemId: ProviderItemId): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(itemId);
}

function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(requestId);
}

function normalizeCodexPlanStepStatus(value: unknown): "pending" | "inProgress" | "completed" {
  switch (value) {
    case "completed":
    case "done":
      return "completed";
    case "inProgress":
    case "in_progress":
      return "inProgress";
    case "pending":
    default:
      return "pending";
  }
}

function normalizeCodexHookOutcome(value: unknown): "success" | "error" | "cancelled" {
  switch (value) {
    case "completed":
      return "success";
    case "stopped":
      return "cancelled";
    case "failed":
    case "blocked":
    default:
      return "error";
  }
}

function codexHookOutput(
  entries: unknown[] | undefined,
  options?: { readonly kind?: string },
): string | undefined {
  const text = entries
    ?.flatMap((entry) => {
      const output = asObject(entry);
      if (!output) {
        return [];
      }
      if (options?.kind && asString(output.kind) !== options.kind) {
        return [];
      }
      const line = asString(output.text)?.trim();
      return line ? [line] : [];
    })
    .join("\n")
    .trim();
  return text && text.length > 0 ? text : undefined;
}

type CodexTaskListItem = Extract<
  ProviderRuntimeEvent,
  { type: "turn.tasks.updated" }
>["payload"]["items"][number];

function codexEventMessage(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return asObject(payload?.msg);
}

function codexTaskId(
  payload: Record<string, unknown> | undefined,
  message: Record<string, unknown> | undefined,
): RuntimeTaskId | undefined {
  const taskId =
    asString(message?.turn_id) ??
    asString(message?.turnId) ??
    asString(payload?.taskId) ??
    asString(payload?.task_id) ??
    asString(payload?.id);
  return taskId ? RuntimeTaskId.makeUnsafe(taskId) : undefined;
}

function codexTaskErrorSummary(value: unknown): string | undefined {
  const error = asObject(value);
  return (
    asString(error?.message) ?? asString(error?.detail) ?? asString(asObject(error?.error)?.message)
  );
}

function codexEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const nativeTurnId = toTurnId(asString(msg?.turn_id) ?? asString(msg?.turnId));
  const routedTurnId = event.turnId ?? nativeTurnId;
  const itemId = event.itemId ?? toProviderItemId(asString(msg?.item_id) ?? asString(msg?.itemId));
  const requestId = asString(msg?.request_id) ?? asString(msg?.requestId);
  const base = runtimeEventBase(event, canonicalThreadId);
  const providerRefs = base.providerRefs
    ? {
        ...base.providerRefs,
        ...((nativeTurnId ?? routedTurnId) ? { providerTurnId: nativeTurnId ?? routedTurnId } : {}),
        ...(itemId ? { providerItemId: itemId } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      }
    : {
        ...((nativeTurnId ?? routedTurnId) ? { providerTurnId: nativeTurnId ?? routedTurnId } : {}),
        ...(itemId ? { providerItemId: itemId } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      };

  return {
    ...base,
    ...(routedTurnId ? { turnId: routedTurnId } : {}),
    ...(itemId ? { itemId: asRuntimeItemId(itemId) } : {}),
    ...(requestId ? { requestId: asRuntimeRequestId(requestId) } : {}),
    ...(Object.keys(providerRefs).length > 0 ? { providerRefs } : {}),
  };
}

function eventRawSource(event: ProviderEvent): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

function runtimeEventBaseWithProviderItemId(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  itemId: string | undefined,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const base = runtimeEventBase(event, canonicalThreadId);
  const trimmedItemId = itemId?.trim();
  if (!trimmedItemId) {
    return base;
  }
  const providerItemId = ProviderItemId.makeUnsafe(trimmedItemId);
  return {
    ...base,
    itemId: RuntimeItemId.makeUnsafe(trimmedItemId),
    providerRefs: {
      ...base.providerRefs,
      providerItemId,
    },
  };
}

function runtimeEventBaseWithProviderRequestId(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  requestId: string | undefined,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const base = runtimeEventBase(event, canonicalThreadId);
  const trimmedRequestId = requestId?.trim();
  if (!trimmedRequestId) {
    return base;
  }
  return {
    ...base,
    requestId: asRuntimeRequestId(trimmedRequestId),
    providerRefs: {
      ...base.providerRefs,
      providerRequestId: trimmedRequestId,
    },
  };
}

function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  const source = item ?? payload;
  if (!source) {
    return undefined;
  }

  const providerItemId = asString(source.id) ?? asString(payload?.itemId);
  const inferredToolData = normalizedCodexToolData({
    item: source,
    payload: payload ?? {},
    itemType: toCanonicalItemType(source.type ?? source.kind),
  });
  const itemType = inferredToolData
    ? classifyProviderToolLifecycleItemType(inferredToolData.toolName)
    : toCanonicalItemType(source.type ?? source.kind);
  if (itemType === "unknown" && lifecycle !== "item.updated") {
    return undefined;
  }

  const detail =
    (inferredToolData
      ? summarizeProviderToolInvocation(inferredToolData.toolName, inferredToolData.input)
      : undefined) ?? itemDetail(source, payload ?? {});
  const status =
    lifecycle === "item.started"
      ? "inProgress"
      : lifecycle === "item.completed"
        ? "completed"
        : undefined;

  return {
    ...runtimeEventBaseWithProviderItemId(event, canonicalThreadId, providerItemId),
    type: lifecycle,
    payload: {
      itemType,
      ...(status ? { status } : {}),
      ...(inferredToolData
        ? { title: providerToolTitle(inferredToolData.toolName) }
        : itemTitle(itemType)
          ? { title: itemTitle(itemType) }
          : {}),
      ...(detail ? { detail } : {}),
      ...(inferredToolData
        ? { data: inferredToolData }
        : event.payload !== undefined
          ? { data: event.payload }
          : {}),
    },
  };
}

function toApprovalReviewStatus(
  value: unknown,
): "inProgress" | "approved" | "denied" | "aborted" | undefined {
  switch (value) {
    case "inProgress":
    case "approved":
    case "denied":
    case "aborted":
      return value;
    default:
      return undefined;
  }
}

function toApprovalReviewRiskLevel(
  value: unknown,
): "low" | "medium" | "high" | "critical" | undefined {
  switch (value) {
    case "low":
    case "medium":
    case "high":
    case "critical":
      return value;
    default:
      return undefined;
  }
}

function toApprovalReviewUserAuthorization(
  value: unknown,
): "unknown" | "low" | "medium" | "high" | undefined {
  switch (value) {
    case "unknown":
    case "low":
    case "medium":
    case "high":
      return value;
    default:
      return undefined;
  }
}

function trimmedNonEmpty(value: unknown): string | undefined {
  const text = asString(value)?.trim();
  return text && text.length > 0 ? text : undefined;
}

function mapAutoApprovalReview(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "approval.review.started" | "approval.review.completed",
): ProviderRuntimeEvent | undefined {
  const payload = asObject(event.payload);
  if (!payload) {
    return undefined;
  }

  const review = asObject(payload.review);
  const targetItemId =
    trimmedNonEmpty(payload.targetItemId) ?? trimmedNonEmpty(payload.target_item_id);
  const reviewId =
    trimmedNonEmpty(payload.reviewId) ??
    trimmedNonEmpty(payload.review_id) ??
    trimmedNonEmpty(review?.id) ??
    trimmedNonEmpty(review?.reviewId) ??
    trimmedNonEmpty(review?.review_id);
  const status = toApprovalReviewStatus(review?.status ?? payload.status);
  const riskLevel = toApprovalReviewRiskLevel(review?.riskLevel ?? review?.risk_level);
  const userAuthorization = toApprovalReviewUserAuthorization(
    review?.userAuthorization ?? review?.user_authorization,
  );
  const rationale =
    trimmedNonEmpty(review?.rationale) ??
    trimmedNonEmpty(review?.reason) ??
    trimmedNonEmpty(payload.rationale);

  return {
    ...runtimeEventBaseWithProviderItemId(event, canonicalThreadId, targetItemId),
    type: lifecycle,
    payload: {
      ...(targetItemId ? { targetItemId: RuntimeItemId.makeUnsafe(targetItemId) } : {}),
      ...(reviewId ? { reviewId } : {}),
      ...(status ? { status } : {}),
      ...(riskLevel ? { riskLevel } : {}),
      ...(userAuthorization ? { userAuthorization } : {}),
      ...(rationale ? { rationale } : {}),
      ...(payload.review !== undefined ? { review: payload.review } : {}),
      ...(payload.action !== undefined ? { action: payload.action } : {}),
    },
  };
}

function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);

  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: event.message,
          class: "provider_error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.kind === "request") {
    if (
      event.method === "item/tool/requestUserInput" ||
      event.method === "tool/requestUserInput" ||
      event.method === "mcpServer/elicitation/request"
    ) {
      const questions = toUserInputQuestions(payload);
      if (!questions) {
        return [];
      }
      return [
        {
          ...runtimeEventBaseWithProviderRequestId(
            event,
            canonicalThreadId,
            requestIdFromPayload(payload),
          ),
          type: "user-input.requested",
          payload: {
            questions,
          },
        },
      ];
    }

    const detail =
      asString(payload?.command) ?? asString(payload?.reason) ?? asString(payload?.prompt);
    return [
      {
        ...runtimeEventBaseWithProviderRequestId(
          event,
          canonicalThreadId,
          requestIdFromPayload(payload),
        ),
        type: "request.opened",
        payload: {
          requestType: toRequestTypeFromEvent(event),
          ...(detail ? { detail } : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/requestApproval/decision") {
    const decision = normalizeProviderApprovalDecision(payload?.decision);
    const requestType = toRequestTypeFromEvent(event);
    return [
      {
        ...runtimeEventBaseWithProviderRequestId(
          event,
          canonicalThreadId,
          requestIdFromPayload(payload),
        ),
        type: "request.resolved",
        payload: {
          requestType,
          ...(decision ? { decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(event.payload !== undefined ? { resume: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/started") {
    const thread = asObject(payload?.thread);
    const payloadThreadId = asString(thread?.id);
    const providerThreadId = payloadThreadId ?? asString(payload?.threadId);
    if (!providerThreadId) {
      return [];
    }
    const startedEvent = {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "thread.started" as const,
      payload: {
        providerThreadId,
      },
    };
    const initialStatus = thread?.status ?? payload?.status ?? thread?.state ?? payload?.state;
    if (initialStatus === undefined) {
      return [startedEvent];
    }
    return [
      startedEvent,
      {
        type: "thread.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state: toThreadState(initialStatus),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (
    event.method === "thread/status/changed" ||
    event.method === "thread/archived" ||
    event.method === "thread/unarchived" ||
    event.method === "thread/closed" ||
    event.method === "thread/compacted"
  ) {
    return [
      {
        type: "thread.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state:
            event.method === "thread/archived"
              ? "archived"
              : event.method === "thread/closed"
                ? "closed"
                : event.method === "thread/compacted"
                  ? "compacted"
                  : toThreadState(
                      payload?.status ?? asObject(payload?.thread)?.status ?? payload?.state,
                    ),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/name/updated") {
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(asString(payload?.threadName) ? { name: asString(payload?.threadName) } : {}),
          ...(event.payload !== undefined ? { metadata: asObject(event.payload) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/settings/updated") {
    const threadSettings = asObject(payload?.threadSettings);
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          metadata: {
            ...(event.payload !== undefined ? { raw: event.payload } : {}),
            ...(threadSettings ? { threadSettings } : {}),
          },
        },
      },
    ];
  }

  if (event.method === "thread/goal/updated") {
    const goal = normalizeCodexThreadGoal(payload?.goal, canonicalThreadId);
    if (!goal) {
      return [];
    }
    return [
      {
        type: "thread.goal.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          goal,
        },
      },
    ];
  }

  if (event.method === "thread/goal/cleared") {
    return [
      {
        type: "thread.goal.cleared",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          clearedAt: event.createdAt,
        },
      },
    ];
  }

  if (event.method === "thread/tokenUsage/updated") {
    const tokenUsage = asObject(payload?.tokenUsage);
    const normalizedUsage = normalizeCodexTokenUsage(tokenUsage ?? event.payload);
    if (!normalizedUsage) {
      return [];
    }
    return [
      {
        type: "thread.token-usage.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          usage: normalizedUsage,
        },
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId,
        type: "turn.started",
        payload: {
          ...(asString(turn?.model) ? { model: asString(turn?.model) } : {}),
          ...(asString(turn?.effort) ? { effort: asString(turn?.effort) } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/completed") {
    const error = asObject(turn?.error);
    const errorMessage = asString(error?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: toTurnStatus(turn?.status),
          ...(asString(turn?.stopReason) ? { stopReason: asString(turn?.stopReason) } : {}),
          ...(turn?.usage !== undefined ? { usage: turn.usage } : {}),
          ...(asObject(turn?.modelUsage) ? { modelUsage: asObject(turn?.modelUsage) } : {}),
          ...(asNumber(turn?.totalCostUsd) !== undefined
            ? { totalCostUsd: asNumber(turn?.totalCostUsd) }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
          ...(error ? { error } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/aborted") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.aborted",
        payload: {
          reason: event.message ?? "Turn aborted",
        },
      },
    ];
  }

  if (event.method === "hook/started") {
    const run = asObject(payload?.run);
    const hookId = asString(run?.id) ?? `${event.id}:hook`;
    const hookEvent = asString(run?.eventName) ?? "unknown";
    const sourcePath = asString(run?.sourcePath);
    const hookName =
      (sourcePath ? path.basename(sourcePath) : undefined) ??
      asString(run?.handlerType) ??
      "Codex hook";
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "hook.started",
        payload: {
          hookId,
          hookName,
          hookEvent,
        },
      },
    ];
  }

  if (event.method === "hook/completed") {
    const run = asObject(payload?.run);
    const entries = asArray(run?.entries);
    const output = codexHookOutput(entries);
    const stderr = codexHookOutput(entries, { kind: "error" });
    const statusMessage = asString(run?.statusMessage)?.trim();
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "hook.completed",
        payload: {
          hookId: asString(run?.id) ?? `${event.id}:hook`,
          outcome: normalizeCodexHookOutcome(run?.status),
          ...(output ? { output } : {}),
          ...(stderr ? { stderr } : {}),
          ...(statusMessage ? { stdout: statusMessage } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/plan/updated") {
    const steps = Array.isArray(payload?.plan) ? payload.plan : [];
    const taskIdPrefix = event.turnId ?? event.id;
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.tasks.updated",
        payload: {
          source: "update_plan",
          items: steps.flatMap((entry, index): CodexTaskListItem[] => {
            const task = asObject(entry);
            if (!task) {
              return [];
            }
            const title = asString(task.step);
            if (!title) {
              return [];
            }
            return [
              {
                id: `${taskIdPrefix}:update-plan:${index}`,
                title,
                status: normalizeCodexPlanStepStatus(task.status),
                source: "update_plan",
              },
            ];
          }),
        },
      },
    ];
  }

  if (event.method === "turn/diff/updated") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.diff.updated",
        payload: {
          unifiedDiff:
            asString(payload?.unifiedDiff) ??
            asString(payload?.diff) ??
            asString(payload?.patch) ??
            "",
        },
      },
    ];
  }

  if (event.method === "item/started") {
    const started = mapItemLifecycle(event, canonicalThreadId, "item.started");
    return started ? [started] : [];
  }

  if (event.method === "item/completed") {
    const payload = asObject(event.payload);
    const item = asObject(payload?.item);
    const source = item ?? payload;
    if (!source) {
      return [];
    }
    const itemType = source ? toCanonicalItemType(source.type ?? source.kind) : "unknown";
    if (itemType === "plan") {
      const detail = itemDetail(source, payload ?? {});
      if (!detail) {
        return [];
      }
      return [
        {
          ...runtimeEventBaseWithProviderItemId(
            event,
            canonicalThreadId,
            asString(source.id) ?? asString(payload?.itemId),
          ),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: detail,
          },
        },
      ];
    }
    const completed = mapItemLifecycle(event, canonicalThreadId, "item.completed");
    return completed ? [completed] : [];
  }

  if (event.method === "item/autoApprovalReview/started") {
    const review = mapAutoApprovalReview(event, canonicalThreadId, "approval.review.started");
    return review ? [review] : [];
  }

  if (event.method === "item/autoApprovalReview/completed") {
    const review = mapAutoApprovalReview(event, canonicalThreadId, "approval.review.completed");
    return review ? [review] : [];
  }

  if (event.method === "item/reasoning/summaryPartAdded") {
    const delta = extractTextDelta(event, payload);
    if (delta && delta.length > 0) {
      const summaryIndex = extractSummaryIndex(payload);
      return [
        {
          ...runtimeEventBaseWithProviderItemId(
            event,
            canonicalThreadId,
            asString(payload?.itemId),
          ),
          type: "content.delta",
          payload: {
            streamKind: "reasoning_summary_text",
            delta,
            ...(summaryIndex !== undefined ? { summaryIndex } : {}),
          },
        },
      ];
    }
    const updated = mapItemLifecycle(event, canonicalThreadId, "item.updated");
    return updated ? [updated] : [];
  }

  if (event.method === "item/commandExecution/terminalInteraction") {
    const processId = asString(payload?.processId);
    return [
      {
        ...runtimeEventBaseWithProviderItemId(
          event,
          canonicalThreadId,
          asString(payload?.itemId) ?? processId,
        ),
        type: "item.updated",
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "Ran command",
          detail: processId ? `Sent terminal input to process ${processId}` : "Sent terminal input",
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/fileChange/patchUpdated") {
    const detail = payload ? fileChangePatchDetail(payload) : undefined;
    return [
      {
        ...runtimeEventBaseWithProviderItemId(event, canonicalThreadId, asString(payload?.itemId)),
        type: "item.updated",
        payload: {
          itemType: "file_change",
          status: "inProgress",
          title: "File change",
          ...(detail ? { detail } : {}),
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/plan/delta") {
    const delta =
      event.textDelta ??
      asString(payload?.delta) ??
      asString(payload?.text) ??
      asString(asObject(payload?.content)?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBaseWithProviderItemId(event, canonicalThreadId, asString(payload?.itemId)),
        type: "turn.proposed.delta",
        payload: {
          delta,
        },
      },
    ];
  }

  if (
    event.method === "item/agentMessage/delta" ||
    event.method === "command/exec/outputDelta" ||
    event.method === "process/outputDelta" ||
    event.method === "item/commandExecution/outputDelta" ||
    event.method === "item/fileChange/outputDelta" ||
    event.method === "item/reasoning/summaryTextDelta" ||
    event.method === "item/reasoning/textDelta"
  ) {
    const delta = extractTextDelta(event, payload);
    const summaryIndex = extractSummaryIndex(payload);
    if (!delta || delta.length === 0) {
      return [];
    }
    const providerItemId =
      event.method === "command/exec/outputDelta"
        ? asString(payload?.processId)
        : event.method === "process/outputDelta"
          ? asString(payload?.processHandle)
          : asString(payload?.itemId);
    const outputStream = outputStreamFromPayload(payload);
    return [
      {
        ...(providerItemId
          ? runtimeEventBaseWithProviderItemId(event, canonicalThreadId, providerItemId)
          : runtimeEventBase(event, canonicalThreadId)),
        type: "content.delta",
        payload: {
          streamKind: contentStreamKindFromMethod(event.method),
          delta,
          ...(typeof payload?.contentIndex === "number"
            ? { contentIndex: payload.contentIndex }
            : {}),
          ...(summaryIndex !== undefined ? { summaryIndex } : {}),
          ...(outputStream ? { outputStream } : {}),
          ...(typeof payload?.capReached === "boolean" ? { capReached: payload.capReached } : {}),
        },
      },
    ];
  }

  if (event.method === "process/exited") {
    const processHandle = asString(payload?.processHandle);
    const exitCode = asNumber(payload?.exitCode);
    const stdout = asString(payload?.stdout);
    const stderr = asString(payload?.stderr);
    return [
      {
        ...runtimeEventBaseWithProviderItemId(event, canonicalThreadId, processHandle),
        type: "item.completed",
        payload: {
          itemType: "command_execution",
          status: exitCode === undefined || exitCode === 0 ? "completed" : "failed",
          title: "Ran command",
          detail:
            exitCode !== undefined ? `Process exited with code ${exitCode}` : "Process exited",
          data: {
            ...(processHandle ? { processHandle } : {}),
            ...(exitCode !== undefined ? { exitCode } : {}),
            ...(stdout !== undefined ? { stdout } : {}),
            ...(stderr !== undefined ? { stderr } : {}),
            ...(payload?.stdoutCapReached !== undefined
              ? { stdoutCapReached: payload.stdoutCapReached }
              : {}),
            ...(payload?.stderrCapReached !== undefined
              ? { stderrCapReached: payload.stderrCapReached }
              : {}),
          },
        },
      },
    ];
  }

  if (event.method === "item/mcpToolCall/progress") {
    const summary = asString(payload?.summary) ?? asString(payload?.message);
    return [
      {
        ...runtimeEventBaseWithProviderItemId(event, canonicalThreadId, asString(payload?.itemId)),
        type: "tool.progress",
        payload: {
          ...(asString(payload?.toolUseId) ? { toolUseId: asString(payload?.toolUseId) } : {}),
          ...(asString(payload?.toolName) ? { toolName: asString(payload?.toolName) } : {}),
          ...(summary ? { summary } : {}),
          ...(asNumber(payload?.elapsedSeconds) !== undefined
            ? { elapsedSeconds: asNumber(payload?.elapsedSeconds) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "serverRequest/resolved") {
    const requestType = toRequestTypeFromEvent(event);
    return [
      {
        ...runtimeEventBaseWithProviderRequestId(
          event,
          canonicalThreadId,
          requestIdFromPayload(payload),
        ),
        type: "request.resolved",
        payload: {
          requestType,
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method?.startsWith("rawResponseItem/") === true) {
    return [
      {
        type: "raw-response.item",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          method: event.method,
          ...(payload?.item !== undefined ? { item: payload.item } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (
    event.method === "item/tool/requestUserInput/answered" ||
    event.method === "tool/requestUserInput/answered"
  ) {
    return [
      {
        ...runtimeEventBaseWithProviderRequestId(
          event,
          canonicalThreadId,
          requestIdFromPayload(payload),
        ),
        type: "user-input.resolved",
        payload: {
          answers: toCanonicalUserInputAnswers(
            asObject(event.payload)?.answers as ProviderUserInputAnswers | undefined,
          ),
        },
      },
    ];
  }

  if (event.method === "codex/event/task_started") {
    const msg = codexEventMessage(payload);
    const taskId = codexTaskId(payload, msg);
    if (!taskId) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.started",
        payload: {
          taskId,
          ...(asString(msg?.collaboration_mode_kind)
            ? { taskType: asString(msg?.collaboration_mode_kind) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "codex/event/task_complete") {
    const msg = codexEventMessage(payload);
    const taskId = codexTaskId(payload, msg);
    const proposedPlanMarkdown = extractProposedPlanMarkdown(asString(msg?.last_agent_message));
    if (!taskId) {
      if (!proposedPlanMarkdown) {
        return [];
      }
      return [
        {
          ...codexEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: proposedPlanMarkdown,
          },
        },
      ];
    }
    const errorSummary = codexTaskErrorSummary(msg?.error);
    const failed = msg?.error != null;
    const events: ProviderRuntimeEvent[] = [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.completed",
        payload: {
          taskId,
          status: failed ? "failed" : "completed",
          ...(failed && errorSummary
            ? { summary: errorSummary }
            : asString(msg?.last_agent_message)
              ? { summary: asString(msg?.last_agent_message) }
              : {}),
        },
      },
    ];
    if (proposedPlanMarkdown && !failed) {
      events.push({
        ...codexEventBase(event, canonicalThreadId),
        type: "turn.proposed.completed",
        payload: {
          planMarkdown: proposedPlanMarkdown,
        },
      });
    }
    return events;
  }

  if (event.method === "codex/event/agent_reasoning") {
    const msg = codexEventMessage(payload);
    const taskId = codexTaskId(payload, msg);
    const description = asString(msg?.text);
    if (!taskId || !description) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.progress",
        payload: {
          taskId,
          description,
        },
      },
    ];
  }

  if (event.method === "codex/event/reasoning_content_delta") {
    const msg = codexEventMessage(payload);
    const delta = asString(msg?.delta);
    if (!delta) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind:
            asNumber(msg?.summary_index) !== undefined
              ? "reasoning_summary_text"
              : "reasoning_text",
          delta,
          ...(asNumber(msg?.summary_index) !== undefined
            ? { summaryIndex: asNumber(msg?.summary_index) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "model/rerouted") {
    return [
      {
        type: "model.rerouted",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          fromModel: asString(payload?.fromModel) ?? "unknown",
          toModel: asString(payload?.toModel) ?? "unknown",
          reason: asString(payload?.reason) ?? "unknown",
        },
      },
    ];
  }

  if (event.method === "model/verification") {
    return [
      {
        type: "model.verification",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          verifications: asArray(payload?.verifications) ?? [],
        },
      },
    ];
  }

  if (event.method === "deprecationNotice") {
    return [
      {
        type: "deprecation.notice",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asString(payload?.summary) ?? "Deprecation notice",
          ...(asString(payload?.details) ? { details: asString(payload?.details) } : {}),
        },
      },
    ];
  }

  if (event.method === "configWarning") {
    return [
      {
        type: "config.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asString(payload?.summary) ?? "Configuration warning",
          ...(asString(payload?.details) ? { details: asString(payload?.details) } : {}),
          ...(asString(payload?.path) ? { path: asString(payload?.path) } : {}),
          ...(payload?.range !== undefined ? { range: payload.range } : {}),
        },
      },
    ];
  }

  if (event.method === "warning" || event.method === "guardianWarning") {
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message:
            asString(payload?.message) ??
            event.message ??
            (event.method === "guardianWarning" ? "Guardian warning" : "Provider warning"),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "account/updated") {
    return [
      {
        type: "account.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          account: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/rateLimits/updated") {
    return [
      {
        type: "account.rate-limits.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          rateLimits: payload?.rateLimits ?? event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/login/completed") {
    const success = payload?.success === true;
    const error = asString(payload?.error)?.trim();
    return [
      {
        type: "auth.status",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          isAuthenticating: false,
          output: [success ? "Codex login completed." : "Codex login failed."],
          ...(!success && error ? { error } : {}),
        },
      },
    ];
  }

  if (event.method === "mcpServer/oauthLogin/completed") {
    return [
      {
        type: "mcp.oauth.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          success: payload?.success === true,
          ...(asString(payload?.name) ? { name: asString(payload?.name) } : {}),
          ...(asString(payload?.error) ? { error: asString(payload?.error) } : {}),
        },
      },
    ];
  }

  if (event.method === "mcpServer/startupStatus/updated") {
    return [
      {
        type: "mcp.status.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          status: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "skills/changed") {
    return [
      {
        type: "skills.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: event.payload !== undefined ? { detail: event.payload } : {},
      },
    ];
  }

  if (event.method === "app/list/updated") {
    return [
      {
        type: "apps.list.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          apps: asArray(payload?.data) ?? asArray(payload?.apps) ?? [],
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "remoteControl/status/changed") {
    const status = trimmedNonEmpty(payload?.status);
    if (!status) {
      return [];
    }
    const environmentId =
      payload?.environmentId === null ? null : trimmedNonEmpty(payload?.environmentId);
    return [
      {
        type: "remote-control.status.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          status,
          ...(trimmedNonEmpty(payload?.serverName)
            ? { serverName: trimmedNonEmpty(payload?.serverName) }
            : {}),
          ...(environmentId !== undefined ? { environmentId } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "externalAgentConfig/import/completed") {
    return [
      {
        type: "external-agent-config.import.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: event.payload !== undefined ? { detail: event.payload } : {},
      },
    ];
  }

  if (event.method === "fuzzyFileSearch/sessionUpdated") {
    const sessionId = trimmedNonEmpty(payload?.sessionId);
    if (!sessionId) {
      return [];
    }
    return [
      {
        type: "fuzzy-file-search.session.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          sessionId,
          ...(asString(payload?.query) !== undefined ? { query: asString(payload?.query) } : {}),
          files: asArray(payload?.files) ?? [],
        },
      },
    ];
  }

  if (event.method === "fuzzyFileSearch/sessionCompleted") {
    const sessionId = trimmedNonEmpty(payload?.sessionId);
    if (!sessionId) {
      return [];
    }
    return [
      {
        type: "fuzzy-file-search.session.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          sessionId,
          ...(asString(payload?.query) !== undefined ? { query: asString(payload?.query) } : {}),
        },
      },
    ];
  }

  if (event.method === "fs/changed") {
    const watchId = trimmedNonEmpty(payload?.watchId);
    const changedPaths = asNonEmptyStringArray(payload?.changedPaths);
    if (!watchId || changedPaths.length === 0) {
      return [];
    }
    return [
      {
        type: "files.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          watchId,
          changedPaths,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/started") {
    const realtimeSessionId = asString(payload?.realtimeSessionId);
    const version = trimmedNonEmpty(payload?.version);
    return [
      {
        type: "thread.realtime.started",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(realtimeSessionId ? { realtimeSessionId } : {}),
          ...(version ? { version } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/realtime/sdp") {
    const sdp = asString(payload?.sdp)?.trim();
    if (!sdp) {
      return [];
    }
    return [
      {
        type: "thread.realtime.sdp",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          sdp,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/itemAdded") {
    return [
      {
        type: "thread.realtime.item-added",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          item: payload?.item ?? event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/transcript/delta") {
    return [
      {
        type: "thread.realtime.transcript.delta",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(asString(payload?.role) ? { role: asString(payload?.role) } : {}),
          delta: asString(payload?.delta) ?? "",
        },
      },
    ];
  }

  if (event.method === "thread/realtime/transcript/done") {
    return [
      {
        type: "thread.realtime.transcript.done",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(asString(payload?.role) ? { role: asString(payload?.role) } : {}),
          text: asString(payload?.text) ?? "",
        },
      },
    ];
  }

  if (event.method === "thread/realtime/outputAudio/delta") {
    return [
      {
        type: "thread.realtime.audio.delta",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          audio: payload?.audio ?? event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/error") {
    const message = asString(payload?.message) ?? event.message ?? "Realtime error";
    return [
      {
        type: "thread.realtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/closed") {
    const reason = trimmedNonEmpty(payload?.reason) ?? event.message;
    return [
      {
        type: "thread.realtime.closed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: reason ? { reason } : {},
      },
    ];
  }

  if (event.method === "error") {
    const message =
      asString(asObject(payload?.error)?.message) ?? event.message ?? "Provider runtime error";
    const willRetry = payload?.willRetry === true;
    return [
      {
        type: willRetry ? "runtime.warning" : "runtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
          ...(!willRetry ? { class: "provider_error" as const } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "process/stderr") {
    const message = event.message ?? "Codex process stderr";
    const isFatal = isFatalCodexProcessStderrMessage(message);
    return [
      isFatal
        ? {
            type: "runtime.error",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message,
              class: "provider_error" as const,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          }
        : {
            type: "runtime.warning",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          },
    ];
  }

  if (event.method === "windows/worldWritableWarning") {
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message ?? "Windows world-writable warning",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windowsSandbox/setupCompleted") {
    const payloadRecord = asObject(event.payload);
    const success = payloadRecord?.success;
    const successMessage = event.message ?? "Windows sandbox setup completed";
    const failureMessage = event.message ?? "Windows sandbox setup failed";

    return [
      {
        type: "session.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state: success === false ? "error" : "ready",
          reason: success === false ? failureMessage : successMessage,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
      ...(success === false
        ? [
            {
              type: "runtime.warning" as const,
              ...runtimeEventBase(event, canonicalThreadId),
              payload: {
                message: failureMessage,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            },
          ]
        : []),
    ];
  }

  return [];
}

const makeCodexAdapter = Effect.fn("makeCodexAdapter")(function* (
  options?: CodexAdapterLiveOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* Effect.service(ServerConfig);
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);

  const acquireManager = Effect.fn("acquireManager")(function* () {
    if (options?.manager) {
      return options.manager;
    }
    const services = yield* Effect.services<never>();
    return options?.makeManager?.(services) ?? new CodexAppServerManager(services);
  });

  const temporaryCodexHomesRef = yield* Ref.make(
    new Map<ThreadId, { cleanup: () => Promise<void> }>(),
  );

  const rememberTemporaryCodexHome = (threadId: ThreadId, cleanup: () => Promise<void>) =>
    Ref.update(temporaryCodexHomesRef, (existing) => {
      const next = new Map(existing);
      next.set(threadId, { cleanup });
      return next;
    }).pipe(Effect.asVoid);

  const releaseTemporaryCodexHome = (threadId: ThreadId) =>
    Ref.modify(temporaryCodexHomesRef, (existing) => {
      const next = new Map(existing);
      const removed = next.get(threadId);
      next.delete(threadId);
      return [removed?.cleanup, next] as const;
    });

  const releaseAllTemporaryCodexHomes = Ref.modify(temporaryCodexHomesRef, (existing) => [
    [...existing.values()].map((entry) => entry.cleanup),
    new Map<ThreadId, { cleanup: () => Promise<void> }>(),
  ]);

  const manager = yield* Effect.acquireRelease(acquireManager(), (manager) =>
    Effect.gen(function* () {
      try {
        manager.stopAll();
      } catch {
        // Finalizers should never fail and block shutdown.
      }
      const cleanups = yield* releaseAllTemporaryCodexHomes;
      yield* Effect.forEach(
        cleanups,
        (cleanup) => Effect.promise(cleanup).pipe(Effect.ignore({ log: false })),
        { concurrency: "unbounded", discard: true },
      );
    }),
  );
  const serverSettingsService = yield* ServerSettingsService;

  const startSession: CodexAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const settings = yield* serverSettingsService.getSettings.pipe(
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
      const codexSettings = settings.providers.codex;
      const binaryPath = resolvePreferredCodexBinaryPath(codexSettings.binaryPath);
      const supportsReasoningSummary = supportsCodexReasoningSummary(binaryPath);
      const preparedHome = yield* Effect.tryPromise(() =>
        (options?.loadManagedMcpServers ?? loadCodexManagedMcpServers)({
          settings,
          ...(input.cwd ? { cwd: input.cwd } : {}),
        }).then(async (effectiveServers) => {
          const prepared = await prepareCodexHomeWithManagedMcpServers({
            threadId: String(input.threadId),
            runtimeRootDir: serverConfig.stateDir,
            homePath: codexSettings.homePath,
            servers: effectiveServers.servers,
            oauthStorageDir: path.join(serverConfig.stateDir, "mcp-oauth"),
          });
          return {
            prepared,
            warnings: effectiveServers.warnings,
          };
        }),
      ).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(
              "codex mcp configuration preparation failed; continuing without managed MCP servers",
            );
            yield* Effect.logWarning(
              toMessage(cause, "Failed to prepare the Codex MCP configuration."),
            );
            return { prepared: null, warnings: [] };
          }),
        ),
      );
      for (const warning of preparedHome.warnings) {
        yield* Effect.logWarning("codex mcp arbitration warning", {
          threadId: input.threadId,
          warning,
        });
      }
      const homePath = preparedHome.prepared?.homePath ?? codexSettings.homePath;
      const managerInput: CodexAppServerStartSessionInput = {
        threadId: input.threadId,
        provider: "codex",
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimeMode: input.runtimeMode,
        binaryPath,
        supportsReasoningSummary,
        ...(homePath ? { homePath } : {}),
        ...(input.modelSelection?.provider === "codex"
          ? { model: input.modelSelection.model }
          : {}),
        ...(input.modelSelection?.provider === "codex" && input.modelSelection.options?.fastMode
          ? { serviceTier: "fast" }
          : {}),
      };

      return yield* Effect.tryPromise({
        try: () => manager.startSession(managerInput),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: toMessage(cause, "Failed to start Codex adapter session."),
            cause,
          }),
      }).pipe(
        Effect.tap(() =>
          preparedHome.prepared
            ? rememberTemporaryCodexHome(input.threadId, preparedHome.prepared.cleanup)
            : Effect.void,
        ),
        Effect.tapError(() =>
          preparedHome.prepared
            ? Effect.promise(preparedHome.prepared.cleanup).pipe(Effect.ignore({ log: false }))
            : Effect.void,
        ),
      );
    },
  );

  const resolveAttachment = Effect.fn("resolveAttachment")(function* (
    input: ProviderSendTurnInput,
    attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
  ) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* toRequestError(
        input.threadId,
        "turn/start",
        new Error(`Invalid attachment id '${attachment.id}'.`),
      );
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
      type: "image" as const,
      url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  });

  const sendTurn: CodexAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const codexAttachments = yield* Effect.forEach(
      input.attachments ?? [],
      (attachment) => resolveAttachment(input, attachment),
      { concurrency: 1 },
    );

    return yield* Effect.tryPromise({
      try: () => {
        const managerInput = {
          threadId: input.threadId,
          ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
          ...(input.input !== undefined ? { input: input.input } : {}),
          ...(input.modelSelection?.provider === "codex"
            ? { model: input.modelSelection.model }
            : {}),
          ...(input.modelSelection?.provider === "codex" &&
          input.modelSelection.options?.reasoningEffort !== undefined
            ? { effort: input.modelSelection.options.reasoningEffort }
            : {}),
          ...(input.modelSelection?.provider === "codex" && input.modelSelection.options?.fastMode
            ? { serviceTier: "fast" }
            : {}),
          ...(input.interactionMode !== undefined
            ? { interactionMode: input.interactionMode }
            : {}),
          ...(codexAttachments.length > 0 ? { attachments: codexAttachments } : {}),
        };
        return manager.sendTurn(managerInput);
      },
      catch: (cause) => toRequestError(input.threadId, "turn/start", cause),
    }).pipe(
      Effect.map((result) => ({
        ...result,
        threadId: input.threadId,
      })),
    );
  });

  const steerTurn: NonNullable<CodexAdapterShape["steerTurn"]> = (input) =>
    Effect.tryPromise({
      try: () =>
        manager.steerTurn({
          threadId: input.threadId,
          ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
          ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
          input: input.input,
        }),
      catch: (cause) => toRequestError(input.threadId, "turn/steer", cause),
    });

  const interruptTurn: CodexAdapterShape["interruptTurn"] = (threadId, turnId) =>
    Effect.tryPromise({
      try: () => manager.interruptTurn(threadId, turnId),
      catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
    });

  const readThread: CodexAdapterShape["readThread"] = (threadId) =>
    Effect.tryPromise({
      try: () => manager.readThread(threadId),
      catch: (cause) => toRequestError(threadId, "thread/read", cause),
    }).pipe(
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );

  const rollbackThread: CodexAdapterShape["rollbackThread"] = (threadId, numTurns) => {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        }),
      );
    }

    return Effect.tryPromise({
      try: () => manager.rollbackThread(threadId, numTurns),
      catch: (cause) => toRequestError(threadId, "thread/rollback", cause),
    }).pipe(
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );
  };

  const respondToRequest: CodexAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.tryPromise({
      try: () => manager.respondToRequest(threadId, requestId, decision),
      catch: (cause) => toRequestError(threadId, "item/requestApproval/decision", cause),
    });

  const respondToUserInput: CodexAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.tryPromise({
      try: () => manager.respondToUserInput(threadId, requestId, answers),
      catch: (cause) => toRequestError(threadId, "item/tool/requestUserInput", cause),
    });

  const stopSession: CodexAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      yield* Effect.sync(() => {
        manager.stopSession(threadId);
      });
      const cleanup = yield* releaseTemporaryCodexHome(threadId);
      if (cleanup) {
        yield* Effect.promise(cleanup).pipe(Effect.ignore({ log: false }));
      }
    });

  const readUsage: CodexAdapterShape["readUsage"] = Effect.fn("readUsage")(function* () {
    const codexSettings = yield* serverSettingsService.getSettings.pipe(
      Effect.map((settings) => settings.providers.codex),
      Effect.mapError(
        (error) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "account/rateLimits/read",
            detail: error.message,
            cause: error,
          }),
      ),
    );

    const activeSession = manager.listSessions()[0];

    return yield* Effect.tryPromise({
      try: async () => {
        if (activeSession) {
          try {
            return await manager.readUsage(activeSession.threadId);
          } catch {
            // Fall through to a standalone app-server probe. The active session
            // may have exited between listSessions and readUsage.
          }
        }

        let probeError: unknown;
        try {
          return await (options?.probeUsage ?? probeCodexUsage)({
            binaryPath: resolvePreferredCodexBinaryPath(codexSettings.binaryPath),
            ...(codexSettings.homePath ? { homePath: codexSettings.homePath } : {}),
          });
        } catch (error) {
          probeError = error;
        }

        let oauthError: unknown;
        try {
          const oauthUsage = codexSettings.homePath
            ? await (options?.fetchOAuthUsage ?? fetchCodexOAuthUsageSnapshot)({
                homePath: codexSettings.homePath,
              })
            : await (options?.fetchOAuthUsage ?? fetchCodexOAuthUsageSnapshot)();
          if (oauthUsage) {
            return oauthUsage;
          }
        } catch (error) {
          oauthError = error;
        }

        throw new Error(
          usageDiagnostic({
            probeError,
            oauthError,
            oauthReturnedEmpty: oauthError === undefined,
          }),
        );
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "account/rateLimits/read",
          detail: toMessage(cause, "Failed to read Codex account usage."),
          cause,
        }),
    });
  });

  const listSessions: CodexAdapterShape["listSessions"] = () =>
    Effect.sync(() => manager.listSessions());

  const hasSession: CodexAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => manager.hasSession(threadId));

  const stopAll: CodexAdapterShape["stopAll"] = () =>
    Effect.gen(function* () {
      yield* Effect.sync(() => {
        manager.stopAll();
      });
      const cleanups = yield* releaseAllTemporaryCodexHomes;
      yield* Effect.forEach(
        cleanups,
        (cleanup) => Effect.promise(cleanup).pipe(Effect.ignore({ log: false })),
        { concurrency: "unbounded", discard: true },
      );
    });

  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const writeNativeEvent = Effect.fn("writeNativeEvent")(function* (event: ProviderEvent) {
    if (!nativeEventLogger) {
      return;
    }
    yield* nativeEventLogger.write(event, event.threadId);
  });

  const registerListener = Effect.fn("registerListener")(function* () {
    const services = yield* Effect.services<never>();
    const listenerEffect = Effect.fn("listener")(function* (event: ProviderEvent) {
      yield* writeNativeEvent(event);
      const runtimeEvents = mapToRuntimeEvents(event, event.threadId);
      if (runtimeEvents.length === 0) {
        yield* Effect.logDebug("ignoring unhandled Codex provider event", {
          method: event.method,
          threadId: event.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
        });
        return;
      }
      yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
    });
    const listener = (event: ProviderEvent) =>
      listenerEffect(event).pipe(Effect.runPromiseWith(services));
    manager.on("event", listener);
    return listener;
  });

  const unregisterListener = Effect.fn("unregisterListener")(function* (
    listener: (event: ProviderEvent) => Promise<void>,
  ) {
    yield* Effect.sync(() => {
      manager.off("event", listener);
    });
    yield* Queue.shutdown(runtimeEventQueue);
  });

  yield* Effect.acquireRelease(registerListener(), unregisterListener);

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
    steerTurn,
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
  } satisfies CodexAdapterShape;
});

export const CodexAdapterLive = Layer.effect(CodexAdapter, makeCodexAdapter());

export function makeCodexAdapterLive(options?: CodexAdapterLiveOptions) {
  return Layer.effect(CodexAdapter, makeCodexAdapter(options));
}
