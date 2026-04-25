import { createFileRoute } from "@tanstack/react-router";

import { ComputerUseSettingsPanel } from "../components/settings/ComputerUseSettingsPanel";

export const Route = createFileRoute("/settings/computer-use")({
  component: ComputerUseSettingsPanel,
});
