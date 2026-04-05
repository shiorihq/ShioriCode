import { createFileRoute } from "@tanstack/react-router";

import { CreditsPanel } from "../components/settings/CreditsPanel";

export const Route = createFileRoute("/settings/credits")({
  component: CreditsPanel,
});
