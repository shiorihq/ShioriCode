import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { ApprovalRequestId, ProviderItemId, ThreadId, TurnId } from "contracts";

import {
  buildCodexAppServerArgs,
  buildCodexInitializeParams,
  CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS,
  CodexAppServerManager,
  normalizeCodexModelSlug,
  readCodexAccountSnapshot,
  resolveCodexModelForAccount,
} from "./codexAppServerManager";
import { classifyCodexStderrLine, isRecoverableThreadResumeError } from "./provider/codexStderr";
import { buildCodexCollaborationMode } from "./provider/policy/codexPromptPolicy";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

function createSendTurnHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    account: {
      type: "unknown",
      planType: null,
      sparkEnabled: true,
    },
    supportsReasoningSummary: false,
    collabReceiverTurns: new Map(),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const sendRequest = vi
    .spyOn(
      manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
      "sendRequest",
    )
    .mockResolvedValue({
      turn: {
        id: "turn_1",
      },
    });
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});

  return { manager, context, requireSession, sendRequest, updateSession };
}

function createThreadControlHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    collabReceiverTurns: new Map(),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const sendRequest = vi.spyOn(
    manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
    "sendRequest",
  );
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});

  return { manager, context, requireSession, sendRequest, updateSession };
}

function createPendingUserInputHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    pendingUserInputs: new Map([
      [
        ApprovalRequestId.makeUnsafe("req-user-input-1"),
        {
          requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
          jsonRpcId: 42,
          threadId: asThreadId("thread_1"),
        },
      ],
    ]),
    collabReceiverTurns: new Map(),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const writeMessage = vi
    .spyOn(manager as unknown as { writeMessage: (...args: unknown[]) => void }, "writeMessage")
    .mockImplementation(() => {});
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});

  return { manager, context, requireSession, writeMessage, emitEvent };
}

function createPendingApprovalHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    pendingApprovals: new Map([
      [
        ApprovalRequestId.makeUnsafe("req-approval-1"),
        {
          requestId: ApprovalRequestId.makeUnsafe("req-approval-1"),
          jsonRpcId: 42,
          method: "item/commandExecution/requestApproval",
          requestKind: "command",
          threadId: asThreadId("thread_1"),
          turnId: "turn_1",
          itemId: "item_1",
        },
      ],
    ]),
    collabReceiverTurns: new Map(),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const writeMessage = vi
    .spyOn(manager as unknown as { writeMessage: (...args: unknown[]) => void }, "writeMessage")
    .mockImplementation(() => {});
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});

  return { manager, context, requireSession, writeMessage, emitEvent };
}

function createCollabNotificationHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "running",
      threadId: asThreadId("thread_1"),
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      activeTurnId: "turn_parent",
      resumeCursor: { threadId: "provider_parent" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    account: {
      type: "unknown",
      planType: null,
      sparkEnabled: true,
    },
    pending: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map<string, string>(),
    nextRequestId: 1,
    stopping: false,
  };

  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});

  return { manager, context, emitEvent, updateSession };
}

function createProcessHarness() {
  const manager = new CodexAppServerManager();
  const output = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
  output.close = vi.fn();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    stdin: {
      writable: boolean;
      write: ReturnType<typeof vi.fn>;
    };
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stderr = stderr;
  child.stdin = {
    writable: true,
    write: vi.fn(),
  };
  child.killed = false;
  child.kill = vi.fn();
  const pendingReject = vi.fn();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: asThreadId("thread_1"),
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    account: {
      type: "unknown",
      planType: null,
      sparkEnabled: false,
    },
    supportsReasoningSummary: false,
    child,
    output,
    pending: new Map([
      [
        "1",
        {
          method: "turn/start",
          timeout: setTimeout(() => undefined, 30_000),
          resolve: vi.fn(),
          reject: pendingReject,
        },
      ],
    ]),
    pendingApprovals: new Map([
      [
        ApprovalRequestId.makeUnsafe("req-approval-1"),
        {
          requestId: ApprovalRequestId.makeUnsafe("req-approval-1"),
          jsonRpcId: 42,
          method: "item/commandExecution/requestApproval",
          requestKind: "command",
          threadId: asThreadId("thread_1"),
          turnId: TurnId.makeUnsafe("turn_1"),
          itemId: ProviderItemId.makeUnsafe("item_1"),
        },
      ],
    ]),
    pendingUserInputs: new Map([
      [
        ApprovalRequestId.makeUnsafe("req-user-input-1"),
        {
          requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
          jsonRpcId: 43,
          threadId: asThreadId("thread_1"),
          turnId: TurnId.makeUnsafe("turn_1"),
          requestMethod: "tool/requestUserInput",
        },
      ],
    ]),
    collabReceiverTurns: new Map(),
    nextRequestId: 2,
    stopping: false,
  };
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});

  return { manager, context, child, pendingReject, emitEvent };
}

