import { ThreadId } from "contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import {
  Suspense,
  lazy,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  IconBranchMergeOutline24 as DiffIcon,
  IconFileOutline24 as FileIcon,
  IconGlobeOutline24 as GlobeIcon,
  IconXmarkOutline24 as XIcon,
} from "nucleo-core-outline-24";

import BrowserPanel from "../components/browser/BrowserPanel";
import { ChatThreadPane } from "../components/ChatThreadPane";
import { DockedSidebarResizeHandle } from "../components/DockedSidebarResizeHandle";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../components/DiffPanelShell";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  type DiffRouteSearch,
  parseDiffRouteSearch,
  resolveActiveThreadPanel,
  type RightPanelId,
  stripRightSidebarSearchParams,
} from "../diffRouteSearch";
import type { PaneDropZone, PaneLayoutNode } from "../paneLayout/model";
import { SplitLayout } from "../paneLayout/SplitLayout";
import {
  closeThreadPane,
  dropThreadOnPane,
  encodeThreadPaneSearchValue,
  parseThreadPaneSearchValue,
  resolveThreadPaneLayout,
  threadPaneIds,
} from "../paneLayout/threadPanes";
import { useActiveThreadLeases } from "../hooks/useActiveThreadLease";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useBrowserUseFeatureEnabled } from "../featureFlags";
import { isSessionActivelyRunningTurn } from "../session-logic";
import { useStore } from "../store";
import { Sheet, SheetPopup } from "../components/ui/sheet";
import { Button } from "../components/ui/button";
import { SidebarInset } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const ArtifactPanel = lazy(() => import("../components/ArtifactPanel"));
const THREAD_PANE_MIN_SIZE_PX = 320;
const DIFF_DOCKED_LAYOUT_MEDIA_QUERY = "(max-width: 1180px)";
const DIFF_DOCKED_SIDEBAR_WIDTH_STORAGE_KEY = "chat_diff_sidebar_width";
const DIFF_DOCKED_SIDEBAR_MIN_WIDTH = 26 * 16;
const DIFF_DOCKED_SIDEBAR_DEFAULT_MIN_WIDTH = 28 * 16;
const DIFF_DOCKED_SIDEBAR_MAX_WIDTH = 44 * 16;
const DIFF_DOCKED_SIDEBAR_DEFAULT_RATIO = 0.48;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;
export const MISSING_THREAD_REDIRECT_GRACE_MS = 750;

export function shouldRedirectMissingThread(input: {
  bootstrapComplete: boolean;
  routeThreadExists: boolean;
  missingSinceMs: number | null;
  nowMs: number;
}): boolean {
  if (!input.bootstrapComplete || input.routeThreadExists || input.missingSinceMs === null) {
    return false;
  }

  return input.nowMs - input.missingSinceMs >= MISSING_THREAD_REDIRECT_GRACE_MS;
}

function clampDockedDiffWidth(width: number): number {
  return Math.max(DIFF_DOCKED_SIDEBAR_MIN_WIDTH, Math.min(width, DIFF_DOCKED_SIDEBAR_MAX_WIDTH));
}

function getDefaultDockedDiffWidth(): number {
  if (typeof window === "undefined") {
    return DIFF_DOCKED_SIDEBAR_DEFAULT_MIN_WIDTH;
  }

  return clampDockedDiffWidth(window.innerWidth * DIFF_DOCKED_SIDEBAR_DEFAULT_RATIO);
}

const SidePanelSheet = (props: {
  children: ReactNode;
  onClosePanel: () => void;
  open: boolean;
}) => {
  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClosePanel();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(92vw,920px)] max-w-[920px] p-0"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
};

const PanelLoadingFallback = (props: { label: string; mode: DiffPanelMode }) => {
  return (
    <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label={props.label} />
    </DiffPanelShell>
  );
};

const LazyDiffPanel = (props: { mode: DiffPanelMode; onClose?: () => void }) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<PanelLoadingFallback label="Loading the diff" mode={props.mode} />}>
        <DiffPanel mode={props.mode} onClose={props.onClose} />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

