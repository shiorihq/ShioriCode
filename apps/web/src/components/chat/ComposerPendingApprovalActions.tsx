import { type ApprovalRequestId, type ProviderApprovalDecision } from "contracts";
import { IconSpinnerLoaderOutline24 as Loader2Icon } from "nucleo-core-outline-24";
import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { Button } from "../ui/button";

interface ComposerPendingApprovalActionsProps {
  approval: PendingApproval;
  isResponding: boolean;
  respondingDecision: ProviderApprovalDecision | null;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
}

type ComposerApprovalAction = {
  readonly key:
    | "accept"
    | "acceptForSession"
    | "decline"
    | "cancel"
    | "acceptWithExecpolicyAmendment"
    | "applyNetworkPolicyAmendment";
  readonly label: string;
  readonly variant: "default" | "outline" | "ghost" | "destructive-outline";
  readonly decision: ProviderApprovalDecision;
};

const DEFAULT_APPROVAL_ACTIONS: ReadonlyArray<ComposerApprovalAction> = [
  {
    key: "cancel",
    label: "Cancel turn",
    variant: "ghost",
    decision: "cancel",
  },
  {
    key: "decline",
    label: "Decline",
    variant: "destructive-outline",
    decision: "decline",
  },
  {
    key: "acceptForSession",
    label: "Auto-approve for session",
    variant: "outline",
    decision: "acceptForSession",
  },
  {
    key: "accept",
    label: "Approve once",
    variant: "default",
    decision: "accept",
  },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length === value.length ? strings : null;
}

function proposedExecpolicyAmendment(data: unknown): string[] | null {
  const record = asRecord(data);
  const proposed = record?.proposedExecpolicyAmendment;
  const proposedRecord = asRecord(proposed);
  return (
    asStringArray(proposed) ??
    asStringArray(proposedRecord?.execpolicy_amendment) ??
    asStringArray(proposedRecord?.execpolicyAmendment)
  );
}

function proposedNetworkPolicyAmendment(data: unknown): { host: string; action: "allow" } | null {
  const record = asRecord(data);
  const amendments = Array.isArray(record?.proposedNetworkPolicyAmendments)
    ? record.proposedNetworkPolicyAmendments
    : [];
  const [firstAmendment] = amendments;
  const amendment = asRecord(firstAmendment);
  const hostFromAmendment = typeof amendment?.host === "string" ? amendment.host.trim() : "";
  if (hostFromAmendment.length > 0) {
    return { host: hostFromAmendment, action: "allow" };
  }

  const networkContext = asRecord(record?.networkApprovalContext);
  const hostFromContext =
    typeof networkContext?.host === "string" ? networkContext.host.trim() : "";
  return hostFromContext.length > 0 ? { host: hostFromContext, action: "allow" } : null;
}

function codexActionFromAvailableDecision(
  availableDecision: string,
  approval: PendingApproval,
): ComposerApprovalAction | null {
  switch (availableDecision) {
    case "accept":
      return DEFAULT_APPROVAL_ACTIONS.find((action) => action.key === "accept") ?? null;
    case "acceptForSession":
      return DEFAULT_APPROVAL_ACTIONS.find((action) => action.key === "acceptForSession") ?? null;
    case "decline":
      return DEFAULT_APPROVAL_ACTIONS.find((action) => action.key === "decline") ?? null;
    case "cancel":
      return DEFAULT_APPROVAL_ACTIONS.find((action) => action.key === "cancel") ?? null;
    case "acceptWithExecpolicyAmendment": {
      const execpolicyAmendment = proposedExecpolicyAmendment(approval.data);
      if (!execpolicyAmendment || execpolicyAmendment.length === 0) {
        return null;
      }
      return {
        key: "acceptWithExecpolicyAmendment",
        label: "Approve and remember command",
        variant: "outline",
        decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: execpolicyAmendment,
          },
        },
      };
    }
    case "applyNetworkPolicyAmendment": {
      const networkPolicyAmendment = proposedNetworkPolicyAmendment(approval.data);
      if (!networkPolicyAmendment) {
        return null;
      }
      return {
        key: "applyNetworkPolicyAmendment",
        label: "Allow network host",
        variant: "outline",
        decision: {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: networkPolicyAmendment,
          },
        },
      };
    }
    default:
      return null;
  }
}

export function resolveComposerApprovalActions(
  approval: PendingApproval,
): ReadonlyArray<ComposerApprovalAction> {
  const data = asRecord(approval.data);
  const availableDecisions = asStringArray(data?.availableDecisions);
  if (!availableDecisions || availableDecisions.length === 0) {
    return DEFAULT_APPROVAL_ACTIONS;
  }

  const resolved = availableDecisions.flatMap((availableDecision) => {
    const action = codexActionFromAvailableDecision(availableDecision, approval);
    return action ? [action] : [];
  });
  return resolved.length > 0 ? resolved : DEFAULT_APPROVAL_ACTIONS;
}

function isRespondingToAction(
  respondingDecision: ProviderApprovalDecision | null,
  action: ComposerApprovalAction,
): boolean {
  if (respondingDecision === null) {
    return false;
  }
  if (typeof respondingDecision === "string") {
    return respondingDecision === action.decision;
  }
  if (typeof action.decision === "string") {
    return false;
  }
  return action.key in respondingDecision;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  approval,
  isResponding,
  respondingDecision,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const actions = resolveComposerApprovalActions(approval);
  return (
    <>
      {actions.map((action) => (
        <Button
          key={action.key}
          size="sm"
          variant={action.variant}
          disabled={isResponding}
          onClick={() => void onRespondToApproval(approval.requestId, action.decision)}
        >
          {isRespondingToAction(respondingDecision, action) ? (
            <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
          ) : null}
          {action.label}
        </Button>
      ))}
    </>
  );
});
