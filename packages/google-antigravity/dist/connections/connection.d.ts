import { CapabilitiesConfig, Content, McpServerConfig, SystemInstructions, TypeScriptTool } from "../types.js";
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
export declare abstract class ConnectionStrategy {
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
export declare abstract class AgentConfig {
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
    protected constructor(init?: AgentConfigInit);
    get system_instructions(): string | SystemInstructions | undefined;
    set system_instructions(value: string | SystemInstructions | undefined);
    get mcp_servers(): McpServerConfig[];
    set mcp_servers(value: McpServerConfig[]);
    get conversation_id(): string | undefined;
    set conversation_id(value: string | undefined);
    get save_dir(): string | undefined;
    set save_dir(value: string | undefined);
    get app_data_dir(): string | undefined;
    set app_data_dir(value: string | undefined);
    get response_schema(): string | undefined;
    set response_schema(value: JsonSchemaObject | JsonSchemaConvertible | string | null | undefined);
    get skills_paths(): string[];
    set skills_paths(value: string[]);
    abstract createStrategy(args: CreateStrategyArgs): ConnectionStrategy;
    create_strategy(args: CreateStrategyArgs): ConnectionStrategy;
    clone(): AgentConfig;
}
export declare function cloneCapabilitiesConfig(config: CapabilitiesConfig): CapabilitiesConfig;
export declare function cloneSystemInstructions(instructions: string | SystemInstructions | undefined): string | SystemInstructions | undefined;
export declare function cloneMcpServerConfig(config: McpServerConfig): McpServerConfig;
export {};
//# sourceMappingURL=connection.d.ts.map