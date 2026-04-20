import { type EditorId, type ResolvedKeybindingsConfig, type ThreadId } from "contracts";
import { memo } from "react";
import { ChevronDownIcon, DiffIcon, GitBranchIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

interface ChatHeaderLinkedThread {
  threadId: ThreadId;
  title: string;
  archivedAt: string | null;
}

interface ChatHeaderMissingThread {
  threadId: ThreadId;
}

interface ChatHeaderProps {
  activeThreadTitle: string;
  /** Effective project cwd (worktree path when set, else project root). Shown as monospace path in the header. */
  activeProjectPath: string | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  /** Shortcut label for `terminal.toggle` (no header button; consumed so callers may resolve the binding). */
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  diffOpen: boolean;
  isBranchedThread: boolean;
  parentThread: ChatHeaderLinkedThread | null;
  missingParentThread: ChatHeaderMissingThread | null;
  childThreads: ReadonlyArray<ChatHeaderLinkedThread>;
  onBranchThread: (() => void) | null;
  onNavigateToThread: (threadId: ThreadId) => void;
  onToggleDiff: () => void;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadTitle,
  activeProjectPath,
  isGitRepo,
  openInCwd,
  keybindings,
  availableEditors,
  terminalToggleShortcutLabel: _terminalToggleShortcutLabel,
  diffToggleShortcutLabel,
  diffOpen,
  isBranchedThread,
  parentThread,
  missingParentThread,
  childThreads,
  onBranchThread,
  onNavigateToThread,
  onToggleDiff,
}: ChatHeaderProps) {
  const hasArchivedChildren = childThreads.some((thread) => thread.archivedAt !== null);
  const childCountLabel =
    childThreads.length === 1 ? "1 branch" : `${childThreads.length} branches`;

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 overflow-hidden">
        <div className="flex min-w-0 items-center gap-2 overflow-hidden sm:gap-3">
          <SidebarTrigger className="size-7 shrink-0" />
          <h2
            className="min-w-0 shrink truncate text-sm font-medium text-foreground"
            title={activeThreadTitle}
          >
            {activeThreadTitle}
          </h2>
          {activeProjectPath && (
            <>
              <span className="shrink-0 select-none text-muted-foreground/50" aria-hidden>
                ·
              </span>
              <span
                className="min-w-0 shrink truncate font-mono text-xs text-muted-foreground/90"
                title={activeProjectPath}
              >
                {activeProjectPath}
              </span>
            </>
          )}
        </div>
        {(isBranchedThread || parentThread || missingParentThread || childThreads.length > 0) && (
          <div className="flex min-w-0 items-center gap-2 overflow-hidden pl-9 text-[11px] text-muted-foreground/80">
            {parentThread ? (
              <button
                type="button"
                className="min-w-0 truncate hover:text-foreground hover:underline"
                onClick={() => onNavigateToThread(parentThread.threadId)}
                title={
                  parentThread.archivedAt !== null
                    ? `${parentThread.title} (archived)`
                    : parentThread.title
                }
              >
                Branched from{" "}
                <span className="font-medium">
                  {parentThread.archivedAt !== null
                    ? `${parentThread.title} (archived)`
                    : parentThread.title}
                </span>
              </button>
            ) : missingParentThread ? (
              <span
                className="truncate text-muted-foreground/60"
                title={missingParentThread.threadId}
              >
                Branched from deleted thread
              </span>
            ) : null}
            {childThreads.length > 0 ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button variant="ghost" size="xs" className="h-6 px-2 text-[11px]">
                      {childCountLabel}
                      <ChevronDownIcon className="size-3" />
                    </Button>
                  }
                />
                <MenuPopup align="start" side="bottom">
                  {childThreads.map((thread) => (
                    <MenuItem
                      key={thread.threadId}
                      onClick={() => onNavigateToThread(thread.threadId)}
                    >
                      {thread.archivedAt !== null ? `${thread.title} (archived)` : thread.title}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            ) : null}
            {hasArchivedChildren && (
              <span className="truncate text-muted-foreground/60">
                Archived branches are read-only
              </span>
            )}
          </div>
        )}
      </div>
      <Group className="shrink-0" aria-label="Thread actions">
        {onBranchThread && (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="xs"
                    className="shrink-0 gap-2 px-3"
                    aria-label="Fork thread"
                    onClick={onBranchThread}
                  >
                    <GitBranchIcon className="size-3" />
                    Fork
                  </Button>
                }
              />
              <TooltipPopup side="bottom">Create a linked child thread</TooltipPopup>
            </Tooltip>
            <GroupSeparator />
          </>
        )}
        {activeProjectPath && (
          <>
            <OpenInPicker
              keybindings={keybindings}
              availableEditors={availableEditors}
              openInCwd={openInCwd}
            />
            <GroupSeparator />
          </>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0 px-2.5"
                pressed={diffOpen}
                onPressedChange={onToggleDiff}
                aria-label="Toggle diff panel"
                variant="outline"
                size="xs"
                disabled={!isGitRepo}
              >
                <DiffIcon className="size-3" />
                View diff
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!isGitRepo
              ? "Diff panel is unavailable because this project is not a git repository."
              : diffToggleShortcutLabel
                ? `Toggle diff panel (${diffToggleShortcutLabel})`
                : "Toggle diff panel"}
          </TooltipPopup>
        </Tooltip>
      </Group>
    </div>
  );
});
