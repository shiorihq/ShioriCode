/**
 * CursorAdapterLive — Cursor Agent SDK provider adapter.
 *
 * @module CursorAdapterLive
 */
import * as nodePath from "node:path";

import {
  Agent,
  type AgentModeOption,
  type AgentOptions,
  type InteractionUpdate,
  type McpServerConfig,
  type ModelSelection as CursorSdkModelSelection,
  type Run,
  type RunResult,
  type SDKAgent,
  type SDKMessage,
  type SDKToolUseMessage,
  type SDKUserMessage,
  type SendOptions,
} from "@cursor/sdk";
import {
  EventId,
  type CanonicalItemType,
  type ChatAttachment,
  type CursorModelOptions,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
} from "contracts";
import {
  Cause,
  DateTime,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Random,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  builtInShioriMcpServers,
  filterMcpServersForProvider,
  materializeMcpServersForRuntime,
} from "../mcpServers.ts";
import {
  classifyProviderToolLifecycleItemType,
  providerToolTitle,
  summarizeProviderToolInvocation,
} from "shared/providerTool";
import { CursorAdapter, type CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "cursor" as const;
const CURSOR_RESUME_VERSION = 1 as const;
const NEXT_CURSOR_RESUME_VERSION = 2 as const;
const DEFAULT_CURSOR_MODEL = "auto";
const CURSOR_INTERRUPT_TIMEOUT = "2 seconds";
const SUPPORTED_CURSOR_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface CursorAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly runtimeEventObserver?: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly createAgent?: (options: AgentOptions) => Promise<SDKAgent>;
  readonly resumeAgent?: (agentId: string, options?: Partial<AgentOptions>) => Promise<SDKAgent>;
}

interface CursorTurnState {
  readonly turnId: TurnId;
  readonly items: Array<unknown>;
  run: Run | undefined;
  emittedAssistantTextDelta: boolean;
  emittedThinkingDelta: boolean;
  completed: boolean;
}

interface CursorSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly agent: SDKAgent;
  streamFiber: Fiber.Fiber<void, never> | undefined;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  turnState: CursorTurnState | undefined;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
}

export function parseCursorResume(
  raw: unknown,
):
  | { readonly agentId: string; readonly sessionId: string; readonly diagnostic?: undefined }
  | { readonly agentId?: undefined; readonly sessionId?: undefined; readonly diagnostic: string }
  | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    return { diagnostic: "Cursor resume cursor is not an object; starting a new session." };
  }
  if (
    raw.schemaVersion !== CURSOR_RESUME_VERSION &&
    raw.schemaVersion !== NEXT_CURSOR_RESUME_VERSION
  ) {
    return {
      diagnostic: `Cursor resume cursor schema version ${String(raw.schemaVersion)} is unsupported; starting a new session.`,
    };
  }
  if (raw.provider !== undefined && raw.provider !== PROVIDER) {
    return {
      diagnostic: `Cursor resume cursor belongs to provider '${String(raw.provider)}'; starting a new session.`,
    };
  }
  const agentId =
    typeof raw.agentId === "string" && raw.agentId.trim()
      ? raw.agentId.trim()
      : typeof raw.sessionId === "string" && raw.sessionId.trim()
        ? raw.sessionId.trim()
        : undefined;
  if (!agentId) {
    return { diagnostic: "Cursor resume cursor is missing an agent id; starting a new session." };
  }
  return { agentId, sessionId: agentId };
}

function trimOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseCursorInlineModelParams(model: string): {
  readonly id: string;
  readonly params: ReadonlyArray<{ readonly id: string; readonly value: string }>;
} {
  const trimmed = model.trim();
  const open = trimmed.indexOf("[");
  const close = trimmed.endsWith("]") ? trimmed.length - 1 : -1;
  if (open <= 0 || close <= open) {
    return { id: trimmed || DEFAULT_CURSOR_MODEL, params: [] };
  }

  const params = trimmed
    .slice(open + 1, close)
    .split(",")
    .flatMap((entry) => {
      const [rawId, ...rawValueParts] = entry.split("=");
      const id = rawId?.trim();
      const value = rawValueParts.join("=").trim();
      return id && value ? [{ id, value }] : [];
    });
  return { id: trimmed.slice(0, open).trim() || DEFAULT_CURSOR_MODEL, params };
}

