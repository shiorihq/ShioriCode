import {
  BuiltinTools,
  CapabilitiesConfig,
  Content,
  CustomSystemInstructions,
  McpServerConfig,
  McpSseServer,
  McpStdioServer,
  McpStreamableHttpServer,
  SystemInstructions,
  TemplatedSystemInstructions,
  TypeScriptTool,
} from "../types.js";

export interface Connection {
  readonly isIdle: boolean;
  readonly is_idle: boolean;
  readonly conversationId: string;
  readonly conversation_id: string;
  send(prompt: Content | undefined, options?: Record<string, unknown>): Promise<void>;
  receiveSteps(): AsyncIterable<import("../types.js").Step>;
  receive_steps(): AsyncIterable<import("../types.js").Step>;
  disconnect(): Promise<void>;
  cancel(): Promise<void>;
  delete(): Promise<void>;
  signalIdle(): Promise<void>;
  signal_idle(): Promise<void>;
  waitForIdle(): Promise<void>;
  wait_for_idle(): Promise<void>;
  waitForWakeup(timeout?: number): Promise<boolean>;
  wait_for_wakeup(timeout?: number): Promise<boolean>;
  sendToolResults(results: import("../types.js").ToolResult[]): Promise<void>;
  send_tool_results(results: import("../types.js").ToolResult[]): Promise<void>;
  sendTriggerNotification(content: string): Promise<void>;
  send_trigger_notification(content: string): Promise<void>;
}

export abstract class ConnectionStrategy {
  abstract connect(): Connection;
  abstract start(): Promise<void>;
  abstract stop(excType?: unknown, excValue?: unknown, excTraceback?: unknown): Promise<void>;
}

type JsonSchemaObject = Record<string, unknown>;
type JsonSchemaConvertible = {
  toJSONSchema: () => unknown;
};

export type AgentConfigInit = {
  systemInstructions?: string | import("../types.js").SystemInstructions;
  system_instructions?: string | import("../types.js").SystemInstructions;
  capabilities?: CapabilitiesConfig;
  tools?: TypeScriptTool[];
  policies?: unknown[];
  hooks?: unknown[];
  triggers?: unknown[];
  mcpServers?: McpServerConfig[];
  mcp_servers?: McpServerConfig[];
  workspaces?: string[];
  conversationId?: string;
  conversation_id?: string;
  saveDir?: string;
  save_dir?: string;
  appDataDir?: string;
  app_data_dir?: string;
  responseSchema?: JsonSchemaObject | JsonSchemaConvertible | string | null;
  response_schema?: JsonSchemaObject | JsonSchemaConvertible | string | null;
  skillsPaths?: string[];
  skills_paths?: string[];
};

export type CreateStrategyArgs = {
  toolRunner?: unknown;
  tool_runner?: unknown;
  hookRunner?: unknown;
  hook_runner?: unknown;
};

export abstract class AgentConfig {
  systemInstructions?: string | import("../types.js").SystemInstructions;
  capabilities: CapabilitiesConfig;
  tools: TypeScriptTool[];
  policies: unknown[];
  hooks: unknown[];
  triggers: unknown[];
  mcpServers: McpServerConfig[];
  workspaces: string[];
  conversationId?: string;
  saveDir?: string;
  appDataDir?: string;
  responseSchema?: string;
  skillsPaths: string[];

  protected constructor(init: AgentConfigInit = {}) {
    this.systemInstructions = init.systemInstructions ?? init.system_instructions;
    this.capabilities =
      init.capabilities ?? new CapabilitiesConfig({ enabledTools: BuiltinTools.readOnly() });
    this.tools = [...(init.tools ?? [])];
    this.policies = [...(init.policies ?? [])];
    this.hooks = [...(init.hooks ?? [])];
    this.triggers = [...(init.triggers ?? [])];
    this.mcpServers = [...(init.mcpServers ?? init.mcp_servers ?? [])];
    this.workspaces = [...(init.workspaces ?? [])];
    this.conversationId = init.conversationId ?? init.conversation_id;
    this.saveDir = init.saveDir ?? init.save_dir;
    this.appDataDir = init.appDataDir ?? init.app_data_dir;
    this.responseSchema = validateResponseSchema(init.responseSchema ?? init.response_schema);
    this.skillsPaths = [...(init.skillsPaths ?? init.skills_paths ?? [])];
  }

  get system_instructions(): string | SystemInstructions | undefined {
    return this.systemInstructions;
  }

  set system_instructions(value: string | SystemInstructions | undefined) {
    this.systemInstructions = value;
  }

  get mcp_servers(): McpServerConfig[] {
    return this.mcpServers;
  }

  set mcp_servers(value: McpServerConfig[]) {
    this.mcpServers = value;
  }

  get conversation_id(): string | undefined {
    return this.conversationId;
  }

  set conversation_id(value: string | undefined) {
    this.conversationId = value;
  }

