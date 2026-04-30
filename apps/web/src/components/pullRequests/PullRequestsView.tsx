import type { GitPullRequestListFilter } from "contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

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
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="relative isolate flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background [contain:paint]">
          {isElectron ? (
            <div className="drag-region flex h-[52px] shrink-0 items-center" />
          ) : (
            <header className="flex h-12 shrink-0 items-center">
              <div className={cn(columnClass, "flex h-full items-center")} />
            </header>
          )}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
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