const LazyArtifactPanel = (props: {
  cwd: string | null;
  mode: DiffPanelMode;
  onClose?: (() => void) | undefined;
  relativePath: string | null;
}) => {
  return (
    <Suspense fallback={<PanelLoadingFallback label="Loading artifact" mode={props.mode} />}>
      <ArtifactPanel
        cwd={props.cwd}
        mode={props.mode}
        relativePath={props.relativePath}
        onClose={props.onClose}
      />
    </Suspense>
  );
};

interface RightSidebarTab {
  id: RightPanelId;
  label: string;
  icon: ReactNode;
}

function rightPanelLabel(panel: RightPanelId): string {
  switch (panel) {
    case "artifact":
      return "artifact";
    case "browser":
      return "browser";
    case "diff":
      return "diff";
  }
}

const RightSidebarFrame = (props: {
  activePanel: RightPanelId;
  children: ReactNode;
  onClosePanel: () => void;
  onSelectPanel: (panel: RightPanelId) => void;
  tabs: ReadonlyArray<RightSidebarTab>;
}) => {
  const handleClosePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    props.onClosePanel();
  };
  const handleCloseClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.detail === 0) {
      props.onClosePanel();
    }
  };

  return (
    <div className="isolate flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="drag-region relative z-20 flex h-11 shrink-0 items-center gap-1 border-b border-border bg-card px-2">
        <div className="no-drag flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {props.tabs.map((tab) => {
            const active = tab.id === props.activePanel;
            return (
              <Button
                key={tab.id}
                type="button"
                variant={active ? "secondary" : "ghost"}
                size="xs"
                aria-current={active ? "page" : undefined}
                className={cn(
                  "min-w-0 gap-1.5 px-2.5",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => props.onSelectPanel(tab.id)}
              >
                {tab.icon}
                <span className="truncate">{tab.label}</span>
              </Button>
            );
          })}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="no-drag shrink-0 text-muted-foreground hover:text-foreground"
          onPointerDown={handleClosePointerDown}
          onClick={handleCloseClick}
          aria-label={`Close ${rightPanelLabel(props.activePanel)} panel`}
          title={`Close ${rightPanelLabel(props.activePanel)} panel`}
        >
          <XIcon />
        </Button>
      </div>
      <div className="relative z-0 min-h-0 min-w-0 flex-1 overflow-hidden">{props.children}</div>
    </div>
  );
};

const RightSidebarTabPanel = (props: {
  active: boolean;
  children: ReactNode;
  panel: RightPanelId;
}) => {
  return (
    <div
      aria-hidden={props.active ? undefined : true}
      data-right-sidebar-panel={props.panel}
      className={cn(
        "absolute inset-0 min-h-0 min-w-0 overflow-hidden",
        props.active ? "visible" : "pointer-events-none invisible",
      )}
    >
      {props.children}
    </div>
  );
};

