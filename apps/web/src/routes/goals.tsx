import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { GoalsView } from "~/components/goals/GoalsView";
import { useGoalsFeatureEnabled } from "~/hooks/useGoalsFeatureEnabled";
import { useServerConfig } from "~/rpc/serverState";

export interface GoalsSearch {
  projectId?: string;
}

export const Route = createFileRoute("/goals")({
  component: GoalsRouteView,
  validateSearch: (search: Record<string, unknown>): GoalsSearch => {
    const out: GoalsSearch = {};
    const projectId = search.projectId;
    if (typeof projectId === "string" && projectId.length > 0) {
      out.projectId = projectId;
    }
    return out;
  },
});

function GoalsRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const serverConfig = useServerConfig();
  const goalsEnabled = useGoalsFeatureEnabled();

  useEffect(() => {
    if (serverConfig && !goalsEnabled) {
      void navigate({ to: "/", replace: true });
    }
  }, [goalsEnabled, navigate, serverConfig]);

  if (!serverConfig || !goalsEnabled) {
    return null;
  }

  return <GoalsView projectId={search.projectId ?? null} />;
}
