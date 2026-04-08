import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { MCPClient } from "@ai-sdk/mcp";
import type { McpServerEntry } from "contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildProviderMcpToolRuntime,
  buildCodexManagedMcpConfigFragment,
  filterMcpServersForProvider,
  prepareCodexHomeWithManagedMcpServers,
} from "./mcpServers.ts";

const TEMP_DIRS = new Set<string>();

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.add(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of TEMP_DIRS) {
    await rm(dir, { recursive: true, force: true });
  }
  TEMP_DIRS.clear();
});

function makeFakeMcpClient(input: {
  tools: Array<{
    name: string;
    title?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    execute?: (toolInput: Record<string, unknown>, options: unknown) => unknown;
  }>;
  close?: () => Promise<void>;
}): MCPClient {
  const toolsWithoutExecute = input.tools.map((tool) => ({
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
  }));

  return {
    listTools: async () => ({ tools: toolsWithoutExecute }),
    toolsFromDefinitions: () =>
      Object.fromEntries(
        input.tools
          .filter(
            (
              tool,
            ): tool is typeof tool & {
              execute: (toolInput: Record<string, unknown>, options: unknown) => unknown;
            } => typeof tool.execute === "function",
          )
          .map((tool) => [tool.name, { execute: tool.execute }]),
      ),
    close: input.close ?? (async () => undefined),
  } as unknown as MCPClient;
}

describe("filterMcpServersForProvider", () => {
  it("includes enabled global servers and provider-targeted servers only", () => {
    const servers: McpServerEntry[] = [
      {
        name: "global",
        transport: "stdio",
        command: "node",
        enabled: true,
        providers: [],
      },
      {
        name: "shiori-only",
        transport: "stdio",
        command: "node",
        enabled: true,
        providers: ["shiori"],
      },
      {
        name: "disabled",
        transport: "stdio",
        command: "node",
        enabled: false,
        providers: [],
      },
    ];

    expect(filterMcpServersForProvider("shiori", servers).map((server) => server.name)).toEqual([
      "global",
      "shiori-only",
    ]);
    expect(filterMcpServersForProvider("codex", servers).map((server) => server.name)).toEqual([
      "global",
    ]);
  });
});

describe("buildCodexManagedMcpConfigFragment", () => {
  it("serializes only stdio MCP servers for Codex", () => {
    const fragment = buildCodexManagedMcpConfigFragment([
      {
        name: "GitHub",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "secret" },
        enabled: true,
        providers: ["codex"],
      },
      {
        name: "Remote",
        transport: "http",
        url: "https://example.com/mcp",
        enabled: true,
        providers: ["codex"],
      },
    ]);

    assert.ok(fragment);
    assert.match(fragment, /\[mcp_servers\.shioricode_github\]/);
    assert.match(fragment, /command = "npx"/);
    assert.match(fragment, /args = \["-y", "@modelcontextprotocol\/server-github"\]/);
    assert.match(fragment, /\[mcp_servers\.shioricode_github\.env\]/);
    assert.match(fragment, /GITHUB_TOKEN = "secret"/);
    assert.doesNotMatch(fragment, /example\.com\/mcp/);
  });
});

