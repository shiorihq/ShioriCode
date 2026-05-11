import { useQueries, useQueryClient } from "@tanstack/react-query";
import {
  IconChevronDownOutline24 as ChevronDownIcon,
  IconBranchMergeOutline24 as GitPullRequestIcon,
  IconRefreshOutline24 as RefreshCwIcon,
} from "nucleo-core-outline-24";
import { useCallback, useMemo, useState } from "react";

import type { GitPullRequestListFilter, GitResolvedPullRequest } from "contracts";

import { Button } from "~/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Skeleton } from "~/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { gitOpenPullRequestsQueryOptions, gitQueryKeys } from "~/lib/gitReactQuery";
import { useStore } from "~/store";
import { useUiStateStore } from "~/uiStateStore";
import type { Project } from "~/types";

import {
  describePullRequestQueryError,
  filterPullRequests,
  getPullRequestEmptyStateCopy,
  getPullRequestStatusTone,
  isPullRequestAuthError,
  isPullRequestGhMissingError,
  PULL_REQUEST_FILTER_LABELS,
  shouldExpandProjectByDefault,
  type PullRequestStatusTone,
} from "./PullRequestsList.logic";

const FILTER_ORDER: readonly GitPullRequestListFilter[] = ["open", "draft", "closed"];

const STATUS_RAIL_CLASS: Record<PullRequestStatusTone, string> = {
  open: "bg-success",
  draft: "bg-muted-foreground/40",
  merged: "bg-violet-500 dark:bg-violet-400",
  closed: "bg-destructive",
};

interface PullRequestsListProps {
  filter: GitPullRequestListFilter;
  selectedProjectId: string | null;
  selectedNumber: number | null;
  onSelect: (input: { projectId: string; number: number }) => void;
  onFilterChange: (filter: GitPullRequestListFilter) => void;
  columnClass: string;
}

type PrQueryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; pullRequests: readonly GitResolvedPullRequest[] };