const SidePanelDockedSidebar = (props: {
  ariaLabel: string;
  children: ReactNode;
  open: boolean;
}) => {
  const { ariaLabel, children, open } = props;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const resizeStateRef = useRef<{
    pointerId: number;
    startWidth: number;
    startX: number;
  } | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const storedWidth = getLocalStorageItem(DIFF_DOCKED_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite);
    return storedWidth === null ? getDefaultDockedDiffWidth() : clampDockedDiffWidth(storedWidth);
  });

  const acceptDockedSidebarWidth = useCallback((nextWidth: number) => {
    const panel = panelRef.current;
    const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
    if (!panel || !composerForm) return true;

    const composerViewport = composerForm.parentElement;
    if (!composerViewport) return true;

    const previousWidth = panel.style.width;
    panel.style.width = `${nextWidth}px`;

    const viewportStyle = window.getComputedStyle(composerViewport);
    const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
    const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
    const viewportContentWidth = Math.max(
      0,
      composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
    );
    const formRect = composerForm.getBoundingClientRect();
    const composerFooter = composerForm.querySelector<HTMLElement>(
      "[data-chat-composer-footer='true']",
    );
    const composerRightActions = composerForm.querySelector<HTMLElement>(
      "[data-chat-composer-actions='right']",
    );
    const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
    const composerFooterGap = composerFooter
      ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
        Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
        0
      : 0;
    const minimumComposerWidth =
      COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
    const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
    const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
    const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

    if (previousWidth.length > 0) {
      panel.style.width = previousWidth;
    } else {
      panel.style.removeProperty("width");
    }

    return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
  }, []);

  const persistSidebarWidth = useCallback((nextWidth: number) => {
    const clampedWidth = clampDockedDiffWidth(nextWidth);
    setSidebarWidth(clampedWidth);
    setLocalStorageItem(DIFF_DOCKED_SIDEBAR_WIDTH_STORAGE_KEY, clampedWidth, Schema.Finite);
  }, []);

  const stopResize = useCallback(() => {
    resizeStateRef.current = null;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }, []);

  const handleResizeStart = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !panelRef.current) return;

    resizeStateRef.current = {
      pointerId: event.pointerId,
      startWidth: panelRef.current.getBoundingClientRect().width,
      startX: event.clientX,
    };

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const handleResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;

      const nextWidth = clampDockedDiffWidth(
        resizeState.startWidth + (resizeState.startX - event.clientX),
      );
      if (!acceptDockedSidebarWidth(nextWidth)) {
        return;
      }

      setSidebarWidth(nextWidth);
      event.preventDefault();
    },
    [acceptDockedSidebarWidth],
  );

  const handleResizeEnd = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;

      persistSidebarWidth(sidebarWidth);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      stopResize();
      event.preventDefault();
    },
    [persistSidebarWidth, sidebarWidth, stopResize],
  );

  useEffect(
    () => () => {
      stopResize();
    },
    [stopResize],
  );

  return open ? (
    <div
      ref={panelRef}
      className={cn(
        "relative hidden min-h-0 shrink-0 overflow-hidden border-l border-border bg-card text-foreground md:flex",
        "shadow-[-20px_0_40px_-36px_rgba(15,23,42,0.55)]",
      )}
      style={{ width: sidebarWidth }}
    >
      <DockedSidebarResizeHandle
        ariaLabel={ariaLabel}
        onPointerCancel={handleResizeEnd}
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
    </div>
  ) : null;
};

