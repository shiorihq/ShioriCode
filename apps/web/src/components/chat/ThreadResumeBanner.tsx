import type { OrchestrationThreadResumeState } from "contracts";
import { memo } from "react";
import { CircleAlertIcon, RefreshCwIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

function bannerCopy(resumeState: OrchestrationThreadResumeState): {
  title: string;
  description: string;
  variant: "warning" | "error";
  action?: { label: string; action: "resume" };
} | null {
  switch (resumeState) {
    case "resuming":
      return {
        title: "Restoring thread runtime",
        description: "ShioriCode is reconnecting this thread's provider session.",
        variant: "warning",
      };
    case "needs_resume":
      return {
        title: "Thread needs resume",
        description: "The provider session is no longer attached. Send a message to restore it.",
        variant: "warning",
        action: { label: "Resume", action: "resume" },
      };
    case "unrecoverable":
      return {
        title: "Thread session cannot be restored",
        description:
          "This provider session could not be resumed automatically. Start a new turn to continue safely.",
        variant: "error",
        action: { label: "Start new turn", action: "resume" },
      };
    case "resumed":
    default:
      return null;
  }
}

export const ThreadResumeBanner = memo(function ThreadResumeBanner({
  resumeState,
  onResumeAction,
}: {
  resumeState: OrchestrationThreadResumeState;
  onResumeAction?: () => void;
}) {
  const copy = bannerCopy(resumeState);
  if (!copy) {
    return null;
  }

  return (
    <div className="mx-auto max-w-3xl pt-3">
      <Alert variant={copy.variant}>
        <CircleAlertIcon />
        <AlertTitle>{copy.title}</AlertTitle>
        <AlertDescription>{copy.description}</AlertDescription>
        {copy.action && onResumeAction ? (
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              className={
                copy.variant === "error"
                  ? "border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  : ""
              }
              onClick={onResumeAction}
            >
              {copy.action.action === "resume" && <RefreshCwIcon className="mr-1 size-3" />}
              {copy.action.label}
            </Button>
          </AlertAction>
        ) : null}
      </Alert>
    </div>
  );
});