function createFakeCodexBinary(input: {
  readonly dir: string;
  readonly logPath: string;
  readonly resumeFails?: boolean;
}) {
  const binaryPath = path.join(input.dir, "fake-codex-app-server.js");
  writeFileSync(
    binaryPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const logPath = ${JSON.stringify(input.logPath)};
const resumeFails = ${JSON.stringify(input.resumeFails === true)};
if (process.argv.includes("--version")) {
  console.log("codex 0.37.0");
  process.exit(0);
}
const append = (entry) => fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  append(message);
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "account/read") {
    send({ id: message.id, result: { type: "chatgpt", planType: "plus" } });
    return;
  }
  if (message.method === "model/list") {
    send({
      id: message.id,
      result: {
        models: [
          { model: "gpt-5.3-codex", displayName: "GPT-5.3 Codex" },
          { model: "gpt-5.3-codex-spark", displayName: "GPT-5.3 Codex Spark" }
        ]
      }
    });
    return;
  }
  if (message.method === "thread/resume" && resumeFails) {
    send({ id: message.id, error: { message: "thread not found" } });
    return;
  }
  if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }
  if (message.method === "thread/start") {
    send({ method: "thread/started", params: { thread: { id: "provider_started" } } });
    send({ id: message.id, result: { thread: { id: "provider_started" } } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn_started" } } });
    return;
  }
});
`,
    "utf8",
  );
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

function readJsonl(pathname: string): Array<Record<string, unknown>> {
  return readFileSync(pathname, "utf8")
    .trim()
    .split(/\n/u)
    .filter(Boolean)
    .map((line: string) => JSON.parse(line) as Record<string, unknown>);
}

describe("classifyCodexStderrLine", () => {
  it("ignores empty lines", () => {
    expect(classifyCodexStderrLine("   ")).toBeNull();
  });

  it("ignores non-error structured codex logs", () => {
    const line =
      "2026-02-08T04:24:19.241256Z  WARN codex_core::features: unknown feature key in config: skills";
    expect(classifyCodexStderrLine(line)).toBeNull();
  });

  it("ignores known benign rollout path errors", () => {
    const line =
      "\u001b[2m2026-02-08T04:24:20.085687Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_core::rollout::list\u001b[0m: state db missing rollout path for thread 019c3b6c-46b8-7b70-ad23-82f824d161fb";
    expect(classifyCodexStderrLine(line)).toBeNull();
  });

  it("keeps unknown structured errors", () => {
    const line = "2026-02-08T04:24:20.085687Z ERROR codex_core::runtime: unrecoverable failure";
    expect(classifyCodexStderrLine(line)).toEqual({
      message: line,
    });
  });

  it("keeps plain stderr messages", () => {
    const line = "fatal: permission denied";
    expect(classifyCodexStderrLine(line)).toEqual({
      message: line,
    });
  });
});

describe("process stderr events", () => {
  it("emits classified stderr lines as notifications", () => {
    const manager = new CodexAppServerManager();
    const emitEvent = vi
      .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
      .mockImplementation(() => {});

    (
      manager as unknown as {
        emitNotificationEvent: (
          context: { session: { threadId: ThreadId } },
          method: string,
          message: string,
        ) => void;
      }
    ).emitNotificationEvent(
      {
        session: {
          threadId: asThreadId("thread-1"),
        },
      },
      "process/stderr",
      "fatal: permission denied",
    );

    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "notification",
        method: "process/stderr",
        threadId: "thread-1",
        message: "fatal: permission denied",
      }),
    );
  });
});

describe("pending request cleanup", () => {
  it("rejects pending RPCs and cancels approval/user-input requests on process exit", () => {
    const { manager, context, child, pendingReject, emitEvent } = createProcessHarness();

    (
      manager as unknown as {
        attachProcessListeners: (sessionContext: typeof context) => void;
      }
    ).attachProcessListeners(context);

    child.emit("exit", 1, null);

    expect(pendingReject).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "codex app-server exited (code=1, signal=null).",
      }),
    );
    expect(context.pending.size).toBe(0);
    expect(context.pendingApprovals.size).toBe(0);
    expect(context.pendingUserInputs.size).toBe(0);
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "serverRequest/resolved",
        requestId: "req-approval-1",
        payload: expect.objectContaining({
          status: "cancelled",
        }),
      }),
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "tool/requestUserInput/answered",
        requestId: "req-user-input-1",
        payload: expect.objectContaining({
          status: "cancelled",
          answers: {},
        }),
      }),
    );
  });

  it("clears pending start requests when stdin is no longer writable", async () => {
    const { manager, context } = createProcessHarness();
    context.pending.clear();
    context.pendingApprovals.clear();
    context.pendingUserInputs.clear();
    context.child.stdin.writable = false;

    await expect(
      (
        manager as unknown as {
          sendRequest: (
            sessionContext: typeof context,
            method: string,
            params: unknown,
          ) => Promise<unknown>;
        }
      ).sendRequest(context, "thread/start", {}),
    ).rejects.toThrow("Cannot write to codex app-server stdin.");

    expect(context.pending.size).toBe(0);
  });
});

describe("normalizeCodexModelSlug", () => {
  it("maps 5.3 aliases to gpt-5.3-codex", () => {
    expect(normalizeCodexModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeCodexModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
  });

  it("prefers codex id when model differs", () => {
    expect(normalizeCodexModelSlug("gpt-5.3", "gpt-5.3-codex")).toBe("gpt-5.3-codex");
  });

  it("keeps non-aliased models as-is", () => {
    expect(normalizeCodexModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
    expect(normalizeCodexModelSlug("gpt-5.2")).toBe("gpt-5.2");
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches not-found resume errors", () => {
    expect(
      isRecoverableThreadResumeError(new Error("thread/resume failed: thread not found")),
    ).toBe(true);
  });

  it("matches rollout-missing resume errors", () => {
    expect(
      isRecoverableThreadResumeError(
        new Error(
          "thread/resume failed: no rollout found for thread id 019d952b-fd4e-7e70-9a18-99ccd027b3db",
        ),
      ),
    ).toBe(true);
  });

  it("ignores non-resume errors", () => {
    expect(
      isRecoverableThreadResumeError(new Error("thread/start failed: permission denied")),
    ).toBe(false);
  });

  it("ignores non-recoverable resume errors", () => {
    expect(
      isRecoverableThreadResumeError(
        new Error("thread/resume failed: timed out waiting for server"),
      ),
    ).toBe(false);
  });
});

describe("readCodexAccountSnapshot", () => {
  it("disables spark for chatgpt plus accounts", () => {
    expect(
      readCodexAccountSnapshot({
        type: "chatgpt",
        email: "plus@example.com",
        planType: "plus",
      }),
    ).toEqual({
      type: "chatgpt",
      planType: "plus",
      sparkEnabled: false,
    });
  });

  it("keeps spark enabled for chatgpt pro accounts", () => {
    expect(
      readCodexAccountSnapshot({
        type: "chatgpt",
        email: "pro@example.com",
        planType: "pro",
      }),
    ).toEqual({
      type: "chatgpt",
      planType: "pro",
      sparkEnabled: true,
    });
  });

  it("disables spark for api key accounts", () => {
    expect(
      readCodexAccountSnapshot({
        type: "apiKey",
      }),
    ).toEqual({
      type: "apiKey",
      planType: null,
      sparkEnabled: false,
    });
  });

  it("disables spark for unknown chatgpt plans", () => {
    expect(
      readCodexAccountSnapshot({
        type: "chatgpt",
        email: "unknown@example.com",
      }),
    ).toEqual({
      type: "chatgpt",
      planType: "unknown",
      sparkEnabled: false,
    });
  });
});

describe("resolveCodexModelForAccount", () => {
  it("falls back from spark to default for unsupported chatgpt plans", () => {
    expect(
      resolveCodexModelForAccount("gpt-5.3-codex-spark", {
        type: "chatgpt",
        planType: "plus",
        sparkEnabled: false,
      }),
    ).toBe("gpt-5.3-codex");
  });

  it("keeps spark for supported plans", () => {
    expect(
      resolveCodexModelForAccount("gpt-5.3-codex-spark", {
        type: "chatgpt",
        planType: "pro",
        sparkEnabled: true,
      }),
    ).toBe("gpt-5.3-codex-spark");
  });

  it("falls back from spark to default for api key auth", () => {
    expect(
      resolveCodexModelForAccount("gpt-5.3-codex-spark", {
        type: "apiKey",
        planType: null,
        sparkEnabled: false,
      }),
    ).toBe("gpt-5.3-codex");
  });
});

describe("startSession", () => {
  it("forces stdio transport for codex app-server", () => {
    expect(buildCodexAppServerArgs()).toEqual(["app-server"]);
  });

  it("allows a longer initialize timeout for slow codex app-server startup", () => {
    expect(CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS).toBe(60_000);
  });

  it("enables Codex experimental api capabilities during initialize", () => {
    expect(buildCodexInitializeParams()).toEqual({
      clientInfo: {
        name: "shioricode_desktop",
        title: "ShioriCode Desktop",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  });

  it("emits session/startFailed when resolving cwd throws before process launch", async () => {
    const manager = new CodexAppServerManager();
    const events: Array<{ method: string; kind: string; message?: string }> = [];
    manager.on("event", (event) => {
      events.push({
        method: event.method,
        kind: event.kind,
        ...(event.message ? { message: event.message } : {}),
      });
    });

    const processCwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("cwd missing");
    });
    try {
      await expect(
        manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "codex",
          binaryPath: "codex",
          runtimeMode: "full-access",
        }),
      ).rejects.toThrow("cwd missing");
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        method: "session/startFailed",
        kind: "error",
        message: "cwd missing",
      });
    } finally {
      processCwd.mockRestore();
      manager.stopAll();
    }
  });

  it("fails fast with an upgrade message when codex is below the minimum supported version", async () => {
    const manager = new CodexAppServerManager();
    const events: Array<{ method: string; kind: string; message?: string }> = [];
    manager.on("event", (event) => {
      events.push({
        method: event.method,
        kind: event.kind,
        ...(event.message ? { message: event.message } : {}),
      });
    });

    const versionCheck = vi
      .spyOn(
        manager as unknown as {
          assertSupportedCodexCliVersion: (input: {
            binaryPath: string;
            cwd: string;
            homePath?: string;
          }) => void;
        },
        "assertSupportedCodexCliVersion",
      )
      .mockImplementation(() => {
        throw new Error(
          "Codex CLI v0.36.0 is too old for ShioriCode. Upgrade to v0.37.0 or newer and restart ShioriCode.",
        );
      });

    try {
      await expect(
        manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "codex",
          binaryPath: "codex",
          runtimeMode: "full-access",
        }),
      ).rejects.toThrow(
        "Codex CLI v0.36.0 is too old for ShioriCode. Upgrade to v0.37.0 or newer and restart ShioriCode.",
      );
      expect(versionCheck).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        {
          method: "session/startFailed",
          kind: "error",
          message:
            "Codex CLI v0.36.0 is too old for ShioriCode. Upgrade to v0.37.0 or newer and restart ShioriCode.",
        },
      ]);
    } finally {
      versionCheck.mockRestore();
      manager.stopAll();
    }
  });

  it("reads account and model metadata before thread/start and downgrades Spark for non-Pro accounts", async () => {
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "codex-start-preflight-"));
    const logPath = path.join(workspaceDir, "calls.jsonl");
    const binaryPath = createFakeCodexBinary({ dir: workspaceDir, logPath });
    const manager = new CodexAppServerManager();

    try {
      const session = await manager.startSession({
        threadId: asThreadId("thread-preflight"),
        provider: "codex",
        cwd: workspaceDir,
        runtimeMode: "full-access",
        model: "gpt-5.3-codex-spark",
        binaryPath,
      });
      const turn = await manager.sendTurn({
        threadId: session.threadId,
        input: "hello",
      });

      expect(session.resumeCursor).toEqual({ threadId: "provider_started" });
      expect(session.model).toBe("gpt-5.3-codex");
      expect(turn.resumeCursor).toEqual({ threadId: "provider_started" });

      const calls = readJsonl(logPath);
      const threadStartIndex = calls.findIndex((call) => call.method === "thread/start");
      const accountReadIndex = calls.findIndex((call) => call.method === "account/read");
      const modelListIndex = calls.findIndex((call) => call.method === "model/list");
      expect(accountReadIndex).toBeGreaterThan(-1);
      expect(modelListIndex).toBeGreaterThan(-1);
      expect(threadStartIndex).toBeGreaterThan(accountReadIndex);
      expect(threadStartIndex).toBeGreaterThan(modelListIndex);
      expect(calls.find((call) => call.method === "thread/start")?.params).toEqual(
        expect.objectContaining({
          model: "gpt-5.3-codex",
        }),
      );
      expect(calls.find((call) => call.method === "turn/start")?.params).toEqual(
        expect.objectContaining({
          model: "gpt-5.3-codex",
        }),
      );
    } finally {
      manager.stopAll();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("persists the fresh resume cursor when resume falls back to a new thread", async () => {
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "codex-resume-fallback-"));
    const logPath = path.join(workspaceDir, "calls.jsonl");
    const binaryPath = createFakeCodexBinary({ dir: workspaceDir, logPath, resumeFails: true });
    const manager = new CodexAppServerManager();

    try {
      const session = await manager.startSession({
        threadId: asThreadId("thread-resume-fallback"),
        provider: "codex",
        cwd: workspaceDir,
        runtimeMode: "full-access",
        resumeCursor: { threadId: "missing-provider-thread" },
        binaryPath,
      });

      expect(session.resumeCursor).toEqual({ threadId: "provider_started" });
      expect(session.status).toBe("ready");
      const calls = readJsonl(logPath);
      expect(calls.some((call) => call.method === "thread/resume")).toBe(true);
      expect(calls.some((call) => call.method === "thread/start")).toBe(true);
    } finally {
      manager.stopAll();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe("hydrateSessionMetadataInBackground", () => {
  it("updates the session account and model after startup without blocking thread open", async () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: asThreadId("thread_1"),
        runtimeMode: "full-access",
        model: "gpt-5.3-codex-spark",
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      supportsReasoningSummary: false,
      collabReceiverTurns: new Map(),
    };

    const sendRequest = vi
      .spyOn(
        manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
        "sendRequest",
      )
      .mockImplementation(async (_sessionContext, method) => {
        if (method === "model/list") {
          return { models: [] };
        }
        if (method === "account/read") {
          return {
            type: "chatgpt",
            planType: "plus",
          };
        }
        throw new Error(`Unexpected method: ${String(method)}`);
      });

    await (
      manager as unknown as {
        hydrateSessionMetadataInBackground: (
          sessionContext: typeof context,
          input: { requestedModel?: string },
        ) => Promise<void>;
      }
    ).hydrateSessionMetadataInBackground(context, {
      requestedModel: "gpt-5.3-codex-spark",
    });

    expect(sendRequest).toHaveBeenCalledTimes(2);
    expect(context.account).toEqual({
      type: "chatgpt",
      planType: "plus",
      sparkEnabled: false,
    });
    expect(context.session.model).toBe("gpt-5.3-codex");
  });

  it("swallows background metadata probe failures", async () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: asThreadId("thread_1"),
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      supportsReasoningSummary: false,
      collabReceiverTurns: new Map(),
    };

    vi.spyOn(
      manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
      "sendRequest",
    ).mockRejectedValue(new Error("probe failed"));

    await expect(
      (
        manager as unknown as {
          hydrateSessionMetadataInBackground: (
            sessionContext: typeof context,
            input: { requestedModel?: string },
          ) => Promise<void>;
        }
      ).hydrateSessionMetadataInBackground(context, {
        requestedModel: "gpt-5.3-codex",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("sendTurn", () => {
  it("sends text and image user input items to turn/start", async () => {
    const { manager, context, requireSession, sendRequest, updateSession } =
      createSendTurnHarness();

    const result = await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Inspect this image",
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
        },
      ],
      model: "gpt-5.3",
      serviceTier: "fast",
      effort: "high",
    });

    expect(result).toEqual({
      threadId: "thread_1",
      turnId: "turn_1",
      resumeCursor: { threadId: "thread_1" },
    });
    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      input: [
        {
          type: "text",
          text: "Inspect this image",
          text_elements: [],
        },
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
        },
      ],
      model: "gpt-5.3-codex",
      serviceTier: "fast",
      effort: "high",
    });
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "running",
      activeTurnId: "turn_1",
      resumeCursor: { threadId: "thread_1" },
    });
  });

  it("supports image-only turns", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,BBBB",
        },
      ],
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      input: [
        {
          type: "image",
          url: "data:image/png;base64,BBBB",
        },
      ],
      model: "gpt-5.3-codex",
    });
  });

  it("uses the in-memory provider thread id before the session becomes resumable", async () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "thread_1",
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      providerThreadId: "provider_thread_1",
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      supportsReasoningSummary: false,
      collabReceiverTurns: new Map(),
    };
    const requireSession = vi
      .spyOn(
        manager as unknown as { requireSession: (sessionId: string) => unknown },
        "requireSession",
      )
      .mockReturnValue(context);
    const sendRequest = vi
      .spyOn(
        manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
        "sendRequest",
      )
      .mockResolvedValue({
        turn: {
          id: "turn_1",
        },
      });
    const updateSession = vi
      .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
      .mockImplementation(() => {});

    const result = await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "hello",
    });

    expect(result).toEqual({
      threadId: "thread_1",
      turnId: "turn_1",
      resumeCursor: { threadId: "provider_thread_1" },
    });
    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "provider_thread_1",
      input: [
        {
          type: "text",
          text: "hello",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex",
    });
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "running",
      activeTurnId: "turn_1",
      resumeCursor: { threadId: "provider_thread_1" },
    });
  });

  it("passes Codex plan mode as a collaboration preset on turn/start", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Plan the work",
      interactionMode: "plan",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      input: [
        {
          type: "text",
          text: "Plan the work",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: buildCodexCollaborationMode({
        interactionMode: "plan",
        model: "gpt-5.3-codex",
      }),
    });
  });

  it("passes Codex default mode as a collaboration preset on turn/start", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "PLEASE IMPLEMENT THIS PLAN:\n- step 1",
      interactionMode: "default",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      input: [
        {
          type: "text",
          text: "PLEASE IMPLEMENT THIS PLAN:\n- step 1",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: buildCodexCollaborationMode({
        interactionMode: "default",
        model: "gpt-5.3-codex",
      }),
    });
  });

  it("appends the assistant personality to Codex collaboration instructions", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    vi.spyOn(
      manager as unknown as {
        readAssistantSettingsAppendix: () => Promise<string | undefined>;
      },
      "readAssistantSettingsAppendix",
    ).mockResolvedValue(
      [
        "## Personality Overlay",
        "Apply this as a light tone overlay on top of every other instruction in this prompt.",
        "Never let tone reduce honesty, correctness, safety, or clarity.",
        "Sound practical, grounded, and outcome-focused.",
      ].join("\n"),
    );

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Implement this carefully",
      interactionMode: "default",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      input: [
        {
          type: "text",
          text: "Implement this carefully",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: buildCodexCollaborationMode({
        interactionMode: "default",
        model: "gpt-5.3-codex",
        developerInstructionsAppendix: [
          "## Personality Overlay",
          "Apply this as a light tone overlay on top of every other instruction in this prompt.",
          "Never let tone reduce honesty, correctness, safety, or clarity.",
          "Sound practical, grounded, and outcome-focused.",
        ].join("\n"),
      }),
    });
  });

  it("keeps the session model when interaction mode is set without an explicit model", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    context.session.model = "gpt-5.2-codex";

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Plan this with my current session model",
      interactionMode: "plan",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      input: [
        {
          type: "text",
          text: "Plan this with my current session model",
          text_elements: [],
        },
      ],
      model: "gpt-5.2-codex",
      collaborationMode: buildCodexCollaborationMode({
        interactionMode: "plan",
        model: "gpt-5.2-codex",
      }),
    });
  });

  it("requests detailed reasoning summaries when the session supports them", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    context.supportsReasoningSummary = true;

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Determine whether 91 is prime.",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      input: [
        {
          type: "text",
          text: "Determine whether 91 is prime.",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex",
      summary: "detailed",
    });
  });

  it("does not request detailed reasoning summaries for spark", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    context.session.model = "gpt-5.3-codex-spark";
    context.supportsReasoningSummary = true;

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Build a simple 2d pixel video game.",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      input: [
        {
          type: "text",
          text: "Build a simple 2d pixel video game.",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex-spark",
    });
  });

  it("rejects empty turn input", async () => {
    const { manager } = createSendTurnHarness();

    await expect(
      manager.sendTurn({
        threadId: asThreadId("thread_1"),
      }),
    ).rejects.toThrow("Turn input must include text or attachments.");
  });
});

describe("thread checkpoint control", () => {
  it("reads thread turns from thread/read", async () => {
    const { manager, context, requireSession, sendRequest } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      thread: {
        id: "thread_1",
        turns: [
          {
            id: "turn_1",
            items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
          },
        ],
      },
    });

    const result = await manager.readThread(asThreadId("thread_1"));

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(sendRequest).toHaveBeenCalledWith(context, "thread/read", {
      threadId: "thread_1",
      includeTurns: true,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });
  });

  it("reads thread turns for fresh prewarmed sessions before a resume cursor exists", async () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "thread_1",
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      providerThreadId: "provider_thread_1",
      collabReceiverTurns: new Map(),
    };
    const requireSession = vi
      .spyOn(
        manager as unknown as { requireSession: (sessionId: string) => unknown },
        "requireSession",
      )
      .mockReturnValue(context);
    const sendRequest = vi.spyOn(
      manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
      "sendRequest",
    );
    sendRequest.mockResolvedValue({
      thread: {
        id: "provider_thread_1",
        turns: [
          {
            id: "turn_1",
            items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
          },
        ],
      },
    });

    const result = await manager.readThread(asThreadId("thread_1"));

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(sendRequest).toHaveBeenCalledWith(context, "thread/read", {
      threadId: "provider_thread_1",
      includeTurns: true,
    });
    expect(result).toEqual({
      threadId: "provider_thread_1",
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });
  });

  it("reads thread turns from flat thread/read responses", async () => {
    const { manager, context, sendRequest } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      threadId: "thread_1",
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });

    const result = await manager.readThread(asThreadId("thread_1"));

    expect(sendRequest).toHaveBeenCalledWith(context, "thread/read", {
      threadId: "thread_1",
      includeTurns: true,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });
  });

  it("rolls back turns via thread/rollback and resets session running state", async () => {
    const { manager, context, sendRequest, updateSession } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      thread: {
        id: "thread_1",
        turns: [],
      },
    });

    const result = await manager.rollbackThread(asThreadId("thread_1"), 2);

    expect(sendRequest).toHaveBeenCalledWith(context, "thread/rollback", {
      threadId: "thread_1",
      numTurns: 2,
    });
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "ready",
      activeTurnId: undefined,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      turns: [],
    });
  });
});

describe("respondToRequest", () => {
  it("passes structured codex approval decisions through to JSON-RPC responses", async () => {
    const { manager, context, requireSession, writeMessage, emitEvent } =
      createPendingApprovalHarness();
    const decision = {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ['allow: ["git", "status"]'],
      },
    } as const;

    await manager.respondToRequest(
      asThreadId("thread_1"),
      ApprovalRequestId.makeUnsafe("req-approval-1"),
      decision,
    );

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      result: {
        decision,
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/requestApproval/decision",
        payload: expect.objectContaining({
          requestId: "req-approval-1",
          requestKind: "command",
          decision,
        }),
      }),
    );
  });
});

describe("respondToUserInput", () => {
  it("serializes canonical answers to Codex native answer objects", async () => {
    const { manager, context, requireSession, writeMessage, emitEvent } =
      createPendingUserInputHarness();

    await manager.respondToUserInput(
      asThreadId("thread_1"),
      ApprovalRequestId.makeUnsafe("req-user-input-1"),
      {
        scope: "All request methods",
        compat: "Keep current envelope",
      },
    );

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      result: {
        answers: {
          scope: { answers: ["All request methods"] },
          compat: { answers: ["Keep current envelope"] },
        },
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/tool/requestUserInput/answered",
        payload: {
          requestId: "req-user-input-1",
          answers: {
            scope: { answers: ["All request methods"] },
            compat: { answers: ["Keep current envelope"] },
          },
        },
      }),
    );
  });

  it("preserves explicit empty multi-select answers", async () => {
    const { manager, context, requireSession, writeMessage, emitEvent } =
      createPendingUserInputHarness();

    await manager.respondToUserInput(
      asThreadId("thread_1"),
      ApprovalRequestId.makeUnsafe("req-user-input-1"),
      {
        scope: [],
      },
    );

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      result: {
        answers: {
          scope: { answers: [] },
        },
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/tool/requestUserInput/answered",
        payload: {
          requestId: "req-user-input-1",
          answers: {
            scope: { answers: [] },
          },
        },
      }),
    );
  });

  it("emits the matching answered method for tool/requestUserInput requests", async () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "thread_1",
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      pendingUserInputs: new Map([
        [
          ApprovalRequestId.makeUnsafe("req-user-input-1"),
          {
            requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
            jsonRpcId: 42,
            threadId: asThreadId("thread_1"),
            requestMethod: "tool/requestUserInput",
          },
        ],
      ]),
      collabReceiverTurns: new Map(),
    };
    const requireSession = vi
      .spyOn(
        manager as unknown as { requireSession: (sessionId: string) => unknown },
        "requireSession",
      )
      .mockReturnValue(context);
    const writeMessage = vi
      .spyOn(manager as unknown as { writeMessage: (...args: unknown[]) => void }, "writeMessage")
      .mockImplementation(() => {});
    const emitEvent = vi
      .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
      .mockImplementation(() => {});

    await manager.respondToUserInput(
      asThreadId("thread_1"),
      ApprovalRequestId.makeUnsafe("req-user-input-1"),
      {
        scope: "All request methods",
      },
    );

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      result: {
        answers: {
          scope: { answers: ["All request methods"] },
        },
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "tool/requestUserInput/answered",
      }),
    );
  });

  it("answers mcp elicitation requests with MCP accept content", async () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "thread_1",
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      pendingUserInputs: new Map([
        [
          ApprovalRequestId.makeUnsafe("req-user-input-1"),
          {
            requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
            jsonRpcId: 42,
            threadId: asThreadId("thread_1"),
            requestMethod: "mcpServer/elicitation/request",
          },
        ],
      ]),
      collabReceiverTurns: new Map(),
    };
    vi.spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    ).mockReturnValue(context);
    const writeMessage = vi
      .spyOn(manager as unknown as { writeMessage: (...args: unknown[]) => void }, "writeMessage")
      .mockImplementation(() => {});
    const emitEvent = vi
      .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
      .mockImplementation(() => {});

    await manager.respondToUserInput(
      asThreadId("thread_1"),
      ApprovalRequestId.makeUnsafe("req-user-input-1"),
      {
        project: "server",
      },
    );

    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      result: {
        action: "accept",
        content: {
          project: "server",
        },
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/tool/requestUserInput/answered",
        payload: {
          requestId: "req-user-input-1",
          answers: {
            project: "server",
          },
        },
      }),
    );
  });

  it("tracks file-read approval requests with the correct method", () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        sessionId: "sess_1",
        provider: "codex",
        status: "ready",
        threadId: asThreadId("thread_1"),
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
    };
    type ApprovalRequestContext = {
      session: typeof context.session;
      pendingApprovals: typeof context.pendingApprovals;
      pendingUserInputs: typeof context.pendingUserInputs;
    };

    (
      manager as unknown as {
        handleServerRequest: (
          context: ApprovalRequestContext,
          request: Record<string, unknown>,
        ) => void;
      }
    ).handleServerRequest(context, {
      jsonrpc: "2.0",
      id: 42,
      method: "item/fileRead/requestApproval",
      params: {},
    });

    const request = Array.from(context.pendingApprovals.values())[0];
    expect(request?.requestKind).toBe("file-read");
    expect(request?.method).toBe("item/fileRead/requestApproval");
  });

  it("tracks tool/requestUserInput requests without rejecting the server request", () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        sessionId: "sess_1",
        provider: "codex",
        status: "ready",
        threadId: asThreadId("thread_1"),
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
    };
    const writeMessage = vi
      .spyOn(manager as unknown as { writeMessage: (...args: unknown[]) => void }, "writeMessage")
      .mockImplementation(() => {});

    (
      manager as unknown as {
        handleServerRequest: (context: unknown, request: Record<string, unknown>) => void;
      }
    ).handleServerRequest(context, {
      jsonrpc: "2.0",
      id: 42,
      method: "tool/requestUserInput",
      params: {
        questions: [
          {
            id: "runtime_mode",
            header: "Runtime mode",
            question: "Which mode should be used?",
            options: [
              {
                label: "default",
                description: "Restore the base permission mode.",
              },
            ],
          },
        ],
      },
    });

    const pendingRequest = Array.from(context.pendingUserInputs.values())[0];
    expect(pendingRequest).toEqual(
      expect.objectContaining({
        requestMethod: "tool/requestUserInput",
      }),
    );
    expect(writeMessage).not.toHaveBeenCalled();
  });

  it("tracks mcp elicitation requests as structured user input", () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        sessionId: "sess_1",
        provider: "codex",
        status: "ready",
        threadId: asThreadId("thread_1"),
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
    };
    const writeMessage = vi
      .spyOn(manager as unknown as { writeMessage: (...args: unknown[]) => void }, "writeMessage")
      .mockImplementation(() => {});
    const emitEvent = vi
      .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
      .mockImplementation(() => {});

    (
      manager as unknown as {
        handleServerRequest: (context: unknown, request: Record<string, unknown>) => void;
      }
    ).handleServerRequest(context, {
      jsonrpc: "2.0",
      id: 42,
      method: "mcpServer/elicitation/request",
      params: {
        message: "Choose a project",
        requestedSchema: {
          properties: {
            project: {
              title: "Project",
              description: "Project to inspect",
              enum: ["web", "server"],
            },
          },
        },
      },
    });

    const pendingRequest = Array.from(context.pendingUserInputs.values())[0];
    expect(pendingRequest).toEqual(
      expect.objectContaining({
        requestMethod: "mcpServer/elicitation/request",
      }),
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "mcpServer/elicitation/request",
        payload: expect.objectContaining({
          questions: [
            {
              id: "project",
              header: "Project",
              question: "Project to inspect",
              options: [
                { label: "web", description: "Project to inspect" },
                { label: "server", description: "Project to inspect" },
              ],
            },
          ],
        }),
      }),
    );
    expect(writeMessage).not.toHaveBeenCalled();
  });

  it("tracks permissions/requestApproval as a command approval", () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        sessionId: "sess_1",
        provider: "codex",
        status: "ready",
        threadId: asThreadId("thread_1"),
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
    };

    (
      manager as unknown as {
        handleServerRequest: (context: unknown, request: Record<string, unknown>) => void;
      }
    ).handleServerRequest(context, {
      jsonrpc: "2.0",
      id: 42,
      method: "permissions/requestApproval",
      params: {
        reason: "Need to run a command",
      },
    });

    expect(Array.from(context.pendingApprovals.values())[0]).toEqual(
      expect.objectContaining({
        method: "permissions/requestApproval",
        requestKind: "command",
      }),
    );
  });

  it("returns explicit unsupported responses for app-server tool calls", () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        sessionId: "sess_1",
        provider: "codex",
        status: "ready",
        threadId: asThreadId("thread_1"),
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
    };
    const writeMessage = vi
      .spyOn(manager as unknown as { writeMessage: (...args: unknown[]) => void }, "writeMessage")
      .mockImplementation(() => {});

    (
      manager as unknown as {
        handleServerRequest: (context: unknown, request: Record<string, unknown>) => void;
      }
    ).handleServerRequest(context, {
      jsonrpc: "2.0",
      id: 42,
      method: "item/tool/call",
      params: {
        name: "unknown",
      },
    });

    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      error: {
        code: -32601,
        message: "Unsupported server request: item/tool/call",
      },
    });
  });

  it("returns explicit unsupported responses for ChatGPT auth refresh requests", () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        sessionId: "sess_1",
        provider: "codex",
        status: "ready",
        threadId: asThreadId("thread_1"),
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
    };
    const writeMessage = vi
      .spyOn(manager as unknown as { writeMessage: (...args: unknown[]) => void }, "writeMessage")
      .mockImplementation(() => {});

    (
      manager as unknown as {
        handleServerRequest: (context: unknown, request: Record<string, unknown>) => void;
      }
    ).handleServerRequest(context, {
      jsonrpc: "2.0",
      id: 42,
      method: "account/chatgptAuthTokens/refresh",
      params: {},
    });

    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      error: {
        code: -32601,
        message: "Unsupported server request: account/chatgptAuthTokens/refresh",
      },
    });
  });
});

describe("collab child conversation routing", () => {
  it("rewrites child notification turn ids onto the parent turn", () => {
    const { manager, context, emitEvent } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        itemId: "msg_child_1",
        delta: "working",
      },
    });

    expect(emitEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "item/agentMessage/delta",
        turnId: "turn_parent",
        itemId: "msg_child_1",
        payload: expect.objectContaining({
          parentItemId: "call_collab_1",
        }),
      }),
    );
  });

  it("suppresses child lifecycle notifications so they cannot replace the parent turn", () => {
    const { manager, context, emitEvent, updateSession } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });
    emitEvent.mockClear();
    updateSession.mockClear();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/started",
      params: {
        threadId: "child_provider_1",
        turn: { id: "turn_child_1" },
      },
    });

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/completed",
      params: {
        threadId: "child_provider_1",
        turn: { id: "turn_child_1", status: "completed" },
      },
    });

    expect(emitEvent).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("rewrites child approval requests onto the parent turn", () => {
    const { manager, context, emitEvent } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });
    emitEvent.mockClear();

    (
      manager as unknown as {
        handleServerRequest: (context: unknown, request: Record<string, unknown>) => void;
      }
    ).handleServerRequest(context, {
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        itemId: "call_child_1",
        command: "bun install",
      },
    });

    expect(Array.from(context.pendingApprovals.values())[0]).toEqual(
      expect.objectContaining({
        turnId: "turn_parent",
        itemId: "call_child_1",
      }),
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/commandExecution/requestApproval",
        turnId: "turn_parent",
        itemId: "call_child_1",
        payload: expect.objectContaining({
          parentItemId: "call_collab_1",
        }),
      }),
    );
  });
});

describe.skipIf(!process.env.CODEX_BINARY_PATH)("startSession live Codex resume", () => {
  it("keeps prior thread history when resuming with a changed runtime mode", async () => {
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "codex-live-resume-"));
    writeFileSync(path.join(workspaceDir, "README.md"), "hello\n", "utf8");

    const manager = new CodexAppServerManager();

    try {
      const firstSession = await manager.startSession({
        threadId: asThreadId("thread-live"),
        provider: "codex",
        cwd: workspaceDir,
        runtimeMode: "full-access",
        binaryPath: process.env.CODEX_BINARY_PATH!,
        ...(process.env.CODEX_HOME_PATH ? { homePath: process.env.CODEX_HOME_PATH } : {}),
      });

      const firstTurn = await manager.sendTurn({
        threadId: firstSession.threadId,
        input: `Reply with exactly the word ALPHA ${randomUUID()}`,
      });

      expect(firstTurn.threadId).toBe(firstSession.threadId);
      expect(firstTurn.resumeCursor).toBeDefined();

      await vi.waitFor(
        async () => {
          const snapshot = await manager.readThread(firstSession.threadId);
          expect(snapshot.turns.length).toBeGreaterThan(0);
        },
        { timeout: 120_000, interval: 1_000 },
      );

      const firstSnapshot = await manager.readThread(firstSession.threadId);
      const originalThreadId = firstSnapshot.threadId;
      const originalTurnCount = firstSnapshot.turns.length;

      manager.stopSession(firstSession.threadId);

      const resumedSession = await manager.startSession({
        threadId: firstSession.threadId,
        provider: "codex",
        cwd: workspaceDir,
        runtimeMode: "approval-required",
        resumeCursor: firstTurn.resumeCursor,
        binaryPath: process.env.CODEX_BINARY_PATH!,
        ...(process.env.CODEX_HOME_PATH ? { homePath: process.env.CODEX_HOME_PATH } : {}),
      });

      expect(resumedSession.threadId).toBe(originalThreadId);

      const resumedSnapshotBeforeTurn = await manager.readThread(resumedSession.threadId);
      expect(resumedSnapshotBeforeTurn.threadId).toBe(originalThreadId);
      expect(resumedSnapshotBeforeTurn.turns.length).toBeGreaterThanOrEqual(originalTurnCount);

      await manager.sendTurn({
        threadId: resumedSession.threadId,
        input: `Reply with exactly the word BETA ${randomUUID()}`,
      });

      await vi.waitFor(
        async () => {
          const snapshot = await manager.readThread(resumedSession.threadId);
          expect(snapshot.turns.length).toBeGreaterThan(originalTurnCount);
        },
        { timeout: 120_000, interval: 1_000 },
      );
    } finally {
      manager.stopAll();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }, 180_000);
});
