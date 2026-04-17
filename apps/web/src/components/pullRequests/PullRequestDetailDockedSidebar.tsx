import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  DEFAULT_RUNTIME_MODE,
  type GitPullRequestListFilter,
  type ProjectId,
  type ThreadId,
} from "contracts";
import { Schema } from "effect";
import {
  CheckIcon,
  ChevronDownIcon,
  DownloadIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  MessageCircleIcon,
  OctagonXIcon,
  SparklesIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  GitPullRequestComment,
  GitPullRequestConversationResult,
  GitPullRequestReview,
  GitPullRequestReviewState,
  GitResolvedPullRequest,
} from "contracts";

import ChatMarkdown from "~/components/ChatMarkdown";
import { DockedSidebarResizeHandle } from "~/components/DockedSidebarResizeHandle";
import { DiffPanelLoadingOverlay, DiffPanelLoadingState } from "~/components/DiffPanelShell";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Skeleton } from "~/components/ui/skeleton";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useComposerDraftStore } from "~/composerDraftStore";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { useRenderedDiffReady } from "~/hooks/useRenderedDiffReady";
import { useTheme } from "~/hooks/useTheme";
import { buildPatchCacheKey, resolveDiffThemeName } from "~/lib/diffRendering";
import {
  gitOpenPullRequestsQueryOptions,
  gitPreparePullRequestThreadMutationOptions,
  gitPullRequestConversationQueryOptions,
  gitPullRequestDiffQueryOptions,
  gitPullRequestSummaryQueryOptions,
} from "~/lib/gitReactQuery";
import { newThreadId } from "~/lib/utils";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { Sheet, SheetPopup } from "~/components/ui/sheet";

const DOCKED_SIDEBAR_WIDTH_STORAGE_KEY = "pull_requests_detail_sidebar_width";
const DOCKED_SIDEBAR_MIN_WIDTH = 28 * 16;
const DOCKED_SIDEBAR_MAX_WIDTH = 60 * 16;
const DOCKED_SIDEBAR_DEFAULT_RATIO = 0.5;

