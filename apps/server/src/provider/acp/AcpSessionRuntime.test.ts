import { describe, expect, it } from "vitest";

import { mergeToolCallState, type AcpToolCallState } from "./AcpRuntimeModel.ts";
import { shouldEmitToolCallUpdate } from "./AcpSessionRuntime.ts";

const makeToolCall = (overrides: Partial<AcpToolCallState> = {}): AcpToolCallState => ({
  toolCallId: "call-1",
  kind: "read",
  title: "Reading configuration file",
  status: "pending",
  data: {
    toolCallId: "call-1",
    kind: "read",
  },
  ...overrides,
});

describe("AcpSessionRuntime tool call emission", () => {
  it("emits newly created tool calls even when they only have title and status", () => {
    expect(shouldEmitToolCallUpdate(undefined, makeToolCall())).toBe(true);
  });

  it("emits status-only updates for existing tool calls", () => {
    const previous = makeToolCall();
    const next = mergeToolCallState(previous, {
      toolCallId: "call-1",
      status: "inProgress",
      data: {
        toolCallId: "call-1",
      },
    });

    expect(shouldEmitToolCallUpdate(previous, next)).toBe(true);
  });

  it("suppresses duplicate non-terminal tool call updates", () => {
    const previous = makeToolCall({ status: "inProgress" });
    const next = makeToolCall({ status: "inProgress" });

    expect(shouldEmitToolCallUpdate(previous, next)).toBe(false);
  });
});
