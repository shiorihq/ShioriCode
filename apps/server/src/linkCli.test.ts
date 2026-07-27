import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const serviceManagerMocks = vi.hoisted(() => ({
  controlService: vi.fn(async () => undefined),
  installedServiceLayout: vi.fn(),
  linkServiceStateDir: vi.fn(),
  requireServiceAdministrator: vi.fn(),
  serviceLayout: vi.fn(
    (
      platform: "linux" | "darwin",
      options: {
        accountMode: "current" | "dedicated";
        account: string;
        homeDir: string;
        stateDir: string;
        workspaceDir: string;
        logPath: string;
        servicePath: string;
        port?: number;
      },
    ) => ({
      platform,
      ...options,
      definitionPath:
        platform === "linux"
          ? "/etc/systemd/system/shioricode.service"
          : "/Library/LaunchDaemons/codes.shiori.shioricode.plist",
      serviceId: platform === "linux" ? "shioricode.service" : "codes.shiori.shioricode",
      port: options.port ?? 3773,
    }),
  ),
}));

vi.mock("./serviceManager", () => serviceManagerMocks);

import {
  decodeLinkServiceChildLayout,
  disconnectLinkEnvironment,
  dispatchLinkMutation,
  linkMutationRequiresServiceChild,
  linkServiceAccountCommand,
  linkServiceChildCommand,
  linkStatus,
  reexecLinkMutationIfNeeded,
  waitForDeviceAuthorization,
} from "./linkCli";
import type { ServiceLayout } from "./serviceManager";
import { RemoteStateStore } from "./remote/remoteStateStore";

const temporaryDirectories: string[] = [];

function posixLayout(
  platform: "linux" | "darwin" = "linux",
  accountMode: "current" | "dedicated" = "dedicated",
): ServiceLayout {
  const account = accountMode === "current" ? "developer" : "shioricode";
  const stateDir = platform === "linux" ? "/var/lib/shioricode" : "/Library/ShioriCode";
  return {
    platform,
    accountMode,
    account,
    homeDir: stateDir,
    stateDir,
    workspaceDir: path.posix.join(stateDir, "workspaces"),
    definitionPath:
      platform === "linux"
        ? "/etc/systemd/system/shioricode.service"
        : "/Library/LaunchDaemons/codes.shiori.shioricode.plist",
    logPath: path.posix.join(stateDir, "server.log"),
    servicePath: "/usr/bin:/bin",
    serviceId: platform === "linux" ? "shioricode.service" : "codes.shiori.shioricode",
    port: 3773,
  };
}

function encodeChildContext(layout: ServiceLayout): string {
  return Buffer.from(JSON.stringify({ layout }), "utf8").toString("base64url");
}

