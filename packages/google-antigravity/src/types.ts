import { readFileSync } from "node:fs";
import { extname } from "node:path";

export const DEFAULT_MODEL = "gemini-3.5-flash";
export const DEFAULT_IMAGE_GENERATION_MODEL = "gemini-3.1-flash-image-preview";

export enum ThinkingLevel {
  MINIMAL = "minimal",
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
}

export type GenerationConfigInit = {
  thinkingLevel?: ThinkingLevel | string;
  thinking_level?: ThinkingLevel | string;
};

export type ModelEntryInit = {
  name: string;
  apiKey?: string;
  api_key?: string;
  generation?: GenerationConfig | GenerationConfigInit;
};

export type ModelConfigInit = {
  default?: string | ModelEntry | ModelEntryInit;
  imageGeneration?: string | ModelEntry | ModelEntryInit;
  image_generation?: string | ModelEntry | ModelEntryInit;
};

export type GeminiConfigInit = {
  apiKey?: string;
  api_key?: string;
  vertex?: boolean;
  project?: string;
  location?: string;
  models?: ModelConfig | ModelConfigInit;
};

function validateThinkingLevel(
  value: ThinkingLevel | string | undefined,
): ThinkingLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Object.values(ThinkingLevel).includes(value as ThinkingLevel)) {
    return value as ThinkingLevel;
  }
  throw new Error(`Unsupported ThinkingLevel: '${value}'.`);
}

export class GenerationConfig {
  thinkingLevel?: ThinkingLevel;

  constructor(init: GenerationConfigInit = {}) {
    this.thinkingLevel = validateThinkingLevel(init.thinkingLevel ?? init.thinking_level);
  }

  get thinking_level(): ThinkingLevel | undefined {
    return this.thinkingLevel;
  }

  set thinking_level(value: ThinkingLevel | string | undefined) {
    this.thinkingLevel = validateThinkingLevel(value);
  }

  toJSON(): { thinking_level?: ThinkingLevel } {
    return {
      thinking_level: this.thinkingLevel,
    };
  }
}

export class ModelEntry {
  name: string;
  apiKey?: string;
  generation: GenerationConfig;

  constructor(init: string | ModelEntryInit) {
    if (typeof init === "string") {
      this.name = init;
      this.generation = new GenerationConfig();
      return;
    }
    if (init.name === undefined || init.name === null) {
      throw new Error("ModelEntry.name is required.");
    }
    this.name = init.name;
    this.apiKey = init.apiKey ?? init.api_key;
    this.generation = new GenerationConfig(init.generation);
  }

  get api_key(): string | undefined {
    return this.apiKey;
  }

  set api_key(value: string | undefined) {
    this.apiKey = value;
  }

  toJSON(): {
    name: string;
    api_key?: string;
    generation: ReturnType<GenerationConfig["toJSON"]>;
  } {
    return {
      name: this.name,
      api_key: this.apiKey,
      generation: this.generation.toJSON(),
    };
  }
}

export class ModelConfig {
  #defaultExplicit: boolean;
  default: ModelEntry;
  imageGeneration: ModelEntry;

  constructor(init: ModelConfigInit = {}) {
    const imageGeneration = init.imageGeneration ?? init.image_generation;
    this.#defaultExplicit =
      init instanceof ModelConfig ? init.defaultExplicit : init.default !== undefined;
    this.default =
      typeof init.default === "string"
        ? new ModelEntry(init.default)
        : init.default
          ? new ModelEntry(init.default)
          : new ModelEntry(DEFAULT_MODEL);
    this.imageGeneration =
      typeof imageGeneration === "string"
        ? new ModelEntry(imageGeneration)
        : imageGeneration
          ? new ModelEntry(imageGeneration)
          : new ModelEntry(DEFAULT_IMAGE_GENERATION_MODEL);
  }

  get defaultExplicit(): boolean {
    return this.#defaultExplicit;
  }

  get image_generation(): ModelEntry {
    return this.imageGeneration;
  }

  set image_generation(value: string | ModelEntry | ModelEntryInit) {
    this.imageGeneration =
      typeof value === "string" ? new ModelEntry(value) : new ModelEntry(value);
  }

  toJSON(): {
    default: ReturnType<ModelEntry["toJSON"]>;
    image_generation: ReturnType<ModelEntry["toJSON"]>;
  } {
    return {
      default: this.default.toJSON(),
      image_generation: this.imageGeneration.toJSON(),
    };
  }
}

export class GeminiConfig {
  apiKey?: string;
  vertex = false;
  project?: string;
  location?: string;
  models: ModelConfig;

  constructor(init: GeminiConfigInit = {}) {
    this.apiKey = init.apiKey ?? init.api_key;
    this.vertex = init.vertex ?? false;
    this.project = init.project;
    this.location = init.location;
    this.models = new ModelConfig(init.models);
  }

  get api_key(): string | undefined {
    return this.apiKey;
  }

  set api_key(value: string | undefined) {
    this.apiKey = value;
  }

  toJSON(): {
    api_key?: string;
    vertex: boolean;
    project?: string;
    location?: string;
    models: ReturnType<ModelConfig["toJSON"]>;
  } {
    return {
      api_key: this.apiKey,
      vertex: this.vertex,
      project: this.project,
      location: this.location,
      models: this.models.toJSON(),
    };
  }
}

export class SystemInstructionSection {
  content: string;
  title: string;

  constructor(init: { content: string; title?: string }) {
    if (init.content === undefined || init.content === null) {
      throw new Error("SystemInstructionSection.content is required.");
    }
    this.content = init.content;
    this.title = init.title ?? "user_system_instructions";
  }

  toJSON(): { content: string; title: string } {
    return {
      content: this.content,
      title: this.title,
    };
  }
}

export class CustomSystemInstructions {
  text: string;

