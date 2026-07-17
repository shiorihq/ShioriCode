import { ThreadId } from "contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildQueuedTurnDispatchCommands,
  decideQueuedTurnProcessing,
} from "./components/chat/QueuedTurnsProcessor";
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
    goalIntent: overrides.goalIntent ?? null,
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

  it("keeps goal intent attached to a queued turn until dispatch", () => {
    const goalIntent = {
      objective: "Ship the queue goal",
      status: "active" as const,
      tokenBudget: null,
      expectedGoalLifecycleKey: null,
    };
    const queuedTurn = useQueuedTurnsStore
      .getState()
      .enqueueQueuedTurn(makeQueuedTurn({ goalIntent }));

    expect(queuedTurn.goalIntent).toEqual(goalIntent);
    expect(
      useQueuedTurnsStore.getState().queuedTurnsByThreadId[THREAD_ID]?.[0]?.goalIntent,
    ).toEqual(goalIntent);
  });

  it("rehydrates a persisted goal turn and dispatches its original lifecycle CAS intent", async () => {
    const originalStorage = useQueuedTurnsStore.persist.getOptions().storage;
    const goalIntent = {
      objective: "Ship the durable queue goal",
      status: "active" as const,
      tokenBudget: 25_000,
      expectedGoalLifecycleKey: "goal-lifecycle-existing",
    };
    const persistedTurn = {
      ...makeQueuedTurn({ goalIntent }),
      status: "sending" as const,
      errorMessage: null,
    };

    useQueuedTurnsStore.persist.setOptions({
      storage: {
        getItem: () => ({
          state: {
            queuedTurnsByThreadId: {
              [THREAD_ID]: [persistedTurn],
            },
          },
          version: 1,
        }),
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    });

    try {
      await useQueuedTurnsStore.persist.rehydrate();
      const rehydratedTurn = useQueuedTurnsStore.getState().queuedTurnsByThreadId[THREAD_ID]?.[0];

      expect(rehydratedTurn).toMatchObject({
        status: "queued",
        errorMessage: null,
        goalIntent,
      });

      const decision = decideQueuedTurnProcessing({
        thread: {
          id: THREAD_ID,
          archivedAt: null,
          latestTurn: null,
          session: null,
          messages: [],
          activities: [],
          error: null,
        },
        queuedTurns: rehydratedTurn ? [rehydratedTurn] : [],
        pendingLocalDispatch: null,
      });
      expect(decision.kind).toBe("dispatch");
      if (decision.kind !== "dispatch") {
        throw new Error("Expected the rehydrated goal turn to be dispatchable");
      }

      const commands = buildQueuedTurnDispatchCommands({
        queuedTurn: decision.queuedTurn,
        thread: {
          id: THREAD_ID,
          modelSelection: decision.queuedTurn.modelSelection,
          runtimeMode: decision.queuedTurn.runtimeMode,
          interactionMode: decision.queuedTurn.interactionMode,
        },
        dispatchCreatedAt: "2026-04-15T00:01:00.000Z",
      });

      expect(commands.at(-1)).toMatchObject({
        type: "thread.turn.start",
        goalIntent,
      });
    } finally {
      useQueuedTurnsStore.persist.setOptions({ storage: originalStorage });
      useQueuedTurnsStore.setState({ queuedTurnsByThreadId: {} });
    }
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