function ChatThreadRouteView() {
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const search = Route.useSearch();
  const routeThread = useStore(
    (store) => store.threads.find((thread) => thread.id === threadId) ?? null,
  );
  const routeProject = useStore((store) =>
    routeThread
      ? (store.projects.find((project) => project.id === routeThread.projectId) ?? null)
      : null,
  );
  const threadIndexById = useStore((store) => store.threadIndexById);
  const threadExists = useStore((store) => store.threads.some((thread) => thread.id === threadId));
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const draftThreadExists = Object.hasOwn(draftThreadsByThreadId, threadId);
  const routeThreadExists = threadExists || draftThreadExists;
  const shouldPrewarmSession = shouldPrewarmThreadSession(routeThread);
  const browserUseEnabled = useBrowserUseFeatureEnabled();
  const diffOpen = search.diff === "1";
  const artifactOpen = search.artifact === "1" && Boolean(search.artifactPath);
  const browserOpen = browserUseEnabled && search.browser === "1";
  const activeRightPanel = resolveActiveThreadPanel(search, { browserEnabled: browserUseEnabled });
  const sidePanelOpen = activeRightPanel !== null;
  const activeCwd = routeProject ? (routeThread?.worktreePath ?? routeProject.cwd) : null;
  const isAgentWorking = isSessionActivelyRunningTurn(
    routeThread?.latestTurn ?? null,
    routeThread?.session ?? null,
  );
  const shouldUseDiffSheet = useMediaQuery(DIFF_DOCKED_LAYOUT_MEDIA_QUERY);
  const missingThreadSinceRef = useRef<number | null>(null);
  const isThreadAvailable = useCallback(
    (paneThreadId: ThreadId) =>
      threadIndexById[paneThreadId] !== undefined ||
      Object.hasOwn(draftThreadsByThreadId, paneThreadId),
    [draftThreadsByThreadId, threadIndexById],
  );
  const paneLayout = useMemo(
    () =>
      routeThreadExists
        ? resolveThreadPaneLayout({
            focusedThreadId: threadId,
            layout: parseThreadPaneSearchValue(search.panes),
            isThreadAvailable,
          })
        : null,
    [isThreadAvailable, routeThreadExists, search.panes, threadId],
  );
  const visibleThreadIds = useMemo(() => threadPaneIds(paneLayout), [paneLayout]);
  const encodedVisiblePanes = encodeThreadPaneSearchValue(paneLayout);
  const multiPane = visibleThreadIds.length > 1;
  const [paneDropTarget, setPaneDropTarget] = useState<{
    threadId: ThreadId;
    zone: PaneDropZone;
  } | null>(null);
  const paneDropActive = paneDropTarget !== null;
  useActiveThreadLeases(visibleThreadIds);
  useEffect(() => {
    if (!paneDropActive) {
      return;
    }

    const resetThreadDropState = () => {
      setPaneDropTarget(null);
    };

    window.addEventListener("dragend", resetThreadDropState);
    window.addEventListener("drop", resetThreadDropState);
    return () => {
      window.removeEventListener("dragend", resetThreadDropState);
      window.removeEventListener("drop", resetThreadDropState);
    };
  }, [paneDropActive]);
  // TanStack Router keeps param-only route navigations mounted by default, so reset any
  // "missing thread" grace bookkeeping when the active thread id changes.
  useEffect(() => {
    missingThreadSinceRef.current = null;
  }, [threadId]);
  const [hasOpenedDiff, setHasOpenedDiff] = useState(diffOpen);
  const [hasOpenedArtifact, setHasOpenedArtifact] = useState(artifactOpen);
  const [hasOpenedBrowser, setHasOpenedBrowser] = useState(browserOpen);
  const closeSidePanel = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => stripRightSidebarSearchParams(previous),
    });
  }, [navigate, threadId]);
  useEffect(() => {
    if (diffOpen) {
      setHasOpenedDiff(true);
    }
  }, [diffOpen]);
  useEffect(() => {
    if (artifactOpen) {
      setHasOpenedArtifact(true);
    }
  }, [artifactOpen]);
  useEffect(() => {
    if (browserOpen) {
      setHasOpenedBrowser(true);
    }
  }, [browserOpen]);

  useEffect(() => {
    if (!bootstrapComplete) {
      return;
    }

    if (routeThreadExists) {
      missingThreadSinceRef.current = null;
      return;
    }

    const nowMs = Date.now();
    const missingSinceMs = missingThreadSinceRef.current ?? nowMs;
    missingThreadSinceRef.current = missingSinceMs;

    if (
      shouldRedirectMissingThread({
        bootstrapComplete,
        routeThreadExists,
        missingSinceMs,
        nowMs,
      })
    ) {
      void navigate({ to: "/", replace: true });
      return;
    }

    const timeoutMs = Math.max(0, MISSING_THREAD_REDIRECT_GRACE_MS - (nowMs - missingSinceMs));
    const timeoutId = window.setTimeout(() => {
      void navigate({ to: "/", replace: true });
    }, timeoutMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [bootstrapComplete, navigate, routeThreadExists, threadId]);

  useEffect(() => {
    if (!routeThreadExists) {
      return;
    }
    if ((search.panes ?? undefined) === encodedVisiblePanes) {
      return;
    }

    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => ({
        ...previous,
        panes: encodedVisiblePanes,
      }),
    });
  }, [encodedVisiblePanes, navigate, routeThreadExists, search.panes, threadId]);

  useEffect(() => {
    if (!bootstrapComplete || !routeThreadExists || !shouldPrewarmSession) {
      return;
    }

    const api = readNativeApi();
    if (!api) {
      return;
    }

    void api.orchestration.dispatchCommand({
      type: "thread.session.ensure",
      commandId: newCommandId(),
      threadId,
      createdAt: new Date().toISOString(),
    });
  }, [bootstrapComplete, routeThreadExists, shouldPrewarmSession, threadId]);

  if (!bootstrapComplete || !routeThreadExists) {
    return null;
  }

  const navigateToPaneLayout = (
    nextFocusedThreadId: ThreadId,
    nextLayout: PaneLayoutNode | null,
    options: { replace?: boolean } = {},
  ) => {
    void navigate({
      to: "/$threadId",
      params: { threadId: nextFocusedThreadId },
      replace: options.replace ?? false,
      search: (previous) => ({
        ...previous,
        panes: encodeThreadPaneSearchValue(nextLayout),
      }),
    });
  };
  const focusThreadPane = (nextThreadId: ThreadId) => {
    if (nextThreadId === threadId) {
      return;
    }
    navigateToPaneLayout(nextThreadId, paneLayout, { replace: true });
  };
  const handlePaneDropZoneChange = (paneThreadId: ThreadId, zone: PaneDropZone | null) => {
    setPaneDropTarget((previous) => {
      if (zone === null) {
        return previous?.threadId === paneThreadId ? null : previous;
      }
      return previous?.threadId === paneThreadId && previous.zone === zone
        ? previous
        : { threadId: paneThreadId, zone };
    });
  };
  const handleThreadPaneDrop = (
    targetThreadId: ThreadId,
    zone: PaneDropZone,
    droppedThreadId: ThreadId,
  ) => {
    if (paneLayout === null || !isThreadAvailable(droppedThreadId)) {
      return;
    }
    const dropResult = dropThreadOnPane({
      droppedThreadId,
      focusedThreadId: threadId,
      layout: paneLayout,
      targetThreadId,
      zone,
    });
    navigateToPaneLayout(dropResult.focusedThreadId, dropResult.layout, { replace: true });
  };
  const closeVisibleThreadPane = (closingThreadId: ThreadId) => {
    if (paneLayout === null) {
      return;
    }
    const nextPaneState = closeThreadPane({
      closingThreadId,
      focusedThreadId: threadId,
      layout: paneLayout,
    });

    if (nextPaneState.focusedThreadId === null) {
      void navigate({ to: "/", replace: true });
      return;
    }

    navigateToPaneLayout(nextPaneState.focusedThreadId, nextPaneState.layout);
  };
  const activateRightPanel = (panel: RightPanelId) => {
    if (panel === "browser") {
      if (!browserUseEnabled) {
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: (previous) => ({
          ...previous,
          browser: "1",
          panel: "browser",
        }),
      });
      return;
    }

    if (panel === "artifact") {
      if (!artifactOpen) {
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: (previous) => ({
          ...previous,
          panel: "artifact",
        }),
      });
      return;
    }

    if (!activeCwd) {
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => ({
        ...previous,
        diff: "1",
        panel: "diff",
      }),
    });
  };
  const interruptActiveThread = () => {
    if (!routeThread) {
      return;
    }
    const api = readNativeApi();
    if (!api) {
      return;
    }
    void api.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId: routeThread.id,
      ...(routeThread.latestTurn?.turnId ? { turnId: routeThread.latestTurn.turnId } : {}),
      createdAt: new Date().toISOString(),
    });
  };
  const rightSidebarTabs = [
    ...(activeCwd
      ? [
          {
            id: "diff" as const,
            label: "Diff",
            icon: <DiffIcon className="size-3.5" />,
          },
        ]
      : []),
    ...(browserUseEnabled
      ? [
          {
            id: "browser" as const,
            label: "Browser",
            icon: <GlobeIcon className="size-3.5" />,
          },
        ]
      : []),
    ...(artifactOpen
      ? [
          {
            id: "artifact" as const,
            label: "Artifact",
            icon: <FileIcon className="size-3.5" />,
          },
        ]
      : []),
  ] satisfies RightSidebarTab[];
  const shouldRenderDiffContent = diffOpen || hasOpenedDiff;
  const shouldRenderArtifactContent = artifactOpen || hasOpenedArtifact;
  const shouldRenderBrowserContent = browserOpen || hasOpenedBrowser;
  const renderSidePanelContent = (mode: DiffPanelMode) => {
    if (!activeRightPanel) {
      return null;
    }
    return (
      <RightSidebarFrame
        activePanel={activeRightPanel}
        tabs={rightSidebarTabs}
        onClosePanel={closeSidePanel}
        onSelectPanel={activateRightPanel}
      >
        <RightSidebarTabPanel panel="diff" active={activeRightPanel === "diff"}>
          {shouldRenderDiffContent ? <LazyDiffPanel mode={mode} /> : null}
        </RightSidebarTabPanel>
        <RightSidebarTabPanel panel="browser" active={activeRightPanel === "browser"}>
          {shouldRenderBrowserContent && browserUseEnabled ? (
            <BrowserPanel
              threadId={threadId}
              active={activeRightPanel === "browser"}
              cwd={activeCwd}
              isAgentWorking={isAgentWorking}
              onStopAgent={interruptActiveThread}
            />
          ) : null}
        </RightSidebarTabPanel>
        <RightSidebarTabPanel panel="artifact" active={activeRightPanel === "artifact"}>
          {shouldRenderArtifactContent ? (
            <LazyArtifactPanel
              cwd={activeCwd}
              mode={mode}
              relativePath={search.artifactPath ?? null}
            />
          ) : null}
        </RightSidebarTabPanel>
      </RightSidebarFrame>
    );
  };
  const paneStrip =
    paneLayout === null ? null : (
      <SplitLayout
        layout={paneLayout}
        minPaneSizePx={THREAD_PANE_MIN_SIZE_PX}
        renderPane={(paneKey) => {
          const paneThreadId = ThreadId.makeUnsafe(paneKey);
          return (
            <ChatThreadPane
              threadId={paneThreadId}
              focused={paneThreadId === threadId}
              multiPane={multiPane}
              dropZone={paneDropTarget?.threadId === paneThreadId ? paneDropTarget.zone : null}
              onDropZoneChange={(zone) => handlePaneDropZoneChange(paneThreadId, zone)}
              onThreadDrop={(droppedThreadId, zone) =>
                handleThreadPaneDrop(paneThreadId, zone, droppedThreadId)
              }
              onFocus={() => focusThreadPane(paneThreadId)}
              onClose={() => closeVisibleThreadPane(paneThreadId)}
            />
          );
        }}
      />
    );

  if (!shouldUseDiffSheet) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {paneStrip}
          <SidePanelDockedSidebar
            open={sidePanelOpen}
            ariaLabel={`Resize ${activeRightPanel ? rightPanelLabel(activeRightPanel) : "right"} panel`}
          >
            {renderSidePanelContent("sidebar")}
          </SidePanelDockedSidebar>
        </div>
      </SidebarInset>
    );
  }

  return (
    <>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        {paneStrip}
      </SidebarInset>
      <SidePanelSheet open={sidePanelOpen} onClosePanel={closeSidePanel}>
        {renderSidePanelContent("sheet")}
      </SidePanelSheet>
    </>
  );
}

export function shouldPrewarmThreadSession(
  thread: {
    session: { orchestrationStatus: string } | null;
    resumeState: string;
  } | null,
): boolean {
  if (thread === null) {
    return false;
  }

  if (thread.resumeState === "unrecoverable" || thread.resumeState === "resuming") {
    return false;
  }

  return (
    thread.session === null ||
    thread.session.orchestrationStatus === "stopped" ||
    thread.session.orchestrationStatus === "error"
  );
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  search: {
    middlewares: [
      retainSearchParams<DiffRouteSearch>([
        "diff",
        "diffTurnId",
        "diffFilePath",
        "artifact",
        "artifactPath",
        "browser",
        "panel",
        "panes",
      ]),
    ],
  },
  component: ChatThreadRouteView,
});