  constructor(init: { text: string } | string) {
    if (typeof init !== "string" && (init.text === undefined || init.text === null)) {
      throw new Error("CustomSystemInstructions.text is required.");
    }
    this.text = typeof init === "string" ? init : init.text;
  }

  toJSON(): { text: string } {
    return {
      text: this.text,
    };
  }
}

export class TemplatedSystemInstructions {
  identity?: string;
  sections: SystemInstructionSection[];

  constructor(
    init: {
      identity?: string;
      sections?: Array<SystemInstructionSection | { content: string; title?: string }>;
    } = {},
  ) {
    if (init.sections !== undefined && !Array.isArray(init.sections)) {
      throw new Error("TemplatedSystemInstructions.sections must be an array.");
    }
    this.identity = init.identity;
    this.sections = (init.sections ?? []).map((section) =>
      section instanceof SystemInstructionSection ? section : new SystemInstructionSection(section),
    );
  }

  toJSON(): {
    identity?: string;
    sections: Array<ReturnType<SystemInstructionSection["toJSON"]>>;
  } {
    return {
      identity: this.identity,
      sections: this.sections.map((section) => section.toJSON()),
    };
  }
}

export type SystemInstructions = CustomSystemInstructions | TemplatedSystemInstructions;

export enum BuiltinTools {
  LIST_DIR = "list_directory",
  SEARCH_DIR = "search_directory",
  FIND_FILE = "find_file",
  VIEW_FILE = "view_file",
  CREATE_FILE = "create_file",
  EDIT_FILE = "edit_file",
  RUN_COMMAND = "run_command",
  ASK_QUESTION = "ask_question",
  START_SUBAGENT = "start_subagent",
  GENERATE_IMAGE = "generate_image",
  FINISH = "finish",
}

export namespace BuiltinTools {
  export function readOnly(): BuiltinTools[] {
    return [
      BuiltinTools.LIST_DIR,
      BuiltinTools.SEARCH_DIR,
      BuiltinTools.FIND_FILE,
      BuiltinTools.VIEW_FILE,
      BuiltinTools.FINISH,
    ];
  }

  export function read_only(): BuiltinTools[] {
    return readOnly();
  }

  export function nondestructive(): BuiltinTools[] {
    return [
      BuiltinTools.LIST_DIR,
      BuiltinTools.SEARCH_DIR,
      BuiltinTools.FIND_FILE,
      BuiltinTools.VIEW_FILE,
      BuiltinTools.CREATE_FILE,
      BuiltinTools.EDIT_FILE,
      BuiltinTools.ASK_QUESTION,
      BuiltinTools.START_SUBAGENT,
      BuiltinTools.GENERATE_IMAGE,
      BuiltinTools.FINISH,
    ];
  }

  export function allTools(): BuiltinTools[] {
    return Object.values(BuiltinTools).filter(
      (value): value is BuiltinTools => typeof value === "string",
    );
  }

  export function all_tools(): BuiltinTools[] {
    return allTools();
  }

  export function fileTools(): BuiltinTools[] {
    return [BuiltinTools.VIEW_FILE, BuiltinTools.CREATE_FILE, BuiltinTools.EDIT_FILE];
  }

  export function file_tools(): BuiltinTools[] {
    return fileTools();
  }

  export function none(): BuiltinTools[] {
    return [];
  }
}

export class CapabilitiesConfig {
  enableSubagents = true;
  enabledTools?: Array<BuiltinTools | string>;
  disabledTools?: Array<BuiltinTools | string>;
  compactionThreshold?: number;
  imageModel = DEFAULT_IMAGE_GENERATION_MODEL;
  finishToolSchemaJson?: string;

  constructor(
    init: {
      enableSubagents?: boolean;
      enable_subagents?: boolean;
      enabledTools?: Array<BuiltinTools | string>;
      enabled_tools?: Array<BuiltinTools | string>;
      disabledTools?: Array<BuiltinTools | string>;
      disabled_tools?: Array<BuiltinTools | string>;
      compactionThreshold?: number;
      compaction_threshold?: number;
      imageModel?: string;
      image_model?: string;
      finishToolSchemaJson?: string;
      finish_tool_schema_json?: string;
    } = {},
  ) {
    const enabledTools = init.enabledTools ?? init.enabled_tools;
    const disabledTools = init.disabledTools ?? init.disabled_tools;
    if (enabledTools !== undefined && disabledTools !== undefined) {
      throw new Error("enabledTools and disabledTools should be mutually exclusive.");
    }
    this.enableSubagents = init.enableSubagents ?? init.enable_subagents ?? true;
    this.enabledTools = enabledTools;
    this.disabledTools = disabledTools;
    this.compactionThreshold = init.compactionThreshold ?? init.compaction_threshold;
    this.imageModel = init.imageModel ?? init.image_model ?? DEFAULT_IMAGE_GENERATION_MODEL;
    this.finishToolSchemaJson = init.finishToolSchemaJson ?? init.finish_tool_schema_json;
  }

  get enable_subagents(): boolean {
    return this.enableSubagents;
  }

  set enable_subagents(value: boolean) {
    this.enableSubagents = value;
  }

  get enabled_tools(): Array<BuiltinTools | string> | undefined {
    return this.enabledTools;
  }

  set enabled_tools(value: Array<BuiltinTools | string> | undefined) {
    this.enabledTools = value;
  }

  get disabled_tools(): Array<BuiltinTools | string> | undefined {
    return this.disabledTools;
  }

  set disabled_tools(value: Array<BuiltinTools | string> | undefined) {
    this.disabledTools = value;
  }

  get compaction_threshold(): number | undefined {
    return this.compactionThreshold;
  }

  set compaction_threshold(value: number | undefined) {
    this.compactionThreshold = value;
  }

