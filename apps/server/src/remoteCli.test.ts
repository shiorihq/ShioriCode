import { describe, expect, it, vi } from "vitest";

import type { RemoteStatus } from "contracts";

import { formatRemoteStatus, remoteStatus, setRemoteExposure } from "./remoteCli";

const status: RemoteStatus = {
  method: "tailscale-serve",
  desiredMethod: "tailscale-serve",
  enabled: true,
  url: "https://build.tailnet.ts.net",
  reachability: "tailnet",
  requireAuth: true,
  authConfigured: true,
  username: "recovery",
  port: 3773,
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
    dnsName: "build.tailnet.ts.net",
    httpsEnabled: true,
  },
  sessions: [],
  notice: null,
};

function rpcWith(remoteStatus: RemoteStatus) {
  return {
    remote: {
      getStatus: vi.fn(async () => remoteStatus),
      setExposure: vi.fn(async () => remoteStatus),
    },
  };
}

describe("formatRemoteStatus", () => {
  it("prints the effective method, URL, sign-in, and Tailscale state", () => {
    expect(formatRemoteStatus(status)).toBe(
      [
        "Remote access: Tailscale Serve",
        "Desired: Tailscale Serve",
        "Reachability: tailnet",
        "URL: https://build.tailnet.ts.net",
        "Sign-in: configured (recovery)",
        "Tailscale: connected (build.tailnet.ts.net)",
      ].join("\n"),
    );
  });
});

describe("remote CLI target selection", () => {
  it("uses the installed service and never starts a second backend", async () => {
    const rpc = rpcWith(status);
    const dispose = vi.fn(async () => undefined);
    const withLocalRpc = vi.fn();
    const requireAdministrator = vi.fn();

    const output = await remoteStatus(undefined, {
      findService: () => ({
        platform: "linux",
        accountMode: "dedicated",
        account: "shioricode",
        homeDir: "/var/lib/shioricode",
        stateDir: "/var/lib/shioricode",
        workspaceDir: "/var/lib/shioricode/workspaces",
        definitionPath: "/etc/systemd/system/shioricode.service",
        logPath: "/var/log/shioricode/server.log",
        servicePath: "/usr/local/bin:/usr/bin:/bin",
        serviceId: "shioricode.service",
        port: 3773,
      }),
      requireAdministrator,
      connectService: async () => ({ rpc: rpc as never, dispose }),
      withLocalRpc,
    });

    expect(output).toContain("Remote access: Tailscale Serve");
    expect(requireAdministrator).toHaveBeenCalledWith("linux");
    expect(withLocalRpc).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("connects to a current-user service without demanding administrator access", async () => {
    const rpc = rpcWith(status);
    const requireAdministrator = vi.fn();

    await remoteStatus(undefined, {
      findService: () => ({
        platform: "darwin",
        accountMode: "current",
        account: "sami",
        homeDir: "/Users/sami",
        stateDir: "/Users/sami/.shioricode-service",
        workspaceDir: "/Users/sami/.shioricode-service/workspaces",
        definitionPath: "/Users/sami/Library/LaunchAgents/codes.shiori.shioricode.plist",
        logPath: "/Users/sami/.shioricode-service/server.log",
        servicePath: "/opt/homebrew/bin:/usr/bin:/bin",
        serviceId: "codes.shiori.shioricode",
        port: 3773,
      }),
      requireAdministrator,
      connectService: async () => ({ rpc: rpc as never, dispose: async () => undefined }),
    });

    expect(requireAdministrator).not.toHaveBeenCalled();
  });

  it("grants the Linux service account operator access before enabling Serve", async () => {
    const rpc = rpcWith(status);
    const setOperator = vi.fn(async () => undefined);
    const events: string[] = [];
    setOperator.mockImplementation(async () => {
      events.push("operator");
    });
    rpc.remote.setExposure.mockImplementation(async () => {
      events.push("exposure");
      return status;
    });

    await setRemoteExposure("tailscale-serve", undefined, {
      findService: () => ({
        platform: "linux",
        accountMode: "dedicated",
        account: "shioricode",
        homeDir: "/var/lib/shioricode",
        stateDir: "/var/lib/shioricode",
        workspaceDir: "/var/lib/shioricode/workspaces",
        definitionPath: "/etc/systemd/system/shioricode.service",
        logPath: "/var/log/shioricode/server.log",
        servicePath: "/usr/local/bin:/usr/bin:/bin",
        serviceId: "shioricode.service",
        port: 3773,
      }),
      requireAdministrator: () => undefined,
      connectService: async () => ({ rpc: rpc as never, dispose: async () => undefined }),
      findTailscale: () => "/usr/bin/tailscale",
      setOperator,
    });

    expect(setOperator).toHaveBeenCalledWith("/usr/bin/tailscale", "shioricode");
    expect(events).toEqual(["operator", "exposure"]);
  });

  it("uses an explicitly targeted local backend without changing Tailscale permissions", async () => {
    const rpc = rpcWith({ ...status, method: "off", desiredMethod: "off" });
    const setOperator = vi.fn();
    const withLocalRpc = vi.fn(async (_baseDir, run) => await run(rpc as never));

    await setRemoteExposure("off", "/tmp/shiori", {
      findService: () => null,
      withLocalRpc,
      setOperator,
    });

    expect(withLocalRpc).toHaveBeenCalled();
    expect(setOperator).not.toHaveBeenCalled();
    expect(rpc.remote.setExposure).toHaveBeenCalledWith({ method: "off" });
  });
});
