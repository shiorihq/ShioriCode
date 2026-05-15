import { ThreadId, type OrchestrationEvent } from "contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback } from "react";

import { getFallbackThreadIdAfterDelete } from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewThread } from "./useHandleNewThread";
import {
  gitCreateWorktreeMutationOptions,
  gitRemoveWorktreeMutationOptions,
} from "../lib/gitReactQuery";
import { newCommandId, newMessageId, newThreadId, randomUUID } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { toastManager } from "../components/ui/toast";
import { useSettings } from "./useSettings";

function buildTemporaryWorktreeBranchName(): string {
  return `shioricode/${randomUUID().replaceAll("-", "").slice(0, 8).toLowerCase()}`;
}

type OptimisticThreadEvent = Extract<
  OrchestrationEvent,
  { type: "thread.archived" | "thread.deleted" | "thread.unarchived" }
>;

function createOptimisticThreadEvent(
  input: Pick<OptimisticThreadEvent, "type" | "payload"> & {
    commandId: OrchestrationEvent["commandId"];
    threadId: ThreadId;
    occurredAt: string;
  },
): OptimisticThreadEvent {
  return {
    sequence: 0,
    eventId: randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: "thread",
    aggregateId: input.threadId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    causationEventId: null,
    correlationId: input.commandId,
    metadata: { optimistic: true },
    type: input.type,
    payload: input.payload,
  } as OptimisticThreadEvent;
}