  get image_model(): string {
    return this.imageModel;
  }

  set image_model(value: string) {
    this.imageModel = value;
  }

  get finish_tool_schema_json(): string | undefined {
    return this.finishToolSchemaJson;
  }

  set finish_tool_schema_json(value: string | undefined) {
    this.finishToolSchemaJson = value;
  }

  toJSON(): {
    enable_subagents: boolean;
    enabled_tools?: Array<BuiltinTools | string>;
    disabled_tools?: Array<BuiltinTools | string>;
    compaction_threshold?: number;
    image_model: string;
    finish_tool_schema_json?: string;
  } {
    return {
      enable_subagents: this.enableSubagents,
      enabled_tools: this.enabledTools,
      disabled_tools: this.disabledTools,
      compaction_threshold: this.compactionThreshold,
      image_model: this.imageModel,
      finish_tool_schema_json: this.finishToolSchemaJson,
    };
  }
}

const MCP_NAME_RE = /^[a-zA-Z0-9_-]+$/;

type McpToolFilters = {
  enabledTools?: string[];
  enabled_tools?: string[];
  disabledTools?: string[];
  disabled_tools?: string[];
};

export abstract class BaseMcpServerConfig {
  name: string;
  enabledTools?: string[];
  disabledTools?: string[];

  protected constructor(init: { name: string } & McpToolFilters) {
    if (typeof init.name !== "string") {
      throw new Error("MCP server name is required.");
    }
    if (!MCP_NAME_RE.test(init.name)) {
      throw new Error(
        "MCP server name must contain only letters, numbers, underscores, and hyphens.",
      );
    }
    const enabledTools = init.enabledTools ?? init.enabled_tools;
    const disabledTools = init.disabledTools ?? init.disabled_tools;
    if (enabledTools !== undefined && disabledTools !== undefined) {
      throw new Error("enabledTools and disabledTools should be mutually exclusive.");
    }
    this.name = init.name;
    this.enabledTools = enabledTools;
    this.disabledTools = disabledTools;
  }

  get enabled_tools(): string[] | undefined {
    return this.enabledTools;
  }

  set enabled_tools(value: string[] | undefined) {
    this.enabledTools = value;
  }

  get disabled_tools(): string[] | undefined {
    return this.disabledTools;
  }

  set disabled_tools(value: string[] | undefined) {
    this.disabledTools = value;
  }

  protected toBaseJSON(): {
    name: string;
    enabled_tools?: string[];
    disabled_tools?: string[];
  } {
    return {
      name: this.name,
      enabled_tools: this.enabledTools,
      disabled_tools: this.disabledTools,
    };
  }
}

export class McpStdioServer extends BaseMcpServerConfig {
  readonly type = "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;

  constructor(
    init: {
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
    } & McpToolFilters,
  ) {
    super(init);
    if (typeof init.command !== "string") {
      throw new Error("McpStdioServer.command is required.");
    }
    this.command = init.command;
    this.args = init.args ?? [];
    this.env = init.env ? { ...init.env } : undefined;
  }

  toJSON(): ReturnType<BaseMcpServerConfig["toBaseJSON"]> & {
    type: "stdio";
    command: string;
    args: string[];
    env?: Record<string, string>;
  } {
    return {
      ...this.toBaseJSON(),
      type: this.type,
      command: this.command,
      args: this.args,
      env: this.env,
    };
  }
}

export class McpSseServer extends BaseMcpServerConfig {
  readonly type = "sse";
  url: string;
  headers?: Record<string, string>;

  constructor(
    init: { name: string; url: string; headers?: Record<string, string> } & McpToolFilters,
  ) {
    super(init);
    if (typeof init.url !== "string") {
      throw new Error("McpSseServer.url is required.");
    }
    this.url = init.url;
    this.headers = init.headers;
  }

  toJSON(): ReturnType<BaseMcpServerConfig["toBaseJSON"]> & {
    type: "sse";
    url: string;
    headers?: Record<string, string>;
  } {
    return {
      ...this.toBaseJSON(),
      type: this.type,
      url: this.url,
      headers: this.headers,
    };
  }
}

export class McpStreamableHttpServer extends BaseMcpServerConfig {
  readonly type = "http";
  url: string;
  headers?: Record<string, string>;
  timeout = 30;
  sseReadTimeout = 300;
  terminateOnClose = true;

  constructor(
    init: {
      name: string;
      url: string;
      headers?: Record<string, string>;
      timeout?: number;
      sseReadTimeout?: number;
      sse_read_timeout?: number;
      terminateOnClose?: boolean;
      terminate_on_close?: boolean;
    } & McpToolFilters,
  ) {
    super(init);
    if (typeof init.url !== "string") {
      throw new Error("McpStreamableHttpServer.url is required.");
    }
    this.url = init.url;
    this.headers = init.headers;
    this.timeout = init.timeout ?? 30;
    this.sseReadTimeout = init.sseReadTimeout ?? init.sse_read_timeout ?? 300;
    this.terminateOnClose = init.terminateOnClose ?? init.terminate_on_close ?? true;
  }

  get sse_read_timeout(): number {
    return this.sseReadTimeout;
  }

  set sse_read_timeout(value: number) {
    this.sseReadTimeout = value;
  }

  get terminate_on_close(): boolean {
    return this.terminateOnClose;
  }

  set terminate_on_close(value: boolean) {
    this.terminateOnClose = value;
  }

  toJSON(): ReturnType<BaseMcpServerConfig["toBaseJSON"]> & {
    type: "http";
    url: string;
    headers?: Record<string, string>;
    timeout: number;
    sse_read_timeout: number;
    terminate_on_close: boolean;
  } {
    return {
      ...this.toBaseJSON(),
      type: this.type,
      url: this.url,
      headers: this.headers,
      timeout: this.timeout,
      sse_read_timeout: this.sseReadTimeout,
      terminate_on_close: this.terminateOnClose,
    };
  }
}

