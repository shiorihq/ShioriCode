import { createFileRoute } from "@tanstack/react-router";

import { McpPanel } from "../components/settings/McpPanel";

export const Route = createFileRoute("/settings/mcp")({
  component: McpPanel,
});
