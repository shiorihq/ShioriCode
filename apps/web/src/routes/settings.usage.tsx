import { createFileRoute } from "@tanstack/react-router";

import { UsagePanel } from "../components/settings/UsagePanel";

export const Route = createFileRoute("/settings/usage")({
  component: UsagePanel,
});
