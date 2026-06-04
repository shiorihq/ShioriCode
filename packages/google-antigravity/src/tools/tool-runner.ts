import { ToolCall, ToolResult, TypeScriptTool } from "../types.js";
import { ToolContext } from "./tool-context.js";

export class ToolWithSchema {
  fn: TypeScriptTool;
  inputSchema: Record<string, unknown>;
  name: string;
  description: string;
  __name__: string;
  __doc__: string;

  constructor(
    fn: TypeScriptTool,
    inputSchema: Record<string, unknown>,
    name = fn.name,
    description = toolDescription(fn),
  ) {
    this.fn = fn;
    this.inputSchema = inputSchema;
    this.name = name;
    this.description = description;
    this.__name__ = name;
    this.__doc__ = description;
  }

  get input_schema(): Record<string, unknown> {
    return this.inputSchema;
  }

  set input_schema(value: Record<string, unknown>) {
    this.inputSchema = value;
  }

  call(...args: unknown[]): unknown | Promise<unknown> {
    return this.fn(...args);
  }
}

type RegisteredTool = TypeScriptTool | ToolWithSchema;
export type PublicToolCallable = TypeScriptTool & {
  inputSchema?: Record<string, unknown>;
  parameterNames?: string[];
  description?: string;
};

function callableName(tool: RegisteredTool): string {
  return tool instanceof ToolWithSchema ? tool.name : tool.name;
}

function innerFn(tool: RegisteredTool): TypeScriptTool {
  return tool instanceof ToolWithSchema ? tool.fn : tool;
}

