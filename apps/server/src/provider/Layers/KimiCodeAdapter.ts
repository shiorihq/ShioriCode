import { createHash, randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type ExternalTool,
  extractBrief,
  forkSession,
  formatContentOutput,
  parseSessionEvents,
  ProtocolClient,
  type ApprovalRequestPayload,
  type ContentPart,
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
  providerToolTitle,
  summarizeProviderToolInvocation,
} from "shared/providerTool";

import { buildAssistantSettingsAppendix } from "../../assistantPersonality.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { makeKanbanProviderToolRuntime } from "../../kanban/providerTools.ts";
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

const PROVIDER = "kimiCode" as const;
const DEFAULT_MODEL = "kimi-code/kimi-for-coding";
const KIMI_REASONING_ITEM_TITLE = "Reasoning";
const KIMI_ASSISTANT_ITEM_TITLE = "Assistant response";
const DEFAULT_KIMI_MAX_STEPS_PER_TURN = 64;
const DEFAULT_KIMI_MAX_RETRIES_PER_STEP = 2;

type KimiResumeCursor = {
  readonly sessionId: string;
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
  commentaryItemIndex: number;
  toolCallSeen: boolean;
  assistantStarted: boolean;
  assistantCompleted: boolean;
  assistantTextSeen: boolean;
  reasoningStarted: boolean;
  reasoningCompleted: boolean;
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

export function resolveKimiLoopControlFromEnv(env: NodeJS.ProcessEnv = process.env): {
  readonly maxStepsPerTurn: number;
  readonly maxRetriesPerStep: number;
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

function normalizeExternalToolResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  return JSON.stringify(result, null, 2);
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

function parseResumeCursor(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const sessionId = "sessionId" in value ? value.sessionId : undefined;
  return typeof sessionId === "string" && sessionId.trim().length > 0
    ? sessionId.trim()
    : undefined;
}

function buildResumeCursor(sessionId: string): KimiResumeCursor {
  return { sessionId };
}

function appendBufferedKimiText(previous: string, next: string): string {
  return `${previous}${next}`;
}

export function shouldFlushKimiPendingTextAsAssistantAnswer(input: {
  readonly turnFinished: boolean;
  readonly toolCallSeen: boolean;
}): boolean {
  return input.turnFinished || !input.toolCallSeen;
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
    resumeCursor: buildResumeCursor(input.sessionId),
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
    const kanbanRuntime = settings.kanban.enabled
      ? Option.match(orchestrationEngineOption, {
          onSome: (orchestrationEngine) =>
            makeKanbanProviderToolRuntime({
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
      descriptors: [...mcpRuntime.descriptors, ...kanbanRuntime.descriptors],
      executors: new Map([...mcpRuntime.executors, ...kanbanRuntime.executors]),
      warnings: [...mcpRuntime.warnings, ...kanbanRuntime.warnings],
      close: async () => {
        await Promise.allSettled([mcpRuntime.close(), kanbanRuntime.close()]);
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
          const result = await executor.execute(params);
          return {
            output: normalizeExternalToolResult(result),
            message: executor.title,
          };
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
          const result = await executor.execute(params);
          return {
            output: normalizeExternalToolResult(result),
            message: executor.title,
          };
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
    yield* Effect.tryPromise({
      try: () =>
        context.client.start({
          sessionId: context.sessionId,
          workDir: context.workDir,
          ...(context.model ? { model: context.model } : {}),
          thinking: context.thinking,
          yoloMode: context.yoloMode,
          executablePath: context.executablePath,
          externalTools: [...context.externalTools],
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

    const timestamp = nowIso();
    context.session = {
      ...context.session,
      status: "ready",
      ...(context.model ? { model: context.model } : {}),
      resumeCursor: buildResumeCursor(context.sessionId),
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

  const flushPendingAssistantTextAsCommentary = Effect.fn("flushPendingAssistantTextAsCommentary")(
    function* (context: KimiSessionContext, turn: ActiveTurnState) {
      const text = trimOrUndefined(turn.pendingAssistantText);
      turn.pendingAssistantText = "";
      if (!text) {
        return;
      }

      turn.commentaryItemIndex += 1;
      const itemId = `commentary:${turn.turnId}:${turn.commentaryItemIndex}`;
      yield* publish({
        type: "item.completed",
        eventId: nextEventId(),
        provider: PROVIDER,
        threadId: context.session.threadId,
        createdAt: nowIso(),
        turnId: turn.turnId,
        itemId: RuntimeItemId.makeUnsafe(itemId),
        payload: {
          itemType: "assistant_message",
          title: "Status update",
          detail: text,
          data: {
            item: {
              id: itemId,
              phase: "commentary",
              text,
            },
          },
        },
        providerRefs: {
          providerItemId: ProviderItemId.makeUnsafe(itemId),
        },
        raw: rawEvent("ContentPart", {
          type: "text",
          text,
          item: {
            id: itemId,
            phase: "commentary",
            text,
          },
        }),
      });
    },
  );

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
      yield* flushPendingAssistantTextAsCommentary(input.context, input.turn);
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
    const detail =
      trimOrUndefined(extractBrief(input.payload.return_value.display)) ??
      trimOrUndefined(input.payload.return_value.message) ??
      trimOrUndefined(summarizeProviderToolInvocation(toolName, parsedArguments) ?? undefined);

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

    if (!isTextContentPart(payload)) {
      return;
    }

    yield* emitReasoningCompleted(input.context, input.turn);
    input.turn.pendingAssistantText = appendBufferedKimiText(
      input.turn.pendingAssistantText,
      payload.text,
    );
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
    } else {
      yield* flushPendingAssistantTextAsCommentary(input.context, input.turn);
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
        ...(input.result.status === "max_steps_reached" ? { stopReason: "max_steps_reached" } : {}),
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
    } else {
      yield* flushPendingAssistantTextAsCommentary(input.context, input.turn);
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
      try {
        for await (const event of stream.events) {
          await Effect.runPromise(
            handleStreamEvent({
              context,
              turn,
              event,
            }),
          );
        }
        const result = await stream.result;
        await Effect.runPromise(
          completeTurn({
            context,
            turn,
            result,
          }),
        );
      } catch (cause) {
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
      const sessionId = parseResumeCursor(input.resumeCursor) ?? randomUUID();
      const model =
        input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : DEFAULT_MODEL;
      const thinking =
        input.modelSelection?.provider === PROVIDER
          ? input.modelSelection.options?.thinking === true
          : false;
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
      const context: KimiSessionContext = {
        session: buildSession(
          {
            threadId: input.threadId,
            workDir,
            sessionId,
            runtimeMode: input.runtimeMode,
            model,
          },
          timestamp,
        ),
        sessionId,
        client: new ProtocolClient(),
        workDir,
        executablePath,
        shareDir: trimOrUndefined(kimiSettings.shareDir),
        model,
        thinking,
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
        turns: [],
      };

      yield* startClient(context, {
        resumePayload: input.resumeCursor,
      });
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
    const thinking =
      input.modelSelection?.provider === PROVIDER
        ? input.modelSelection.options?.thinking === true
        : context.thinking;
    const yoloMode = context.session.runtimeMode === "full-access";
    const executablePath = yield* prepareKimiExecutable({
      threadId: input.threadId,
      executablePath: trimOrUndefined(kimiSettings.binaryPath) ?? "kimi",
    });
    const shareDir = trimOrUndefined(kimiSettings.shareDir);
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
    const turn: ActiveTurnState = {
      turnId,
      assistantItemId: `assistant:${turnId}`,
      reasoningItemId: `reasoning:${turnId}`,
      items: [],
      toolCalls: new Map(),
      lastToolCallIdByParent: new Map(),
      pendingAssistantText: "",
      commentaryItemIndex: 0,
      toolCallSeen: false,
      assistantStarted: false,
      assistantCompleted: false,
      assistantTextSeen: false,
      reasoningStarted: false,
      reasoningCompleted: false,
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
          resumeCursor: buildResumeCursor(context.sessionId),
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

      const normalizedAnswers: Record<string, string> = {};
      for (const question of pending.questions) {
        const rawAnswer = answers[question.question];
        if (typeof rawAnswer === "string" && rawAnswer.trim().length > 0) {
          normalizedAnswers[question.question] = rawAnswer.trim();
          continue;
        }
        if (Array.isArray(rawAnswer)) {
          const joined = rawAnswer
            .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
            .filter((entry) => entry.length > 0)
            .join(", ");
          if (joined.length > 0) {
            normalizedAnswers[question.question] = joined;
          }
        }
      }

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
      context.session = {
        ...context.session,
        status: "ready",
        resumeCursor: buildResumeCursor(nextSessionId),
        updatedAt: nowIso(),
        lastError: undefined,
      };
      context.agentFilePath = resources.agentFilePath;
      context.externalTools = resources.externalTools;
      context.toolRuntime = resources.toolRuntime;

      yield* startClient(context, {
        emitLifecycle: true,
        resumePayload: buildResumeCursor(nextSessionId),
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
