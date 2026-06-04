import { describe, expect, it } from "vitest";

import {
  isProviderApprovalAccepted,
  normalizeProviderApprovalDecision,
} from "./providerApprovalDecision.ts";

describe("normalizeProviderApprovalDecision", () => {
  it("normalizes Codex network policy amendments as accepted approvals", () => {
    expect(
      normalizeProviderApprovalDecision({
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            host: "example.com",
            action: "allow",
          },
        },
      }),
    ).toBe("accept");
  });

  it("treats Codex network policy amendments as accepted decisions", () => {
    expect(
      isProviderApprovalAccepted({
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            host: "example.com",
            action: "allow",
          },
        },
      }),
    ).toBe(true);
  });
});
