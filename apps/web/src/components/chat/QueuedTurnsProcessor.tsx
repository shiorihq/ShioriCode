import {
  MessageId,
  type ModelSelection,
  type ProviderKind,
  type ServerProvider,
  type ThreadId,
} from "contracts";
import { useEffect, useRef } from "react";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useHostedShioriState } from "../../convex/HostedShioriProvider";
import { useMergedServerProviders } from "../../convex/shioriProvider";
import { newCommandId } from "../../lib/utils";
import { readNativeApi } from "../../nativeApi";
import { getProviderUnavailableReason } from "../../providerModels";
import { isSessionActivelyRunningTurn } from "../../session-logic";
import { useStore } from "../../store";
import { type Thread } from "../../types";
import { useQueuedTurnsStore } from "../../queuedTurnsStore";
import { useServerConfig } from "../../rpc/serverState";

function modelSelectionsEqual(a: ModelSelection, b: ModelSelection): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    JSON.stringify(a.options ?? null) === JSON.stringify(b.options ?? null)
  );
}

async function ensureProviderCanStartQueuedTurn(input: {
  provider: ProviderKind;
  providerStatuses: ReadonlyArray<ServerProvider>;
  hostedShioriAuthToken: string | null;
}) {
  const unavailableReason = getProviderUnavailableReason(input.providerStatuses, input.provider);
  if (unavailableReason) {
    throw new Error(unavailableReason);
  }
  if (input.provider !== "shiori") {
    return;
  }

  const api = readNativeApi();
  if (!api) {
    throw new Error("Native API not found");
  }
  if (!input.hostedShioriAuthToken) {
    throw new Error(
      "Shiori account token is unavailable or invalid. Sign out and sign back in to continue.",
    );
  }
  await api.server.setShioriAuthToken(input.hostedShioriAuthToken);
}

async function persistThreadSettingsForQueuedTurn(input: {
  queuedTurn: {
    threadId: ThreadId;
    createdAt: string;
    modelSelection: ModelSelection;
    runtimeMode: Thread["runtimeMode"];
    interactionMode: Thread["interactionMode"];
  };
  thread: Thread;
}) {
  const api = readNativeApi();
  if (!api) {
    throw new Error("Native API not found");
  }

  if (!modelSelectionsEqual(input.thread.modelSelection, input.queuedTurn.modelSelection)) {
    await api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId: input.queuedTurn.threadId,
      modelSelection: input.queuedTurn.modelSelection,
    });
  }

  if (input.thread.runtimeMode !== input.queuedTurn.runtimeMode) {
    await api.orchestration.dispatchCommand({
      type: "thread.runtime-mode.set",
      commandId: newCommandId(),
      threadId: input.queuedTurn.threadId,
      runtimeMode: input.queuedTurn.runtimeMode,
      createdAt: input.queuedTurn.createdAt,
    });
  }

  if (input.thread.interactionMode !== input.queuedTurn.interactionMode) {
    await api.orchestration.dispatchCommand({
      type: "thread.interaction-mode.set",
      commandId: newCommandId(),
      threadId: input.queuedTurn.threadId,
      interactionMode: input.queuedTurn.interactionMode,
      createdAt: input.queuedTurn.createdAt,
    });
  }
}

export function QueuedTurnsProcessor() {
  const threads = useStore((state) => state.threads);
  const setThreadError = useStore((state) => state.setError);
  const draftThreadsByThreadId = useComposerDraftStore((state) => state.draftThreadsByThreadId);
  const serverConfig = useServerConfig();
  const providerStatuses = useMergedServerProviders(serverConfig?.providers ?? []);
  const { authToken: hostedShioriAuthToken } = useHostedShioriState();
  const queuedTurnsByThreadId = useQueuedTurnsStore((state) => state.queuedTurnsByThreadId);
  const removeQueuedTurn = useQueuedTurnsStore((state) => state.removeQueuedTurn);
  const markQueuedTurnSending = useQueuedTurnsStore((state) => state.markQueuedTurnSending);
  const markQueuedTurnFailed = useQueuedTurnsStore((state) => state.markQueuedTurnFailed);
  const clearQueuedTurns = useQueuedTurnsStore((state) => state.clearQueuedTurns);
  const processingQueuedTurnIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const validThreadIds = new Set<ThreadId>([
      ...threads.map((thread) => thread.id),
      ...(Object.keys(draftThreadsByThreadId) as ThreadId[]),
    ]);
    for (const threadId of Object.keys(queuedTurnsByThreadId) as ThreadId[]) {
      if (validThreadIds.has(threadId)) {
        continue;
      }
      clearQueuedTurns(threadId);
    }
  }, [clearQueuedTurns, draftThreadsByThreadId, queuedTurnsByThreadId, threads]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) {
      return;
    }

    for (const thread of threads) {
      const queuedTurns = queuedTurnsByThreadId[thread.id] ?? [];
      const nextQueuedTurn = queuedTurns[0];
      if (!nextQueuedTurn) {
        continue;
      }
      if (thread.messages.some((message) => String(message.id) === nextQueuedTurn.messageId)) {
        removeQueuedTurn(thread.id, nextQueuedTurn.id);
        continue;
      }
      if (nextQueuedTurn.status !== "queued") {
        continue;
      }
      if (processingQueuedTurnIdsRef.current.has(nextQueuedTurn.id)) {
        continue;
      }
      if (thread.archivedAt !== null) {
        clearQueuedTurns(thread.id);
        continue;
      }
      if (thread.session?.status === "connecting") {
        continue;
      }
      if (isSessionActivelyRunningTurn(thread.latestTurn, thread.session)) {
        continue;
      }

      processingQueuedTurnIdsRef.current.add(nextQueuedTurn.id);
      markQueuedTurnSending(thread.id, nextQueuedTurn.id);

      void (async () => {
        try {
          await ensureProviderCanStartQueuedTurn({
            provider: nextQueuedTurn.modelSelection.provider,
            providerStatuses,
            hostedShioriAuthToken,
          });
          await persistThreadSettingsForQueuedTurn({
            queuedTurn: nextQueuedTurn,
            thread,
          });
          await api.orchestration.dispatchCommand({
            type: "thread.turn.start",
            commandId: newCommandId(),
            threadId: nextQueuedTurn.threadId,
            message: {
              messageId: MessageId.makeUnsafe(nextQueuedTurn.messageId),
              role: "user",
              text: nextQueuedTurn.text,
              attachments: nextQueuedTurn.attachments,
            },
            modelSelection: nextQueuedTurn.modelSelection,
            titleSeed: nextQueuedTurn.titleSeed,
            runtimeMode: nextQueuedTurn.runtimeMode,
            interactionMode: nextQueuedTurn.interactionMode,
            createdAt: nextQueuedTurn.createdAt,
          });
          setThreadError(nextQueuedTurn.threadId, null);
          removeQueuedTurn(nextQueuedTurn.threadId, nextQueuedTurn.id);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Failed to send queued message.";
          setThreadError(nextQueuedTurn.threadId, errorMessage);
          markQueuedTurnFailed(nextQueuedTurn.threadId, nextQueuedTurn.id, errorMessage);
        } finally {
          processingQueuedTurnIdsRef.current.delete(nextQueuedTurn.id);
        }
      })();
    }
  }, [
    clearQueuedTurns,
    hostedShioriAuthToken,
    markQueuedTurnFailed,
    markQueuedTurnSending,
    providerStatuses,
    queuedTurnsByThreadId,
    removeQueuedTurn,
    setThreadError,
    threads,
  ]);

  return null;
}
