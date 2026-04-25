import { describe, expect, it } from "vitest";
import type * as EffectAcpSchema from "effect-acp/schema";

import { parseSessionUpdateEvent } from "./AcpRuntimeModel.ts";

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
});
