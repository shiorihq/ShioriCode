import { describe, expect, it } from "vitest";

import { ThreadId } from "contracts";
import type { StreamEvent } from "@moonshot-ai/kimi-agent-sdk";

import {
  shouldFlushKimiPendingTextAsAssistantAnswer,
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

  it("keeps pre-tool/interrupted Kimi text out of final answers after tools ran", () => {
    expect(
      shouldFlushKimiPendingTextAsAssistantAnswer({
        turnFinished: false,
        toolCallSeen: true,
      }),
    ).toBe(false);
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
});
