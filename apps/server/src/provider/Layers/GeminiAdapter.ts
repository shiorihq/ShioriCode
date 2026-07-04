/**
 * GeminiAdapterLive - Antigravity SDK provider adapter.
 *
 * This keeps the existing `gemini` provider contract stable while migrating the
 * runtime away from the Gemini ACP CLI path and onto the local Antigravity TypeScript SDK.
 *
 * @module GeminiAdapterLive
 */
import * as nodePath from "node:path";

import {
  Agent,
  CapabilitiesConfig,
  Image,
  LocalAgentConfig,
  McpSseServer,
  McpStdioServer,
  McpStreamableHttpServer,
  QuestionHookResult,
  QuestionResponse,
  StepSource,
  StepStatus,
  StepTarget,
  type AskQuestionInteractionSpec,
  type ContentPrimitive,
  type McpServerConfig,
  type Step,
  type ToolCall,
  hooks,
  policy,
} from "google-antigravity";
import {
  ApprovalRequestId,
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  type CanonicalRequestType,
  type ProviderApprovalDecision,
  type ProviderApprovalPolicy,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type RuntimeContentStreamKind,
  type RuntimeMode,
  type ThreadId,
  type ThreadTokenUsageSnapshot,
  type ToolLifecycleItemType,
  TurnId,
} from "contracts";
import {
  Cause,
  DateTime,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  PubSub,
  Random,
  Scope,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect";
import { classifyProviderToolRequestKind } from "shared/providerTool";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { builtInShioriMcpServers, materializeMcpServersForRuntime } from "../mcpServers.ts";
import { GeminiAdapter, type GeminiAdapterShape } from "../Services/GeminiAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "gemini" as const;
const ANTIGRAVITY_RESUME_VERSION = 1 as const;

export interface GeminiAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly startAgent?: (config: LocalAgentConfig) => Promise<Agent>;
}

interface PendingApproval {
  readonly resolve: (decision: ProviderApprovalDecision) => void;
}

interface PendingUserInput {
  readonly resolve: (answers: ProviderUserInputAnswers) => void;
}

interface GeminiSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly agent: Agent;
  activeTurnFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly startedItems: Set<string>;
  activeTurnId: TurnId | undefined;
  model: string | undefined;
  approvalPolicy: ProviderApprovalPolicy | undefined;
  stopped: boolean;
}

function trimOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAntigravityResume(raw: unknown): { conversationId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== ANTIGRAVITY_RESUME_VERSION) return undefined;
  if (typeof raw.conversationId !== "string" || !raw.conversationId.trim()) return undefined;
  return { conversationId: raw.conversationId.trim() };
}

function makeAntigravityResumeCursor(conversationId: string | undefined) {
  return {
    schemaVersion: ANTIGRAVITY_RESUME_VERSION,
    ...(conversationId ? { conversationId } : {}),
  };
}

function resolveAntigravityModel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === "auto" || trimmed === "default") return undefined;
  return trimmed;
}

function requestTypeFromToolCall(toolCall: ToolCall): CanonicalRequestType {
  switch (classifyProviderToolRequestKind(String(toolCall.name))) {
    case "computer-use":
      return "computer_use_approval";
    case "command":
      return "exec_command_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
  }
  switch (String(toolCall.name)) {
    case "run_command":
      return "exec_command_approval";
    case "view_file":
    case "list_directory":
    case "search_directory":
    case "find_file":
      return "file_read_approval";
    case "create_file":
    case "edit_file":
      return "file_change_approval";
    default:
      return "dynamic_tool_call";
  }
}

function itemTypeFromToolCall(toolCall: ToolCall): ToolLifecycleItemType {
  const name = String(toolCall.name);
  if (name === "run_command") return "command_execution";
  if (name === "create_file" || name === "edit_file") return "file_change";
  if (name.startsWith("mcp_")) return "mcp_tool_call";
  if (name === "start_subagent") return "collab_agent_tool_call";
  return "dynamic_tool_call";
}

function runtimeStatusFromStepStatus(
  status: StepStatus,
): "inProgress" | "completed" | "failed" | undefined {
  switch (status) {
    case StepStatus.ACTIVE:
    case StepStatus.WAITING_FOR_USER:
      return "inProgress";
    case StepStatus.DONE:
      return "completed";
    case StepStatus.ERROR:
    case StepStatus.TERMINAL_ERROR:
      return "failed";
    default:
      return undefined;
  }
}

