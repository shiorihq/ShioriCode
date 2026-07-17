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
      recoveryPassword: "secret",
    });
    expect(unit).toContain("User=shioricode");
    expect(unit).toContain("WorkingDirectory=/var/lib/shioricode/workspaces");
    expect(unit).not.toContain('WorkingDirectory="');
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
      recoveryPassword: "a&b",
    });
    expect(plist).toContain("<string>_shioricode</string>");
    expect(plist).toContain("<key>GroupName</key>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("a&amp;b");
  });

  it("renders a Windows startup script", () => {
    const layout = serviceLayout("win32");
    const script = renderWindowsServiceScript({
      layout,
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      cliPath: "C:\\npm\\node_modules\\@shiori\\shioricode\\dist\\bin.mjs",
      recoveryPassword: "secret",
    });
    expect(script).toContain("SHIORICODE_USERNAME=recovery");
    expect(script).toContain('"serve"');
    expect(script).toContain("127.0.0.1");
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