export function PullRequestsList({
  filter,
  selectedProjectId,
  selectedNumber,
  onSelect,
  onFilterChange,
  columnClass,
}: PullRequestsListProps) {
  const queryClient = useQueryClient();
  const projects = useStore((store) => store.projects);
  const requestProjectAdd = useUiStateStore((state) => state.requestProjectAdd);

  const queriesFlat = useQueries({
    queries: projects.flatMap((project) =>
      FILTER_ORDER.map((filterKey) =>
        gitOpenPullRequestsQueryOptions({ cwd: project.cwd, filter: filterKey }),
      ),
    ),
  });

  const queriesByFilter = useMemo(() => {
    const grouped: Record<GitPullRequestListFilter, ReadonlyArray<(typeof queriesFlat)[number]>> = {
      open: [],
      draft: [],
      closed: [],
    };
    for (const [index, query] of queriesFlat.entries()) {
      const filterKey = FILTER_ORDER[index % FILTER_ORDER.length]!;
      (grouped[filterKey] as Array<(typeof queriesFlat)[number]>).push(query);
    }
    return grouped;
  }, [queriesFlat]);

  const queries = queriesByFilter[filter];

  const filterCounts = useMemo<Record<GitPullRequestListFilter, number | null>>(() => {
    const entries = {} as Record<GitPullRequestListFilter, number | null>;
    for (const filterKey of FILTER_ORDER) {
      const queriesForFilter = queriesByFilter[filterKey];
      if (queriesForFilter.some((query) => query.isLoading)) {
        entries[filterKey] = null;
        continue;
      }
      let total = 0;
      for (const query of queriesForFilter) {
        if (query.data) {
          total += filterPullRequests(query.data.pullRequests, filterKey).length;
        }
      }
      entries[filterKey] = total;
    }
    return entries;
  }, [queriesByFilter]);

  const [projectOpenOverrides, setProjectOpenOverrides] = useState<
    Readonly<Record<string, boolean>>
  >({});

  const setProjectOpen = useCallback((projectId: string, open: boolean) => {
    setProjectOpenOverrides((previous) => {
      if (previous[projectId] === open) return previous;
      return { ...previous, [projectId]: open };
    });
  }, []);

  const projectStates = useMemo<
    ReadonlyArray<{
      project: Project;
      state: PrQueryState;
      visiblePullRequests: readonly GitResolvedPullRequest[];
    }>
  >(() => {
    return projects.map((project, index) => {
      const query = queries[index];
      if (!query) {
        return { project, state: { status: "loading" }, visiblePullRequests: [] };
      }
      if (query.isError) {
        return {
          project,
          state: { status: "error", message: describePullRequestQueryError(query.error) },
          visiblePullRequests: [],
        };
      }
      if (!query.data) {
        return { project, state: { status: "loading" }, visiblePullRequests: [] };
      }
      const visiblePullRequests = filterPullRequests(query.data.pullRequests, filter);
      return {
        project,
        state: {
          status: "success",
          pullRequests: query.data.pullRequests,
        },
        visiblePullRequests,
      };
    });
  }, [filter, projects, queries]);

  const totalPullRequests = projectStates.reduce(
    (sum, entry) => sum + entry.visiblePullRequests.length,
    0,
  );
  const allSettled = queries.every((query) => !query.isLoading);
  const allZero = allSettled && totalPullRequests === 0;
  const emptyStateCopy = getPullRequestEmptyStateCopy(filter);

  const refreshAll = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: gitQueryKeys.all });
  }, [queryClient]);

  if (projects.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GitPullRequestIcon />
            </EmptyMedia>
            <EmptyTitle className="text-pretty">No projects registered</EmptyTitle>
            <EmptyDescription className="text-pretty">
              Open a project in ShioriCode to see its pull requests here.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={requestProjectAdd}>Open Folder</Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center border-b border-border/40">
        <div className={cn(columnClass, "flex h-full items-center justify-between gap-3")}>
          <div
            role="radiogroup"
            aria-label="Pull request filter"
            className="inline-flex items-center rounded-full border border-border/60 bg-background/60 p-[2px]"
          >
            {FILTER_ORDER.map((value) => {
              const isActive = value === filter;
              const count = filterCounts[value];
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  onClick={() => onFilterChange(value)}
                  className={cn(
                    "inline-flex h-5 items-center gap-1 rounded-full px-2 text-[10.5px] font-medium leading-none transition-colors",
                    isActive
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span>{PULL_REQUEST_FILTER_LABELS[value]}</span>
                  <span className="text-[9px] tabular-nums opacity-70">{count ?? "–"}</span>
                </button>
              );
            })}
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={refreshAll}
                  aria-label="Refresh pull requests"
                >
                  <RefreshCwIcon className="size-3.5" aria-hidden />
                </Button>
              }
            />
            <TooltipPopup>Refresh</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn(columnClass, "flex flex-col gap-1 pt-2 pb-4")}>
          {projectStates.map(({ project, state, visiblePullRequests }) => {
            const count = state.status === "success" ? visiblePullRequests.length : null;
            const isOpen =
              projectOpenOverrides[project.id] ??
              shouldExpandProjectByDefault({
                status: state.status,
                visiblePullRequestsCount: count ?? 0,
              });

            return (
              <Collapsible
                key={project.id}
                open={isOpen}
                onOpenChange={(open) => setProjectOpen(project.id, open)}
              >
                <CollapsibleTrigger
                  className={cn(
                    "group/section sticky top-0 z-10 flex w-full items-center gap-2 px-1 py-2",
                    isElectron
                      ? "bg-background text-left"
                      : "bg-background/75 backdrop-blur-md text-left",
                    "text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70",
                    "transition-colors hover:text-foreground",
                  )}
                >
                  <ChevronDownIcon
                    className={cn(
                      "size-3 shrink-0 opacity-50 transition-transform",
                      isOpen ? "rotate-0" : "-rotate-90",
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {count !== null ? (
                    <span className="shrink-0 tabular-nums text-muted-foreground/40 normal-case tracking-normal">
                      {count}
                    </span>
                  ) : state.status === "loading" ? (
                    <Skeleton className="h-2 w-3 rounded-full" />
                  ) : null}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ProjectPullRequestRows
                    filter={filter}
                    projectId={project.id}
                    state={state}
                    visiblePullRequests={visiblePullRequests}
                    selectedProjectId={selectedProjectId}
                    selectedNumber={selectedNumber}
                    onSelect={onSelect}
                  />
                </CollapsibleContent>
              </Collapsible>
            );
          })}

          {allZero ? (
            <div className="p-6">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <GitPullRequestIcon />
                  </EmptyMedia>
                  <EmptyTitle className="text-pretty">{emptyStateCopy.title}</EmptyTitle>
                  <EmptyDescription className="text-pretty">
                    {emptyStateCopy.description}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

function ProjectPullRequestRows({
  filter,
  projectId,
  state,
  visiblePullRequests,
  selectedProjectId,
  selectedNumber,
  onSelect,
}: {
  filter: GitPullRequestListFilter;
  projectId: string;
  state: PrQueryState;
  visiblePullRequests: readonly GitResolvedPullRequest[];
  selectedProjectId: string | null;
  selectedNumber: number | null;
  onSelect: (input: { projectId: string; number: number }) => void;
}) {
  if (state.status === "loading") {
    return (
      <ul className="flex flex-col gap-1 pb-2">
        {[0, 1, 2].map((index) => (
          <li key={index} className="flex items-stretch gap-3 py-2 pl-4 pr-2">
            <span className="w-[3px] shrink-0 rounded-full bg-muted-foreground/15" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-3 w-[70%] rounded-full" />
              <Skeleton className="h-2 w-[40%] rounded-full" />
            </div>
          </li>
        ))}
      </ul>
    );
  }

  if (state.status === "error") {
    const isAuth = isPullRequestAuthError(state.message);
    const isMissing = isPullRequestGhMissingError(state.message);
    return (
      <div className="flex flex-col gap-1.5 px-4 pb-3 pt-1">
        <p className="text-xs text-destructive/90 text-pretty">
          {isMissing
            ? "GitHub CLI (gh) is required to list pull requests."
            : isAuth
              ? "GitHub CLI is not authenticated."
              : state.message}
        </p>
        {isMissing ? (
          <a
            href="https://cli.github.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary underline-offset-2 hover:underline"
          >
            Install GitHub CLI
          </a>
        ) : isAuth ? (
          <p className="text-xs text-muted-foreground">
            Run <span className="font-mono">gh auth login</span> in a terminal.
          </p>
        ) : null}
      </div>
    );
  }

  if (visiblePullRequests.length === 0) {
    return (
      <p className="px-4 pb-3 pt-1 text-xs text-muted-foreground/60">
        {getPullRequestEmptyStateCopy(filter).title}.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5 pb-2">
      {visiblePullRequests.map((pr) => {
        const isActive = selectedProjectId === projectId && selectedNumber === pr.number;
        return (
          <li key={pr.number}>
            <PullRequestRow
              pullRequest={pr}
              isActive={isActive}
              onSelect={() => onSelect({ projectId, number: pr.number })}
            />
          </li>
        );
      })}
    </ul>
  );
}

function PullRequestRow({
  pullRequest,
  isActive,
  onSelect,
}: {
  pullRequest: GitResolvedPullRequest;
  isActive: boolean;
  onSelect: () => void;
}) {
  const tone = getPullRequestStatusTone(pullRequest);
  const railClass = STATUS_RAIL_CLASS[tone];

  return (
    <button
      type="button"
      onClick={onSelect}
      data-active={isActive || undefined}
      className={cn(
        "group/pr flex w-full min-w-0 items-stretch gap-3 rounded-md py-2 pl-2 pr-2.5 text-left transition-colors",
        "hover:bg-sidebar-accent/50",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "data-[active=true]:bg-sidebar-accent",
      )}
    >
      <span
        className={cn(
          "w-[3px] shrink-0 self-stretch rounded-full transition-opacity",
          railClass,
          "opacity-80 group-hover/pr:opacity-100 group-data-[active=true]/pr:opacity-100",
        )}
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight text-foreground">
            {pullRequest.title}
          </span>
          {pullRequest.isDraft ? (
            <span className="shrink-0 rounded-sm border border-border/60 px-1 py-px text-[9px] font-medium uppercase tracking-wider text-muted-foreground/80">
              Draft
            </span>
          ) : null}
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/50">
            #{pullRequest.number}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground/60">
          <span className="truncate font-mono">{pullRequest.headBranch}</span>
          <span className="shrink-0 opacity-60">→</span>
          <span className="truncate font-mono opacity-80">{pullRequest.baseBranch}</span>
        </span>
      </span>
    </button>
  );
}
