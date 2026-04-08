import {
  ProviderAcceptWithExecpolicyAmendmentDecision,
  ProviderSimpleApprovalDecision,
  type ProviderApprovalDecision,
  type ProviderSimpleApprovalDecision as ProviderSimpleApprovalDecisionType,
} from "contracts";
import { Schema } from "effect";

const isSimpleProviderApprovalDecision = Schema.is(ProviderSimpleApprovalDecision);
const isProviderAcceptWithExecpolicyAmendmentDecision = Schema.is(
  ProviderAcceptWithExecpolicyAmendmentDecision,
);

export function isSimpleApprovalDecision(
  decision: ProviderApprovalDecision | unknown,
): decision is ProviderSimpleApprovalDecisionType {
  return isSimpleProviderApprovalDecision(decision);
}

export function normalizeProviderApprovalDecision(
  decision: ProviderApprovalDecision | unknown,
): ProviderSimpleApprovalDecisionType | null {
  if (isSimpleProviderApprovalDecision(decision)) {
    return decision;
  }
  if (isProviderAcceptWithExecpolicyAmendmentDecision(decision)) {
    return "accept";
  }
  return null;
}