function toolDescription(fn: TypeScriptTool): string {
  const explicitDescription = (fn as TypeScriptTool & { description?: unknown }).description;
  if (typeof explicitDescription === "string") {
    return explicitDescription;
  }
  return (
    fn
      .toString()
      .match(/\/\*\*([\s\S]*?)\*\//)?.[1]
      ?.trim() ?? ""
  );
}

function parseParamNames(fn: TypeScriptTool): string[] {
  const source = fn.toString().replace(/\/\*[\s\S]*?\*\//g, "");
  const match = source.match(/^[^(]*\(([^)]*)\)/) ?? source.match(/^(?:async\s*)?([^=()]+?)\s*=>/);
  if (!match?.[1]) {
    return [];
  }
  return match[1]
    .split(",")
    .map((param) => param.trim().replace(/=.*$/, "").trim())
    .filter(Boolean);
}

function contextParamName(fn: TypeScriptTool): string | undefined {
  return parseParamNames(fn).find((name) => ["ctx", "context", "toolContext"].includes(name));
}

function publicParamNames(fn: TypeScriptTool): string[] {
  return parseParamNames(fn).filter((name) => !["ctx", "context", "toolContext"].includes(name));
}

function inferredObjectSchema(parameterNames: string[]): Record<string, unknown> {
  if (
    parameterNames.length === 0 ||
    parameterNames[0]?.startsWith("{") ||
    parameterNames[0] === "args"
  ) {
    return { type: "object" };
  }
  return {
    type: "object",
    properties: Object.fromEntries(parameterNames.map((name) => [name, {}])),
    required: parameterNames,
  };
}

export class ToolRunner {
  #tools = new Map<string, RegisteredTool>();
  #context?: ToolContext;
  #contextParams = new Map<string, string>();
  #publicParamNames = new Map<string, string[]>();

  constructor(tools: RegisteredTool[] = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  setContext(ctx: ToolContext): void {
    this.#context = ctx;
  }

  set_context(ctx: ToolContext): void {
    this.setContext(ctx);
  }

  register(tool: RegisteredTool, name?: string): void {
    const toolName = name ?? callableName(tool);
    if (!toolName) {
      throw new Error("Tool must have a name or an explicit name override.");
    }
    if (this.#tools.has(toolName)) {
      throw new Error(`Tool '${toolName}' is already registered.`);
    }
    this.#tools.set(toolName, tool);
    this.#publicParamNames.set(toolName, publicParamNames(innerFn(tool)));
    const ctxParam = contextParamName(innerFn(tool));
    if (ctxParam) {
      this.#contextParams.set(toolName, ctxParam);
    }
  }

  unregister(name: string): void {
    if (!this.#tools.delete(name)) {
      throw new Error(`Tool '${name}' is not registered.`);
    }
    this.#contextParams.delete(name);
    this.#publicParamNames.delete(name);
  }

  get toolNames(): string[] {
    return [...this.#tools.keys()];
  }

  get tool_names(): string[] {
    return this.toolNames;
  }

  get tools(): Record<string, RegisteredTool> {
    return Object.fromEntries(this.#tools);
  }

  getPublicCallable(toolName: string): RegisteredTool | PublicToolCallable {
    const tool = this.#tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool '${toolName}' is not registered.`);
    }
    const ctxParam = this.#contextParams.get(toolName);
    if (!ctxParam) {
      return tool;
    }
    const fn = innerFn(tool);
    const publicCallable = ((...args: unknown[]) => fn(...args)) as PublicToolCallable;
    Object.defineProperty(publicCallable, "name", {
      value: callableName(tool),
      configurable: true,
    });
    publicCallable.parameterNames = this.#publicParamNames.get(toolName) ?? [];
    if (tool instanceof ToolWithSchema) {
      publicCallable.inputSchema = tool.inputSchema;
      publicCallable.description = tool.description;
    }
    return publicCallable;
  }

  get_public_callable(toolName: string): RegisteredTool | PublicToolCallable {
    return this.getPublicCallable(toolName);
  }

  getPublicInputSchema(toolName: string): Record<string, unknown> {
    const tool = this.#tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool '${toolName}' is not registered.`);
    }
    if (tool instanceof ToolWithSchema) {
      return tool.inputSchema;
    }
    return inferredObjectSchema(this.#publicParamNames.get(toolName) ?? []);
  }

  get_public_input_schema(toolName: string): Record<string, unknown> {
    return this.getPublicInputSchema(toolName);
  }

  getPublicParameterNames(toolName: string): string[] {
    if (!this.#tools.has(toolName)) {
      throw new Error(`Tool '${toolName}' is not registered.`);
    }
    return [...(this.#publicParamNames.get(toolName) ?? [])];
  }

  get_public_parameter_names(toolName: string): string[] {
    return this.getPublicParameterNames(toolName);
  }

  getToolDescription(toolName: string): string {
    const tool = this.#tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool '${toolName}' is not registered.`);
    }
    if (tool instanceof ToolWithSchema) {
      return tool.description;
    }
    return toolDescription(innerFn(tool));
  }

  get_tool_description(toolName: string): string {
    return this.getToolDescription(toolName);
  }

  #injectContext(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
    const ctxParam = this.#contextParams.get(toolName);
    if (ctxParam && this.#context && !(ctxParam in args)) {
      return { ...args, [ctxParam]: this.#context };
    }
    return args;
  }

  async #executeFn(fn: TypeScriptTool, args: Record<string, unknown>): Promise<unknown> {
    const paramNames = parseParamNames(fn);
    let result: unknown;
    if (paramNames.length === 0 || paramNames[0]?.startsWith("{") || paramNames[0] === "args") {
      result = fn(args);
    } else {
      result = fn(...paramNames.map((name) => args[name]));
    }
    return await result;
  }

  async execute(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const tool = this.#tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool '${toolName}' is not registered.`);
    }
    return await this.#executeFn(innerFn(tool), this.#injectContext(toolName, args));
  }

  async processToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    return await Promise.all(
      toolCalls.map(async (toolCall) => {
        try {
          if (!this.#tools.has(String(toolCall.name))) {
            return new ToolResult({
              name: toolCall.name,
              id: toolCall.id,
              error: `Unknown tool: '${toolCall.name}'`,
            });
          }
          const result = await this.execute(String(toolCall.name), toolCall.args);
          return new ToolResult({
            name: toolCall.name,
            id: toolCall.id,
            result,
          });
        } catch (error) {
          return new ToolResult({
            name: toolCall.name,
            id: toolCall.id,
            error: error instanceof Error ? error.message : String(error),
            exception: error,
          });
        }
      }),
    );
  }

  async process_tool_calls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    return await this.processToolCalls(toolCalls);
  }
}