export type McpServerConfig = McpStdioServer | McpSseServer | McpStreamableHttpServer;

export class ToolCall {
  name: BuiltinTools | string;
  args: Record<string, unknown>;
  id?: string;
  canonicalPath?: string;

  constructor(init: {
    name: BuiltinTools | string;
    args?: Record<string, unknown>;
    id?: string;
    canonicalPath?: string;
    canonical_path?: string;
  }) {
    if (init.name === undefined || init.name === null) {
      throw new Error("ToolCall.name is required.");
    }
    this.name = init.name;
    if (
      init.args !== undefined &&
      (init.args === null || typeof init.args !== "object" || Array.isArray(init.args))
    ) {
      throw new Error("ToolCall.args must be an object.");
    }
    this.args = init.args ?? {};
    this.id = init.id;
    this.canonicalPath = init.canonicalPath ?? init.canonical_path;
  }

  get canonical_path(): string | undefined {
    return this.canonicalPath;
  }

  set canonical_path(value: string | undefined) {
    this.canonicalPath = value;
  }

  toJSON(): {
    name: BuiltinTools | string;
    args: Record<string, unknown>;
    id?: string;
    canonical_path?: string;
  } {
    return {
      name: this.name,
      args: this.args,
      id: this.id,
      canonical_path: this.canonicalPath,
    };
  }
}

export class ToolResult {
  name: BuiltinTools | string;
  id?: string;
  result?: unknown;
  error?: string;
  exception?: unknown;

  constructor(init: {
    name: BuiltinTools | string;
    id?: string;
    result?: unknown;
    error?: string;
    exception?: unknown;
  }) {
    if (init.name === undefined || init.name === null) {
      throw new Error("ToolResult.name is required.");
    }
    this.name = init.name;
    this.id = init.id;
    this.result = init.result;
    this.error = init.error;
    this.exception = init.exception;
  }

  toJSON(): {
    name: BuiltinTools | string;
    id?: string;
    result?: unknown;
    error?: string;
  } {
    return {
      name: this.name,
      id: this.id,
      result: this.result,
      error: this.error,
    };
  }
}

export type TypeScriptTool = (...args: any[]) => unknown | Promise<unknown>;
export type PythonTool = TypeScriptTool;

export class UsageMetadata {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;

  constructor(
    init: Partial<UsageMetadata> & {
      prompt_token_count?: number;
      cached_content_token_count?: number;
      candidates_token_count?: number;
      thoughts_token_count?: number;
      total_token_count?: number;
    } = {},
  ) {
    this.promptTokenCount = init.promptTokenCount ?? init.prompt_token_count;
    this.cachedContentTokenCount = init.cachedContentTokenCount ?? init.cached_content_token_count;
    this.candidatesTokenCount = init.candidatesTokenCount ?? init.candidates_token_count;
    this.thoughtsTokenCount = init.thoughtsTokenCount ?? init.thoughts_token_count;
    this.totalTokenCount = init.totalTokenCount ?? init.total_token_count;
  }

  get prompt_token_count(): number | undefined {
    return this.promptTokenCount;
  }

  set prompt_token_count(value: number | undefined) {
    this.promptTokenCount = value;
  }

  get cached_content_token_count(): number | undefined {
    return this.cachedContentTokenCount;
  }

  set cached_content_token_count(value: number | undefined) {
    this.cachedContentTokenCount = value;
  }

  get candidates_token_count(): number | undefined {
    return this.candidatesTokenCount;
  }

  set candidates_token_count(value: number | undefined) {
    this.candidatesTokenCount = value;
  }

  get thoughts_token_count(): number | undefined {
    return this.thoughtsTokenCount;
  }

  set thoughts_token_count(value: number | undefined) {
    this.thoughtsTokenCount = value;
  }

  get total_token_count(): number | undefined {
    return this.totalTokenCount;
  }

  set total_token_count(value: number | undefined) {
    this.totalTokenCount = value;
  }

  toJSON(): {
    prompt_token_count?: number;
    cached_content_token_count?: number;
    candidates_token_count?: number;
    thoughts_token_count?: number;
    total_token_count?: number;
  } {
    return {
      prompt_token_count: this.promptTokenCount,
      cached_content_token_count: this.cachedContentTokenCount,
      candidates_token_count: this.candidatesTokenCount,
      thoughts_token_count: this.thoughtsTokenCount,
      total_token_count: this.totalTokenCount,
    };
  }
}

export enum StepType {
  TEXT_RESPONSE = "TEXT_RESPONSE",
  TOOL_CALL = "TOOL_CALL",
  SYSTEM_MESSAGE = "SYSTEM_MESSAGE",
  COMPACTION = "COMPACTION",
  FINISH = "FINISH",
  UNKNOWN = "UNKNOWN",
}

export enum StepSource {
  SYSTEM = "SYSTEM",
  USER = "USER",
  MODEL = "MODEL",
  UNKNOWN = "UNKNOWN",
}

export enum StepTarget {
  USER = "TARGET_USER",
  ENVIRONMENT = "TARGET_ENVIRONMENT",
  UNSPECIFIED = "TARGET_UNSPECIFIED",
  UNKNOWN = "UNKNOWN",
}

export enum StepStatus {
  ACTIVE = "ACTIVE",
  DONE = "DONE",
  WAITING_FOR_USER = "WAITING_FOR_USER",
  ERROR = "ERROR",
  CANCELED = "CANCELED",
  TERMINAL_ERROR = "TERMINAL_ERROR",
  UNKNOWN = "UNKNOWN",
}

