import {
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type UploadChatAttachment,
} from "contracts";
import { create } from "zustand";

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
}

interface QueuedTurnsState {
  readonly queuedTurnsByThreadId: Record<string, QueuedTurnDraft | undefined>;
  readonly enqueueQueuedTurn: (turn: QueuedTurnDraft) => void;
  readonly clearQueuedTurn: (threadId: ThreadId) => void;
}

export const useQueuedTurnsStore = create<QueuedTurnsState>((set) => ({
  queuedTurnsByThreadId: {},
  enqueueQueuedTurn: (turn) =>
    set((state) => ({
      queuedTurnsByThreadId: {
        ...state.queuedTurnsByThreadId,
        [turn.threadId]: turn,
      },
    })),
  clearQueuedTurn: (threadId) =>
    set((state) => {
      if (!(threadId in state.queuedTurnsByThreadId)) {
        return state;
      }
      const nextQueuedTurnsByThreadId = { ...state.queuedTurnsByThreadId };
      delete nextQueuedTurnsByThreadId[threadId];
      return {
        queuedTurnsByThreadId: nextQueuedTurnsByThreadId,
      };
    }),
}));
