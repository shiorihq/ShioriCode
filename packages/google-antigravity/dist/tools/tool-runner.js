import { ToolResult } from "../types.js";
export class ToolWithSchema {
    fn;
    inputSchema;
    name;
    description;
    __name__;
    __doc__;
    constructor(fn, inputSchema, name = fn.name, description = toolDescription(fn)) {
        this.fn = fn;
        this.inputSchema = inputSchema;
        this.name = name;
        this.description = description;
        this.__name__ = name;
        this.__doc__ = description;
    }
    get input_schema() {
        return this.inputSchema;
    }
    set input_schema(value) {
        this.inputSchema = value;
    }
    call(...args) {
        return this.fn(...args);
    }
}
function callableName(tool) {
    return tool instanceof ToolWithSchema ? tool.name : tool.name;
}
function innerFn(tool) {
    return tool instanceof ToolWithSchema ? tool.fn : tool;
}
function toolDescription(fn) {
    const explicitDescription = fn.description;
    if (typeof explicitDescription === "string") {
        return explicitDescription;
    }
    return (fn
        .toString()
        .match(/\/\*\*([\s\S]*?)\*\//)?.[1]
        ?.trim() ?? "");
}
function parseParamNames(fn) {
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
function contextParamName(fn) {
    return parseParamNames(fn).find((name) => ["ctx", "context", "toolContext"].includes(name));
}
function publicParamNames(fn) {
    return parseParamNames(fn).filter((name) => !["ctx", "context", "toolContext"].includes(name));
}
function inferredObjectSchema(parameterNames) {
    if (parameterNames.length === 0 ||
        parameterNames[0]?.startsWith("{") ||
        parameterNames[0] === "args") {
        return { type: "object" };
    }
    return {
        type: "object",
        properties: Object.fromEntries(parameterNames.map((name) => [name, {}])),
        required: parameterNames,
    };
}
export class ToolRunner {
    #tools = new Map();
    #context;
    #contextParams = new Map();
    #publicParamNames = new Map();
    constructor(tools = []) {
        for (const tool of tools) {
            this.register(tool);
        }
    }
    setContext(ctx) {
        this.#context = ctx;
    }
    set_context(ctx) {
        this.setContext(ctx);
    }
    register(tool, name) {
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
    unregister(name) {
        if (!this.#tools.delete(name)) {
            throw new Error(`Tool '${name}' is not registered.`);
        }
        this.#contextParams.delete(name);
        this.#publicParamNames.delete(name);
    }
    get toolNames() {
        return [...this.#tools.keys()];
    }
    get tool_names() {
        return this.toolNames;
    }
    get tools() {
        return Object.fromEntries(this.#tools);
    }
    getPublicCallable(toolName) {
        const tool = this.#tools.get(toolName);
        if (!tool) {
            throw new Error(`Tool '${toolName}' is not registered.`);
        }
        const ctxParam = this.#contextParams.get(toolName);
        if (!ctxParam) {
            return tool;
        }
        const fn = innerFn(tool);
        const publicCallable = ((...args) => fn(...args));
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
    get_public_callable(toolName) {
        return this.getPublicCallable(toolName);
    }
    getPublicInputSchema(toolName) {
        const tool = this.#tools.get(toolName);
        if (!tool) {
            throw new Error(`Tool '${toolName}' is not registered.`);
        }
        if (tool instanceof ToolWithSchema) {
            return tool.inputSchema;
        }
        return inferredObjectSchema(this.#publicParamNames.get(toolName) ?? []);
    }
    get_public_input_schema(toolName) {
        return this.getPublicInputSchema(toolName);
    }
    getPublicParameterNames(toolName) {
        if (!this.#tools.has(toolName)) {
            throw new Error(`Tool '${toolName}' is not registered.`);
        }
        return [...(this.#publicParamNames.get(toolName) ?? [])];
    }
    get_public_parameter_names(toolName) {
        return this.getPublicParameterNames(toolName);
    }
    getToolDescription(toolName) {
        const tool = this.#tools.get(toolName);
        if (!tool) {
            throw new Error(`Tool '${toolName}' is not registered.`);
        }
        if (tool instanceof ToolWithSchema) {
            return tool.description;
        }
        return toolDescription(innerFn(tool));
    }
    get_tool_description(toolName) {
        return this.getToolDescription(toolName);
    }
    #injectContext(toolName, args) {
        const ctxParam = this.#contextParams.get(toolName);
        if (ctxParam && this.#context && !(ctxParam in args)) {
            return { ...args, [ctxParam]: this.#context };
        }
        return args;
    }
    async #executeFn(fn, args) {
        const paramNames = parseParamNames(fn);
        let result;
        if (paramNames.length === 0 || paramNames[0]?.startsWith("{") || paramNames[0] === "args") {
            result = fn(args);
        }
        else {
            result = fn(...paramNames.map((name) => args[name]));
        }
        return await result;
    }
    async execute(toolName, args = {}) {
        const tool = this.#tools.get(toolName);
        if (!tool) {
            throw new Error(`Tool '${toolName}' is not registered.`);
        }
        return await this.#executeFn(innerFn(tool), this.#injectContext(toolName, args));
    }
    async processToolCalls(toolCalls) {
        return await Promise.all(toolCalls.map(async (toolCall) => {
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
            }
            catch (error) {
                return new ToolResult({
                    name: toolCall.name,
                    id: toolCall.id,
                    error: error instanceof Error ? error.message : String(error),
                    exception: error,
                });
            }
        }));
    }
    async process_tool_calls(toolCalls) {
        return await this.processToolCalls(toolCalls);
    }
}
//# sourceMappingURL=tool-runner.js.map