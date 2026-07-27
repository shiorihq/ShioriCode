import type { GitPullRequestListFilter } from "contracts";
import { useNavigate } from "@tanstack/react-router";
import { IconBranchMergeOutline24 as GitPullRequestIcon } from "nucleo-core-outline-24";
import { type CSSProperties, useCallback } from "react";

import { SidebarInset } from "~/components/ui/sidebar";
import { isElectron } from "~/env";
import { cn } from "~/lib/utils";

import { PullRequestDetailDockedSidebar } from "./PullRequestDetailDockedSidebar";
import { PullRequestsList } from "./PullRequestsList";

interface PullRequestsViewProps {
  search: {
    projectId?: string | undefined;
    number?: number | undefined;
    filter?: GitPullRequestListFilter | undefined;
  };
}

export function PullRequestsView({ search }: PullRequestsViewProps) {
  const navigate = useNavigate();
  const filter = search.filter ?? "open";

  const selectPullRequest = useCallback(
    (input: { projectId: string; number: number }) => {
      void navigate({
        to: "/pull-requests",
        search: { projectId: input.projectId, number: input.number, filter },
      });
    },
    [filter, navigate],
  );

  const clearSelection = useCallback(() => {
    void navigate({ to: "/pull-requests", search: { filter } });
  }, [filter, navigate]);

  const changeFilter = useCallback(
    (nextFilter: GitPullRequestListFilter) => {
      void navigate({ to: "/pull-requests", search: { filter: nextFilter } });
    },
    [navigate],
  );

  const selectedProjectId = search.projectId ?? null;
  const selectedNumber = search.number ?? null;
  const detailOpen = selectedProjectId !== null && selectedNumber !== null;

  const columnClass = detailOpen ? "w-full px-4" : "mx-auto w-full max-w-3xl px-4";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none text-foreground">
      <div className="relative isolate flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-canvas [contain:paint]">
          {isElectron ? (
            <div data-app-chrome className="drag-region flex h-[52px] shrink-0 items-center">
              <div className={cn(columnClass, "flex h-full items-center gap-2 select-none")}>
                <GitPullRequestIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <h1 className="text-sm font-semibold tracking-tight text-foreground">
                  Pull Requests
                </h1>
              </div>
            </div>
          ) : (
            <header data-app-chrome className="flex h-12 shrink-0 items-center">
              <div className={cn(columnClass, "flex h-full items-center gap-2")}>
                <GitPullRequestIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <h1 className="text-sm font-semibold tracking-tight text-foreground">
                  Pull Requests
                </h1>
              </div>
            </header>
          )}
          <div
            data-app-reading-plate
            style={
              {
                "--app-reading-width": "100%",
                "--app-reading-plate-radius": "0px",
              } as CSSProperties
            }
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <PullRequestsList
              filter={filter}
              selectedProjectId={selectedProjectId}
              selectedNumber={selectedNumber}
              onSelect={selectPullRequest}
              onFilterChange={changeFilter}
              columnClass={columnClass}
            />
          </div>
        </div>
        <PullRequestDetailDockedSidebar
          filter={filter}
          open={detailOpen}
          projectId={selectedProjectId}
          number={selectedNumber}
          onClose={clearSelection}
        />
      </div>
    </SidebarInset>
  );
}
