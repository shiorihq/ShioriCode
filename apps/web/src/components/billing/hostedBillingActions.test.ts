import type { NativeApi } from "contracts";
import { describe, expect, it, vi } from "vitest";

import { openHostedBillingCheckout, openHostedBillingPortal } from "./hostedBillingActions";

function makeApi(): Pick<NativeApi, "server" | "shell"> {
  return {
    server: {
      getConfig: vi.fn(),
      refreshProviders: vi.fn(),
      upsertKeybinding: vi.fn(),
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      listMcpServers: vi.fn(),
      authenticateMcpServer: vi.fn(),
      removeMcpServer: vi.fn(),
      listSkills: vi.fn(),
      removeSkill: vi.fn(),
      setShioriAuthToken: vi.fn(),
      getProviderUsage: vi.fn(),
      getHostedBillingSnapshot: vi.fn(),
      hostedOAuthStart: vi.fn(),
      hostedPasswordAuth: vi.fn(),
      createHostedBillingCheckout: vi.fn(async () => ({
        sessionId: "cs_test_1",
        url: "https://checkout.stripe.test/session",
      })),
      createHostedBillingPortal: vi.fn(async () => ({
        url: "https://billing.stripe.test/session",
      })),
    },
    shell: {
      openInEditor: vi.fn(),
      openExternal: vi.fn(async () => undefined),
    },
  };
}

describe("hostedBillingActions", () => {
  it("opens checkout URLs returned by the local server bridge", async () => {
    const api = makeApi();

    await openHostedBillingCheckout(api, { planId: "pro", isAnnual: true });

    expect(api.server.createHostedBillingCheckout).toHaveBeenCalledWith({
      planId: "pro",
      isAnnual: true,
    });
    expect(api.shell.openExternal).toHaveBeenCalledWith("https://checkout.stripe.test/session");
  });

  it("opens billing portal URLs returned by the local server bridge", async () => {
    const api = makeApi();

    await openHostedBillingPortal(api, "manage");

    expect(api.server.createHostedBillingPortal).toHaveBeenCalledWith("manage");
    expect(api.shell.openExternal).toHaveBeenCalledWith("https://billing.stripe.test/session");
  });
});
