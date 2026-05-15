import {
  IconArchiveOutline24 as ArchiveIcon,
  IconSortBottomToTopOutline24 as ArrowUpDownIcon,
  IconChevronDownOutline24 as ChevronDownIcon,
  IconChequeredFlagOutline24 as GoalsIcon,
  IconResizeXOutline24 as Columns2Icon,
  IconFolderOutline24 as FolderClosedIcon,
  IconFolderOutline24 as FolderIcon,
  IconFolderOpenOutline24 as FolderOpenIcon,
  IconBranchOutOutline24 as GitBranchIcon,
  IconBranchMergeOutline24 as GitPullRequestIcon,
  IconCopyOutline24 as CopyIcon,
  IconPencilOutline24 as PencilIcon,
  IconPinTackOutline24 as PinIcon,
  IconPinXmarkOutline24 as PinOffIcon,
  IconMagnifierOutline24 as SearchIcon,
  IconComposeOutline24 as NewThreadIcon,
  IconConsoleOutline24 as TerminalIcon,
  IconTriangleWarningOutline24 as TriangleAlertIcon,
} from "nucleo-core-outline-24";
import { Clock3 as AutomationsIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  memo,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
  type ReactNode,
} from "react";
import { BrailleLoader } from "./ui/braille-loader";
import { useShallow } from "zustand/react/shallow";
import {
  DndContext,
  type DragCancelEvent,
  type CollisionDetection,
  PointerSensor,
  type DragStartEvent,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { type DesktopUpdateState, ProjectId, ThreadId, type GitStatusResult } from "contracts";
import { useQueries } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { type SidebarProjectSortOrder, type SidebarThreadSortOrder } from "contracts/settings";
import { isElectron } from "../env";
import { APP_VERSION } from "../branding";
import { isTerminalFocused } from "../lib/terminalFocus";
import {
  cn,
  isLinuxPlatform,
  isMacPlatform,
  newCommandId,
  newProjectId,
  newThreadId,
} from "../lib/utils";
import { useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useUiStateStore } from "../uiStateStore";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHints,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { gitStatusQueryOptions } from "../lib/gitReactQuery";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useDesktopWindowControlsInset } from "../hooks/useDesktopWindowControlsInset";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  addThreadPaneId,
  encodeThreadPaneSearchValue,
  parseDiffRouteSearch,
  parseThreadPaneSearchValue,
  resolveDroppedThreadPaneIds,
  writeThreadPaneDragData,
} from "../diffRouteSearch";

import { useThreadActions } from "../hooks/useThreadActions";
import { toastManager } from "./ui/toast";
import { formatRelativeTime } from "../timestampFormat";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { AnimatedExpandPanel } from "./ui/AnimatedExpandPanel";
import { Button } from "./ui/button";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenuAction,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarMenuSkeleton,
  SidebarTrigger,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { isNonEmpty as isNonEmptyString } from "effect/String";
import {
  SidebarBackgroundSubagentRowsView,
  useSidebarBackgroundSubagentRows,
} from "./sidebar/SidebarBackgroundSubagentRows";
import { SidebarUserFooter } from "./sidebar/SidebarUserFooter";
import {
  getArchivedOnlyProjectEmptyStateLabel,
  getProjectDeletionBlocker,
  getProjectThreadCounts,
  getVisibleSidebarThreadIds,
  getVisibleThreadsForProject,
  resolveAdjacentThreadId,
  isContextMenuPointerDown,
  resolveSidebarNewThreadSeedContext,
  resolveSidebarNewThreadEnvMode,
  resolveThreadRowClickAction,
  resolveThreadRowClassName,
  orderItemsByPreferredIds,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
  useThreadJumpHintVisibility,
} from "./Sidebar.logic";
import { SidebarUpdatePill } from "./sidebar/SidebarUpdatePill";
import { useProjectAddRequest } from "./sidebar/useProjectAddRequest";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useGoalsFeatureEnabled } from "~/hooks/useGoalsFeatureEnabled";
import { useServerKeybindings } from "../rpc/serverState";
import { useSidebarThreadSummaryById } from "../storeSelectors";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Project } from "../types";
import { normalizeProjectTitle } from "shared/String";
import { ShioriWordmark } from "./ShioriWordmark";
import { PROVIDER_BRAND_ICON_BY_PROVIDER } from "./chat/providerBrandIcons";

const THREAD_PREVIEW_LIMIT = 10;
const SIDEBAR_SORT_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};
const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
};
const SIDEBAR_HOVER_SURFACE_CLASS = "hover:bg-sidebar-hover hover:text-sidebar-hover-foreground";
const SIDEBAR_ROW_LABEL_CLASS = "min-w-0 flex-1 truncate font-normal";
const SIDEBAR_ROW_META_CLASS =
  "ml-auto font-normal text-muted-foreground/50 opacity-0 transition-none! group-hover/menu-item:opacity-100";

type SidebarProjectSnapshot = Project & {
  expanded: boolean;
};

type SidebarSectionKey = "pinned" | "chats" | "projects";

function SidebarBrandHeader() {
  const macWindowControlsInset = useDesktopWindowControlsInset();
  const macTitlebarHorizontalInset = Math.max(16, macWindowControlsInset);
  const wordmark = (
    <div className="relative flex w-full items-center justify-center">
      <SidebarTrigger className="absolute left-0 shrink-0 md:hidden" />
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              aria-label="Go to threads"
              className="flex min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-md outline-hidden ring-ring hover:text-foreground focus-visible:ring-2"
              to="/"
            >
              <ShioriWordmark showLogo={false} />
            </Link>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
    </div>
  );

  return isElectron ? (
    <SidebarHeader
      className="drag-region h-[52px] flex-row items-center gap-2 px-4 py-0"
      style={{
        paddingLeft: `${macTitlebarHorizontalInset}px`,
        paddingRight: `${macTitlebarHorizontalInset}px`,
      }}
    >
      {wordmark}
    </SidebarHeader>
  ) : (
    <SidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3">{wordmark}</SidebarHeader>
  );
}

const SIDEBAR_LOADING_SECTIONS = [
  {
    label: "Pinned",
    rows: [
      { id: "pinned-thread-1", showIcon: false },
      { id: "pinned-thread-2", showIcon: false },
    ],
  },
  {
    label: "Chats",
    rows: [
      { id: "recent-chat-1", showIcon: false },
      { id: "recent-chat-2", showIcon: false },
      { id: "recent-chat-3", showIcon: false },
      { id: "recent-chat-4", showIcon: false },
    ],
  },
  {
    label: "Projects",
    rows: [
      { id: "project-1", showIcon: true },
      { id: "project-2", showIcon: true },
      { id: "project-3", showIcon: true },
    ],
  },
] as const;

interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
}

type ThreadPr = GitStatusResult["pr"];

function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

function SidebarThreadBrailleLoader() {
  return (
    <BrailleLoader className="inline-flex size-3 shrink-0 items-center justify-center font-normal text-sm leading-none text-current opacity-70" />
  );
}

function SidebarLoadingSkeleton({ className }: { className?: string }) {
  return (
    <div aria-label="Loading sidebar" className={cn("flex flex-col gap-3", className)}>
      {SIDEBAR_LOADING_SECTIONS.map((section) => (
        <div key={section.label} className="min-w-0">
          <SidebarGroupLabel className="h-6 px-2 text-xs font-medium text-muted-foreground/60">
            {section.label}
          </SidebarGroupLabel>
          <SidebarMenu className="gap-0.5">
            {section.rows.map((row, index) => (
              <SidebarMenuItem key={row.id}>
                <SidebarMenuSkeleton className="h-7" showIcon={row.showIcon} />
                {section.label === "Projects" && index < 2 ? (
                  <SidebarMenuSub className="mx-0 my-0 mt-0.5 w-full translate-x-0 gap-0.5 overflow-hidden border-l-0 px-0 py-0">
                    <SidebarMenuSkeleton className="h-6" />
                    <SidebarMenuSkeleton className="h-6" />
                  </SidebarMenuSub>
                ) : null}
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </div>
      ))}
    </div>
  );
}

function SidebarSectionHeader(props: {
  children: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    props.onToggle();
  };

  return (
    <div className="flex h-6 min-w-0 items-center px-2 text-xs font-medium text-muted-foreground/60">
      <span
        role="button"
        tabIndex={0}
        aria-expanded={!props.collapsed}
        className="group/section-header inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-sm hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        onClick={props.onToggle}
        onKeyDown={handleKeyDown}
      >
        <span className="min-w-0 truncate">{props.children}</span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 opacity-0 group-hover/section-header:opacity-100 group-focus-visible/section-header:opacity-100",
            props.collapsed ? "-rotate-90" : "rotate-0",
          )}
        />
      </span>
    </div>
  );
}

function SidebarSectionEmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-6 items-center px-2 text-sm text-muted-foreground/55">{children}</div>
  );
}

const SIDEBAR_THREAD_STATUS_GLYPH_TRANSITION_MS = 220;