function configureServiceState(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-link-cli-"));
  temporaryDirectories.push(root);
  const stateDir = path.join(root, "service-state");
  const userDataDir = path.join(stateDir, "userdata");
  serviceManagerMocks.installedServiceLayout.mockReturnValue({
    platform: "linux",
    accountMode: "current",
    account: os.userInfo().username,
    homeDir: stateDir,
    stateDir,
    workspaceDir: path.join(stateDir, "workspaces"),
    definitionPath: path.join(root, "shioricode.service"),
    logPath: path.join(stateDir, "server.log"),
    servicePath: "/usr/bin",
    serviceId: "shioricode.service",
    port: 3773,
  });
  serviceManagerMocks.linkServiceStateDir.mockReturnValue(userDataDir);
  return userDataDir;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("linkCli", () => {
  it("builds a shell-free Linux child with a clean, explicit environment", () => {
    const layout = posixLayout();
    const command = linkServiceChildCommand(
      layout,
      ["/usr/bin/node", "/opt/shioricode/bin.mjs", "link", "disconnect"],
      "http://127.0.0.1:8787/link/",
    );
    expect(command.file).toBe("/usr/sbin/runuser");
    expect(command.args.slice(0, 4)).toEqual(["-u", "shioricode", "--", "/usr/bin/env"]);
    expect(command.args).toContain("-i");
    expect(command.args).toContain("-u");
    expect(command.args).toContain("SUDO_USER");
    expect(command.args).toContain("HOME=/var/lib/shioricode");
    expect(command.args).toContain("USER=shioricode");
    expect(command.args).toContain("SHIORICODE_LINK_API_URL=http://127.0.0.1:8787/link");
    expect(command.args).not.toContain("sh");
    expect(command.args).not.toContain("-c");
    expect(command.args.some((arg) => arg.startsWith("HTTP_PROXY="))).toBe(false);
    expect(command.args.at(-2)).toBe("link");
    expect(command.args.at(-1)).toBe("disconnect");
    expect(command.args.some((arg) => arg.startsWith("SHIORICODE_LINK_SERVICE_CHILD="))).toBe(true);
  });

  it("uses absolute sudo and env paths for a current-account macOS child", () => {
    const layout = posixLayout("darwin", "current");
    const command = linkServiceChildCommand(
      layout,
      ["/usr/bin/node", "/opt/shioricode/bin.mjs", "link", "disconnect"],
      "https://link.example.test",
    );

    expect(command.file).toBe("/usr/bin/sudo");
    expect(command.args.slice(0, 4)).toEqual(["-u", "developer", "/usr/bin/env", "-i"]);
    expect(command.args).toContain("SHIORICODE_LINK_API_URL=https://link.example.test");
    expect(linkServiceAccountCommand(layout, "/usr/bin/test", ["-r", "/cli.mjs"])).toEqual({
      file: "/usr/bin/sudo",
      args: ["-u", "developer", "/usr/bin/test", "-r", "/cli.mjs"],
    });
  });

  it("authenticates the untrusted child context against platform and account UID", async () => {
    const layout = posixLayout("linux", "current");
    const encoded = encodeChildContext(layout);
    const resolveUid = vi.fn(async () => 1001);

    await expect(
      decodeLinkServiceChildLayout(encoded, {
        platform: "linux",
        effectiveUid: 1001,
        resolveUid,
      }),
    ).resolves.toMatchObject({ account: "developer", accountMode: "current" });
    expect(resolveUid).toHaveBeenCalledWith("developer");

    await expect(
      decodeLinkServiceChildLayout(encoded, {
        platform: "linux",
        effectiveUid: 0,
        resolveUid: async () => 1001,
      }),
    ).rejects.toThrow("Invalid Link service-child identity");
    await expect(
      decodeLinkServiceChildLayout(encoded, {
        platform: "linux",
        effectiveUid: 1001,
        resolveUid: async () => 1002,
      }),
    ).rejects.toThrow("Invalid Link service-child identity");
    await expect(
      decodeLinkServiceChildLayout(encoded, {
        platform: "linux",
        effectiveUid: 1001,
        resolveUid: async () => 0,
      }),
    ).rejects.toThrow("Invalid Link service-child identity");
    await expect(
      decodeLinkServiceChildLayout(encoded, {
        platform: "darwin",
        effectiveUid: 1001,
        resolveUid: async () => 1001,
      }),
    ).rejects.toThrow("Invalid Link service-child context");
    await expect(
      decodeLinkServiceChildLayout("x".repeat(16 * 1024 + 1), {
        platform: "linux",
        effectiveUid: 1001,
        resolveUid: async () => 1001,
      }),
    ).rejects.toThrow("Invalid Link service-child context");
    await expect(
      decodeLinkServiceChildLayout(
        Buffer.from(JSON.stringify({ layout: { ...layout, platform: "win32" } })).toString(
          "base64url",
        ),
        {
          platform: "win32",
          effectiveUid: 1001,
          resolveUid: async () => 1001,
        },
      ),
    ).rejects.toThrow("Invalid Link service-child context");
  });

  it("dispatches current-mode sudo mutations and restarts only after child success", async () => {
    const layout = posixLayout("linux", "current");
    const runChild = vi.fn(async () => undefined);
    const restart = vi.fn(async () => undefined);
    const dependencies = {
      effectiveUid: () => 0,
      resolveUid: async () => 1001,
      runChild,
      restart,
    };

    expect(linkMutationRequiresServiceChild(layout, 0, 1001)).toBe(true);
    await expect(
      reexecLinkMutationIfNeeded({ layout, serviceChild: false }, dependencies),
    ).resolves.toBe(true);
    expect(runChild).toHaveBeenCalledWith(layout);
    expect(restart).toHaveBeenCalledTimes(1);

    runChild.mockRejectedValueOnce(new Error("child failed"));
    restart.mockClear();
    await expect(
      reexecLinkMutationIfNeeded({ layout, serviceChild: false }, dependencies),
    ).rejects.toThrow("child failed");
    expect(restart).not.toHaveBeenCalled();
  });

  it("suppresses parent output and mutations after a successful child", async () => {
    const execution = { layout: posixLayout("linux", "current"), serviceChild: false };
    const mutate = vi.fn(async () => "parent output");

    await expect(
      dispatchLinkMutation(mutate, {
        resolveExecution: async () => execution,
        reexec: async () => true,
      }),
    ).resolves.toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("skips parent restart for the authenticated child and explains legacy permission failures", async () => {
    const layout = posixLayout("linux", "dedicated");
    const restart = vi.fn(async () => undefined);
    await expect(
      reexecLinkMutationIfNeeded(
        { layout, serviceChild: true },
        {
          effectiveUid: () => 1001,
          resolveUid: async () => 1001,
          runChild: async () => undefined,
          restart,
        },
      ),
    ).resolves.toBe(false);
    expect(restart).not.toHaveBeenCalled();

    serviceManagerMocks.linkServiceStateDir.mockReturnValue("/var/lib/shioricode/userdata");
    await expect(
      dispatchLinkMutation(
        async () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
        {
          resolveExecution: async () => ({ layout, serviceChild: true }),
          reexec: async () => false,
        },
      ),
    ).rejects.toThrow(/manually reassign or remove.*administrator/u);
  });

  it("keeps device authorization polling after a transient network failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        Response.json({ token: "access", refreshToken: "refresh" }, { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = waitForDeviceAuthorization({
      deviceCode: "device-code",
      userCode: "USER-CODE",
      verificationUri: "https://verify.example",
      verificationUriComplete: "https://verify.example/device-code",
      expiresIn: 10,
      interval: 1,
    });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toEqual({
      token: "access",
      refreshToken: "refresh",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports status without creating service-owned state", async () => {
    const userDataDir = configureServiceState();

    await expect(linkStatus()).resolves.toBe(
      "GitHub account: not connected\nLink environment: not configured",
    );
    expect(fs.existsSync(userDataDir)).toBe(false);
  });

  it("does not replace an active Tailscale intent when disconnecting Link credentials", async () => {
    const userDataDir = configureServiceState();
    new RemoteStateStore({ stateDir: userDataDir }).setReconciled("tailscale-funnel");

    await disconnectLinkEnvironment();

    const remote = new RemoteStateStore({ stateDir: userDataDir });
    expect(remote.method).toBe("tailscale-funnel");
    expect(remote.requiresTailscaleConfirmation).toBe(false);
    expect(serviceManagerMocks.controlService).toHaveBeenCalledWith("restart");
  });

  it("performs child-side disconnect mutations without restarting from the child", async () => {
    const userDataDir = configureServiceState();
    new RemoteStateStore({ stateDir: userDataDir }).setReconciled("shiori-link");
    const layout = serviceManagerMocks.installedServiceLayout();

    await expect(
      disconnectLinkEnvironment({
        resolveExecution: async () => ({ layout, serviceChild: true }),
        reexec: async () => false,
      }),
    ).resolves.toBe("Disconnected GitHub and revoked this Link environment.");

    expect(new RemoteStateStore({ stateDir: userDataDir }).method).toBe("off");
    expect(serviceManagerMocks.controlService).not.toHaveBeenCalled();
  });

  it("keeps stale-Tailscale uncertainty when disconnecting an offline Link", async () => {
    const userDataDir = configureServiceState();
    const remote = new RemoteStateStore({ stateDir: userDataDir });
    remote.setReconciled("tailscale-serve");
    remote.transitionWithoutTailscaleTeardown("shiori-link");

    await disconnectLinkEnvironment();

    const reloaded = new RemoteStateStore({ stateDir: userDataDir });
    expect(reloaded.method).toBe("off");
    expect(reloaded.requiresTailscaleConfirmation).toBe(true);
  });
});
