import { createFileRoute } from "@tanstack/react-router";

import { AccountPanel } from "../components/settings/AccountPanel";

export const Route = createFileRoute("/settings/account")({
  component: AccountPanel,
});
