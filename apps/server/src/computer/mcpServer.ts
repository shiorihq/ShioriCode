import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";

const TOOL_SCHEMAS = [
  {
    name: "computer_screenshot",
    description: "Capture the current macOS desktop as a screenshot.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "computer_click",
    description: "Click an absolute macOS screen coordinate. Use computer_screenshot first.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right"] },
        clickCount: { type: "number" },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "computer_move",
    description: "Move the macOS pointer to an absolute screen coordinate.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "computer_type",
    description: "Type text into the currently focused macOS control.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "computer_key",
    description: "Press a macOS key with optional command/control/option/shift modifiers.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        modifiers: {
          type: "array",
          items: { type: "string", enum: ["command", "control", "option", "shift"] },
        },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "computer_scroll",
    description: "Scroll the current macOS desktop target by line deltas.",
    inputSchema: {
      type: "object",
      properties: {
        deltaX: { type: "number" },
        deltaY: { type: "number" },
      },
      additionalProperties: false,
    },
  },
] as const;

const HELPER_BINARY_NAME = "ShioriComputerUseHelper";

function helperCandidates(): string[] {
  const configured = process.env.SHIORICODE_COMPUTER_USE_HELPER_BINARY?.trim();
  const packagePath =
    process.env.SHIORICODE_COMPUTER_USE_HELPER_PACKAGE_PATH?.trim() ||
    path.resolve(process.cwd(), "apps/desktop/native/ShioriComputerUse");
  return [
    configured,
    path.join(packagePath, ".build/debug", HELPER_BINARY_NAME),
    path.join(packagePath, ".build/release", HELPER_BINARY_NAME),
    path.resolve(process.cwd(), "apps/desktop/resources/native/macos", HELPER_BINARY_NAME),
    path.resolve(process.cwd(), "apps/desktop/prod-resources/native/macos", HELPER_BINARY_NAME),
  ].flatMap((candidate) => (candidate ? [candidate] : []));
}

function resolveHelperPath(): string {
  for (const candidate of helperCandidates()) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("The macOS Computer Use helper is unavailable.");
}

function helperCommandForTool(toolName: string): string {
  switch (toolName) {
    case "computer_screenshot":
      return "screenshot";
    case "computer_click":
      return "click";
    case "computer_move":
      return "move";
    case "computer_type":
      return "type";
    case "computer_key":
      return "key";
    case "computer_scroll":
      return "scroll";
    default:
      throw new Error(`Unknown Computer Use tool '${toolName}'.`);
  }
}

function runHelper(command: string, input: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveHelperPath(), [command], { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      const text = stdout.trim();
      if (code !== 0) {
        try {
          const parsed = JSON.parse(text || stderr.trim());
          reject(new Error(parsed.error ?? `Computer Use helper failed with code ${code}.`));
        } catch {
          reject(new Error(stderr.trim() || `Computer Use helper failed with code ${code}.`));
        }
        return;
      }
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(input ?? {}));
  });
}

function imageContentFromDataUrl(imageDataUrl: string): { data: string; mimeType: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(imageDataUrl);
  return {
    mimeType: match?.[1] ?? "image/png",
    data: match?.[2] ?? imageDataUrl,
  };
}

function toolResultContent(result: unknown) {
  if (result && typeof result === "object" && "imageDataUrl" in result) {
    const record = result as { imageDataUrl?: unknown; width?: unknown; height?: unknown };
    const imageDataUrl = typeof record.imageDataUrl === "string" ? record.imageDataUrl : "";
    return {
      content: [
        {
          type: "text",
          text: `Captured desktop screenshot (${record.width ?? "?"}x${record.height ?? "?"}).`,
        },
        {
          type: "image",
          ...imageContentFromDataUrl(imageDataUrl),
        },
      ],
    };
  }
  return {
    content: [
      {
        type: "text",
        text:
          result && typeof result === "object" && "message" in result
            ? String((result as { message?: unknown }).message ?? "Computer Use action completed.")
            : JSON.stringify(result ?? {}),
      },
    ],
  };
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function success(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function failure(id: unknown, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

async function handleRequest(message: Record<string, unknown>): Promise<void> {
  const id = message.id;
  const method = message.method;
  try {
    switch (method) {
      case "initialize":
        success(id, {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "shioricode-computer-use", version: "0.1.0" },
        });
        return;
      case "tools/list":
        success(id, { tools: TOOL_SCHEMAS });
        return;
      case "tools/call": {
        const params =
          message.params && typeof message.params === "object"
            ? (message.params as Record<string, unknown>)
            : {};
        const name = typeof params.name === "string" ? params.name : "";
        const args =
          params.arguments && typeof params.arguments === "object"
            ? (params.arguments as Record<string, unknown>)
            : {};
        const result = await runHelper(helperCommandForTool(name), args);
        success(id, toolResultContent(result));
        return;
      }
      default:
        if (id !== undefined) {
          failure(id, new Error(`Unsupported MCP method '${String(method)}'.`));
        }
    }
  } catch (error) {
    failure(id, error);
  }
}

export async function runComputerUseMcpServer(): Promise<void> {
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      if ("id" in message) {
        void handleRequest(message);
      }
    } catch (error) {
      console.error(error);
    }
  }
}
