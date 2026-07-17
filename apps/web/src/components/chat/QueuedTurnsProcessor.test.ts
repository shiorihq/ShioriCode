import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProviderKind,
  ThreadId,
} from "contracts";
import { MessageId } from "contracts";
import { describe, expect, it } from "vitest";

import {
  buildQueuedTurnDispatchCommands,
  decideQueuedTurnProcessing,
} from "./QueuedTurnsProcessor";

const THREAD_ID = ThreadId.makeUnsafe("thread-queued");
const QUEUED_CREATED_AT = "2026-04-19T17:47:27.301Z";
const DISPATCHED_AT = "2026-04-19T17:48:15.500Z";
const PROVIDER_KINDS = [
  "kimiCode",
  "gemini",
  "glm",
  "cursor",
  "codex",
  "claudeAgent",
] as const satisfies ReadonlyArray<ProviderKind>;

describe("buildQueuedTurnDispatchCommands", () => {
  it("stamps queued turns with the dequeue time instead of the original queue timestamp", () => {
    const commands = buildQueuedTurnDispatchCommands({
      queuedTurn: {
        threadId: THREAD_ID,
        messageId: "message-queued-1",
        text: "fill the icon please",
        attachments: [],
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        goalIntent: null,
        titleSeed: "Thread",
      },
      thread: {
        id: THREAD_ID,
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      dispatchCreatedAt: DISPATCHED_AT,
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.turn.start",
      threadId: THREAD_ID,
      createdAt: DISPATCHED_AT,
    });
    expect(commands[0]).not.toMatchObject({
      createdAt: QUEUED_CREATED_AT,
    });
  });

  it.each(PROVIDER_KINDS)("carries goal intent into a dequeued %s turn", (provider) => {
    const modelSelection = {
      provider,
      model: DEFAULT_MODEL_BY_PROVIDER[provider],
    } as ModelSelection;
    const commands = buildQueuedTurnDispatchCommands({
      queuedTurn: {
        threadId: THREAD_ID,
        messageId: "message-goal-queued",
        text: "ship the goal flow",
        attachments: [],
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        goalIntent: {
          objective: "ship the goal flow",
          status: "active",
          tokenBudget: null,
          expectedGoalLifecycleKey: null,
        },
        titleSeed: "Thread",
      },
      thread: {
        id: THREAD_ID,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      dispatchCreatedAt: DISPATCHED_AT,
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.turn.start",
      modelSelection,
      goalIntent: {
        objective: "ship the goal flow",
        status: "active",
        tokenBudget: null,
        expectedGoalLifecycleKey: null,
      },
    });
  });

  it("uses the dequeue time for queued setting changes as well", () => {
    const commands = buildQueuedTurnDispatchCommands({
      queuedTurn: {
        threadId: THREAD_ID,
        messageId: "message-queued-1",
        text: "fill the icon please",
        attachments: [],
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        goalIntent: null,
        titleSeed: "Thread",
      },
      thread: {
        id: THREAD_ID,
        modelSelection: { provider: "codex", model: "gpt-5.3-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
      },
      dispatchCreatedAt: DISPATCHED_AT,
    });

    expect(commands.map((command) => command.type)).toEqual([
      "thread.meta.update",
      "thread.runtime-mode.set",
      "thread.interaction-mode.set",
      "thread.turn.start",
    ]);
    expect(commands[1]).toMatchObject({
      type: "thread.runtime-mode.set",
      createdAt: DISPATCHED_AT,
    });
    expect(commands[2]).toMatchObject({
      type: "thread.interaction-mode.set",
      createdAt: DISPATCHED_AT,
    });
    expect(commands[3]).toMatchObject({
      type: "thread.turn.start",
      createdAt: DISPATCHED_AT,
    });
  });
});

describe("decideQueuedTurnProcessing", () => {
  it("does not dispatch later queued turns while the head is still sending", () => {
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
      queuedTurns: [
        {
          id: "queued-turn-1",
          threadId: THREAD_ID,
          messageId: "message-queued-1",
          text: "what's 9 + 9",
          attachments: [],
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          goalIntent: null,
          titleSeed: "Thread",
          createdAt: "2026-04-19T20:20:00.000Z",
          composerSnapshot: {
            prompt: "what's 9 + 9",
            persistedAttachments: [],
            terminalContexts: [],
          },
          status: "sending",
          errorMessage: null,
        },
        {
          id: "queued-turn-2",
          threadId: THREAD_ID,
          messageId: "message-queued-2",
          text: "what's 5 + 5",
          attachments: [],
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          goalIntent: null,
          titleSeed: "Thread",
          createdAt: "2026-04-19T20:20:01.000Z",
          composerSnapshot: {
            prompt: "what's 5 + 5",
            persistedAttachments: [],
            terminalContexts: [],
          },
          status: "queued",
          errorMessage: null,
        },
      ],
      pendingLocalDispatch: {
        startedAt: "2026-04-19T20:20:00.000Z",
        preparingWorktree: false,
        latestTurnTurnId: null,
        latestTurnRequestedAt: null,
        latestTurnStartedAt: null,
        latestTurnCompletedAt: null,
      },
    });

    expect(decision).toEqual({ kind: "none" });
  });

  it("waits for a real dispatch acknowledgment before removing a sending head", () => {
    const decision = decideQueuedTurnProcessing({
      thread: {
        id: THREAD_ID,
        archivedAt: null,
        latestTurn: null,
        session: null,
        messages: [
          {
            id: MessageId.makeUnsafe("message-queued-1"),
            role: "user",
            text: "what's 9 + 9",
            createdAt: "2026-04-19T20:20:02.000Z",
            streaming: false,
          },
        ],
        activities: [],
        error: null,
      },
      queuedTurns: [
        {
          id: "queued-turn-1",
          threadId: THREAD_ID,
          messageId: "message-queued-1",
          text: "what's 9 + 9",
          attachments: [],
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          goalIntent: null,
          titleSeed: "Thread",
          createdAt: "2026-04-19T20:20:00.000Z",
          composerSnapshot: {
            prompt: "what's 9 + 9",
            persistedAttachments: [],
            terminalContexts: [],
          },
          status: "sending",
          errorMessage: null,
        },
      ],
      pendingLocalDispatch: {
        startedAt: "2026-04-19T20:20:00.000Z",
        preparingWorktree: false,
        latestTurnTurnId: null,
        latestTurnRequestedAt: null,
        latestTurnStartedAt: null,
        latestTurnCompletedAt: null,
      },
    });

    expect(decision).toEqual({ kind: "none" });
  });

  it("removes the head queued turn after the server acknowledges its message", () => {
    const decision = decideQueuedTurnProcessing({
      thread: {
        id: THREAD_ID,
        archivedAt: null,
        latestTurn: null,
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: undefined,
          createdAt: "2026-04-19T20:20:03.000Z",
          updatedAt: "2026-04-19T20:20:03.000Z",
        },
        messages: [
          {
            id: MessageId.makeUnsafe("message-queued-1"),
            role: "user",
            text: "what's 9 + 9",
            createdAt: "2026-04-19T20:20:02.000Z",
            streaming: false,
          },
        ],
        activities: [],
        error: null,
      },
      queuedTurns: [
        {
          id: "queued-turn-1",
          threadId: THREAD_ID,
          messageId: "message-queued-1",
          text: "what's 9 + 9",
          attachments: [],
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          goalIntent: null,
          titleSeed: "Thread",
          createdAt: "2026-04-19T20:20:00.000Z",
          composerSnapshot: {
            prompt: "what's 9 + 9",
            persistedAttachments: [],
            terminalContexts: [],
          },
          status: "sending",
          errorMessage: null,
        },
      ],
      pendingLocalDispatch: {
        startedAt: "2026-04-19T20:20:00.000Z",
        preparingWorktree: false,
        latestTurnTurnId: null,
        latestTurnRequestedAt: null,
        latestTurnStartedAt: null,
        latestTurnCompletedAt: null,
      },
    });

    expect(decision).toEqual({
      kind: "remove-acknowledged",
      queuedTurnId: "queued-turn-1",
    });
  });

  it("dispatches the next queued turn only when there is no pending local dispatch", () => {
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
      queuedTurns: [
        {
          id: "queued-turn-1",
          threadId: THREAD_ID,
          messageId: "message-queued-1",
          text: "what's 9 + 9",
          attachments: [],
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          goalIntent: null,
          titleSeed: "Thread",
          createdAt: "2026-04-19T20:20:00.000Z",
          composerSnapshot: {
            prompt: "what's 9 + 9",
            persistedAttachments: [],
            terminalContexts: [],
          },
          status: "queued",
          errorMessage: null,
        },
      ],
      pendingLocalDispatch: null,
    });

    expect(decision).toEqual({
      kind: "dispatch",
      queuedTurn: expect.objectContaining({ id: "queued-turn-1" }),
    });
  });
});
