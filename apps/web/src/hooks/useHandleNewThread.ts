import { DEFAULT_RUNTIME_MODE, type ProjectId, ThreadId } from "contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback } from "react";
import {
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newThreadId } from "../lib/utils";
import { getDefaultSidebarProjectId } from "../components/Sidebar.logic";
import { useStore } from "../store";
import { useThreadById } from "../storeSelectors";
import { useUiStateStore } from "../uiStateStore";
import { useSettings } from "./useSettings";

type HandleNewThreadOptions = {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
};

type ThreadNavigation = (input: {
  to: "/$threadId";
  params: { threadId: ThreadId };
}) => Promise<unknown>;

export async function openProjectDraftThread(input: {
  projectId: ProjectId;
  navigate: ThreadNavigation;
  routeThreadId: ThreadId | null;
  options?: HandleNewThreadOptions;
}): Promise<void> {
  const {
    clearProjectDraftThreadId,
    getDraftThread,
    getDraftThreadByProjectId,
    applyStickyState,
    setDraftThreadContext,
    setProjectDraftThreadId,
  } = useComposerDraftStore.getState();
  const { navigate, options, projectId, routeThreadId } = input;
  const hasBranchOption = options?.branch !== undefined;
  const hasWorktreePathOption = options?.worktreePath !== undefined;
  const hasEnvModeOption = options?.envMode !== undefined;
  const storedDraftThread = getDraftThreadByProjectId(projectId);
  const latestActiveDraftThread: DraftThreadState | null = routeThreadId
    ? getDraftThread(routeThreadId)
    : null;

  if (storedDraftThread) {
    if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
      setDraftThreadContext(storedDraftThread.threadId, {
        ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
        ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
        ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
      });
    }
    setProjectDraftThreadId(projectId, storedDraftThread.threadId);
    if (routeThreadId === storedDraftThread.threadId) {
      return;
    }
    await navigate({
      to: "/$threadId",
      params: { threadId: storedDraftThread.threadId },
    });
    return;
  }

  clearProjectDraftThreadId(projectId);

  if (latestActiveDraftThread && routeThreadId && latestActiveDraftThread.projectId === projectId) {
    if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
      setDraftThreadContext(routeThreadId, {
        ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
        ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
        ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
      });
    }
    setProjectDraftThreadId(projectId, routeThreadId);
    return;
  }

  const threadId = newThreadId();
  const createdAt = new Date().toISOString();
  setProjectDraftThreadId(projectId, threadId, {
    createdAt,
    branch: options?.branch ?? null,
    worktreePath: options?.worktreePath ?? null,
    envMode: options?.envMode ?? "local",
    runtimeMode: DEFAULT_RUNTIME_MODE,
  });
  applyStickyState(threadId);

  await navigate({
    to: "/$threadId",
    params: { threadId },
  });
}

export function useHandleNewThread() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const appSettings = useSettings();
  const navigate = useNavigate();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const activeThread = useThreadById(routeThreadId);
  const activeDraftThread = useComposerDraftStore((store) =>
    routeThreadId ? (store.draftThreadsByThreadId[routeThreadId] ?? null) : null,
  );
  const defaultProjectId = getDefaultSidebarProjectId({
    projects,
    threads,
    preferredProjectIds: projectOrder,
    sortOrder: appSettings.sidebarProjectSortOrder,
  });

  const handleNewThread = useCallback(
    (projectId: ProjectId, options?: HandleNewThreadOptions): Promise<void> =>
      openProjectDraftThread({
        projectId,
        navigate,
        routeThreadId,
        ...(options ? { options } : {}),
      }),
    [navigate, routeThreadId],
  );

  return {
    activeDraftThread,
    activeThread,
    defaultProjectId,
    handleNewThread,
    routeThreadId,
  };
}
