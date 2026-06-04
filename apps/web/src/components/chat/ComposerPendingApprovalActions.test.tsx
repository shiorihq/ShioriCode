import { ApprovalRequestId } from "contracts";
import { describe, expect, it } from "vitest";
import { type PendingApproval } from "../../session-logic";
import { resolveComposerApprovalActions } from "./ComposerPendingApprovalActions";

function makeApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    requestId: ApprovalRequestId.makeUnsafe("req-approval-1"),
    requestKind: "command",
    createdAt: "2026-02-23T00:00:01.000Z",
    ...overrides,
  };
}

describe("resolveComposerApprovalActions", () => {
  it("falls back to legacy approval actions when Codex does not provide decisions", () => {
    const actions = resolveComposerApprovalActions(makeApproval());

    expect(actions.map((action) => action.label)).toEqual([
      "Cancel turn",
      "Decline",
      "Auto-approve for session",
      "Approve once",
    ]);
    expect(actions.map((action) => action.decision)).toEqual([
      "cancel",
      "decline",
      "acceptForSession",
      "accept",
    ]);
  });

  it("uses Codex availableDecisions to build network policy amendment actions", () => {
    const actions = resolveComposerApprovalActions(
      makeApproval({
        data: {
          availableDecisions: ["applyNetworkPolicyAmendment", "decline"],
          proposedNetworkPolicyAmendments: [
            {
              host: "example.com",
              action: "allow",
            },
          ],
        },
      }),
    );

    expect(actions.map((action) => action.label)).toEqual(["Allow network host", "Decline"]);
    expect(actions[0]?.decision).toEqual({
      applyNetworkPolicyAmendment: {
        network_policy_amendment: {
          host: "example.com",
          action: "allow",
        },
      },
    });
    expect(actions[1]?.decision).toBe("decline");
  });

  it("uses Codex availableDecisions to build exec policy amendment actions", () => {
    const actions = resolveComposerApprovalActions(
      makeApproval({
        data: {
          availableDecisions: ["acceptWithExecpolicyAmendment", "accept", "decline"],
          proposedExecpolicyAmendment: {
            execpolicy_amendment: ['allow: ["git", "status"]'],
          },
        },
      }),
    );

    expect(actions.map((action) => action.label)).toEqual([
      "Approve and remember command",
      "Approve once",
      "Decline",
    ]);
    expect(actions[0]?.decision).toEqual({
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ['allow: ["git", "status"]'],
      },
    });
  });
});
