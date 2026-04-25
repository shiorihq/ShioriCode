import { createFileRoute } from "@tanstack/react-router";

import { MobilePairingPanel } from "../components/settings/MobilePairingPanel";

export const Route = createFileRoute("/settings/mobile")({
  component: MobilePairingPanel,
});
