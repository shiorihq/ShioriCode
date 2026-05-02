import { describe, expect, it } from "vitest";
import type * as EffectAcpSchema from "effect-acp/schema";

import { normalizeAcpPromptUsage, parseSessionUpdateEvent } from "./AcpRuntimeModel.ts";

describe("parseSessionUpdateEvent", () => {
  it("preserves Gemini ACP tool state that only includes kind/title/locations/content", () => {
    const parsed = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "read_file-1",
        status: "in_progress",
        title: "package.json",
        kind: "read",
        content: [],
        locations: [{ path: "/workspace/package.json" }],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(parsed.events).toHaveLength(1);
    const [event] = parsed.events;
    expect(event?._tag).toBe("ToolCallUpdated");
    if (event?._tag === "ToolCallUpdated") {
      expect(event.toolCall).toMatchObject({
        toolCallId: "read_file-1",
        kind: "read",
        title: "package.json",
        status: "inProgress",
        data: {
          toolCallId: "read_file-1",
          kind: "read",
          title: "package.json",
          status: "inProgress",
          content: [],
          locations: [{ path: "/workspace/package.json" }],
        },
      });
    }
  });

  it("copies object rawInput/rawOutput into normalized input/result aliases", () => {
    const parsed = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "shell-1",
        status: "completed",
        title: "bun lint",
        kind: "execute",
        rawInput: { command: "bun lint" },
        rawOutput: { stdout: "ok" },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    const event = parsed.events[0];
    expect(event?._tag).toBe("ToolCallUpdated");
    if (event?._tag === "ToolCallUpdated") {
      expect(event.toolCall.data).toMatchObject({
        rawInput: { command: "bun lint" },
        input: { command: "bun lint" },
        rawOutput: { stdout: "ok" },
        result: { stdout: "ok" },
      });
    }
  });

  it("normalizes ACP context usage updates", () => {
    const parsed = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "usage_update",
        used: 1234,
        size: 200000,
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(parsed.events).toEqual([
      {
        _tag: "UsageUpdated",
        usage: {
          usedTokens: 1234,
          maxTokens: 200000,
        },
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "usage_update",
            used: 1234,
            size: 200000,
          },
        },
      },
    ]);
  });
});

describe("normalizeAcpPromptUsage", () => {
  it("maps ACP prompt usage to token usage snapshots", () => {
    expect(
      normalizeAcpPromptUsage({
        inputTokens: 100,
        cachedReadTokens: 20,
        cachedWriteTokens: 5,
        outputTokens: 30,
        thoughtTokens: 7,
        totalTokens: 162,
      }),
    ).toEqual({
      usedTokens: 162,
      totalProcessedTokens: 162,
      inputTokens: 100,
      cachedInputTokens: 25,
      outputTokens: 30,
      reasoningOutputTokens: 7,
      lastUsedTokens: 162,
      lastInputTokens: 100,
      lastCachedInputTokens: 25,
      lastOutputTokens: 30,
      lastReasoningOutputTokens: 7,
    });
  });
});
