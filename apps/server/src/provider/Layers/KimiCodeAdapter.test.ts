import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { type McpServerEntry, ThreadId } from "contracts";
import type { InitializeResult, ProtocolClient, StreamEvent } from "@moonshot-ai/kimi-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { KimiCodeAdapter } from "../Services/KimiCodeAdapter.ts";
import {
  buildKimiTerminalTokenUsage,
  buildKimiSessionFingerprint,
  buildKimiExecutableWrapperScript,
  evaluateKimiToolLoopGuard,
  findKimiResumeFingerprintMismatch,
  kimiAssistantDeltaFromContentPart,
  kimiMcpToolNeedsShioriApproval,
  mapKimiRequestKindToCanonical,
  rememberKimiShioriApprovalDecision,
  normalizeKimiQuestionAnswers,
  recordKimiProcessedTokenUsage,
  resolveKimiExternalToolTimeoutMsFromEnv,
  resolveKimiLoopControlFromEnv,
  resolveKimiThinking,
  resolveKimiTurnWatchdogTimeoutMsFromEnv,
  runKimiExternalToolWithTimeout,
  shouldRequestKimiShioriApproval,
  shouldFlushKimiPendingTextAsAssistantAnswer,
  shouldAvoidKimiToolsForUserInput,
  shouldOmitKimiCompletedToolData,
  turnSnapshotFromEvents,
  type KimiCodeAdapterLiveOptions,
  makeKimiCodeAdapterLive,
} from "./KimiCodeAdapter.ts";
import { evaluateKimiCliWireCompatibility, parseKimiInfoOutput } from "./KimiCodeProvider.ts";

function makeKimiShareDir(defaultThinking: boolean): string {
  const shareDir = mkdtempSync(path.join(tmpdir(), "shioricode-kimi-test-"));
  writeFileSync(
    path.join(shareDir, "config.toml"),
    [`default_thinking = ${defaultThinking ? "true" : "false"}`, ""].join("\n"),
  );
  return shareDir;
}

const KIMI_GOAL_TOOL_NAMES = [
  "mcp__shioricode-thread-goal__get_goal",
  "mcp__shioricode-thread-goal__update_goal",
] as const;

function makeKimiGoalServer(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    name: "shioricode-thread-goal",
    transport: "stdio",
    command: process.execPath,
    args: ["server.js", "thread-goal-mcp"],
    env: {
      SHIORICODE_THREAD_GOAL_CONTROL_URL: "http://127.0.0.1:4321/api/internal/thread-goal",
      SHIORICODE_THREAD_GOAL_CAPABILITY_TOKEN: "kimi-test-capability",
    },
    enabled: true,
    providers: ["kimiCode"],
    ...overrides,
  };
}

function makeKimiProtocolClientFactory(
  starts: Array<Parameters<ProtocolClient["start"]>[0]>,
): () => ProtocolClient {
  return () => {
    let running = false;
    return {
      get isRunning() {
        return running;
      },
      start: async (options: Parameters<ProtocolClient["start"]>[0]) => {
        running = true;
        starts.push(options);
        return {
          protocol_version: "1.7",
          server: { name: "kimi-test", version: "1.0.0" },
          slash_commands: [],
          external_tools: {
            accepted: options.externalTools?.map((tool) => tool.name) ?? [],
            rejected: [],
          },
        } satisfies InitializeResult;
      },
      stop: async () => {
        running = false;
      },
    } as unknown as ProtocolClient;
  };
}

function makeEmptyKimiSkillRuntime() {
  return {
    descriptors: [],
    executors: new Map(),
    warnings: [],
    skillPrompt: undefined,
    close: async () => undefined,
  };
}

async function runKimiStartSession(options: KimiCodeAdapterLiveOptions, threadId: string) {
  const testRoot = mkdtempSync(path.join(tmpdir(), "shioricode-kimi-adapter-goal-"));
  const runtime = ManagedRuntime.make(
    makeKimiCodeAdapterLive(options).pipe(
      Layer.provideMerge(ServerConfig.layerTest(testRoot, testRoot)),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const adapter = yield* KimiCodeAdapter;
        const result = yield* adapter
          .startSession({
            provider: "kimiCode",
            threadId: ThreadId.makeUnsafe(threadId),
            cwd: testRoot,
            runtimeMode: "full-access",
          })
          .pipe(Effect.result);
        if (result._tag === "Success") {
          yield* adapter.stopSession(result.success.threadId);
        }
        return result;
      }),
    );
  } finally {
    await runtime.dispose();
    rmSync(testRoot, { recursive: true, force: true });
  }
}