  get save_dir(): string | undefined {
    return this.saveDir;
  }

  set save_dir(value: string | undefined) {
    this.saveDir = value;
  }

  get app_data_dir(): string | undefined {
    return this.appDataDir;
  }

  set app_data_dir(value: string | undefined) {
    this.appDataDir = value;
  }

  get response_schema(): string | undefined {
    return this.responseSchema;
  }

  set response_schema(value: JsonSchemaObject | JsonSchemaConvertible | string | null | undefined) {
    this.responseSchema = validateResponseSchema(value);
  }

  get skills_paths(): string[] {
    return this.skillsPaths;
  }

  set skills_paths(value: string[]) {
    this.skillsPaths = value;
  }

  abstract createStrategy(args: CreateStrategyArgs): ConnectionStrategy;

  create_strategy(args: CreateStrategyArgs): ConnectionStrategy {
    return this.createStrategy({
      toolRunner: args.toolRunner ?? args.tool_runner,
      hookRunner: args.hookRunner ?? args.hook_runner,
    });
  }

  clone(): AgentConfig {
    const clone = Object.assign(Object.create(Object.getPrototypeOf(this)), this) as AgentConfig;
    clone.systemInstructions = cloneSystemInstructions(this.systemInstructions);
    clone.capabilities = cloneCapabilitiesConfig(this.capabilities);
    clone.tools = [...this.tools];
    clone.policies = [...this.policies];
    clone.hooks = [...this.hooks];
    clone.triggers = [...this.triggers];
    clone.mcpServers = this.mcpServers.map(cloneMcpServerConfig);
    clone.workspaces = [...this.workspaces];
    clone.skillsPaths = [...this.skillsPaths];
    return clone;
  }
}

export function cloneCapabilitiesConfig(config: CapabilitiesConfig): CapabilitiesConfig {
  return new CapabilitiesConfig({
    enableSubagents: config.enableSubagents,
    enabledTools: config.enabledTools ? [...config.enabledTools] : undefined,
    disabledTools: config.disabledTools ? [...config.disabledTools] : undefined,
    compactionThreshold: config.compactionThreshold,
    imageModel: config.imageModel,
    finishToolSchemaJson: config.finishToolSchemaJson,
  });
}

export function cloneSystemInstructions(
  instructions: string | SystemInstructions | undefined,
): string | SystemInstructions | undefined {
  if (typeof instructions === "string" || instructions === undefined) {
    return instructions;
  }
  if (instructions instanceof CustomSystemInstructions) {
    return new CustomSystemInstructions({ text: instructions.text });
  }
  if (instructions instanceof TemplatedSystemInstructions) {
    return new TemplatedSystemInstructions({
      identity: instructions.identity,
      sections: instructions.sections.map((section) => ({
        content: section.content,
        title: section.title,
      })),
    });
  }
  return instructions;
}

export function cloneMcpServerConfig(config: McpServerConfig): McpServerConfig {
  const filters = {
    enabledTools: config.enabledTools ? [...config.enabledTools] : undefined,
    disabledTools: config.disabledTools ? [...config.disabledTools] : undefined,
  };
  if (config instanceof McpStdioServer) {
    return new McpStdioServer({
      name: config.name,
      command: config.command,
      args: [...config.args],
      ...filters,
    });
  }
  if (config instanceof McpSseServer) {
    return new McpSseServer({
      name: config.name,
      url: config.url,
      headers: config.headers ? { ...config.headers } : undefined,
      ...filters,
    });
  }
  return new McpStreamableHttpServer({
    name: config.name,
    url: config.url,
    headers: config.headers ? { ...config.headers } : undefined,
    timeout: config.timeout,
    sseReadTimeout: config.sseReadTimeout,
    terminateOnClose: config.terminateOnClose,
    ...filters,
  });
}

function validateResponseSchema(
  schema: JsonSchemaObject | JsonSchemaConvertible | string | null | undefined,
): string | undefined {
  if (schema === undefined || schema === null) {
    return undefined;
  }
  if (typeof schema === "string") {
    try {
      JSON.parse(schema);
    } catch (error) {
      throw new Error("response_schema string is not valid JSON.", {
        cause: error,
      });
    }
    return schema;
  }
  if (isJsonSchemaConvertible(schema)) {
    return JSON.stringify(schema.toJSONSchema());
  }
  if (isPlainObject(schema)) {
    return JSON.stringify(schema);
  }
  throw new Error(
    `Unsupported response_schema format: ${typeof schema}. Expected a JSON string, object, or Zod schema.`,
  );
}

function isJsonSchemaConvertible(
  schema: JsonSchemaObject | JsonSchemaConvertible,
): schema is JsonSchemaConvertible {
  return typeof (schema as JsonSchemaConvertible).toJSONSchema === "function";
}

function isPlainObject(value: unknown): value is JsonSchemaObject {
  return (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