const DIFF_PANEL_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--destructive));

  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
}
`;

const DIFF_PANEL_FONT_STYLE = {
  "--diffs-font-family": "var(--font-mono)",
  "--diffs-header-font-family": "var(--font-mono)",
} as CSSProperties;

function clampDockedWidth(width: number): number {
  return Math.max(DOCKED_SIDEBAR_MIN_WIDTH, Math.min(width, DOCKED_SIDEBAR_MAX_WIDTH));
}

function getDefaultDockedWidth(): number {
  if (typeof window === "undefined") return DOCKED_SIDEBAR_MIN_WIDTH;
  return clampDockedWidth(window.innerWidth * DOCKED_SIDEBAR_DEFAULT_RATIO);
}

function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

function buildFileDiffKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

interface PullRequestDetailDockedSidebarProps {
  filter: GitPullRequestListFilter;
  open: boolean;
  projectId: string | null;
  number: number | null;
  onClose: () => void;
}

export function PullRequestDetailDockedSidebar({
  filter,
  open,
  projectId,
  number,
  onClose,
}: PullRequestDetailDockedSidebarProps) {
  const isMobile = useIsMobile();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const resizeStateRef = useRef<{
    pointerId: number;
    startWidth: number;
    startX: number;
  } | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = getLocalStorageItem(DOCKED_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite);
    return stored === null ? getDefaultDockedWidth() : clampDockedWidth(stored);
  });

  const persistWidth = useCallback((nextWidth: number) => {
    const clamped = clampDockedWidth(nextWidth);
    setSidebarWidth(clamped);
    setLocalStorageItem(DOCKED_SIDEBAR_WIDTH_STORAGE_KEY, clamped, Schema.Finite);
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

  const handleResizeMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    const nextWidth = clampDockedWidth(
      resizeState.startWidth + (resizeState.startX - event.clientX),
    );
    setSidebarWidth(nextWidth);
    event.preventDefault();
  }, []);

  const handleResizeEnd = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      persistWidth(sidebarWidth);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      stopResize();
      event.preventDefault();
    },
    [persistWidth, sidebarWidth, stopResize],
  );

  useEffect(() => () => stopResize(), [stopResize]);

  if (!open || projectId === null || number === null) return null;

  if (isMobile) {
    return (
      <Sheet
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            onClose();
          }
        }}
      >
        <SheetPopup
          side="bottom"
          showCloseButton={false}
          keepMounted
          className="h-[min(92dvh,900px)] w-full max-w-full p-0"
        >
          <PullRequestDetailContent
            filter={filter}
            projectId={projectId}
            number={number}
            onClose={onClose}
          />
        </SheetPopup>
      </Sheet>
    );
  }

  return (
    <div
      ref={panelRef}
      className={cn(
        "relative hidden min-h-0 shrink-0 border-l border-border bg-card text-foreground md:flex",
      )}
      style={{ width: sidebarWidth }}
    >
      <DockedSidebarResizeHandle
        ariaLabel="Resize pull request detail panel"
        onPointerCancel={handleResizeEnd}
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PullRequestDetailContent
          filter={filter}
          projectId={projectId}
          number={number}
          onClose={onClose}
        />
      </div>
    </div>
  );
}

function PullRequestDetailContent({
  filter,
  projectId,
  number,
  onClose,
}: {
  filter: GitPullRequestListFilter;
  projectId: string;
  number: number;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const diffContentRef = useRef<HTMLDivElement | null>(null);

  const project = useStore(
    (store) => store.projects.find((entry) => entry.id === projectId) ?? null,
  );
  const projectCwd = project?.cwd ?? null;

  const pullRequestsQuery = useQuery(gitOpenPullRequestsQueryOptions({ cwd: projectCwd, filter }));
  const pullRequest = useMemo<GitResolvedPullRequest | null>(() => {
    if (!pullRequestsQuery.data) return null;
    return pullRequestsQuery.data.pullRequests.find((pr) => pr.number === number) ?? null;
  }, [pullRequestsQuery.data, number]);

  const diffQuery = useQuery(gitPullRequestDiffQueryOptions({ cwd: projectCwd, number }));
  const diffText = diffQuery.data?.diff ?? "";
  const diffCacheKey = useMemo(() => {
    const trimmed = diffText.trim();
    return trimmed.length === 0
      ? null
      : buildPatchCacheKey(trimmed, `pull-requests-panel:${resolvedTheme}`);
  }, [diffText, resolvedTheme]);

  const renderableFiles = useMemo(() => {
    const trimmed = diffText.trim();
    if (trimmed.length === 0) return [];
    try {
      const parsed = parsePatchFiles(trimmed, diffCacheKey ?? undefined);
      return parsed
        .flatMap((patch) => patch.files)
        .toSorted((left, right) =>
          resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
            numeric: true,
            sensitivity: "base",
          }),
        );
    } catch {
      return [];
    }
  }, [diffCacheKey, diffText]);

  const hasRenderedDiffContent = useRenderedDiffReady({
    rootRef: diffContentRef,
    enabled:
      !diffQuery.isLoading && !diffQuery.isError && renderableFiles.length > 0 && !!diffCacheKey,
    dependencyKey: `${diffCacheKey ?? "none"}:${diffQuery.isError ? "error" : "ok"}:${diffQuery.isLoading ? "loading" : "ready"}:${renderableFiles.length}:${resolvedTheme}`,
  });

  const summaryQuery = useQuery(
    gitPullRequestSummaryQueryOptions({ cwd: projectCwd, number, pullRequest }),
  );

  const conversationQuery = useQuery(
    gitPullRequestConversationQueryOptions({ cwd: projectCwd, number }),
  );

  const [activeTab, setActiveTab] = useState<"files" | "conversation">("files");
  const summary = summaryQuery.data?.summary ?? null;

  const preparePullRequestMutation = useMutation(
    gitPreparePullRequestThreadMutationOptions({ cwd: projectCwd, queryClient }),
  );

  const handleOpenInBrowser = useCallback(() => {
    if (!pullRequest) return;
    const api = readNativeApi();
    if (!api) return;
    void api.shell.openExternal(pullRequest.url).catch((error) => {
      console.warn("Failed to open pull request in browser.", error);
    });
  }, [pullRequest]);

  const handleCheckout = useCallback(async () => {
    if (!pullRequest || !projectCwd) return;
    try {
      const result = await preparePullRequestMutation.mutateAsync({
        reference: String(pullRequest.number),
        mode: "worktree",
      });
      void navigate({
        to: "/",
        search: (previous) => ({
          ...previous,
          branch: result.branch,
          worktreePath: result.worktreePath,
        }),
      });
    } catch (error) {
      console.warn("Failed to checkout pull request.", error);
    }
  }, [navigate, preparePullRequestMutation, projectCwd, pullRequest]);

  const handleReview = useCallback(() => {
    if (!pullRequest || !project) return;
    const descriptionBlock =
      summary && summary.length > 0 ? `\n\n**AI summary of changes:**\n${summary}` : "";
    const reviewPrompt = [
      `Please review pull request #${pullRequest.number}: **${pullRequest.title}**.`,
      "",
      `- URL: ${pullRequest.url}`,
      `- State: ${pullRequest.state}`,
      `- Base branch: \`${pullRequest.baseBranch}\``,
      `- Head branch: \`${pullRequest.headBranch}\``,
      descriptionBlock,
      "",
      "Walk through the changes file by file, highlight bugs, risky refactors, security or performance concerns, and suggest concrete improvements. Finish with a short overall verdict and a list of follow-up actions.",
    ].join("\n");

    const composerStore = useComposerDraftStore.getState();
    const threadId = newThreadId() as ThreadId;
    composerStore.setProjectDraftThreadId(project.id as ProjectId, threadId, {
      createdAt: new Date().toISOString(),
      envMode: "local",
      runtimeMode: DEFAULT_RUNTIME_MODE,
    });
    composerStore.applyStickyState(threadId);
    composerStore.setPrompt(threadId, reviewPrompt);
    void navigate({ to: "/$threadId", params: { threadId } });
  }, [navigate, project, pullRequest, summary]);

  const stateTone: "success" | "secondary" | "error" =
    pullRequest?.state === "open"
      ? "success"
      : pullRequest?.state === "merged"
        ? "secondary"
        : "error";
  const shouldShowDiffRenderLoading =
    !diffQuery.isLoading &&
    !diffQuery.isError &&
    renderableFiles.length > 0 &&
    !hasRenderedDiffContent;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header>
        <div className="flex items-start gap-2 px-4 pt-3 pb-2">
          <div className="min-w-0 flex-1">
            {pullRequest ? (
              <>
                <h2 className="text-balance line-clamp-2 text-sm font-semibold text-foreground">
                  {pullRequest.title}
                </h2>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <Badge
                    variant={stateTone}
                    className="h-4 px-1.5 text-[10px] uppercase tracking-wide"
                  >
                    {pullRequest.state}
                  </Badge>
                  {pullRequest.isDraft ? (
                    <Badge
                      variant="outline"
                      className="h-4 px-1.5 text-[10px] uppercase tracking-wide"
                    >
                      Draft
                    </Badge>
                  ) : null}
                  <span className="tabular-nums">#{pullRequest.number}</span>
                  <span className="flex min-w-0 items-center gap-1 truncate font-mono text-[11px]">
                    <GitBranchIcon className="size-3 shrink-0" aria-hidden />
                    <span className="truncate">
                      {pullRequest.baseBranch} ← {pullRequest.headBranch}
                    </span>
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="h-4 w-48 animate-pulse rounded bg-muted" />
                <div className="mt-2 h-3 w-64 animate-pulse rounded bg-muted/70" />
              </>
            )}
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Close pull request detail"
            className="size-7 shrink-0"
            onClick={onClose}
          >
            <XIcon className="size-4" aria-hidden />
          </Button>
        </div>
        <div className="flex items-center gap-1.5 px-4 pb-3">
          <div className="inline-flex">
            <Button
              type="button"
              size="xs"
              disabled={!pullRequest || preparePullRequestMutation.isPending}
              className="gap-1.5 rounded-r-none"
              onClick={() => {
                void handleCheckout();
              }}
            >
              <DownloadIcon className="size-3.5" aria-hidden />
              {preparePullRequestMutation.isPending ? "Checking out…" : "Checkout"}
            </Button>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    type="button"
                    size="xs"
                    aria-label="More checkout options"
                    disabled={!pullRequest || preparePullRequestMutation.isPending}
                    className="-ml-px rounded-l-none border-l border-l-primary-foreground/20 px-1.5"
                  />
                }
              >
                <ChevronDownIcon className="size-3.5" aria-hidden />
              </MenuTrigger>
              <MenuPopup align="end" side="bottom">
                <MenuItem
                  onClick={() => {
                    void handleCheckout();
                  }}
                >
                  <DownloadIcon className="size-3.5" aria-hidden />
                  Checkout
                </MenuItem>
                <MenuItem onClick={handleOpenInBrowser}>
                  <ExternalLinkIcon className="size-3.5" aria-hidden />
                  Open in GitHub
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!pullRequest || !project}
            className="gap-1.5"
            onClick={handleReview}
          >
            <SparklesIcon className="size-3.5" aria-hidden />
            Review
          </Button>
        </div>
        <div className="border-t border-border/60 px-4 py-3">
          {summaryQuery.isLoading ? (
            <div className="flex flex-col gap-1.5" aria-label="Loading pull request summary">
              <Skeleton className="h-3 w-11/12 rounded-full" />
              <Skeleton className="h-3 w-10/12 rounded-full" />
              <Skeleton className="h-3 w-9/12 rounded-full" />
              <Skeleton className="h-3 w-8/12 rounded-full" />
            </div>
          ) : summaryQuery.isError ? (
            <p className="text-pretty text-xs text-muted-foreground/80">
              Failed to summarize this pull request.
            </p>
          ) : summary && summary.length > 0 ? (
            <ChatMarkdown
              text={summary}
              cwd={projectCwd ?? undefined}
              className="text-xs leading-relaxed text-muted-foreground"
            />
          ) : (
            <p className="text-pretty text-xs text-muted-foreground/60">
              No summary generated for this pull request.
            </p>
          )}
        </div>
      </header>

      <div className="my-2 flex h-9 shrink-0 items-center px-4">
        <ToggleGroup
          value={[activeTab]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "files" || next === "conversation") {
              setActiveTab(next);
            }
          }}
          className="h-7 gap-1"
        >
          <Toggle value="files" className="h-6 px-2 text-xs">
            Files
          </Toggle>
          <Toggle value="conversation" className="h-6 gap-1 px-2 text-xs">
            Conversation
            {conversationQuery.data
              ? (() => {
                  const total =
                    conversationQuery.data.comments.length + conversationQuery.data.reviews.length;
                  return total > 0 ? (
                    <span className="ml-1 tabular-nums text-muted-foreground/60">{total}</span>
                  ) : null;
                })()
              : null}
          </Toggle>
        </ToggleGroup>
      </div>

      {activeTab === "conversation" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <PullRequestConversationView
            query={conversationQuery}
            projectCwd={projectCwd}
            pullRequestUrl={pullRequest?.url ?? null}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden" style={DIFF_PANEL_FONT_STYLE}>
          {diffQuery.isLoading ? (
            <DiffPanelLoadingState label="Loading the diff" />
          ) : diffQuery.isError ? (
            <div className="flex h-full items-center justify-center p-6">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <XIcon />
                  </EmptyMedia>
                  <EmptyTitle className="text-pretty">Failed to load diff</EmptyTitle>
                  <EmptyDescription className="text-pretty">
                    {diffQuery.error instanceof Error
                      ? diffQuery.error.message
                      : "The diff could not be retrieved."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : renderableFiles.length === 0 ? (
            <div className="flex h-full items-center justify-center p-6">
              <Empty>
                <EmptyHeader>
                  <EmptyTitle className="text-pretty">No changes to show</EmptyTitle>
                  <EmptyDescription className="text-pretty">
                    This pull request has an empty diff.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : (
            <div className="relative h-full min-h-0">
              {shouldShowDiffRenderLoading ? (
                <DiffPanelLoadingOverlay label="Loading the diff" />
              ) : null}
              <div ref={diffContentRef} className="h-full min-h-0">
                <Virtualizer
                  className="diff-render-surface h-full min-h-0 overflow-auto px-2 pb-2"
                  config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
                >
                  {renderableFiles.map((fileDiff) => {
                    const key = `${buildFileDiffKey(fileDiff)}:${resolvedTheme}`;
                    return (
                      <div
                        key={key}
                        data-diff-file-path={resolveFileDiffPath(fileDiff)}
                        className="diff-render-file mb-2 rounded-md first:mt-2 last:mb-0"
                      >
                        <FileDiff
                          fileDiff={fileDiff}
                          options={{
                            diffStyle: "unified",
                            lineDiffType: "none",
                            overflow: "scroll",
                            theme: resolveDiffThemeName(resolvedTheme),
                            themeType: resolvedTheme,
                            unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
                          }}
                        />
                      </div>
                    );
                  })}
                </Virtualizer>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type ConversationQueryState = UseQueryResult<GitPullRequestConversationResult, Error>;

type ConversationTimelineEntry =
  | { kind: "comment"; id: string; createdAt: string; data: GitPullRequestComment }
  | { kind: "review"; id: string; createdAt: string; data: GitPullRequestReview };

function buildConversationTimeline(
  conversation: GitPullRequestConversationResult,
): ConversationTimelineEntry[] {
  const entries: ConversationTimelineEntry[] = [];
  for (const comment of conversation.comments) {
    entries.push({
      kind: "comment",
      id: `comment:${comment.id}`,
      createdAt: comment.createdAt,
      data: comment,
    });
  }
  for (const review of conversation.reviews) {
    entries.push({
      kind: "review",
      id: `review:${review.id}`,
      createdAt: review.submittedAt,
      data: review,
    });
  }
  entries.sort((left, right) => {
    if (left.createdAt === right.createdAt) return 0;
    return left.createdAt < right.createdAt ? -1 : 1;
  });
  return entries;
}

function formatTimelineTimestamp(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function getReviewStateCopy(state: GitPullRequestReviewState): {
  label: string;
  tone: "success" | "destructive" | "muted";
} {
  switch (state) {
    case "approved":
      return { label: "approved these changes", tone: "success" };
    case "changes_requested":
      return { label: "requested changes", tone: "destructive" };
    case "dismissed":
      return { label: "dismissed a review", tone: "muted" };
    case "pending":
      return { label: "started a pending review", tone: "muted" };
    default:
      return { label: "left a review", tone: "muted" };
  }
}

function ConversationAvatar({ author }: { author: string | null }) {
  const [errored, setErrored] = useState(false);
  const trimmed = (author ?? "").trim();
  const initial = trimmed.charAt(0).toUpperCase();

  if (trimmed.length > 0 && !errored) {
    return (
      <img
        src={`https://github.com/${encodeURIComponent(trimmed)}.png?size=64`}
        alt={`${trimmed} avatar`}
        loading="lazy"
        decoding="async"
        className="size-7 shrink-0 rounded-full border border-border/60 bg-muted object-cover"
        onError={() => setErrored(true)}
      />
    );
  }

  return (
    <div
      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground"
      aria-hidden
    >
      {initial.length > 0 ? initial : <UserIcon className="size-3.5" />}
    </div>
  );
}

function ConversationMessageCard({
  author,
  createdAt,
  children,
  headerExtra,
  url,
}: {
  author: string | null;
  createdAt: string;
  children: React.ReactNode;
  headerExtra?: React.ReactNode;
  url?: string;
}) {
  return (
    <article className="flex gap-3 text-sm">
      <ConversationAvatar author={author} />
      <div className="min-w-0 flex-1 rounded-lg border border-border/60 bg-card/60">
        <header className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
          <span className="truncate font-medium text-foreground">{author ?? "Unknown user"}</span>
          {headerExtra ? <span className="truncate">{headerExtra}</span> : null}
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/70">
            {formatTimelineTimestamp(createdAt)}
          </span>
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground/70 transition-colors hover:text-foreground"
              aria-label="Open on GitHub"
            >
              <ExternalLinkIcon className="size-3" />
            </a>
          ) : null}
        </header>
        <div className="px-3 py-2">{children}</div>
      </div>
    </article>
  );
}

function PullRequestConversationView({
  query,
  projectCwd,
  pullRequestUrl: _pullRequestUrl,
}: {
  query: ConversationQueryState;
  projectCwd: string | null;
  pullRequestUrl: string | null;
}) {
  if (query.isLoading) {
    return (
      <div className="flex h-full flex-col gap-3 overflow-hidden p-4">
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex gap-3">
            <Skeleton className="size-7 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-36 rounded-full" />
              <Skeleton className="h-3 w-11/12 rounded-full" />
              <Skeleton className="h-3 w-9/12 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <XIcon />
            </EmptyMedia>
            <EmptyTitle className="text-pretty">Failed to load conversation</EmptyTitle>
            <EmptyDescription className="text-pretty">
              {query.error instanceof Error
                ? query.error.message
                : "The conversation could not be retrieved."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const conversation = query.data;
  if (!conversation) return null;

  const timeline = buildConversationTimeline(conversation);
  const isEmpty = conversation.description.length === 0 && timeline.length === 0;

  if (isEmpty) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MessageCircleIcon />
            </EmptyMedia>
            <EmptyTitle className="text-pretty">No conversation yet</EmptyTitle>
            <EmptyDescription className="text-pretty">
              This pull request has no description or comments.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 p-4">
        {conversation.description.length > 0 ? (
          <ConversationMessageCard
            author={conversation.descriptionAuthor}
            createdAt={conversation.descriptionCreatedAt ?? ""}
            headerExtra="opened this pull request"
          >
            <ChatMarkdown
              text={conversation.description}
              cwd={projectCwd ?? undefined}
              className="text-xs leading-relaxed text-foreground/90"
            />
          </ConversationMessageCard>
        ) : null}
        {timeline.map((entry) =>
          entry.kind === "comment" ? (
            <ConversationMessageCard
              key={entry.id}
              author={entry.data.author}
              createdAt={entry.data.createdAt}
              headerExtra="commented"
              {...(entry.data.url ? { url: entry.data.url } : {})}
            >
              <ChatMarkdown
                text={entry.data.body}
                cwd={projectCwd ?? undefined}
                className="text-xs leading-relaxed text-foreground/90"
              />
            </ConversationMessageCard>
          ) : (
            <ReviewTimelineEntry key={entry.id} review={entry.data} projectCwd={projectCwd} />
          ),
        )}
      </div>
    </ScrollArea>
  );
}

function ReviewTimelineEntry({
  review,
  projectCwd,
}: {
  review: GitPullRequestReview;
  projectCwd: string | null;
}) {
  const { label, tone } = getReviewStateCopy(review.state);
  const Icon =
    review.state === "approved"
      ? CheckIcon
      : review.state === "changes_requested"
        ? OctagonXIcon
        : MessageCircleIcon;
  const badgeClass =
    tone === "success"
      ? "text-success"
      : tone === "destructive"
        ? "text-destructive"
        : "text-muted-foreground";

  const headerExtra = (
    <span className={cn("flex items-center gap-1", badgeClass)}>
      <Icon className="size-3" aria-hidden />
      {label}
    </span>
  );

  return (
    <ConversationMessageCard
      author={review.author}
      createdAt={review.submittedAt}
      headerExtra={headerExtra}
      {...(review.url ? { url: review.url } : {})}
    >
      {review.body.length > 0 ? (
        <ChatMarkdown
          text={review.body}
          cwd={projectCwd ?? undefined}
          className="text-xs leading-relaxed text-foreground/90"
        />
      ) : (
        <p className="text-xs italic text-muted-foreground/70">No review body.</p>
      )}
    </ConversationMessageCard>
  );
}
