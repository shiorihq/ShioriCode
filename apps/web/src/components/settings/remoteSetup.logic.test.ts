import { describe, expect, it } from "vitest";
import type { RemoteLinkStatus, RemoteTailscaleStatus } from "contracts";

import { credentialsIssue, prerequisiteChecks, prerequisitesSatisfied } from "./remoteSetup.logic";

function tailscale(overrides: Partial<RemoteTailscaleStatus> = {}): {
  tailscale: RemoteTailscaleStatus;
  link: RemoteLinkStatus;
} {
  return {
    link: {
      accountLinked: false,
      connectorInstalled: false,
      connectorRunning: false,
      endpoint: null,
      lastError: null,
    },
    tailscale: {
      installed: true,
      running: true,
      backendState: "Running",
      dnsName: "machine.tailnet.ts.net",
      httpsEnabled: true,
      ...overrides,
    },
  };
}

describe("prerequisiteChecks", () => {
  it("requires a linked Shiori account for Link", () => {
    const status = tailscale();
    expect(prerequisitesSatisfied("shiori-link", status)).toBe(false);
    expect(
      prerequisitesSatisfied("shiori-link", {
        ...status,
        link: { ...status.link, accountLinked: true },
      }),
    ).toBe(true);
  });
  it("passes serve when Tailscale is installed and running", () => {
    expect(prerequisitesSatisfied("tailscale-serve", tailscale())).toBe(true);
    expect(prerequisitesSatisfied("tailscale-serve", tailscale({ httpsEnabled: false }))).toBe(
      true,
    );
  });

  it("fails with an install link when Tailscale is missing", () => {
    const checks = prerequisiteChecks(
      "tailscale-serve",
      tailscale({ installed: false, running: false, backendState: null }),
    );
    const installed = checks.find((check) => check.id === "installed");
    expect(installed?.ok).toBe(false);
    expect(installed?.href).toContain("tailscale.com/download");
  });

  it("tailors the hint when the daemon needs a login", () => {
    const checks = prerequisiteChecks(
      "tailscale-serve",
      tailscale({ running: false, backendState: "NeedsLogin" }),
    );
    expect(checks.find((check) => check.id === "running")?.hint).toMatch(/sign in/i);
  });

  it("requires tailnet HTTPS only for funnel", () => {
    const noHttps = tailscale({ httpsEnabled: false });
    expect(prerequisitesSatisfied("tailscale-funnel", noHttps)).toBe(false);
    const https = prerequisiteChecks("tailscale-funnel", noHttps).find(
      (check) => check.id === "https",
    );
    expect(https?.href).toContain("admin/dns");
  });
});

describe("credentialsIssue", () => {
  const base = { username: "owner", password: "longenough", confirm: "longenough" };

  it("passes a valid new credential and any kept existing one", () => {
    expect(credentialsIssue({ ...base, keepExisting: false })).toBeNull();
    expect(
      credentialsIssue({ username: "", password: "", confirm: "", keepExisting: true }),
    ).toBeNull();
  });

  it("rejects missing username, short passwords, and mismatches", () => {
    expect(credentialsIssue({ ...base, username: "  ", keepExisting: false })).toMatch(/username/i);
    expect(
      credentialsIssue({ ...base, password: "short", confirm: "short", keepExisting: false }),
    ).toMatch(/at least 8/);
    expect(credentialsIssue({ ...base, confirm: "different", keepExisting: false })).toMatch(
      /don't match/,
    );
  });
});