function makeKimiRotationHarness(failStartCall?: number) {
  const startedClients: Array<{ readonly stop: ReturnType<typeof vi.fn> }> = [];
  const resourceClosers: Array<ReturnType<typeof vi.fn>> = [];
  let startCall = 0;
  const options: KimiCodeAdapterLiveOptions = {
    loadEffectiveMcpServers: async () => ({ servers: [makeKimiGoalServer()], warnings: [] }),
    buildMcpToolRuntime: async () => {
      const close = vi.fn(async () => undefined);
      resourceClosers.push(close);
      return {
        descriptors: KIMI_GOAL_TOOL_NAMES.map((name) => ({
          name,
          description: name,
          inputSchema: { type: "object" },
        })),
        executors: new Map(
          KIMI_GOAL_TOOL_NAMES.map((name) => [
            name,
            { title: name, execute: async () => ({ ok: true }) },
          ]),
        ),
        warnings: [],
        close,
      };
    },
    buildSkillRuntime: async () => makeEmptyKimiSkillRuntime(),
    createProtocolClient: () => {
      let running = false;
      const stop = vi.fn(async () => {
        running = false;
      });
      return {
        get isRunning() {
          return running;
        },
        start: async () => {
          startCall += 1;
          if (startCall === failStartCall) throw new Error("replacement failed");
          running = true;
          startedClients.push({ stop });
          return {
            protocol_version: "1.7",
            server: { name: "kimi-test", version: "1.0.0" },
            slash_commands: [],
            external_tools: { accepted: [...KIMI_GOAL_TOOL_NAMES], rejected: [] },
          } satisfies InitializeResult;
        },
        stop,
      } as unknown as ProtocolClient;
    },
  };
  return { options, resourceClosers, startedClients };
}

