import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { McpServerEntry, ProviderKind } from "contracts";

export interface ProviderMcpDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ProviderMcpToolExecutor {
  readonly title: string;
  readonly execute: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface ProviderMcpToolRuntime {
  readonly descriptors: ReadonlyArray<ProviderMcpDescriptor>;
  readonly executors: ReadonlyMap<string, ProviderMcpToolExecutor>;
  readonly warnings: ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

export interface BuildProviderMcpToolRuntimeOptions {
  readonly createClient?: (input: {
    readonly entry: McpServerEntry;
    readonly cwd?: string;
  }) => Promise<MCPClient>;
  readonly connectTimeoutMs?: number;
  readonly listToolsTimeoutMs?: number;
}

const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MCP_LIST_TOOLS_TIMEOUT_MS = 10_000;

export function filterMcpServersForProvider(
  provider: ProviderKind,
  servers: ReadonlyArray<McpServerEntry>,
): ReadonlyArray<McpServerEntry> {
  return servers.filter((server) => {
    if (!server.enabled) return false;
    return server.providers.length === 0 || server.providers.includes(provider);
  });
}

function sanitizeIdentifier(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
}

function prefixedShioriToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeIdentifier(serverName, "server")}__${sanitizeIdentifier(toolName, "tool")}`;
}

function resolveMcpToolDescription(tool: {
  readonly description?: string | undefined;
  readonly title?: string | undefined;
  readonly name: string;
}): string {
  if (typeof tool.description === "string" && tool.description.trim().length > 0) {
    return tool.description;
  }
  if (typeof tool.title === "string" && tool.title.trim().length > 0) {
    return tool.title;
  }
  return tool.name;
}

async function createMcpClientForEntry(input: {
  readonly entry: McpServerEntry;
  readonly cwd?: string;
}): Promise<MCPClient> {
  switch (input.entry.transport) {
    case "stdio": {
      const command = input.entry.command?.trim();
      if (!command) {
        throw new Error(`MCP server '${input.entry.name}' is missing a command.`);
      }
      return await createMCPClient({
        transport: new Experimental_StdioMCPTransport({
          command,
          ...(input.entry.args ? { args: [...input.entry.args] } : {}),
          ...(input.entry.env ? { env: { ...input.entry.env } } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
        }),
      });
    }
    case "http":
    case "sse": {
      const url = input.entry.url?.trim();
      if (!url) {
        throw new Error(`MCP server '${input.entry.name}' is missing a URL.`);
      }
      return await createMCPClient({
        transport: {
          type: input.entry.transport,
          url,
          ...(input.entry.headers ? { headers: { ...input.entry.headers } } : {}),
          redirect: "error",
        },
      });
    }
  }
}

function normalizeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return fallback;
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  if (timeoutMs <= 0) {
    return operation;
  }

  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function safelyCloseClient(client: MCPClient): Promise<void> {
  await Promise.allSettled([client.close()]);
}

export async function buildProviderMcpToolRuntime(
  input: {
    readonly provider: ProviderKind;
    readonly servers: ReadonlyArray<McpServerEntry>;
    readonly cwd?: string;
  },
  options: BuildProviderMcpToolRuntimeOptions = {},
): Promise<ProviderMcpToolRuntime> {
  // ShioriCode-native MCP runtime:
  // - resolves provider-scoped servers from ShioriCode settings
  // - connects to each server in isolation (no single-server fail-stop)
  // - exposes namespaced tool descriptors/executors for hosted Shiori turns
  const createClient = options.createClient ?? createMcpClientForEntry;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;
  const listToolsTimeoutMs = options.listToolsTimeoutMs ?? DEFAULT_MCP_LIST_TOOLS_TIMEOUT_MS;
  const providerServers = filterMcpServersForProvider(input.provider, input.servers);

  const clients: MCPClient[] = [];
  const descriptors: ProviderMcpDescriptor[] = [];
  const executors = new Map<string, ProviderMcpToolExecutor>();
  const warnings: string[] = [];
  let closed = false;

  const serverResults = await Promise.allSettled(
    providerServers.map(async (entry) => {
      let client: MCPClient | null = null;
      try {
        client = await withTimeout(
          createClient({
            entry,
            ...(input.cwd ? { cwd: input.cwd } : {}),
          }),
          connectTimeoutMs,
          `Timed out connecting to MCP server '${entry.name}' after ${connectTimeoutMs}ms.`,
        );

        const definitions = await withTimeout(
          client.listTools(),
          listToolsTimeoutMs,
          `Timed out loading tools from MCP server '${entry.name}' after ${listToolsTimeoutMs}ms.`,
        );

        const toolSet = client.toolsFromDefinitions(definitions);
        return { entry, client, definitions, toolSet };
      } catch (error) {
        if (client) {
          await safelyCloseClient(client);
        }
        throw error;
      }
    }),
  );

  for (let index = 0; index < serverResults.length; index += 1) {
    const result = serverResults[index];
    const entry = providerServers[index];
    if (!result || !entry) {
      continue;
    }

    if (result.status === "rejected") {
      warnings.push(
        `Failed to initialize MCP server '${entry.name}' (${entry.transport}): ${normalizeErrorMessage(
          result.reason,
          "unknown error",
        )}`,
      );
      continue;
    }

    const { client, definitions, toolSet } = result.value;
    clients.push(client);

    for (const tool of definitions.tools) {
      const prefixedName = prefixedShioriToolName(entry.name, tool.name);
      if (executors.has(prefixedName)) {
        warnings.push(`Skipping duplicate MCP tool '${tool.name}' from server '${entry.name}'.`);
        continue;
      }

      const executable = toolSet[tool.name as keyof typeof toolSet] as
        | {
            execute: (input: Record<string, unknown>, options: unknown) => unknown;
          }
        | undefined;
      if (!executable || typeof executable.execute !== "function") {
        warnings.push(
          `Skipping MCP tool '${tool.name}' from server '${entry.name}' because it is not executable.`,
        );
        continue;
      }

      descriptors.push({
        name: prefixedName,
        title:
          typeof tool.title === "string" && tool.title.trim().length > 0
            ? `${entry.name} · ${tool.title}`
            : `${entry.name} · ${tool.name}`,
        description: resolveMcpToolDescription(tool),
        inputSchema:
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? (tool.inputSchema as Record<string, unknown>)
            : {
                type: "object",
                properties: {},
                additionalProperties: true,
              },
      });

      executors.set(prefixedName, {
        title:
          typeof tool.title === "string" && tool.title.trim().length > 0
            ? `${entry.name} · ${tool.title}`
            : `${entry.name} · ${tool.name}`,
        execute: async (toolInput) =>
          await Promise.resolve(
            executable.execute(toolInput, {
              messages: [],
              toolCallId: prefixedName,
            } as unknown),
          ),
      });
    }
  }

  return {
    descriptors,
    executors,
    warnings,
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };
}

function escapeTomlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/"/g, '\\"')}"`;
}

