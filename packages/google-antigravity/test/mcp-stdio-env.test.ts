import { afterEach, describe, expect, it } from "vitest";

import { cloneMcpServerConfig } from "../src/connections/connection.ts";
import { McpBridge } from "../src/mcp/bridge.ts";
import { McpStdioServer } from "../src/types.ts";

const ENV_ECHO_MCP_SERVER = String.raw`
import readline from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "env-echo", version: "1.0.0" },
      },
    });
  } else if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{ name: "read_env", inputSchema: { type: "object", properties: {} } }],
      },
    });
  } else if (message.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: process.env.MCP_NATIVE_ENV_TEST ?? "" }] },
    });
  }
}
`;

describe("McpStdioServer environment", () => {
  const bridges: McpBridge[] = [];

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
  });

  it("preserves environment values when cloned and serialized", () => {
    const sourceEnv = { MCP_NATIVE_ENV_TEST: "native-secret" };
    const server = new McpStdioServer({
      name: "env-test",
      command: process.execPath,
      args: ["server.js"],
      env: sourceEnv,
    });
    sourceEnv.MCP_NATIVE_ENV_TEST = "mutated";

    const clone = cloneMcpServerConfig(server);
    expect(clone).toBeInstanceOf(McpStdioServer);
    expect((clone as McpStdioServer).env).toEqual({ MCP_NATIVE_ENV_TEST: "native-secret" });
    expect((clone as McpStdioServer).env).not.toBe(server.env);
    expect(server.toJSON()).toMatchObject({
      command: process.execPath,
      args: ["server.js"],
      env: { MCP_NATIVE_ENV_TEST: "native-secret" },
    });
  });

  it("passes environment values to the spawned MCP process without argv shims", async () => {
    const bridge = new McpBridge();
    bridges.push(bridge);
    const server = new McpStdioServer({
      name: "env-test",
      command: process.execPath,
      args: ["--input-type=module", "--eval", ENV_ECHO_MCP_SERVER],
      env: { MCP_NATIVE_ENV_TEST: "native-secret" },
    });

    await bridge.connect(server);

    expect(server.command).toBe(process.execPath);
    expect(server.args).not.toContain("MCP_NATIVE_ENV_TEST=native-secret");
    await expect(bridge.tools[0]?.call()).resolves.toEqual({
      content: [{ type: "text", text: "native-secret" }],
    });
  });
});