function SidebarThreadStatusGlyph(props: {
  mode: "dot" | "loader";
  dotClassName?: string | undefined;
  neutralDotClassName?: string | undefined;
}) {
  const isLoaderVisible = props.mode === "loader";
  const [shouldRenderLoader, setShouldRenderLoader] = useState(isLoaderVisible);

  useEffect(() => {
    if (isLoaderVisible) {
      setShouldRenderLoader(true);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setShouldRenderLoader(false);
    }, SIDEBAR_THREAD_STATUS_GLYPH_TRANSITION_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isLoaderVisible]);

  return (
    <span className="relative inline-flex size-3 shrink-0 items-center justify-center [transform:translateZ(0)]">
      <span
        className={cn(
          "absolute inset-0 flex items-center justify-center transition-[opacity,transform,filter] duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          isLoaderVisible
            ? "pointer-events-none opacity-0 scale-[0.6] blur-[2px] motion-reduce:scale-100 motion-reduce:blur-none"
            : "opacity-100 scale-100 blur-0",
        )}
      >
        <span
          className={cn(
            "size-1.5 rounded-full transition-[background-color,opacity] duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
            props.dotClassName ?? props.neutralDotClassName ?? "bg-current opacity-50",
          )}
          aria-hidden
        />
      </span>
      {shouldRenderLoader ? (
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center transition-[opacity,transform,filter] duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
            isLoaderVisible
              ? "opacity-100 scale-100 blur-0"
              : "pointer-events-none opacity-0 scale-[1.08] blur-[2px] motion-reduce:scale-100 motion-reduce:blur-none",
          )}
          aria-hidden={!isLoaderVisible}
        >
          <SidebarThreadBrailleLoader />
        </span>
      ) : null}
    </span>
  );
}

interface SidebarThreadRowProps {
  threadId: ThreadId;
  orderedProjectThreadIds: readonly ThreadId[];
  threadWorkspacePath: string | null;
  routeThreadId: ThreadId | null;
  isSelected: boolean;
  hasSelection: boolean;
  showThreadJumpHints: boolean;
  jumpLabel: string | null;
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  renamingInputRef: MutableRefObject<HTMLInputElement | null>;
  renamingCommittedRef: MutableRefObject<boolean>;
  handleThreadClick: (
    event: MouseEvent,
    threadId: ThreadId,
    orderedProjectThreadIds: readonly ThreadId[],
  ) => void;
  handleThreadDragStart: (event: ReactDragEvent, threadId: ThreadId, title: string) => void;
  navigateToThread: (threadId: ThreadId) => void;
  clearSelection: () => void;
  commitRename: (threadId: ThreadId, newTitle: string, originalTitle: string) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadId: ThreadId) => Promise<void>;
  isPinned: boolean;
  onSetPinned: (threadId: ThreadId, pinned: boolean) => Promise<void>;
  openPrLink: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  pr: ThreadPr | null;
  setRenamingThreadId: (threadId: ThreadId | null) => void;
  onBranchThread: (threadId: ThreadId) => Promise<void>;
  onMarkThreadUnread: (threadId: ThreadId) => void;
  onOpenThreadBeside: (threadId: ThreadId) => void;
  onCopyPath: (path: string) => void;
  onCopyThreadId: (threadId: ThreadId) => void;
}

