import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import {
  readCodexAccountSnapshot,
  readCodexUsageSnapshot,
  type CodexAccountSnapshot,
} from "./codexAccount";
import type { CodexUsageSnapshot } from "./Services/ProviderUsage.ts";

interface JsonRpcProbeResponse {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: {
    readonly message?: unknown;
  };
}

export interface CodexAppServerModelSnapshot {
  readonly id: string | null;
  readonly model: string | null;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly hidden: boolean;
  readonly supportedReasoningEfforts: ReadonlyArray<{
    readonly reasoningEffort: string;
    readonly description: string | null;
  }>;
  readonly defaultReasoningEffort: string | null;
  readonly inputModalities: ReadonlyArray<string>;
  readonly additionalSpeedTiers: ReadonlyArray<string>;
  readonly isDefault: boolean;
}

export interface CodexAppServerMetadataSnapshot {
  readonly account: CodexAccountSnapshot;
  readonly models: ReadonlyArray<CodexAppServerModelSnapshot> | null;
}

export const CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS = 60_000;

export function buildCodexAppServerArgs(): string[] {
  // Current Codex CLI releases expose app-server over stdio without any
  // transport flag. Keep the argv minimal so probes and session startup
  // stay compatible with the installed binary.
  return ["app-server"];
}

function readErrorMessage(response: JsonRpcProbeResponse): string | undefined {
  return typeof response.error?.message === "string" ? response.error.message : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(value: unknown): ReadonlyArray<string> {
  return (asArray(value) ?? []).filter((item): item is string => typeof item === "string");
}

export function readCodexModelListSnapshot(
  response: unknown,
): ReadonlyArray<CodexAppServerModelSnapshot> {
  const record = asObject(response);
  const entries = asArray(record?.data) ?? asArray(record?.models) ?? [];

  return entries.flatMap((entry) => {
    const model = asObject(entry);
    if (!model) {
      return [];
    }

    const supportedReasoningEfforts = (asArray(model.supportedReasoningEfforts) ?? []).flatMap(
      (effort) => {
        const effortRecord = asObject(effort);
        const reasoningEffort = asString(effortRecord?.reasoningEffort);
        if (!reasoningEffort) {
          return [];
        }
        return [
          {
            reasoningEffort,
            description: asString(effortRecord?.description),
          },
        ];
      },
    );

    return [
      {
        id: asString(model.id),
        model: asString(model.model),
        displayName: asString(model.displayName),
        description: asString(model.description),
        hidden: asBoolean(model.hidden) ?? false,
        supportedReasoningEfforts,
        defaultReasoningEffort: asString(model.defaultReasoningEffort),
        inputModalities: readStringArray(model.inputModalities),
        additionalSpeedTiers: readStringArray(model.additionalSpeedTiers),
        isDefault: asBoolean(model.isDefault) ?? false,
      },
    ];
  });
}

export function buildCodexInitializeParams() {
  return {
    clientInfo: {
      name: "shioricode_desktop",
      title: "ShioriCode Desktop",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  } as const;
}

export function killCodexChildProcess(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // Fall through to direct kill when taskkill is unavailable.
    }
  }

  child.kill();
}

function subscribeToAbort(
  signal: AbortSignal | undefined,
  listener: () => void,
): (() => void) | undefined {
  if (!signal) {
    return undefined;
  }
  signal.addEventListener("abort", listener, { once: true });
  return () => {
    signal.removeEventListener("abort", listener);
  };
}