export class Step {
  id = "";
  stepIndex = 0;
  type = StepType.UNKNOWN;
  source = StepSource.UNKNOWN;
  target = StepTarget.UNKNOWN;
  status = StepStatus.UNKNOWN;
  content = "";
  contentDelta = "";
  thinking = "";
  thinkingDelta = "";
  toolCalls: ToolCall[] = [];
  error = "";
  isCompleteResponse?: boolean;
  structuredOutput?: unknown;
  usageMetadata?: UsageMetadata;
  [key: string]: unknown;

  constructor(
    init: Partial<Step> & {
      step_index?: number;
      content_delta?: string;
      thinking_delta?: string;
      tool_calls?: Array<ToolCall | ConstructorParameters<typeof ToolCall>[0]>;
      is_complete_response?: boolean;
      structured_output?: unknown;
      usage_metadata?: ConstructorParameters<typeof UsageMetadata>[0];
    } = {},
  ) {
    Object.assign(this, init);
    this.stepIndex = init.stepIndex ?? init.step_index ?? this.stepIndex;
    this.contentDelta = init.contentDelta ?? init.content_delta ?? this.contentDelta;
    this.thinkingDelta = init.thinkingDelta ?? init.thinking_delta ?? this.thinkingDelta;
    this.isCompleteResponse =
      init.isCompleteResponse ?? init.is_complete_response ?? this.isCompleteResponse;
    this.structuredOutput =
      init.structuredOutput ?? init.structured_output ?? this.structuredOutput;
    this.toolCalls = (init.toolCalls ?? init.tool_calls ?? []).map((call) =>
      call instanceof ToolCall
        ? call
        : new ToolCall(call as ConstructorParameters<typeof ToolCall>[0]),
    );
    const usageMetadata = init.usageMetadata ?? init.usage_metadata;
    this.usageMetadata = usageMetadata ? new UsageMetadata(usageMetadata) : undefined;
  }

  get step_index(): number {
    return this.stepIndex;
  }

  set step_index(value: number) {
    this.stepIndex = value;
  }

  get content_delta(): string {
    return this.contentDelta;
  }

  set content_delta(value: string) {
    this.contentDelta = value;
  }

  get thinking_delta(): string {
    return this.thinkingDelta;
  }

  set thinking_delta(value: string) {
    this.thinkingDelta = value;
  }

  get tool_calls(): ToolCall[] {
    return this.toolCalls;
  }

  set tool_calls(value: Array<ToolCall | ConstructorParameters<typeof ToolCall>[0]>) {
    this.toolCalls = value.map((call) => (call instanceof ToolCall ? call : new ToolCall(call)));
  }

  get is_complete_response(): boolean | undefined {
    return this.isCompleteResponse;
  }

  set is_complete_response(value: boolean | undefined) {
    this.isCompleteResponse = value;
  }

  get structured_output(): unknown {
    return this.structuredOutput;
  }

  set structured_output(value: unknown) {
    this.structuredOutput = value;
  }

  get usage_metadata(): UsageMetadata | undefined {
    return this.usageMetadata;
  }

  set usage_metadata(value: ConstructorParameters<typeof UsageMetadata>[0] | undefined) {
    this.usageMetadata =
      value === undefined
        ? undefined
        : value instanceof UsageMetadata
          ? value
          : new UsageMetadata(value);
  }

  toJSON(): Record<string, unknown> {
    const json: Record<string, unknown> = {
      id: this.id,
      step_index: this.stepIndex,
      type: this.type,
      source: this.source,
      target: this.target,
      status: this.status,
      content: this.content,
      content_delta: this.contentDelta,
      thinking: this.thinking,
      thinking_delta: this.thinkingDelta,
      tool_calls: this.toolCalls.map((call) => call.toJSON()),
      error: this.error,
      is_complete_response: this.isCompleteResponse,
      structured_output: this.structuredOutput,
      usage_metadata: this.usageMetadata?.toJSON(),
    };
    for (const [key, value] of Object.entries(this)) {
      if (!STEP_SERIALIZED_FIELD_NAMES.has(key)) {
        json[key] = value;
      }
    }
    return json;
  }
}

const STEP_SERIALIZED_FIELD_NAMES = new Set([
  "id",
  "stepIndex",
  "step_index",
  "type",
  "source",
  "target",
  "status",
  "content",
  "contentDelta",
  "content_delta",
  "thinking",
  "thinkingDelta",
  "thinking_delta",
  "toolCalls",
  "tool_calls",
  "error",
  "isCompleteResponse",
  "is_complete_response",
  "structuredOutput",
  "structured_output",
  "usageMetadata",
  "usage_metadata",
]);

export class HookResult {
  allow = true;
  message = "";

  constructor(init: Partial<HookResult> = {}) {
    this.allow = init.allow ?? true;
    this.message = init.message ?? "";
  }
}

export class QuestionResponse {
  selectedOptionIds?: string[];
  freeformResponse = "";
  skipped = false;

  constructor(
    init: Partial<QuestionResponse> & {
      selected_option_ids?: string[];
      freeform_response?: string;
    } = {},
  ) {
    this.selectedOptionIds = init.selectedOptionIds ?? init.selected_option_ids;
    this.freeformResponse = init.freeformResponse ?? init.freeform_response ?? "";
    this.skipped = init.skipped ?? false;
  }

  get selected_option_ids(): string[] | undefined {
    return this.selectedOptionIds;
  }

  set selected_option_ids(value: string[] | undefined) {
    this.selectedOptionIds = value;
  }

  get freeform_response(): string {
    return this.freeformResponse;
  }

  set freeform_response(value: string) {
    this.freeformResponse = value;
  }

  toJSON(): {
    selected_option_ids?: string[];
    freeform_response: string;
    skipped: boolean;
  } {
    return {
      selected_option_ids: this.selectedOptionIds,
      freeform_response: this.freeformResponse,
      skipped: this.skipped,
    };
  }
}

