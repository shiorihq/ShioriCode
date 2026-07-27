import { describe, expect, it, vi } from "vitest";

import {
  disableExposureSafely,
  isAuthenticationConfiguredForExposure,
  persistLinkIntentAfterTailscaleTeardown,
  remoteStartupCleanupDecision,
  teardownExposureOnce,
} from "./RemoteAccess";

const runningTailscale = {
  installed: true,
  running: true,
  backendState: "Running",
  dnsName: "host.tailnet.ts.net",
  httpsEnabled: true,
} as const;

describe("teardownExposureOnce", () => {
  it("does not treat an unreachable tailscaled daemon as cleared", async () => {
    const disableLink = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const observe = vi.fn(async () => ({ method: "off", url: null }) as const);

    const cleared = await teardownExposureOnce(
      { cli: "/usr/bin/tailscale", port: 3773, disableLink },
      {
        detect: async () => ({ ...runningTailscale, running: false }),
        release,
        observe,
      },
    );

    expect(cleared).toBe(false);
    expect(disableLink).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it("requires a CLI before considering persisted serve state cleared", async () => {
    const cleared = await teardownExposureOnce(
      { cli: null, port: 3773, disableLink: async () => undefined },
      {
        detect: async () => runningTailscale,
        release: async () => undefined,
        observe: async () => ({ method: "off", url: null }),
      },
    );
    expect(cleared).toBe(false);
  });

  it("re-reads serve state after reset and only succeeds when it is off", async () => {
    const release = vi.fn(async () => undefined);
    const stillExposed = await teardownExposureOnce(
      { cli: "/usr/bin/tailscale", port: 3773, disableLink: async () => undefined },
      {
        detect: async () => runningTailscale,
        release,
        observe: async () => ({ method: "tailscale-funnel", url: "https://host.example" }),
      },
    );
    const cleared = await teardownExposureOnce(
      { cli: "/usr/bin/tailscale", port: 3773, disableLink: async () => undefined },
      {
        detect: async () => runningTailscale,
        release,
        observe: async () => ({ method: "off", url: null }),
      },
    );

    expect(stillExposed).toBe(false);
    expect(cleared).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not collapse a failed confirmation read into off", async () => {
    const cleared = await teardownExposureOnce(
      { cli: "/usr/bin/tailscale", port: 3773, disableLink: async () => undefined },
      {
        detect: async () => runningTailscale,
        release: async () => undefined,
        observe: async () => null,
      },
    );
    expect(cleared).toBe(false);
  });

  it("allows Link-only teardown when no Tailscale installation exists", async () => {
    const cleared = await teardownExposureOnce(
      {
        cli: null,
        port: 3773,
        disableLink: async () => undefined,
        requireTailscaleConfirmation: false,
      },
      {
        detect: async () => runningTailscale,
        release: async () => undefined,
        observe: async () => ({ method: "off", url: null }),
      },
    );

    expect(cleared).toBe(true);
  });
});

describe("disableExposureSafely", () => {
  it("does not persist off or lower authentication when Tailscale cannot be confirmed off", async () => {
    const disableLink = vi.fn(async () => undefined);
    const persistOff = vi.fn();
    const lowerAuth = vi.fn();

    await expect(
      disableExposureSafely(
        {
          cli: "/usr/bin/tailscale",
          port: 3773,
          requireTailscaleConfirmation: true,
          disableLink,
          persistOff,
          lowerAuth,
        },
        {
          detect: async () => ({ ...runningTailscale, running: false }),
          release: async () => undefined,
          observe: async () => ({ method: "off", url: null }),
        },
      ),
    ).rejects.toThrow("could not be confirmed off");

    expect(disableLink).not.toHaveBeenCalled();
    expect(persistOff).not.toHaveBeenCalled();
    expect(lowerAuth).not.toHaveBeenCalled();
  });

  it("does not persist off or lower authentication when Link shutdown rejects", async () => {
    const persistOff = vi.fn();
    const lowerAuth = vi.fn();

    await expect(
      disableExposureSafely(
        {
          cli: null,
          port: 3773,
          requireTailscaleConfirmation: false,
          disableLink: async () => {
            throw new Error("connector is still alive");
          },
          persistOff,
          lowerAuth,
        },
        {
          detect: async () => runningTailscale,
          release: async () => undefined,
          observe: async () => ({ method: "off", url: null }),
        },
      ),
    ).rejects.toThrow(/still alive/i);

    expect(persistOff).not.toHaveBeenCalled();
    expect(lowerAuth).not.toHaveBeenCalled();
  });
});

describe("remoteStartupCleanupDecision", () => {
  it("forces cleanup for an orphan record even when persisted intent is clean off", () => {
    expect(
      remoteStartupCleanupDecision({
        desiredMethod: "off",
        stateNeedsCleanup: false,
        requiresTailscaleConfirmation: false,
        authenticationConfigured: false,
        unsafeNoAuth: false,
        connectorCleanupRequired: true,
      }),
    ).toEqual({ cleanupRequired: true, connectorOnlyCleanup: true });
  });

  it("does not waive Tailscale confirmation when Funnel intent also needs teardown", () => {
    expect(
      remoteStartupCleanupDecision({
        desiredMethod: "tailscale-funnel",
        stateNeedsCleanup: false,
        requiresTailscaleConfirmation: false,
        authenticationConfigured: false,
        unsafeNoAuth: false,
        connectorCleanupRequired: true,
      }),
    ).toEqual({ cleanupRequired: true, connectorOnlyCleanup: false });
  });
});

describe("persistLinkIntentAfterTailscaleTeardown", () => {
  it("does not overwrite Tailscale provenance when teardown cannot be confirmed", async () => {
    const persistLinkIntent = vi.fn();

    await expect(
      persistLinkIntentAfterTailscaleTeardown(
        {
          cli: "/usr/bin/tailscale",
          port: 3773,
          requiresTailscaleConfirmation: true,
          mayRetainExistingLinkIntent: false,
          persistLinkIntent,
        },
        {
          detect: async () => ({ ...runningTailscale, running: false }),
          release: async () => undefined,
          observe: async () => ({ method: "off", url: null }),
        },
      ),
    ).rejects.toThrow("previous exposure could not be confirmed off");

    expect(persistLinkIntent).not.toHaveBeenCalled();
  });

  it("keeps an existing legacy Link intent without falsely migrating it", async () => {
    const persistLinkIntent = vi.fn();

    await persistLinkIntentAfterTailscaleTeardown(
      {
        cli: null,
        port: 3773,
        requiresTailscaleConfirmation: true,
        mayRetainExistingLinkIntent: true,
        persistLinkIntent,
      },
      {
        detect: async () => runningTailscale,
        release: async () => undefined,
        observe: async () => ({ method: "off", url: null }),
      },
    );

    expect(persistLinkIntent).not.toHaveBeenCalled();
  });

  it("persists Link intent only after Serve is observed off", async () => {
    const order: string[] = [];
    let observation = 0;

    await persistLinkIntentAfterTailscaleTeardown(
      {
        cli: "/usr/bin/tailscale",
        port: 3773,
        requiresTailscaleConfirmation: true,
        mayRetainExistingLinkIntent: false,
        persistLinkIntent: () => order.push("persist"),
      },
      {
        detect: async () => runningTailscale,
        release: async () => {
          order.push("release");
        },
        observe: async () => {
          observation += 1;
          order.push(`observe-${observation}`);
          return observation === 1
            ? { method: "tailscale-funnel", url: "https://host.example" }
            : { method: "off", url: null };
        },
      },
    );

    expect(order).toEqual(["observe-1", "release", "observe-2", "persist"]);
  });
});

describe("isAuthenticationConfiguredForExposure", () => {
  it("recognizes hosted Link authentication without local recovery credentials", () => {
    expect(
      isAuthenticationConfiguredForExposure({
        method: "shiori-link",
        localAuthConfigured: false,
        linkHostedAccessConfigured: true,
      }),
    ).toBe(true);
    expect(
      isAuthenticationConfiguredForExposure({
        method: "tailscale-funnel",
        localAuthConfigured: false,
        linkHostedAccessConfigured: true,
      }),
    ).toBe(false);
  });
});