export function buildCodexManagedMcpConfigFragment(
  servers: ReadonlyArray<McpServerEntry>,
): string | null {
  const managedServers = filterMcpServersForProvider("codex", servers).filter(
    (server) => server.transport === "stdio",
  );
  if (managedServers.length === 0) {
    return null;
  }

  const lines: string[] = ["# ShioriCode managed MCP servers"];
  for (const server of managedServers) {
    const tableName = `shioricode_${sanitizeIdentifier(server.name, "server")}`;
    const command = server.command?.trim();
    if (!command) {
      continue;
    }
    lines.push("", `[mcp_servers.${tableName}]`);
    lines.push(`command = ${escapeTomlString(command)}`);
    if (server.args && server.args.length > 0) {
      lines.push(`args = [${server.args.map(escapeTomlString).join(", ")}]`);
    }
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push(`[mcp_servers.${tableName}.env]`);
      for (const [key, value] of Object.entries(server.env)) {
        lines.push(`${key} = ${escapeTomlString(value)}`);
      }
    }
  }

  return lines.length > 1 ? `${lines.join("\n")}\n` : null;
}

function resolveCodexHomePath(homePath?: string): string {
  return homePath?.trim() ? homePath.trim() : path.join(homedir(), ".codex");
}

async function maybeCopyFile(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await copyFile(sourcePath, targetPath);
  } catch {
    // Missing optional files are fine.
  }
}

export async function prepareCodexHomeWithManagedMcpServers(input: {
  readonly threadId: string;
  readonly runtimeRootDir: string;
  readonly homePath?: string;
  readonly servers: ReadonlyArray<McpServerEntry>;
}): Promise<{ homePath: string; cleanup: () => Promise<void> } | null> {
  const managedFragment = buildCodexManagedMcpConfigFragment(input.servers);
  if (!managedFragment) {
    return null;
  }

  const sourceHome = resolveCodexHomePath(input.homePath);
  const targetHome = path.join(
    input.runtimeRootDir,
    "codex-mcp-homes",
    sanitizeIdentifier(input.threadId, "thread"),
    randomUUID(),
  );

  await mkdir(targetHome, { recursive: true });
  await maybeCopyFile(path.join(sourceHome, "auth.json"), path.join(targetHome, "auth.json"));

  const baseConfig = await readFile(path.join(sourceHome, "config.toml"), "utf8").catch(() => "");
  const mergedConfig =
    baseConfig.trim().length > 0
      ? `${baseConfig.trimEnd()}\n\n${managedFragment}`
      : managedFragment;
  await writeFile(path.join(targetHome, "config.toml"), mergedConfig, "utf8");

  return {
    homePath: targetHome,
    cleanup: async () => {
      await rm(targetHome, { recursive: true, force: true });
    },
  };
}
