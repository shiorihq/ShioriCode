import type { GitPullRequestListFilter } from "contracts";
import { createFileRoute } from "@tanstack/react-router";

import { PullRequestsView } from "~/components/pullRequests/PullRequestsView";

export interface PullRequestsSearch {
  projectId?: string;
  number?: number;
  filter?: GitPullRequestListFilter;
}

export const Route = createFileRoute("/pull-requests")({
  component: PullRequestsRouteView,
  validateSearch: (search: Record<string, unknown>): PullRequestsSearch => {
    const out: PullRequestsSearch = {};
    const rawFilter = search.filter;
    if (rawFilter === "open" || rawFilter === "closed" || rawFilter === "draft") {
      out.filter = rawFilter;
    }
    const projectId = search.projectId;
    if (typeof projectId === "string" && projectId.length > 0) {
      out.projectId = projectId;
    }
    const rawNumber = search.number;
    if (typeof rawNumber === "number" && Number.isFinite(rawNumber) && rawNumber > 0) {
      out.number = rawNumber;
    } else if (typeof rawNumber === "string") {
      const parsed = Number.parseInt(rawNumber, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        out.number = parsed;
      }
    }
    return out;
  },
});

function PullRequestsRouteView() {
  const search = Route.useSearch();
  return <PullRequestsView search={search} />;
}
