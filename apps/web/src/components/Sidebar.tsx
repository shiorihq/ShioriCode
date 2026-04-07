import {
  ArchiveIcon,
  ArrowUpDownIcon,
  ChevronDownIcon,
  FolderIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  NavigationIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { autoAnimate } from "@formkit/auto-animate";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
  type ReactNode,
} from "react";
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
import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { type SidebarProjectSortOrder, type SidebarThreadSortOrder } from "contracts/settings";
import { isElectron } from "../env";
import { useHostedShioriState } from "../convex/HostedShioriProvider";
import { APP_STAGE_LABEL, APP_VERSION } from "../branding";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isLinuxPlatform, isMacPlatform, newCommandId, newProjectId } from "../lib/utils";
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

import { useThreadActions } from "../hooks/useThreadActions";
import { toastManager } from "./ui/toast";
import { formatRelativeTimeLabel } from "../timestampFormat";
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
import { Button } from "./ui/button";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenuAction,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarMenuSkeleton,
  SidebarSeparator,
  SidebarTrigger,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { isNonEmpty as isNonEmptyString } from "effect/String";
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
  resolveThreadRowClassName,
  orderItemsByPreferredIds,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
  useThreadJumpHintVisibility,
} from "./Sidebar.logic";
import { SidebarUpdatePill } from "./sidebar/SidebarUpdatePill";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "../rpc/serverState";
import { useSidebarThreadSummaryById } from "../storeSelectors";
import type { Project } from "../types";
const THREAD_PREVIEW_LIMIT = 6;
const SIDEBAR_SORT_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};
const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
};
const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;

type SidebarProjectSnapshot = Project & {
  expanded: boolean;
};
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

/** Thread running: loader 6 (× / +), 700ms. Text in DOM; CSS `content` keyframes are unreliable in WebKit. */
const SIDEBAR_THREAD_ASCII_LOADER_6_FRAME_MS = 350;

function SidebarThreadAsciiLoader6() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      setFrame((value) => (value + 1) % 2);
    }, SIDEBAR_THREAD_ASCII_LOADER_6_FRAME_MS);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span
      role="img"
      aria-label="Response in progress"
      className="inline-flex size-3 shrink-0 items-center justify-center font-mono text-[10px] leading-none text-current opacity-70"
    >
      {frame === 0 ? "\u00d7" : "+"}
    </span>
  );
}

interface SidebarThreadRowProps {
  threadId: ThreadId;
  orderedProjectThreadIds: readonly ThreadId[];
  routeThreadId: ThreadId | null;
  selectedThreadIds: ReadonlySet<ThreadId>;
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
  navigateToThread: (threadId: ThreadId) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadId: ThreadId,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (threadId: ThreadId, newTitle: string, originalTitle: string) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadId: ThreadId) => Promise<void>;
  openPrLink: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  pr: ThreadPr | null;
}

