import { BuiltinTools, CapabilitiesConfig, CustomSystemInstructions, McpSseServer, McpStdioServer, McpStreamableHttpServer, TemplatedSystemInstructions, } from "../types.js";
export class ConnectionStrategy {
}
export class AgentConfig {
    systemInstructions;
    capabilities;
    tools;
    policies;
    hooks;
    triggers;
    mcpServers;
    workspaces;
    conversationId;
    saveDir;
    appDataDir;
    responseSchema;
    skillsPaths;
    constructor(init = {}) {
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
    get system_instructions() {
        return this.systemInstructions;
    }
    set system_instructions(value) {
        this.systemInstructions = value;
    }
    get mcp_servers() {
        return this.mcpServers;
    }
    set mcp_servers(value) {
        this.mcpServers = value;
    }
    get conversation_id() {
        return this.conversationId;
    }
    set conversation_id(value) {
        this.conversationId = value;
    }
    get save_dir() {
        return this.saveDir;
    }
    set save_dir(value) {
        this.saveDir = value;
    }
    get app_data_dir() {
        return this.appDataDir;
    }
    set app_data_dir(value) {
        this.appDataDir = value;
    }
    get response_schema() {
        return this.responseSchema;
    }
    set response_schema(value) {
        this.responseSchema = validateResponseSchema(value);
    }
    get skills_paths() {
        return this.skillsPaths;
    }
    set skills_paths(value) {
        this.skillsPaths = value;
    }
    create_strategy(args) {
        return this.createStrategy({
            toolRunner: args.toolRunner ?? args.tool_runner,
            hookRunner: args.hookRunner ?? args.hook_runner,
        });
    }
    clone() {
        const clone = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
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
export function cloneCapabilitiesConfig(config) {
    return new CapabilitiesConfig({
        enableSubagents: config.enableSubagents,
        enabledTools: config.enabledTools ? [...config.enabledTools] : undefined,
        disabledTools: config.disabledTools ? [...config.disabledTools] : undefined,
        compactionThreshold: config.compactionThreshold,
        imageModel: config.imageModel,
        finishToolSchemaJson: config.finishToolSchemaJson,
    });
}
export function cloneSystemInstructions(instructions) {
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
export function cloneMcpServerConfig(config) {
    const filters = {
        enabledTools: config.enabledTools ? [...config.enabledTools] : undefined,
        disabledTools: config.disabledTools ? [...config.disabledTools] : undefined,
    };
    if (config instanceof McpStdioServer) {
        return new McpStdioServer({
            name: config.name,
            command: config.command,
            args: [...config.args],
            env: config.env ? { ...config.env } : undefined,
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
function validateResponseSchema(schema) {
    if (schema === undefined || schema === null) {
        return undefined;
    }
    if (typeof schema === "string") {
        try {
            JSON.parse(schema);
        }
        catch (error) {
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
    throw new Error(`Unsupported response_schema format: ${typeof schema}. Expected a JSON string, object, or Zod schema.`);
}
function isJsonSchemaConvertible(schema) {
    return typeof schema.toJSONSchema === "function";
}
function isPlainObject(value) {
    return (value !== null &&
        typeof value === "object" &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}
//# sourceMappingURL=connection.js.map