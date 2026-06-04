import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpSseServer, McpStdioServer, McpStreamableHttpServer, } from "../types.js";
import { ToolWithSchema } from "../tools/tool-runner.js";
export const MCP_TOOL_PREFIX = "mcp";
export function getMcpToolPrefix(serverName) {
    return serverName ? `${MCP_TOOL_PREFIX}_${serverName}_` : `${MCP_TOOL_PREFIX}_`;
}
export const get_mcp_tool_prefix = getMcpToolPrefix;
function sanitizeServerName(name) {
    return name.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}
export function componentToolName(toolName, serverName, serverReportedName) {
    const prefixName = serverName ?? sanitizeServerName(serverReportedName ?? "");
    return `${getMcpToolPrefix(prefixName)}${toolName}`;
}
export const component_tool_name = componentToolName;
function isToolAllowed(toolName, serverConfig) {
    if (serverConfig.enabledTools !== undefined) {
        return serverConfig.enabledTools.includes(toolName);
    }
    if (serverConfig.disabledTools !== undefined) {
        return !serverConfig.disabledTools.includes(toolName);
    }
    return true;
}
export async function getMcpTools(client, options = {}) {
    const { tools } = await client.listTools();
    return tools
        .map((tool) => {
        const prefixedName = componentToolName(tool.name, options.serverName, options.serverReportedName);
        return { ...tool, prefixedName };
    })
        .filter((tool) => !options.allowedNames || options.allowedNames.has(tool.prefixedName))
        .map((tool) => {
        const fn = async (args = {}) => {
            const argumentsObject = args && typeof args === "object" && !Array.isArray(args)
                ? args
                : {};
            return await client.callTool({ name: tool.name, arguments: argumentsObject });
        };
        Object.defineProperty(fn, "name", { value: tool.prefixedName });
        Object.defineProperty(fn, "description", { value: tool.description ?? "" });
        return new ToolWithSchema(fn, tool.inputSchema, tool.prefixedName);
    });
}
export const get_mcp_tools = getMcpTools;
async function defaultClientFactory(serverConfig) {
    const client = new Client({ name: "google-antigravity-typescript", version: "0.1.1-ts.0" }, { capabilities: {} });
    let transport;
    switch (serverConfig.type) {
        case "stdio":
            transport = new StdioClientTransport({
                command: serverConfig.command,
                args: serverConfig.args,
            });
            break;
        case "sse":
            transport = new SSEClientTransport(new URL(serverConfig.url), {
                requestInit: { headers: serverConfig.headers },
            });
            break;
        case "http":
            transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
                requestInit: { headers: serverConfig.headers },
            });
            break;
        default:
            throw new Error(`Unsupported MCP server type: ${serverConfig.type}`);
    }
    await client.connect(transport);
    return client;
}
export class McpBridge {
    #sessions = [];
    #tools = [];
    #allowedToolNames = new Set();
    #clientFactory;
    constructor(init = {}) {
        this.#clientFactory = init.clientFactory ?? defaultClientFactory;
    }
    get tools() {
        return [...this.#tools];
    }
    async connect(serverConfig) {
        const client = await this.#clientFactory(serverConfig);
        let connected = false;
        try {
            const { tools } = await client.listTools();
            const prefix = getMcpToolPrefix(serverConfig.name);
            const seenOriginalNames = new Set(tools.map((tool) => tool.name));
            if (serverConfig.enabledTools) {
                const invalid = serverConfig.enabledTools.filter((tool) => !seenOriginalNames.has(tool));
                if (invalid.length) {
                    throw new Error(`Configured enabled_tools do not exist on server '${serverConfig.name}': ${invalid.join(", ")}`);
                }
            }
            if (serverConfig.disabledTools) {
                const invalid = serverConfig.disabledTools.filter((tool) => !seenOriginalNames.has(tool));
                if (invalid.length) {
                    throw new Error(`Configured disabled_tools do not exist on server '${serverConfig.name}': ${invalid.join(", ")}`);
                }
            }
            this.#sessions.push({ client, serverName: serverConfig.name });
            connected = true;
            for (const tool of tools) {
                const prefixedName = `${prefix}${tool.name}`;
                if (isToolAllowed(tool.name, serverConfig)) {
                    this.#allowedToolNames.add(prefixedName);
                }
            }
            await this.#refreshTools();
        }
        finally {
            if (!connected) {
                await client.close?.();
            }
        }
    }
    async connectStdio(command, args = [], serverConfig) {
        await this.connect(serverConfig ?? new McpStdioServer({ name: "stdio", command, args }));
    }
    async connect_stdio(command, args = [], serverConfig) {
        await this.connectStdio(command, args, serverConfig);
    }
    async connectSse(url, headers, serverConfig) {
        await this.connect(serverConfig ?? new McpSseServer({ name: "sse", url, headers }));
    }
    async connect_sse(url, headers, serverConfig) {
        await this.connectSse(url, headers, serverConfig);
    }
    async connectStreamableHttp(init, headers, timeout, sseReadTimeout, terminateOnClose, serverConfig) {
        const options = typeof init === "string"
            ? {
                url: init,
                headers,
                timeout,
                sseReadTimeout,
                terminateOnClose,
                serverConfig,
            }
            : init;
        await this.connect(options.serverConfig ??
            new McpStreamableHttpServer({
                name: "http",
                url: options.url,
                headers: options.headers,
                timeout: options.timeout,
                sseReadTimeout: options.sseReadTimeout,
                terminateOnClose: options.terminateOnClose,
            }));
    }
    async connect_streamable_http(init, headers, timeout, sseReadTimeout, terminateOnClose, serverConfig) {
        const options = typeof init === "string"
            ? {
                url: init,
                headers,
                timeout,
                sseReadTimeout,
                terminateOnClose,
                serverConfig,
            }
            : {
                url: init.url,
                headers: init.headers,
                timeout: init.timeout,
                sseReadTimeout: init.sseReadTimeout ?? init.sse_read_timeout,
                terminateOnClose: init.terminateOnClose ?? init.terminate_on_close,
                serverConfig: init.serverConfig ?? init.server_cfg,
            };
        await this.connectStreamableHttp({
            url: options.url,
            headers: options.headers,
            timeout: options.timeout,
            sseReadTimeout: options.sseReadTimeout,
            terminateOnClose: options.terminateOnClose,
            serverConfig: options.serverConfig,
        });
    }
    async stop() {
        await Promise.allSettled(this.#sessions.map((session) => session.client.close?.()));
        this.#sessions = [];
        this.#tools = [];
        this.#allowedToolNames.clear();
    }
    async #refreshTools() {
        const toolGroups = await Promise.all(this.#sessions.map((session) => getMcpTools(session.client, {
            allowedNames: this.#allowedToolNames,
            serverName: session.serverName,
        })));
        this.#tools = toolGroups.flat();
    }
}
//# sourceMappingURL=bridge.js.map