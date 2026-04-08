import { spawn } from "node:child_process";
import readline from "node:readline";

import { TurnId } from "contracts";

import { buildCodexInitializeParams, type CodexThreadSnapshot } from "../codexAppServerManager.ts";

interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: {
    message?: string;
  };
}

function asObject(value: unknown, key?: string): Record<string, unknown> | undefined {
  const target =
    key === undefined
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;
  return target && typeof target === "object" ? (target as Record<string, unknown>) : undefined;
}

function asString(value: unknown, key?: string): string | undefined {
  if (key !== undefined) {
    return value && typeof value === "object"
      ? typeof (value as Record<string, unknown>)[key] === "string"
        ? ((value as Record<string, unknown>)[key] as string)
        : undefined
      : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown, key?: string): unknown[] | undefined {
  const target =
    key === undefined
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;
  return Array.isArray(target) ? target : undefined;
}

function parseCodexThreadSnapshot(method: string, response: unknown): CodexThreadSnapshot {
  const responseRecord = asObject(response);
  const thread = asObject(responseRecord, "thread");
  const threadIdRaw = asString(thread, "id") ?? asString(responseRecord, "threadId");
  if (!threadIdRaw) {
    throw new Error(`${method} response did not include a thread id.`);
  }

  const turnsRaw = asArray(thread, "turns") ?? asArray(responseRecord, "turns") ?? [];
  return {
    threadId: threadIdRaw,
    turns: turnsRaw.map((turnValue, index) => {
      const turn = asObject(turnValue);
      const turnIdRaw = asString(turn, "id") ?? `${threadIdRaw}:turn:${index + 1}`;
      return {
        id: TurnId.makeUnsafe(turnIdRaw),
        items: asArray(turn, "items") ?? [],
      };
    }),
  };
}

async function readResponse(
  output: readline.Interface,
  input: { requestId: number; method: string; timeoutMs: number },
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      output.off("line", onLine);
      reject(new Error(`Timed out waiting for ${input.method}.`));
    }, input.timeoutMs);

    const onLine = (line: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }

      if (!parsed || typeof parsed !== "object") {
        return;
      }

      const response = parsed as JsonRpcResponse;
      if (response.id !== input.requestId) {
        return;
      }

      clearTimeout(timeout);
      output.off("line", onLine);
      if (response.error?.message) {
        reject(new Error(`${input.method} failed: ${response.error.message}`));
        return;
      }
      resolve(response.result);
    };

    output.on("line", onLine);
  });
}

export async function readCodexStoredThread(input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly cwd: string;
  readonly providerThreadId: string;
  readonly timeoutMs?: number;
}): Promise<CodexThreadSnapshot> {
  const child = spawn(input.binaryPath, ["app-server"], {
    cwd: input.cwd,
    env: {
      ...process.env,
      ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  const output = readline.createInterface({ input: child.stdout });
  const timeoutMs = input.timeoutMs ?? 20_000;
  let nextRequestId = 1;

  const send = async (method: string, params: unknown) => {
    const requestId = nextRequestId;
    nextRequestId += 1;

    const encoded = JSON.stringify({
      method,
      id: requestId,
      params,
    });
    child.stdin.write(`${encoded}\n`);
    return await readResponse(output, { requestId, method, timeoutMs });
  };

  try {
    await send("initialize", buildCodexInitializeParams());
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const threadReadResponse = await send("thread/read", {
      threadId: input.providerThreadId,
      includeTurns: true,
    });
    return parseCodexThreadSnapshot("thread/read", threadReadResponse);
  } finally {
    output.close();
    child.kill();
  }
}