export class QuestionHookResult {
  responses: QuestionResponse[];
  cancelled = false;

  constructor(init: { responses: QuestionResponse[]; cancelled?: boolean }) {
    if (!Array.isArray(init.responses)) {
      throw new Error("QuestionHookResult.responses is required.");
    }
    this.responses = init.responses.map((response) =>
      response instanceof QuestionResponse ? response : new QuestionResponse(response),
    );
    this.cancelled = init.cancelled ?? false;
  }

  toJSON(): {
    responses: Array<ReturnType<QuestionResponse["toJSON"]>>;
    cancelled: boolean;
  } {
    return {
      responses: this.responses.map((response) => response.toJSON()),
      cancelled: this.cancelled,
    };
  }
}

export class AskQuestionOption {
  readonly id: string;
  readonly text: string;

  constructor(init: { id: string; text: string }) {
    if (init.id === undefined || init.id === null) {
      throw new Error("AskQuestionOption.id is required.");
    }
    if (init.text === undefined || init.text === null) {
      throw new Error("AskQuestionOption.text is required.");
    }
    this.id = init.id;
    this.text = init.text;
    Object.freeze(this);
  }

  toJSON(): { id: string; text: string } {
    return {
      id: this.id,
      text: this.text,
    };
  }
}

export class AskQuestionEntry {
  readonly question: string;
  readonly options: AskQuestionOption[];
  readonly isMultiSelect: boolean;

  constructor(init: {
    question: string;
    options: Array<AskQuestionOption | { id: string; text: string }>;
    isMultiSelect?: boolean;
    is_multi_select?: boolean;
  }) {
    if (init.question === undefined || init.question === null) {
      throw new Error("AskQuestionEntry.question is required.");
    }
    if (!Array.isArray(init.options)) {
      throw new Error("AskQuestionEntry.options is required.");
    }
    this.question = init.question;
    this.options = init.options.map((option) =>
      option instanceof AskQuestionOption ? option : new AskQuestionOption(option),
    );
    this.isMultiSelect = init.isMultiSelect ?? init.is_multi_select ?? false;
    Object.freeze(this);
  }

  get is_multi_select(): boolean {
    return this.isMultiSelect;
  }

  toJSON(): {
    question: string;
    options: Array<ReturnType<AskQuestionOption["toJSON"]>>;
    is_multi_select: boolean;
  } {
    return {
      question: this.question,
      options: this.options.map((option) => option.toJSON()),
      is_multi_select: this.isMultiSelect,
    };
  }
}

export class AskQuestionInteractionSpec {
  readonly questions: AskQuestionEntry[];

  constructor(init: {
    questions: Array<AskQuestionEntry | ConstructorParameters<typeof AskQuestionEntry>[0]>;
  }) {
    if (!Array.isArray(init.questions)) {
      throw new Error("AskQuestionInteractionSpec.questions is required.");
    }
    this.questions = init.questions.map((question) =>
      question instanceof AskQuestionEntry ? question : new AskQuestionEntry(question),
    );
    Object.freeze(this);
  }

  toJSON(): { questions: Array<ReturnType<AskQuestionEntry["toJSON"]>> } {
    return {
      questions: this.questions.map((question) => question.toJSON()),
    };
  }
}

export class AntigravityConnectionError extends Error {
  override name = "AntigravityConnectionError";
}

export class AntigravityExecutionError extends Error {
  override name = "AntigravityExecutionError";
}

export class AntigravityValidationError extends Error {
  override name = "AntigravityValidationError";
  errors: Array<Record<string, unknown>>;

  constructor(message: string, errors: Array<Record<string, unknown>> = []) {
    super(message);
    this.errors = [...errors];
  }

  static fromPydantic(exc: unknown): AntigravityValidationError {
    return new AntigravityValidationError(String(exc), extractValidationErrors(exc));
  }

  static from_pydantic = AntigravityValidationError.fromPydantic;
}

function extractValidationErrors(exc: unknown): Array<Record<string, unknown>> {
  if (!exc || typeof exc !== "object") {
    return [];
  }
  const maybeErrors = (exc as { errors?: unknown }).errors;
  const errors = typeof maybeErrors === "function" ? maybeErrors.call(exc) : maybeErrors;
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors.filter(
    (error): error is Record<string, unknown> =>
      error !== null && typeof error === "object" && !Array.isArray(error),
  );
}

export enum TriggerDelivery {
  SEND_IMMEDIATELY = "send_immediately",
  WAIT_IDLE = "wait_idle",
}

export enum FileChangeKind {
  ADDED = "added",
  MODIFIED = "modified",
  DELETED = "deleted",
}

export class FileChange {
  readonly kind: FileChangeKind;
  readonly path: string;

  constructor(init: { kind: FileChangeKind; path: string }) {
    this.kind = init.kind;
    this.path = init.path;
    Object.freeze(this);
  }

  toJSON(): { kind: FileChangeKind; path: string } {
    return {
      kind: this.kind,
      path: this.path,
    };
  }
}

export abstract class StreamChunk {
  readonly stepIndex: number;

  protected constructor(init: { stepIndex?: number; step_index?: number }) {
    const stepIndex = init.stepIndex ?? init.step_index;
    if (stepIndex === undefined || stepIndex === null) {
      throw new Error("StreamChunk.stepIndex is required.");
    }
    this.stepIndex = stepIndex;
  }

  get step_index(): number {
    return this.stepIndex;
  }
}

export class Thought extends StreamChunk {
  readonly text: string;
  readonly signature?: Uint8Array;

