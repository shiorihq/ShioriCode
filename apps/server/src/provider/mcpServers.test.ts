import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { McpServerEntry } from "contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
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
