import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Cursor SDK strict MCP install patch", () => {
  it("rejects explicit MCP initialization instead of retrying without MCP", async () => {
    const { CURSOR_API_KEY: _cursorApiKey, ...env } = process.env;
    const probe = [
      'import { Agent } from "@cursor/sdk";',
      "const agent = await Agent.create({",
      '  model: { id: "auto" },',
      "  local: { cwd: process.cwd(), settingSources: [] },",
      '  mcpServers: { required: { type: "unsupported", url: "invalid" } },',
      "});",
      "try {",
      '  await agent.send("strict MCP probe");',
      '  console.error("CURSOR_MCP_FALLBACK_OCCURRED");',
      "  process.exitCode = 2;",
      "} catch (error) {",
      "  console.log(`CURSOR_MCP_REJECTED:${error instanceof Error ? error.message : String(error)}`);",
      "} finally {",
      "  await agent[Symbol.asyncDispose]();",
      "}",
    ].join("\n");

    const result = await execFileAsync(process.execPath, ["--input-type=module", "--eval", probe], {
      cwd: repoRoot,
      env,
      timeout: 15_000,
    });

    expect(result.stdout).toContain("CURSOR_MCP_REJECTED:");
    expect(result.stdout).toContain('Unsupported MCP server type "unsupported" for "required"');
    expect(result.stderr).not.toContain("CURSOR_MCP_FALLBACK_OCCURRED");
  }, 20_000);
});
