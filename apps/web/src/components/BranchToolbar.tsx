import type { ProjectId, ThreadId } from "contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  IconFolderOutline24 as FolderGit2,
  IconBranchOutOutline24 as GitForkIcon,
  IconLaptopOutline24 as Laptop,
} from "nucleo-core-outline-24";
import { useCallback } from "react";

import { openProjectDraftThread } from "../hooks/useHandleNewThread";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import { AnimatedFolderIcon } from "./AnimatedFolderIcon";
import {
  EnvMode,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

const envModeItems = [
  { value: "local", label: "Work locally" },
  { value: "worktree", label: "New worktree" },
] as const;

interface BranchToolbarProps {
  threadId: ThreadId;
  onEnvModeChange: (mode: EnvMode) => void;
  envLocked: boolean;
  isGitRepo?: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

export default function BranchToolbar({
  threadId,
  onEnvModeChange,
  envLocked,
  isGitRepo = true,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
}: BranchToolbarProps) {
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const setThreadBranchAction = useStore((store) => store.setThreadBranch);
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(threadId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const navigate = useNavigate();

  const serverThread = threads.find((thread) => thread.id === threadId);
  const activeProjectId = serverThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch = serverThread?.branch ?? draftThread?.branch ?? null;
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const branchCwd = activeWorktreePath ?? activeProject?.cwd ?? null;
  const hasServerThread = serverThread !== undefined;
  const effectiveEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread,
    draftThreadEnvMode: draftThread?.envMode,
  });

  const setThreadBranch = useCallback(
    (branch: string | null, worktreePath: string | null) => {
      if (!activeThreadId) return;
      const api = readNativeApi();
      // If the effective cwd is about to change, stop the running session so the
      // next message creates a new one with the correct cwd.
      if (serverThread?.session && worktreePath !== activeWorktreePath && api) {
        void api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId: activeThreadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      if (api && hasServerThread) {
        void api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThreadId,
          branch,
          worktreePath,
        });
      }
      if (hasServerThread) {
        setThreadBranchAction(activeThreadId, branch, worktreePath);
        return;
      }
      const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: worktreePath,
        currentWorktreePath: activeWorktreePath,
        effectiveEnvMode,
      });
      setDraftThreadContext(threadId, {
        branch,
        worktreePath,
        envMode: nextDraftEnvMode,
      });
    },
    [
      activeThreadId,
      serverThread?.session,
      activeWorktreePath,
      hasServerThread,
      setThreadBranchAction,
      setDraftThreadContext,
      threadId,
      effectiveEnvMode,
    ],
  );

  const handleProjectChange = useCallback(
    (nextProjectId: ProjectId) => {
      if (!nextProjectId || nextProjectId === activeProjectId) {
        return;
      }
      void openProjectDraftThread({
        projectId: nextProjectId,
        navigate,
        routeThreadId: activeThreadId ?? null,
      });
    },
    [activeProjectId, activeThreadId, navigate],
  );

  if (!activeThreadId || !activeProject) return null;

  const projectSelector = hasServerThread ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-transparent px-[calc(--spacing(3)-1px)] py-1.5 text-sm font-medium text-muted-foreground/70 sm:text-xs">
      <FolderGit2 className="size-3.5" />
      <span className="max-w-[10rem] truncate">{activeProject.name}</span>
    </span>
  ) : (
    <Select
      value={activeProject.id}
      onValueChange={(value) => handleProjectChange(value as ProjectId)}
      items={projects.map((project) => ({ value: project.id, label: project.name }))}
    >
      <SelectTrigger
        variant="ghost"
        size="xs"
        className="h-auto gap-1.5 rounded-full py-1.5 font-medium transition-none sm:h-auto sm:py-1.5"
      >
        <AnimatedFolderIcon />
        <SelectValue className="max-w-[10rem] truncate" />
      </SelectTrigger>
      <SelectPopup>
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            <span className="inline-flex items-center gap-1.5">
              <FolderGit2 className="size-3.5" />
              <span className="truncate">{project.name}</span>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );

  const envModeSelector = !isGitRepo ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-transparent px-[calc(--spacing(3)-1px)] py-1.5 text-sm font-medium text-muted-foreground/70 sm:text-xs">
      <Laptop className="size-3.5" />
      Work locally
    </span>
  ) : envLocked || activeWorktreePath ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-transparent px-[calc(--spacing(3)-1px)] py-1.5 text-sm font-medium text-muted-foreground/70 sm:text-xs">
      {activeWorktreePath ? (
        <>
          <GitForkIcon className="size-3" />
          Worktree
        </>
      ) : (
        <>
          <Laptop className="size-3.5" />
          Work locally
        </>
      )}
    </span>
  ) : (
    <Select
      value={effectiveEnvMode}
      onValueChange={(value) => onEnvModeChange(value as EnvMode)}
      items={envModeItems}
    >
      <SelectTrigger
        variant="ghost"
        size="xs"
        className="h-auto gap-1.5 rounded-full py-1.5 font-medium transition-none sm:h-auto sm:py-1.5"
      >
        {effectiveEnvMode === "worktree" ? (
          <GitForkIcon className="size-3" />
        ) : (
          <Laptop className="size-3.5" />
        )}
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="local">
          <span className="inline-flex items-center gap-1.5">
            <Laptop className="size-3.5" />
            Work locally
          </span>
        </SelectItem>
        <SelectItem value="worktree">
          <span className="inline-flex items-center gap-1.5">
            <GitForkIcon className="size-3" />
            New worktree
          </span>
        </SelectItem>
      </SelectPopup>
    </Select>
  );

  const branchSelector = isGitRepo ? (
    <BranchToolbarBranchSelector
      activeProjectCwd={activeProject.cwd}
      activeThreadBranch={activeThreadBranch}
      activeWorktreePath={activeWorktreePath}
      branchCwd={branchCwd}
      effectiveEnvMode={effectiveEnvMode}
      envLocked={envLocked}
      onSetThreadBranch={setThreadBranch}
      {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
      {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
    />
  ) : null;

  return (
    <>
      {projectSelector}
      {envModeSelector}
      {branchSelector}
    </>
  );
}
