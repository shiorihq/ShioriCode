import { describe, expect, it } from "vitest";

import { ThreadId } from "contracts";
import type { StreamEvent } from "@moonshot-ai/kimi-agent-sdk";

import {
  buildKimiExecutableWrapperScript,
  evaluateKimiToolLoopGuard,
  kimiAssistantDeltaFromContentPart,
  resolveKimiLoopControlFromEnv,
  shouldFlushKimiPendingTextAsAssistantAnswer,
  shouldAvoidKimiToolsForUserInput,
  shouldOmitKimiCompletedToolData,
  turnSnapshotFromEvents,
} from "./KimiCodeAdapter.ts";

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
});