describe("KimiCodeAdapter thread-goal provider boundary", () => {
  it("retires a Kimi runtime only after its replacement is ready", async () => {
    const harness = makeKimiRotationHarness();
    const testRoot = mkdtempSync(path.join(tmpdir(), "shioricode-kimi-rotation-"));
    const runtime = ManagedRuntime.make(
      makeKimiCodeAdapterLive(harness.options).pipe(
        Layer.provideMerge(ServerConfig.layerTest(testRoot, testRoot)),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const adapter = yield* KimiCodeAdapter;
          const threadId = ThreadId.makeUnsafe("thread-kimi-replacement");
          yield* adapter.startSession({
            provider: "kimiCode",
            threadId,
            cwd: testRoot,
            runtimeMode: "full-access",
          });
          yield* adapter.startSession({
            provider: "kimiCode",
            threadId,
            cwd: testRoot,
            runtimeMode: "full-access",
          });
          expect(harness.startedClients[0]?.stop).toHaveBeenCalledOnce();
          expect(harness.startedClients[1]?.stop).not.toHaveBeenCalled();
          expect(yield* adapter.listSessions()).toHaveLength(1);
        }),
      );
    } finally {
      await runtime.dispose();
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("preserves a Kimi runtime and cleans staged resources when replacement startup fails", async () => {
    const harness = makeKimiRotationHarness(2);
    const testRoot = mkdtempSync(path.join(tmpdir(), "shioricode-kimi-rotation-failure-"));
    const runtime = ManagedRuntime.make(
      makeKimiCodeAdapterLive(harness.options).pipe(
        Layer.provideMerge(ServerConfig.layerTest(testRoot, testRoot)),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const adapter = yield* KimiCodeAdapter;
          const threadId = ThreadId.makeUnsafe("thread-kimi-failed-replacement");
          const original = yield* adapter.startSession({
            provider: "kimiCode",
            threadId,
            cwd: testRoot,
            runtimeMode: "full-access",
          });
          yield* adapter
            .startSession({
              provider: "kimiCode",
              threadId,
              cwd: testRoot,
              runtimeMode: "full-access",
            })
            .pipe(Effect.flip);
          expect(harness.startedClients[0]?.stop).not.toHaveBeenCalled();
          expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual(original.resumeCursor);
          expect(yield* adapter.hasSession(threadId)).toBe(true);
          expect(harness.resourceClosers[1]).toHaveBeenCalledOnce();
        }),
      );
    } finally {
      await runtime.dispose();
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("starts only after exposing both harness goal tools to Kimi", async () => {
    const protocolStarts: Array<Parameters<ProtocolClient["start"]>[0]> = [];
    const closeMcp = vi.fn(async () => undefined);
    const loadEffectiveMcpServers = vi.fn(
      async (
        _input: Parameters<NonNullable<KimiCodeAdapterLiveOptions["loadEffectiveMcpServers"]>>[0],
      ) => ({
        servers: [makeKimiGoalServer()],
        warnings: [],
      }),
    );
    const buildMcpToolRuntime = vi.fn(
      async (
        _input: Parameters<NonNullable<KimiCodeAdapterLiveOptions["buildMcpToolRuntime"]>>[0],
        _options?: Parameters<NonNullable<KimiCodeAdapterLiveOptions["buildMcpToolRuntime"]>>[1],
      ) => ({
        descriptors: KIMI_GOAL_TOOL_NAMES.map((name) => ({
          name,
          description: name,
          inputSchema: { type: "object" },
        })),
        executors: new Map(
          KIMI_GOAL_TOOL_NAMES.map((name) => [
            name,
            { title: name, execute: async () => ({ ok: true }) },
          ]),
        ),
        warnings: [],
        close: closeMcp,
      }),
    );

    const result = await runKimiStartSession(
      {
        loadEffectiveMcpServers,
        buildMcpToolRuntime,
        buildSkillRuntime: async () => makeEmptyKimiSkillRuntime(),
        createProtocolClient: makeKimiProtocolClientFactory(protocolStarts),
      },
      "thread-kimi-goal-tools",
    );

    expect(result._tag).toBe("Success");
    expect(loadEffectiveMcpServers).toHaveBeenCalledOnce();
    expect(loadEffectiveMcpServers.mock.calls[0]?.[0]).toMatchObject({
      provider: "kimiCode",
      threadGoal: { threadId: "thread-kimi-goal-tools" },
    });
    expect(buildMcpToolRuntime).toHaveBeenCalledOnce();
    expect(buildMcpToolRuntime.mock.calls[0]?.[0].servers).toHaveLength(1);
    expect(buildMcpToolRuntime.mock.calls[0]?.[0].servers[0]).toMatchObject({
      name: "shioricode-thread-goal",
      command: process.execPath,
      args: expect.arrayContaining(["thread-goal-mcp"]),
      env: {
        SHIORICODE_THREAD_GOAL_CONTROL_URL: "http://127.0.0.1:4321/api/internal/thread-goal",
        SHIORICODE_THREAD_GOAL_CAPABILITY_TOKEN: "kimi-test-capability",
      },
    });
    expect(protocolStarts).toHaveLength(1);
    expect(protocolStarts[0]?.externalTools?.map((tool) => tool.name)).toEqual(
      KIMI_GOAL_TOOL_NAMES,
    );
    expect(closeMcp).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing", []],
    ["invalid", [makeKimiGoalServer({ command: "not-the-shiori-entrypoint" })]],
    ["duplicate", [makeKimiGoalServer(), makeKimiGoalServer()]],
  ] as const)("fails closed for a %s harness goal server", async (_label, servers) => {
    const protocolStarts: Array<Parameters<ProtocolClient["start"]>[0]> = [];
    const buildMcpToolRuntime = vi.fn(async () => {
      throw new Error("The invalid server must be rejected before MCP initialization.");
    });

    const result = await runKimiStartSession(
      {
        loadEffectiveMcpServers: async () => ({ servers, warnings: [] }),
        buildMcpToolRuntime,
        buildSkillRuntime: async () => makeEmptyKimiSkillRuntime(),
        createProtocolClient: makeKimiProtocolClientFactory(protocolStarts),
      },
      `thread-kimi-${_label}-goal-server`,
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      if (result.failure._tag !== "ProviderAdapterProcessError") {
        throw new Error(`Expected ProviderAdapterProcessError, received ${result.failure._tag}.`);
      }
      expect(result.failure.detail).toMatch(/thread-goal.*(?:received|invalid)/iu);
    }
    expect(buildMcpToolRuntime).not.toHaveBeenCalled();
    expect(protocolStarts).toHaveLength(0);
  });

  it("fails closed and closes MCP resources when a required goal tool is missing", async () => {
    const protocolStarts: Array<Parameters<ProtocolClient["start"]>[0]> = [];
    const closeMcp = vi.fn(async () => undefined);
    const getGoalTool = KIMI_GOAL_TOOL_NAMES[0];
    const result = await runKimiStartSession(
      {
        loadEffectiveMcpServers: async () => ({
          servers: [makeKimiGoalServer()],
          warnings: [],
        }),
        buildMcpToolRuntime: async () => ({
          descriptors: [
            {
              name: getGoalTool,
              description: getGoalTool,
              inputSchema: { type: "object" },
            },
          ],
          executors: new Map([
            [getGoalTool, { title: getGoalTool, execute: async () => ({ ok: true }) }],
          ]),
          warnings: [],
          close: closeMcp,
        }),
        buildSkillRuntime: async () => makeEmptyKimiSkillRuntime(),
        createProtocolClient: makeKimiProtocolClientFactory(protocolStarts),
      },
      "thread-kimi-missing-goal-tool",
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      if (result.failure._tag !== "ProviderAdapterProcessError") {
        throw new Error(`Expected ProviderAdapterProcessError, received ${result.failure._tag}.`);
      }
      expect(result.failure.detail).toContain("mcp__shioricode-thread-goal__update_goal");
    }
    expect(closeMcp).toHaveBeenCalledOnce();
    expect(protocolStarts).toHaveLength(0);
  });
});

describe("KimiCodeAdapter helpers", () => {
  it("uses stable turn ids when rebuilding snapshots from Kimi wire events", () => {
    const events: StreamEvent[] = [
      { type: "TurnBegin", payload: { user_input: "first" } },
      { type: "ContentPart", payload: { type: "text", text: "First answer." } },
      { type: "TurnEnd", payload: {} },
      { type: "TurnBegin", payload: { user_input: "second" } },
      { type: "ContentPart", payload: { type: "text", text: "Second answer." } },
      { type: "StepInterrupted", payload: {} },
    ] as StreamEvent[];

    const threadId = ThreadId.makeUnsafe("thread-kimi");
    const first = turnSnapshotFromEvents(threadId, "session-abc", events);
    const second = turnSnapshotFromEvents(threadId, "session-abc", events);

    expect(first.turns.map((turn) => String(turn.id))).toEqual([
      "kimi:session-abc:turn:1",
      "kimi:session-abc:turn:2",
    ]);
    expect(second.turns.map((turn) => String(turn.id))).toEqual(
      first.turns.map((turn) => String(turn.id)),
    );
  });

  it("deduplicates cumulative Kimi usage by provider message id", () => {
    const processedTokensByMessageId = new Map<string, number>();

    recordKimiProcessedTokenUsage({
      processedTokensByMessageId,
      messageId: "message-1",
      usedTokens: 100,
    });
    recordKimiProcessedTokenUsage({
      processedTokensByMessageId,
      messageId: "message-1",
      usedTokens: 140,
    });
    recordKimiProcessedTokenUsage({
      processedTokensByMessageId,
      messageId: "message-1",
      usedTokens: 120,
    });
    recordKimiProcessedTokenUsage({
      processedTokensByMessageId,
      messageId: "message-2",
      usedTokens: 60,
    });
    recordKimiProcessedTokenUsage({
      processedTokensByMessageId,
      messageId: undefined,
      usedTokens: 999,
    });

    expect(Object.fromEntries(processedTokensByMessageId)).toEqual({
      __unkeyed__: 999,
      "message-1": 140,
      "message-2": 60,
    });
    expect(
      buildKimiTerminalTokenUsage({
        processedTokensByMessageId,
        lastTokenUsage: {
          usedTokens: 60,
          lastUsedTokens: 60,
        },
      }),
    ).toEqual({
      usedTokens: 60,
      lastUsedTokens: 60,
      processedTokensDelta: 1_199,
    });
  });

  it("keeps pending Kimi text as assistant output even around tools", () => {
    expect(
      shouldFlushKimiPendingTextAsAssistantAnswer({
        turnFinished: false,
        toolCallSeen: true,
      }),
    ).toBe(true);
    expect(
      shouldFlushKimiPendingTextAsAssistantAnswer({
        turnFinished: true,
        toolCallSeen: true,
      }),
    ).toBe(true);
    expect(
      shouldFlushKimiPendingTextAsAssistantAnswer({
        turnFinished: false,
        toolCallSeen: false,
      }),
    ).toBe(true);
  });

  it("treats Kimi text content parts as assistant stream deltas", () => {
    expect(kimiAssistantDeltaFromContentPart({ type: "text", text: "hello" })).toBe("hello");
    expect(kimiAssistantDeltaFromContentPart({ type: "think", think: "reasoning" })).toBe(
      undefined,
    );
    expect(kimiAssistantDeltaFromContentPart({ type: "text", text: "" })).toBe("");
  });

  it("omits successful read tool result payloads from completed Kimi work items", () => {
    expect(shouldOmitKimiCompletedToolData({ toolName: "ReadFile", isError: false })).toBe(true);
    expect(shouldOmitKimiCompletedToolData({ toolName: "read", isError: false })).toBe(true);
    expect(shouldOmitKimiCompletedToolData({ toolName: "ReadFile", isError: true })).toBe(false);
    expect(shouldOmitKimiCompletedToolData({ toolName: "Search", isError: false })).toBe(false);
  });

  it("maps Computer Use approval request kinds to canonical runtime requests", () => {
    expect(mapKimiRequestKindToCanonical("computer-use")).toBe("computer_use_approval");
  });

  it("detects MCP tools that need ShioriCode-side approval wrapping", () => {
    expect(
      kimiMcpToolNeedsShioriApproval({
        name: "mcp__shiori-computer-use__computer_click",
        description: "Click.",
        inputSchema: {
          type: "object",
        },
      }),
    ).toBe(true);
    expect(
      kimiMcpToolNeedsShioriApproval({
        name: "mcp__shiori-computer-use__computer_permissions",
        description: "Inspect permissions.",
        inputSchema: {
          type: "object",
        },
      }),
    ).toBe(false);
  });

  it("remembers accept-for-session for ShioriCode-wrapped Kimi approvals", () => {
    const approvedRequestTypes = new Set<"computer_use_approval">();

    expect(
      shouldRequestKimiShioriApproval({
        requestType: "computer_use_approval",
        approvedRequestTypes,
      }),
    ).toBe(true);

    rememberKimiShioriApprovalDecision({
      requestType: "computer_use_approval",
      approvedRequestTypes,
      decision: "accept",
    });
    expect(
      shouldRequestKimiShioriApproval({
        requestType: "computer_use_approval",
        approvedRequestTypes,
      }),
    ).toBe(true);

    rememberKimiShioriApprovalDecision({
      requestType: "computer_use_approval",
      approvedRequestTypes,
      decision: "acceptForSession",
    });
    expect(
      shouldRequestKimiShioriApproval({
        requestType: "computer_use_approval",
        approvedRequestTypes,
      }),
    ).toBe(false);
  });

  it("wraps the Kimi executable with ShioriCode loop-control flags", () => {
    const script = buildKimiExecutableWrapperScript("/Applications/Kimi Code/kimi's");

    expect(script).toContain("exec '/Applications/Kimi Code/kimi'\\''s' \\");
    expect(script).toContain('max_steps="${SHIORICODE_KIMI_MAX_STEPS_PER_TURN:-64}"');
    expect(script).toContain('max_retries="${SHIORICODE_KIMI_MAX_RETRIES_PER_STEP:-2}"');
    expect(script).toContain('--max-steps-per-turn "$max_steps"');
    expect(script).toContain('--max-retries-per-step "$max_retries"');
  });

  it("lets environment variables tune Kimi loop-control limits", () => {
    expect(
      resolveKimiLoopControlFromEnv({
        SHIORICODE_KIMI_MAX_STEPS_PER_TURN: "32",
        SHIORICODE_KIMI_MAX_RETRIES_PER_STEP: "1",
        SHIORICODE_KIMI_MAX_TOOL_CALLS_PER_TURN: "12",
        SHIORICODE_KIMI_MAX_SHELL_CALLS_PER_TURN: "8",
      }),
    ).toEqual({
      maxStepsPerTurn: 32,
      maxRetriesPerStep: 1,
      maxToolCallsPerTurn: 12,
      maxShellCallsPerTurn: 8,
    });
    expect(
      resolveKimiLoopControlFromEnv({
        SHIORICODE_KIMI_MAX_STEPS_PER_TURN: "nope",
        SHIORICODE_KIMI_MAX_RETRIES_PER_STEP: "0",
        SHIORICODE_KIMI_MAX_TOOL_CALLS_PER_TURN: "-1",
        SHIORICODE_KIMI_MAX_SHELL_CALLS_PER_TURN: "",
      }),
    ).toEqual({
      maxStepsPerTurn: 64,
      maxRetriesPerStep: 2,
      maxToolCallsPerTurn: 32,
      maxShellCallsPerTurn: 24,
    });
  });

  it("blocks Kimi shell loops before the provider step limit", () => {
    expect(
      evaluateKimiToolLoopGuard({
        toolName: "Shell",
        toolCallCount: 23,
        shellCallCount: 23,
        maxToolCallsPerTurn: 32,
        maxShellCallsPerTurn: 24,
      }),
    ).toMatchObject({
      toolCallCount: 24,
      shellCallCount: 24,
      shouldBlock: false,
      trigger: null,
    });

    expect(
      evaluateKimiToolLoopGuard({
        toolName: "Shell",
        toolCallCount: 24,
        shellCallCount: 24,
        maxToolCallsPerTurn: 32,
        maxShellCallsPerTurn: 24,
      }),
    ).toMatchObject({
      toolCallCount: 25,
      shellCallCount: 25,
      shouldBlock: true,
      shouldCancel: true,
      trigger: "shell_call_limit",
    });
  });

  it("blocks tool use for short user stop/confusion prompts", () => {
    expect(
      shouldAvoidKimiToolsForUserInput("Stop running so many commands. What are you doing...?"),
    ).toBe(true);
    expect(shouldAvoidKimiToolsForUserInput("??")).toBe(true);
    expect(shouldAvoidKimiToolsForUserInput("Find some UI/UX design issues.")).toBe(false);

    expect(
      evaluateKimiToolLoopGuard({
        toolName: "Shell",
        toolCallCount: 0,
        shellCallCount: 0,
        maxToolCallsPerTurn: 32,
        maxShellCallsPerTurn: 24,
        toolsDisabledReason: "Answer directly without tools.",
      }),
    ).toMatchObject({
      toolCallCount: 1,
      shellCallCount: 1,
      shouldBlock: true,
      shouldCancel: false,
      trigger: "tools_disabled",
    });
  });

  it("normalizes Kimi question answers by generated question id first", () => {
    const questions = [
      {
        id: "request:1",
        header: "Q1",
        question: "Pick a branch",
        options: [{ label: "main", description: "main" }],
      },
    ];

    expect(
      normalizeKimiQuestionAnswers(questions, {
        "request:1": " feature ",
        "Pick a branch": "main",
      }),
    ).toEqual({
      "Pick a branch": "feature",
    });
  });

  it("normalizes Kimi multi-select answers and keeps legacy question text fallback", () => {
    const questions = [
      {
        id: "request:1",
        header: "Q1",
        question: "Choose tools",
        options: [{ label: "lint", description: "lint" }],
        multiSelect: true,
      },
      {
        id: "request:2",
        header: "Q2",
        question: "Proceed?",
        options: [{ label: "yes", description: "yes" }],
      },
    ];

    expect(
      normalizeKimiQuestionAnswers(questions, {
        "request:1": [" lint ", "", "typecheck"],
        "Proceed?": " yes ",
      }),
    ).toEqual({
      "Choose tools": "lint, typecheck",
      "Proceed?": "yes",
    });
  });

  it("omits missing or empty Kimi question answers", () => {
    expect(
      normalizeKimiQuestionAnswers(
        [
          {
            id: "request:1",
            header: "Q1",
            question: "Proceed?",
            options: [{ label: "yes", description: "yes" }],
          },
        ],
        {
          "request:1": "   ",
        },
      ),
    ).toEqual({});
  });

  it("uses Kimi config default thinking when the UI omits the thinking option", () => {
    const enabledShareDir = makeKimiShareDir(true);
    const disabledShareDir = makeKimiShareDir(false);

    expect(
      resolveKimiThinking({
        shareDir: enabledShareDir,
        modelSelection: {
          provider: "kimiCode",
          model: "kimi2.7-code",
        },
      }),
    ).toBe(true);
    expect(
      resolveKimiThinking({
        shareDir: disabledShareDir,
        modelSelection: {
          provider: "kimiCode",
          model: "kimi2.7-code",
        },
      }),
    ).toBe(false);
  });

  it("lets explicit Kimi thinking override the config default", () => {
    const enabledShareDir = makeKimiShareDir(true);
    const disabledShareDir = makeKimiShareDir(false);

    expect(
      resolveKimiThinking({
        shareDir: enabledShareDir,
        modelSelection: {
          provider: "kimiCode",
          model: "kimi2.7-code",
          options: { thinking: false },
        },
      }),
    ).toBe(false);
    expect(
      resolveKimiThinking({
        shareDir: disabledShareDir,
        modelSelection: {
          provider: "kimiCode",
          model: "kimi2.7-code",
          options: { thinking: true },
        },
      }),
    ).toBe(true);
  });

  it("detects Kimi resume fingerprint changes that should not silently resume", () => {
    const previous = buildKimiSessionFingerprint({
      agentSignature: "agent-v1",
      workDir: "/workspace",
      shareDir: "/share",
    });
    const next = buildKimiSessionFingerprint({
      agentSignature: "agent-v2",
      workDir: "/workspace",
      shareDir: "/share",
    });

    expect(findKimiResumeFingerprintMismatch({ previous, next })).toBe("agentSignature");
  });

  it("can compare Kimi CLI and wire metadata after initialize", () => {
    const previous = buildKimiSessionFingerprint({
      agentSignature: "agent",
      workDir: "/workspace",
      initializeResult: {
        protocol_version: "1.7.0",
        server: { name: "kimi", version: "1.2.3" },
        slash_commands: [],
      },
    });
    const next = buildKimiSessionFingerprint({
      agentSignature: "agent",
      workDir: "/workspace",
      initializeResult: {
        protocol_version: "1.8.0",
        server: { name: "kimi", version: "1.2.3" },
        slash_commands: [],
      },
    });

    expect(
      findKimiResumeFingerprintMismatch({
        previous,
        next,
        compareRuntime: true,
      }),
    ).toBe("wireVersion");
  });

  it("returns a deterministic Kimi external tool timeout result", async () => {
    const warnings: string[] = [];
    const result = await runKimiExternalToolWithTimeout({
      toolName: "stuck_tool",
      timeoutMs: 1,
      execute: () => new Promise(() => undefined),
      onTimeout: (message) => {
        warnings.push(message);
      },
    });

    expect(result.message).toBe("Tool 'stuck_tool' timed out.");
    expect(result.output).toContain("stuck_tool");
    expect(warnings).toHaveLength(1);
  });

  it("lets environment variables tune Kimi timeout controls", () => {
    expect(
      resolveKimiExternalToolTimeoutMsFromEnv({
        SHIORICODE_KIMI_EXTERNAL_TOOL_TIMEOUT_MS: "7",
      }),
    ).toBe(7);
    expect(
      resolveKimiTurnWatchdogTimeoutMsFromEnv({
        SHIORICODE_KIMI_TURN_WATCHDOG_MS: "9",
      }),
    ).toBe(9);
  });

  it("parses Kimi CLI and wire versions from JSON info output", () => {
    const info = parseKimiInfoOutput(
      JSON.stringify({
        cli_version: "0.9.1",
        wire_protocol_version: "1.7.0",
        capabilities: { supports_question: true },
      }),
    );

    expect(info).toEqual({
      cliVersion: "0.9.1",
      wireVersion: "1.7.0",
      capabilities: { supports_question: true },
    });
    expect(evaluateKimiCliWireCompatibility(info)).toEqual({ status: "ready" });
  });

  it("parses Kimi CLI and wire versions from text info output", () => {
    expect(parseKimiInfoOutput("Kimi Code 0.9.1\nWire protocol: 1.7\n")).toEqual({
      cliVersion: "0.9.1",
      wireVersion: "1.7.0",
    });
  });

  it("warns when Kimi wire compatibility cannot be verified or is too old", () => {
    expect(
      evaluateKimiCliWireCompatibility({
        cliVersion: "0.9.1",
        wireVersion: null,
      }),
    ).toMatchObject({ status: "warning" });
    expect(
      evaluateKimiCliWireCompatibility({
        cliVersion: "0.9.1",
        wireVersion: "1.6.0",
      }),
    ).toMatchObject({ status: "warning" });
  });
});
