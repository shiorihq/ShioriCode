import {
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type UploadChatAttachment,
} from "contracts";
import { type PersistedComposerImageAttachment } from "./composerDraftStore";
import { type TerminalContextDraft } from "./lib/terminalContext";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  createDebouncedStorage,
  createMemoryStorage,
  registerBeforeUnloadCallback,
} from "./lib/storage";

export type QueuedTurnStatus = "queued" | "sending" | "failed";

export interface QueuedTurnComposerSnapshot {
  readonly prompt: string;
  readonly persistedAttachments: ReadonlyArray<PersistedComposerImageAttachment>;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
}

export interface QueuedTurnDraft {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<UploadChatAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly titleSeed: string;
  readonly createdAt: string;
  readonly composerSnapshot: QueuedTurnComposerSnapshot;
  readonly status: QueuedTurnStatus;
  readonly errorMessage: string | null;
}

interface PersistedQueuedTurnsState {
  readonly queuedTurnsByThreadId: Record<string, ReadonlyArray<QueuedTurnDraft> | undefined>;
}

interface QueuedTurnsState extends PersistedQueuedTurnsState {
  readonly enqueueQueuedTurn: (
    turn: Omit<QueuedTurnDraft, "errorMessage" | "status">,
  ) => QueuedTurnDraft;
  readonly removeQueuedTurn: (threadId: ThreadId, queuedTurnId: string) => void;
  readonly markQueuedTurnSending: (threadId: ThreadId, queuedTurnId: string) => void;
  readonly markQueuedTurnFailed: (
    threadId: ThreadId,
    queuedTurnId: string,
    errorMessage: string,
  ) => void;
  readonly clearQueuedTurns: (threadId: ThreadId) => void;
}

const QUEUED_TURNS_STORAGE_KEY = "shioricode:queued-turns:v1";
const QUEUED_TURNS_STORAGE_VERSION = 1;
const EMPTY_PERSISTED_QUEUED_TURNS_STATE = Object.freeze<PersistedQueuedTurnsState>({
  queuedTurnsByThreadId: {},
});
const EMPTY_QUEUED_TURNS: ReadonlyArray<QueuedTurnDraft> = Object.freeze([]);

const queuedTurnsStorage = createDebouncedStorage(
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
  300,
);

