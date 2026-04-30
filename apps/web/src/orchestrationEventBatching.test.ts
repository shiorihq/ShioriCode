import { describe, expect, it, vi } from "vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "contracts";
import { coalesceOrchestrationUiEvents, createFrameBatcher } from "./orchestrationEventBatching";

function makeEvent<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
  overrides: Partial<Extract<OrchestrationEvent, { type: T }>> = {},
): Extract<OrchestrationEvent, { type: T }> {
  const sequence = overrides.sequence ?? 1;
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId:
      "threadId" in payload
        ? payload.threadId
        : "projectId" in payload
          ? payload.projectId
          : ProjectId.makeUnsafe("project-1"),
    occurredAt: "2026-02-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
    ...overrides,
  } as Extract<OrchestrationEvent, { type: T }>;
}

describe("coalesceOrchestrationUiEvents", () => {
  it("merges adjacent streaming chunks for the same message", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const messageId = MessageId.makeUnsafe("message-1");
    const turnId = TurnId.makeUnsafe("turn-1");

    const events = coalesceOrchestrationUiEvents([
      makeEvent("thread.message-sent", {
        threadId,
        messageId,
        role: "assistant",
        text: "hel",
        turnId,
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      makeEvent("thread.message-sent", {
        threadId,
        messageId,
        role: "assistant",
        text: "lo",
        turnId,
        streaming: true,
        createdAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    ]);

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe("thread.message-sent");
    if (event?.type !== "thread.message-sent") {
      throw new Error("Expected a message event.");
    }
    expect(event.payload.text).toBe("hello");
    expect(event.payload.createdAt).toBe("2026-02-27T00:00:01.000Z");
    expect(event.payload.updatedAt).toBe("2026-02-27T00:00:02.000Z");
  });

  it("keeps final full message text instead of appending it", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const messageId = MessageId.makeUnsafe("message-1");
    const turnId = TurnId.makeUnsafe("turn-1");

    const events = coalesceOrchestrationUiEvents([
      makeEvent("thread.message-sent", {
        threadId,
        messageId,
        role: "assistant",
        text: "partial",
        turnId,
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      makeEvent("thread.message-sent", {
        threadId,
        messageId,
        role: "assistant",
        text: "complete",
        turnId,
        streaming: false,
        createdAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    ]);

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe("thread.message-sent");
    if (event?.type !== "thread.message-sent") {
      throw new Error("Expected a message event.");
    }
    expect(event.payload.text).toBe("complete");
    expect(event.payload.streaming).toBe(false);
  });
});

describe("createFrameBatcher", () => {
  it("flushes many pushed items in one frame", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    const flush = vi.fn();
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return 1;
    });
    const cancelFrame = vi.fn();
    const batcher = createFrameBatcher<number>({
      flush,
      requestFrame,
      cancelFrame,
    });

    batcher.push(1);
    batcher.push(2);
    batcher.push(3);

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(flush).not.toHaveBeenCalled();

    frameCallbacks[0]?.(16);

    expect(flush).toHaveBeenCalledWith([1, 2, 3]);
  });

  it("flushes pending items synchronously before recovery", () => {
    const flush = vi.fn();
    const requestFrame = vi.fn(() => 1);
    const cancelFrame = vi.fn();
    const batcher = createFrameBatcher<number>({
      flush,
      requestFrame,
      cancelFrame,
    });

    batcher.push(1);
    batcher.flushNow();

    expect(cancelFrame).toHaveBeenCalledWith(1);
    expect(flush).toHaveBeenCalledWith([1]);
  });

  it("flushes once the pending item cap is reached", () => {
    const flush = vi.fn();
    const requestFrame = vi.fn(() => 1);
    const cancelFrame = vi.fn();
    const batcher = createFrameBatcher<number>({
      flush,
      requestFrame,
      cancelFrame,
      maxItems: 2,
    });

    batcher.push(1);
    batcher.push(2);

    expect(cancelFrame).toHaveBeenCalledWith(1);
    expect(flush).toHaveBeenCalledWith([1, 2]);
  });

  it("flushes after the max delay when a frame is delayed", () => {
    vi.useFakeTimers();
    try {
      const flush = vi.fn();
      const requestFrame = vi.fn(() => 1);
      const cancelFrame = vi.fn();
      const batcher = createFrameBatcher<number>({
        flush,
        requestFrame,
        cancelFrame,
        maxDelayMs: 100,
      });

      batcher.push(1);
      vi.advanceTimersByTime(100);

      expect(cancelFrame).toHaveBeenCalledWith(1);
      expect(flush).toHaveBeenCalledWith([1]);
    } finally {
      vi.useRealTimers();
    }
  });
});