export async function probeCodexAccount(input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly signal?: AbortSignal;
}): Promise<CodexAccountSnapshot> {
  return await new Promise((resolve, reject) => {
    const child = spawn(input.binaryPath, buildCodexAppServerArgs(), {
      env: {
        ...process.env,
        ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const output = readline.createInterface({ input: child.stdout });

    let completed = false;
    let unsubscribeAbort: (() => void) | undefined;

    const cleanup = () => {
      unsubscribeAbort?.();
      unsubscribeAbort = undefined;
      output.removeAllListeners();
      output.close();
      child.removeAllListeners();
      if (!child.killed) {
        killCodexChildProcess(child);
      }
    };

    const finish = (callback: () => void) => {
      if (completed) return;
      completed = true;
      cleanup();
      callback();
    };

    const fail = (error: unknown) =>
      finish(() =>
        reject(
          error instanceof Error
            ? error
            : new Error(`Codex account probe failed: ${String(error)}.`),
        ),
      );

    if (input.signal?.aborted) {
      fail(new Error("Codex account probe aborted."));
      return;
    }
    unsubscribeAbort = subscribeToAbort(input.signal, () =>
      fail(new Error("Codex account probe aborted.")),
    );

    const writeMessage = (message: unknown) => {
      if (!child.stdin.writable) {
        fail(new Error("Cannot write to codex app-server stdin."));
        return;
      }

      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    output.on("line", (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail(new Error("Received invalid JSON from codex app-server during account probe."));
        return;
      }

      if (!parsed || typeof parsed !== "object") {
        return;
      }

      const response = parsed as JsonRpcProbeResponse;
      if (response.id === 1) {
        const errorMessage = readErrorMessage(response);
        if (errorMessage) {
          fail(new Error(`initialize failed: ${errorMessage}`));
          return;
        }

        writeMessage({ method: "initialized" });
        writeMessage({ id: 2, method: "account/read", params: {} });
        return;
      }

      if (response.id === 2) {
        const errorMessage = readErrorMessage(response);
        if (errorMessage) {
          fail(new Error(`account/read failed: ${errorMessage}`));
          return;
        }

        finish(() => resolve(readCodexAccountSnapshot(response.result)));
      }
    });

    child.once("error", fail);
    child.once("exit", (code, signal) => {
      if (completed) return;
      fail(
        new Error(
          `codex app-server exited before probe completed (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        ),
      );
    });

    writeMessage({
      id: 1,
      method: "initialize",
      params: buildCodexInitializeParams(),
    });
  });
}

export async function probeCodexMetadata(input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly signal?: AbortSignal;
}): Promise<CodexAppServerMetadataSnapshot> {
  return await new Promise((resolve, reject) => {
    const child = spawn(input.binaryPath, buildCodexAppServerArgs(), {
      env: {
        ...process.env,
        ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const output = readline.createInterface({ input: child.stdout });

    let completed = false;
    let unsubscribeAbort: (() => void) | undefined;
    let account: CodexAccountSnapshot | undefined;
    let models: ReadonlyArray<CodexAppServerModelSnapshot> | null | undefined;

    const cleanup = () => {
      unsubscribeAbort?.();
      unsubscribeAbort = undefined;
      output.removeAllListeners();
      output.close();
      child.removeAllListeners();
      if (!child.killed) {
        killCodexChildProcess(child);
      }
    };

    const finish = (callback: () => void) => {
      if (completed) return;
      completed = true;
      cleanup();
      callback();
    };

    const fail = (error: unknown) =>
      finish(() =>
        reject(
          error instanceof Error
            ? error
            : new Error(`Codex metadata probe failed: ${String(error)}.`),
        ),
      );

    const maybeResolve = () => {
      const resolvedAccount = account;
      const resolvedModels = models;
      if (resolvedAccount && resolvedModels !== undefined) {
        finish(() => resolve({ account: resolvedAccount, models: resolvedModels }));
      }
    };

    if (input.signal?.aborted) {
      fail(new Error("Codex metadata probe aborted."));
      return;
    }
    unsubscribeAbort = subscribeToAbort(input.signal, () =>
      fail(new Error("Codex metadata probe aborted.")),
    );

    const writeMessage = (message: unknown) => {
      if (!child.stdin.writable) {
        fail(new Error("Cannot write to codex app-server stdin."));
        return;
      }

      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    output.on("line", (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail(new Error("Received invalid JSON from codex app-server during metadata probe."));
        return;
      }

      if (!parsed || typeof parsed !== "object") {
        return;
      }

      const response = parsed as JsonRpcProbeResponse;
      if (response.id === 1) {
        const errorMessage = readErrorMessage(response);
        if (errorMessage) {
          fail(new Error(`initialize failed: ${errorMessage}`));
          return;
        }

        writeMessage({ method: "initialized" });
        writeMessage({ id: 2, method: "account/read", params: {} });
        writeMessage({ id: 3, method: "model/list", params: {} });
        return;
      }

      if (response.id === 2) {
        const errorMessage = readErrorMessage(response);
        if (errorMessage) {
          fail(new Error(`account/read failed: ${errorMessage}`));
          return;
        }

        account = readCodexAccountSnapshot(response.result);
        maybeResolve();
        return;
      }

      if (response.id === 3) {
        const errorMessage = readErrorMessage(response);
        models = errorMessage ? null : readCodexModelListSnapshot(response.result);
        maybeResolve();
      }
    });

    child.once("error", fail);
    child.once("exit", (code, signal) => {
      if (completed) return;
      fail(
        new Error(
          `codex app-server exited before metadata probe completed (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        ),
      );
    });

    writeMessage({
      id: 1,
      method: "initialize",
      params: buildCodexInitializeParams(),
    });
  });
}

export async function probeCodexUsage(input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly signal?: AbortSignal;
}): Promise<CodexUsageSnapshot> {
  return await new Promise((resolve, reject) => {
    const child = spawn(input.binaryPath, buildCodexAppServerArgs(), {
      env: {
        ...process.env,
        ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const output = readline.createInterface({ input: child.stdout });

    let completed = false;
    let unsubscribeAbort: (() => void) | undefined;

    const cleanup = () => {
      unsubscribeAbort?.();
      unsubscribeAbort = undefined;
      output.removeAllListeners();
      output.close();
      child.removeAllListeners();
      if (!child.killed) {
        killCodexChildProcess(child);
      }
    };

    const finish = (callback: () => void) => {
      if (completed) return;
      completed = true;
      cleanup();
      callback();
    };

    const fail = (error: unknown) =>
      finish(() =>
        reject(
          error instanceof Error ? error : new Error(`Codex usage probe failed: ${String(error)}.`),
        ),
      );

    if (input.signal?.aborted) {
      fail(new Error("Codex usage probe aborted."));
      return;
    }
    unsubscribeAbort = subscribeToAbort(input.signal, () =>
      fail(new Error("Codex usage probe aborted.")),
    );

    const writeMessage = (message: unknown) => {
      if (!child.stdin.writable) {
        fail(new Error("Cannot write to codex app-server stdin."));
        return;
      }

      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    output.on("line", (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail(new Error("Received invalid JSON from codex app-server during usage probe."));
        return;
      }

      if (!parsed || typeof parsed !== "object") {
        return;
      }

      const response = parsed as JsonRpcProbeResponse;
      if (response.id === 1) {
        const errorMessage = readErrorMessage(response);
        if (errorMessage) {
          fail(new Error(`initialize failed: ${errorMessage}`));
          return;
        }

        writeMessage({ method: "initialized" });
        writeMessage({ id: 2, method: "account/rateLimits/read", params: {} });
        return;
      }

      if (response.id === 2) {
        const errorMessage = readErrorMessage(response);
        if (errorMessage) {
          fail(new Error(`account/rateLimits/read failed: ${errorMessage}`));
          return;
        }

        finish(() => resolve(readCodexUsageSnapshot(response.result)));
      }
    });

    child.once("error", fail);
    child.once("exit", (code, signal) => {
      if (completed) return;
      fail(
        new Error(
          `codex app-server exited before usage probe completed (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        ),
      );
    });

    writeMessage({
      id: 1,
      method: "initialize",
      params: buildCodexInitializeParams(),
    });
  });
}