registerBeforeUnloadCallback("queued-turns", () => {
  queuedTurnsStorage.flush();
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeQueuedTurnStatus(value: unknown): QueuedTurnStatus {
  switch (value) {
    case "failed":
      return "failed";
    case "sending":
      // Treat persisted sending items as queued so they can resume safely after reload.
      return "queued";
    case "queued":
    default:
      return "queued";
  }
}

function normalizeQueuedTurnDraft(value: unknown): QueuedTurnDraft | null {
  if (!isRecord(value)) {
    return null;
  }
  const composerSnapshot = isRecord(value.composerSnapshot) ? value.composerSnapshot : null;
  const id = typeof value.id === "string" ? value.id : "";
  const threadId = typeof value.threadId === "string" ? value.threadId : "";
  const messageId = typeof value.messageId === "string" ? value.messageId : "";
  const text = typeof value.text === "string" ? value.text : "";
  const titleSeed = typeof value.titleSeed === "string" ? value.titleSeed : "";
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
  if (
    id.length === 0 ||
    threadId.length === 0 ||
    messageId.length === 0 ||
    titleSeed.length === 0 ||
    createdAt.length === 0
  ) {
    return null;
  }

  const attachments = Array.isArray(value.attachments)
    ? (value.attachments as ReadonlyArray<UploadChatAttachment>)
    : [];
  const persistedAttachments = Array.isArray(composerSnapshot?.persistedAttachments)
    ? (composerSnapshot.persistedAttachments as ReadonlyArray<PersistedComposerImageAttachment>)
    : [];
  const terminalContexts = Array.isArray(composerSnapshot?.terminalContexts)
    ? (composerSnapshot.terminalContexts as ReadonlyArray<TerminalContextDraft>)
    : [];
  const composerPrompt =
    typeof composerSnapshot?.prompt === "string" ? composerSnapshot.prompt : "";
  const modelSelection = value.modelSelection as ModelSelection | undefined;
  const runtimeMode = value.runtimeMode as RuntimeMode | undefined;
  const interactionMode = value.interactionMode as ProviderInteractionMode | undefined;
  if (
    !modelSelection ||
    (runtimeMode !== "approval-required" && runtimeMode !== "full-access") ||
    (interactionMode !== "default" && interactionMode !== "plan")
  ) {
    return null;
  }

  return {
    id,
    threadId: threadId as ThreadId,
    messageId,
    text,
    attachments,
    modelSelection,
    runtimeMode,
    interactionMode,
    titleSeed,
    createdAt,
    composerSnapshot: {
      prompt: composerPrompt,
      persistedAttachments,
      terminalContexts,
    },
    status: normalizeQueuedTurnStatus(value.status),
    errorMessage:
      typeof value.errorMessage === "string" && value.errorMessage.trim().length > 0
        ? value.errorMessage
        : null,
  };
}

function normalizePersistedQueuedTurnsState(persistedState: unknown): PersistedQueuedTurnsState {
  if (!isRecord(persistedState)) {
    return EMPTY_PERSISTED_QUEUED_TURNS_STATE;
  }

  const queuedTurnsByThreadId: Record<string, QueuedTurnDraft[]> = {};
  for (const [threadId, queuedTurns] of Object.entries(
    persistedState.queuedTurnsByThreadId ?? {},
  )) {
    if (!Array.isArray(queuedTurns) || threadId.length === 0) {
      continue;
    }
    const normalizedQueuedTurns = queuedTurns
      .map((queuedTurn) => normalizeQueuedTurnDraft(queuedTurn))
      .filter((queuedTurn): queuedTurn is QueuedTurnDraft => queuedTurn !== null)
      .map((queuedTurn) =>
        queuedTurn.status === "sending"
          ? {
              id: queuedTurn.id,
              threadId: queuedTurn.threadId,
              messageId: queuedTurn.messageId,
              text: queuedTurn.text,
              attachments: queuedTurn.attachments,
              modelSelection: queuedTurn.modelSelection,
              runtimeMode: queuedTurn.runtimeMode,
              interactionMode: queuedTurn.interactionMode,
              titleSeed: queuedTurn.titleSeed,
              createdAt: queuedTurn.createdAt,
              composerSnapshot: queuedTurn.composerSnapshot,
              status: "queued" as const,
              errorMessage: null,
            }
          : queuedTurn,
      );
    if (normalizedQueuedTurns.length > 0) {
      queuedTurnsByThreadId[threadId] = normalizedQueuedTurns;
    }
  }

  return {
    queuedTurnsByThreadId,
  };
}

function partializeQueuedTurnsState(state: QueuedTurnsState): PersistedQueuedTurnsState {
  const queuedTurnsByThreadId: Record<string, ReadonlyArray<QueuedTurnDraft>> = {};
  for (const [threadId, queuedTurns] of Object.entries(state.queuedTurnsByThreadId)) {
    const nextQueuedTurns = (queuedTurns ?? []).filter((queuedTurn) => queuedTurn.id.length > 0);
    if (nextQueuedTurns.length > 0) {
      queuedTurnsByThreadId[threadId] = nextQueuedTurns;
    }
  }

  return { queuedTurnsByThreadId };
}

function updateQueuedTurnsForThread(
  state: QueuedTurnsState,
  threadId: ThreadId,
  updater: (queuedTurns: ReadonlyArray<QueuedTurnDraft>) => ReadonlyArray<QueuedTurnDraft>,
): Partial<QueuedTurnsState> | QueuedTurnsState {
  const currentQueuedTurns = state.queuedTurnsByThreadId[threadId] ?? [];
  const nextQueuedTurns = updater(currentQueuedTurns);
  if (nextQueuedTurns === currentQueuedTurns) {
    return state;
  }

  const nextQueuedTurnsByThreadId = { ...state.queuedTurnsByThreadId };
  if (nextQueuedTurns.length === 0) {
    delete nextQueuedTurnsByThreadId[threadId];
  } else {
    nextQueuedTurnsByThreadId[threadId] = nextQueuedTurns;
  }

  return { queuedTurnsByThreadId: nextQueuedTurnsByThreadId };
}

export const useQueuedTurnsStore = create<QueuedTurnsState>()(
  persist(
    (set) => ({
      queuedTurnsByThreadId: {},
      enqueueQueuedTurn: (turn) => {
        const queuedTurn: QueuedTurnDraft = {
          ...turn,
          status: "queued",
          errorMessage: null,
        };
        set((state) =>
          updateQueuedTurnsForThread(state, turn.threadId, (queuedTurns) => [
            ...queuedTurns,
            queuedTurn,
          ]),
        );
        return queuedTurn;
      },
      removeQueuedTurn: (threadId, queuedTurnId) => {
        if (threadId.length === 0 || queuedTurnId.length === 0) {
          return;
        }
        set((state) =>
          updateQueuedTurnsForThread(state, threadId, (queuedTurns) =>
            queuedTurns.filter((queuedTurn) => queuedTurn.id !== queuedTurnId),
          ),
        );
      },
      markQueuedTurnSending: (threadId, queuedTurnId) => {
        if (threadId.length === 0 || queuedTurnId.length === 0) {
          return;
        }
        set((state) =>
          updateQueuedTurnsForThread(state, threadId, (queuedTurns) =>
            queuedTurns.map((queuedTurn) =>
              queuedTurn.id === queuedTurnId
                ? { ...queuedTurn, status: "sending", errorMessage: null }
                : queuedTurn,
            ),
          ),
        );
      },
      markQueuedTurnFailed: (threadId, queuedTurnId, errorMessage) => {
        if (threadId.length === 0 || queuedTurnId.length === 0) {
          return;
        }
        set((state) =>
          updateQueuedTurnsForThread(state, threadId, (queuedTurns) =>
            queuedTurns.map((queuedTurn) =>
              queuedTurn.id === queuedTurnId
                ? {
                    ...queuedTurn,
                    status: "failed",
                    errorMessage:
                      errorMessage.trim().length > 0
                        ? errorMessage
                        : "Failed to send queued message.",
                  }
                : queuedTurn,
            ),
          ),
        );
      },
      clearQueuedTurns: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          if (!(threadId in state.queuedTurnsByThreadId)) {
            return state;
          }
          const nextQueuedTurnsByThreadId = { ...state.queuedTurnsByThreadId };
          delete nextQueuedTurnsByThreadId[threadId];
          return { queuedTurnsByThreadId: nextQueuedTurnsByThreadId };
        });
      },
    }),
    {
      name: QUEUED_TURNS_STORAGE_KEY,
      version: QUEUED_TURNS_STORAGE_VERSION,
      storage: createJSONStorage(() => queuedTurnsStorage),
      partialize: partializeQueuedTurnsState,
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...normalizePersistedQueuedTurnsState(persistedState),
      }),
    },
  ),
);

export function selectQueuedTurnsForThread(
  queuedTurnsByThreadId: QueuedTurnsState["queuedTurnsByThreadId"],
  threadId: ThreadId | null | undefined,
): ReadonlyArray<QueuedTurnDraft> {
  if (!threadId) {
    return EMPTY_QUEUED_TURNS;
  }
  return queuedTurnsByThreadId[threadId] ?? EMPTY_QUEUED_TURNS;
}
