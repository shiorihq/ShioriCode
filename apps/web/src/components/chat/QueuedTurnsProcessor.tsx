import {
  type ClientOrchestrationCommand,
  MessageId,
  type ModelSelection,
  type ProviderKind,
  type ServerProvider,
  type ThreadId,
  type UploadChatAttachment,
} from "contracts";
import { useEffect, useRef } from "react";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useHostedShioriState } from "../../convex/HostedShioriProvider";
import { useMergedServerProviders } from "../../convex/shioriProvider";
import { newCommandId } from "../../lib/utils";
import { readNativeApi } from "../../nativeApi";
import { getProviderUnavailableReason } from "../../providerModels";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  isSessionActivelyRunningTurn,
} from "../../session-logic";
import { useStore } from "../../store";
import {
  type LocalDispatchSnapshot,
  hasServerAcknowledgedLocalDispatch,
} from "../../threadDispatchState";
import { type Thread } from "../../types";
import { type QueuedTurnDraft, useQueuedTurnsStore } from "../../queuedTurnsStore";
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
  commands: ReadonlyArray<ClientOrchestrationCommand>;
}) {
  const api = readNativeApi();
  if (!api) {
    throw new Error("Native API not found");
  }

  for (const command of input.commands) {
    await api.orchestration.dispatchCommand(command);
  }
}

type QueuedTurnForDispatch = {
  threadId: ThreadId;
  messageId: string;
  text: string;
  attachments: ReadonlyArray<UploadChatAttachment>;
  modelSelection: ModelSelection;
  runtimeMode: Thread["runtimeMode"];
  interactionMode: Thread["interactionMode"];
  titleSeed: string;
};

export function buildQueuedTurnDispatchCommands(input: {
  queuedTurn: QueuedTurnForDispatch;
  thread: Pick<Thread, "id" | "modelSelection" | "runtimeMode" | "interactionMode">;
  dispatchCreatedAt: string;
}): ClientOrchestrationCommand[] {
  const commands: ClientOrchestrationCommand[] = [];

  if (!modelSelectionsEqual(input.thread.modelSelection, input.queuedTurn.modelSelection)) {
    commands.push({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId: input.queuedTurn.threadId,
      modelSelection: input.queuedTurn.modelSelection,
    });
  }

  if (input.thread.runtimeMode !== input.queuedTurn.runtimeMode) {
    commands.push({
      type: "thread.runtime-mode.set",
      commandId: newCommandId(),
      threadId: input.queuedTurn.threadId,
      runtimeMode: input.queuedTurn.runtimeMode,
      createdAt: input.dispatchCreatedAt,
    });
  }

  if (input.thread.interactionMode !== input.queuedTurn.interactionMode) {
    commands.push({
      type: "thread.interaction-mode.set",
      commandId: newCommandId(),
      threadId: input.queuedTurn.threadId,
      interactionMode: input.queuedTurn.interactionMode,
      createdAt: input.dispatchCreatedAt,
    });
  }

  commands.push({
    type: "thread.turn.start",
    commandId: newCommandId(),
    threadId: input.queuedTurn.threadId,
    message: {
      messageId: MessageId.makeUnsafe(input.queuedTurn.messageId),
      role: "user",
      text: input.queuedTurn.text,
      attachments: input.queuedTurn.attachments,
    },
    modelSelection: input.queuedTurn.modelSelection,
    titleSeed: input.queuedTurn.titleSeed,
    runtimeMode: input.queuedTurn.runtimeMode,
    interactionMode: input.queuedTurn.interactionMode,
    createdAt: input.dispatchCreatedAt,
  });

  return commands;
}

type QueueProcessingThread = Pick<
  Thread,
  "id" | "archivedAt" | "latestTurn" | "messages" | "session" | "activities" | "error"
>;

export type QueuedTurnProcessingDecision =
  | { kind: "none" }
  | { kind: "clear-thread" }
  | { kind: "remove-acknowledged"; queuedTurnId: string }
  | { kind: "dispatch"; queuedTurn: QueuedTurnDraft };

