import { type OrchestrationEvent } from "contracts";

export function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  if (events.length < 2) {
    return [...events];
  }

  const coalesced: OrchestrationEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (
      previous?.type === "thread.message-sent" &&
      event.type === "thread.message-sent" &&
      previous.payload.threadId === event.payload.threadId &&
      previous.payload.messageId === event.payload.messageId
    ) {
      coalesced[coalesced.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          attachments: event.payload.attachments ?? previous.payload.attachments,
          createdAt: previous.payload.createdAt,
          text:
            !event.payload.streaming && event.payload.text.length > 0
              ? event.payload.text
              : previous.payload.text + event.payload.text,
        },
      };
      continue;
    }

    coalesced.push(event);
  }

  return coalesced;
}

interface CreateFrameBatcherOptions<T> {
  flush: (items: ReadonlyArray<T>) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  maxDelayMs?: number;
  maxItems?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export function createFrameBatcher<T>({
  flush,
  requestFrame = globalThis.requestAnimationFrame.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame.bind(globalThis),
  maxDelayMs,
  maxItems = Number.POSITIVE_INFINITY,
  setTimer = globalThis.setTimeout.bind(globalThis),
  clearTimer = globalThis.clearTimeout.bind(globalThis),
}: CreateFrameBatcherOptions<T>) {
  const pendingItems: T[] = [];
  let scheduledFrame: number | null = null;
  let scheduledTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const cancelScheduledFlush = () => {
    if (scheduledFrame !== null) {
      cancelFrame(scheduledFrame);
      scheduledFrame = null;
    }
    if (scheduledTimer !== null) {
      clearTimer(scheduledTimer);
      scheduledTimer = null;
    }
  };

  const flushNow = () => {
    cancelScheduledFlush();
    if (pendingItems.length === 0) {
      return;
    }
    const items = pendingItems.splice(0, pendingItems.length);
    flush(items);
  };

  const schedule = () => {
    if (disposed || scheduledFrame !== null) {
      return;
    }
    scheduledFrame = requestFrame(() => {
      scheduledFrame = null;
      if (scheduledTimer !== null) {
        clearTimer(scheduledTimer);
        scheduledTimer = null;
      }
      if (disposed || pendingItems.length === 0) {
        return;
      }
      const items = pendingItems.splice(0, pendingItems.length);
      flush(items);
    });
    if (maxDelayMs !== undefined && scheduledTimer === null) {
      scheduledTimer = setTimer(() => {
        scheduledTimer = null;
        if (scheduledFrame !== null) {
          cancelFrame(scheduledFrame);
          scheduledFrame = null;
        }
        if (disposed || pendingItems.length === 0) {
          return;
        }
        const items = pendingItems.splice(0, pendingItems.length);
        flush(items);
      }, maxDelayMs);
    }
  };

  return {
    push(item: T) {
      if (disposed) {
        return;
      }
      pendingItems.push(item);
      if (pendingItems.length >= maxItems) {
        flushNow();
        return;
      }
      schedule();
    },
    flushNow,
    dispose() {
      disposed = true;
      cancelScheduledFlush();
      pendingItems.length = 0;
    },
  };
}
