import { createFileRoute } from "@tanstack/react-router";

import { PluginsPanel } from "../components/settings/PluginsPanel";

export const Route = createFileRoute("/settings/plugins")({
  component: PluginsPanel,
});
