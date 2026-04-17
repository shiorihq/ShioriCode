import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { MCPClient } from "@ai-sdk/mcp";
import type { McpServerEntry } from "contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  listEffectiveMcpServerRows,
  buildProviderMcpToolRuntime,
  buildCodexManagedMcpConfigFragment,
  discoverClaudeMcpServers,
  discoverCodexMcpServers,
  filterMcpServersForProvider,
  loadCodexManagedMcpServers,
  prepareCodexHomeWithManagedMcpServers,
  removeExternalMcpServer,
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
        headers: { Authorization: "Bearer token" },
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
    assert.match(fragment, /\[mcp_servers\.shioricode_remote\.http_headers\]/);
    assert.match(fragment, /Authorization = "Bearer token"/);
    assert.match(fragment, /\[mcp_servers\.shioricode_events\]/);
    assert.match(fragment, /transport = "sse"/);
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
        'url = "https://project.example/mcp"',
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
  it("creates an isolated CODEX_HOME with managed MCP config appended", async () => {
    const sourceHome = await createTempDir("codex-home-source-");
    const runtimeRoot = await createTempDir("codex-home-runtime-");
    await mkdir(path.join(sourceHome, "skills", "demo"), { recursive: true });
    await writeFile(path.join(sourceHome, "auth.json"), '{"access_token":"token"}', "utf8");
    await writeFile(path.join(sourceHome, "config.toml"), 'model = "gpt-5"\n', "utf8");
    await writeFile(path.join(sourceHome, "skills", "demo", "SKILL.md"), "# Demo\n", "utf8");

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
    const skill = await readFile(
      path.join(prepared.homePath, "skills", "demo", "SKILL.md"),
      "utf8",
    );

    assert.equal(auth, '{"access_token":"token"}');
    assert.equal(skill, "# Demo\n");
    assert.match(config, /model = "gpt-5"/);
    assert.match(config, /\[mcp_servers\.shioricode_filesystem\]/);
    assert.match(config, /args = \["server\.js"\]/);

    await prepared.cleanup();
  });
});