function modelParam(
  id: string,
  value: string | boolean | undefined,
): { id: string; value: string }[] {
  if (value === undefined) return [];
  const normalized = typeof value === "boolean" ? String(value) : value.trim();
  return normalized.length > 0 ? [{ id, value: normalized }] : [];
}

function dedupeModelParams(
  params: ReadonlyArray<{ readonly id: string; readonly value: string }>,
): Array<{ id: string; value: string }> {
  const byId = new Map<string, string>();
  for (const param of params) {
    const id = param.id.trim();
    const value = param.value.trim();
    if (id && value) byId.set(id, value);
  }
  return Array.from(byId, ([id, value]) => ({ id, value }));
}

function toCursorSdkModelSelection(
  model: string | null | undefined,
  options: CursorModelOptions | null | undefined,
): CursorSdkModelSelection {
  const parsed = parseCursorInlineModelParams(model ?? DEFAULT_CURSOR_MODEL);
  const params = dedupeModelParams([
    ...parsed.params,
    ...modelParam("reasoning", options?.reasoning),
    ...modelParam("effort", options?.reasoning),
    ...modelParam("context", options?.contextWindow),
    ...modelParam("contextWindow", options?.contextWindow),
    ...modelParam("fast", options?.fastMode),
    ...modelParam("thinking", options?.thinking),
  ]);
  return {
    id: parsed.id,
    ...(params.length > 0 ? { params } : {}),
  };
}

function cursorSdkModelToString(model: CursorSdkModelSelection | undefined): string | undefined {
  if (!model) return undefined;
  if (!model.params || model.params.length === 0) return model.id;
  const params = model.params.map((param) => `${param.id}=${param.value}`).join(",");
  return `${model.id}[${params}]`;
}

function modeFromInteractionMode(mode: "default" | "plan" | undefined): AgentModeOption {
  return mode === "plan" ? "plan" : "agent";
}

function sdkMcpServerFromEntry(entry: {
  readonly transport: "stdio" | "sse" | "http";
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
  readonly url?: string;
  readonly headers?: Record<string, string>;
}): McpServerConfig | undefined {
  switch (entry.transport) {
    case "stdio": {
      const command = trimOrUndefined(entry.command);
      if (!command) return undefined;
      return {
        type: "stdio",
        command,
        ...(entry.args ? { args: [...entry.args] } : {}),
        ...(entry.env ? { env: { ...entry.env } } : {}),
      };
    }
    case "http":
    case "sse": {
      const url = trimOrUndefined(entry.url);
      if (!url) return undefined;
      return {
        type: entry.transport,
        url,
        ...(entry.headers ? { headers: { ...entry.headers } } : {}),
      };
    }
  }
}

