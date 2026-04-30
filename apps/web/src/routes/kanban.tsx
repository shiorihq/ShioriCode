import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { KanbanView } from "~/components/kanban/KanbanView";
import { useSettings } from "~/hooks/useSettings";
import { useServerConfig } from "~/rpc/serverState";

export interface KanbanSearch {
  projectId?: string;
}

export const Route = createFileRoute("/kanban")({
  component: KanbanRouteView,
  validateSearch: (search: Record<string, unknown>): KanbanSearch => {
    const out: KanbanSearch = {};
    const projectId = search.projectId;
    if (typeof projectId === "string" && projectId.length > 0) {
      out.projectId = projectId;
    }
    return out;
  },
});

function KanbanRouteView() {
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