function turnStateFromStepStatus(status: StepStatus): "completed" | "failed" | "cancelled" {
  switch (status) {
    case StepStatus.ERROR:
    case StepStatus.TERMINAL_ERROR:
      return "failed";
    case StepStatus.CANCELED:
      return "cancelled";
    default:
      return "completed";
  }
}

function normalizeUsage(step: Step): ThreadTokenUsageSnapshot | undefined {
  const usage = step.usageMetadata;
  if (!usage) return undefined;
  const usedTokens = Math.max(0, usage.totalTokenCount ?? 0);
  if (usedTokens === 0) return undefined;
  return {
    usedTokens,
    totalProcessedTokens: usedTokens,
    inputTokens: Math.max(0, usage.promptTokenCount ?? 0),
    cachedInputTokens: Math.max(0, usage.cachedContentTokenCount ?? 0),
    outputTokens: Math.max(0, usage.candidatesTokenCount ?? 0),
    reasoningOutputTokens: Math.max(0, usage.thoughtsTokenCount ?? 0),
    lastUsedTokens: usedTokens,
    lastInputTokens: Math.max(0, usage.promptTokenCount ?? 0),
    lastCachedInputTokens: Math.max(0, usage.cachedContentTokenCount ?? 0),
    lastOutputTokens: Math.max(0, usage.candidatesTokenCount ?? 0),
    lastReasoningOutputTokens: Math.max(0, usage.thoughtsTokenCount ?? 0),
  };
}

function makeEventStampSync(): { eventId: EventId; createdAt: string } {
  return {
    eventId: EventId.makeUnsafe(crypto.randomUUID()),
    createdAt: new Date().toISOString(),
  };
}

function toMcpServerConfig(entry: {
  readonly name: string;
  readonly transport: string;
  readonly command?: string | undefined;
  readonly args?: ReadonlyArray<string> | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly url?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}): McpServerConfig | undefined {
  if (entry.transport === "stdio" && entry.command?.trim()) {
    const envArgs = Object.entries(entry.env ?? {})
      .filter(([name, value]) => name.trim() && value !== undefined)
      .map(([name, value]) => `${name}=${value}`);
    const command = envArgs.length > 0 ? "/usr/bin/env" : entry.command;
    const args =
      envArgs.length > 0
        ? [...envArgs, entry.command, ...(entry.args ?? [])]
        : [...(entry.args ?? [])];
    return new McpStdioServer({
      name: entry.name,
      command,
      args,
    });
  }
  if (entry.transport === "sse" && entry.url?.trim()) {
    return new McpSseServer({
      name: entry.name,
      url: entry.url,
      ...(entry.headers ? { headers: { ...entry.headers } } : {}),
    });
  }
  if (entry.transport === "http" && entry.url?.trim()) {
    return new McpStreamableHttpServer({
      name: entry.name,
      url: entry.url,
      ...(entry.headers ? { headers: { ...entry.headers } } : {}),
    });
  }
  return undefined;
}

