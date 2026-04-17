import { ThreadId } from "contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import {
  Suspense,
  lazy,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

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
import { type DiffRouteSearch, parseDiffRouteSearch } from "../diffRouteSearch";
import { useActiveThreadLease } from "../hooks/useActiveThreadLease";
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
        "relative hidden min-h-0 shrink-0 border-l border-border bg-card text-foreground md:flex",
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
      <div className="min-h-0 flex-1">
        {renderDiffContent ? <LazyDiffPanel mode="sidebar" onClose={onCloseDiff} /> : null}
      </div>
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
  const threadExists = useStore((store) => store.threads.some((thread) => thread.id === threadId));
  const draftThreadExists = useComposerDraftStore((store) =>
    Object.hasOwn(store.draftThreadsByThreadId, threadId),
  );
  const routeThreadExists = threadExists || draftThreadExists;
  const shouldPrewarmSession = shouldPrewarmThreadSession(routeThread);
  useActiveThreadLease(routeThreadExists ? threadId : null);
  const diffOpen = search.diff === "1";
  const shouldUseDiffSheet = useMediaQuery(DIFF_DOCKED_LAYOUT_MEDIA_QUERY);
  const missingThreadSinceRef = useRef<number | null>(null);
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
      search: { diff: undefined },
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

  const shouldRenderDiffContent = diffOpen || hasOpenedDiff;

  if (!shouldUseDiffSheet) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            <ChatView key={threadId} threadId={threadId} />
          </div>
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
        <ChatView key={threadId} threadId={threadId} />
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

  if (thread.resumeState !== "resumed") {
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
    middlewares: [retainSearchParams<DiffRouteSearch>(["diff"])],
  },
  component: ChatThreadRouteView,
});
