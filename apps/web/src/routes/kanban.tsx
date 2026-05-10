import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

export interface KanbanSearch {
  projectId?: string;
}

export const Route = createFileRoute("/kanban")({
  component: KanbanCompatRedirect,
  validateSearch: (search: Record<string, unknown>): KanbanSearch => {
    const out: KanbanSearch = {};
    const projectId = search.projectId;
    if (typeof projectId === "string" && projectId.length > 0) {
      out.projectId = projectId;
    }
    return out;
  },
});

function KanbanCompatRedirect() {
  const search = Route.useSearch();
  const navigate = useNavigate();

  useEffect(() => {
    void navigate({ to: "/goals", search, replace: true });
  }, [navigate, search]);

  return null;
}
