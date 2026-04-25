import { describe, expect, it } from "vitest";
import { EventId, ThreadId } from "contracts";

import { makeAcpToolCallEvent } from "./AcpCoreRuntimeEvents.ts";
import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

const baseToolCall = (overrides: Partial<AcpToolCallState>): AcpToolCallState => ({
  toolCallId: "tool-1",
  status: "inProgress",
  data: {
    toolCallId: "tool-1",
  },
  ...overrides,
});

const makeEvent = (toolCall: AcpToolCallState) =>
  makeAcpToolCallEvent({
    stamp: {
      eventId: EventId.makeUnsafe("evt-1"),
      createdAt: "2026-04-23T00:00:00.000Z",
    },
    provider: "gemini",
    threadId: ThreadId.makeUnsafe("thread-1"),
    toolCall,
    rawPayload: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
      },
    },
  });

describe("makeAcpToolCallEvent", () => {
  it("keeps Gemini file searches as dynamic tool calls instead of web search", () => {
    const event = makeEvent(
      baseToolCall({
        kind: "search",
        title: "Search for provider code",
        data: {
          toolCallId: "tool-1",
          kind: "search",
          title: "Search for provider code",
          locations: [{ path: "/workspace/apps/server/src/provider" }],
        },
      }),
    );

    expect(event.type).toBe("item.updated");
    if (event.type === "item.updated") {
      expect(event.payload.itemType).toBe("dynamic_tool_call");
      expect(event.payload.data).toMatchObject({
        title: "Search for provider code",
        locations: [{ path: "/workspace/apps/server/src/provider" }],
      });
    }
  });

  it("classifies Gemini web search/fetch tools as web search", () => {
    const searchEvent = makeEvent(
      baseToolCall({
        kind: "search",
        title: 'Searching the web for: "Gemini ACP"',
        data: {
          toolCallId: "tool-1",
          kind: "search",
          title: 'Searching the web for: "Gemini ACP"',
        },
      }),
    );
    const fetchEvent = makeEvent(
      baseToolCall({
        kind: "fetch",
        title: "Fetching content from: https://example.com",
        data: {
          toolCallId: "tool-1",
          kind: "fetch",
          title: "Fetching content from: https://example.com",
        },
      }),
    );

    if (searchEvent.type === "item.updated") {
      expect(searchEvent.payload.itemType).toBe("web_search");
    }
    if (fetchEvent.type === "item.updated") {
      expect(fetchEvent.payload.itemType).toBe("web_search");
    }
  });

  it("classifies Gemini MCP-titled tools as MCP tool calls", () => {
    const event = makeEvent(
      baseToolCall({
        kind: "other",
        title: "list_issues (github MCP Server)",
        data: {
          toolCallId: "tool-1",
          kind: "other",
          title: "list_issues (github MCP Server)",
        },
      }),
    );

    if (event.type === "item.updated") {
      expect(event.payload.itemType).toBe("mcp_tool_call");
    }
  });

  it("classifies Gemini ACP agent tools without treating every think tool as a subagent", () => {
    const topicEvent = makeEvent(
      baseToolCall({
        kind: "think",
        title: "Update topic",
        data: {
          toolCallId: "tool-1",
          kind: "think",
          title: "Update topic",
        },
      }),
    );
    const agentEvent = makeEvent(
      baseToolCall({
        kind: "think",
        title: "Codebase Agent",
        data: {
          toolCallId: "tool-1",
          kind: "think",
          title: "Codebase Agent",
        },
      }),
    );

    if (topicEvent.type === "item.updated") {
      expect(topicEvent.payload.itemType).toBe("dynamic_tool_call");
    }
    if (agentEvent.type === "item.updated") {
      expect(agentEvent.payload.itemType).toBe("collab_agent_tool_call");
    }
  });
});