function SidebarThreadRow(props: SidebarThreadRowProps) {
  const thread = useSidebarThreadSummaryById(props.threadId);
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadId, props.threadId).runningTerminalIds,
  );

  if (!thread) {
    return null;
  }

  const isActive = props.routeThreadId === thread.id;
  const isSelected = props.selectedThreadIds.has(thread.id);
  const isHighlighted = isActive || isSelected;
  const isThreadRunning =
    thread.session?.status === "running" && thread.session.activeTurnId != null;
  const prStatus = prStatusIndicator(props.pr);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const threadMetaClassName = !isThreadRunning
    ? "pointer-events-none transition-opacity duration-150 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0"
    : "pointer-events-none";

  return (
    <SidebarMenuSubItem className="w-full" data-thread-item>
      <SidebarMenuSubButton
        render={<div role="button" tabIndex={0} />}
        size="sm"
        isActive={isActive}
        data-testid={`thread-row-${thread.id}`}
        className={`${resolveThreadRowClassName({
          isActive,
          isSelected,
        })} relative isolate text-[13px]`}
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
          if (props.selectedThreadIds.size > 0 && props.selectedThreadIds.has(thread.id)) {
            void props.handleMultiSelectContextMenu({
              x: event.clientX,
              y: event.clientY,
            });
          } else {
            if (props.selectedThreadIds.size > 0) {
              props.clearSelection();
            }
            void props.handleThreadContextMenu(thread.id, {
              x: event.clientX,
              y: event.clientY,
            });
          }
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <span className="mr-2 inline-flex shrink-0 items-center justify-center pl-1">
            {isThreadRunning ? (
              <SidebarThreadAsciiLoader6 />
            ) : (
              <span className="size-1.5 rounded-full bg-current opacity-50" aria-hidden />
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
              className="min-w-0 flex-1 truncate text-[13px] bg-transparent outline-none border border-ring rounded px-0.5"
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
              className={`min-w-0 flex-1 truncate ${isThreadRunning ? "shimmer shimmer-spread-200" : ""}`}
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
          <div className="flex min-w-12 justify-end">
            {!isThreadRunning ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <div className="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                      <button
                        type="button"
                        data-thread-selection-safe
                        data-testid={`thread-archive-${thread.id}`}
                        aria-label={`Archive ${thread.title}`}
                        className="inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                        onPointerDown={(event) => {
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void props.attemptArchiveThread(thread.id);
                        }}
                      >
                        <ArchiveIcon className="size-3.5" />
                      </button>
                    </div>
                  }
                />
                <TooltipPopup side="top">Archive</TooltipPopup>
              </Tooltip>
            ) : null}
            <span className={threadMetaClassName}>
              {props.showThreadJumpHints && props.jumpLabel ? (
                <span
                  className="inline-flex h-5 items-center rounded-full border border-border/80 bg-background/90 px-1.5 font-mono text-[10px] font-medium tracking-tight text-foreground shadow-sm"
                  title={props.jumpLabel}
                >
                  {props.jumpLabel}
                </span>
              ) : (
                <span
                  className={`text-[10px] ${
                    isHighlighted
                      ? "text-foreground/72 dark:text-foreground/82"
                      : "text-muted-foreground/40"
                  }`}
                >
                  {formatRelativeTimeLabel(
                    thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
                  )}
                </span>
              )}
            </span>
          </div>
        </div>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