  constructor(init: {
    stepIndex?: number;
    step_index?: number;
    text: string;
    signature?: Uint8Array;
  }) {
    super(init);
    if (init.text === undefined || init.text === null) {
      throw new Error("Thought.text is required.");
    }
    this.text = init.text;
    this.signature = init.signature;
    Object.freeze(this);
  }

  toJSON(): { step_index: number; text: string; signature?: Uint8Array } {
    return {
      step_index: this.stepIndex,
      text: this.text,
      signature: this.signature,
    };
  }
}

export class Text extends StreamChunk {
  readonly text: string;

  constructor(init: { stepIndex?: number; step_index?: number; text: string }) {
    super(init);
    if (init.text === undefined || init.text === null) {
      throw new Error("Text.text is required.");
    }
    this.text = init.text;
    Object.freeze(this);
  }

  toJSON(): { step_index: number; text: string } {
    return {
      step_index: this.stepIndex,
      text: this.text,
    };
  }
}

export type ResponseChunk = StreamChunk | ToolCall | ToolResult;

export interface StructuredOutputProvider {
  getLastStructuredOutput?: () => unknown | undefined;
  get_last_structured_output?: () => unknown | undefined;
  readonly lastTurnUsage?: UsageMetadata | undefined;
  readonly last_turn_usage?: UsageMetadata | undefined;
}

export class ChatResponse implements AsyncIterable<string> {
  #source: AsyncIterator<ResponseChunk>;
  #conversation: StructuredOutputProvider;
  #bufferedChunks: ResponseChunk[] = [];
  #done = false;
  #streamError: unknown;
  #pulling?: Promise<void>;

  constructor(
    chunkStream: AsyncIterable<ResponseChunk> | AsyncIterator<ResponseChunk>,
    conversation: StructuredOutputProvider,
  ) {
    this.#source =
      Symbol.asyncIterator in chunkStream ? chunkStream[Symbol.asyncIterator]() : chunkStream;
    this.#conversation = conversation;
  }

  get chunks(): AsyncIterable<ResponseChunk> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        let pos = 0;
        while (true) {
          if (pos < self.#bufferedChunks.length) {
            yield self.#bufferedChunks[pos]!;
            pos += 1;
            continue;
          }
          if (self.#done) {
            if (self.#streamError !== undefined) {
              throw self.#streamError;
            }
            return;
          }
          await self.#pullOnce();
        }
      },
    };
  }

  async #pullOnce(): Promise<void> {
    if (this.#pulling) {
      await this.#pulling;
      return;
    }
    this.#pulling = (async () => {
      try {
        const next = await this.#source.next();
        if (next.done) {
          this.#done = true;
        } else {
          this.#bufferedChunks.push(next.value);
        }
      } catch (error) {
        this.#done = true;
        this.#streamError = error;
        throw error;
      } finally {
        this.#pulling = undefined;
      }
    })();
    await this.#pulling;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for await (const chunk of this.chunks) {
      if (chunk instanceof Text) {
        yield chunk.text;
      }
    }
  }

  get thoughts(): AsyncIterable<string> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of self.chunks) {
          if (chunk instanceof Thought) {
            yield chunk.text;
          }
        }
      },
    };
  }

  get toolCalls(): AsyncIterable<ToolCall> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of self.chunks) {
          if (chunk instanceof ToolCall) {
            yield chunk;
          }
        }
      },
    };
  }

  get tool_calls(): AsyncIterable<ToolCall> {
    return this.toolCalls;
  }

  async resolve(): Promise<ResponseChunk[]> {
    const chunks: ResponseChunk[] = [];
    for await (const chunk of this.chunks) {
      chunks.push(chunk);
    }
    return chunks;
  }

  async text(): Promise<string> {
    const chunks = await this.resolve();
    return chunks
      .filter((chunk): chunk is Text => chunk instanceof Text)
      .map((chunk) => chunk.text)
      .join("");
  }

  async structuredOutput(): Promise<unknown | undefined> {
    if (!this.#done) {
      await this.resolve();
    }
    if (this.#conversation.getLastStructuredOutput) {
      return this.#conversation.getLastStructuredOutput();
    }
    return this.#conversation.get_last_structured_output?.();
  }

  structured_output(): Promise<unknown | undefined> {
    return this.structuredOutput();
  }

  get usageMetadata(): UsageMetadata | undefined {
    return this.#conversation.lastTurnUsage ?? this.#conversation.last_turn_usage;
  }

  get usage_metadata(): UsageMetadata | undefined {
    return this.usageMetadata;
  }
}

export const SUPPORTED_IMAGE_MIMES = new Set([
  "image/bmp",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const SUPPORTED_DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/json",
  "text/css",
  "text/csv",
  "text/html",
  "text/javascript",
  "text/plain",
  "text/rtf",
  "text/xml",
]);

export const SUPPORTED_AUDIO_MIMES = new Set([
  "audio/wav",
  "audio/mp3",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
  "audio/opus",
  "audio/mpeg",
  "audio/m4a",
  "audio/l16",
]);

export const SUPPORTED_VIDEO_MIMES = new Set([
  "video/3gpp",
  "video/avi",
  "video/mp4",
  "video/mpeg",
  "video/mpg",
  "video/quicktime",
  "video/webm",
  "video/wmv",
  "video/x-flv",
]);

