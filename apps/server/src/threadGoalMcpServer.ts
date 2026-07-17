import readline from "node:readline";

export const THREAD_GOAL_TOOL_SCHEMAS = [
  {
    name: "get_goal",
    description:
      "Read the active ShioriCode thread goal, including its stable goal_id, objective, status, and harness-owned usage counters.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "update_goal",
    description:
      "Report the outcome of the current ShioriCode thread goal. Use complete only when the objective is genuinely achieved. Use blocked only when meaningful progress cannot continue without user input or an external change.",
    inputSchema: {
      type: "object",
      properties: {
        goal_id: {
          type: "string",
          description: "The stable goal_id returned by get_goal.",
        },
        status: {
          type: "string",
          enum: ["complete", "blocked"],
        },
      },
      required: ["goal_id", "status"],
      additionalProperties: false,
    },
  },
] as const;

interface ThreadGoalControlPayload {
  readonly ok?: boolean;
  readonly error?: string;
  readonly goal?: unknown;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(`${key} is required.`);
  }
  return normalized;
}

export async function requestThreadGoalControl(
  body: Record<string, unknown>,
  options?: {
    readonly controlUrl?: string | undefined;
    readonly capabilityToken?: string | undefined;
    readonly fetch?: FetchLike | undefined;
  },
): Promise<ThreadGoalControlPayload> {
  const controlUrl = options?.controlUrl ?? process.env.SHIORICODE_THREAD_GOAL_CONTROL_URL?.trim();
  const capabilityToken =
    options?.capabilityToken ?? process.env.SHIORICODE_THREAD_GOAL_CAPABILITY_TOKEN?.trim();
  if (!controlUrl || !capabilityToken) {
    throw new Error("ShioriCode thread-goal control is not configured.");
  }

  const fetchImpl = options?.fetch ?? fetch;
  const response = await fetchImpl(controlUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${capabilityToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  let payload: ThreadGoalControlPayload;
  try {
    payload = (await response.json()) as ThreadGoalControlPayload;
  } catch {
    throw new Error(`Thread-goal control returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.error ?? `Thread-goal control failed with HTTP ${response.status}.`);
  }
  return payload;
}

export async function runThreadGoalTool(
  name: "get_goal" | "update_goal",
  input: Record<string, unknown>,
  options?: Parameters<typeof requestThreadGoalControl>[1],
) {
  const payload =
    name === "get_goal"
      ? await requestThreadGoalControl({ action: "get" }, options)
      : await requestThreadGoalControl(
          {
            action: "update",
            goal_id: requiredString(input, "goal_id"),
            status: (() => {
              const status = requiredString(input, "status");
              if (status !== "complete" && status !== "blocked") {
                throw new Error("status must be either 'complete' or 'blocked'.");
              }
              return status;
            })(),
          },
          options,
        );

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ goal: payload.goal ?? null }, null, 2),
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
  try {
    switch (message.method) {
      case "initialize":
        success(id, {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "shioricode-thread-goal", version: "0.5.0" },
        });
        return;
      case "tools/list":
        success(id, { tools: THREAD_GOAL_TOOL_SCHEMAS });
        return;
      case "tools/call": {
        const params =
          message.params && typeof message.params === "object"
            ? (message.params as Record<string, unknown>)
            : {};
        const name = typeof params.name === "string" ? params.name : "";
        if (name !== "get_goal" && name !== "update_goal") {
          throw new Error(`Unknown thread-goal tool '${name}'.`);
        }
        const args =
          params.arguments && typeof params.arguments === "object"
            ? (params.arguments as Record<string, unknown>)
            : {};
        success(id, await runThreadGoalTool(name, args));
        return;
      }
      default:
        if (id !== undefined) {
          failure(id, new Error(`Unsupported MCP method '${String(message.method)}'.`));
        }
    }
  } catch (error) {
    failure(id, error);
  }
}

export async function runThreadGoalMcpServer(): Promise<void> {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      await handleRequest(JSON.parse(trimmed) as Record<string, unknown>);
    } catch (error) {
      failure(undefined, error);
    }
  }
}