function ShioriWordmark() {
  return (
    <span className="flex items-baseline gap-0.5 shrink-0">
      <span className="font-sans text-sm font-normal tracking-tight text-foreground">Shiori</span>
      <span className="font-mono text-[13px] font-medium italic text-primary">Code</span>
    </span>
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
            <MenuTrigger className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground" />
          }
        >
          <ArrowUpDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">Sort projects</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-44">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">
            Sort projects
          </div>
          <MenuRadioGroup
            value={projectSortOrder}
            onValueChange={(value) => {
              onProjectSortOrderChange(value as SidebarProjectSortOrder);
            }}
          >
            {(Object.entries(SIDEBAR_SORT_LABELS) as Array<[SidebarProjectSortOrder, string]>).map(
              ([value, label]) => (
                <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                  {label}
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 sm:text-xs font-medium text-muted-foreground">
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
              <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
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
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

function UserAvatar(props: { src: string | null | undefined; name: string | null | undefined }) {
  const initials = (props.name ?? "?").charAt(0).toUpperCase();

  return props.src ? (
    <img
      src={props.src}
      alt=""
      className="size-6 shrink-0 rounded-lg object-cover"
      referrerPolicy="no-referrer"
    />
  ) : (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-muted text-[10px] font-medium text-muted-foreground">
      {initials}
    </span>
  );
}

function SidebarUserFooter(props: { onSettingsClick: () => void; sortMenu?: ReactNode }) {
  const { isAuthenticated, viewer, subscriptionPlanLabel } = useHostedShioriState();

  if (!isAuthenticated || !viewer) {
    return (
      <div className="flex items-center gap-1">
        {props.sortMenu}
        <SidebarMenu className="flex-1">
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              tooltip="Settings"
              className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
              onClick={props.onSettingsClick}
            >
              <SettingsIcon className="size-3.5" />
              <span className="text-xs">Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </div>
    );
  }

  const displayName = viewer.name ?? viewer.email ?? "User";

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        onClick={props.onSettingsClick}
      >
        <span className="mt-0.5 shrink-0">
          <UserAvatar src={viewer.image} name={viewer.name} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 group-data-[collapsible=icon]:hidden">
          <span className="block truncate text-xs font-medium text-foreground">{displayName}</span>
          {subscriptionPlanLabel ? (
            <span className="block truncate text-[10px] leading-tight text-muted-foreground">
              {subscriptionPlanLabel}
            </span>
          ) : null}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-0.5 group-data-[collapsible=icon]:hidden">
        {props.sortMenu}
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded-lg text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
          onClick={props.onSettingsClick}
        >
          <SettingsIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

export default function Sidebar() {
  const projects = useStore((store) => store.projects);
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const sidebarThreadsById = useStore((store) => store.sidebarThreadsById);
  const threadIdsByProjectId = useStore((store) => store.threadIdsByProjectId);
  const { projectExpandedById, projectOrder } = useUiStateStore(
    useShallow((store) => ({
      projectExpandedById: store.projectExpandedById,
      projectOrder: store.projectOrder,
    })),
  );
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
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const isOnSettings = pathname.startsWith("/settings");
  const appSettings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const { activeDraftThread, activeThread, defaultProjectId, handleNewThread } =
    useHandleNewThread();
  const { archiveThread, branchThread, deleteThread } = useThreadActions();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
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
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const isLinuxDesktop = isElectron && isLinuxPlatform(navigator.platform);
  const platform = navigator.platform;
  const shouldBrowseForProjectImmediately = isElectron && !isLinuxDesktop;
  const shouldShowProjectPathEntry = addingProject && !shouldBrowseForProjectImmediately;
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
  const routeTerminalOpen = routeThreadId
    ? selectThreadTerminalState(terminalStateByThreadId, routeThreadId).terminalOpen
    : false;
  const sidebarShortcutLabelOptions = useMemo(
    () => ({
      platform,
      context: {
        terminalFocus: false,
        terminalOpen: routeTerminalOpen,
      },
    }),
    [platform, routeTerminalOpen],
  );
  const threadGitTargets = useMemo(
    () =>
      sidebarThreads.map((thread) => ({
        threadId: thread.id,
        branch: thread.branch,
        cwd: thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null,
      })),
    [projectCwdById, sidebarThreads],
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

  const focusMostRecentThreadForProject = useCallback(
    (projectId: ProjectId) => {
      const latestThread = sortThreadsForSidebar(
        (threadIdsByProjectId[projectId] ?? [])
          .map((threadId) => sidebarThreadsById[threadId])
          .filter((thread): thread is NonNullable<typeof thread> => thread !== undefined)
          .filter((thread) => thread.archivedAt === null),
        appSettings.sidebarThreadSortOrder,
      )[0];
      if (!latestThread) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [appSettings.sidebarThreadSortOrder, navigate, sidebarThreadsById, threadIdsByProjectId],
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
        focusMostRecentThreadForProject(existing.id);
        finishAddingProject();
        return;
      }

      const projectId = newProjectId();
      const createdAt = new Date().toISOString();
      const title = cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? cwd;
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
        }).catch(() => undefined);
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
      focusMostRecentThreadForProject,
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

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") return;

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-project") return;
      void handlePickFolderRef.current();
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

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
  const handleThreadContextMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = sidebarThreadsById[threadId];
      if (!thread) return;
      const threadWorkspacePath =
        thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null;
      const clicked = await api.contextMenu.show(
        [
          { id: "branch", label: "Branch thread" },
          { id: "rename", label: "Rename thread" },
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "branch") {
        try {
          await branchThread(threadId);
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Could not branch thread",
            description: error instanceof Error ? error.message : "An unknown error occurred.",
          });
        }
        return;
      }

      if (clicked === "rename") {
        setRenamingThreadId(threadId);
        setRenamingTitle(thread.title);
        renamingCommittedRef.current = false;
        return;
      }

      if (clicked === "mark-unread") {
        markThreadUnread(threadId, thread.latestTurn?.completedAt);
        return;
      }
      if (clicked === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add({
            type: "error",
            title: "Path unavailable",
            description: "This thread does not have a workspace path to copy.",
          });
          return;
        }
        copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(threadId, { threadId });
        return;
      }
      if (clicked !== "delete") return;
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
    [
      appSettings.confirmThreadDelete,
      branchThread,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      markThreadUnread,
      projectCwdById,
      sidebarThreadsById,
    ],
  );

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const ids = [...selectedThreadIds];
      if (ids.length === 0) return;
      const count = ids.length;

      const clicked = await api.contextMenu.show(
        [
          { id: "mark-unread", label: `Mark unread (${count})` },
          { id: "delete", label: `Delete (${count})`, destructive: true },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const id of ids) {
          const thread = sidebarThreadsById[id];
          markThreadUnread(id, thread?.latestTurn?.completedAt);
        }
        clearSelection();
        return;
      }

      if (clicked !== "delete") return;

      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} thread${count === 1 ? "" : "s"}?`,
            "This permanently clears conversation history for these threads.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }

      const deletedIds = new Set<ThreadId>(ids);
      for (const id of ids) {
        await deleteThread(id, { deletedThreadIds: deletedIds });
      }
      removeFromSelection(ids);
    },
    [
      appSettings.confirmThreadDelete,
      clearSelection,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
      selectedThreadIds,
      sidebarThreadsById,
    ],
  );

  const handleThreadClick = useCallback(
    (event: MouseEvent, threadId: ThreadId, orderedProjectThreadIds: readonly ThreadId[]) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;

      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadId);
        return;
      }

      if (isShiftClick) {
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

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        dragInProgressRef.current = false;
        return;
      }
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeProject = sidebarProjects.find((project) => project.id === active.id);
      const overProject = sidebarProjects.find((project) => project.id === over.id);
      if (!activeProject || !overProject) return;
      reorderProjects(activeProject.id, overProject.id);
    },
    [appSettings.sidebarProjectSortOrder, reorderProjects, sidebarProjects],
  );

  const handleProjectDragStart = useCallback(
    (_event: DragStartEvent) => {
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        return;
      }
      dragInProgressRef.current = true;
      suppressProjectClickAfterDragRef.current = true;
    },
    [appSettings.sidebarProjectSortOrder],
  );

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);

  const animatedProjectListsRef = useRef(new WeakSet<HTMLElement>());
  const attachProjectListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedProjectListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedProjectListsRef.current.add(node);
  }, []);

  const animatedThreadListsRef = useRef(new WeakSet<HTMLElement>());
  const attachThreadListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedThreadListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedThreadListsRef.current.add(node);
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

  const visibleThreads = useMemo(
    () => sidebarThreads.filter((thread) => thread.archivedAt === null),
    [sidebarThreads],
  );
  const sortedProjects = useMemo(
    () =>
      sortProjectsForSidebar(sidebarProjects, visibleThreads, appSettings.sidebarProjectSortOrder),
    [appSettings.sidebarProjectSortOrder, sidebarProjects, visibleThreads],
  );
  const isManualProjectSorting = appSettings.sidebarProjectSortOrder === "manual";
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
            .filter((thread) => thread.archivedAt === null),
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
        const showEmptyThreadState = project.expanded && projectThreads.length === 0;
        const emptyThreadStateLabel =
          archivedThreadCount > 0
            ? getArchivedOnlyProjectEmptyStateLabel(archivedThreadCount)
            : "No threads yet";

        return {
          emptyThreadStateLabel,
          hasHiddenThreads,
          orderedProjectThreadIds,
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
  const visibleSidebarThreadIds = useMemo(
    () => getVisibleSidebarThreadIds(renderedProjects),
    [renderedProjects],
  );
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
      hasHiddenThreads,
      orderedProjectThreadIds,
      emptyThreadStateLabel,
      project,
      renderedThreadIds,
      showEmptyThreadState,
      shouldShowThreadPanel,
      isThreadListExpanded,
    } = renderedProject;
    return (
      <>
        <div className="group/project-header relative">
          <SidebarMenuButton
            ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
            size="sm"
            className={`group/project-name gap-2 px-2 py-1.5 text-left hover:bg-transparent ${
              isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
            }`}
            {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.attributes : {})}
            {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.listeners : {})}
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
            <span className="min-w-0 shrink truncate text-sm text-muted-foreground">
              {project.name}
            </span>
            <ChevronDownIcon
              aria-hidden
              className="pointer-events-none size-3.5 shrink-0 text-muted-foreground/50 opacity-0 group-hover/project-name:opacity-100 group-focus-visible/project-name:opacity-100"
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
                  className="top-1 right-1.5 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
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
                  <SquarePenIcon className="size-3.5" />
                </SidebarMenuAction>
              }
            />
            <TooltipPopup side="top">
              {newThreadShortcutLabel ? `New Thread (${newThreadShortcutLabel})` : "New Thread"}
            </TooltipPopup>
          </Tooltip>
        </div>

        <SidebarMenuSub
          ref={attachThreadListAutoAnimateRef}
          className="mx-0 my-0 w-full translate-x-0 gap-0.5 overflow-hidden border-l-0 px-0 py-0"
        >
          {shouldShowThreadPanel && showEmptyThreadState ? (
            <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
              <div
                data-thread-selection-safe
                className="flex h-6 w-full translate-x-0 items-center px-2 text-left text-[10px] text-muted-foreground/60"
              >
                <span>{emptyThreadStateLabel}</span>
              </div>
            </SidebarMenuSubItem>
          ) : null}
          {shouldShowThreadPanel &&
            renderedThreadIds.map((threadId) => (
              <SidebarThreadRow
                key={threadId}
                threadId={threadId}
                orderedProjectThreadIds={orderedProjectThreadIds}
                routeThreadId={routeThreadId}
                selectedThreadIds={selectedThreadIds}
                showThreadJumpHints={showThreadJumpHints}
                jumpLabel={threadJumpLabelById.get(threadId) ?? null}
                renamingThreadId={renamingThreadId}
                renamingTitle={renamingTitle}
                setRenamingTitle={setRenamingTitle}
                renamingInputRef={renamingInputRef}
                renamingCommittedRef={renamingCommittedRef}
                handleThreadClick={handleThreadClick}
                navigateToThread={navigateToThread}
                handleMultiSelectContextMenu={handleMultiSelectContextMenu}
                handleThreadContextMenu={handleThreadContextMenu}
                clearSelection={clearSelection}
                commitRename={commitRename}
                cancelRename={cancelRename}
                attemptArchiveThread={attemptArchiveThread}
                openPrLink={openPrLink}
                pr={prByThreadId.get(threadId) ?? null}
              />
            ))}

          {project.expanded && hasHiddenThreads && !isThreadListExpanded && (
            <SidebarMenuSubItem className="w-full">
              <SidebarMenuSubButton
                render={<div role="button" tabIndex={0} />}
                data-thread-selection-safe
                size="sm"
                className="h-6 w-full translate-x-0 justify-start px-2 text-left text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                onClick={() => {
                  expandThreadListForProject(project.id);
                }}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span>Show more</span>
                </span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          )}
          {project.expanded && hasHiddenThreads && isThreadListExpanded && (
            <SidebarMenuSubItem className="w-full">
              <SidebarMenuSubButton
                render={<div role="button" tabIndex={0} />}
                data-thread-selection-safe
                size="sm"
                className="h-6 w-full translate-x-0 justify-start px-2 text-left text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                onClick={() => {
                  collapseThreadListForProject(project.id);
                }}
              >
                <span>Show less</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          )}
        </SidebarMenuSub>
      </>
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
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal", sidebarShortcutLabelOptions) ??
    shortcutLabelForCommand(keybindings, "chat.new", sidebarShortcutLabelOptions);

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

  const wordmark = (
    <div className="flex items-center gap-2">
      <SidebarTrigger className="shrink-0 md:hidden" />
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              aria-label="Go to threads"
              className="ml-1 flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md outline-hidden ring-ring transition-colors hover:text-foreground focus-visible:ring-2"
              to="/"
            >
              <ShioriWordmark />
              {APP_STAGE_LABEL ? (
                <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
                  {APP_STAGE_LABEL}
                </span>
              ) : null}
            </Link>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
  const macWindowControlsInset = useDesktopWindowControlsInset();

  return (
    <>
      {isElectron ? (
        <SidebarHeader
          className="drag-region h-[52px] flex-row items-center gap-2 px-4 py-0"
          style={{ paddingLeft: `${Math.max(16, macWindowControlsInset)}px` }}
        >
          {wordmark}
        </SidebarHeader>
      ) : (
        <SidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3">
          {wordmark}
        </SidebarHeader>
      )}

      {isOnSettings ? (
        <SettingsSidebarNav pathname={pathname} />
      ) : (
        <>
          <SidebarContent className="gap-0">
            <SidebarGroup className="px-2 pt-1 pb-0">
              <SidebarMenu className="gap-0.5">
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={<button type="button" />}
                    size="sm"
                    data-testid="new-thread-button"
                    className="h-9 gap-3 rounded-lg bg-sidebar-accent/50 px-3 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
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
                    <NavigationIcon className="size-4 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">New Thread</span>
                    {newThreadShortcutLabel ? (
                      <span className="ml-auto text-xs text-muted-foreground/50">
                        {newThreadShortcutLabel}
                      </span>
                    ) : null}
                  </SidebarMenuButton>
                </SidebarMenuItem>
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
                      className="mb-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-border bg-secondary py-1.5 text-xs text-foreground/80 transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
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
                      className={`min-w-0 flex-1 rounded-md border bg-secondary px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none ${
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
                      className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
                      onClick={handleAddProject}
                      disabled={!canAddProject}
                    >
                      {isAddingProject ? "Adding..." : "Add"}
                    </button>
                  </div>
                  {addProjectError && (
                    <p className="mt-1 px-0.5 text-[11px] leading-tight text-red-400">
                      {addProjectError}
                    </p>
                  )}
                </div>
              )}

              {!bootstrapComplete ? (
                <SidebarMenu>
                  {Array.from({ length: 3 }, (_, i) => (
                    <SidebarMenuItem key={i}>
                      <SidebarMenuSkeleton showIcon />
                      <SidebarMenuSub className="mx-0 my-0 w-full translate-x-0 gap-0.5 overflow-hidden border-l-0 px-0 py-0">
                        <SidebarMenuSkeleton />
                        <SidebarMenuSkeleton />
                      </SidebarMenuSub>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              ) : isManualProjectSorting ? (
                <DndContext
                  sensors={projectDnDSensors}
                  collisionDetection={projectCollisionDetection}
                  modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
                  onDragStart={handleProjectDragStart}
                  onDragEnd={handleProjectDragEnd}
                  onDragCancel={handleProjectDragCancel}
                >
                  <SidebarMenu>
                    <SortableContext
                      items={renderedProjects.map((renderedProject) => renderedProject.project.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {renderedProjects.map((renderedProject) => (
                        <SortableProjectItem
                          key={renderedProject.project.id}
                          projectId={renderedProject.project.id}
                        >
                          {(dragHandleProps) => renderProjectItem(renderedProject, dragHandleProps)}
                        </SortableProjectItem>
                      ))}
                    </SortableContext>
                  </SidebarMenu>
                </DndContext>
              ) : (
                <SidebarMenu ref={attachProjectListAutoAnimateRef}>
                  {renderedProjects.map((renderedProject) => (
                    <SidebarMenuItem key={renderedProject.project.id} className="rounded-md">
                      {renderProjectItem(renderedProject, null)}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              )}

              {bootstrapComplete && projects.length === 0 && !shouldShowProjectPathEntry && (
                <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
                  No projects yet
                </div>
              )}
            </SidebarGroup>
          </SidebarContent>

          <SidebarSeparator />
          <SidebarFooter className="p-2">
            <SidebarUpdatePill />
            <SidebarUserFooter
              onSettingsClick={() => void navigate({ to: "/settings" })}
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
      )}
    </>
  );
}
