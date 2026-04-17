import { ThreadId } from "contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type QueuedTurnDraft, useQueuedTurnsStore } from "./queuedTurnsStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
type EnqueueQueuedTurnInput = Omit<QueuedTurnDraft, "errorMessage" | "status">;

function makeQueuedTurn(overrides: Partial<EnqueueQueuedTurnInput> = {}) {
  return {
    id: overrides.id ?? "queued-turn-1",
    threadId: overrides.threadId ?? THREAD_ID,
    messageId: overrides.messageId ?? "message-1",
    text: overrides.text ?? "Ship the queue UI",
    attachments: overrides.attachments ?? [],
    modelSelection:
      overrides.modelSelection ??
      ({
        provider: "codex",
        model: "gpt-5-codex",
      } as const),
    runtimeMode: overrides.runtimeMode ?? "full-access",
    interactionMode: overrides.interactionMode ?? "default",
    titleSeed: overrides.titleSeed ?? "Thread",
    createdAt: overrides.createdAt ?? "2026-04-15T00:00:00.000Z",
    composerSnapshot:
      overrides.composerSnapshot ??
      ({
        prompt: "Ship the queue UI",
        persistedAttachments: [],
        terminalContexts: [],
      } as const),
  };
}

describe("queuedTurnsStore", () => {
  beforeEach(() => {
    useQueuedTurnsStore.persist.clearStorage();
    useQueuedTurnsStore.setState({
      queuedTurnsByThreadId: {},
    });
  });

  it("appends queued turns per thread", () => {
    const store = useQueuedTurnsStore.getState();
    const first = store.enqueueQueuedTurn(makeQueuedTurn({ id: "queued-turn-1" }));
    const second = store.enqueueQueuedTurn(
      makeQueuedTurn({
        id: "queued-turn-2",
        messageId: "message-2",
        text: "Follow up on the previous change",
      }),
    );

    const queuedTurns = useQueuedTurnsStore.getState().queuedTurnsByThreadId[THREAD_ID];

    expect(queuedTurns).toEqual([first, second]);
    expect(queuedTurns?.every((queuedTurn) => queuedTurn.status === "queued")).toBe(true);
  });

  it("tracks sending and failed queue states", () => {
    const store = useQueuedTurnsStore.getState();
    store.enqueueQueuedTurn(makeQueuedTurn({ id: "queued-turn-1" }));

    store.markQueuedTurnSending(THREAD_ID, "queued-turn-1");
    expect(useQueuedTurnsStore.getState().queuedTurnsByThreadId[THREAD_ID]?.[0]?.status).toBe(
      "sending",
    );

    store.markQueuedTurnFailed(THREAD_ID, "queued-turn-1", "Provider unavailable.");
    expect(useQueuedTurnsStore.getState().queuedTurnsByThreadId[THREAD_ID]?.[0]).toMatchObject({
      status: "failed",
      errorMessage: "Provider unavailable.",
    });
  });

  it("removes queued turns and cleans up empty thread buckets", () => {
    const store = useQueuedTurnsStore.getState();
    store.enqueueQueuedTurn(makeQueuedTurn({ id: "queued-turn-1" }));
    store.enqueueQueuedTurn(
      makeQueuedTurn({
        id: "queued-turn-2",
        messageId: "message-2",
      }),
    );

    store.removeQueuedTurn(THREAD_ID, "queued-turn-1");
    expect(useQueuedTurnsStore.getState().queuedTurnsByThreadId[THREAD_ID]).toHaveLength(1);

    store.removeQueuedTurn(THREAD_ID, "queued-turn-2");
    expect(useQueuedTurnsStore.getState().queuedTurnsByThreadId[THREAD_ID]).toBeUndefined();
  });
});
