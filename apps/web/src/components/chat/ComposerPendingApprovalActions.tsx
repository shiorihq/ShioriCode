import { type ApprovalRequestId, type ProviderApprovalDecision } from "contracts";
import { Loader2Icon } from "lucide-react";
import { memo } from "react";
import { Button } from "../ui/button";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  respondingDecision: ProviderApprovalDecision | null;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  respondingDecision,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "cancel")}
      >
        {respondingDecision === "cancel" ? (
          <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
        ) : null}
        Cancel turn
      </Button>
      <Button
        size="sm"
        variant="destructive-outline"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "decline")}
      >
        {respondingDecision === "decline" ? (
          <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
        ) : null}
        Decline
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "acceptForSession")}
      >
        {respondingDecision === "acceptForSession" ? (
          <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
        ) : null}
        Auto-approve for session
      </Button>
      <Button
        size="sm"
        variant="default"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "accept")}
      >
        {respondingDecision === "accept" ? (
          <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
        ) : null}
        Approve once
      </Button>
    </>
  );
});
