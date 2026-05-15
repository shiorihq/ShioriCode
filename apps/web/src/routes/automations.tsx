import { createFileRoute } from "@tanstack/react-router";

import { AutomationsView } from "~/components/automations/AutomationsView";
import { type AutomationFilter } from "~/components/automations/automationShared";

export interface AutomationsSearch {
  filter?: AutomationFilter;
}

export const Route = createFileRoute("/automations")({
  component: AutomationsRouteView,
  validateSearch: (search: Record<string, unknown>): AutomationsSearch => {
    const out: AutomationsSearch = {};
    const rawFilter = search.filter;
    if (rawFilter === "all" || rawFilter === "active" || rawFilter === "paused") {
      out.filter = rawFilter;
    }
    return out;
  },
});

function AutomationsRouteView() {
  const search = Route.useSearch();
  return <AutomationsView search={search} />;
}
