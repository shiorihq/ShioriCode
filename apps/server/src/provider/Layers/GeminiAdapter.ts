/**
 * GeminiAdapterLive - Gemini CLI ACP provider adapter.
 *
 * Wraps `gemini --acp` (or older `--experimental-acp`) behind the generic
 * provider adapter contract and translates ACP session updates into Shiori's
 * canonical runtime event stream.
 *
 * @module GeminiAdapterLive
 */
import * as nodePath from "node:path";

import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderApprovalPolicy,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "contracts";
import {
  Cause,
  DateTime,
  Deferred,
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
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
  makeAcpUsageUpdatedEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import { normalizeAcpPromptUsage, parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import {
  type GeminiAcpApprovalMode,
  type GeminiAcpRuntimeInput,
  makeGeminiAcpRuntime,
  resolveGeminiAcpApprovalMode,
  selectGeminiAutoApprovedPermissionOption,
} from "../acp/GeminiAcpSupport.ts";
import { materializeMcpServersForRuntime, toAcpMcpServers } from "../mcpServers.ts";
import { GeminiAdapter, type GeminiAdapterShape } from "../Services/GeminiAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "gemini" as const;
const GEMINI_RESUME_VERSION = 1 as const;
const IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];
const PLAN_MODE_ALIASES = ["plan", "architect"];

export interface GeminiAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly makeAcpRuntime?: (
    input: GeminiAcpRuntimeInput,
  ) => Effect.Effect<AcpSessionRuntimeShape, import("effect-acp/errors").AcpError, Scope.Scope>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface GeminiSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  activeTurnFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  model: string | undefined;
  approvalMode: GeminiAcpApprovalMode;
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

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    pendingApprovals.values(),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function findPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string {
  const desiredKind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const option = request.options.find((entry) => entry.kind === desiredKind);
  if (option?.optionId?.trim()) {
    return option.optionId.trim();
  }
  return acpPermissionOutcome(decision);
}

function normalizeModeSearchText(mode: { id: string; name: string; description?: string }): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGeminiResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== GEMINI_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function findModeByAliases(
  modes: ReadonlyArray<{ id: string; name: string; description?: string }>,
  aliases: ReadonlyArray<string>,
): { id: string } | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) return exact;
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) return partial;
  }
  return undefined;
}

function resolveRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState:
    | {
        readonly currentModeId: string;
        readonly availableModes: ReadonlyArray<{
          readonly id: string;
          readonly name: string;
          readonly description?: string;
        }>;
      }
    | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) return undefined;
  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, PLAN_MODE_ALIASES)?.id;
  }
  return (
    findModeByAliases(modeState.availableModes, IMPLEMENT_MODE_ALIASES)?.id ??
    modeState.currentModeId
  );
}

