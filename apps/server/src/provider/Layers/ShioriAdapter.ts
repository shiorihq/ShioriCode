// @effect-diagnostics anyUnknownInErrorContext:off
// @effect-diagnostics tryCatchInEffectGen:off
// @effect-diagnostics unnecessaryFailYieldableError:off
// @effect-diagnostics runEffectInsideEffect:off
import { readFile } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
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
  RuntimeItemId,
  RuntimeRequestId,
  type ShioriModelOptions,
  type AssistantPersonality,
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
import { Effect, Layer, PubSub, Ref, Schema, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { buildAssistantPersonalityAppendix } from "../../assistantPersonality.ts";
import { ServerConfig } from "../../config.ts";
import { HostedShioriAuthTokenStore } from "../../hostedShioriAuthTokenStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { WorkspaceEntries } from "../../workspace/Services/WorkspaceEntries.ts";
import {
  buildProviderMcpToolRuntime,
  type ProviderMcpToolExecutor,
  type ProviderMcpToolRuntime,
} from "../mcpServers.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { ShioriAdapter } from "../Services/ShioriAdapter.ts";
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
    "Use only the tools actually exposed in this session.",
    "If local tools such as exec_command, read_file, write_file, or apply_patch are available, treat them as real capabilities of your current environment.",
    "Do not claim you lack local machine, workspace, file, or browser-launch access when an available tool can perform the action.",
    "Do not describe a limitation unless it is supported by the actual tool surface or by an observed tool failure.",
    "",
    "## Tool Grounding",
    "Ground every claim about commands, file changes, browser launches, and tool availability in actual tool results from this session.",
    "Never contradict a successful tool call.",
    "If a browser-opening command such as open, start, or xdg-open exits with code 0 and does not report an error, treat the open request as completed.",
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
    "## Browser And Desktop Actions",
    "If the user asks to open a file, URL, app, or browser page and a local tool can do it, do the action instead of claiming you cannot.",
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
  readonly interactionMode?: "default" | "plan" | undefined;
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
  const personalityAppendix = buildAssistantPersonalityAppendix(input.personality);

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
    ...(personalityAppendix ? [personalityAppendix] : []),
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

export type ApprovalRequestKind = "command" | "file-read" | "file-change";

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
};

interface ActiveTurnState {
  readonly turnId: TurnId;
  readonly controller: AbortController;
  readonly assistantItemId: RuntimeItemId;
  readonly interactionMode: "default" | "plan";
  readonly mcpToolDescriptors: ReadonlyArray<HostedToolDescriptor>;
  readonly mcpTools: ReadonlyMap<string, ProviderMcpToolExecutor>;
  readonly closeMcpTools: () => Promise<void>;
  readonly modelSettings?: HostedShioriModelSettings | undefined;
  assistantText: string;
  assistantStarted: boolean;
  reasoningBlocks: Map<
    string,
    {
      itemId: RuntimeItemId;
      text: string;
      providerMetadata: ProviderMetadata | undefined;
      completed: boolean;
      includedInHistory: boolean;
    }
  >;
  reasoningBlockOrder: string[];
}

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

interface ShioriSessionContext {
  session: ProviderSession;
  messages: HostedShioriMessage[];
  turns: ShioriTurnState[];
  activeTurn: ActiveTurnState | null;
  pendingApprovals: Map<ApprovalRequestId, PendingToolCall>;
  pendingUserInputs: Map<ApprovalRequestId, PendingToolCall>;
  allowedRequestKinds: Set<ApprovalRequestKind>;
}

export interface ShioriAdapterLiveOptions {
  readonly buildMcpToolRuntime?: (input: {
    readonly provider: "shiori";
    readonly servers: ReadonlyArray<McpServerEntry>;
    readonly cwd?: string;
  }) => Promise<ProviderMcpToolRuntime>;
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

function describeToken(token: string | null | undefined) {
  return {
    present: typeof token === "string",
    jwtLike: isJwtLikeToken(token),
  };
}

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
  return assistantMessageWithParts({
    messageId: input.messageId,
    text: input.text,
    ...(input.reasoningParts ? { reasoningParts: input.reasoningParts } : {}),
    extraParts: [toolPart],
  });
}

