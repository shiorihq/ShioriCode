import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { KanbanView } from "~/components/kanban/KanbanView";
import { useSettings } from "~/hooks/useSettings";
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
  const kanbanEnabled = useSettings().kanban.enabled;

  useEffect(() => {
    if (serverConfig && !kanbanEnabled) {
      void navigate({ to: "/", replace: true });
    }
  }, [kanbanEnabled, navigate, serverConfig]);

  if (!serverConfig || !kanbanEnabled) {
    return null;
  }

  return <KanbanView projectId={search.projectId ?? null} />;
}