const MIME_BY_EXTENSION = new Map<string, string>([
  [".bmp", "image/bmp"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
  [".json", "application/json"],
  [".css", "text/css"],
  [".csv", "text/csv"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".txt", "text/plain"],
  [".rtf", "text/rtf"],
  [".xml", "text/xml"],
  [".wav", "audio/wav"],
  [".mp3", "audio/mpeg"],
  [".aac", "audio/aac"],
  [".ogg", "audio/ogg"],
  [".flac", "audio/flac"],
  [".opus", "audio/opus"],
  [".m4a", "audio/m4a"],
  [".3gp", "video/3gpp"],
  [".avi", "video/avi"],
  [".mp4", "video/mp4"],
  [".mpeg", "video/mpeg"],
  [".mpg", "video/mpg"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".wmv", "video/wmv"],
  [".flv", "video/x-flv"],
]);

function inferMime(path: string): string | undefined {
  return MIME_BY_EXTENSION.get(extname(path).toLowerCase());
}

function readFileSafely(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      throw new Error(`File not found at path: '${path}'`);
    }
    if (code === "EISDIR") {
      throw new Error(`Path is a directory, not a file: '${path}'`);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`Permission denied when reading path: '${path}'`);
    }
    throw new Error(`Failed to read file at path '${path}': ${String(error)}`);
  }
}

abstract class BaseMedia {
  #data: Uint8Array;
  readonly mimeType: string;
  readonly description?: string;

  protected constructor(init: {
    data: Uint8Array | Buffer | ArrayBuffer | string;
    mimeType?: string;
    mime_type?: string;
    description?: string;
  }) {
    this.#data = normalizeMediaData(init.data);
    Object.defineProperty(this, "data", {
      enumerable: true,
      configurable: false,
      get: () => new Uint8Array(this.#data),
    });
    this.mimeType = init.mimeType ?? init.mime_type ?? "";
    this.description = init.description;
    this.validateMimeType();
    Object.freeze(this);
  }

  get data(): Uint8Array {
    return new Uint8Array(this.#data);
  }

  get mime_type(): string {
    return this.mimeType;
  }

  protected abstract supportedMimes(): Set<string>;

  protected validateMimeType(): void {
    if (!this.supportedMimes().has(this.mimeType)) {
      throw new Error(`Unsupported ${this.constructor.name} MIME type: '${this.mimeType}'`);
    }
  }
}

function normalizeMediaData(data: Uint8Array | Buffer | ArrayBuffer | string): Uint8Array {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(new Uint8Array(data));
  }
  return new Uint8Array(data);
}

export class Image extends BaseMedia {
  constructor(init: {
    data: Uint8Array | Buffer | ArrayBuffer | string;
    mimeType?: string;
    mime_type?: string;
    description?: string;
  }) {
    super(init);
  }

  protected supportedMimes(): Set<string> {
    return SUPPORTED_IMAGE_MIMES;
  }

  static fromFile(path: string, description?: string): Image {
    return new Image({
      data: readFileSafely(path),
      mimeType: inferMime(path) ?? "",
      description,
    });
  }

  static from_file(path: string, description?: string): Image {
    return Image.fromFile(path, description);
  }
}

export class Document extends BaseMedia {
  constructor(init: {
    data: Uint8Array | Buffer | ArrayBuffer | string;
    mimeType?: string;
    mime_type?: string;
    description?: string;
  }) {
    super(init);
  }

  protected supportedMimes(): Set<string> {
    return SUPPORTED_DOCUMENT_MIMES;
  }

  static fromFile(path: string, description?: string): Document {
    return new Document({
      data: readFileSafely(path),
      mimeType: inferMime(path) ?? "",
      description,
    });
  }

  static from_file(path: string, description?: string): Document {
    return Document.fromFile(path, description);
  }
}

export class Audio extends BaseMedia {
  constructor(init: {
    data: Uint8Array | Buffer | ArrayBuffer | string;
    mimeType?: string;
    mime_type?: string;
    description?: string;
  }) {
    super(init);
  }

  protected supportedMimes(): Set<string> {
    return SUPPORTED_AUDIO_MIMES;
  }

  static fromFile(path: string, description?: string): Audio {
    return new Audio({
      data: readFileSafely(path),
      mimeType: inferMime(path) ?? "",
      description,
    });
  }

  static from_file(path: string, description?: string): Audio {
    return Audio.fromFile(path, description);
  }
}

export class Video extends BaseMedia {
  constructor(init: {
    data: Uint8Array | Buffer | ArrayBuffer | string;
    mimeType?: string;
    mime_type?: string;
    description?: string;
  }) {
    super(init);
  }

  protected supportedMimes(): Set<string> {
    return SUPPORTED_VIDEO_MIMES;
  }

  static fromFile(path: string, description?: string): Video {
    return new Video({
      data: readFileSafely(path),
      mimeType: inferMime(path) ?? "",
      description,
    });
  }

  static from_file(path: string, description?: string): Video {
    return Video.fromFile(path, description);
  }
}

export type ContentPrimitive = string | Image | Document | Audio | Video;
export type Content = ContentPrimitive | ContentPrimitive[];

export function fromFile(path: string, description?: string): Image | Document | Audio | Video {
  const data = readFileSafely(path);
  const mimeType = inferMime(path);
  if (!mimeType) {
    throw new Error(`Could not infer a valid MIME type for extension: '${extname(path)}'`);
  }
  if (SUPPORTED_IMAGE_MIMES.has(mimeType)) {
    return new Image({ data, mimeType, description });
  }
  if (SUPPORTED_DOCUMENT_MIMES.has(mimeType)) {
    return new Document({ data, mimeType, description });
  }
  if (SUPPORTED_AUDIO_MIMES.has(mimeType)) {
    return new Audio({ data, mimeType, description });
  }
  if (SUPPORTED_VIDEO_MIMES.has(mimeType)) {
    return new Video({ data, mimeType, description });
  }
  throw new Error(
    `Unsupported MIME type: '${mimeType}'. Supported file formats in the SDK are: ${[
      ...SUPPORTED_IMAGE_MIMES,
      ...SUPPORTED_DOCUMENT_MIMES,
      ...SUPPORTED_AUDIO_MIMES,
      ...SUPPORTED_VIDEO_MIMES,
    ]
      .sort()
      .join(", ")}`,
  );
}

export const from_file: typeof fromFile = fromFile;
