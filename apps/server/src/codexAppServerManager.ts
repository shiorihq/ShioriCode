import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { StringDecoder } from "node:string_decoder";

import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  ProviderRequestKind,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  RuntimeMode,
  ProviderInteractionMode,
} from "contracts";
import { normalizeModelSlug } from "shared/model";
import { Effect, ServiceMap } from "effect";

import { buildAssistantSettingsAppendix } from "./assistantPersonality";
import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "./provider/codexCliVersion";
import {
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./provider/codexJsonRpc";
import {
  type PendingApprovalRequest,
  type PendingRequest,
  type PendingRequestKey,
  type PendingUserInputRequest,
} from "./provider/codexRequestTracker";
import {
  classifyCodexStderrLine,
  consumeCodexStderrChunk,
  flushCodexStderrStream,
  isRecoverableThreadResumeError,
  type CodexStderrStreamState,
} from "./provider/codexStderr";
import { toCodexUserInputAnswers } from "./provider/codexUserInput";
import {
  CODEX_SPARK_MODEL,
  readCodexAccountSnapshot,
  readCodexUsageSnapshot,
  resolveCodexModelForAccount,
  type CodexAccountSnapshot,
} from "./provider/codexAccount";
import { buildCodexCollaborationMode } from "./provider/policy/codexPromptPolicy";
import {
  buildCodexAppServerArgs,
  buildCodexInitializeParams,
  CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS,
  killCodexChildProcess,
  readCodexModelListSnapshot,
  type CodexAppServerModelSnapshot,
} from "./provider/codexAppServer";
import type { CodexUsageSnapshot } from "./provider/Services/ProviderUsage.ts";
import { ServerSettingsService } from "./serverSettings";

export {
  buildCodexAppServerArgs,
  buildCodexInitializeParams,
  CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS,
} from "./provider/codexAppServer";
export { readCodexAccountSnapshot, resolveCodexModelForAccount } from "./provider/codexAccount";

interface CodexSessionContext {
  session: ProviderSession;
  providerThreadId?: string;
  account: CodexAccountSnapshot;
  supportsReasoningSummary: boolean;
  child: ChildProcessWithoutNullStreams;
  output: readline.Interface;
  pending: Map<PendingRequestKey, PendingRequest>;
  pendingApprovals: Map<ApprovalRequestId, PendingApprovalRequest>;
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInputRequest>;
  collabReceiverTurns: Map<
    string,
    {
      parentTurnId: TurnId;
      parentItemId?: ProviderItemId;
    }
  >;
  nextRequestId: number;
  stopping: boolean;
}

function isUserInputRequestMethod(method: string): method is CodexUserInputRequestMethod {
  return CODEX_SERVER_REQUEST_HANDLERS[method as CodexServerRequestMethod] === "user-input";
}

export interface CodexAppServerSendTurnInput {
  readonly threadId: ThreadId;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{ type: "image"; url: string }>;
  readonly model?: string;
  readonly serviceTier?: string | null;
  readonly effort?: string;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface CodexAppServerStartSessionInput {
  readonly threadId: ThreadId;
  readonly provider?: "codex";
  readonly cwd?: string;
  readonly model?: string;
  readonly serviceTier?: string;
  readonly resumeCursor?: unknown;
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly supportsReasoningSummary?: boolean;
  readonly runtimeMode: RuntimeMode;
}

export interface CodexThreadTurnSnapshot {
  id: TurnId;
  items: unknown[];
}

export interface CodexThreadSnapshot {
  threadId: string;
  turns: CodexThreadTurnSnapshot[];
}

const CODEX_VERSION_CHECK_TIMEOUT_MS = 4_000;
const CODEX_SESSION_METADATA_TIMEOUT_MS = 4_000;

const CODEX_SERVER_REQUEST_HANDLERS = {
  "account/chatgptAuthTokens/refresh": "unsupported",
  "item/commandExecution/requestApproval": "approval",
  "item/fileChange/requestApproval": "approval",
  "item/fileRead/requestApproval": "approval",
  "item/tool/call": "unsupported",
  "item/tool/requestUserInput": "user-input",
  "mcpServer/elicitation/request": "user-input",
  "permissions/requestApproval": "approval",
  "tool/requestUserInput": "user-input",
} as const;

type CodexServerRequestMethod = keyof typeof CODEX_SERVER_REQUEST_HANDLERS;

type CodexUserInputRequestMethod = Extract<
  CodexServerRequestMethod,
  "item/tool/requestUserInput" | "tool/requestUserInput" | "mcpServer/elicitation/request"
>;

function mapCodexRuntimeMode(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: "on-request" | "never";
  readonly sandbox: "workspace-write" | "danger-full-access";
} {
  if (runtimeMode === "approval-required") {
    return {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    };
  }

  return {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  };
}

/**
 * On Windows with `shell: true`, `child.kill()` only terminates the `cmd.exe`
 * wrapper, leaving the actual command running. Use `taskkill /T` to kill the
 * entire process tree instead.
 */
function killChildTree(child: ChildProcessWithoutNullStreams): void {
  killCodexChildProcess(child);
}

export function normalizeCodexModelSlug(
  model: string | undefined | null,
  preferredId?: string,
): string | undefined {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return undefined;
  }

  if (preferredId?.endsWith("-codex") && preferredId !== normalized) {
    return preferredId;
  }

  return normalized;
}

function supportsDetailedReasoningSummaryForModel(model: string | undefined): boolean {
  return model !== CODEX_SPARK_MODEL;
}

export interface CodexAppServerManagerEvents {
  event: [event: ProviderEvent];
}

export class CodexAppServerManager extends EventEmitter<CodexAppServerManagerEvents> {
  private readonly sessions = new Map<ThreadId, CodexSessionContext>();
  private readonly services: ServiceMap.ServiceMap<any> | undefined;

  constructor(services?: ServiceMap.ServiceMap<never>) {
    super();
    this.services = services as ServiceMap.ServiceMap<any> | undefined;
  }

  private readonly runPromise = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
    this.services
      ? Effect.runPromiseWith(this.services)(effect as Effect.Effect<A, E, never>)
      : Effect.runPromise(effect as Effect.Effect<A, E, never>);

  private async readAssistantSettingsAppendix(): Promise<string | undefined> {
    try {
      const result = (await this.runPromise(
        Effect.result(
          Effect.gen(function* () {
            const serverSettings = yield* ServerSettingsService;
            const settings = yield* serverSettings.getSettings;
            return buildAssistantSettingsAppendix({
              personality: settings.assistantPersonality,
              generateMemories: settings.generateMemories,
            });
          }),
        ),
      )) as { _tag: "Success"; value: string | undefined } | { _tag: "Failure" };
      return result._tag === "Success" ? result.value : undefined;
    } catch {
      return undefined;
    }
  }

  private async refreshSessionMetadata(
    context: CodexSessionContext,
    input: { readonly requestedModel?: string; readonly timeoutMs?: number },
  ): Promise<{
    readonly model?: string;
    readonly models: ReadonlyArray<CodexAppServerModelSnapshot> | null;
  }> {
    const timeoutMs = input.timeoutMs ?? CODEX_SESSION_METADATA_TIMEOUT_MS;
    const logFailure = async (method: string, error: unknown) => {
      await Effect.logDebug("codex app-server session metadata request failed", {
        threadId: context.session.threadId,
        method,
        cause: error instanceof Error ? error.message : String(error),
      }).pipe(this.runPromise);
    };

    let models: ReadonlyArray<CodexAppServerModelSnapshot> | null = null;

    const modelListPromise = this.sendRequest(context, "model/list", {}, timeoutMs)
      .then((response) => {
        models = readCodexModelListSnapshot(response);
      })
      .catch(async (error) => {
        await logFailure("model/list", error);
      });

    const accountReadPromise = this.sendRequest(context, "account/read", {}, timeoutMs)
      .then(async (response) => {
        const account = readCodexAccountSnapshot(response);
        context.account = account;

        await Effect.logDebug("codex app-server hydrated session account metadata", {
          threadId: context.session.threadId,
          accountType: account.type,
          planType: account.planType,
          sparkEnabled: account.sparkEnabled,
        }).pipe(this.runPromise);
      })
      .catch(async (error) => {
        await logFailure("account/read", error);
      });

    await Promise.allSettled([modelListPromise, accountReadPromise]);

    const requestedModel = normalizeCodexModelSlug(input.requestedModel ?? context.session.model);
    const resolvedModel = this.resolveModelForSessionMetadata({
      ...(requestedModel ? { requestedModel } : {}),
      account: context.account,
      models,
    });
    if (resolvedModel !== context.session.model) {
      this.updateSession(context, { model: resolvedModel });
    }

    return { ...(resolvedModel !== undefined ? { model: resolvedModel } : {}), models };
  }

  private async hydrateSessionMetadataInBackground(
    context: CodexSessionContext,
    input: { readonly requestedModel?: string },
  ): Promise<void> {
    await this.refreshSessionMetadata(context, input);
  }

  async startSession(input: CodexAppServerStartSessionInput): Promise<ProviderSession> {
    const threadId = input.threadId;
    const now = new Date().toISOString();
    let context: CodexSessionContext | undefined;

    try {
      const resolvedCwd = input.cwd ?? process.cwd();

      const session: ProviderSession = {
        provider: "codex",
        status: "connecting",
        runtimeMode: input.runtimeMode,
        model: normalizeCodexModelSlug(input.model),
        cwd: resolvedCwd,
        threadId,
        createdAt: now,
        updatedAt: now,
      };

      const codexBinaryPath = input.binaryPath;
      const codexHomePath = input.homePath;
      this.assertSupportedCodexCliVersion({
        binaryPath: codexBinaryPath,
        cwd: resolvedCwd,
        ...(codexHomePath ? { homePath: codexHomePath } : {}),
      });
      const child = spawn(codexBinaryPath, buildCodexAppServerArgs(), {
        cwd: resolvedCwd,
        env: {
          ...process.env,
          ...(codexHomePath ? { CODEX_HOME: codexHomePath } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      const output = readline.createInterface({ input: child.stdout });

      context = {
        session,
        account: {
          type: "unknown",
          planType: null,
          sparkEnabled: false,
        },
        supportsReasoningSummary: input.supportsReasoningSummary === true,
        child,
        output,
        pending: new Map(),
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        collabReceiverTurns: new Map(),
        nextRequestId: 1,
        stopping: false,
      };

      this.sessions.set(threadId, context);
      this.attachProcessListeners(context);

      this.emitLifecycleEvent(context, "session/connecting", "Starting codex app-server");

      await this.sendRequest(
        context,
        "initialize",
        buildCodexInitializeParams(),
        CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS,
      );

      this.writeMessage(context, { method: "initialized" });
      const requestedModel = normalizeCodexModelSlug(input.model);
      const metadata = await this.refreshSessionMetadata(
        context,
        requestedModel === undefined ? {} : { requestedModel },
      );
      const normalizedModel = metadata.model;
      const sessionOverrides = {
        model: normalizedModel ?? null,
        ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
        cwd: input.cwd ?? null,
        ...mapCodexRuntimeMode(input.runtimeMode ?? "full-access"),
      };

      const threadStartParams = {
        ...sessionOverrides,
        experimentalRawEvents: false,
      };
      const resumeThreadId = readResumeThreadId(input);
      this.emitLifecycleEvent(
        context,
        "session/threadOpenRequested",
        resumeThreadId
          ? `Attempting to resume thread ${resumeThreadId}.`
          : "Starting a new Codex thread.",
      );
      await Effect.logInfo("codex app-server opening thread", {
        threadId,
        requestedRuntimeMode: input.runtimeMode,
        requestedModel: normalizedModel ?? null,
        requestedCwd: resolvedCwd,
        resumeThreadId: resumeThreadId ?? null,
      }).pipe(this.runPromise);

      let threadOpenMethod: "thread/start" | "thread/resume" = "thread/start";
      let threadOpenResponse: unknown;
      if (resumeThreadId) {
        try {
          threadOpenMethod = "thread/resume";
          threadOpenResponse = await this.sendRequest(context, "thread/resume", {
            ...sessionOverrides,
            threadId: resumeThreadId,
          });
        } catch (error) {
          if (!isRecoverableThreadResumeError(error)) {
            this.emitErrorEvent(
              context,
              "session/threadResumeFailed",
              error instanceof Error ? error.message : "Codex thread resume failed.",
            );
            await Effect.logWarning("codex app-server thread resume failed", {
              threadId,
              requestedRuntimeMode: input.runtimeMode,
              resumeThreadId,
              recoverable: false,
              cause: error instanceof Error ? error.message : String(error),
            }).pipe(this.runPromise);
            throw error;
          }

          threadOpenMethod = "thread/start";
          this.emitLifecycleEvent(
            context,
            "session/threadResumeFallback",
            `Could not resume thread ${resumeThreadId}; started a new thread instead.`,
          );
          await Effect.logWarning("codex app-server thread resume fell back to fresh start", {
            threadId,
            requestedRuntimeMode: input.runtimeMode,
            resumeThreadId,
            recoverable: true,
            cause: error instanceof Error ? error.message : String(error),
          }).pipe(this.runPromise);
          threadOpenResponse = await this.sendRequest(context, "thread/start", threadStartParams);
        }
      } else {
        threadOpenMethod = "thread/start";
        threadOpenResponse = await this.sendRequest(context, "thread/start", threadStartParams);
      }

      const threadOpenRecord = this.readObject(threadOpenResponse);
      const threadIdRaw =
        this.readString(this.readObject(threadOpenRecord, "thread"), "id") ??
        this.readString(threadOpenRecord, "threadId");
      if (!threadIdRaw) {
        throw new Error(`${threadOpenMethod} response did not include a thread id.`);
      }
      const providerThreadId = threadIdRaw;

      context.providerThreadId = providerThreadId;
      const resumeCursor = { threadId: providerThreadId };
      this.updateSession(context, {
        status: "ready",
        resumeCursor,
      });
      this.emitLifecycleEvent(
        context,
        "session/threadOpenResolved",
        `Codex ${threadOpenMethod} resolved.`,
      );
      await Effect.logInfo("codex app-server thread open resolved", {
        threadId,
        threadOpenMethod,
        requestedResumeThreadId: resumeThreadId ?? null,
        resolvedThreadId: providerThreadId,
        requestedRuntimeMode: input.runtimeMode,
      }).pipe(this.runPromise);
      this.emitLifecycleEvent(context, "session/ready", `Connected to thread ${providerThreadId}`);
      return { ...context.session };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start Codex session.";
      if (context) {
        this.updateSession(context, {
          status: "error",
          lastError: message,
        });
        this.emitErrorEvent(context, "session/startFailed", message);
        this.stopSession(threadId);
      } else {
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "error",
          provider: "codex",
          threadId,
          createdAt: new Date().toISOString(),
          method: "session/startFailed",
          message,
        });
      }
      throw new Error(message, { cause: error });
    }
  }

  async sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    context.collabReceiverTurns.clear();

    const turnInput: Array<
      { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }
    > = [];
    if (input.input) {
      turnInput.push({
        type: "text",
        text: input.input,
        text_elements: [],
      });
    }
    for (const attachment of input.attachments ?? []) {
      if (attachment.type === "image") {
        turnInput.push({
          type: "image",
          url: attachment.url,
        });
      }
    }
    if (turnInput.length === 0) {
      throw new Error("Turn input must include text or attachments.");
    }

    const providerThreadId = this.readProviderThreadId(context);
    if (!providerThreadId) {
      throw new Error("Session is missing provider resume thread id.");
    }
    const turnStartParams: {
      threadId: string;
      input: Array<
        { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }
      >;
      model?: string;
      serviceTier?: string | null;
      effort?: string;
      summary?: "detailed";
      collaborationMode?: {
        mode: "default" | "plan";
        settings: {
          model: string;
          reasoning_effort: string;
          developer_instructions: string;
        };
      };
    } = {
      threadId: providerThreadId,
      input: turnInput,
    };
    const normalizedModel = resolveCodexModelForAccount(
      normalizeCodexModelSlug(input.model ?? context.session.model),
      context.account,
    );
    if (normalizedModel) {
      turnStartParams.model = normalizedModel;
    }
    if (input.serviceTier !== undefined) {
      turnStartParams.serviceTier = input.serviceTier;
    }
    if (input.effort) {
      turnStartParams.effort = input.effort;
    }
    if (
      context.supportsReasoningSummary &&
      supportsDetailedReasoningSummaryForModel(normalizedModel)
    ) {
      turnStartParams.summary = "detailed";
    }
    const developerInstructionsAppendix = await this.readAssistantSettingsAppendix();
    const collaborationMode = buildCodexCollaborationMode({
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(developerInstructionsAppendix !== undefined ? { developerInstructionsAppendix } : {}),
    });
    if (collaborationMode) {
      if (!turnStartParams.model) {
        turnStartParams.model = collaborationMode.settings.model;
      }
      turnStartParams.collaborationMode = collaborationMode;
    }

    const response = await this.sendRequest(context, "turn/start", turnStartParams);

    const turn = this.readObject(this.readObject(response), "turn");
    const turnIdRaw = this.readString(turn, "id");
    if (!turnIdRaw) {
      throw new Error("turn/start response did not include a turn id.");
    }
    const turnId = TurnId.makeUnsafe(turnIdRaw);
    const resumeCursor = { threadId: providerThreadId };

    this.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
      resumeCursor,
    });

    return {
      threadId: context.session.threadId,
      turnId,
      resumeCursor,
    };
  }

  async interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    const context = this.requireSession(threadId);
    const effectiveTurnId = turnId ?? context.session.activeTurnId;

    const providerThreadId = this.readProviderThreadId(context);
    if (!effectiveTurnId || !providerThreadId) {
      return;
    }

    await this.sendRequest(context, "turn/interrupt", {
      threadId: providerThreadId,
      turnId: effectiveTurnId,
    });
  }

  async readThread(threadId: ThreadId): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    const providerThreadId = this.readProviderThreadId(context);
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }

    const response = await this.sendRequest(context, "thread/read", {
      threadId: providerThreadId,
      includeTurns: true,
    });
    return this.parseThreadSnapshot("thread/read", response);
  }

  async rollbackThread(threadId: ThreadId, numTurns: number): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    const providerThreadId = this.readProviderThreadId(context);
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new Error("numTurns must be an integer >= 1.");
    }

    const response = await this.sendRequest(context, "thread/rollback", {
      threadId: providerThreadId,
      numTurns,
    });
    this.updateSession(context, {
      status: "ready",
      activeTurnId: undefined,
    });
    return this.parseThreadSnapshot("thread/rollback", response);
  }

  async readUsage(threadId: ThreadId): Promise<CodexUsageSnapshot> {
    const context = this.requireSession(threadId);
    const response = await this.sendRequest(context, "account/rateLimits/read", {});
    return readCodexUsageSnapshot(response);
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pendingRequest = context.pendingApprovals.get(requestId);
    if (!pendingRequest) {
      throw new Error(`Unknown pending approval request: ${requestId}`);
    }

    context.pendingApprovals.delete(requestId);
    this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result: {
        decision,
      },
    });

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "item/requestApproval/decision",
      turnId: pendingRequest.turnId,
      itemId: pendingRequest.itemId,
      requestId: pendingRequest.requestId,
      requestKind: pendingRequest.requestKind,
      payload: {
        requestId: pendingRequest.requestId,
        requestKind: pendingRequest.requestKind,
        decision,
      },
    });
  }

  async respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pendingRequest = context.pendingUserInputs.get(requestId);
    if (!pendingRequest) {
      throw new Error(`Unknown pending user input request: ${requestId}`);
    }

    context.pendingUserInputs.delete(requestId);
    const codexAnswers = toCodexUserInputAnswers(answers);
    const result =
      pendingRequest.requestMethod === "mcpServer/elicitation/request"
        ? {
            action: "accept",
            content: this.toPlainUserInputAnswers(answers),
          }
        : {
            answers: codexAnswers,
          };
    this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result,
    });

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: this.userInputResolvedMethod(pendingRequest.requestMethod),
      turnId: pendingRequest.turnId,
      itemId: pendingRequest.itemId,
      requestId: pendingRequest.requestId,
      payload: {
        requestId: pendingRequest.requestId,
        answers:
          pendingRequest.requestMethod === "mcpServer/elicitation/request"
            ? this.toPlainUserInputAnswers(answers)
            : codexAnswers,
      },
    });
  }

  stopSession(threadId: ThreadId): void {
    const context = this.sessions.get(threadId);
    if (!context) {
      return;
    }

    context.stopping = true;

    this.failPendingRequests(context, "Session stopped before request completed.");

    context.output.close();

    if (!context.child.killed) {
      killChildTree(context.child);
    }

    this.updateSession(context, {
      status: "closed",
      activeTurnId: undefined,
    });
    this.emitLifecycleEvent(context, "session/closed", "Session stopped");
    this.sessions.delete(threadId);
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values(), ({ session }) => ({
      ...session,
    }));
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  stopAll(): void {
    for (const threadId of this.sessions.keys()) {
      this.stopSession(threadId);
    }
  }

  private requireSession(threadId: ThreadId): CodexSessionContext {
    const context = this.sessions.get(threadId);
    if (!context) {
      throw new Error(`Unknown session for thread: ${threadId}`);
    }

    if (context.session.status === "closed") {
      throw new Error(`Session is closed for thread: ${threadId}`);
    }

    return context;
  }

  private attachProcessListeners(context: CodexSessionContext): void {
    context.output.on("line", (line) => {
      this.handleStdoutLine(context, line);
    });

    // StringDecoder buffers incomplete multi-byte UTF-8 sequences across
    // chunk boundaries, preventing replacement-character corruption.
    const stderrDecoder = new StringDecoder("utf8");
    let stderrState: CodexStderrStreamState = { pendingBlock: null, remainder: "" };
    const emitClassifiedStderrLines = (rawLines: ReadonlyArray<string>) => {
      for (const rawLine of rawLines) {
        const classified = classifyCodexStderrLine(rawLine);
        if (!classified) {
          continue;
        }

        this.emitNotificationEvent(context, "process/stderr", classified.message);
      }
    };
    context.child.stderr.on("data", (chunk: Buffer) => {
      const raw = stderrDecoder.write(chunk);
      const next = consumeCodexStderrChunk(stderrState, raw);
      stderrState = next.state;
      emitClassifiedStderrLines(next.emittedLines);
    });
    context.child.stderr.on("end", () => {
      const raw = stderrDecoder.end();
      if (raw.length > 0) {
        const next = consumeCodexStderrChunk(stderrState, raw);
        stderrState = next.state;
        emitClassifiedStderrLines(next.emittedLines);
      }

      const flushed = flushCodexStderrStream(stderrState);
      stderrState = flushed.state;
      emitClassifiedStderrLines(flushed.emittedLines);
    });

    context.child.on("error", (error) => {
      const message = error.message || "codex app-server process errored.";
      this.updateSession(context, {
        status: "error",
        lastError: message,
      });
      this.failPendingRequests(context, message);
      this.emitErrorEvent(context, "process/error", message);
    });

    context.child.on("exit", (code, signal) => {
      if (context.stopping) {
        return;
      }

      const message = `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      this.updateSession(context, {
        status: "closed",
        activeTurnId: undefined,
        lastError: code === 0 ? context.session.lastError : message,
      });
      this.failPendingRequests(context, message);
      this.emitLifecycleEvent(context, "session/exited", message);
      this.sessions.delete(context.session.threadId);
    });
  }

  private handleStdoutLine(context: CodexSessionContext, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emitErrorEvent(
        context,
        "protocol/parseError",
        "Received invalid JSON from codex app-server.",
      );
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      this.emitErrorEvent(
        context,
        "protocol/invalidMessage",
        "Received non-object protocol message.",
      );
      return;
    }

    if (this.isServerRequest(parsed)) {
      this.handleServerRequest(context, parsed);
      return;
    }

    if (this.isServerNotification(parsed)) {
      this.handleServerNotification(context, parsed);
      return;
    }

    if (this.isResponse(parsed)) {
      this.handleResponse(context, parsed);
      return;
    }

    this.emitErrorEvent(
      context,
      "protocol/unrecognizedMessage",
      "Received protocol message in an unknown shape.",
    );
  }

  private handleServerNotification(
    context: CodexSessionContext,
    notification: JsonRpcNotification,
  ): void {
    const rawRoute = this.readRouteFields(notification.params);
    this.rememberCollabReceiverTurns(context, notification.params, rawRoute.turnId);
    const childRoute = this.readChildRoute(context, notification.params);
    const childParentTurnId = childRoute?.parentTurnId;
    const isChildConversation = childRoute !== undefined;
    if (
      isChildConversation &&
      this.shouldSuppressChildConversationNotification(notification.method)
    ) {
      return;
    }
    const textDelta =
      notification.method === "item/agentMessage/delta"
        ? this.readString(notification.params, "delta")
        : undefined;

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: notification.method,
      ...((childParentTurnId ?? rawRoute.turnId)
        ? { turnId: childParentTurnId ?? rawRoute.turnId }
        : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      textDelta,
      payload: this.attachChildParentItemId(notification.params, childRoute?.parentItemId),
    });

    if (notification.method === "thread/started") {
      const providerThreadId = normalizeProviderThreadId(
        this.readString(this.readObject(notification.params)?.thread, "id"),
      );
      if (providerThreadId) {
        context.providerThreadId = providerThreadId;
        this.updateSession(context, {
          resumeCursor: { threadId: providerThreadId },
        });
      }
      return;
    }

    if (notification.method === "turn/started") {
      if (isChildConversation) {
        return;
      }
      const turnId = toTurnId(this.readString(this.readObject(notification.params)?.turn, "id"));
      this.updateSession(context, {
        status: "running",
        activeTurnId: turnId,
      });
      return;
    }

    if (notification.method === "turn/completed") {
      if (isChildConversation) {
        return;
      }
      context.collabReceiverTurns.clear();
      const turn = this.readObject(notification.params, "turn");
      const status = this.readString(turn, "status");
      const errorMessage = this.readString(this.readObject(turn, "error"), "message");
      this.updateSession(context, {
        status: status === "failed" ? "error" : "ready",
        activeTurnId: undefined,
        lastError: errorMessage ?? context.session.lastError,
      });
      return;
    }

    if (notification.method === "error") {
      if (isChildConversation) {
        return;
      }
      const message = this.readString(this.readObject(notification.params)?.error, "message");
      const willRetry = this.readBoolean(notification.params, "willRetry");

      this.updateSession(context, {
        status: willRetry ? "running" : "error",
        lastError: message ?? context.session.lastError,
      });
    }
  }

  private handleServerRequest(context: CodexSessionContext, request: JsonRpcRequest): void {
    const handler = CODEX_SERVER_REQUEST_HANDLERS[request.method as CodexServerRequestMethod];
    const rawRoute = this.readRouteFields(request.params);
    const childRoute = this.readChildRoute(context, request.params);
    const childParentTurnId = childRoute?.parentTurnId;
    const effectiveTurnId = childParentTurnId ?? rawRoute.turnId;
    const requestKind =
      handler === "approval" ? this.requestKindForMethod(request.method) : undefined;
    let requestId: ApprovalRequestId | undefined;
    if (requestKind) {
      requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      const pendingRequest: PendingApprovalRequest = {
        requestId,
        jsonRpcId: request.id,
        method: this.approvalMethodForRequest(request.method, requestKind),
        requestKind,
        threadId: context.session.threadId,
        ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
        ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      };
      context.pendingApprovals.set(requestId, pendingRequest);
    }

    if (isUserInputRequestMethod(request.method)) {
      requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      context.pendingUserInputs.set(requestId, {
        requestId,
        jsonRpcId: request.id,
        threadId: context.session.threadId,
        ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
        ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
        requestMethod: request.method,
      });
    }
    const payload = this.payloadForServerRequest(request.method, request.params);

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "request",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: request.method,
      ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      requestId,
      requestKind,
      payload: this.attachChildParentItemId(payload, childRoute?.parentItemId),
    });

    if (requestKind) {
      return;
    }

    if (isUserInputRequestMethod(request.method)) {
      return;
    }

    this.rejectUnsupportedServerRequest(context, request);
  }

  private handleResponse(context: CodexSessionContext, response: JsonRpcResponse): void {
    const key = String(response.id);
    const pending = context.pending.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    context.pending.delete(key);

    if (response.error?.message) {
      pending.reject(new Error(`${pending.method} failed: ${String(response.error.message)}`));
      return;
    }

    pending.resolve(response.result);
  }

  private async sendRequest<TResponse>(
    context: CodexSessionContext,
    method: string,
    params: unknown,
    timeoutMs = 20_000,
  ): Promise<TResponse> {
    const id = context.nextRequestId;
    context.nextRequestId += 1;

    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        context.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      context.pending.set(String(id), {
        method,
        timeout,
        resolve,
        reject,
      });
      this.writeMessage(context, {
        method,
        id,
        params,
      });
    });

    return result as TResponse;
  }

  private failPendingRequests(context: CodexSessionContext, message: string): void {
    const error = new Error(message);
    for (const pending of context.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    context.pending.clear();

    const pendingApprovals = Array.from(context.pendingApprovals.values());
    context.pendingApprovals.clear();
    for (const pendingRequest of pendingApprovals) {
      this.emitEvent({
        id: EventId.makeUnsafe(randomUUID()),
        kind: "notification",
        provider: "codex",
        threadId: context.session.threadId,
        createdAt: new Date().toISOString(),
        method: "serverRequest/resolved",
        ...(pendingRequest.turnId ? { turnId: pendingRequest.turnId } : {}),
        ...(pendingRequest.itemId ? { itemId: pendingRequest.itemId } : {}),
        requestId: pendingRequest.requestId,
        requestKind: pendingRequest.requestKind,
        payload: {
          requestId: pendingRequest.requestId,
          requestKind: pendingRequest.requestKind,
          status: "cancelled",
          reason: message,
          request: {
            method: pendingRequest.method,
            kind: pendingRequest.requestKind,
          },
        },
      });
    }

    const pendingUserInputs = Array.from(context.pendingUserInputs.values());
    context.pendingUserInputs.clear();
    for (const pendingRequest of pendingUserInputs) {
      this.emitEvent({
        id: EventId.makeUnsafe(randomUUID()),
        kind: "notification",
        provider: "codex",
        threadId: context.session.threadId,
        createdAt: new Date().toISOString(),
        method: this.userInputResolvedMethod(pendingRequest.requestMethod),
        ...(pendingRequest.turnId ? { turnId: pendingRequest.turnId } : {}),
        ...(pendingRequest.itemId ? { itemId: pendingRequest.itemId } : {}),
        requestId: pendingRequest.requestId,
        payload: {
          requestId: pendingRequest.requestId,
          status: "cancelled",
          reason: message,
          answers: {},
        },
      });
    }
  }

  private handleWriteFailure(context: CodexSessionContext, error: unknown): Error {
    const normalizedError =
      error instanceof Error
        ? error
        : new Error(`Failed to write to codex app-server stdin: ${String(error)}`);
    const message = normalizedError.message || "Failed to write to codex app-server stdin.";
    this.updateSession(context, {
      status: "error",
      lastError: message,
    });
    this.failPendingRequests(context, message);
    this.emitErrorEvent(context, "process/stdinWriteFailed", message);
    return normalizedError;
  }

  private writeMessage(context: CodexSessionContext, message: unknown): void {
    const encoded = JSON.stringify(message);
    if (!context.child.stdin.writable) {
      throw this.handleWriteFailure(context, new Error("Cannot write to codex app-server stdin."));
    }

    try {
      context.child.stdin.write(`${encoded}\n`, (error) => {
        if (error) {
          this.handleWriteFailure(context, error);
        }
      });
    } catch (error) {
      throw this.handleWriteFailure(context, error);
    }
  }

  private emitLifecycleEvent(context: CodexSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "session",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitErrorEvent(context: CodexSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "error",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitNotificationEvent(
    context: CodexSessionContext,
    method: string,
    message: string,
  ): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitEvent(event: ProviderEvent): void {
    this.emit("event", event);
  }

  private assertSupportedCodexCliVersion(input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly homePath?: string;
  }): void {
    assertSupportedCodexCliVersion(input);
  }

  private updateSession(context: CodexSessionContext, updates: Partial<ProviderSession>): void {
    context.session = {
      ...context.session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
  }

  private resolveModelForSessionMetadata(input: {
    readonly requestedModel?: string;
    readonly account: CodexAccountSnapshot;
    readonly models: ReadonlyArray<CodexAppServerModelSnapshot> | null;
  }): string | undefined {
    if (!input.requestedModel) {
      return undefined;
    }

    if (input.account.type === "unknown" && input.requestedModel === CODEX_SPARK_MODEL) {
      return undefined;
    }

    const resolvedModel = resolveCodexModelForAccount(input.requestedModel, input.account);
    if (!resolvedModel) {
      return undefined;
    }

    if (!input.models || input.models.length === 0) {
      return resolvedModel;
    }

    const availableModels = new Set(
      input.models.flatMap((model) => [
        normalizeCodexModelSlug(model.model ?? undefined),
        normalizeCodexModelSlug(model.id ?? undefined),
      ]),
    );
    return availableModels.has(resolvedModel) ? resolvedModel : undefined;
  }

  private readProviderThreadId(context: CodexSessionContext): string | undefined {
    return (
      context.providerThreadId ??
      readResumeThreadId({
        threadId: context.session.threadId,
        runtimeMode: context.session.runtimeMode,
        resumeCursor: context.session.resumeCursor,
      })
    );
  }

  private requestKindForMethod(method: string): ProviderRequestKind | undefined {
    if (method === "item/commandExecution/requestApproval") {
      return "command";
    }

    if (method === "permissions/requestApproval") {
      return "command";
    }

    if (method === "item/fileRead/requestApproval") {
      return "file-read";
    }

    if (method === "item/fileChange/requestApproval") {
      return "file-change";
    }

    return undefined;
  }

  private approvalMethodForRequest(
    method: string,
    requestKind: ProviderRequestKind,
  ): PendingApprovalRequest["method"] {
    if (method === "permissions/requestApproval") {
      return "permissions/requestApproval";
    }

    if (requestKind === "command") {
      return "item/commandExecution/requestApproval";
    }

    if (requestKind === "file-read") {
      return "item/fileRead/requestApproval";
    }

    return "item/fileChange/requestApproval";
  }

  private payloadForServerRequest(method: string, params: unknown): unknown {
    if (method !== "mcpServer/elicitation/request") {
      return params;
    }

    const payload = this.readObject(params);
    return {
      ...payload,
      questions: this.questionsForMcpElicitationRequest(params),
    };
  }

  private questionsForMcpElicitationRequest(params: unknown): Array<{
    id: string;
    header: string;
    question: string;
    options: Array<{ label: string; description: string }>;
  }> {
    const paramsRecord = this.readObject(params) ?? {};
    const message =
      this.readString(paramsRecord, "message") ??
      this.readString(this.readObject(paramsRecord, "params"), "message") ??
      "Provide the requested MCP input.";
    const schema =
      this.readObject(paramsRecord, "requestedSchema") ??
      this.readObject(this.readObject(paramsRecord, "params"), "requestedSchema") ??
      this.readObject(paramsRecord, "schema");
    const properties = this.readObject(schema, "properties");
    const entries = Object.entries(properties ?? {});

    if (entries.length === 0) {
      return [
        {
          id: "response",
          header: "MCP input",
          question: message,
          options: [
            {
              label: "Accept",
              description: "Provide a custom response for this MCP request.",
            },
          ],
        },
      ];
    }

    return entries.map(([id, value]) => {
      const property = this.readObject(value) ?? {};
      const title = this.readString(property, "title") ?? id;
      const description = this.readString(property, "description") ?? message;
      const enumValues =
        this.readArray(property, "enum")
          ?.filter((entry): entry is string => typeof entry === "string")
          .map((entry) => ({
            label: entry,
            description,
          })) ??
        this.readArray(property, "oneOf")?.flatMap((entry) => {
          const option = this.readObject(entry);
          const label = this.readString(option, "title") ?? this.readString(option, "const");
          if (!label) {
            return [];
          }
          return [
            {
              label,
              description: this.readString(option, "description") ?? description,
            },
          ];
        }) ??
        [];
      const options =
        enumValues.length > 0
          ? enumValues
          : [
              {
                label: "Provide value",
                description: "Enter a custom value for this field.",
              },
            ];

      return {
        id,
        header: title,
        question: description,
        options,
      };
    });
  }

  private rejectUnsupportedServerRequest(
    context: CodexSessionContext,
    request: JsonRpcRequest,
  ): void {
    const message = `Unsupported server request: ${request.method}`;
    this.writeMessage(context, {
      id: request.id,
      error: {
        code: -32601,
        message,
      },
    });
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "serverRequest/resolved",
      payload: {
        status: "unsupported",
        reason: message,
        request: {
          method: request.method,
        },
      },
    });
  }

  private userInputResolvedMethod(
    method: PendingUserInputRequest["requestMethod"] | undefined,
  ): "item/tool/requestUserInput/answered" | "tool/requestUserInput/answered" {
    return method === "tool/requestUserInput"
      ? "tool/requestUserInput/answered"
      : "item/tool/requestUserInput/answered";
  }

  private toPlainUserInputAnswers(answers: ProviderUserInputAnswers): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(answers).map(([key, value]) => {
        const answerObject = this.readObject(value);
        const answerList = this.readArray(answerObject, "answers");
        if (answerList?.length === 1) {
          return [key, answerList[0]] as const;
        }
        if (answerList) {
          return [key, answerList] as const;
        }
        return [key, value] as const;
      }),
    );
  }

  private parseThreadSnapshot(method: string, response: unknown): CodexThreadSnapshot {
    const responseRecord = this.readObject(response);
    const thread = this.readObject(responseRecord, "thread");
    const threadIdRaw =
      this.readString(thread, "id") ?? this.readString(responseRecord, "threadId");
    if (!threadIdRaw) {
      throw new Error(`${method} response did not include a thread id.`);
    }
    const turnsRaw =
      this.readArray(thread, "turns") ?? this.readArray(responseRecord, "turns") ?? [];
    const turns = turnsRaw.map((turnValue, index) => {
      const turn = this.readObject(turnValue);
      const turnIdRaw = this.readString(turn, "id") ?? `${threadIdRaw}:turn:${index + 1}`;
      const turnId = TurnId.makeUnsafe(turnIdRaw);
      const items = this.readArray(turn, "items") ?? [];
      return {
        id: turnId,
        items,
      };
    });

    return {
      threadId: threadIdRaw,
      turns,
    };
  }

  private isServerRequest(value: unknown): value is JsonRpcRequest {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.method === "string" &&
      (typeof candidate.id === "string" || typeof candidate.id === "number")
    );
  }

  private isServerNotification(value: unknown): value is JsonRpcNotification {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return typeof candidate.method === "string" && !("id" in candidate);
  }

  private isResponse(value: unknown): value is JsonRpcResponse {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    const hasId = typeof candidate.id === "string" || typeof candidate.id === "number";
    const hasMethod = typeof candidate.method === "string";
    return hasId && !hasMethod;
  }

  private readRouteFields(params: unknown): {
    turnId?: TurnId;
    itemId?: ProviderItemId;
  } {
    const route: {
      turnId?: TurnId;
      itemId?: ProviderItemId;
    } = {};

    const turnId = toTurnId(
      this.readString(params, "turnId") ?? this.readString(this.readObject(params, "turn"), "id"),
    );
    const itemId = toProviderItemId(
      this.readString(params, "itemId") ?? this.readString(this.readObject(params, "item"), "id"),
    );

    if (turnId) {
      route.turnId = turnId;
    }

    if (itemId) {
      route.itemId = itemId;
    }

    return route;
  }

  private readProviderConversationId(params: unknown): string | undefined {
    return (
      this.readString(params, "threadId") ??
      this.readString(this.readObject(params, "thread"), "id") ??
      this.readString(params, "conversationId")
    );
  }

  private readChildRoute(
    context: CodexSessionContext,
    params: unknown,
  ):
    | {
        parentTurnId: TurnId;
        parentItemId?: ProviderItemId;
      }
    | undefined {
    const providerConversationId = this.readProviderConversationId(params);
    if (!providerConversationId) {
      return undefined;
    }
    return context.collabReceiverTurns.get(providerConversationId);
  }

  private attachChildParentItemId(
    params: unknown,
    parentItemId: ProviderItemId | undefined,
  ): unknown {
    if (!parentItemId || !params || typeof params !== "object") {
      return params;
    }

    return {
      ...(params as Record<string, unknown>),
      parentItemId,
    };
  }

  private rememberCollabReceiverTurns(
    context: CodexSessionContext,
    params: unknown,
    parentTurnId: TurnId | undefined,
  ): void {
    if (!parentTurnId) {
      return;
    }
    const payload = this.readObject(params);
    const item = this.readObject(payload, "item") ?? payload;
    const itemType = this.readString(item, "type") ?? this.readString(item, "kind");
    if (itemType !== "collabAgentToolCall") {
      return;
    }
    const parentItemId = toProviderItemId(this.readString(item, "id"));

    const receiverThreadIds =
      this.readArray(item, "receiverThreadIds")
        ?.map((value) => (typeof value === "string" ? value : null))
        .filter((value): value is string => value !== null) ?? [];
    for (const receiverThreadId of receiverThreadIds) {
      context.collabReceiverTurns.set(receiverThreadId, {
        parentTurnId,
        ...(parentItemId ? { parentItemId } : {}),
      });
    }
  }

  private shouldSuppressChildConversationNotification(method: string): boolean {
    return (
      method === "thread/started" ||
      method === "thread/status/changed" ||
      method === "thread/archived" ||
      method === "thread/unarchived" ||
      method === "thread/closed" ||
      method === "thread/compacted" ||
      method === "thread/name/updated" ||
      method === "thread/tokenUsage/updated" ||
      method === "turn/started" ||
      method === "turn/completed" ||
      method === "turn/aborted" ||
      method === "turn/plan/updated" ||
      method === "item/plan/delta"
    );
  }

  private readObject(value: unknown, key?: string): Record<string, unknown> | undefined {
    const target =
      key === undefined
        ? value
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;

    if (!target || typeof target !== "object") {
      return undefined;
    }

    return target as Record<string, unknown>;
  }

  private readArray(value: unknown, key?: string): unknown[] | undefined {
    const target =
      key === undefined
        ? value
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;
    return Array.isArray(target) ? target : undefined;
  }

  private readString(value: unknown, key: string): string | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  }

  private readBoolean(value: unknown, key: string): boolean | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "boolean" ? candidate : undefined;
  }
}

function brandIfNonEmpty<T extends string>(
  value: string | undefined,
  maker: (value: string) => T,
): T | undefined {
  const normalized = value?.trim();
  return normalized?.length ? maker(normalized) : undefined;
}

function normalizeProviderThreadId(value: string | undefined): string | undefined {
  return brandIfNonEmpty(value, (normalized) => normalized);
}

function assertSupportedCodexCliVersion(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly homePath?: string;
}): void {
  const result = spawnSync(input.binaryPath, ["--version"], {
    cwd: input.cwd,
    env: {
      ...process.env,
      ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
    },
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CODEX_VERSION_CHECK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    const lower = result.error.message.toLowerCase();
    if (
      lower.includes("enoent") ||
      lower.includes("command not found") ||
      lower.includes("not found")
    ) {
      throw new Error(`Codex CLI (${input.binaryPath}) is not installed or not executable.`);
    }
    throw new Error(
      `Failed to execute Codex CLI version check: ${result.error.message || String(result.error)}`,
    );
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    const detail = stderr.trim() || stdout.trim() || `Command exited with code ${result.status}.`;
    throw new Error(`Codex CLI version check failed. ${detail}`);
  }

  const parsedVersion = parseCodexCliVersion(`${stdout}\n${stderr}`);
  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    throw new Error(formatCodexCliUpgradeMessage(parsedVersion));
  }
}

function readResumeCursorThreadId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const rawThreadId = (resumeCursor as Record<string, unknown>).threadId;
  return typeof rawThreadId === "string" ? normalizeProviderThreadId(rawThreadId) : undefined;
}

function readResumeThreadId(input: {
  readonly resumeCursor?: unknown;
  readonly threadId?: ThreadId;
  readonly runtimeMode?: RuntimeMode;
}): string | undefined {
  return readResumeCursorThreadId(input.resumeCursor);
}

function toTurnId(value: string | undefined): TurnId | undefined {
  return brandIfNonEmpty(value, TurnId.makeUnsafe);
}

function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return brandIfNonEmpty(value, ProviderItemId.makeUnsafe);
}
