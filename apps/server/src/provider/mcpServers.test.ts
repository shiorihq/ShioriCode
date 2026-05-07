import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { MCPClient } from "@ai-sdk/mcp";
import type { McpServerEntry } from "contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildCodexLeanAppServerConfig,
  listEffectiveMcpServerRows,
  buildProviderMcpToolRuntime,
  buildCodexManagedMcpConfigFragment,
  discoverClaudeMcpServers,
  discoverCodexMcpServers,
  filterMcpServersForProvider,
  loadEffectiveMcpServersForProvider,
  loadCodexManagedMcpServers,
  prepareCodexHomeWithManagedMcpServers,
  removeExternalMcpServer,
  toAcpMcpServers,
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

describe("toAcpMcpServers", () => {
  it("adds built-in browser and computer MCP servers when enabled", () => {
    const servers = toAcpMcpServers(
      "gemini",
      {
        browserUse: { enabled: true },
        computerUse: { enabled: true, requireApproval: false },
        mcpServers: { servers: [] },
      } as never,
      undefined,
      {
        browserPanel: {
          config: {
            host: "0.0.0.0",
            port: 4321,
            authToken: "secret-token",
          } as never,
          threadId: "thread-browser" as never,
        },
      },
    );

    expect(servers.map((server) => server.name)).toEqual([
      "shioricode-browser",
      "shioricode-computer",
    ]);
    expect(servers[0]).toMatchObject({
      command: process.execPath,
      args: expect.arrayContaining(["browser-panel-mcp"]),
      env: expect.arrayContaining([
        {
          name: "SHIORICODE_BROWSER_CONTROL_URL",
          value: "http://127.0.0.1:4321/api/browser-panel/command",
        },
        { name: "SHIORICODE_BROWSER_THREAD_ID", value: "thread-browser" },
        { name: "SHIORICODE_BROWSER_CONTROL_TOKEN", value: "secret-token" },
      ]),
    });
    expect(servers[1]).toMatchObject({
      command: process.execPath,
      args: expect.arrayContaining(["computer-use-mcp"]),
      env: expect.arrayContaining([
        { name: "SHIORICODE_COMPUTER_USE_ENABLED", value: "1" },
        { name: "SHIORICODE_COMPUTER_USE_REQUIRE_APPROVAL", value: "0" },
      ]),
    });
  });

  it("does not expose the built-in computer MCP server while approvals are required", () => {
    const servers = toAcpMcpServers(
      "gemini",
      {
        browserUse: { enabled: true },
        computerUse: { enabled: true, requireApproval: true },
        mcpServers: { servers: [] },
      } as never,
      undefined,
      {
        browserPanel: {
          config: {
            host: "0.0.0.0",
            port: 4321,
            authToken: "secret-token",
          } as never,
          threadId: "thread-browser" as never,
        },
      },
    );

    expect(servers.map((server) => server.name)).toEqual(["shioricode-browser"]);
  });

  it("does not expose built-in MCP servers when their settings are disabled", () => {
    const servers = toAcpMcpServers(
      "cursor",
      {
        browserUse: { enabled: false },
        computerUse: { enabled: false, requireApproval: true },
        mcpServers: { servers: [] },
      } as never,
      undefined,
      {
        browserPanel: {
          config: { host: "127.0.0.1", port: 4321 } as never,
          threadId: "thread-browser" as never,
        },
      },
    );

    expect(servers).toEqual([]);
  });
});

describe("buildCodexManagedMcpConfigFragment", () => {
  it("serializes stdio and remote MCP servers for Codex", () => {
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
        headers: { "X-Static": "static" },
        envHttpHeaders: { "X-Team": "MCP_TEAM" },
        oauthScopes: ["read", "write"],
        oauthResource: "https://example.com/mcp",
        enabled: true,
        providers: ["codex"],
      },
      {
        name: "Events",
        transport: "sse",
        url: "https://example.com/sse",
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
    assert.match(fragment, /\[mcp_servers\.shioricode_remote\]/);
    assert.match(fragment, /url = "https:\/\/example\.com\/mcp"/);
    assert.match(fragment, /scopes = \["read", "write"\]/);
    assert.match(fragment, /oauth_resource = "https:\/\/example\.com\/mcp"/);
    assert.match(fragment, /\[mcp_servers\.shioricode_remote\.http_headers\]/);
    assert.match(fragment, /X-Static = "static"/);
    assert.match(fragment, /\[mcp_servers\.shioricode_remote\.env_http_headers\]/);
    assert.match(fragment, /X-Team = "MCP_TEAM"/);
    assert.match(fragment, /\[mcp_servers\.shioricode_events\]/);
    assert.match(fragment, /transport = "sse"/);
  });
});

