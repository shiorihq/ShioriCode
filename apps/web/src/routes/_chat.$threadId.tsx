import { ThreadId } from "contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import {
  Suspense,
  lazy,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { IconXmarkOutline24 as XIcon } from "nucleo-core-outline-24";

import ChatView from "../components/ChatView";
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
  closeThreadPane,
  encodeThreadPaneSearchValue,
  type DiffRouteSearch,
  hasThreadPaneDragData,
  parseDiffRouteSearch,
  parseThreadPaneSearchValue,
  readThreadPaneDragData,
  resolveDroppedThreadPaneIds,
  resolveVisibleThreadPaneIds,
  stripDiffSearchParams,
} from "../diffRouteSearch";
import { useActiveThreadLeases } from "../hooks/useActiveThreadLease";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { Sheet, SheetPopup } from "../components/ui/sheet";
import { SidebarInset } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
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

const DiffPanelSheet = (props: {
  children: ReactNode;
  diffOpen: boolean;
  onCloseDiff: () => void;
}) => {
  return (
    <Sheet
      open={props.diffOpen}
      onOpenChange={(open) => {
        if (!open) {
          props.onCloseDiff();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(88vw,820px)] max-w-[820px] p-0"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
};

const DiffLoadingFallback = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label="Loading the diff" />
    </DiffPanelShell>
  );
};

const LazyDiffPanel = (props: { mode: DiffPanelMode; onClose?: () => void }) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
        <DiffPanel mode={props.mode} onClose={props.onClose} />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

const DiffPanelDockedSidebar = (props: {
  diffOpen: boolean;
  onCloseDiff: () => void;
  renderDiffContent: boolean;
}) => {
  const { diffOpen, onCloseDiff, renderDiffContent } = props;
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

  return diffOpen ? (
    <div
      ref={panelRef}
      className={cn(
        "relative hidden min-h-0 shrink-0 overflow-hidden border-l border-border bg-card text-foreground md:flex",
        "shadow-[-20px_0_40px_-36px_rgba(15,23,42,0.55)]",
      )}
      style={{ width: sidebarWidth }}
    >
      <DockedSidebarResizeHandle
        ariaLabel="Resize diff panel"
        onPointerCancel={handleResizeEnd}
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {renderDiffContent ? <LazyDiffPanel mode="sidebar" onClose={onCloseDiff} /> : null}
      </div>
    </div>
  ) : null;
};

function ChatThreadPane(props: {
  focused: boolean;
  multiPane: boolean;
  onClose: () => void;
  onFocus: () => void;
  threadId: ThreadId;
}) {
  return (
    <section
      aria-label={props.focused ? "Focused thread pane" : "Thread pane"}
      data-focused={props.focused ? "true" : "false"}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
        props.multiPane &&
          "min-w-[min(34rem,86vw)] basis-[34rem] border-r border-border/70 last:border-r-0",
        props.multiPane && !props.focused && "bg-muted/10",
      )}
      onFocusCapture={() => {
        if (!props.focused) {
          props.onFocus();
        }
      }}
      onPointerEnter={() => {
        if (!props.focused) {
          props.onFocus();
        }
      }}
      onPointerDownCapture={(event) => {
        if (props.focused) {
          return;
        }
        const target = event.target;
        if (!(target instanceof Element)) {
          return;
        }
        if (target.closest("[data-thread-pane-close='true']")) {
          return;
        }
        props.onFocus();
      }}
    >
      {props.multiPane ? (
        <div
          className={cn(
            "flex h-8 shrink-0 items-center justify-end border-b px-2",
            props.focused ? "border-foreground/20 bg-background" : "border-border/70 bg-muted/10",
          )}
        >
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 z-30 h-px transition-colors",
              props.focused ? "bg-foreground/60" : "bg-border/80",
            )}
          />
          <button
            type="button"
            data-thread-pane-close="true"
            aria-label="Close thread pane"
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-hover hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              props.onClose();
            }}
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      ) : null}
      <ChatView key={props.threadId} threadId={props.threadId} isFocusedPane={props.focused} />
    </section>
  );
}

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
  const threadIndexById = useStore((store) => store.threadIndexById);
  const threadExists = useStore((store) => store.threads.some((thread) => thread.id === threadId));
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const draftThreadExists = Object.hasOwn(draftThreadsByThreadId, threadId);
  const routeThreadExists = threadExists || draftThreadExists;
  const shouldPrewarmSession = shouldPrewarmThreadSession(routeThread);
  const diffOpen = search.diff === "1";
  const shouldUseDiffSheet = useMediaQuery(DIFF_DOCKED_LAYOUT_MEDIA_QUERY);
  const missingThreadSinceRef = useRef<number | null>(null);
  const threadDropDepthRef = useRef(0);
  const isThreadAvailable = useCallback(
    (paneThreadId: ThreadId) =>
      threadIndexById[paneThreadId] !== undefined ||
      Object.hasOwn(draftThreadsByThreadId, paneThreadId),
    [draftThreadsByThreadId, threadIndexById],
  );
  const visibleThreadIds = useMemo(
    () =>
      routeThreadExists
        ? resolveVisibleThreadPaneIds({
            focusedThreadId: threadId,
            paneThreadIds: parseThreadPaneSearchValue(search.panes),
            isThreadAvailable,
          })
        : [],
    [isThreadAvailable, routeThreadExists, search.panes, threadId],
  );
  const encodedVisiblePanes = encodeThreadPaneSearchValue(visibleThreadIds);
  const multiPane = visibleThreadIds.length > 1;
  const [threadDropActive, setThreadDropActive] = useState(false);
  useActiveThreadLeases(visibleThreadIds);
  useEffect(() => {
    if (!threadDropActive) {
      return;
    }

    const resetThreadDropState = () => {
      threadDropDepthRef.current = 0;
      setThreadDropActive(false);
    };

    window.addEventListener("dragend", resetThreadDropState);
    window.addEventListener("drop", resetThreadDropState);
    return () => {
      window.removeEventListener("dragend", resetThreadDropState);
      window.removeEventListener("drop", resetThreadDropState);
    };
  }, [threadDropActive]);
  // TanStack Router keeps param-only route navigations mounted by default, so reset any
  // "missing thread" grace bookkeeping when the active thread id changes.
  useEffect(() => {
    missingThreadSinceRef.current = null;
  }, [threadId]);
  const [hasOpenedDiff, setHasOpenedDiff] = useState(diffOpen);
  const closeDiff = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => ({ ...stripDiffSearchParams(previous), diff: undefined }),
    });
  }, [navigate, threadId]);
  useEffect(() => {
    if (diffOpen) {
      setHasOpenedDiff(true);
    }
  }, [diffOpen]);

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

  const focusThreadPane = (nextThreadId: ThreadId) => {
    if (nextThreadId === threadId) {
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId: nextThreadId },
      replace: true,
      search: (previous) => ({
        ...previous,
        panes: encodedVisiblePanes,
      }),
    });
  };
  const openDroppedThreadPane = (nextThreadId: ThreadId) => {
    if (!isThreadAvailable(nextThreadId)) {
      return;
    }

    const nextPaneIds = resolveDroppedThreadPaneIds({
      focusedThreadId: threadId,
      paneThreadIds: visibleThreadIds,
      threadId: nextThreadId,
    });

    void navigate({
      to: "/$threadId",
      params: { threadId: nextThreadId },
      replace: true,
      search: (previous) => ({
        ...previous,
        panes: encodeThreadPaneSearchValue(nextPaneIds),
      }),
    });
  };
  const closeVisibleThreadPane = (closingThreadId: ThreadId) => {
    const nextPaneState = closeThreadPane({
      focusedThreadId: threadId,
      paneThreadIds: visibleThreadIds,
      closingThreadId,
    });

    if (nextPaneState.focusedThreadId === null) {
      void navigate({ to: "/", replace: true });
      return;
    }

    void navigate({
      to: "/$threadId",
      params: { threadId: nextPaneState.focusedThreadId },
      search: (previous) => ({
        ...previous,
        panes: encodeThreadPaneSearchValue(nextPaneState.paneThreadIds),
      }),
    });
  };
  const shouldRenderDiffContent = diffOpen || hasOpenedDiff;
  const renderChatPanes = () =>
    visibleThreadIds.map((visibleThreadId) => (
      <ChatThreadPane
        key={visibleThreadId}
        threadId={visibleThreadId}
        focused={visibleThreadId === threadId}
        multiPane={multiPane}
        onFocus={() => focusThreadPane(visibleThreadId)}
        onClose={() => closeVisibleThreadPane(visibleThreadId)}
      />
    ));
  const acceptThreadPaneDrag = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasThreadPaneDragData(event.dataTransfer)) {
      return false;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    return true;
  };
  const handleThreadPaneDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!acceptThreadPaneDrag(event)) {
      return;
    }
    threadDropDepthRef.current += 1;
    setThreadDropActive(true);
  };
  const handleThreadPaneDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    acceptThreadPaneDrag(event);
  };
  const handleThreadPaneDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasThreadPaneDragData(event.dataTransfer)) {
      return;
    }
    threadDropDepthRef.current = Math.max(0, threadDropDepthRef.current - 1);
    if (threadDropDepthRef.current === 0) {
      setThreadDropActive(false);
    }
  };
  const handleThreadPaneDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    const droppedThreadId = readThreadPaneDragData(event.dataTransfer);
    if (!droppedThreadId) {
      return;
    }
    event.preventDefault();
    threadDropDepthRef.current = 0;
    setThreadDropActive(false);
    openDroppedThreadPane(droppedThreadId);
  };
  const paneStrip = (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden",
        threadDropActive && "ring-1 ring-inset ring-foreground/35",
      )}
      onDragEnter={handleThreadPaneDragEnter}
      onDragOver={handleThreadPaneDragOver}
      onDragLeave={handleThreadPaneDragLeave}
      onDrop={handleThreadPaneDrop}
    >
      {renderChatPanes()}
      {threadDropActive ? (
        <div className="pointer-events-none absolute inset-2 z-50 rounded-lg border border-dashed border-foreground/35 bg-background/20" />
      ) : null}
    </div>
  );

  if (!shouldUseDiffSheet) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {paneStrip}
          <DiffPanelDockedSidebar
            diffOpen={diffOpen}
            onCloseDiff={closeDiff}
            renderDiffContent={shouldRenderDiffContent}
          />
        </div>
      </SidebarInset>
    );
  }

  return (
    <>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        {paneStrip}
      </SidebarInset>
      <DiffPanelSheet diffOpen={diffOpen} onCloseDiff={closeDiff}>
        {shouldRenderDiffContent ? <LazyDiffPanel mode="sheet" onClose={closeDiff} /> : null}
      </DiffPanelSheet>
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
    middlewares: [retainSearchParams<DiffRouteSearch>(["diff", "browser", "panes"])],
  },
  component: ChatThreadRouteView,
});
