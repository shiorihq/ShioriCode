import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ThreadId } from "contracts";
import type { StreamEvent } from "@moonshot-ai/kimi-agent-sdk";

import {
  buildKimiSessionFingerprint,
  buildKimiExecutableWrapperScript,
  evaluateKimiToolLoopGuard,
  findKimiResumeFingerprintMismatch,
  kimiAssistantDeltaFromContentPart,
  normalizeKimiQuestionAnswers,
  resolveKimiExternalToolTimeoutMsFromEnv,
  resolveKimiLoopControlFromEnv,
  resolveKimiThinking,
  resolveKimiTurnWatchdogTimeoutMsFromEnv,
  runKimiExternalToolWithTimeout,
  shouldFlushKimiPendingTextAsAssistantAnswer,
  shouldAvoidKimiToolsForUserInput,
  shouldOmitKimiCompletedToolData,
  turnSnapshotFromEvents,
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
          model: "kimi-code/kimi-for-coding",
        },
      }),
    ).toBe(true);
    expect(
      resolveKimiThinking({
        shareDir: disabledShareDir,
        modelSelection: {
          provider: "kimiCode",
          model: "kimi-code/kimi-for-coding",
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
          model: "kimi-code/kimi-for-coding",
          options: { thinking: false },
        },
      }),
    ).toBe(false);
    expect(
      resolveKimiThinking({
        shareDir: disabledShareDir,
        modelSelection: {
          provider: "kimiCode",
          model: "kimi-code/kimi-for-coding",
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