function makeGeminiAdapter(options?: GeminiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
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

    const sessions = new Map<ThreadId, GeminiSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = current.get(threadId);
        if (existing) return Effect.succeed([existing, current] as const);
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const next = new Map(current);
            next.set(threadId, semaphore);
            return [semaphore, next] as const;
          }),
        );
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
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
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<GeminiSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const emitRuntimeError = (
      ctx: GeminiSessionContext,
      turnId: TurnId | undefined,
      cause: unknown,
    ) =>
      offerRuntimeEvent({
        type: "runtime.error",
        eventId: EventId.makeUnsafe(crypto.randomUUID()),
        provider: PROVIDER,
        createdAt: new Date().toISOString(),
        threadId: ctx.threadId,
        ...(turnId ? { turnId } : {}),
        payload: {
          message: toMessage(cause, "Antigravity SDK turn failed."),
          class: "provider_error",
          detail: cause,
        },
      });

    const settlePendingApprovalsAsCancelled = (ctx: GeminiSessionContext) =>
      Effect.sync(() => {
        for (const pending of ctx.pendingApprovals.values()) {
          pending.resolve("cancel");
        }
        ctx.pendingApprovals.clear();
        for (const pending of ctx.pendingUserInputs.values()) {
          pending.resolve({});
        }
        ctx.pendingUserInputs.clear();
      });

    const stopSessionInternal = (ctx: GeminiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx);
        if (ctx.activeTurnFiber) {
          yield* Fiber.interrupt(ctx.activeTurnFiber);
        }
        yield* Effect.tryPromise(() => ctx.agent.stop()).pipe(Effect.ignore);
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const makeApprovalHandler = (ctx: () => GeminiSessionContext | undefined) => {
      return async (toolCall: ToolCall): Promise<boolean> => {
        const current = ctx();
        if (!current || current.stopped) return false;
        const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
        const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
        const requestType = requestTypeFromToolCall(toolCall);
        const detail = `${String(toolCall.name)} ${JSON.stringify(toolCall.args)}`.slice(0, 2000);
        await Effect.runPromise(
          offerRuntimeEvent({
            type: "request.opened",
            ...makeEventStampSync(),
            provider: PROVIDER,
            threadId: current.threadId,
            ...(current.activeTurnId ? { turnId: current.activeTurnId } : {}),
            requestId: runtimeRequestId,
            payload: {
              requestType,
              detail,
              args: toolCall.args,
            },
            raw: {
              source: "antigravity.sdk.hook",
              method: "preToolCall",
              payload: toolCall,
            },
          }),
        );
        const decision = await new Promise<ProviderApprovalDecision>((resolve) => {
          current.pendingApprovals.set(requestId, { resolve });
        });
        current.pendingApprovals.delete(requestId);
        await Effect.runPromise(
          offerRuntimeEvent({
            type: "request.resolved",
            ...makeEventStampSync(),
            provider: PROVIDER,
            threadId: current.threadId,
            ...(current.activeTurnId ? { turnId: current.activeTurnId } : {}),
            requestId: runtimeRequestId,
            payload: {
              requestType,
              decision: typeof decision === "string" ? decision : "decline",
              ...(typeof decision === "string" ? {} : { resolution: decision }),
            },
          }),
        );
        return decision === "accept" || decision === "acceptForSession";
      };
    };

    const makeUserInputHook = (ctx: () => GeminiSessionContext | undefined) =>
      new (class extends hooks.OnInteractionHook {
        override async run(
          _context: unknown,
          spec: AskQuestionInteractionSpec,
        ): Promise<QuestionHookResult> {
          const current = ctx();
          if (!current || current.stopped) {
            return new QuestionHookResult({ responses: [], cancelled: true });
          }
          const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
          const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
          await Effect.runPromise(
            offerRuntimeEvent({
              type: "user-input.requested",
              ...makeEventStampSync(),
              provider: PROVIDER,
              threadId: current.threadId,
              ...(current.activeTurnId ? { turnId: current.activeTurnId } : {}),
              requestId: runtimeRequestId,
              payload: {
                questions: spec.questions.map((question, index) => ({
                  id: String(index),
                  header: question.question.slice(0, 80) || "Question",
                  question: question.question,
                  multiSelect: question.isMultiSelect,
                  options: question.options.map((option) => ({
                    label: option.text,
                    description: option.id,
                  })),
                })),
              },
              raw: {
                source: "antigravity.sdk.hook",
                method: "interaction",
                payload: spec,
              },
            }),
          );
          const answers = await new Promise<ProviderUserInputAnswers>((resolve) => {
            current.pendingUserInputs.set(requestId, { resolve });
          });
          current.pendingUserInputs.delete(requestId);
          const responses = spec.questions.map((question, index) => {
            const raw = answers[String(index)];
            const values = Array.isArray(raw)
              ? raw.map(String)
              : typeof raw === "string"
                ? [raw]
                : [];
            return new QuestionResponse({
              selectedOptionIds: values,
              freeformResponse: values.join("\n"),
              skipped: values.length === 0 && !question.options.length,
            });
          });
          await Effect.runPromise(
            offerRuntimeEvent({
              type: "user-input.resolved",
              ...makeEventStampSync(),
              provider: PROVIDER,
              threadId: current.threadId,
              ...(current.activeTurnId ? { turnId: current.activeTurnId } : {}),
              requestId: runtimeRequestId,
              payload: { answers },
            }),
          );
          return new QuestionHookResult({ responses });
        }
      })();

    const emitItemStarted = (ctx: GeminiSessionContext, itemId: string, itemType: string) =>
      Effect.gen(function* () {
        if (ctx.startedItems.has(itemId)) return;
        ctx.startedItems.add(itemId);
        yield* offerRuntimeEvent({
          type: "item.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
          itemId: RuntimeItemId.makeUnsafe(itemId),
          payload: {
            itemType: itemType as never,
            status: "inProgress",
          },
        });
      });

    const processStep = (ctx: GeminiSessionContext, step: Step) =>
      Effect.gen(function* () {
        yield* logNative(ctx.threadId, "step", step);
        const itemId = step.id || `${ctx.activeTurnId ?? "turn"}:${step.stepIndex}`;
        if (step.thinkingDelta) {
          const reasoningItemId = `${itemId}:thinking`;
          yield* emitItemStarted(ctx, reasoningItemId, "reasoning");
          yield* offerRuntimeEvent({
            type: "content.delta",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
            itemId: RuntimeItemId.makeUnsafe(reasoningItemId),
            payload: {
              streamKind: "reasoning_text" satisfies RuntimeContentStreamKind,
              delta: step.thinkingDelta,
            },
            raw: { source: "antigravity.sdk.step", method: "step", payload: step },
          });
        }
        if (
          step.contentDelta &&
          step.source === StepSource.MODEL &&
          step.target === StepTarget.USER
        ) {
          yield* emitItemStarted(ctx, itemId, "assistant_message");
          yield* offerRuntimeEvent({
            type: "content.delta",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
            itemId: RuntimeItemId.makeUnsafe(itemId),
            payload: {
              streamKind: "assistant_text" satisfies RuntimeContentStreamKind,
              delta: step.contentDelta,
            },
            raw: { source: "antigravity.sdk.step", method: "step", payload: step },
          });
        }
        for (const toolCall of step.toolCalls) {
          const toolItemId = toolCall.id ?? `${itemId}:${String(toolCall.name)}`;
          const status = runtimeStatusFromStepStatus(step.status);
          yield* offerRuntimeEvent({
            type: status === "completed" || status === "failed" ? "item.completed" : "item.updated",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
            itemId: RuntimeItemId.makeUnsafe(toolItemId),
            payload: {
              itemType: itemTypeFromToolCall(toolCall),
              ...(status ? { status } : {}),
              title: String(toolCall.name),
              data: toolCall.args,
            },
            raw: { source: "antigravity.sdk.step", method: "toolCall", payload: step },
          });
        }
        const usage = normalizeUsage(step);
        if (usage) {
          yield* offerRuntimeEvent({
            type: "thread.token-usage.updated",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
            payload: { usage },
            raw: { source: "antigravity.sdk.step", method: "usage", payload: step },
          });
        }
        if (
          step.source === StepSource.MODEL &&
          step.target === StepTarget.USER &&
          [
            StepStatus.DONE,
            StepStatus.ERROR,
            StepStatus.CANCELED,
            StepStatus.TERMINAL_ERROR,
          ].includes(step.status)
        ) {
          yield* offerRuntimeEvent({
            type: "item.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
            itemId: RuntimeItemId.makeUnsafe(itemId),
            payload: {
              itemType: "assistant_message",
              status: step.status === StepStatus.DONE ? "completed" : "failed",
            },
            raw: { source: "antigravity.sdk.step", method: "step", payload: step },
          });
        }
      });

    const completeTurn = (
      ctx: GeminiSessionContext,
      turnId: TurnId,
      state: "completed" | "failed" | "cancelled",
    ) =>
      Effect.gen(function* () {
        const now = yield* nowIso;
        ctx.activeTurnId = undefined;
        ctx.activeTurnFiber = undefined;
        const { activeTurnId: _activeTurnId, ...sessionWithoutActiveTurn } = ctx.session;
        ctx.session = {
          ...sessionWithoutActiveTurn,
          status: state === "failed" ? "error" : "ready",
          resumeCursor: makeAntigravityResumeCursor(
            ctx.agent.conversationId ??
              parseAntigravityResume(ctx.session.resumeCursor)?.conversationId,
          ),
          updatedAt: now,
        };
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: { state },
        });
      });

    const createSessionContext = Effect.fn("createAntigravitySessionContext")(function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly runtimeMode: RuntimeMode;
      readonly approvalPolicy: ProviderApprovalPolicy | undefined;
      readonly model: string | undefined;
      readonly resumeConversationId?: string | undefined;
    }) {
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
      const geminiSettings = serverSettings.providers.gemini;
      const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
      const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
      const sessionScope = yield* Scope.make("sequential");
      let sessionScopeTransferred = false;
      yield* Effect.addFinalizer(() =>
        sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
      );
      let ctx: GeminiSessionContext | undefined;

      const runtimeMcpServers = yield* Effect.tryPromise(() =>
        materializeMcpServersForRuntime({
          servers: serverSettings.mcpServers.servers,
          oauthStorageDir: nodePath.join(serverConfig.stateDir, "mcp-oauth"),
        }),
      ).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(
              "antigravity mcp OAuth materialization failed; continuing with static MCP config",
            );
            yield* Effect.logWarning(
              cause instanceof Error
                ? cause.message
                : "Failed to materialize Antigravity MCP auth.",
            );
            return serverSettings.mcpServers.servers;
          }),
        ),
      );
      const builtInMcpServers = builtInShioriMcpServers({
        provider: PROVIDER,
        settings: serverSettings,
      });
      const mcpServers = [...runtimeMcpServers, ...builtInMcpServers]
        .filter(
          (server) =>
            server.enabled && (!server.providers.length || server.providers.includes(PROVIDER)),
        )
        .map(toMcpServerConfig)
        .filter((server): server is McpServerConfig => server !== undefined);
      const approvalHandler = makeApprovalHandler(() => ctx);
      const sdkPolicies =
        input.runtimeMode === "approval-required"
          ? [policy.askUser("*", { handler: approvalHandler, name: "shiori_approval" })]
          : [policy.allowAll()];
      const startAgent = options?.startAgent ?? ((config: LocalAgentConfig) => Agent.start(config));
      const googleCloudProject = trimOrUndefined(geminiSettings.googleCloudProject);
      const runtimePath = trimOrUndefined(geminiSettings.binaryPath);
      const antigravityModel = resolveAntigravityModel(input.model);
      const configInput: ConstructorParameters<typeof LocalAgentConfig>[0] = {
        workspaces: [input.cwd],
        saveDir: nodePath.join(serverConfig.stateDir, "antigravity-sessions"),
        appDataDir: nodePath.join(serverConfig.stateDir, "antigravity-app-data"),
        ...(runtimePath ? { runtimePath } : {}),
        ...(input.resumeConversationId ? { conversationId: input.resumeConversationId } : {}),
        ...(antigravityModel ? { model: antigravityModel } : {}),
        capabilities: new CapabilitiesConfig(),
        policies: sdkPolicies,
        hooks: [makeUserInputHook(() => ctx)],
        mcpServers,
      };
      if (googleCloudProject) {
        configInput.project = googleCloudProject;
        configInput.location = "global";
        configInput.vertex = true;
      }
      const config = new LocalAgentConfig(configInput);
      const agent = yield* Effect.tryPromise(() => startAgent(config)).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to start Antigravity SDK agent."),
              cause,
            }),
        ),
      );
      const now = yield* nowIso;
      const conversationId = agent.conversationId ?? input.resumeConversationId;
      const session: ProviderSession = {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        threadId: input.threadId,
        resumeCursor: makeAntigravityResumeCursor(conversationId),
        createdAt: now,
        updatedAt: now,
      };
      ctx = {
        threadId: input.threadId,
        session,
        scope: sessionScope,
        agent,
        activeTurnFiber: undefined,
        pendingApprovals,
        pendingUserInputs,
        turns: [],
        startedItems: new Set(),
        activeTurnId: undefined,
        model: input.model,
        approvalPolicy: input.approvalPolicy,
        stopped: false,
      };
      sessions.set(input.threadId, ctx);
      sessionScopeTransferred = true;

      yield* offerRuntimeEvent({
        type: "session.started",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: input.threadId,
        payload: { resume: session.resumeCursor },
      });
      yield* offerRuntimeEvent({
        type: "session.state.changed",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: input.threadId,
        payload: { state: "ready", reason: "Antigravity SDK session ready" },
      });
      yield* offerRuntimeEvent({
        type: "thread.started",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: input.threadId,
        payload: conversationId ? { providerThreadId: conversationId } : {},
      });

      return ctx;
    });

    const startSession: GeminiAdapterShape["startSession"] = (input) =>
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
          const cwd = nodePath.resolve(trimOrUndefined(input.cwd) ?? serverConfig.cwd);
          const modelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }
          const resumeConversationId = parseAntigravityResume(input.resumeCursor)?.conversationId;
          const ctx = yield* createSessionContext({
            threadId: input.threadId,
            cwd,
            runtimeMode: input.runtimeMode,
            approvalPolicy: input.approvalPolicy,
            model: modelSelection?.model,
            ...(resumeConversationId ? { resumeConversationId } : {}),
          }).pipe(Effect.scoped);
          return ctx.session;
        }),
      );

    const buildPrompt = (input: Parameters<GeminiAdapterShape["sendTurn"]>[0]) =>
      Effect.gen(function* () {
        const promptParts: ContentPrimitive[] = [];
        if (input.input?.trim()) {
          promptParts.push(input.input.trim());
        }
        for (const attachment of input.attachments ?? []) {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "conversation/send",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "conversation/send",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          promptParts.push(
            new Image({
              data: bytes,
              mimeType: attachment.mimeType,
              description: attachment.name,
            }),
          );
        }
        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }
        return promptParts.length === 1 ? promptParts[0] : promptParts;
      });

    const sendTurn: GeminiAdapterShape["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          let ctx = yield* requireSession(input.threadId);
          const turnModelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
          const requestedModel = turnModelSelection?.model ?? ctx.model;
          if (requestedModel && requestedModel !== ctx.model) {
            const { cwd, runtimeMode } = ctx.session;
            const resumeConversationId = parseAntigravityResume(
              ctx.session.resumeCursor,
            )?.conversationId;
            yield* stopSessionInternal(ctx);
            ctx = yield* createSessionContext({
              threadId: input.threadId,
              cwd: cwd ?? serverConfig.cwd,
              runtimeMode,
              approvalPolicy: ctx.approvalPolicy,
              model: requestedModel,
              ...(resumeConversationId ? { resumeConversationId } : {}),
            }).pipe(Effect.scoped);
          }
          if (ctx.activeTurnId) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "An Antigravity turn is already in progress.",
            });
          }
          const prompt = yield* buildPrompt(input);
          const turnId = TurnId.makeUnsafe(crypto.randomUUID());
          ctx.activeTurnId = turnId;
          ctx.model = requestedModel;
          ctx.session = {
            ...ctx.session,
            status: "running",
            activeTurnId: turnId,
            ...(requestedModel ? { model: requestedModel } : {}),
            updatedAt: yield* nowIso,
          };
          yield* offerRuntimeEvent({
            type: "turn.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: requestedModel ? { model: requestedModel } : {},
          });

          const services = yield* Effect.services();
          const runFork = Effect.runForkWith(services);
          const turnFiber = runFork(
            Effect.tryPromise(async () => {
              await ctx.agent.conversation.send(prompt);
              const steps: Step[] = [];
              let finalState: "completed" | "failed" | "cancelled" = "completed";
              for await (const step of ctx.agent.conversation.receiveSteps()) {
                steps.push(step);
                await Effect.runPromise(processStep(ctx, step));
                if (
                  step.source === StepSource.MODEL &&
                  step.target === StepTarget.USER &&
                  [
                    StepStatus.DONE,
                    StepStatus.ERROR,
                    StepStatus.CANCELED,
                    StepStatus.TERMINAL_ERROR,
                  ].includes(step.status)
                ) {
                  finalState = turnStateFromStepStatus(step.status);
                }
              }
              return { steps, finalState };
            }).pipe(
              Effect.flatMap(({ steps, finalState }) =>
                Effect.gen(function* () {
                  ctx.turns.push({ id: turnId, items: steps });
                  yield* completeTurn(ctx, turnId, finalState);
                }),
              ),
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.void;
                const error = Cause.squash(cause);
                return Effect.gen(function* () {
                  yield* emitRuntimeError(ctx, turnId, error);
                  yield* completeTurn(ctx, turnId, "failed");
                });
              }),
            ),
          );
          ctx.activeTurnFiber = turnFiber;
          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }),
      );

    const interruptTurn: GeminiAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx);
        yield* Effect.tryPromise(() => ctx.agent.conversation.cancel()).pipe(Effect.ignore);
      });

    const respondToRequest: GeminiAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "preToolCall",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        pending.resolve(decision);
      });

    const respondToUserInput: GeminiAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "interaction",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        pending.resolve(answers);
      });

    const readThread: GeminiAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: GeminiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
      });

    const stopSession: GeminiAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: GeminiAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: GeminiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const stopAll: GeminiAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-session",
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
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    } satisfies GeminiAdapterShape;
  });
}

export const GeminiAdapterLive = Layer.effect(GeminiAdapter, makeGeminiAdapter());

export function makeGeminiAdapterLive(options?: GeminiAdapterLiveOptions) {
  return Layer.effect(GeminiAdapter, makeGeminiAdapter(options));
}