export function decideQueuedTurnProcessing(input: {
  thread: QueueProcessingThread;
  queuedTurns: ReadonlyArray<QueuedTurnDraft>;
  pendingLocalDispatch: LocalDispatchSnapshot | null | undefined;
}): QueuedTurnProcessingDecision {
  const nextQueuedTurn = input.queuedTurns[0];
  if (!nextQueuedTurn) {
    return { kind: "none" };
  }

  const hasQueuedMessageInThread = input.thread.messages.some(
    (message) => String(message.id) === nextQueuedTurn.messageId,
  );
  if (hasQueuedMessageInThread) {
    if (!input.pendingLocalDispatch) {
      return {
        kind: "remove-acknowledged",
        queuedTurnId: nextQueuedTurn.id,
      };
    }
    const threadSessionStatus = input.thread.session?.orchestrationStatus ?? null;
    const acknowledged = hasServerAcknowledgedLocalDispatch({
      localDispatch: input.pendingLocalDispatch,
      phase: derivePhase(input.thread.session ?? null),
      latestTurn: input.thread.latestTurn,
      activities: input.thread.activities,
      hasPendingApproval:
        threadSessionStatus === "running" &&
        derivePendingApprovals(input.thread.activities).length > 0,
      hasPendingUserInput:
        threadSessionStatus === "running" &&
        derivePendingUserInputs(input.thread.activities).length > 0,
      threadError: input.thread.error,
    });
    if (!acknowledged) {
      return { kind: "none" };
    }
    return {
      kind: "remove-acknowledged",
      queuedTurnId: nextQueuedTurn.id,
    };
  }

  if (input.thread.archivedAt !== null) {
    return { kind: "clear-thread" };
  }

  if (nextQueuedTurn.status !== "queued") {
    return { kind: "none" };
  }

  if (input.pendingLocalDispatch) {
    return { kind: "none" };
  }

  if (input.thread.session?.status === "connecting") {
    return { kind: "none" };
  }

  if (isSessionActivelyRunningTurn(input.thread.latestTurn, input.thread.session)) {
    return { kind: "none" };
  }

  return { kind: "dispatch", queuedTurn: nextQueuedTurn };
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
  const queuedTurnDispatchSnapshotsRef = useRef<Map<string, LocalDispatchSnapshot>>(new Map());

  useEffect(() => {
    const validThreadIds = new Set<ThreadId>([
      ...threads.map((thread) => thread.id),
      ...(Object.keys(draftThreadsByThreadId) as ThreadId[]),
    ]);
    for (const threadId of Object.keys(queuedTurnsByThreadId) as ThreadId[]) {
      if (validThreadIds.has(threadId)) {
        continue;
      }
      for (const queuedTurn of queuedTurnsByThreadId[threadId] ?? []) {
        queuedTurnDispatchSnapshotsRef.current.delete(queuedTurn.id);
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
      const nextQueuedTurnId = queuedTurns[0]?.id ?? null;
      const decision = decideQueuedTurnProcessing({
        thread,
        queuedTurns,
        pendingLocalDispatch:
          nextQueuedTurnId === null
            ? null
            : (queuedTurnDispatchSnapshotsRef.current.get(nextQueuedTurnId) ?? null),
      });

      if (decision.kind === "none") {
        continue;
      }

      if (decision.kind === "clear-thread") {
        for (const queuedTurn of queuedTurns) {
          queuedTurnDispatchSnapshotsRef.current.delete(queuedTurn.id);
        }
        clearQueuedTurns(thread.id);
        continue;
      }

      if (decision.kind === "remove-acknowledged") {
        queuedTurnDispatchSnapshotsRef.current.delete(decision.queuedTurnId);
        removeQueuedTurn(thread.id, decision.queuedTurnId);
        continue;
      }

      const nextQueuedTurn = decision.queuedTurn;
      const dispatchCreatedAt = new Date().toISOString();
      queuedTurnDispatchSnapshotsRef.current.set(nextQueuedTurn.id, {
        startedAt: dispatchCreatedAt,
        preparingWorktree: false,
        latestTurnTurnId: thread.latestTurn?.turnId ?? null,
        latestTurnRequestedAt: thread.latestTurn?.requestedAt ?? null,
        latestTurnStartedAt: thread.latestTurn?.startedAt ?? null,
        latestTurnCompletedAt: thread.latestTurn?.completedAt ?? null,
      });
      markQueuedTurnSending(thread.id, nextQueuedTurn.id);

      void (async () => {
        try {
          // Preserve queue ordering in the panel, but stamp orchestration events
          // with the actual dequeue time so persisted transcript order matches
          // when the turn really started.
          await ensureProviderCanStartQueuedTurn({
            provider: nextQueuedTurn.modelSelection.provider,
            providerStatuses,
            hostedShioriAuthToken,
          });
          const commands = buildQueuedTurnDispatchCommands({
            queuedTurn: nextQueuedTurn,
            thread,
            dispatchCreatedAt,
          });
          await persistThreadSettingsForQueuedTurn({
            commands,
          });
          setThreadError(nextQueuedTurn.threadId, null);
        } catch (error) {
          queuedTurnDispatchSnapshotsRef.current.delete(nextQueuedTurn.id);
          const errorMessage =
            error instanceof Error ? error.message : "Failed to send queued message.";
          setThreadError(nextQueuedTurn.threadId, errorMessage);
          markQueuedTurnFailed(nextQueuedTurn.threadId, nextQueuedTurn.id, errorMessage);
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
