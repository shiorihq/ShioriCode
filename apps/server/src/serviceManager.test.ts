import { describe, expect, it } from "vitest";

import {
  renderLaunchDaemon,
  renderSystemdUnit,
  renderWindowsAccountScript,
  renderWindowsServiceScript,
  serviceLayout,
} from "./serviceManager";

describe("service definitions", () => {
  it("renders a dedicated-user systemd service", () => {
    const layout = serviceLayout("linux");
    const unit = renderSystemdUnit({
      layout,
      execPath: "/usr/bin/node",
      cliPath: "/usr/lib/node_modules/shioricode/dist/bin.mjs",
      recoveryUsername: "recovery",
      recoveryPassword: "secret",
    });
    expect(unit).toContain("User=shioricode");
    expect(unit).toContain('WorkingDirectory="/var/lib/shioricode/workspaces"');
    expect(unit).toContain('"serve"');
    expect(unit).toContain("--remote");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("SuccessExitStatus=130 143");
  });

  it("renders a dedicated-user launch daemon", () => {
    const layout = serviceLayout("darwin");
    const plist = renderLaunchDaemon({
      layout,
      execPath: "/usr/local/bin/node",
      cliPath: "/usr/local/lib/node_modules/shioricode/dist/bin.mjs",
      recoveryUsername: "owner",
      recoveryPassword: "a&b",
    });
    expect(plist).toContain("<string>_shioricode</string>");
    expect(plist).toContain("<key>GroupName</key>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<key>SHIORICODE_USERNAME</key><string>owner</string>");
    expect(plist).toContain("a&amp;b");
  });

  it("renders a Windows startup script", () => {
    const layout = serviceLayout("win32");
    const script = renderWindowsServiceScript({
      layout,
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      cliPath: "C:\\npm\\node_modules\\@shiori\\shioricode\\dist\\bin.mjs",
      recoveryUsername: "recovery",
      recoveryPassword: "secret",
    });
    expect(script).toContain("SHIORICODE_USERNAME=recovery");
    expect(script).toContain('"serve"');
    expect(script).toContain("127.0.0.1");
  });

  it("can reuse the invoking macOS account and its provider home", () => {
    const layout = serviceLayout("darwin", {
      accountMode: "current",
      account: "sami",
      homeDir: "/Users/sami",
      port: 4773,
    });
    expect(layout.accountMode).toBe("current");
    expect(layout.account).toBe("sami");
    expect(layout.homeDir).toBe("/Users/sami");
    expect(layout.stateDir).toBe("/Users/sami/.shioricode-service");
    expect(layout.workspaceDir).toBe("/Users/sami/.shioricode-service/workspaces");
    expect(layout.definitionPath).toBe(
      "/Users/sami/Library/LaunchAgents/codes.shiori.shioricode.plist",
    );
    expect(layout.port).toBe(4773);

    const plist = renderLaunchDaemon({
      layout,
      execPath: "/usr/local/bin/node",
      cliPath: "/usr/local/lib/node_modules/shioricode/dist/bin.mjs",
      recoveryUsername: "sami",
      recoveryPassword: "secret",
    });
    expect(plist).toContain("<string>sami</string>");
    expect(plist).not.toContain("<key>UserName</key>");
    expect(plist).not.toContain("<key>GroupName</key>");
    expect(plist).toContain("<key>HOME</key><string>/Users/sami</string>");
    expect(plist).toContain("<string>4773</string>");
  });

  it("renders a user-scoped systemd service without privileged account directives", () => {
    const layout = serviceLayout("linux", {
      accountMode: "current",
      account: "sami",
      homeDir: "/home/sami",
    });
    const unit = renderSystemdUnit({
      layout,
      execPath: "/usr/bin/node",
      cliPath: "/usr/lib/node_modules/shioricode/dist/bin.mjs",
      recoveryUsername: "sami",
      recoveryPassword: "secret",
    });
    expect(layout.definitionPath).toBe("/home/sami/.config/systemd/user/shioricode.service");
    expect(unit).not.toContain("User=");
    expect(unit).not.toContain("Group=");
    expect(unit).toContain('Environment="HOME=/home/sami"');
  });

  it("omits direct credentials and startup auth when recovery login is disabled", () => {
    const layout = serviceLayout("darwin", {
      accountMode: "current",
      account: "sami",
      homeDir: "/Users/sami",
    });
    const plist = renderLaunchDaemon({
      layout,
      execPath: "/usr/local/bin/node",
      cliPath: "/usr/local/lib/node_modules/shioricode/dist/bin.mjs",
      recoveryUsername: null,
      recoveryPassword: null,
    });
    expect(plist).not.toContain("SHIORICODE_USERNAME");
    expect(plist).not.toContain("SHIORICODE_PASSWORD");
    expect(plist).not.toContain("<string>--remote</string>");
  });

  it("rotates the Windows service account password on reinstall", () => {
    const script = renderWindowsAccountScript("ShioriCode", "secret");
    expect(script).toContain("New-LocalUser");
    expect(script).toContain("Set-LocalUser");
    expect(script).toContain("-AccountNeverExpires -PasswordNeverExpires $true");
    expect(script).toContain("-UserMayChangePassword $false");
    expect(script).toContain("SpecialAccounts\\UserList");
  });
});