function buildCursorSdkMcpServers(
  servers: ReadonlyArray<ReturnType<typeof filterMcpServersForProvider>[number]>,
): Record<string, McpServerConfig> | undefined {
  const result: Record<string, McpServerConfig> = {};
  for (const server of servers) {
    const sdkServer = sdkMcpServerFromEntry(server);
    if (sdkServer) {
      result[server.name] = sdkServer;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function toolInputFromSdkToolCall(toolCall: unknown): Record<string, unknown> | undefined {
  if (!isRecord(toolCall)) return undefined;
  const args = isRecord(toolCall.args) ? toolCall.args : undefined;
  return {
    ...args,
    toolName: typeof toolCall.type === "string" ? toolCall.type : undefined,
  };
}

function toolResultFromSdkToolCall(toolCall: unknown): unknown {
  if (!isRecord(toolCall)) return undefined;
  const result = toolCall.result;
  if (!isRecord(result)) return result;
  if (result.status === "success" && "value" in result) return result.value;
  if (result.status === "error" && "error" in result) return result.error;
  return result;
}

function toolNameFromSdkToolCall(toolCall: unknown, fallback?: string): string {
  return (
    (isRecord(toolCall) && typeof toolCall.type === "string" ? toolCall.type : undefined) ??
    fallback ??
    "tool"
  );
}

function canonicalItemTypeFromToolName(toolName: string): CanonicalItemType {
  if (toolName === "createPlan") return "plan";
  return classifyProviderToolLifecycleItemType(toolName);
}

function statusFromSdkToolMessage(
  status: SDKToolUseMessage["status"],
): "inProgress" | "completed" | "failed" {
  switch (status) {
    case "completed":
      return "completed";
    case "error":
      return "failed";
    case "running":
    default:
      return "inProgress";
  }
}

function normalizeCursorTokenUsage(
  usage: Extract<InteractionUpdate, { type: "turn-ended" }>["usage"],
): ThreadTokenUsageSnapshot | undefined {
  if (!usage) return undefined;
  const inputTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const outputTokens = usage.outputTokens;
  const usedTokens = inputTokens + outputTokens;
  if (usedTokens <= 0) return undefined;
  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
  };
}

function runStateFromResult(status: RunResult["status"]): "completed" | "failed" | "cancelled" {
  switch (status) {
    case "finished":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "error":
    default:
      return "failed";
  }
}

function toSdkUserMessage(input: {
  readonly text: string;
  readonly images: ReadonlyArray<{ readonly data: string; readonly mimeType: string }>;
}): SDKUserMessage | string {
  if (input.images.length === 0) return input.text;
  return {
    text: input.text,
    images: input.images.map((image) => ({
      data: image.data,
      mimeType: image.mimeType,
    })),
  };
}

function makeCursorAdapter(options?: CursorAdapterLiveOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* Effect.service(ServerConfig);
    const serverSettingsService = yield* ServerSettingsService;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const createAgent =
      options?.createAgent ?? ((agentOptions: AgentOptions) => Agent.create(agentOptions));
    const resumeAgent =
      options?.resumeAgent ??
      ((agentId: string, agentOptions?: Partial<AgentOptions>) =>
        Agent.resume(agentId, agentOptions));

    const sessions = new Map<ThreadId, CursorSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      Effect.all(
        [
          options?.runtimeEventObserver?.(event) ?? Effect.void,
          PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<CursorSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const logNative = (ctx: CursorSessionContext, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = new Date().toISOString();
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId: ctx.threadId,
              ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
              payload,
            },
          },
          ctx.threadId,
        );
      });

    const emitRuntimeWarning = (
      ctx: CursorSessionContext,
      message: string,
      detail?: unknown,
      turnId?: TurnId,
    ) =>
      makeEventStamp().pipe(
        Effect.flatMap((stamp) =>
          offerRuntimeEvent({
            type: "runtime.warning",
            ...stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            ...((turnId ?? ctx.activeTurnId) ? { turnId: turnId ?? ctx.activeTurnId } : {}),
            payload: {
              message,
              ...(detail !== undefined ? { detail } : {}),
            },
          }),
        ),
      );

    const emitRuntimeError = (ctx: CursorSessionContext, turnId: TurnId, cause: unknown) =>
      offerRuntimeEvent({
        type: "runtime.error",
        eventId: EventId.makeUnsafe(crypto.randomUUID()),
        provider: PROVIDER,
        createdAt: new Date().toISOString(),
        threadId: ctx.threadId,
        turnId,
        payload: {
          message: toMessage(cause, "Cursor SDK turn failed."),
          class: "provider_error",
          detail: cause,
        },
      });

    const emitContentDelta = (
      ctx: CursorSessionContext,
      turnId: TurnId,
      input: {
        readonly text: string;
        readonly streamKind: "assistant_text" | "reasoning_text" | "command_output";
        readonly itemId?: string;
        readonly rawPayload: unknown;
      },
    ) =>
      Effect.gen(function* () {
        if (input.text.length === 0) return;
        yield* offerRuntimeEvent({
          type: "content.delta",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          ...(input.itemId ? { itemId: RuntimeItemId.makeUnsafe(input.itemId) } : {}),
          payload: {
            streamKind: input.streamKind,
            delta: input.text,
          },
          raw: {
            source: "cursor.sdk.message",
            method: "cursor/sdk/delta",
            payload: input.rawPayload,
          },
        });
      });

    const emitToolEvent = (
      ctx: CursorSessionContext,
      turnId: TurnId,
      input: {
        readonly callId: string;
        readonly toolName: string;
        readonly toolCall?: unknown;
        readonly status: "inProgress" | "completed" | "failed";
        readonly rawPayload: unknown;
      },
    ) =>
      Effect.gen(function* () {
        const toolInput = toolInputFromSdkToolCall(input.toolCall);
        const toolResult = toolResultFromSdkToolCall(input.toolCall);
        const detail =
          toolInput !== undefined
            ? summarizeProviderToolInvocation(input.toolName, toolInput)
            : undefined;
        yield* offerRuntimeEvent({
          type:
            input.status === "completed" || input.status === "failed"
              ? "item.completed"
              : "item.updated",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          itemId: RuntimeItemId.makeUnsafe(input.callId),
          payload: {
            itemType: canonicalItemTypeFromToolName(input.toolName),
            status: input.status,
            title: providerToolTitle(input.toolName),
            ...(detail ? { detail } : {}),
            data: {
              toolName: input.toolName,
              ...(toolInput !== undefined ? { input: toolInput } : {}),
              ...(toolResult !== undefined ? { result: toolResult } : {}),
            },
          },
          providerRefs: {
            providerItemId: ProviderItemId.makeUnsafe(input.callId),
          },
          raw: {
            source: "cursor.sdk.message",
            method: "cursor/sdk/tool",
            payload: input.rawPayload,
          },
        });
      });

    const emitPlanFromTool = (
      ctx: CursorSessionContext,
      turnId: TurnId,
      toolCall: unknown,
      rawPayload: unknown,
    ) =>
      Effect.gen(function* () {
        const args = isRecord(toolCall) && isRecord(toolCall.args) ? toolCall.args : undefined;
        const plan = typeof args?.plan === "string" ? args.plan.trim() : "";
        if (!plan) return;
        yield* offerRuntimeEvent({
          type: "turn.proposed.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: { planMarkdown: plan },
          raw: {
            source: "cursor.sdk.message",
            method: "cursor/sdk/createPlan",
            payload: rawPayload,
          },
        });
      });

    const handleDelta = (ctx: CursorSessionContext, turnId: TurnId, update: InteractionUpdate) =>
      Effect.gen(function* () {
        const turnState = ctx.turnState;
        switch (update.type) {
          case "text-delta":
            if (turnState) turnState.emittedAssistantTextDelta = true;
            yield* emitContentDelta(ctx, turnId, {
              text: update.text,
              streamKind: "assistant_text",
              rawPayload: update,
            });
            return;
          case "thinking-delta":
            if (turnState) turnState.emittedThinkingDelta = true;
            yield* emitContentDelta(ctx, turnId, {
              text: update.text,
              streamKind: "reasoning_text",
              rawPayload: update,
            });
            return;
          case "tool-call-started":
          case "partial-tool-call":
          case "tool-call-completed": {
            const toolName = toolNameFromSdkToolCall(update.toolCall);
            yield* emitToolEvent(ctx, turnId, {
              callId: update.callId,
              toolName,
              toolCall: update.toolCall,
              status: update.type === "tool-call-completed" ? "completed" : "inProgress",
              rawPayload: update,
            });
            if (toolName === "createPlan") {
              yield* emitPlanFromTool(ctx, turnId, update.toolCall, update);
            }
            return;
          }
          case "shell-output-delta": {
            const text = typeof update.event.text === "string" ? update.event.text : undefined;
            if (text) {
              yield* emitContentDelta(ctx, turnId, {
                text,
                streamKind: "command_output",
                rawPayload: update,
              });
            }
            return;
          }
          case "turn-ended": {
            const usage = normalizeCursorTokenUsage(update.usage);
            if (usage) {
              yield* offerRuntimeEvent({
                type: "thread.token-usage.updated",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                payload: { usage },
                raw: {
                  source: "cursor.sdk.message",
                  method: "cursor/sdk/turn-ended",
                  payload: update,
                },
              });
            }
            return;
          }
          default:
            return;
        }
      });

    const assistantTextFromMessage = (message: SDKMessage): string => {
      if (message.type !== "assistant") return "";
      return message.message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
    };

    const handleSdkMessage = (ctx: CursorSessionContext, turnId: TurnId, message: SDKMessage) =>
      Effect.gen(function* () {
        yield* logNative(ctx, `cursor/sdk/${message.type}`, message);
        const turnState = ctx.turnState;
        if (turnState) turnState.items.push(message);

        switch (message.type) {
          case "system": {
            yield* offerRuntimeEvent({
              type: "thread.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              payload: { providerThreadId: message.agent_id },
              providerRefs: { providerTurnId: message.run_id },
              raw: {
                source: "cursor.sdk.message",
                method: "cursor/sdk/system",
                payload: message,
              },
            });
            return;
          }
          case "assistant": {
            const text = assistantTextFromMessage(message);
            if (text && !turnState?.emittedAssistantTextDelta) {
              yield* emitContentDelta(ctx, turnId, {
                text,
                streamKind: "assistant_text",
                rawPayload: message,
              });
            }
            return;
          }
          case "thinking": {
            if (message.text && !turnState?.emittedThinkingDelta) {
              yield* emitContentDelta(ctx, turnId, {
                text: message.text,
                streamKind: "reasoning_text",
                rawPayload: message,
              });
            }
            return;
          }
          case "tool_call": {
            yield* emitToolEvent(ctx, turnId, {
              callId: message.call_id,
              toolName: message.name,
              toolCall: {
                type: message.name,
                args: message.args,
                result: message.result,
              },
              status: statusFromSdkToolMessage(message.status),
              rawPayload: message,
            });
            return;
          }
          case "status": {
            yield* offerRuntimeEvent({
              type: "session.state.changed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId,
              payload: {
                state:
                  message.status === "FINISHED"
                    ? "ready"
                    : message.status === "ERROR"
                      ? "error"
                      : message.status === "CANCELLED" || message.status === "EXPIRED"
                        ? "stopped"
                        : "running",
                ...(message.message ? { reason: message.message } : {}),
              },
              raw: {
                source: "cursor.sdk.message",
                method: "cursor/sdk/status",
                payload: message,
              },
            });
            return;
          }
          case "task": {
            if (!message.text) return;
            yield* offerRuntimeEvent({
              type: "task.progress",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId,
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(`task:${message.run_id}`),
                description: message.text,
                ...(message.status ? { summary: message.status } : {}),
              },
              raw: {
                source: "cursor.sdk.message",
                method: "cursor/sdk/task",
                payload: message,
              },
            });
            return;
          }
          case "user":
          default:
            return;
        }
      });

    const completeTurn = (
      ctx: CursorSessionContext,
      turnId: TurnId,
      input: {
        readonly state: "completed" | "failed" | "cancelled";
        readonly stopReason?: string | null | undefined;
        readonly errorMessage?: string | undefined;
        readonly model?: string | undefined;
      },
    ) =>
      Effect.gen(function* () {
        if (ctx.activeTurnId !== turnId && ctx.session.activeTurnId !== turnId) {
          return;
        }
        const turnState = ctx.turnState;
        if (turnState) {
          turnState.completed = true;
          ctx.turns.push({ id: turnId, items: [...turnState.items] });
        }
        ctx.activeTurnId = undefined;
        ctx.turnState = undefined;
        ctx.streamFiber = undefined;
        const { activeTurnId: _activeTurnId, ...sessionWithoutActiveTurn } = ctx.session;
        ctx.session = {
          ...sessionWithoutActiveTurn,
          status: input.state === "failed" ? "error" : "ready",
          ...(input.model ? { model: input.model } : {}),
          updatedAt: yield* nowIso,
        };

        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {
            state: input.state,
            ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
            ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
          },
        });
      });

    const stopSessionInternal = (ctx: CursorSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        if (ctx.turnState?.run) {
          yield* Effect.tryPromise(() => ctx.turnState!.run!.cancel()).pipe(
            Effect.timeout(CURSOR_INTERRUPT_TIMEOUT),
            Effect.ignore,
          );
        }
        if (ctx.streamFiber) {
          yield* Fiber.interrupt(ctx.streamFiber);
        }
        yield* Effect.sync(() => ctx.agent.close());
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: CursorAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = nodePath.resolve(input.cwd.trim());
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const serverSettings = yield* serverSettingsService.getSettings.pipe(
            Effect.mapError(
              (error) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "settings/get",
                  detail: error.message,
                  cause: error,
                }),
            ),
          );
          const cursorModelSelection =
            input.modelSelection?.provider === "cursor" ? input.modelSelection : undefined;
          const sdkModel = toCursorSdkModelSelection(
            cursorModelSelection?.model ?? DEFAULT_CURSOR_MODEL,
            cursorModelSelection?.options,
          );
          const runtimeMcpServers = yield* Effect.tryPromise(() =>
            materializeMcpServersForRuntime({
              servers: serverSettings.mcpServers.servers,
              oauthStorageDir: nodePath.join(serverConfig.stateDir, "mcp-oauth"),
            }),
          ).pipe(
            Effect.catch((cause) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  "cursor sdk mcp OAuth materialization failed; continuing with static MCP config",
                );
                yield* Effect.logWarning(
                  cause instanceof Error ? cause.message : "Failed to materialize Cursor MCP auth.",
                );
                return serverSettings.mcpServers.servers;
              }),
            ),
          );
          const sdkMcpServers = buildCursorSdkMcpServers([
            ...filterMcpServersForProvider(PROVIDER, runtimeMcpServers),
            ...builtInShioriMcpServers({
              provider: PROVIDER,
              settings: serverSettings,
              browserPanel: {
                config: serverConfig,
                threadId: input.threadId,
              },
              exposeComputerWhenApprovalRequired: input.runtimeMode === "approval-required",
            }),
          ]);
          const parsedResumeCursor = parseCursorResume(input.resumeCursor);
          const baseAgentOptions: AgentOptions = {
            model: sdkModel,
            local: {
              cwd,
              sandboxOptions: { enabled: input.runtimeMode !== "full-access" },
            },
            ...(sdkMcpServers ? { mcpServers: sdkMcpServers } : {}),
            mode: "agent",
          };

          const agent = yield* Effect.tryPromise({
            try: () =>
              parsedResumeCursor?.agentId
                ? resumeAgent(parsedResumeCursor.agentId, baseAgentOptions)
                : createAgent(baseAgentOptions),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: parsedResumeCursor?.agentId ? "Agent.resume" : "Agent.create",
                detail: toMessage(cause, "Cursor SDK session start failed."),
                cause,
              }),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: cursorSdkModelToString(agent.model) ?? cursorSdkModelToString(sdkModel),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: NEXT_CURSOR_RESUME_VERSION,
              provider: PROVIDER,
              agentId: agent.agentId,
              sessionId: agent.agentId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: CursorSessionContext = {
            threadId: input.threadId,
            session,
            agent,
            streamFiber: undefined,
            turns: [],
            activeTurnId: undefined,
            turnState: undefined,
            stopped: false,
          };
          sessions.set(input.threadId, ctx);

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: parsedResumeCursor?.agentId ? { agentId: agent.agentId } : null },
          });
          yield* offerRuntimeEvent({
            type: "session.configured",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: {
              config: {
                cwd,
                agentId: agent.agentId,
                model: cursorSdkModelToString(agent.model) ?? cursorSdkModelToString(sdkModel),
              },
            },
          });
          if (parsedResumeCursor?.diagnostic) {
            yield* emitRuntimeWarning(ctx, parsedResumeCursor.diagnostic, {
              resumeCursor: input.resumeCursor,
            });
          }
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Cursor SDK session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: agent.agentId },
          });

          return session;
        }),
      );

    const readAttachmentImages = (
      attachments: ReadonlyArray<ChatAttachment> | undefined,
    ): Effect.Effect<
      ReadonlyArray<{ data: string; mimeType: string }>,
      ProviderAdapterRequestError
    > =>
      Effect.gen(function* () {
        const images: Array<{ data: string; mimeType: string }> = [];
        for (const attachment of attachments ?? []) {
          if (attachment.type !== "image") continue;
          if (!SUPPORTED_CURSOR_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "Agent.send",
              detail: `Unsupported Cursor image attachment type '${attachment.mimeType}'.`,
            });
          }
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "Agent.send",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "Agent.send",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          images.push({
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          });
        }
        return images;
      });

    const sendTurn: CursorAdapterShape["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          if (ctx.activeTurnId) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "A Cursor turn is already in progress.",
            });
          }

          const text = input.input?.trim() ?? "";
          const images = yield* readAttachmentImages(input.attachments);
          if (!text && images.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          const turnId = TurnId.makeUnsafe(crypto.randomUUID());
          const turnModelSelection =
            input.modelSelection?.provider === "cursor" ? input.modelSelection : undefined;
          const sdkModel =
            turnModelSelection !== undefined
              ? toCursorSdkModelSelection(turnModelSelection.model, turnModelSelection.options)
              : undefined;
          const sendOptions: SendOptions = {
            ...(sdkModel ? { model: sdkModel } : {}),
            mode: modeFromInteractionMode(input.interactionMode),
            onDelta: (args) => Effect.runPromise(handleDelta(ctx, turnId, args.update)),
          };
          const modelForEvent =
            cursorSdkModelToString(sdkModel) ?? ctx.session.model ?? DEFAULT_CURSOR_MODEL;

          ctx.activeTurnId = turnId;
          ctx.turnState = {
            turnId,
            items: [],
            run: undefined,
            emittedAssistantTextDelta: false,
            emittedThinkingDelta: false,
            completed: false,
          };
          ctx.session = {
            ...ctx.session,
            status: "running",
            activeTurnId: turnId,
            ...(modelForEvent ? { model: modelForEvent } : {}),
            updatedAt: yield* nowIso,
          };

          yield* offerRuntimeEvent({
            type: "turn.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: { model: modelForEvent },
          });

          const message = toSdkUserMessage({ text, images });
          const run = yield* Effect.tryPromise({
            try: () => ctx.agent.send(message, sendOptions),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "Agent.send",
                detail: toMessage(cause, "Cursor SDK send failed."),
                cause,
              }),
          });
          if (ctx.turnState) {
            ctx.turnState.run = run;
            ctx.turnState.items.push({ prompt: message, runId: run.id });
          }

          const services = yield* Effect.services();
          const runFork = Effect.runForkWith(services);
          const streamFiber = runFork(
            Stream.fromAsyncIterable(run.stream(), (cause) => cause).pipe(
              Stream.runForEach((message) => handleSdkMessage(ctx, turnId, message)),
              Effect.flatMap(() =>
                Effect.tryPromise({
                  try: () => run.wait(),
                  catch: (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "Run.wait",
                      detail: toMessage(cause, "Cursor SDK wait failed."),
                      cause,
                    }),
                }),
              ),
              Effect.flatMap((result) =>
                completeTurn(ctx, turnId, {
                  state: runStateFromResult(result.status),
                  stopReason: result.status,
                  model: cursorSdkModelToString(result.model) ?? modelForEvent,
                  ...(result.status === "error" && result.result
                    ? { errorMessage: result.result }
                    : {}),
                }),
              ),
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) {
                  return completeTurn(ctx, turnId, {
                    state: "cancelled",
                    stopReason: "interrupted",
                    model: modelForEvent,
                  });
                }
                const error = Cause.squash(cause);
                return Effect.gen(function* () {
                  yield* emitRuntimeError(ctx, turnId, error);
                  yield* completeTurn(ctx, turnId, {
                    state: "failed",
                    errorMessage: toMessage(error, "Cursor SDK turn failed."),
                    model: modelForEvent,
                  });
                });
              }),
            ),
          );
          ctx.streamFiber = streamFiber;

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }),
      );

    const interruptTurn: CursorAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const interruptedTurnId = ctx.activeTurnId;
        const run = ctx.turnState?.run;
        if (run) {
          yield* Effect.tryPromise(() => run.cancel()).pipe(
            Effect.timeout(CURSOR_INTERRUPT_TIMEOUT),
            Effect.ignore,
          );
        }
        if (interruptedTurnId) {
          yield* completeTurn(ctx, interruptedTurnId, {
            state: "cancelled",
            stopReason: "interrupted",
            model: ctx.session.model,
          });
        }
        if (ctx.streamFiber) {
          yield* Fiber.interrupt(ctx.streamFiber).pipe(Effect.ignore);
        }
      });

    const respondToRequest: CursorAdapterShape["respondToRequest"] = (threadId, requestId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "cursor/sdk/request",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      });

    const respondToUserInput: CursorAdapterShape["respondToUserInput"] = (threadId, requestId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "cursor/sdk/user-input",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      });

    const readThread: CursorAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: CursorAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
      });

    const stopSession: CursorAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: CursorAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: CursorAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: CursorAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
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
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies CursorAdapterShape;
  });
}

export const CursorAdapterLive = Layer.effect(CursorAdapter, makeCursorAdapter());

export function makeCursorAdapterLive(opts?: CursorAdapterLiveOptions) {
  return Layer.effect(CursorAdapter, makeCursorAdapter(opts));
}
