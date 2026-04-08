import { createFileRoute } from "@tanstack/react-router";

import { ThemeBuilderPanel } from "../components/settings/ThemeBuilder";

export const Route = createFileRoute("/settings/theme-builder")({
  component: ThemeBuilderPanel,
});