function makeGeminiAdapter(options?: GeminiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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
        if (existing) {
          return Effect.succeed([existing, current] as const);
        }
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

    const stopSessionInternal = (ctx: GeminiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        if (ctx.activeTurnFiber) {
          yield* Fiber.interrupt(ctx.activeTurnFiber);
        }
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
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

    const createSessionContext = Effect.fn("createGeminiSessionContext")(function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly runtimeMode: RuntimeMode;
      readonly approvalPolicy: ProviderApprovalPolicy | undefined;
      readonly approvalMode: GeminiAcpApprovalMode;
      readonly model: string | undefined;
      readonly resumeSessionId?: string | undefined;
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
      const sessionScope = yield* Scope.make("sequential");
      let sessionScopeTransferred = false;
      yield* Effect.addFinalizer(() =>
        sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
      );
      let ctx!: GeminiSessionContext;

      const acpNativeLoggers = makeAcpNativeLoggers({
        nativeEventLogger,
        provider: PROVIDER,
        threadId: input.threadId,
      });
      const runtimeMcpServers = yield* Effect.tryPromise(() =>
        materializeMcpServersForRuntime({
          servers: serverSettings.mcpServers.servers,
          oauthStorageDir: nodePath.join(serverConfig.stateDir, "mcp-oauth"),
        }),
      ).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning(
              "gemini mcp OAuth materialization failed; continuing with static MCP config",
            );
            yield* Effect.logWarning(
              cause instanceof Error ? cause.message : "Failed to materialize Gemini MCP auth.",
            );
            return serverSettings.mcpServers.servers;
          }),
        ),
      );
      const runtimeServerSettings = {
        ...serverSettings,
        mcpServers: { servers: runtimeMcpServers },
      };

      const makeRuntime = options?.makeAcpRuntime ?? makeGeminiAcpRuntime;
      const acp = yield* makeRuntime({
        geminiSettings,
        childProcessSpawner,
        cwd: input.cwd,
        mcpServers: toAcpMcpServers(PROVIDER, runtimeServerSettings, undefined, {
          browserPanel: {
            config: serverConfig,
            threadId: input.threadId,
          },
        }),
        ...(input.model !== undefined ? { model: input.model } : {}),
        approvalMode: input.approvalMode,
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        clientInfo: { name: "shiori-code", version: "0.0.0" },
        ...acpNativeLoggers,
      }).pipe(
        Effect.provideService(Scope.Scope, sessionScope),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: cause.message,
              cause,
            }),
        ),
      );

      const started = yield* Effect.gen(function* () {
        yield* acp.handleRequestPermission((params) =>
          Effect.gen(function* () {
            yield* logNative(input.threadId, "session/request_permission", params);
            const autoApprovedOptionId = selectGeminiAutoApprovedPermissionOption(
              params,
              input.approvalMode,
            );
            if (autoApprovedOptionId !== undefined) {
              return {
                outcome: {
                  outcome: "selected" as const,
                  optionId: autoApprovedOptionId,
                },
              };
            }

            const permissionRequest = parsePermissionRequest(params);
            const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
            const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
            const decision = yield* Deferred.make<ProviderApprovalDecision>();
            pendingApprovals.set(requestId, { decision });
            yield* offerRuntimeEvent(
              makeAcpRequestOpenedEvent({
                stamp: yield* makeEventStamp(),
                provider: PROVIDER,
                threadId: input.threadId,
                ...(ctx?.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
                requestId: runtimeRequestId,
                permissionRequest,
                detail: permissionRequest.detail ?? JSON.stringify(params).slice(0, 2000),
                args: params,
                source: "acp.jsonrpc",
                method: "session/request_permission",
                rawPayload: params,
              }),
            );
            const resolved = yield* Deferred.await(decision);
            pendingApprovals.delete(requestId);
            yield* offerRuntimeEvent(
              makeAcpRequestResolvedEvent({
                stamp: yield* makeEventStamp(),
                provider: PROVIDER,
                threadId: input.threadId,
                ...(ctx?.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
                requestId: runtimeRequestId,
                permissionRequest,
                decision: resolved,
              }),
            );
            return {
              outcome:
                resolved === "cancel"
                  ? ({ outcome: "cancelled" } as const)
                  : {
                      outcome: "selected" as const,
                      optionId: findPermissionOption(params, resolved),
                    },
            };
          }),
        );
        return yield* acp.start();
      }).pipe(
        Effect.mapError((error) =>
          mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
        ),
      );

      const now = yield* nowIso;
      const session: ProviderSession = {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        threadId: input.threadId,
        resumeCursor: {
          schemaVersion: GEMINI_RESUME_VERSION,
          sessionId: started.sessionId,
        },
        createdAt: now,
        updatedAt: now,
      };

      ctx = {
        threadId: input.threadId,
        session,
        scope: sessionScope,
        acp,
        notificationFiber: undefined,
        activeTurnFiber: undefined,
        pendingApprovals,
        turns: [],
        activeTurnId: undefined,
        model: input.model,
        approvalMode: input.approvalMode,
        approvalPolicy: input.approvalPolicy,
        stopped: false,
      };

      const nf = yield* Stream.runDrain(
        Stream.mapEffect(acp.getEvents(), (event) =>
          Effect.gen(function* () {
            switch (event._tag) {
              case "ModeChanged":
                return;
              case "AssistantItemStarted":
                yield* offerRuntimeEvent(
                  makeAcpAssistantItemEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    itemId: event.itemId,
                    lifecycle: "item.started",
                  }),
                );
                return;
              case "AssistantItemCompleted":
                yield* offerRuntimeEvent(
                  makeAcpAssistantItemEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    itemId: event.itemId,
                    lifecycle: "item.completed",
                  }),
                );
                return;
              case "PlanUpdated":
                yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                yield* offerRuntimeEvent(
                  makeAcpPlanUpdatedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    payload: event.payload,
                    source: "acp.jsonrpc",
                    method: "session/update",
                    rawPayload: event.rawPayload,
                  }),
                );
                return;
              case "ToolCallUpdated":
                yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                yield* offerRuntimeEvent(
                  makeAcpToolCallEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    toolCall: event.toolCall,
                    rawPayload: event.rawPayload,
                  }),
                );
                return;
              case "ContentDelta":
                yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                yield* offerRuntimeEvent(
                  makeAcpContentDeltaEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    ...(event.itemId ? { itemId: event.itemId } : {}),
                    text: event.text,
                    rawPayload: event.rawPayload,
                  }),
                );
                return;
              case "UsageUpdated":
                yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                yield* offerRuntimeEvent(
                  makeAcpUsageUpdatedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    usage: event.usage,
                    source: "acp.jsonrpc",
                    method: "session/update",
                    rawPayload: event.rawPayload,
                  }),
                );
                return;
            }
          }),
        ),
      ).pipe(Effect.forkChild);

      ctx.notificationFiber = nf;
      sessions.set(input.threadId, ctx);
      sessionScopeTransferred = true;

      const requestedModeId = resolveRequestedModeId({
        interactionMode: undefined,
        runtimeMode: input.runtimeMode,
        modeState: yield* acp.getModeState,
      });
      if (requestedModeId) {
        yield* acp.setMode(requestedModeId).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", error),
          ),
          Effect.ignore,
        );
      }

      yield* offerRuntimeEvent({
        type: "session.started",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: input.threadId,
        payload: { resume: started.initializeResult },
      });
      yield* offerRuntimeEvent({
        type: "session.state.changed",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: input.threadId,
        payload: { state: "ready", reason: "Gemini ACP session ready" },
      });
      yield* offerRuntimeEvent({
        type: "thread.started",
        ...(yield* makeEventStamp()),
        provider: PROVIDER,
        threadId: input.threadId,
        payload: { providerThreadId: started.sessionId },
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
          const geminiModelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
          const approvalMode = resolveGeminiAcpApprovalMode({
            runtimeMode: input.runtimeMode,
            approvalPolicy: input.approvalPolicy,
          });
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const resumeSessionId = parseGeminiResume(input.resumeCursor)?.sessionId;
          const ctx = yield* createSessionContext({
            threadId: input.threadId,
            cwd,
            runtimeMode: input.runtimeMode,
            approvalPolicy: input.approvalPolicy,
            approvalMode,
            model: geminiModelSelection?.model,
            ...(resumeSessionId ? { resumeSessionId } : {}),
          }).pipe(Effect.scoped);
          return ctx.session;
        }),
      );

    const completeTurn = (
      ctx: GeminiSessionContext,
      turnId: TurnId,
      status: "completed" | "failed" | "cancelled",
    ) =>
      Effect.gen(function* () {
        const now = yield* nowIso;
        ctx.activeTurnId = undefined;
        ctx.activeTurnFiber = undefined;
        const { activeTurnId: _activeTurnId, ...sessionWithoutActiveTurn } = ctx.session;
        ctx.session = {
          ...sessionWithoutActiveTurn,
          status: status === "failed" ? "error" : "ready",
          updatedAt: now,
        };
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {
            state: status === "cancelled" ? "cancelled" : status,
          },
        });
      });

    const emitRuntimeError = (ctx: GeminiSessionContext, turnId: TurnId, cause: unknown) =>
      offerRuntimeEvent({
        type: "runtime.error",
        eventId: EventId.makeUnsafe(crypto.randomUUID()),
        provider: PROVIDER,
        createdAt: new Date().toISOString(),
        threadId: ctx.threadId,
        turnId,
        payload: {
          message: toMessage(cause, "Gemini ACP turn failed."),
          class: "provider_error",
          detail: cause,
        },
      });

    const sendTurn: GeminiAdapterShape["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          let ctx = yield* requireSession(input.threadId);
          const turnModelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
          const requestedModel = turnModelSelection?.model ?? ctx.model;
          const requestedApprovalMode = resolveGeminiAcpApprovalMode({
            runtimeMode: ctx.session.runtimeMode,
            approvalPolicy: ctx.approvalPolicy,
            interactionMode: input.interactionMode,
          });
          if (
            (requestedModel && requestedModel !== ctx.model) ||
            requestedApprovalMode !== ctx.approvalMode
          ) {
            const { cwd, runtimeMode } = ctx.session;
            const resumeSessionId = parseGeminiResume(ctx.session.resumeCursor)?.sessionId;
            yield* stopSessionInternal(ctx);
            ctx = yield* createSessionContext({
              threadId: input.threadId,
              cwd: cwd ?? serverConfig.cwd,
              runtimeMode,
              approvalPolicy: ctx.approvalPolicy,
              approvalMode: requestedApprovalMode,
              model: requestedModel,
              ...(resumeSessionId ? { resumeSessionId } : {}),
            }).pipe(Effect.scoped);
          }

          if (ctx.activeTurnId) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "A Gemini turn is already in progress.",
            });
          }

          const requestedModeId = resolveRequestedModeId({
            interactionMode: input.interactionMode,
            runtimeMode: ctx.session.runtimeMode,
            modeState: yield* ctx.acp.getModeState,
          });
          if (requestedModeId) {
            yield* ctx.acp.setMode(requestedModeId).pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", error),
              ),
              Effect.ignore,
            );
          }

          const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
          if (input.input?.trim()) {
            promptParts.push({ type: "text", text: input.input.trim() });
          }
          for (const attachment of input.attachments ?? []) {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            promptParts.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }

          if (promptParts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

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
            ctx.acp.prompt({ prompt: promptParts }).pipe(
              Effect.flatMap((result) =>
                Effect.gen(function* () {
                  ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
                  const usage = normalizeAcpPromptUsage(result.usage);
                  if (usage) {
                    yield* offerRuntimeEvent(
                      makeAcpUsageUpdatedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId,
                        usage,
                        source: "acp.jsonrpc",
                        method: "session/prompt",
                        rawPayload: result,
                      }),
                    );
                  }
                  yield* completeTurn(
                    ctx,
                    turnId,
                    result.stopReason === "cancelled" ? "cancelled" : "completed",
                  );
                }),
              ),
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) {
                  return Effect.void;
                }
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
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
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
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: GeminiAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      _answers,
    ) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/elicitation",
          detail: `Unknown pending user-input request: ${requestId} for thread '${threadId}'.`,
        }),
      );

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