export function toolRequestKind(toolName: string): ApprovalRequestKind | undefined {
  switch (toolName) {
    case "exec_command":
      return "command";
    case "list_directory":
    case "read_file":
      return "file-read";
    case "write_file":
    case "apply_patch":
      return "file-change";
    default:
      return undefined;
  }
}

export function buildHostedToolDescriptors(input: HostedToolContext): HostedToolDescriptor[] {
  const runtimeMode = input.session.runtimeMode;
  const requiresApproval = (kind: ApprovalRequestKind) =>
    runtimeMode !== "full-access" && !input.allowedRequestKinds.has(kind);

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
        "x-shioricode-needs-approval": requiresApproval("file-read"),
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
        "x-shioricode-needs-approval": requiresApproval("file-read"),
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
        "x-shioricode-needs-approval": requiresApproval("file-change"),
      },
    },
    {
      name: "apply_patch",
      title: "Apply patch",
      description: "Apply a unified diff patch inside the workspace git checkout.",
      inputSchema: {
        type: "object",
        properties: {
          patch: { type: "string", description: "Unified diff patch text." },
        },
        required: ["patch"],
        additionalProperties: false,
        "x-shioricode-request-kind": "file-change",
        "x-shioricode-needs-approval": requiresApproval("file-change"),
      },
    },
    {
      name: "exec_command",
      title: "Execute command",
      description: "Run a shell command inside the local workspace.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run." },
        },
        required: ["command"],
        additionalProperties: false,
        "x-shioricode-request-kind": "command",
        "x-shioricode-needs-approval": requiresApproval("command"),
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
    descriptors.push(...input.mcpToolDescriptors);
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

