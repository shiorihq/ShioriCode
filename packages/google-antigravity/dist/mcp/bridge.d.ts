import { McpServerConfig } from "../types.js";
import { ToolWithSchema } from "../tools/tool-runner.js";
export declare const MCP_TOOL_PREFIX = "mcp";
export declare function getMcpToolPrefix(serverName?: string): string;
export declare const get_mcp_tool_prefix: typeof getMcpToolPrefix;
export declare function componentToolName(toolName: string, serverName?: string, serverReportedName?: string): string;
export declare const component_tool_name: typeof componentToolName;
export type McpToolInfo = {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
};
export type McpClientLike = {
    listTools(): Promise<{
        tools: McpToolInfo[];
    }>;
    callTool(params: {
        name: string;
        arguments?: Record<string, unknown>;
    }): Promise<unknown>;
    close?(): Promise<void>;
};
export type McpClientFactory = (serverConfig: McpServerConfig) => Promise<McpClientLike>;
export declare function getMcpTools(client: McpClientLike, options?: {
    allowedNames?: Set<string>;
    serverName?: string;
    serverReportedName?: string;
}): Promise<ToolWithSchema[]>;
export declare const get_mcp_tools: typeof getMcpTools;
export declare class McpBridge {
    #private;
    constructor(init?: {
        clientFactory?: McpClientFactory;
    });
    get tools(): ToolWithSchema[];
    connect(serverConfig: McpServerConfig): Promise<void>;
    connectStdio(command: string, args?: string[], serverConfig?: McpServerConfig): Promise<void>;
    connect_stdio(command: string, args?: string[], serverConfig?: McpServerConfig): Promise<void>;
    connectSse(url: string, headers?: Record<string, string>, serverConfig?: McpServerConfig): Promise<void>;
    connect_sse(url: string, headers?: Record<string, string>, serverConfig?: McpServerConfig): Promise<void>;
    connectStreamableHttp(init: string | {
        url: string;
        headers?: Record<string, string>;
        timeout?: number;
        sseReadTimeout?: number;
        terminateOnClose?: boolean;
        serverConfig?: McpServerConfig;
    }, headers?: Record<string, string>, timeout?: number, sseReadTimeout?: number, terminateOnClose?: boolean, serverConfig?: McpServerConfig): Promise<void>;
    connect_streamable_http(init: string | {
        url: string;
        headers?: Record<string, string>;
        timeout?: number;
        sseReadTimeout?: number;
        sse_read_timeout?: number;
        terminateOnClose?: boolean;
        terminate_on_close?: boolean;
        serverConfig?: McpServerConfig;
        server_cfg?: McpServerConfig;
    }, headers?: Record<string, string>, timeout?: number, sseReadTimeout?: number, terminateOnClose?: boolean, serverConfig?: McpServerConfig): Promise<void>;
    stop(): Promise<void>;
}
//# sourceMappingURL=bridge.d.ts.map