describe("buildCodexLeanAppServerConfig", () => {
  it("keeps provider essentials while disabling plugins and app surfaces", () => {
    const config = buildCodexLeanAppServerConfig({
      baseConfig: [
        'model_provider = "custom"',
        'openai_base_url = "https://api.example.com/v1"',
        "",
        "[features]",
        "plugins = true",
        "apps = true",
        "fast_mode = true",
        "",
        "[analytics]",
        "enabled = true",
        "",
        "[feedback]",
        "enabled = true",
        "",
        "[history]",
        'persistence = "save-all"',
        "",
        "[plugins.demo]",
        "enabled = true",
        "",
        "[marketplaces.demo]",
        'source = "github.com/example/demo"',
        "",
        "[mcp_servers.remote]",
        'url = "https://remote.example/mcp"',
        "",
        "[model_providers.custom]",
        'name = "Custom"',
        'base_url = "https://llm.example.com/v1"',
      ].join("\n"),
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

    assert.match(config, /model_provider = "custom"/);
    assert.match(config, /openai_base_url = "https:\/\/api\.example\.com\/v1"/);
    assert.match(config, /\[model_providers\.custom\]/);
    assert.match(config, /\[features\]/);
    assert.match(config, /plugins = false/);
    assert.match(config, /apps = false/);
    assert.match(config, /fast_mode = true/);
    assert.match(config, /\[analytics\]/);
    assert.match(config, /enabled = false/);
    assert.match(config, /\[feedback\]/);
    assert.match(config, /\[history\]/);
    assert.match(config, /persistence = "none"/);
    assert.match(config, /\[apps\._default\]/);
    assert.match(config, /\[mcp_servers\.shioricode_filesystem\]/);
    assert.doesNotMatch(config, /\[plugins\.demo\]/);
    assert.doesNotMatch(config, /\[marketplaces\.demo\]/);
    assert.doesNotMatch(config, /\[mcp_servers\.remote\]/);
  });
});

describe("listEffectiveMcpServerRows", () => {
  it("marks Shiori-managed remote servers unauthenticated until OAuth tokens exist", async () => {
    const oauthStorageDir = await createTempDir("mcp-oauth-storage-");
    const settings = {
      providers: {
        codex: { homePath: "/tmp/codex" },
      },
      mcpServers: {
        servers: [
          {
            name: "remote",
            transport: "sse",
            url: "https://example.com/sse",
            enabled: true,
            providers: ["shiori"],
          },
        ],
      },
    } as never;

    const before = await listEffectiveMcpServerRows({
      settings,
      oauthStorageDir,
    });
    expect(before.servers[0]?.auth).toEqual({
      status: "unauthenticated",
      message: "Authentication required",
    });

    const digest = createHash("sha256")
      .update("remote\nhttps://example.com/sse")
      .digest("hex")
      .slice(0, 16);
    await writeFile(
      path.join(oauthStorageDir, `remote-${digest}.json`),
      `${JSON.stringify({ tokens: { access_token: "access-token" } }, null, 2)}\n`,
      "utf8",
    );

    const after = await listEffectiveMcpServerRows({
      settings,
      oauthStorageDir,
    });
    expect(after.servers[0]?.auth.status).toBe("authenticated");
  });

  it("leaves header-authenticated remote servers in an unknown auth state", async () => {
    const oauthStorageDir = await createTempDir("mcp-oauth-storage-");
    const result = await listEffectiveMcpServerRows({
      oauthStorageDir,
      settings: {
        providers: {
          codex: { homePath: "/tmp/codex" },
        },
        mcpServers: {
          servers: [
            {
              name: "header-auth",
              transport: "http",
              url: "https://example.com/mcp",
              headers: { Authorization: "Bearer secret" },
              enabled: true,
              providers: ["shiori"],
            },
          ],
        },
      } as never,
    });

    expect(result.servers[0]?.auth).toEqual({ status: "unknown" });
  });

  it("marks discovered remote servers unauthenticated until OAuth tokens exist", async () => {
    const codexHome = await createTempDir("mcp-oauth-codex-home-");
    const oauthStorageDir = await createTempDir("mcp-oauth-storage-");
    await writeFile(
      path.join(codexHome, "config.toml"),
      ["[mcp_servers.remote]", 'url = "https://codex.example/mcp"'].join("\n"),
      "utf8",
    );

    const result = await listEffectiveMcpServerRows({
      oauthStorageDir,
      settings: {
        providers: {
          codex: { homePath: codexHome },
        },
        mcpServers: {
          servers: [],
        },
      } as never,
    });

    expect(result.servers[0]).toMatchObject({
      name: "codex:remote",
      source: "codex",
      auth: {
        status: "unauthenticated",
        message: "Authentication required",
      },
    });
  });
});

describe("external MCP discovery", () => {
  it("loads Codex MCP servers from global and project config with project override", async () => {
    const codexHome = await createTempDir("codex-mcp-home-");
    const workspaceRoot = await createTempDir("codex-mcp-project-");
    await mkdir(path.join(workspaceRoot, ".codex"), { recursive: true });
    await writeFile(
      path.join(codexHome, "config.toml"),
      [
        "[mcp_servers.github]",
        'command = "npx"',
        'args = ["-y", "server"]',
        "",
        "[mcp_servers.remote]",
        'url = "https://global.example/mcp"',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(workspaceRoot, ".codex", "config.toml"),
      [
        "[mcp_servers.remote]",
        'transport = { type = "streamable_http", url = "https://project.example/mcp" }',
        'scopes = ["read", "write"]',
        'oauth_resource = "https://project.example/mcp"',
        "",
        "[mcp_servers.remote.env_http_headers]",
        'X-Team = "MCP_TEAM"',
        "",
        "[mcp_servers.events]",
        'transport = "sse"',
        'url = "https://project.example/sse"',
      ].join("\n"),
      "utf8",
    );

    const result = await discoverCodexMcpServers({
      homePath: codexHome,
      cwd: workspaceRoot,
    });

    expect(result.warnings).toEqual([]);
    expect(result.servers.map((server) => server.name)).toEqual([
      "codex:github",
      "codex:remote",
      "codex:remote",
      "codex:events",
    ]);
    const merged = Object.fromEntries(result.servers.map((server) => [server.name, server]));
    expect(merged["codex:remote"]?.url).toEqual("https://project.example/mcp");
    expect(merged["codex:remote"]?.oauthScopes).toEqual(["read", "write"]);
    expect(merged["codex:remote"]?.oauthResource).toEqual("https://project.example/mcp");
    expect(merged["codex:remote"]?.envHttpHeaders).toEqual({ "X-Team": "MCP_TEAM" });
    expect(merged["codex:events"]?.transport).toEqual("sse");
  });

  it("arbitrates ShioriCode, project Codex, and Claude MCP servers for Codex sessions", async () => {
    const codexHome = await createTempDir("codex-managed-home-");
    const workspaceRoot = await createTempDir("codex-managed-project-");
    const claudeHome = await createTempDir("codex-managed-claude-home-");
    const claudeDesktopConfig = path.join(claudeHome, "claude_desktop_config.json");
    await mkdir(path.join(workspaceRoot, ".codex"), { recursive: true });
    await mkdir(path.join(workspaceRoot, ".claude"), { recursive: true });
    await writeFile(claudeDesktopConfig, JSON.stringify({ mcpServers: {} }), "utf8");
    await writeFile(
      path.join(codexHome, "config.toml"),
      ["[mcp_servers.global_codex]", 'command = "node"', 'args = ["global.js"]'].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(workspaceRoot, ".codex", "config.toml"),
      ["[mcp_servers.project_codex]", 'command = "node"', 'args = ["project.js"]'].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(workspaceRoot, ".claude", "settings.json"),
      JSON.stringify({
        mcpServers: {
          claudeProject: { command: "node", args: ["claude.js"] },
        },
      }),
      "utf8",
    );

    const result = await loadCodexManagedMcpServers({
      cwd: workspaceRoot,
      claudeHomePath: claudeHome,
      claudeDesktopConfigPath: claudeDesktopConfig,
      settings: {
        providers: {
          codex: { homePath: codexHome },
        },
        mcpServers: {
          servers: [
            {
              name: "shiori-owned",
              transport: "stdio",
              command: "node",
              args: ["shiori.js"],
              enabled: true,
              providers: ["codex"],
            },
          ],
        },
      } as never,
    });

    expect(result.warnings).toEqual([]);
    expect(result.servers.map((server) => server.name)).toEqual([
      "shiori-owned",
      "codex:project_codex",
      "claude:claudeProject",
    ]);
    expect(result.servers.every((server) => server.providers.includes("codex"))).toBe(true);
    expect(result.servers.some((server) => server.name === "codex:global_codex")).toBe(false);
  });

  it("loads Claude MCP servers from user, desktop, and project config", async () => {
    const claudeHome = await createTempDir("claude-mcp-home-");
    const workspaceRoot = await createTempDir("claude-mcp-project-");
    const desktopConfig = path.join(claudeHome, "claude_desktop_config.json");
    await mkdir(path.join(workspaceRoot, ".claude"), { recursive: true });
    await writeFile(
      path.join(claudeHome, "settings.json"),
      JSON.stringify({
        mcpServers: {
          user: { command: "node", args: ["user.js"] },
        },
      }),
      "utf8",
    );
    await writeFile(
      desktopConfig,
      JSON.stringify({
        mcpServers: {
          desktop: { command: "node", args: ["desktop.js"] },
        },
      }),
      "utf8",
    );
    await writeFile(
      path.join(workspaceRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          remote: { type: "http", url: "https://project.example/mcp" },
        },
      }),
      "utf8",
    );

    const result = await discoverClaudeMcpServers({
      homePath: claudeHome,
      desktopConfigPath: desktopConfig,
      cwd: workspaceRoot,
    });

    expect(result.warnings).toEqual([]);
    expect(result.servers.map((server) => server.name)).toEqual([
      "claude:user",
      "claude:desktop",
      "claude:remote",
    ]);
    expect(result.servers[2]).toMatchObject({
      transport: "http",
      url: "https://project.example/mcp",
      providers: ["shiori"],
    });
  });

  it("dedupes equivalent discovered Codex and Claude servers for Shiori", async () => {
    const codexHome = await createTempDir("shiori-mcp-codex-home-");
    const claudeHome = await createTempDir("shiori-mcp-claude-home-");
    const workspaceRoot = await createTempDir("shiori-mcp-project-");
    const claudeDesktopConfig = path.join(claudeHome, "claude_desktop_config.json");

    await mkdir(path.join(workspaceRoot, ".claude"), { recursive: true });

    await writeFile(
      path.join(codexHome, "config.toml"),
      ["[mcp_servers.posthog]", 'transport = "sse"', 'url = "https://mcp-eu.posthog.com/sse"'].join(
        "\n",
      ),
      "utf8",
    );

    await writeFile(claudeDesktopConfig, JSON.stringify({ mcpServers: {} }), "utf8");
    await writeFile(
      path.join(workspaceRoot, ".claude", "settings.json"),
      JSON.stringify({
        mcpServers: {
          posthog: {
            transport: "sse",
            url: "https://mcp-eu.posthog.com/sse",
          },
        },
      }),
      "utf8",
    );

    const result = await loadEffectiveMcpServersForProvider({
      provider: "shiori",
      cwd: workspaceRoot,
      settings: {
        providers: {
          codex: { homePath: codexHome },
        },
        mcpServers: {
          servers: [],
        },
      } as never,
    });

    expect(result.warnings).toEqual([]);
    expect(result.servers.filter((server) => server.name === "codex:posthog")).toHaveLength(1);
    expect(result.servers.some((server) => server.name === "claude:posthog")).toBe(false);
  });

  it("removes Codex MCP servers from config.toml", async () => {
    const codexHome = await createTempDir("codex-mcp-remove-");
    const configPath = path.join(codexHome, "config.toml");
    await writeFile(
      configPath,
      [
        "[mcp_servers.keep]",
        'command = "node"',
        "",
        "[mcp_servers.remove-me]",
        'command = "npx"',
        "",
        "[mcp_servers.remove-me.env]",
        'TOKEN = "secret"',
        "",
        "[mcp_servers.keep.tools.search]",
        "enabled = true",
      ].join("\n"),
      "utf8",
    );

    await removeExternalMcpServer({
      source: "codex",
      name: "codex:remove-me",
      sourceName: "remove-me",
      configPath,
    });

    const updated = await readFile(configPath, "utf8");
    assert.match(updated, /\[mcp_servers\.keep\]/);
    assert.match(updated, /\[mcp_servers\.keep\.tools\.search\]/);
    assert.doesNotMatch(updated, /remove-me/);
    assert.doesNotMatch(updated, /TOKEN/);
  });

  it("removes Claude MCP servers from JSON config", async () => {
    const claudeHome = await createTempDir("claude-mcp-remove-");
    const configPath = path.join(claudeHome, "settings.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          keep: { command: "node" },
          removeMe: { command: "npx" },
        },
      }),
      "utf8",
    );

    await removeExternalMcpServer({
      source: "claude",
      name: "claude:removeMe",
      sourceName: "removeMe",
      configPath,
    });

    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    expect(parsed.mcpServers.keep).toEqual({ command: "node" });
    expect(parsed.mcpServers.removeMe).toBeUndefined();
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
  it("creates an isolated lean CODEX_HOME with managed MCP config", async () => {
    const sourceHome = await createTempDir("codex-home-source-");
    const runtimeRoot = await createTempDir("codex-home-runtime-");
    const oauthStorageDir = await createTempDir("codex-home-oauth-");
    await mkdir(path.join(sourceHome, "skills", "demo"), { recursive: true });
    await writeFile(path.join(sourceHome, "auth.json"), '{"access_token":"token"}', "utf8");
    await writeFile(
      path.join(sourceHome, ".credentials.json"),
      '{"mcp":"codex-oauth-token"}',
      "utf8",
    );
    await writeFile(
      path.join(sourceHome, "config.toml"),
      ['model = "gpt-5"', "", "[features]", "plugins = true"].join("\n"),
      "utf8",
    );
    await writeFile(path.join(sourceHome, "skills", "demo", "SKILL.md"), "# Demo\n", "utf8");
    const digest = createHash("sha256")
      .update("remote\nhttps://remote.example/mcp")
      .digest("hex")
      .slice(0, 16);
    await writeFile(
      path.join(oauthStorageDir, `remote-${digest}.json`),
      `${JSON.stringify({ tokens: { access_token: "mcp-access-token" } }, null, 2)}\n`,
      "utf8",
    );

    const prepared = await prepareCodexHomeWithManagedMcpServers({
      threadId: "thread-1",
      runtimeRootDir: runtimeRoot,
      homePath: sourceHome,
      oauthStorageDir,
      servers: [
        {
          name: "filesystem",
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          enabled: true,
          providers: ["codex"],
        },
        {
          name: "remote",
          transport: "http",
          url: "https://remote.example/mcp",
          enabled: true,
          providers: ["codex"],
        },
      ],
    });

    assert.ok(prepared);
    const auth = await readFile(path.join(prepared.homePath, "auth.json"), "utf8");
    const mcpCredentials = await readFile(
      path.join(prepared.homePath, ".credentials.json"),
      "utf8",
    );
    const config = await readFile(path.join(prepared.homePath, "config.toml"), "utf8");
    const skill = await readFile(
      path.join(prepared.homePath, "skills", "demo", "SKILL.md"),
      "utf8",
    );

    assert.equal(auth, '{"access_token":"token"}');
    assert.equal(mcpCredentials, '{"mcp":"codex-oauth-token"}');
    assert.equal(skill, "# Demo\n");
    assert.match(config, /model = "gpt-5"/);
    assert.match(config, /plugins = false/);
    assert.match(config, /\[mcp_servers\.shioricode_filesystem\]/);
    assert.match(config, /args = \[\s*"server\.js"\s*\]/);
    assert.match(config, /\[mcp_servers\.shioricode_remote\]/);
    assert.match(config, /\[mcp_servers\.shioricode_remote\.http_headers\]/);
    assert.match(config, /Authorization = "Bearer mcp-access-token"/);

    await prepared.cleanup();
  });

  it("uses the real CODEX_HOME when no managed MCP servers are present", async () => {
    const sourceHome = await createTempDir("codex-home-source-empty-");
    const runtimeRoot = await createTempDir("codex-home-runtime-empty-");
    await writeFile(
      path.join(sourceHome, "config.toml"),
      ['model_provider = "custom"', "", "[features]", "plugins = true"].join("\n"),
      "utf8",
    );

    const prepared = await prepareCodexHomeWithManagedMcpServers({
      threadId: "thread-empty",
      runtimeRootDir: runtimeRoot,
      homePath: sourceHome,
      servers: [],
    });

    assert.equal(prepared, null);
  });
});