function encodeResumeCursor(
  messages: ReadonlyArray<HostedShioriMessage>,
  turns: ReadonlyArray<ShioriTurnState>,
): ShioriResumeCursor {
  const sanitizedMessages = messages
    .map(stripMessageForResume)
    .filter((message): message is HostedShioriMessage => message !== null);

  const defaultSliceStart = Math.max(0, sanitizedMessages.length - MAX_PERSISTED_MESSAGES);
  const sliceStart =
    turns.length === 0
      ? defaultSliceStart
      : turns.reduce((currentStart, turn, index) => {
          const previousMessageCount = index === 0 ? 0 : (turns[index - 1]?.messageCount ?? 0);
          return sanitizedMessages.length - previousMessageCount <= MAX_PERSISTED_MESSAGES
            ? previousMessageCount
            : currentStart;
        }, defaultSliceStart);

  return {
    messages: sanitizedMessages.slice(sliceStart),
    turns: turns.flatMap((turn) =>
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
  };
}

function decodeResumeCursor(value: unknown): {
  readonly messages: HostedShioriMessage[];
  readonly turns: ShioriTurnState[];
} {
  if (!value || typeof value !== "object") {
    return {
      messages: [],
      turns: [],
    };
  }
  const messages = (value as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return {
      messages: [],
      turns: [],
    };
  }

  const decodedMessages = messages.flatMap((message) => {
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

  return {
    messages: decodedMessages,
    turns: decodedTurns,
  };
}

function computeResumeCursor(
  messages: ReadonlyArray<HostedShioriMessage>,
  turns: ReadonlyArray<ShioriTurnState>,
): ShioriResumeCursor | undefined {
  const resumeCursor = encodeResumeCursor(messages, turns);
  return resumeCursor.messages.length > 0 || resumeCursor.turns.length > 0
    ? resumeCursor
    : undefined;
}

function withResumeCursor(context: ShioriSessionContext): ShioriSessionContext {
  const resumeCursor = computeResumeCursor(context.messages, context.turns);
  const { resumeCursor: _resumeCursor, ...sessionWithoutCursor } = context.session;

  return {
    ...context,
    session: {
      ...sessionWithoutCursor,
      ...(resumeCursor ? { resumeCursor } : {}),
    },
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
      killChildProcessTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        killChildProcessTree(child, "SIGKILL");
      }, 1_000);
    }, LOCAL_TOOL_COMMAND_TIMEOUT_MS);

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
      killChildProcessTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        killChildProcessTree(child, "SIGKILL");
      }, 1_000);
      finalize(() => {
        reject(new Error("Interrupted"));
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code) => {
      finalize(() => {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0,
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
  return record;
}

function buildUserMessageText(input: ProviderSendTurnInput): string {
  return input.input?.trim() ?? "";
}

function buildAssistantCompletionEvent(input: {
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
      ...(input.detail.trim().length > 0 ? { detail: input.detail } : {}),
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
  assistantItemId: RuntimeItemId;
  assistantStarted: boolean;
  openReasoningItemIds: ReadonlyArray<RuntimeItemId>;
  assistantText: string;
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

  if (input.assistantStarted) {
    events.push(
      buildAssistantCompletionEvent({
        threadId: input.threadId,
        turnId: input.turnId,
        itemId: input.assistantItemId,
        detail: input.assistantText,
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

function runtimeItemTypeForTool(
  toolName: string,
): "command_execution" | "file_change" | "dynamic_tool_call" {
  switch (toolName) {
    case "exec_command":
      return "command_execution";
    case "write_file":
    case "apply_patch":
      return "file_change";
    default:
      return "dynamic_tool_call";
  }
}

function toolTitle(toolName: string): string {
  switch (toolName) {
    case "exec_command":
      return "Run command";
    case "list_directory":
      return "List directory";
    case "read_file":
      return "Read file";
    case "write_file":
      return "Write file";
    case "apply_patch":
      return "Apply patch";
    case "ask_user":
      return "Ask user";
    default:
      return toolName;
  }
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
    if (!block || block.text.trim().length === 0) {
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

function takeUnconsumedReasoningBlockIds(activeTurn: ActiveTurnState): string[] {
  const selected: string[] = [];
  for (const blockId of activeTurn.reasoningBlockOrder) {
    const block = activeTurn.reasoningBlocks.get(blockId);
    if (!block || block.includedInHistory || block.text.trim().length === 0) {
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
      const directory = yield* ProviderSessionDirectory;
      const workspaceEntries = yield* WorkspaceEntries;
      const sessionsRef = yield* Ref.make(new Map<string, ShioriSessionContext>());
      const finalizedTurnIdsRef = yield* Ref.make(new Set<string>());
      const eventsPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

      const emit = (event: ProviderRuntimeEvent) =>
        PubSub.publish(eventsPubSub, event).pipe(Effect.asVoid);

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
            ...(computeResumeCursor(context.messages, context.turns)
              ? { resumeCursor: computeResumeCursor(context.messages, context.turns) }
              : {}),
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
      }) =>
        emit({
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
            decision: input.decision,
          },
        } satisfies ProviderRuntimeEvent);

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
            assistantItemId: activeTurn.assistantItemId,
            assistantStarted: activeTurn.assistantStarted,
            openReasoningItemIds: activeTurn.reasoningBlockOrder.flatMap((blockId) => {
              const block = activeTurn.reasoningBlocks.get(blockId);
              return block && !block.completed ? [block.itemId] : [];
            }),
            assistantText: activeTurn.assistantText,
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
                  : undefined),
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

      const executeLocalToolForTurn = Effect.fn("executeLocalToolForTurn")(function* (input: {
        toolName: string;
        toolInput: Record<string, unknown>;
        cwd: string | undefined;
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
          case "apply_patch": {
            const patchText =
              typeof input.toolInput.patch === "string" ? input.toolInput.patch : "";
            const result = yield* Effect.tryPromise({
              try: () => applyUnifiedPatch(patchText, input.cwd ?? process.cwd(), input.signal),
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
              try: () => execShellCommand(command, input.cwd ?? process.cwd(), input.signal),
              catch: (error) =>
                requestError(`shiori.tool.${input.toolName}`, "Failed to run command.", error),
            });
            return sanitizeToolOutput(input.toolName, result);
          }
          default:
            return yield* requestError(
              `shiori.tool.${input.toolName}`,
              `Unsupported Shiori tool '${input.toolName}'.`,
            );
        }
      });

      const replaceMessageInContext = (
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
        const tools = buildHostedToolDescriptors({
          ...input.context,
          interactionMode,
          mcpToolDescriptors: input.context.activeTurn?.mcpToolDescriptors ?? [],
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
              interactionMode,
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
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(`${apiBaseUrl}/api/shiori-code/agent/stream`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(requestBody)),
                "X-Convex-Auth-Token": input.authToken,
                "X-Shiori-Client": "electron",
                "User-Agent": "ShioriCode-macOS/1.0",
              },
              body: Buffer.from(requestBody, "utf8"),
              signal: input.controller.signal,
            }),
          catch: (error) =>
            requestError(
              `shiori.turn.start:${String(input.context.session.threadId)}`,
              toMessage(error),
              error,
            ),
        });

        if (!response.ok || !response.body) {
          const detail = yield* Effect.tryPromise({
            try: async () => {
              const text = await response.text();
              return text.trim().length > 0
                ? text
                : `Shiori API returned ${response.status} ${response.statusText}`.trim();
            },
            catch: (error) =>
              requestError(
                `shiori.turn.start:${String(input.context.session.threadId)}`,
                `Shiori API returned ${response.status}.`,
                error,
              ),
          });
          yield* Effect.logWarning("shiori turn request failed", {
            threadId: input.context.session.threadId,
            turnId: input.turnId,
            status: response.status,
            statusText: response.statusText,
            detail,
          });
          return yield* Effect.fail(
            requestError(`shiori.turn.start:${String(input.context.session.threadId)}`, detail),
          );
        }

        yield* Effect.logInfo("shiori turn request accepted", {
          threadId: input.context.session.threadId,
          turnId: input.turnId,
          status: response.status,
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

        const reader = parseJsonEventStream({
          stream: response.body,
          schema: uiMessageChunkSchema,
        }).getReader();

        let assistantText = "";
        let assistantCompletionText = input.context.activeTurn?.assistantText ?? "";
        let assistantStarted = input.context.activeTurn?.assistantStarted ?? false;

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
            });
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
                if (interactionMode === "plan") {
                  break;
                }
                if (!assistantStarted) {
                  assistantStarted = true;
                  if (input.context.activeTurn) {
                    input.context.activeTurn.assistantStarted = true;
                  }
                  yield* emit({
                    ...runtimeEventBase({
                      threadId: input.context.session.threadId,
                      turnId: input.turnId,
                      itemId: input.assistantItemId,
                    }),
                    type: "item.started",
                    payload: {
                      itemType: "assistant_message",
                      status: "inProgress",
                      title: "Assistant message",
                    },
                  } satisfies ProviderRuntimeEvent);
                }
                break;
              }
              case "text-delta": {
                assistantText += chunk.delta;
                assistantCompletionText += chunk.delta;
                if (input.context.activeTurn) {
                  input.context.activeTurn.assistantText = assistantCompletionText;
                }
                if (interactionMode === "plan") {
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
                yield* emit({
                  ...runtimeEventBase({
                    threadId: input.context.session.threadId,
                    turnId: input.turnId,
                    itemId: input.assistantItemId,
                  }),
                  type: "content.delta",
                  payload: {
                    streamKind: "assistant_text",
                    delta: chunk.delta,
                  },
                } satisfies ProviderRuntimeEvent);
                break;
              }
              case "reasoning-start": {
                if (input.context.activeTurn) {
                  const block = ensureReasoningBlock(input.context.activeTurn, chunk.id);
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
                break;
              }
              case "reasoning-delta": {
                if (input.context.activeTurn) {
                  const block = ensureReasoningBlock(input.context.activeTurn, chunk.id);
                  block.text += chunk.delta;
                  if (chunk.providerMetadata !== undefined) {
                    block.providerMetadata = chunk.providerMetadata;
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
                  if (block.completed) {
                    break;
                  }
                  block.completed = true;
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
                const toolName = chunk.toolName;
                const toolInput =
                  chunk.input && typeof chunk.input === "object" && !Array.isArray(chunk.input)
                    ? (chunk.input as Record<string, unknown>)
                    : {};
                const requestKind = toolRequestKind(toolName);
                const mcpTool = input.context.activeTurn?.mcpTools.get(toolName);
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const approvalRequired =
                  mcpTool === undefined &&
                  requestKind !== undefined &&
                  input.context.session.runtimeMode !== "full-access" &&
                  !input.context.allowedRequestKinds.has(requestKind);
                const assistantMessageId = `assistant-tool:${chunk.toolCallId}`;
                const reasoningBlockIds =
                  input.context.activeTurn !== null
                    ? takeUnconsumedReasoningBlockIds(input.context.activeTurn)
                    : [];
                const reasoningParts =
                  input.context.activeTurn && reasoningBlockIds.length > 0
                    ? buildReasoningPartsForBlockIds(input.context.activeTurn, reasoningBlockIds)
                    : undefined;

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
                    return;
                  }

                  yield* emit({
                    ...runtimeEventBase({
                      threadId: input.context.session.threadId,
                      turnId: input.turnId,
                    }),
                    type: "turn.plan.updated",
                    payload: planUpdate,
                  } satisfies ProviderRuntimeEvent);

                  const completedMessage = assistantToolMessage({
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
                  });
                  const resumedContext = withResumeCursor({
                    ...input.context,
                    messages: [...input.requestMessages, completedMessage],
                  });
                  yield* setContext(input.context.session.threadId, resumedContext);
                  yield* persistContext(resumedContext);
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
                    return;
                  }
                  return yield* runHostedTurn({
                    ...input,
                    context: refreshedContext,
                    requestMessages: refreshedContext.messages,
                    controller: continuedController,
                    resumeExistingTurn: true,
                  });
                }

                yield* emitToolStarted({
                  threadId: input.context.session.threadId,
                  turnId: input.turnId,
                  toolName,
                  toolCallId: chunk.toolCallId,
                  toolInput,
                  ...(mcpTool ? { title: mcpTool.title } : {}),
                });
                const pendingMessage = assistantToolMessage({
                  messageId: assistantMessageId,
                  text: assistantCompletionText,
                  ...(reasoningParts ? { reasoningParts } : {}),
                  toolName,
                  toolCallId: chunk.toolCallId,
                  toolInput,
                  state: approvalRequired ? "approval-requested" : "input-available",
                  ...(approvalRequired ? { approvalId: requestId } : {}),
                  ...(chunk.providerMetadata !== undefined
                    ? { callProviderMetadata: chunk.providerMetadata }
                    : {}),
                });

                const nextContext = withResumeCursor({
                  ...input.context,
                  messages: [...input.requestMessages, pendingMessage],
                  pendingApprovals: new Map(input.context.pendingApprovals),
                  pendingUserInputs: new Map(input.context.pendingUserInputs),
                });

                if (isUserInputToolName(toolName)) {
                  nextContext.pendingUserInputs.set(requestId, {
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
                  yield* setContext(input.context.session.threadId, nextContext);
                  yield* persistContext(nextContext);
                  yield* emitUserInputRequest({
                    threadId: input.context.session.threadId,
                    turnId: input.turnId,
                    requestId,
                    toolInput,
                  });
                  return;
                }

                if (approvalRequired && requestKind) {
                  nextContext.pendingApprovals.set(requestId, {
                    requestId,
                    toolCallId: chunk.toolCallId,
                    toolName,
                    input: toolInput,
                    assistantMessageId,
                    approvalId: requestId,
                    requestKind,
                    ...(reasoningBlockIds.length > 0 ? { reasoningBlockIds } : {}),
                    ...(chunk.providerMetadata !== undefined
                      ? { callProviderMetadata: chunk.providerMetadata }
                      : {}),
                  });
                  yield* setContext(input.context.session.threadId, nextContext);
                  yield* persistContext(nextContext);
                  yield* emitApprovalRequest({
                    threadId: input.context.session.threadId,
                    turnId: input.turnId,
                    requestId,
                    toolName,
                    toolInput,
                    requestKind,
                  });
                  return;
                }

                const execution = mcpTool
                  ? yield* Effect.tryPromise({
                      try: async () => ({
                        state: "output-available" as const,
                        output: await mcpTool.execute(toolInput),
                      }),
                      catch: (error) => ({
                        state: "output-error" as const,
                        errorText: toMessage(error) || `MCP tool '${toolName}' failed.`,
                      }),
                    })
                  : yield* executeLocalToolForTurn({
                      toolName,
                      toolInput,
                      cwd: input.context.session.cwd,
                      signal: input.controller.signal,
                    });
                const completedMessage = assistantToolMessage({
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
                });
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
                          : toolTitle(toolName),
                  data:
                    execution.state === "output-available"
                      ? execution.output
                      : { errorText: execution.errorText },
                });
                const resumedContext = withResumeCursor({
                  ...input.context,
                  messages: [...input.requestMessages, completedMessage],
                });
                yield* setContext(input.context.session.threadId, resumedContext);
                yield* persistContext(resumedContext);
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
                  return;
                }
                return yield* runHostedTurn({
                  ...input,
                  context: refreshedContext,
                  requestMessages: refreshedContext.messages,
                  controller: continuedController,
                  resumeExistingTurn: true,
                });
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
                yield* Effect.logWarning("shiori stream emitted error chunk", {
                  threadId: input.context.session.threadId,
                  turnId: input.turnId,
                  errorText: chunk.errorText,
                });
                return yield* Effect.fail(
                  requestError(
                    `shiori.turn.start:${String(input.context.session.threadId)}`,
                    chunk.errorText,
                  ),
                );
              }
              default:
                break;
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
          } else if (assistantStarted) {
            yield* emit(
              buildAssistantCompletionEvent({
                threadId: input.context.session.threadId,
                turnId: input.turnId,
                itemId: input.assistantItemId,
                detail: assistantCompletionText,
              }),
            );
          }

          const assistantMessage = assistantMessageWithParts({
            messageId: `assistant-${String(input.turnId)}`,
            text: assistantText,
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
            assistantChars: assistantText.length,
          });
          const finalizedMessages = hasMessageParts(assistantMessage)
            ? [...input.requestMessages, assistantMessage]
            : input.requestMessages;

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

          yield* updateContext(input.context.session.threadId, (context) =>
            withResumeCursor({
              ...context,
              activeTurn: null,
              session: {
                ...context.session,
                status: "ready",
                updatedAt: nowIso(),
                ...(aborted ? {} : { lastError: detail }),
              },
            }),
          );
          const updatedContext = yield* getContext(input.context.session.threadId);
          yield* persistContext(updatedContext);

          if (aborted && !alreadyFinalized) {
            yield* markTurnFinalized(input.turnId);
            yield* Effect.forEach(
              buildInterruptedTurnEvents({
                threadId: input.context.session.threadId,
                turnId: input.turnId,
                assistantItemId: input.assistantItemId,
                assistantStarted,
                openReasoningItemIds:
                  input.context.activeTurn !== null
                    ? input.context.activeTurn.reasoningBlockOrder.flatMap((blockId) => {
                        const block = input.context.activeTurn?.reasoningBlocks.get(blockId);
                        return block && !block.completed ? [block.itemId] : [];
                      })
                    : [],
                assistantText,
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
            catch: (error) => error,
          }).pipe(Effect.ignore({ log: false }));
        }
      });

      return {
        provider: PROVIDER,
        capabilities: {
          sessionModelSwitch: "restart-session",
        },
        startSession: (input) => {
          const providerError = ensureProvider("startSession", input.provider);
          if (providerError) {
            return Effect.fail(providerError);
          }

          const now = nowIso();
          const restoredState = decodeResumeCursor(input.resumeCursor);
          const restoredResumeCursor = computeResumeCursor(
            restoredState.messages,
            restoredState.turns,
          );
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            threadId: input.threadId,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
            ...(restoredResumeCursor ? { resumeCursor: restoredResumeCursor } : {}),
            createdAt: now,
            updatedAt: now,
          };
          const context: ShioriSessionContext = {
            session,
            messages: restoredState.messages,
            turns: restoredState.turns,
            activeTurn: null,
            pendingApprovals: new Map(),
            pendingUserInputs: new Map(),
            allowedRequestKinds: new Set(),
          };
          return Ref.update(sessionsRef, (sessions) => {
            const next = new Map(sessions);
            next.set(String(input.threadId), context);
            return next;
          }).pipe(Effect.as(session));
        },
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
            if (!isJwtLikeToken(authToken)) {
              return yield* Effect.fail(
                requestError(
                  `shiori.turn.start:${String(input.threadId)}`,
                  "Shiori account token is unavailable or invalid. Sign out and sign back in to continue.",
                ),
              );
            }

            const selectedModel =
              input.modelSelection?.provider === PROVIDER
                ? input.modelSelection.model
                : (context.session.model ?? "openai/gpt-5.4");
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
            const requestMessages = [...context.messages, userMessage];
            const turnId = TurnId.makeUnsafe(crypto.randomUUID());
            const assistantItemId = RuntimeItemId.makeUnsafe(
              `${SHIORI_ASSISTANT_ITEM_PREFIX}:${String(turnId)}`,
            );
            const controller = new AbortController();
            const currentSettings = yield* serverSettings.getSettings.pipe(
              Effect.mapError((error) =>
                requestError(
                  `shiori.turn.start:${String(input.threadId)}`,
                  "Failed to load server settings.",
                  error,
                ),
              ),
            );
            const mcpToolRuntime = yield* Effect.tryPromise({
              try: () =>
                (options?.buildMcpToolRuntime ?? buildProviderMcpToolRuntime)({
                  provider: PROVIDER,
                  servers: currentSettings.mcpServers.servers,
                  ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
                }),
              catch: (error) =>
                requestError(
                  `shiori.turn.start:${String(input.threadId)}`,
                  "Failed to initialize MCP servers for Shiori.",
                  error,
                ),
            });
            for (const warning of mcpToolRuntime.warnings) {
              yield* Effect.logWarning("shiori mcp runtime warning", {
                threadId: input.threadId,
                warning,
              });
            }

            const runningContext = withResumeCursor({
              ...context,
              messages: requestMessages,
              activeTurn: {
                turnId,
                controller,
                assistantItemId,
                interactionMode: input.interactionMode ?? "default",
                mcpToolDescriptors: mcpToolRuntime.descriptors,
                mcpTools: mcpToolRuntime.executors,
                closeMcpTools: mcpToolRuntime.close,
                ...(modelSettings ? { modelSettings } : {}),
                assistantText: "",
                assistantStarted: false,
                reasoningBlocks: new Map(),
                reasoningBlockOrder: [],
              },
              session: {
                ...context.session,
                model: selectedModel,
                status: "running",
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
              ...(computeResumeCursor(requestMessages, context.turns)
                ? { resumeCursor: computeResumeCursor(requestMessages, context.turns) }
                : {}),
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
            void Effect.runFork(background);

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

            context.pendingApprovals.delete(requestId);
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

            if (decision === "acceptForSession" && pending.requestKind) {
              context.allowedRequestKinds.add(pending.requestKind);
            }

            const execution =
              decision === "decline"
                ? { state: "output-denied" as const }
                : yield* Effect.gen(function* () {
                    const attempt = yield* Effect.result(
                      executeLocalToolForTurn({
                        toolName: pending.toolName,
                        toolInput: pending.input,
                        cwd: context.session.cwd,
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

            const nextMessage = assistantToolMessage({
              messageId: pending.assistantMessageId,
              text: context.activeTurn.assistantText,
              ...(pending.reasoningBlockIds && pending.reasoningBlockIds.length > 0
                ? {
                    reasoningParts: buildReasoningPartsForBlockIds(
                      context.activeTurn,
                      pending.reasoningBlockIds,
                    ),
                  }
                : {}),
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

            const updatedContext = yield* replaceMessageInContext(
              threadId,
              pending.assistantMessageId,
              nextMessage,
            );
            if (context.activeTurn.controller.signal.aborted) {
              yield* finalizeInterruptedTurn(yield* getContext(threadId));
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
            const continuedAuthToken = yield* hostedAuthTokenStore.getToken;
            if (!isJwtLikeToken(continuedAuthToken)) {
              const detail =
                "Shiori account token is unavailable or invalid. Sign out and sign back in to continue.";
              yield* failTurn({
                context: continuedContext,
                detail,
              });
              return yield* Effect.fail(requestError("shiori.respondToRequest", detail));
            }
            void Effect.runFork(
              runHostedTurn({
                context: continuedContext,
                turnId: context.activeTurn.turnId,
                requestMessages: updatedContext.messages,
                selectedModel: context.session.model ?? "openai/gpt-5.4",
                authToken: continuedAuthToken,
                controller: continuedController,
                assistantItemId: context.activeTurn.assistantItemId,
                resumeExistingTurn: true,
              }),
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
            context.pendingUserInputs.delete(requestId);
            yield* emitUserInputResolved({
              threadId,
              turnId: context.activeTurn.turnId,
              requestId,
              answers,
            });
            const output = {
              answers,
            };
            const nextMessage = assistantToolMessage({
              messageId: pending.assistantMessageId,
              text: context.activeTurn.assistantText,
              ...(pending.reasoningBlockIds && pending.reasoningBlockIds.length > 0
                ? {
                    reasoningParts: buildReasoningPartsForBlockIds(
                      context.activeTurn,
                      pending.reasoningBlockIds,
                    ),
                  }
                : {}),
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
            const updatedContext = yield* replaceMessageInContext(
              threadId,
              pending.assistantMessageId,
              nextMessage,
            );
            if (context.activeTurn.controller.signal.aborted) {
              yield* finalizeInterruptedTurn(yield* getContext(threadId));
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
            const continuedAuthToken = yield* hostedAuthTokenStore.getToken;
            if (!isJwtLikeToken(continuedAuthToken)) {
              const detail =
                "Shiori account token is unavailable or invalid. Sign out and sign back in to continue.";
              yield* failTurn({
                context: continuedContext,
                detail,
              });
              return yield* Effect.fail(requestError("shiori.respondToUserInput", detail));
            }
            void Effect.runFork(
              runHostedTurn({
                context: continuedContext,
                turnId: context.activeTurn.turnId,
                requestMessages: updatedContext.messages,
                selectedModel: context.session.model ?? "openai/gpt-5.4",
                authToken: continuedAuthToken,
                controller: continuedController,
                assistantItemId: context.activeTurn.assistantItemId,
                resumeExistingTurn: true,
              }),
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
                const resumeCursor = computeResumeCursor(context.messages, context.turns);
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