function areThreadIdArraysEqual(left: readonly ThreadId[], right: readonly ThreadId[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const thread = useSidebarThreadSummaryById(props.threadId);
  const pendingThreadDispatch = useStore(
    (store) => store.pendingThreadDispatchById[props.threadId],
  );
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadId, props.threadId).runningTerminalIds,
  );
  const subagentRows = useSidebarBackgroundSubagentRows(props.threadId);
  const hasSubagents = subagentRows.length > 0;
  const [subagentsExpanded, setSubagentsExpanded] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [isConfirmingArchive, setIsConfirmingArchive] = useState(false);
  const [actionMenuPosition, setActionMenuPosition] = useState<{ x: number; y: number } | null>(
    null,
  );

  useEffect(() => {
    if (!isConfirmingArchive) return;
    const timeoutId = window.setTimeout(() => {
      setIsConfirmingArchive(false);
    }, 3000);
    return () => window.clearTimeout(timeoutId);
  }, [isConfirmingArchive]);

  if (!thread) {
    return null;
  }

  const isActive = props.routeThreadId === thread.id;
  const isSelected = props.isSelected;
  const isHighlighted = isActive || isSelected;
  const hasPendingDispatch = pendingThreadDispatch !== undefined;
  const isThreadRunning =
    thread.session?.status === "running" && thread.session.activeTurnId != null;
  const isThreadBusy = isThreadRunning || hasPendingDispatch;
  const isPinned = props.isPinned;
  const prStatus = prStatusIndicator(props.pr);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const threadMetaClassName = !isThreadBusy
    ? "pointer-events-none group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0"
    : "pointer-events-none";
  const threadActionReserveClassName = !isThreadBusy
    ? isConfirmingArchive
      ? "min-w-28"
      : hasSubagents
        ? "min-w-20"
        : "min-w-16"
    : "min-w-12";
  const threadWorkspacePath = props.threadWorkspacePath;
  const ProviderIcon = PROVIDER_BRAND_ICON_BY_PROVIDER[thread.modelProvider];
  const actionMenuAnchor = useMemo(
    () =>
      actionMenuPosition
        ? {
            getBoundingClientRect: () =>
              new DOMRect(actionMenuPosition.x, actionMenuPosition.y, 0, 0),
          }
        : null,
    [actionMenuPosition],
  );
  const actionMenuTriggerStyle = {
    left: -9999,
    top: -9999,
  } satisfies CSSProperties;

  return (
    <>
      <SidebarMenuSubItem className="w-full" data-thread-item>
        <SidebarMenuSubButton
          render={<div role="button" tabIndex={0} />}
          size="sm"
          isActive={isActive}
          data-testid={`thread-row-${thread.id}`}
          className={`${resolveThreadRowClassName({
            isActive,
            isSelected,
          })} relative isolate`}
          draggable={props.renamingThreadId !== thread.id}
          onDragStart={(event) => {
            props.handleThreadDragStart(event, thread.id, thread.title);
          }}
          onClick={(event) => {
            props.handleThreadClick(event, thread.id, props.orderedProjectThreadIds);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            props.navigateToThread(thread.id);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (isThreadBusy) {
              return;
            }
            if (props.hasSelection) {
              props.clearSelection();
            }
            setActionMenuPosition({
              x: event.clientX,
              y: event.clientY,
            });
            setActionMenuOpen(true);
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            <span className="mr-1.5 inline-flex w-4 shrink-0 items-center justify-center">
              {isThreadBusy ? (
                <SidebarThreadStatusGlyph mode="loader" />
              ) : (
                <span className="relative inline-flex size-4 items-center justify-center">
                  <ProviderIcon
                    aria-hidden="true"
                    className="pointer-events-none inline-flex size-3 shrink-0 text-muted-foreground/70 opacity-55 grayscale group-hover/menu-sub-item:hidden group-focus-within/menu-sub-item:hidden"
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          data-thread-selection-safe
                          data-testid={`thread-pin-${thread.id}`}
                          aria-label={`${isPinned ? "Unpin" : "Pin"} ${thread.title}`}
                          className="absolute inset-0 hidden cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring group-hover/menu-sub-item:inline-flex group-focus-within/menu-sub-item:inline-flex"
                          onPointerDown={(event) => {
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void props.onSetPinned(thread.id, !isPinned);
                          }}
                        >
                          {isPinned ? (
                            <PinOffIcon className="size-3.5" />
                          ) : (
                            <PinIcon className="size-3.5" />
                          )}
                        </button>
                      }
                    />
                    <TooltipPopup side="top">{isPinned ? "Unpin" : "Pin"}</TooltipPopup>
                  </Tooltip>
                </span>
              )}
            </span>
            {thread.parentThreadId !== null && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      role="img"
                      aria-label="Branched thread"
                      className="inline-flex items-center justify-center text-muted-foreground/70"
                    >
                      <GitBranchIcon className="size-3" />
                    </span>
                  }
                />
                <TooltipPopup side="top">Branched thread</TooltipPopup>
              </Tooltip>
            )}
            {prStatus && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={prStatus.tooltip}
                      className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                      onClick={(event) => {
                        props.openPrLink(event, prStatus.url);
                      }}
                    >
                      <GitPullRequestIcon className="size-3" />
                    </button>
                  }
                />
                <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
              </Tooltip>
            )}
            {props.renamingThreadId === thread.id ? (
              <input
                ref={(element) => {
                  if (element && props.renamingInputRef.current !== element) {
                    props.renamingInputRef.current = element;
                    element.focus();
                    element.select();
                  }
                }}
                className="min-w-0 flex-1 truncate border border-ring rounded bg-transparent px-0.5 text-sm outline-none"
                value={props.renamingTitle}
                onChange={(event) => props.setRenamingTitle(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    props.renamingCommittedRef.current = true;
                    void props.commitRename(thread.id, props.renamingTitle, thread.title);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    props.renamingCommittedRef.current = true;
                    props.cancelRename();
                  }
                }}
                onBlur={() => {
                  if (!props.renamingCommittedRef.current) {
                    void props.commitRename(thread.id, props.renamingTitle, thread.title);
                  }
                }}
                onClick={(event) => event.stopPropagation()}
              />
            ) : (
              <span
                className={`min-w-0 flex-1 truncate ${isThreadBusy ? "shimmer shimmer-spread-200" : ""}`}
              >
                {thread.title}
              </span>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {terminalStatus && (
              <span
                role="img"
                aria-label={terminalStatus.label}
                title={terminalStatus.label}
                className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
              >
                <TerminalIcon className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`} />
              </span>
            )}
            <div className={cn("flex justify-end", threadActionReserveClassName)}>
              {!isThreadBusy ? (
                <div className="pointer-events-none absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-1 opacity-0 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                  {hasSubagents ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            data-thread-selection-safe
                            data-testid={`thread-subagents-toggle-${thread.id}`}
                            aria-label={
                              subagentsExpanded
                                ? `Collapse subagents for ${thread.title}`
                                : `Expand subagents for ${thread.title}`
                            }
                            aria-expanded={subagentsExpanded}
                            className="inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                            onPointerDown={(event) => {
                              event.stopPropagation();
                            }}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setSubagentsExpanded((current) => !current);
                            }}
                          >
                            <ChevronDownIcon
                              className={`size-3.5 transition-transform duration-200 ease-out ${
                                subagentsExpanded ? "rotate-0" : "-rotate-90"
                              }`}
                            />
                          </button>
                        }
                      />
                      <TooltipPopup side="top">
                        {subagentsExpanded ? "Collapse subagents" : "Expand subagents"}
                      </TooltipPopup>
                    </Tooltip>
                  ) : null}
                  <Menu
                    open={actionMenuOpen}
                    onOpenChange={(open) => {
                      setActionMenuOpen(open);
                      if (!open) {
                        setActionMenuPosition(null);
                      }
                    }}
                  >
                    <MenuTrigger
                      render={<button type="button" aria-hidden tabIndex={-1} />}
                      className="pointer-events-none fixed size-px opacity-0"
                      style={actionMenuTriggerStyle}
                    />
                    <MenuPopup
                      anchor={actionMenuAnchor}
                      align="start"
                      positionMethod="fixed"
                      side="bottom"
                      sideOffset={4}
                      className="min-w-44"
                    >
                      <MenuGroup>
                        <MenuItem
                          className="grid grid-cols-[1rem_1fr] gap-2"
                          onClick={() => {
                            props.onOpenThreadBeside(thread.id);
                          }}
                        >
                          <Columns2Icon className="size-4" />
                          Open beside
                        </MenuItem>
                        <MenuItem
                          className="grid grid-cols-[1rem_1fr] gap-2"
                          onClick={() => {
                            void props.onBranchThread(thread.id);
                          }}
                        >
                          <GitBranchIcon className="size-4" />
                          Branch thread
                        </MenuItem>
                        <MenuItem
                          className="grid grid-cols-[1rem_1fr] gap-2"
                          onClick={() => {
                            props.setRenamingTitle(thread.title);
                            props.setRenamingThreadId(thread.id);
                            props.renamingCommittedRef.current = false;
                          }}
                        >
                          <PencilIcon className="size-4" />
                          Rename
                        </MenuItem>
                        <MenuItem
                          className="grid grid-cols-[1rem_1fr] gap-2"
                          onClick={() => {
                            props.onMarkThreadUnread(thread.id);
                          }}
                        >
                          <NewThreadIcon className="size-4" />
                          Mark unread
                        </MenuItem>
                        <MenuItem
                          className="grid grid-cols-[1rem_1fr] gap-2"
                          onClick={() => {
                            void props.onSetPinned(thread.id, !isPinned);
                          }}
                        >
                          {isPinned ? (
                            <PinOffIcon className="size-4" />
                          ) : (
                            <PinIcon className="size-4" />
                          )}
                          {isPinned ? "Unpin" : "Pin"}
                        </MenuItem>
                      </MenuGroup>
                      <MenuGroup>
                        <MenuItem
                          className="grid grid-cols-[1rem_1fr] gap-2"
                          disabled={threadWorkspacePath === null}
                          onClick={() => {
                            if (threadWorkspacePath) {
                              props.onCopyPath(threadWorkspacePath);
                            }
                          }}
                        >
                          <CopyIcon className="size-4" />
                          Copy path
                        </MenuItem>
                        <MenuItem
                          className="grid grid-cols-[1rem_1fr] gap-2"
                          onClick={() => {
                            props.onCopyThreadId(thread.id);
                          }}
                        >
                          <CopyIcon className="size-4" />
                          Copy thread ID
                        </MenuItem>
                      </MenuGroup>
                      <MenuGroup>
                        <MenuItem
                          data-testid={`thread-context-archive-${thread.id}`}
                          className="grid grid-cols-[1rem_1fr] gap-2"
                          onClick={() => {
                            void props.attemptArchiveThread(thread.id);
                          }}
                        >
                          <ArchiveIcon className="size-4" />
                          Archive
                        </MenuItem>
                      </MenuGroup>
                    </MenuPopup>
                  </Menu>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          data-thread-selection-safe
                          data-testid={`thread-archive-${thread.id}`}
                          aria-label={
                            isConfirmingArchive
                              ? `Confirm archive ${thread.title}`
                              : `Archive ${thread.title}`
                          }
                          className={cn(
                            "inline-flex h-5 cursor-pointer items-center justify-center focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
                            isConfirmingArchive
                              ? "rounded-full bg-destructive/12 px-2 text-[11px] font-medium text-destructive transition-none hover:bg-destructive/18"
                              : "w-5 text-muted-foreground hover:text-foreground",
                          )}
                          onPointerDown={(event) => {
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (!isConfirmingArchive) {
                              setIsConfirmingArchive(true);
                              return;
                            }
                            setIsConfirmingArchive(false);
                            void props.attemptArchiveThread(thread.id);
                          }}
                        >
                          {isConfirmingArchive ? (
                            <span>Confirm</span>
                          ) : (
                            <ArchiveIcon className="size-3.5" />
                          )}
                        </button>
                      }
                    />
                    <TooltipPopup side="top">
                      {isConfirmingArchive ? "Confirm archive" : "Archive"}
                    </TooltipPopup>
                  </Tooltip>
                </div>
              ) : null}
              <span className={threadMetaClassName}>
                {props.showThreadJumpHints && props.jumpLabel ? (
                  <span
                    className="inline-flex h-5 items-center rounded-full border border-border/80 bg-background/90 px-1.5 font-mono text-sm font-medium tracking-tight text-foreground shadow-sm"
                    title={props.jumpLabel}
                  >
                    {props.jumpLabel}
                  </span>
                ) : (
                  <span
                    className={`text-sm ${
                      isHighlighted
                        ? "text-foreground/72 dark:text-foreground/82"
                        : "text-muted-foreground/40"
                    }`}
                  >
                    {
                      formatRelativeTime(
                        thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
                      ).value
                    }
                  </span>
                )}
              </span>
            </div>
          </div>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
      {hasSubagents && subagentsExpanded ? (
        <SidebarBackgroundSubagentRowsView threadId={thread.id} rows={subagentRows} />
      ) : null}
    </>
  );
}, areSidebarThreadRowPropsEqual);

function areSidebarThreadRowPropsEqual(
  previous: SidebarThreadRowProps,
  next: SidebarThreadRowProps,
): boolean {
  return (
    previous.threadId === next.threadId &&
    previous.threadWorkspacePath === next.threadWorkspacePath &&
    previous.routeThreadId === next.routeThreadId &&
    previous.isSelected === next.isSelected &&
    previous.hasSelection === next.hasSelection &&
    previous.showThreadJumpHints === next.showThreadJumpHints &&
    previous.jumpLabel === next.jumpLabel &&
    previous.renamingThreadId === next.renamingThreadId &&
    previous.renamingTitle === next.renamingTitle &&
    previous.isPinned === next.isPinned &&
    previous.pr === next.pr &&
    previous.setRenamingTitle === next.setRenamingTitle &&
    previous.renamingInputRef === next.renamingInputRef &&
    previous.renamingCommittedRef === next.renamingCommittedRef &&
    previous.handleThreadClick === next.handleThreadClick &&
    previous.handleThreadDragStart === next.handleThreadDragStart &&
    previous.navigateToThread === next.navigateToThread &&
    previous.clearSelection === next.clearSelection &&
    previous.commitRename === next.commitRename &&
    previous.cancelRename === next.cancelRename &&
    previous.attemptArchiveThread === next.attemptArchiveThread &&
    previous.onSetPinned === next.onSetPinned &&
    previous.openPrLink === next.openPrLink &&
    previous.setRenamingThreadId === next.setRenamingThreadId &&
    previous.onBranchThread === next.onBranchThread &&
    previous.onMarkThreadUnread === next.onMarkThreadUnread &&
    previous.onOpenThreadBeside === next.onOpenThreadBeside &&
    previous.onCopyPath === next.onCopyPath &&
    previous.onCopyThreadId === next.onCopyThreadId &&
    areThreadIdArraysEqual(previous.orderedProjectThreadIds, next.orderedProjectThreadIds)
  );
}

type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function ProjectSortMenu({
  projectSortOrder,
  threadSortOrder,
  onProjectSortOrderChange,
  onThreadSortOrderChange,
}: {
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              className={cn(
                "inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-foreground",
                SIDEBAR_HOVER_SURFACE_CLASS,
              )}
            />
          }
        >
          <ArrowUpDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">Sort projects</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-44">
        <MenuGroup>
          <div className="px-2 py-1 text-sm font-medium text-muted-foreground">Sort projects</div>
          <MenuRadioGroup
            value={projectSortOrder}
            onValueChange={(value) => {
              onProjectSortOrderChange(value as SidebarProjectSortOrder);
            }}
          >
            {(Object.entries(SIDEBAR_SORT_LABELS) as Array<[SidebarProjectSortOrder, string]>).map(
              ([value, label]) => (
                <MenuRadioItem key={value} value={value} className="min-h-7 py-1 text-sm">
                  {label}
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 text-sm font-medium text-muted-foreground">
            Sort threads
          </div>
          <MenuRadioGroup
            value={threadSortOrder}
            onValueChange={(value) => {
              onThreadSortOrderChange(value as SidebarThreadSortOrder);
            }}
          >
            {(
              Object.entries(SIDEBAR_THREAD_SORT_LABELS) as Array<[SidebarThreadSortOrder, string]>
            ).map(([value, label]) => (
              <MenuRadioItem key={value} value={value} className="min-h-7 py-1 text-sm">
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function SortableProjectItem({
  projectId,
  disabled = false,
  children,
}: {
  projectId: ProjectId;
  disabled?: boolean;
  children: (handleProps: SortableProjectHandleProps) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: projectId, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={cn(
        "group/menu-item relative border border-transparent",
        isOver && !isDragging ? "rounded-none" : "rounded-md",
        isDragging ? "z-20 opacity-80" : "",
        isOver && !isDragging
          ? "border-t-blue-500/70 border-x-transparent border-b-transparent"
          : "",
      )}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

function SettingsSidebarContent({ pathname }: { pathname: string }) {
  return (
    <>
      <SidebarBrandHeader />
      <SettingsSidebarNav pathname={pathname} />
    </>
  );
}

function ThreadSidebarContent(props: { onSearchClick?: () => void }) {
  const projects = useStore((store) => store.projects);
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const sidebarThreadsById = useStore((store) => store.sidebarThreadsById);
  const sidebarThreadsByIdRef = useRef(sidebarThreadsById);
  const threadIdsByProjectId = useStore((store) => store.threadIdsByProjectId);
  const { projectExpandedById, projectOrder } = useUiStateStore(
    useShallow((store) => ({
      projectExpandedById: store.projectExpandedById,
      projectOrder: store.projectOrder,
    })),
  );
  const projectAddRequestNonce = useUiStateStore((store) => store.projectAddRequestNonce);
  const markThreadUnread = useUiStateStore((store) => store.markThreadUnread);
  const toggleProject = useUiStateStore((store) => store.toggleProject);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const setDraftThread = useComposerDraftStore((store) => store.setDraftThread);
  const applyStickyDraftState = useComposerDraftStore((store) => store.applyStickyState);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const appSettings = useSettings();
  const goalsEnabled = useGoalsFeatureEnabled();
  const { updateSettings } = useUpdateSettings();
  const { activeDraftThread, activeThread, defaultProjectId, handleNewThread } =
    useHandleNewThread();
  const { archiveThread, branchThread } = useThreadActions();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const routeSearch = useSearch({
    strict: false,
    select: (search) => parseDiffRouteSearch(search),
  });
  const keybindings = useServerKeybindings();
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<ProjectId>
  >(() => new Set());
  const [collapsedSidebarSections, setCollapsedSidebarSections] = useState<
    ReadonlySet<SidebarSectionKey>
  >(() => new Set());
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const selectedThreadIds = useThreadSelectionStore((s) => s.selectedThreadIds);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const isLinuxDesktop = isElectron && isLinuxPlatform(navigator.platform);
  const platform = navigator.platform;
  const shouldBrowseForProjectImmediately = isElectron && !isLinuxDesktop;
  const shouldShowProjectPathEntry = addingProject && !shouldBrowseForProjectImmediately;
  useEffect(() => {
    sidebarThreadsByIdRef.current = sidebarThreadsById;
  }, [sidebarThreadsById]);
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: (project) => project.id,
    });
  }, [projectOrder, projects]);
  const sidebarProjects = useMemo<SidebarProjectSnapshot[]>(
    () =>
      orderedProjects.map((project) => ({
        ...project,
        expanded: projectExpandedById[project.id] ?? true,
      })),
    [orderedProjects, projectExpandedById],
  );
  const sidebarThreads = useMemo(() => Object.values(sidebarThreadsById), [sidebarThreadsById]);
  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );
  const resolveThreadWorkspacePath = useCallback(
    (threadId: ThreadId): string | null => {
      const thread = sidebarThreadsById[threadId];
      if (!thread) {
        return null;
      }
      return (
        thread.worktreePath ??
        (thread.projectId !== null
          ? projectCwdById.get(thread.projectId)
          : thread.projectlessCwd) ??
        null
      );
    },
    [projectCwdById, sidebarThreadsById],
  );
  const routeTerminalOpen = routeThreadId
    ? selectThreadTerminalState(terminalStateByThreadId, routeThreadId).terminalOpen
    : false;
  const sidebarShortcutLabelOptions = useMemo(
    () => ({
      platform,
      context: {
        terminalFocus: false,
        terminalOpen: routeTerminalOpen,
        goalsView: pathname === "/goals",
      },
    }),
    [pathname, platform, routeTerminalOpen],
  );
  const searchShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "search.open", sidebarShortcutLabelOptions),
    [keybindings, sidebarShortcutLabelOptions],
  );
  const toggleSidebarSection = useCallback((section: SidebarSectionKey) => {
    setCollapsedSidebarSections((current) => {
      const next = new Set(current);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }, []);
  const createProjectlessChat = useCallback(async () => {
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    try {
      setDraftThread(threadId, {
        projectId: null,
        createdAt,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        envMode: "local",
      });
      applyStickyDraftState(threadId);
      setCollapsedSidebarSections((current) => {
        if (!current.has("chats")) {
          return current;
        }
        const next = new Set(current);
        next.delete("chats");
        return next;
      });
      await navigate({
        to: "/$threadId",
        params: { threadId },
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to create draft chat",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  }, [applyStickyDraftState, navigate, setDraftThread]);

  const openPrLink = useCallback((event: MouseEvent<HTMLElement>, prUrl: string) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
      });
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, []);

  const attemptArchiveThread = useCallback(
    async (threadId: ThreadId) => {
      try {
        await archiveThread(threadId);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to archive thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [archiveThread],
  );

  const addProjectFromPath = useCallback(
    async (rawCwd: string) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) return;
      const api = readNativeApi();
      if (!api) return;

      setIsAddingProject(true);
      const finishAddingProject = () => {
        setIsAddingProject(false);
        setNewCwd("");
        setAddProjectError(null);
        setAddingProject(false);
      };

      const existing = projects.find((project) => project.cwd === cwd);
      if (existing) {
        await handleNewThread(existing.id, {
          envMode: appSettings.defaultThreadEnvMode,
        });
        finishAddingProject();
        return;
      }

      const projectId = newProjectId();
      const createdAt = new Date().toISOString();
      const title = normalizeProjectTitle(cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? cwd);
      try {
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          workspaceRoot: cwd,
          defaultModelSelection: appSettings.defaultModelSelection,
          createdAt,
        });
        await handleNewThread(projectId, {
          envMode: appSettings.defaultThreadEnvMode,
        });
      } catch (error) {
        const description =
          error instanceof Error ? error.message : "An error occurred while adding the project.";
        setIsAddingProject(false);
        if (shouldBrowseForProjectImmediately) {
          toastManager.add({
            type: "error",
            title: "Failed to add project",
            description,
          });
        } else {
          setAddProjectError(description);
        }
        return;
      }
      finishAddingProject();
    },
    [
      handleNewThread,
      isAddingProject,
      projects,
      appSettings.defaultModelSelection,
      shouldBrowseForProjectImmediately,
      appSettings.defaultThreadEnvMode,
    ],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd);
  };

  const canAddProject = newCwd.trim().length > 0 && !isAddingProject;

  const handlePickFolder = async () => {
    const api = readNativeApi();
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    let pickedPath: string | null = null;
    try {
      pickedPath = await api.dialogs.pickFolder();
    } catch {
      // Ignore picker failures and leave the current thread selection unchanged.
    }
    if (pickedPath) {
      await addProjectFromPath(pickedPath);
    } else if (!shouldBrowseForProjectImmediately) {
      addProjectInputRef.current?.focus();
    }
    setIsPickingFolder(false);
  };

  const handlePickFolderRef = useRef(handlePickFolder);
  handlePickFolderRef.current = handlePickFolder;

  const revealProjectPathEntry = useCallback(() => {
    setAddProjectError(null);
    setAddingProject(true);
    window.requestAnimationFrame(() => {
      addProjectInputRef.current?.focus();
    });
  }, []);

  useProjectAddRequest({
    projectAddRequestNonce,
    shouldBrowseForProjectImmediately,
    onPickFolder: () => handlePickFolderRef.current(),
    onRevealPathEntry: revealProjectPathEntry,
  });

  const cancelRename = useCallback(() => {
    setRenamingThreadId(null);
    renamingInputRef.current = null;
  }, []);

  const commitRename = useCallback(
    async (threadId: ThreadId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingThreadId((current) => {
          if (current !== threadId) return current;
          renamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({
          type: "warning",
          title: "Thread title cannot be empty",
        });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readNativeApi();
      if (!api) {
        finishRename();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finishRename();
    },
    [],
  );

  const setThreadPinned = useCallback(async (threadId: ThreadId, pinned: boolean) => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Thread pinning is unavailable.",
      });
      return;
    }

    try {
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId,
        pinnedAt: pinned ? new Date().toISOString() : null,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: pinned ? "Failed to pin thread" : "Failed to unpin thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  }, []);

  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy thread ID",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{
    path: string;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
  const handleBranchThread = useCallback(
    async (threadId: ThreadId) => {
      try {
        await branchThread(threadId);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not branch thread",
          description: error instanceof Error ? error.message : "An unknown error occurred.",
        });
      }
    },
    [branchThread],
  );
  const handleMarkThreadUnread = useCallback(
    (threadId: ThreadId) => {
      const thread = sidebarThreadsByIdRef.current[threadId];
      if (thread) {
        markThreadUnread(threadId, thread.latestTurn?.completedAt);
      }
    },
    [markThreadUnread],
  );
  const handleCopyPath = useCallback(
    (path: string) => {
      copyPathToClipboard(path, { path });
    },
    [copyPathToClipboard],
  );
  const handleCopyThreadId = useCallback(
    (threadId: ThreadId) => {
      copyThreadIdToClipboard(threadId, { threadId });
    },
    [copyThreadIdToClipboard],
  );
  const handleThreadClick = useCallback(
    (event: MouseEvent, threadId: ThreadId, orderedProjectThreadIds: readonly ThreadId[]) => {
      const clickAction = resolveThreadRowClickAction({
        button: event.button,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        isMac: isMacPlatform(navigator.platform),
      });

      if (clickAction === "noop") {
        event.preventDefault();
        return;
      }

      if (clickAction === "toggle-selection") {
        event.preventDefault();
        toggleThreadSelection(threadId);
        return;
      }

      if (clickAction === "range-select") {
        event.preventDefault();
        rangeSelectTo(threadId, orderedProjectThreadIds);
        return;
      }

      // Plain click — clear selection, set anchor for future shift-clicks, and navigate
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadId);
      void navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [
      clearSelection,
      navigate,
      rangeSelectTo,
      selectedThreadIds.size,
      setSelectionAnchor,
      toggleThreadSelection,
    ],
  );

  const handleThreadDragStart = useCallback(
    (event: ReactDragEvent, threadId: ThreadId, title: string) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-thread-selection-safe]")) {
        event.preventDefault();
        return;
      }

      writeThreadPaneDragData(event.dataTransfer, threadId);
      event.dataTransfer.dropEffect = "copy";
      const ghost = document.createElement("div");
      ghost.textContent = title;
      ghost.style.position = "fixed";
      ghost.style.top = "-1000px";
      ghost.style.left = "-1000px";
      ghost.style.maxWidth = "240px";
      ghost.style.padding = "4px 8px";
      ghost.style.borderRadius = "6px";
      ghost.style.background = "rgb(24 24 27)";
      ghost.style.color = "white";
      ghost.style.font = "12px system-ui, sans-serif";
      ghost.style.whiteSpace = "nowrap";
      ghost.style.overflow = "hidden";
      ghost.style.textOverflow = "ellipsis";
      document.body.appendChild(ghost);
      event.dataTransfer.setDragImage(ghost, 12, 12);
      window.setTimeout(() => {
        ghost.remove();
      }, 0);
    },
    [],
  );

  const navigateToThread = useCallback(
    (threadId: ThreadId) => {
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadId);
      void navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [clearSelection, navigate, selectedThreadIds.size, setSelectionAnchor],
  );

  const openThreadBeside = useCallback(
    (threadId: ThreadId) => {
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadId);
      const focusedThreadId = routeThreadId ?? threadId;
      const paneThreadIds = parseThreadPaneSearchValue(routeSearch.panes);
      const nextPaneIds =
        routeThreadId === null
          ? addThreadPaneId({
              focusedThreadId,
              paneThreadIds,
              threadId,
            })
          : resolveDroppedThreadPaneIds({
              focusedThreadId,
              paneThreadIds,
              threadId,
            });

      void navigate({
        to: "/$threadId",
        params: { threadId: focusedThreadId },
        search: (previous) => ({
          ...previous,
          panes: encodeThreadPaneSearchValue(nextPaneIds),
        }),
      });
    },
    [
      clearSelection,
      navigate,
      routeSearch.panes,
      routeThreadId,
      selectedThreadIds.size,
      setSelectionAnchor,
    ],
  );

  const handleProjectContextMenu = useCallback(
    async (projectId: ProjectId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;

      const clicked = await api.contextMenu.show(
        [
          { id: "copy-path", label: "Copy Project Path" },
          { id: "delete", label: "Remove project", destructive: true },
        ],
        position,
      );
      if (clicked === "copy-path") {
        copyPathToClipboard(project.cwd, { path: project.cwd });
        return;
      }
      if (clicked !== "delete") return;

      const projectThreadIds = threadIdsByProjectId[projectId] ?? [];
      const projectDeletionBlocker = getProjectDeletionBlocker({
        threadIds: projectThreadIds,
        threadsById: sidebarThreadsById,
      });
      if (projectDeletionBlocker) {
        toastManager.add({
          type: "warning",
          title: projectDeletionBlocker.title,
          description: projectDeletionBlocker.description,
        });
        return;
      }

      const confirmed = await api.dialogs.confirm(`Remove project "${project.name}"?`);
      if (!confirmed) return;

      try {
        const projectDraftThread = getDraftThreadByProjectId(projectId);
        if (projectDraftThread) {
          clearComposerDraftForThread(projectDraftThread.threadId);
        }
        clearProjectDraftThreadId(projectId);
        await api.orchestration.dispatchCommand({
          type: "project.delete",
          commandId: newCommandId(),
          projectId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing project.";
        console.error("Failed to remove project", { projectId, error });
        toastManager.add({
          type: "error",
          title: `Failed to remove "${project.name}"`,
          description: message,
        });
      }
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadId,
      copyPathToClipboard,
      getDraftThreadByProjectId,
      projects,
      sidebarThreadsById,
      threadIdsByProjectId,
    ],
  );

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);
  const visibleThreads = useMemo(
    () => sidebarThreads.filter((thread) => thread.archivedAt === null),
    [sidebarThreads],
  );
  const sortedProjects = useMemo(
    () =>
      sortProjectsForSidebar(sidebarProjects, visibleThreads, appSettings.sidebarProjectSortOrder),
    [appSettings.sidebarProjectSortOrder, sidebarProjects, visibleThreads],
  );

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeProject = sidebarProjects.find((project) => project.id === active.id);
      const overProject = sidebarProjects.find((project) => project.id === over.id);
      if (!activeProject || !overProject) return;
      reorderProjects(
        activeProject.id,
        overProject.id,
        sortedProjects.map((project) => project.id),
      );
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        // Dragging establishes an explicit personal order, so promote the sidebar into
        // manual sorting immediately after the drop lands.
        updateSettings({ sidebarProjectSortOrder: "manual" });
      }
    },
    [
      appSettings.sidebarProjectSortOrder,
      reorderProjects,
      sidebarProjects,
      sortedProjects,
      updateSettings,
    ],
  );

  const handleProjectDragStart = useCallback((_event: DragStartEvent) => {
    dragInProgressRef.current = true;
    suppressProjectClickAfterDragRef.current = true;
  }, []);

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);

  const handleProjectTitlePointerDownCapture = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      suppressProjectClickForContextMenuRef.current = false;
      if (
        isContextMenuPointerDown({
          button: event.button,
          ctrlKey: event.ctrlKey,
          isMac: isMacPlatform(navigator.platform),
        })
      ) {
        // Keep context-menu gestures from arming the sortable drag sensor.
        event.stopPropagation();
      }

      suppressProjectClickAfterDragRef.current = false;
    },
    [],
  );
  const renderedProjects = useMemo(
    () =>
      sortedProjects.map((project) => {
        const projectThreadIds = threadIdsByProjectId[project.id] ?? [];
        const { archivedThreadCount } = getProjectThreadCounts({
          threadIds: projectThreadIds,
          threadsById: sidebarThreadsById,
        });
        const projectThreads = sortThreadsForSidebar(
          projectThreadIds
            .map((threadId) => sidebarThreadsById[threadId])
            .filter((thread): thread is NonNullable<typeof thread> => thread !== undefined)
            .filter((thread) => thread.archivedAt === null && thread.pinnedAt == null),
          appSettings.sidebarThreadSortOrder,
        );
        const activeThreadId = routeThreadId ?? undefined;
        const isThreadListExpanded = expandedThreadListsByProject.has(project.id);
        const pinnedCollapsedThread =
          !project.expanded && activeThreadId
            ? (projectThreads.find((thread) => thread.id === activeThreadId) ?? null)
            : null;
        const shouldShowThreadPanel = project.expanded || pinnedCollapsedThread !== null;
        const { hasHiddenThreads, visibleThreads: visibleProjectThreads } =
          getVisibleThreadsForProject({
            threads: projectThreads,
            activeThreadId,
            isThreadListExpanded,
            previewLimit: THREAD_PREVIEW_LIMIT,
          });
        const orderedProjectThreadIds = projectThreads.map((thread) => thread.id);
        const renderedThreadIds = pinnedCollapsedThread
          ? [pinnedCollapsedThread.id]
          : visibleProjectThreads.map((thread) => thread.id);
        const animatedThreadIds = pinnedCollapsedThread
          ? visibleProjectThreads.map((thread) => thread.id)
          : renderedThreadIds;
        const showEmptyThreadState = projectThreads.length === 0;
        const emptyThreadStateLabel =
          archivedThreadCount > 0
            ? getArchivedOnlyProjectEmptyStateLabel(archivedThreadCount)
            : "No threads yet";

        return {
          animatedThreadIds,
          emptyThreadStateLabel,
          hasHiddenThreads,
          orderedProjectThreadIds,
          pinnedCollapsedThreadId: pinnedCollapsedThread?.id ?? null,
          project,
          renderedThreadIds,
          showEmptyThreadState,
          shouldShowThreadPanel,
          isThreadListExpanded,
        };
      }),
    [
      appSettings.sidebarThreadSortOrder,
      expandedThreadListsByProject,
      routeThreadId,
      sortedProjects,
      sidebarThreadsById,
      threadIdsByProjectId,
    ],
  );
  const pinnedThreads = useMemo(() => {
    const threads = sortThreadsForSidebar(
      visibleThreads.filter((thread) => thread.pinnedAt != null),
      appSettings.sidebarThreadSortOrder,
    );
    return threads.toSorted((left, right) => {
      const leftPinnedAt = Date.parse(left.pinnedAt ?? "");
      const rightPinnedAt = Date.parse(right.pinnedAt ?? "");
      return (
        (Number.isNaN(rightPinnedAt) ? 0 : rightPinnedAt) -
        (Number.isNaN(leftPinnedAt) ? 0 : leftPinnedAt)
      );
    });
  }, [appSettings.sidebarThreadSortOrder, visibleThreads]);
  const orderedPinnedThreadIds = useMemo(
    () => pinnedThreads.map((thread) => thread.id),
    [pinnedThreads],
  );
  const chatThreads = useMemo(
    () =>
      sortThreadsForSidebar(
        visibleThreads.filter((thread) => thread.projectId === null && thread.pinnedAt == null),
        appSettings.sidebarThreadSortOrder,
      ),
    [appSettings.sidebarThreadSortOrder, visibleThreads],
  );
  const renderedChatThreadIds = useMemo(
    () => chatThreads.slice(0, THREAD_PREVIEW_LIMIT).map((thread) => thread.id),
    [chatThreads],
  );
  const orderedChatThreadIds = useMemo(() => chatThreads.map((thread) => thread.id), [chatThreads]);
  const visiblePinnedSidebarThreadIds = useMemo(
    () => (collapsedSidebarSections.has("pinned") ? [] : orderedPinnedThreadIds),
    [collapsedSidebarSections, orderedPinnedThreadIds],
  );
  const visibleChatSidebarThreadIds = useMemo(
    () => (collapsedSidebarSections.has("chats") ? [] : renderedChatThreadIds),
    [collapsedSidebarSections, renderedChatThreadIds],
  );
  const visibleProjectSidebarThreadIds = useMemo(
    () =>
      collapsedSidebarSections.has("projects") ? [] : getVisibleSidebarThreadIds(renderedProjects),
    [collapsedSidebarSections, renderedProjects],
  );
  const visibleSidebarThreadIds = useMemo(() => {
    const seenThreadIds = new Set<ThreadId>();
    const orderedThreadIds: ThreadId[] = [];
    for (const threadId of [
      ...visiblePinnedSidebarThreadIds,
      ...visibleChatSidebarThreadIds,
      ...visibleProjectSidebarThreadIds,
    ]) {
      if (seenThreadIds.has(threadId)) {
        continue;
      }
      seenThreadIds.add(threadId);
      orderedThreadIds.push(threadId);
    }
    return orderedThreadIds;
  }, [visibleChatSidebarThreadIds, visiblePinnedSidebarThreadIds, visibleProjectSidebarThreadIds]);
  const visibleSidebarThreadsForGit = useMemo(
    () =>
      visibleSidebarThreadIds
        .map((threadId) => sidebarThreadsById[threadId])
        .filter((thread): thread is NonNullable<typeof thread> => thread !== undefined),
    [sidebarThreadsById, visibleSidebarThreadIds],
  );
  const threadGitTargets = useMemo(
    () =>
      visibleSidebarThreadsForGit.map((thread) => ({
        threadId: thread.id,
        branch: thread.branch,
        cwd:
          thread.worktreePath ??
          (thread.projectId !== null
            ? projectCwdById.get(thread.projectId)
            : thread.projectlessCwd) ??
          null,
      })),
    [projectCwdById, visibleSidebarThreadsForGit],
  );
  const threadGitStatusCwds = useMemo(
    () => [
      ...new Set(
        threadGitTargets
          .filter((target) => target.branch !== null)
          .map((target) => target.cwd)
          .filter((cwd): cwd is string => cwd !== null),
      ),
    ],
    [threadGitTargets],
  );
  const threadGitStatusQueries = useQueries({
    queries: threadGitStatusCwds.map((cwd) => ({
      ...gitStatusQueryOptions(cwd),
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });
  const prByThreadId = useMemo(() => {
    const statusByCwd = new Map<string, GitStatusResult>();
    for (let index = 0; index < threadGitStatusCwds.length; index += 1) {
      const cwd = threadGitStatusCwds[index];
      if (!cwd) continue;
      const status = threadGitStatusQueries[index]?.data;
      if (status) {
        statusByCwd.set(cwd, status);
      }
    }

    const map = new Map<ThreadId, ThreadPr>();
    for (const target of threadGitTargets) {
      const status = target.cwd ? statusByCwd.get(target.cwd) : undefined;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      map.set(target.threadId, branchMatches ? (status?.pr ?? null) : null);
    }
    return map;
  }, [threadGitStatusCwds, threadGitStatusQueries, threadGitTargets]);
  const threadJumpCommandById = useMemo(() => {
    const mapping = new Map<ThreadId, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadId] of visibleSidebarThreadIds.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(threadId, jumpCommand);
    }

    return mapping;
  }, [visibleSidebarThreadIds]);
  const threadJumpThreadIds = useMemo(
    () => [...threadJumpCommandById.keys()],
    [threadJumpCommandById],
  );
  const threadJumpLabelById = useMemo(() => {
    const mapping = new Map<ThreadId, string>();
    for (const [threadId, command] of threadJumpCommandById) {
      const label = shortcutLabelForCommand(keybindings, command, sidebarShortcutLabelOptions);
      if (label) {
        mapping.set(threadId, label);
      }
    }
    return mapping;
  }, [keybindings, sidebarShortcutLabelOptions, threadJumpCommandById]);
  const orderedSidebarThreadIds = visibleSidebarThreadIds;

  useEffect(() => {
    const getShortcutContext = () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen: routeTerminalOpen,
    });

    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      updateThreadJumpHintsVisibility(
        shouldShowThreadJumpHints(event, keybindings, {
          platform,
          context: getShortcutContext(),
        }),
      );

      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform,
        context: getShortcutContext(),
      });
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        const targetThreadId = resolveAdjacentThreadId({
          threadIds: orderedSidebarThreadIds,
          currentThreadId: routeThreadId,
          direction: traversalDirection,
        });
        if (!targetThreadId) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        navigateToThread(targetThreadId);
        return;
      }

      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetThreadId = threadJumpThreadIds[jumpIndex];
      if (!targetThreadId) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      navigateToThread(targetThreadId);
    };

    const onWindowKeyUp = (event: globalThis.KeyboardEvent) => {
      updateThreadJumpHintsVisibility(
        shouldShowThreadJumpHints(event, keybindings, {
          platform,
          context: getShortcutContext(),
        }),
      );
    };

    const onWindowBlur = () => {
      updateThreadJumpHintsVisibility(false);
    };

    window.addEventListener("keydown", onWindowKeyDown);
    window.addEventListener("keyup", onWindowKeyUp);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
      window.removeEventListener("keyup", onWindowKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [
    keybindings,
    navigateToThread,
    orderedSidebarThreadIds,
    platform,
    routeTerminalOpen,
    routeThreadId,
    threadJumpThreadIds,
    updateThreadJumpHintsVisibility,
  ]);

  function renderProjectItem(
    renderedProject: (typeof renderedProjects)[number],
    dragHandleProps: SortableProjectHandleProps | null,
  ) {
    const {
      animatedThreadIds,
      hasHiddenThreads,
      orderedProjectThreadIds,
      emptyThreadStateLabel,
      pinnedCollapsedThreadId,
      project,
      showEmptyThreadState,
      shouldShowThreadPanel,
      isThreadListExpanded,
    } = renderedProject;
    const renderProjectThreadRow = (threadId: ThreadId) => (
      <SidebarThreadRow
        threadId={threadId}
        orderedProjectThreadIds={orderedProjectThreadIds}
        threadWorkspacePath={resolveThreadWorkspacePath(threadId)}
        routeThreadId={routeThreadId}
        isSelected={selectedThreadIds.has(threadId)}
        hasSelection={selectedThreadIds.size > 0}
        showThreadJumpHints={showThreadJumpHints}
        jumpLabel={threadJumpLabelById.get(threadId) ?? null}
        renamingThreadId={renamingThreadId}
        renamingTitle={renamingTitle}
        setRenamingTitle={setRenamingTitle}
        renamingInputRef={renamingInputRef}
        renamingCommittedRef={renamingCommittedRef}
        handleThreadClick={handleThreadClick}
        handleThreadDragStart={handleThreadDragStart}
        navigateToThread={navigateToThread}
        clearSelection={clearSelection}
        commitRename={commitRename}
        cancelRename={cancelRename}
        attemptArchiveThread={attemptArchiveThread}
        isPinned={sidebarThreadsById[threadId]?.pinnedAt != null}
        onSetPinned={setThreadPinned}
        openPrLink={openPrLink}
        pr={prByThreadId.get(threadId) ?? null}
        setRenamingThreadId={setRenamingThreadId}
        onBranchThread={handleBranchThread}
        onMarkThreadUnread={handleMarkThreadUnread}
        onOpenThreadBeside={openThreadBeside}
        onCopyPath={handleCopyPath}
        onCopyThreadId={handleCopyThreadId}
      />
    );
    return (
      <>
        <div className="group/project-header relative">
          <SidebarMenuButton
            ref={dragHandleProps?.setActivatorNodeRef}
            size="sm"
            className="group/project-name cursor-grab gap-2 px-2 py-1.5 text-left hover:bg-transparent active:cursor-grabbing active:bg-transparent"
            {...(dragHandleProps ? dragHandleProps.attributes : {})}
            {...(dragHandleProps ? dragHandleProps.listeners : {})}
            onPointerDownCapture={handleProjectTitlePointerDownCapture}
            onClick={(event) => handleProjectTitleClick(event, project.id)}
            onKeyDown={(event) => handleProjectTitleKeyDown(event, project.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              suppressProjectClickForContextMenuRef.current = true;
              void handleProjectContextMenu(project.id, {
                x: event.clientX,
                y: event.clientY,
              });
            }}
          >
            {project.expanded ? (
              <FolderOpenIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/60" />
            ) : (
              <FolderClosedIcon
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground/60"
              />
            )}
            <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground/72">
              {project.name}
            </span>
            <ChevronDownIcon
              aria-hidden
              className={`pointer-events-none size-3.5 shrink-0 text-foreground/45 opacity-0 group-hover/project-name:opacity-100 group-focus-visible/project-name:opacity-100 ${
                project.expanded ? "rotate-0" : "-rotate-90"
              }`}
            />
          </SidebarMenuButton>
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuAction
                  render={
                    <button
                      type="button"
                      aria-label={`Create new thread in ${project.name}`}
                      data-testid="new-thread-in-project-button"
                    />
                  }
                  showOnHover
                  className="top-1 right-1.5 size-5 rounded-md p-0 text-muted-foreground/70"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const seedContext = resolveSidebarNewThreadSeedContext({
                      projectId: project.id,
                      defaultEnvMode: resolveSidebarNewThreadEnvMode({
                        defaultEnvMode: appSettings.defaultThreadEnvMode,
                      }),
                      activeThread:
                        activeThread && activeThread.projectId === project.id
                          ? {
                              projectId: activeThread.projectId,
                              branch: activeThread.branch,
                              worktreePath: activeThread.worktreePath,
                            }
                          : null,
                      activeDraftThread:
                        activeDraftThread && activeDraftThread.projectId === project.id
                          ? {
                              projectId: activeDraftThread.projectId,
                              branch: activeDraftThread.branch,
                              worktreePath: activeDraftThread.worktreePath,
                              envMode: activeDraftThread.envMode,
                            }
                          : null,
                    });
                    void handleNewThread(project.id, {
                      ...(seedContext.branch !== undefined ? { branch: seedContext.branch } : {}),
                      ...(seedContext.worktreePath !== undefined
                        ? { worktreePath: seedContext.worktreePath }
                        : {}),
                      envMode: seedContext.envMode,
                    });
                  }}
                >
                  <NewThreadIcon className="size-3.5" />
                </SidebarMenuAction>
              }
            />
            <TooltipPopup side="top">
              {newThreadShortcutLabel ? `New Thread (${newThreadShortcutLabel})` : "New Thread"}
            </TooltipPopup>
          </Tooltip>
        </div>

        <AnimatedExpandPanel
          open={shouldShowThreadPanel}
          fade
          className="w-full"
          contentClassName="min-h-0"
        >
          {/* Keep live row updates static. We only animate thread rows here when a
              collapsed project needs to keep the active thread pinned in place. */}
          <SidebarMenuSub
            className={cn(
              "mx-0 my-0 mt-0.5 w-full translate-x-0 overflow-hidden border-l-0 px-0 py-0",
              project.expanded ? "gap-0.5" : "gap-0",
            )}
          >
            {showEmptyThreadState ? (
              <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
                <div
                  data-thread-selection-safe
                  className="flex h-6 w-full translate-x-0 items-center gap-2 px-2 text-left text-sm text-muted-foreground/60"
                >
                  <span>{emptyThreadStateLabel}</span>
                  {!emptyThreadStateLabel.includes("archived") && (
                    <button
                      type="button"
                      className="ml-auto inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground/80 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void handleNewThread(project.id, {
                          envMode: resolveSidebarNewThreadEnvMode({
                            defaultEnvMode: appSettings.defaultThreadEnvMode,
                          }),
                        });
                      }}
                    >
                      <NewThreadIcon className="size-3" />
                      New
                    </button>
                  )}
                </div>
              </SidebarMenuSubItem>
            ) : null}
            {animatedThreadIds.map((threadId) => (
              <AnimatedExpandPanel
                key={threadId}
                open={
                  project.expanded ||
                  pinnedCollapsedThreadId === null ||
                  pinnedCollapsedThreadId === threadId
                }
                fade
                animateOnMount={false}
                unmountOnExit={false}
                className="w-full"
                contentClassName="min-h-0"
              >
                {renderProjectThreadRow(threadId)}
              </AnimatedExpandPanel>
            ))}

            {project.expanded && hasHiddenThreads && !isThreadListExpanded && (
              <SidebarMenuSubItem className="w-full">
                <span
                  data-thread-selection-safe
                  className="flex h-6 w-full cursor-pointer items-center pl-7 text-xs text-muted-foreground/60 hover:text-sidebar-foreground"
                  onClick={() => {
                    expandThreadListForProject(project.id);
                  }}
                >
                  Show more
                </span>
              </SidebarMenuSubItem>
            )}
            {project.expanded && hasHiddenThreads && isThreadListExpanded && (
              <SidebarMenuSubItem className="w-full">
                <span
                  data-thread-selection-safe
                  className="flex h-6 w-full cursor-pointer items-center pl-7 text-xs text-muted-foreground/60 hover:text-sidebar-foreground"
                  onClick={() => {
                    collapseThreadListForProject(project.id);
                  }}
                >
                  Show less
                </span>
              </SidebarMenuSubItem>
            )}
          </SidebarMenuSub>
        </AnimatedExpandPanel>
      </>
    );
  }

  function renderThreadRows(threadIds: readonly ThreadId[], orderedThreadIds: readonly ThreadId[]) {
    return threadIds.map((threadId) => (
      <SidebarThreadRow
        key={threadId}
        threadId={threadId}
        orderedProjectThreadIds={orderedThreadIds}
        threadWorkspacePath={resolveThreadWorkspacePath(threadId)}
        routeThreadId={routeThreadId}
        isSelected={selectedThreadIds.has(threadId)}
        hasSelection={selectedThreadIds.size > 0}
        showThreadJumpHints={showThreadJumpHints}
        jumpLabel={threadJumpLabelById.get(threadId) ?? null}
        renamingThreadId={renamingThreadId}
        renamingTitle={renamingTitle}
        setRenamingTitle={setRenamingTitle}
        renamingInputRef={renamingInputRef}
        renamingCommittedRef={renamingCommittedRef}
        handleThreadClick={handleThreadClick}
        handleThreadDragStart={handleThreadDragStart}
        navigateToThread={navigateToThread}
        clearSelection={clearSelection}
        commitRename={commitRename}
        cancelRename={cancelRename}
        attemptArchiveThread={attemptArchiveThread}
        isPinned={sidebarThreadsById[threadId]?.pinnedAt != null}
        onSetPinned={setThreadPinned}
        openPrLink={openPrLink}
        pr={prByThreadId.get(threadId) ?? null}
        setRenamingThreadId={setRenamingThreadId}
        onBranchThread={handleBranchThread}
        onMarkThreadUnread={handleMarkThreadUnread}
        onOpenThreadBeside={openThreadBeside}
        onCopyPath={handleCopyPath}
        onCopyThreadId={handleCopyThreadId}
      />
    ));
  }

  function renderPinnedThreadsSection() {
    if (orderedPinnedThreadIds.length === 0) {
      return null;
    }

    const isCollapsed = collapsedSidebarSections.has("pinned");
    return (
      <div className="min-w-0">
        <SidebarSectionHeader
          collapsed={isCollapsed}
          onToggle={() => toggleSidebarSection("pinned")}
        >
          Pinned
        </SidebarSectionHeader>
        <AnimatedExpandPanel open={!isCollapsed} fade className="w-full">
          <SidebarMenu className="gap-0.5">
            {renderThreadRows(orderedPinnedThreadIds, orderedPinnedThreadIds)}
          </SidebarMenu>
        </AnimatedExpandPanel>
      </div>
    );
  }

  function renderChatsSection() {
    const isCollapsed = collapsedSidebarSections.has("chats");
    return (
      <div className="group/chats-section min-w-0">
        <div className="relative">
          <SidebarSectionHeader
            collapsed={isCollapsed}
            onToggle={() => toggleSidebarSection("chats")}
          >
            Chats
          </SidebarSectionHeader>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="New chat"
                  data-testid="new-chat-button"
                  className="absolute top-0 right-1 inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 opacity-0 hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring group-hover/chats-section:opacity-100"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void createProjectlessChat();
                  }}
                >
                  <NewThreadIcon className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup side="top">New chat</TooltipPopup>
          </Tooltip>
        </div>
        <AnimatedExpandPanel open={!isCollapsed} fade className="w-full">
          {renderedChatThreadIds.length === 0 ? (
            <SidebarSectionEmptyState>No chats yet</SidebarSectionEmptyState>
          ) : (
            <SidebarMenu className="gap-0.5">
              {renderThreadRows(renderedChatThreadIds, orderedChatThreadIds)}
            </SidebarMenu>
          )}
        </AnimatedExpandPanel>
      </div>
    );
  }

  function renderProjectSection(
    label: "Projects",
    projectsToRender: typeof renderedProjects,
    emptyLabel: string,
  ) {
    const isCollapsed = collapsedSidebarSections.has("projects");
    return (
      <div className="min-w-0">
        <SidebarSectionHeader
          collapsed={isCollapsed}
          onToggle={() => toggleSidebarSection("projects")}
        >
          {label}
        </SidebarSectionHeader>
        <AnimatedExpandPanel open={!isCollapsed} fade className="w-full">
          {projectsToRender.length === 0 ? (
            <SidebarSectionEmptyState>{emptyLabel}</SidebarSectionEmptyState>
          ) : (
            <SidebarMenu className="gap-0.5">
              {projectsToRender.map((renderedProject) => (
                <SortableProjectItem
                  key={renderedProject.project.id}
                  projectId={renderedProject.project.id}
                >
                  {(dragHandleProps) => renderProjectItem(renderedProject, dragHandleProps)}
                </SortableProjectItem>
              ))}
            </SidebarMenu>
          )}
        </AnimatedExpandPanel>
      </div>
    );
  }

  const handleProjectTitleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (suppressProjectClickForContextMenuRef.current) {
        suppressProjectClickForContextMenuRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        // Consume the synthetic click emitted after a drag release.
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      toggleProject(projectId);
    },
    [clearSelection, selectedThreadIds.size, toggleProject],
  );

  const handleProjectTitleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      toggleProject(projectId);
    },
    [toggleProject],
  );

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (selectedThreadIds.size === 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection, selectedThreadIds.size]);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const newThreadShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "chat.new",
    sidebarShortcutLabelOptions,
  );
  const pullRequestsShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "pullRequests.open",
    sidebarShortcutLabelOptions,
  );
  const goalsShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "goals.open",
    sidebarShortcutLabelOptions,
  );
  const projectListTopSpacingClassName = shouldShowProjectPathEntry ? "" : "mt-2";

  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: "Update downloaded",
              description: "Restart the app from the update button to install it.",
            });
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(desktopUpdateState),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
    }
  }, [desktopUpdateButtonAction, desktopUpdateButtonDisabled, desktopUpdateState]);

  const expandThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (current.has(projectId)) return current;
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  }, []);

  return (
    <>
      <SidebarBrandHeader />
      <SidebarContent className="gap-0">
        <SidebarGroup className="px-2 pt-1 pb-0">
          <SidebarMenu className="gap-0.5">
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<button type="button" />}
                size="sm"
                data-testid="new-thread-button"
                className="h-7 gap-2 rounded-lg px-2 text-foreground"
                aria-disabled={defaultProjectId === null || undefined}
                onClick={() => {
                  const projectId =
                    activeThread?.projectId ?? activeDraftThread?.projectId ?? defaultProjectId;
                  if (!projectId) return;
                  void handleNewThread(projectId, {
                    envMode:
                      activeDraftThread?.envMode ??
                      (activeThread?.worktreePath ? "worktree" : "local"),
                  });
                }}
              >
                <NewThreadIcon className="size-4 shrink-0" aria-hidden />
                <span className={SIDEBAR_ROW_LABEL_CLASS}>New Thread</span>
                {newThreadShortcutLabel ? (
                  <span className={SIDEBAR_ROW_META_CLASS}>{newThreadShortcutLabel}</span>
                ) : null}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<button type="button" />}
                size="sm"
                data-testid="search-button"
                className="h-7 gap-2 rounded-lg px-2 text-foreground"
                onClick={() => {
                  props.onSearchClick?.();
                }}
              >
                <SearchIcon className="size-4 shrink-0" aria-hidden />
                <span className={SIDEBAR_ROW_LABEL_CLASS}>Search</span>
                {searchShortcutLabel ? (
                  <span className={SIDEBAR_ROW_META_CLASS}>{searchShortcutLabel}</span>
                ) : null}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link to="/pull-requests" />}
                size="sm"
                isActive={pathname === "/pull-requests"}
                data-testid="pull-requests-button"
                className="h-7 gap-2 rounded-lg px-2 text-foreground"
              >
                <GitPullRequestIcon className="size-4 shrink-0" aria-hidden />
                <span className={SIDEBAR_ROW_LABEL_CLASS}>Pull Requests</span>
                {pullRequestsShortcutLabel ? (
                  <span className={SIDEBAR_ROW_META_CLASS}>{pullRequestsShortcutLabel}</span>
                ) : null}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link to="/automations" />}
                size="sm"
                isActive={pathname === "/automations"}
                data-testid="automations-button"
                className="h-7 gap-2 rounded-lg px-2 text-foreground"
              >
                <AutomationsIcon className="size-4 shrink-0" aria-hidden />
                <span className={SIDEBAR_ROW_LABEL_CLASS}>Automations</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {goalsEnabled ? (
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link to="/goals" />}
                  size="sm"
                  isActive={pathname === "/goals"}
                  data-testid="goals-button"
                  className="h-7 gap-2 rounded-lg px-2 text-foreground"
                >
                  <GoalsIcon className="size-4 shrink-0" aria-hidden />
                  <span className={SIDEBAR_ROW_LABEL_CLASS}>Goals</span>
                  {goalsShortcutLabel ? (
                    <span className={SIDEBAR_ROW_META_CLASS}>{goalsShortcutLabel}</span>
                  ) : null}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
        </SidebarGroup>
        {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
          <SidebarGroup className="px-2 pt-2 pb-0">
            <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
              <TriangleAlertIcon />
              <AlertTitle>Intel build on Apple Silicon</AlertTitle>
              <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
              {desktopUpdateButtonAction !== "none" ? (
                <AlertAction>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={desktopUpdateButtonDisabled}
                    onClick={handleDesktopUpdateButtonClick}
                  >
                    {desktopUpdateButtonAction === "download"
                      ? "Download ARM build"
                      : "Install ARM build"}
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          </SidebarGroup>
        ) : null}
        <SidebarGroup className="px-2 py-2">
          {shouldShowProjectPathEntry && (
            <div className="mb-2 px-1">
              {isElectron && (
                <button
                  type="button"
                  className={cn(
                    "mb-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-border bg-secondary py-1.5 text-sm text-foreground/80 disabled:cursor-not-allowed disabled:opacity-60",
                    SIDEBAR_HOVER_SURFACE_CLASS,
                  )}
                  onClick={() => void handlePickFolder()}
                  disabled={isPickingFolder || isAddingProject}
                >
                  <FolderIcon className="size-3.5" />
                  {isPickingFolder ? "Picking folder..." : "Browse for folder"}
                </button>
              )}
              <div className="flex gap-1.5">
                <input
                  ref={addProjectInputRef}
                  className={`min-w-0 flex-1 rounded-md border bg-secondary px-2 py-1 font-mono text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none ${
                    addProjectError
                      ? "border-red-500/70 focus:border-red-500"
                      : "border-border focus:border-ring"
                  }`}
                  placeholder="/path/to/project"
                  value={newCwd}
                  onChange={(event) => {
                    setNewCwd(event.target.value);
                    setAddProjectError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleAddProject();
                    if (event.key === "Escape") {
                      setAddingProject(false);
                      setAddProjectError(null);
                    }
                  }}
                  autoFocus
                />
                <button
                  type="button"
                  className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                  onClick={handleAddProject}
                  disabled={!canAddProject}
                >
                  {isAddingProject ? "Adding..." : "Add"}
                </button>
              </div>
              {addProjectError && (
                <p className="mt-1 px-0.5 text-sm leading-tight text-red-400">{addProjectError}</p>
              )}
            </div>
          )}

          {!bootstrapComplete ? (
            <SidebarLoadingSkeleton className={projectListTopSpacingClassName} />
          ) : (
            <div className={cn("flex flex-col gap-3", projectListTopSpacingClassName)}>
              {renderPinnedThreadsSection()}
              {renderChatsSection()}
              <DndContext
                sensors={projectDnDSensors}
                collisionDetection={projectCollisionDetection}
                modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
                onDragStart={handleProjectDragStart}
                onDragEnd={handleProjectDragEnd}
                onDragCancel={handleProjectDragCancel}
              >
                <SortableContext
                  items={renderedProjects.map((renderedProject) => renderedProject.project.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {renderProjectSection("Projects", renderedProjects, "No projects yet")}
                </SortableContext>
              </DndContext>
            </div>
          )}
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="mt-auto p-2">
        <SidebarUpdatePill />
        <SidebarUserFooter
          onSettingsClick={() => void navigate({ to: "/settings/general" })}
          sortMenu={
            <ProjectSortMenu
              projectSortOrder={appSettings.sidebarProjectSortOrder}
              threadSortOrder={appSettings.sidebarThreadSortOrder}
              onProjectSortOrderChange={(sortOrder) => {
                updateSettings({ sidebarProjectSortOrder: sortOrder });
              }}
              onThreadSortOrderChange={(sortOrder) => {
                updateSettings({ sidebarThreadSortOrder: sortOrder });
              }}
            />
          }
        />
      </SidebarFooter>
    </>
  );
}

export default function Sidebar(props: { onSearchClick?: () => void }) {
  const pathname = useLocation({ select: (loc) => loc.pathname });
  return pathname.startsWith("/settings") ? (
    <SettingsSidebarContent pathname={pathname} />
  ) : (
    <ThreadSidebarContent {...props} />
  );
}
