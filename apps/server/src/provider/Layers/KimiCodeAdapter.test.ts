import { describe, expect, it } from "vitest";

import { ThreadId } from "contracts";
import type { StreamEvent } from "@moonshot-ai/kimi-agent-sdk";

import {
  buildKimiExecutableWrapperScript,
  resolveKimiLoopControlFromEnv,
  shouldFlushKimiPendingTextAsAssistantAnswer,
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
      }),
    ).toEqual({
      maxStepsPerTurn: 32,
      maxRetriesPerStep: 1,
    });
    expect(
      resolveKimiLoopControlFromEnv({
        SHIORICODE_KIMI_MAX_STEPS_PER_TURN: "nope",
        SHIORICODE_KIMI_MAX_RETRIES_PER_STEP: "0",
      }),
    ).toEqual({
      maxStepsPerTurn: 64,
      maxRetriesPerStep: 2,
    });
  });
});