describe("buildProviderMcpToolRuntime", () => {
  it("continues loading healthy servers when one server fails", async () => {
    let closedCount = 0;
    const healthyClient = makeFakeMcpClient({
      tools: [
        {
          name: "lookup_weather",
          description: "Look up weather.",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
            additionalProperties: false,
          },
          execute: async (toolInput) => ({ city: toolInput.city, forecast: "sunny" }),
        },
      ],
      close: async () => {
        closedCount += 1;
      },
    });

    const runtime = await buildProviderMcpToolRuntime(
      {
        provider: "shiori",
        servers: [
          {
            name: "Good",
            transport: "http",
            url: "https://good.example/mcp",
            enabled: true,
            providers: ["shiori"],
          },
          {
            name: "Bad",
            transport: "sse",
            url: "https://bad.example/sse",
            enabled: true,
            providers: ["shiori"],
          },
        ],
      },
      {
        createClient: async ({ entry }) => {
          if (entry.name === "Bad") {
            throw new Error("Connection refused");
          }
          return healthyClient;
        },
      },
    );

    expect(runtime.descriptors.map((descriptor) => descriptor.name)).toEqual([
      "mcp__good__lookup_weather",
    ]);
    expect(
      runtime.warnings.some((warning) =>
        warning.includes("Failed to initialize MCP server 'Bad' (sse): Connection refused"),
      ),
    ).toEqual(true);

    const executor = runtime.executors.get("mcp__good__lookup_weather");
    expect(executor).toBeDefined();
    const output = await executor?.execute({ city: "Zurich" });
    expect(output).toEqual({ city: "Zurich", forecast: "sunny" });

    await runtime.close();
    await runtime.close();
    expect(closedCount).toEqual(1);
  });

  it("times out slow MCP connections and continues with available servers", async () => {
    const fastClient = makeFakeMcpClient({
      tools: [
        {
          name: "ping",
          execute: async () => ({ ok: true }),
        },
      ],
    });

    const runtime = await buildProviderMcpToolRuntime(
      {
        provider: "shiori",
        servers: [
          {
            name: "Fast",
            transport: "http",
            url: "https://fast.example/mcp",
            enabled: true,
            providers: ["shiori"],
          },
          {
            name: "Slow",
            transport: "http",
            url: "https://slow.example/mcp",
            enabled: true,
            providers: ["shiori"],
          },
        ],
      },
      {
        connectTimeoutMs: 20,
        createClient: async ({ entry }) => {
          if (entry.name === "Slow") {
            return await new Promise<MCPClient>(() => {
              // Intentionally unresolved to assert timeout handling.
            });
          }
          return fastClient;
        },
      },
    );

    expect(runtime.descriptors.map((descriptor) => descriptor.name)).toEqual(["mcp__fast__ping"]);
    expect(
      runtime.warnings.some((warning) =>
        warning.includes("Timed out connecting to MCP server 'Slow' after 20ms."),
      ),
    ).toEqual(true);

    await runtime.close();
  });

  it("skips duplicate namespaced tool collisions with warnings", async () => {
    const firstClient = makeFakeMcpClient({
      tools: [{ name: "lookup weather", execute: async () => ({ from: "first" }) }],
    });
    const secondClient = makeFakeMcpClient({
      tools: [{ name: "lookup@weather", execute: async () => ({ from: "second" }) }],
    });

    const runtime = await buildProviderMcpToolRuntime(
      {
        provider: "shiori",
        servers: [
          {
            name: "Demo API",
            transport: "http",
            url: "https://one.example/mcp",
            enabled: true,
            providers: ["shiori"],
          },
          {
            name: "demo_api",
            transport: "http",
            url: "https://two.example/mcp",
            enabled: true,
            providers: ["shiori"],
          },
        ],
      },
      {
        createClient: async ({ entry }) => (entry.name === "Demo API" ? firstClient : secondClient),
      },
    );

    expect(runtime.descriptors.map((descriptor) => descriptor.name)).toEqual([
      "mcp__demo_api__lookup_weather",
    ]);
    expect(
      runtime.warnings.some((warning) =>
        warning.includes("Skipping duplicate MCP tool 'lookup@weather' from server 'demo_api'."),
      ),
    ).toEqual(true);

    const executor = runtime.executors.get("mcp__demo_api__lookup_weather");
    const output = await executor?.execute({});
    expect(output).toEqual({ from: "first" });

    await runtime.close();
  });
});

describe("prepareCodexHomeWithManagedMcpServers", () => {
  it("creates an isolated CODEX_HOME with managed MCP config appended", async () => {
    const sourceHome = await createTempDir("codex-home-source-");
    const runtimeRoot = await createTempDir("codex-home-runtime-");
    await writeFile(path.join(sourceHome, "auth.json"), '{"access_token":"token"}', "utf8");
    await writeFile(path.join(sourceHome, "config.toml"), 'model = "gpt-5"\n', "utf8");

    const prepared = await prepareCodexHomeWithManagedMcpServers({
      threadId: "thread-1",
      runtimeRootDir: runtimeRoot,
      homePath: sourceHome,
      servers: [
        {
          name: "filesystem",
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          enabled: true,
          providers: ["codex"],
        },
      ],
    });

    assert.ok(prepared);
    const auth = await readFile(path.join(prepared.homePath, "auth.json"), "utf8");
    const config = await readFile(path.join(prepared.homePath, "config.toml"), "utf8");

    assert.equal(auth, '{"access_token":"token"}');
    assert.match(config, /model = "gpt-5"/);
    assert.match(config, /\[mcp_servers\.shioricode_filesystem\]/);
    assert.match(config, /args = \["server\.js"\]/);

    await prepared.cleanup();
  });
});
