import { createFileRoute } from "@tanstack/react-router";

import { FeedbackPanel } from "../components/settings/FeedbackPanel";

export const Route = createFileRoute("/settings/feedback")({
  component: FeedbackPanel,
});
