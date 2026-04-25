import { randomUUID } from "node:crypto";
import readline from "node:readline";

type BrowserToolName =
  | "browser_navigate"
  | "browser_evaluate_javascript"
  | "browser_snapshot"
  | "browser_go_back"
  | "browser_go_forward"
  | "browser_reload"
  | "browser_stop"
  | "browser_click_selector"
  | "browser_type_selector";

const TOOL_SCHEMAS = [
  {
    name: "browser_navigate",
    description:
      "Navigate ShioriCode's built-in visible Browser panel to a URL. Use this for requests to use the browser tool or browser panel.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL or hostname to load." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_evaluate_javascript",
    description:
      "Run JavaScript in the current page of ShioriCode's built-in Browser panel and return the JSON-serializable result.",
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description: "JavaScript expression or async function body to execute in the page.",
        },
        awaitPromise: {
          type: "boolean",
          description: "Whether to await a returned Promise. Defaults to true.",
        },
      },
      required: ["script"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Inspect the current Browser panel page: URL, title, loading state, visible text, links, and form controls.",
    inputSchema: {
      type: "object",
      properties: {
        includeText: {
          type: "boolean",
          description: "Include document body text. Defaults to true.",
        },
        includeLinks: { type: "boolean", description: "Include anchors. Defaults to true." },
        includeForms: {
          type: "boolean",
          description: "Include inputs/buttons/selects. Defaults to true.",
        },
      },
      additionalProperties: false,
    },
  },
  ...(["browser_go_back", "browser_go_forward", "browser_reload", "browser_stop"] as const).map(
    (name) => ({
      name,
      description: `Run ${name.replace("browser_", "").replaceAll("_", " ")} in ShioriCode's built-in Browser panel.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
  ),
  {
    name: "browser_click_selector",
    description:
      "Click the first element matching a CSS selector in the current built-in Browser panel page.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for the element to click." },
      },
      required: ["selector"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_type_selector",
    description:
      "Focus an input/textarea/contenteditable element matching a CSS selector and type text into it.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for the target field." },
        text: { type: "string", description: "Text to place in the target field." },
      },
      required: ["selector", "text"],
      additionalProperties: false,
    },
  },
] as const;

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

function normalizeUrl(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new Error("url is required.");
  if (
    trimmed.startsWith("localhost") ||
    trimmed.startsWith("127.0.0.1") ||
    trimmed.startsWith("0.0.0.0") ||
    /^\[[0-9a-f:]+\]/i.test(trimmed)
  ) {
    return `http://${trimmed}`;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new Error(`${key} is required.`);
  return trimmed;
}

export function browserPanelCommandForTool(name: BrowserToolName, input: Record<string, unknown>) {
  switch (name) {
    case "browser_navigate":
      return { type: "navigate" as const, url: normalizeUrl(input.url) };
    case "browser_evaluate_javascript":
      return {
        type: "evaluate" as const,
        script: requiredString(input, "script"),
        awaitPromise: typeof input.awaitPromise === "boolean" ? input.awaitPromise : true,
      };
    case "browser_snapshot":
      return {
        type: "snapshot" as const,
        includeText: input.includeText !== false,
        includeLinks: input.includeLinks !== false,
        includeForms: input.includeForms !== false,
      };
    case "browser_go_back":
      return { type: "action" as const, action: "back" as const };
    case "browser_go_forward":
      return { type: "action" as const, action: "forward" as const };
    case "browser_reload":
      return { type: "action" as const, action: "reload" as const };
    case "browser_stop":
      return { type: "action" as const, action: "stop" as const };
    case "browser_click_selector":
      return { type: "click-selector" as const, selector: requiredString(input, "selector") };
    case "browser_type_selector":
      return {
        type: "type-selector" as const,
        selector: requiredString(input, "selector"),
        text: requiredString(input, "text"),
      };
  }
}

export async function runBrowserCommand(name: BrowserToolName, input: Record<string, unknown>) {
  const controlUrl = process.env.SHIORICODE_BROWSER_CONTROL_URL?.trim();
  const threadId = process.env.SHIORICODE_BROWSER_THREAD_ID?.trim();
  if (!controlUrl || !threadId) {
    throw new Error("ShioriCode browser panel control is not configured.");
  }

  const token = process.env.SHIORICODE_BROWSER_CONTROL_TOKEN?.trim();
  const response = await fetch(controlUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      id: randomUUID(),
      threadId,
      ...browserPanelCommandForTool(name, input),
    }),
  });

  if (!response.ok) {
    throw new Error(`Browser panel command failed with HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as {
    result?: { ok?: boolean; value?: unknown; error?: string };
  };
  const result = payload.result;
  if (!result?.ok) {
    throw new Error(result?.error ?? "Browser panel command failed.");
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result.value ?? { ok: true }, null, 2),
      },
    ],
  };
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
          serverInfo: { name: "shioricode-browser-panel", version: "0.2.0" },
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
        if (!TOOL_SCHEMAS.some((tool) => tool.name === name)) {
          throw new Error(`Unknown browser panel tool '${name}'.`);
        }
        success(id, await runBrowserCommand(name as BrowserToolName, args));
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

export async function runBrowserPanelMcpServer(): Promise<void> {
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const message = JSON.parse(trimmed) as Record<string, unknown>;
      await handleRequest(message);
    } catch (error) {
      failure(undefined, error);
    }
  }
}