export function useThreadActions() {
  const appSettings = useSettings();
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const queryClient = useQueryClient();
  const createWorktreeMutation = useMutation(gitCreateWorktreeMutationOptions({ queryClient }));
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));

  const archiveThread = useCallback(
    async (threadId: ThreadId) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = useStore.getState().threads.find((entry) => entry.id === threadId);
      if (!thread) return;
      if (thread.session?.status === "running" && thread.session.activeTurnId != null) {
        throw new Error("Cannot archive a running thread.");
      }

      const commandId = newCommandId();
      const archivedAt = new Date().toISOString();
      useStore.getState().applyOrchestrationEvent(
        createOptimisticThreadEvent({
          type: "thread.archived",
          commandId,
          threadId,
          occurredAt: archivedAt,
          payload: {
            threadId,
            archivedAt,
            updatedAt: archivedAt,
          },
        }),
      );

      try {
        await api.orchestration.dispatchCommand({
          type: "thread.archive",
          commandId,
          threadId,
        });
      } catch (error) {
        useStore.getState().restoreThread(thread);
        throw error;
      }

      if (routeThreadId === threadId) {
        if (thread.projectId === null) {
          await navigate({ to: "/" });
        } else {
          await handleNewThread(thread.projectId);
        }
      }
    },
    [handleNewThread, navigate, routeThreadId],
  );

  const unarchiveThread = useCallback(async (threadId: ThreadId) => {
    const api = readNativeApi();
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.unarchive",
      commandId: newCommandId(),
      threadId,
    });
  }, []);

  const branchThread = useCallback(
    async (
      threadId: ThreadId,
      options?: {
        mode?: "local" | "worktree";
      },
    ) => {
      const api = readNativeApi();
      if (!api) return;
      const { projects, threads } = useStore.getState();
      const thread = threads.find((entry) => entry.id === threadId);
      if (!thread) {
        throw new Error("Only saved server threads can be branched.");
      }
      if (thread.archivedAt !== null) {
        throw new Error("Archived threads cannot be branched.");
      }
      if (thread.projectId === null) {
        throw new Error("Projectless chats cannot be branched yet.");
      }
      const threadProject = projects.find((project) => project.id === thread.projectId);
      if (!threadProject) {
        throw new Error("Could not resolve the thread project.");
      }

      const nextThreadId = newThreadId();
      const createdAt = new Date().toISOString();
      const mode = options?.mode ?? "local";
      const seedMessages = thread.messages.map((message) => ({
        messageId: newMessageId(),
        role: message.role,
        text: message.text,
        ...(message.attachments
          ? {
              attachments: message.attachments.map((attachment) => ({
                type: attachment.type,
                id: attachment.id,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
              })),
            }
          : {}),
        createdAt: message.createdAt,
        updatedAt: message.completedAt ?? message.createdAt,
      }));
      let nextBranch = thread.branch;
      let nextWorktreePath: string | null = null;

      if (mode === "worktree") {
        const branchStatus = await api.git.status({
          cwd: thread.worktreePath ?? threadProject.cwd,
        });
        const baseBranch = thread.branch ?? branchStatus.branch ?? null;
        if (!baseBranch) {
          throw new Error("Select a branch before forking into a new worktree.");
        }
        const result = await createWorktreeMutation.mutateAsync({
          cwd: threadProject.cwd,
          branch: baseBranch,
          newBranch: buildTemporaryWorktreeBranchName(),
        });
        nextBranch = result.worktree.branch;
        nextWorktreePath = result.worktree.path;
      }

      await api.orchestration.dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        projectId: thread.projectId,
        title: `${thread.title} (branch)`,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        parentThreadId: thread.id,
        branchSourceTurnId: thread.latestTurn?.turnId ?? null,
        seedMessages,
        branch: nextBranch,
        worktreePath: nextWorktreePath,
        tag: thread.tag,
        createdAt,
      });

      await navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
      });
    },
    [createWorktreeMutation, navigate],
  );

  const deleteThread = useCallback(
    async (threadId: ThreadId, opts: { deletedThreadIds?: ReadonlySet<ThreadId> } = {}) => {
      const api = readNativeApi();
      if (!api) return;
      const { projects, threads } = useStore.getState();
      const thread = threads.find((entry) => entry.id === threadId);
      if (!thread) return;
      const threadProject =
        thread.projectId === null
          ? undefined
          : projects.find((project) => project.id === thread.projectId);
      const deletedIds = opts.deletedThreadIds;
      const survivingThreads =
        deletedIds && deletedIds.size > 0
          ? threads.filter((entry) => entry.id === threadId || !deletedIds.has(entry.id))
          : threads;
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(survivingThreads, threadId);
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const canDeleteWorktree = orphanedWorktreePath !== null && threadProject !== undefined;
      const shouldDeleteWorktree =
        canDeleteWorktree &&
        (await api.dialogs.confirm(
          [
            "This thread is the only one linked to this worktree:",
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            "Delete the worktree too?",
          ].join("\n"),
        ));

      const deleteCommandId = newCommandId();
      const deletedAt = new Date().toISOString();
      const deletedThreadIds = opts.deletedThreadIds ?? new Set<ThreadId>();
      const shouldNavigateToFallback = routeThreadId === threadId;
      const fallbackThreadId = getFallbackThreadIdAfterDelete({
        threads,
        deletedThreadId: threadId,
        deletedThreadIds,
        sortOrder: appSettings.sidebarThreadSortOrder,
      });

      useStore.getState().applyOrchestrationEvent(
        createOptimisticThreadEvent({
          type: "thread.deleted",
          commandId: deleteCommandId,
          threadId,
          occurredAt: deletedAt,
          payload: {
            threadId,
            deletedAt,
          },
        }),
      );
      clearComposerDraftForThread(threadId);
      if (thread.projectId !== null) {
        clearProjectDraftThreadById(thread.projectId, thread.id);
      }
      clearTerminalState(threadId);

      const navigationPromise = (
        shouldNavigateToFallback
          ? fallbackThreadId
            ? navigate({
                to: "/$threadId",
                params: { threadId: fallbackThreadId },
                replace: true,
              })
            : navigate({ to: "/", replace: true })
          : Promise.resolve()
      ).catch((error) => {
        console.error("Failed to navigate after optimistic thread deletion", { threadId, error });
      });

      if (thread.session && thread.session.status !== "closed") {
        await api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }

      try {
        await api.terminal.close({ threadId, deleteHistory: true });
      } catch {
        // Terminal may already be closed.
      }

      try {
        await api.orchestration.dispatchCommand({
          type: "thread.delete",
          commandId: deleteCommandId,
          threadId,
        });
        await navigationPromise;
      } catch (error) {
        useStore.getState().restoreThread(thread);
        throw error;
      }

      if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
        return;
      }

      try {
        await removeWorktreeMutation.mutateAsync({
          cwd: threadProject.cwd,
          path: orphanedWorktreePath,
          force: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing worktree.";
        console.error("Failed to remove orphaned worktree after thread deletion", {
          threadId,
          projectCwd: threadProject.cwd,
          worktreePath: orphanedWorktreePath,
          error,
        });
        toastManager.add({
          type: "error",
          title: "Thread deleted, but worktree removal failed",
          description: `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`,
        });
      }
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalState,
      appSettings.sidebarThreadSortOrder,
      navigate,
      removeWorktreeMutation,
      routeThreadId,
    ],
  );

  const confirmAndDeleteThread = useCallback(
    async (threadId: ThreadId) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = useStore.getState().threads.find((entry) => entry.id === threadId);
      if (!thread) return;

      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }

      await deleteThread(threadId);
    },
    [appSettings.confirmThreadDelete, deleteThread],
  );

  return {
    archiveThread,
    branchThread,
    unarchiveThread,
    deleteThread,
    confirmAndDeleteThread,
  };
}
