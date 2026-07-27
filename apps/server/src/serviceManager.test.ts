import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chownWritableServiceState,
  controlService,
  currentServiceLayoutMetadataPath,
  darwinActivationCommands,
  darwinServiceIsAlreadyRunning,
  findInstalledServiceLayout,
  installedLayoutFromRecords,
  installService,
  isSudoInvocation,
  isMissingServiceError,
  launchctlPrintShowsActiveService,
  linuxServiceInstallCommands,
  nextWindowsServiceManagerId,
  normalizeWindowsAclSnapshotRoots,
  posixDirectoryPreparationMode,
  readLogTail,
  renderLaunchDaemon,
  renderServiceHostScript,
  renderSystemdUnit,
  renderWindowsAccountScript,
  renderWindowsAccountPasswordScript,
  renderWindowsAccountVisibilityScript,
  renderWindowsAclRestoreScript,
  renderWindowsAclSnapshotScript,
  renderWindowsDirectoryAdoptionScript,
  renderWindowsDirectoryAclScript,
  renderWindowsDirectoryBoundaryScript,
  renderWindowsMetadataPreflightScript,
  renderWindowsMetadataAclHardeningScript,
  renderWindowsFileAclScript,
  renderWindowsProcessStopScript,
  renderWindowsProgramFilesProbeScript,
  renderWindowsSafeFileReadScript,
  renderWindowsServiceScript,
  renderWindowsTaskRestartScript,
  runTransactionalServiceInstall,
  selectServiceRuntimeExecutable,
  serviceLayout,
  serviceRuntimeRoot,
  stageServiceExecutable,
  validateDedicatedRuntimeSeparation,
  validatePosixDirectoryBoundary,
  validatePosixWritableTargets,
  validateServiceAccountModeTransition,
  validateWindowsWritableTargets,
  verifyServiceAndPruneRuntimes,
  waitForServiceHealth,
  windowsLayoutsToStop,
  windowsCandidateDefinitionPathsToSnapshot,
  windowsLayoutWithManagerSlot,
  windowsRuntimeProtectionArguments,
  windowsServiceDefinitionKind,
  windowsServiceDirectories,
  windowsUnmanagedServiceDirectories,
} from "./serviceManager";

afterEach(() => {
  vi.unstubAllEnvs();
});

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
    expect(unit).toContain("StandardOutput=journal");
    expect(unit).toContain("StandardError=journal");
    expect(unit).not.toContain("append:");
    expect(unit).toContain("WantedBy=multi-user.target");
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
    expect(plist).toContain("<key>StandardOutPath</key><string>/dev/null</string>");
    expect(plist).toContain("<key>StandardErrorPath</key><string>/dev/null</string>");
    expect(plist).not.toContain(layout.logPath);
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
    expect(script).not.toContain(">>");
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
    expect(unit).toContain("WantedBy=default.target");
  });

  it("keeps a current-user unit in systemd's real search path when provider HOME is custom", () => {
    const layout = serviceLayout("linux", {
      accountMode: "current",
      account: "sami",
      homeDir: "/srv/provider-home",
    });
    expect(layout.homeDir).toBe("/srv/provider-home");
    expect(layout.stateDir).toBe("/home/sami/.shioricode-service");
    expect(layout.definitionPath).toBe("/home/sami/.config/systemd/user/shioricode.service");
  });

  it("keeps macOS service state and launchd discovery independent from provider HOME", () => {
    const layout = serviceLayout("darwin", {
      accountMode: "current",
      account: "sami",
      homeDir: "/srv/provider-home",
    });
    expect(layout.homeDir).toBe("/srv/provider-home");
    expect(layout.stateDir).toBe("/Users/sami/.shioricode-service");
    expect(layout.definitionPath).toBe(
      "/Users/sami/Library/LaunchAgents/codes.shiori.shioricode.plist",
    );
    expect(serviceLayout("darwin").workspaceDir).toBe(
      "/Library/Application Support/ShioriCode/workspaces",
    );
  });

  it("escapes systemd specifiers in credentials and paths", () => {
    const layout = serviceLayout("linux", {
      workspaceDir: "/var/lib/shioricode/work%space",
    });
    const unit = renderSystemdUnit({
      layout,
      execPath: "/opt/node%24/bin/node",
      cliPath: "/opt/shiori%code/bin.mjs",
      recoveryUsername: "recovery",
      recoveryPassword: "pass%h%i",
    });
    expect(unit).toContain('WorkingDirectory="/var/lib/shioricode/work%%space"');
    expect(unit).toContain("SHIORICODE_PASSWORD=pass%%h%%i");
    expect(unit).toContain('ExecStart="/opt/node%%24/bin/node" "/opt/shiori%%code/bin.mjs"');
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

    const passwordOnly = renderWindowsAccountPasswordScript("ShioriCode", "secret");
    expect(passwordOnly).toContain("Set-LocalUser");
    expect(passwordOnly).not.toContain("SpecialAccounts\\UserList");
    const visibilityOnly = renderWindowsAccountVisibilityScript("ShioriCode");
    expect(visibilityOnly).toContain("SpecialAccounts\\UserList");
    expect(visibilityOnly).not.toContain("Set-LocalUser");
    expect(visibilityOnly).not.toContain("ConvertTo-SecureString");
  });
});

describe("service lifecycle safeguards", () => {
  it("enables linger and the user systemd target before starting a current-account service", () => {
    const layout = serviceLayout("linux", {
      accountMode: "current",
      account: "sami",
      homeDir: "/home/sami",
    });
    expect(linuxServiceInstallCommands(layout)).toEqual([
      { file: "loginctl", args: ["enable-linger", "sami"] },
      { file: "systemctl", args: ["--user", "daemon-reload"] },
      { file: "systemctl", args: ["--user", "enable", "shioricode.service"] },
      { file: "systemctl", args: ["--user", "restart", "shioricode.service"] },
    ]);
  });

  it("stages the exact running executable instead of selecting a PATH node", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-runtime-"));
    try {
      const source = path.join(root, "source-runtime");
      const runtimeDir = path.join(root, "staged");
      fs.mkdirSync(runtimeDir);
      fs.writeFileSync(source, "exact-runtime-bytes", { mode: 0o700 });
      const staged = stageServiceExecutable(source, runtimeDir, "linux");
      expect(fs.readFileSync(staged, "utf8")).toBe("exact-runtime-bytes");
      expect(fs.statSync(staged).mode & 0o111).toBe(0o111);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves split Node runtime libraries in a relocatable bin/../lib bundle", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-split-runtime-"));
    try {
      const sourceRoot = path.join(root, "node-install");
      const source = path.join(sourceRoot, "bin", "node");
      const dependency = path.join(sourceRoot, "lib", "libnode.141.dylib");
      const runtimeDir = path.join(root, "staged");
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.mkdirSync(path.dirname(dependency), { recursive: true });
      fs.mkdirSync(runtimeDir);
      fs.writeFileSync(source, "exact-runtime-bytes", { mode: 0o700 });
      fs.writeFileSync(dependency, "exact-library-bytes");

      const staged = stageServiceExecutable(source, runtimeDir, "darwin");

      expect(staged).toBe(path.join(runtimeDir, "runtime-bundle", "bin", "runtime"));
      expect(
        fs.readFileSync(
          path.join(runtimeDir, "runtime-bundle", "lib", "libnode.141.dylib"),
          "utf8",
        ),
      ).toBe("exact-library-bytes");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes the exact staged runtime with its real loader dependencies", () => {
    if (
      process.platform !== "linux" &&
      process.platform !== "darwin" &&
      process.platform !== "win32"
    ) {
      return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-real-runtime-"));
    try {
      const staged = stageServiceExecutable(process.execPath, root, process.platform);
      expect(execFileSync(staged, ["--version"], { encoding: "utf8" }).trim()).toBe(
        process.version,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers the staged runtime and uses a validated original only as fallback", async () => {
    const stagedCalls: string[] = [];
    await expect(
      selectServiceRuntimeExecutable("/staged/runtime", "/original/runtime", async (candidate) => {
        stagedCalls.push(candidate);
      }),
    ).resolves.toBe("/staged/runtime");
    expect(stagedCalls).toEqual(["/staged/runtime"]);

    const fallbackCalls: string[] = [];
    await expect(
      selectServiceRuntimeExecutable("/staged/runtime", "/original/runtime", async (candidate) => {
        fallbackCalls.push(candidate);
        if (candidate === "/staged/runtime") throw new Error("loader dependency missing");
      }),
    ).resolves.toBe("/original/runtime");
    expect(fallbackCalls).toEqual(["/staged/runtime", "/original/runtime"]);

    await expect(
      selectServiceRuntimeExecutable("/staged/runtime", "/original/runtime", async () => {
        throw new Error("cannot execute");
      }),
    ).rejects.toThrow("Neither the staged runtime nor the protected original runtime");
  });

  it("keeps dedicated runtimes outside service-writable state trees", () => {
    const dedicatedLinux = serviceLayout("linux", {
      stateDir: "/srv/shiori-state",
    });
    const currentLinux = serviceLayout("linux", {
      accountMode: "current",
      account: "sami",
      homeDir: "/home/sami",
      stateDir: "/home/sami/shiori-state",
    });
    expect(serviceRuntimeRoot(dedicatedLinux)).toMatch(
      /^\/usr\/local\/lib\/shioricode-runtime\/[a-f0-9]{16}$/,
    );
    expect(serviceRuntimeRoot(dedicatedLinux)).not.toContain(dedicatedLinux.stateDir);
    expect(serviceRuntimeRoot(currentLinux)).toBe("/home/sami/shiori-state/runtime");
  });

  it("rejects custom writable paths that could replace the protected runtime", () => {
    const layout = serviceLayout("linux", {
      stateDir: "/usr/local/lib",
      workspaceDir: "/srv/shiori-workspaces",
      logPath: "/var/log/shioricode/server.log",
    });
    expect(() => validateDedicatedRuntimeSeparation(layout)).toThrow(
      "must not overlap a service-writable path",
    );
  });

  it("never recursively chowns staged runtime artifacts to the service account", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-state-ownership-"));
    try {
      const layout = serviceLayout("linux", {
        stateDir: root,
        workspaceDir: path.join(root, "workspaces"),
        logPath: path.join(root, "logs", "server.log"),
      });
      fs.mkdirSync(path.join(root, "runtime", "old-stage"), {
        recursive: true,
      });
      fs.mkdirSync(layout.workspaceDir);
      fs.mkdirSync(path.dirname(layout.logPath));
      const calls: { file: string; args: readonly string[] }[] = [];

      await chownWritableServiceState(
        async (file, args) => {
          calls.push({ file, args });
          return { stdout: "", stderr: "" };
        },
        layout,
        layout.account,
      );

      expect(calls).toContainEqual({
        file: "chown",
        args: [layout.account, root],
      });
      expect(calls.some(({ args }) => args.includes(path.join(root, "runtime")))).toBe(false);
      expect(calls).not.toContainEqual({
        file: "chown",
        args: ["-R", layout.account, root],
      });
      expect(calls.every(({ args }) => !args.includes("-R") && !args.includes("-hR"))).toBe(true);
      expect(calls.filter(({ args }) => args.at(-1) === root)).toEqual([
        { file: "chown", args: [layout.account, root] },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps administrator operations out of service-writable POSIX descendants", () => {
    const dedicated = serviceLayout("linux", {
      stateDir: "/var/lib/shioricode",
      workspaceDir: "/var/lib/shioricode/workspaces",
      logPath: "/var/lib/shioricode/logs/server.log",
    });
    expect(posixDirectoryPreparationMode(dedicated, dedicated.stateDir)).toBe("administrator");
    expect(posixDirectoryPreparationMode(dedicated, dedicated.workspaceDir)).toBe(
      "service-account",
    );
    expect(posixDirectoryPreparationMode(dedicated, path.dirname(dedicated.logPath))).toBe(
      "service-account",
    );
    expect(posixDirectoryPreparationMode(dedicated, "/srv/shioricode-workspaces")).toBe(
      "administrator",
    );

    const current = serviceLayout("linux", {
      accountMode: "current",
      account: "sami",
      homeDir: "/home/sami",
    });
    expect(posixDirectoryPreparationMode(current, current.stateDir)).toBe("service-account");
  });

  it("retains the previous runtime until the new service passes identity health", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-prune-health-"));
    try {
      const layout = serviceLayout("linux", {
        accountMode: "current",
        account: os.userInfo().username,
        homeDir: root,
        stateDir: root,
      });
      const runtimeRoot = serviceRuntimeRoot(layout);
      const previousRuntime = path.join(runtimeRoot, "previous");
      const activeRuntime = path.join(runtimeRoot, "active");
      fs.mkdirSync(previousRuntime, { recursive: true });
      fs.mkdirSync(activeRuntime);
      const expectation = { startedAfterMs: Date.now() };

      await expect(
        verifyServiceAndPruneRuntimes(layout, activeRuntime, expectation, async () => {
          throw new Error("new launch failed health");
        }),
      ).rejects.toThrow("new launch failed health");
      expect(fs.existsSync(previousRuntime)).toBe(true);

      await verifyServiceAndPruneRuntimes(layout, activeRuntime, expectation, async () => {});
      expect(fs.existsSync(previousRuntime)).toBe(false);
      expect(fs.existsSync(activeRuntime)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rotates and size-caps logs while the staged service host is running", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-host-"));
    try {
      const cliPath = path.join(root, "cli.mjs");
      const hostPath = path.join(root, "host.mjs");
      const logPath = path.join(root, "server.log");
      fs.writeFileSync(cliPath, 'process.stdout.write("new-" + "x".repeat(80));\n');
      fs.writeFileSync(logPath, "previous-log");
      fs.writeFileSync(
        hostPath,
        renderServiceHostScript({
          execPath: process.execPath,
          cliPath,
          logPath,
          maxLogBytes: 32,
          logBackups: 1,
        }),
      );
      execFileSync(process.execPath, [hostPath]);
      expect(fs.readFileSync(`${logPath}.1`, "utf8")).toBe("previous-log");
      expect(fs.statSync(logPath).size).toBeLessThanOrEqual(32);
      expect(fs.readFileSync(logPath, "utf8")).toBe("x".repeat(32));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires the post-start endpoint to match a fresh server-instance PID and boot ID", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-health-"));
    const bootId = "fresh-service-boot";
    const server = http.createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ status: "ok", service: "shioricode", bootId }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server did not bind");
      const layout = serviceLayout("linux", {
        port: address.port,
        stateDir: root,
      });
      const startedAfterMs = Date.now() - 10;
      fs.writeFileSync(
        path.join(root, "server-instance.json"),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          port: address.port,
          baseDir: root,
          startedAt: new Date().toISOString(),
          bootId,
          wsUrl: `ws://127.0.0.1:${address.port}/ws`,
          authToken: null,
        }),
      );
      await expect(
        waitForServiceHealth(layout, { startedAfterMs }, 1_000),
      ).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a foreign listener even when it reports generic ShioriCode health", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-foreign-health-"));
    const server = http.createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          status: "ok",
          service: "shioricode",
          bootId: "foreign-boot",
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server did not bind");
      const layout = serviceLayout("linux", {
        port: address.port,
        stateDir: root,
      });
      const startedAfterMs = Date.now() - 10;
      fs.writeFileSync(
        path.join(root, "server-instance.json"),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          port: address.port,
          baseDir: root,
          startedAt: new Date().toISOString(),
          bootId: "expected-boot",
          wsUrl: `ws://127.0.0.1:${address.port}/ws`,
          authToken: null,
        }),
      );
      await expect(waitForServiceHealth(layout, { startedAfterMs }, 50)).rejects.toThrow(
        "did not match the newly launched server process",
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a stale server record even when its listener boot ID matches", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-stale-health-"));
    const bootId = "stale-boot";
    const server = http.createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ status: "ok", service: "shioricode", bootId }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server did not bind");
      const layout = serviceLayout("linux", {
        port: address.port,
        stateDir: root,
      });
      const startedAfterMs = Date.now();
      fs.writeFileSync(
        path.join(root, "server-instance.json"),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          port: address.port,
          baseDir: root,
          startedAt: new Date(startedAfterMs - 10_000).toISOString(),
          bootId,
          wsUrl: `ws://127.0.0.1:${address.port}/ws`,
          authToken: null,
        }),
      );
      await expect(waitForServiceHealth(layout, { startedAfterMs }, 50)).rejects.toThrow(
        "belongs to an older launch",
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses current-account installation under sudo before writing service state", async () => {
    vi.stubEnv("SUDO_USER", "sami");
    vi.stubEnv("SUDO_UID", "1000");
    await expect(
      installService(
        { accountMode: "current", account: "sami", homeDir: "/home/sami" },
        {
          platform: "linux",
          run: async () => ({ stdout: "", stderr: "" }),
          healthCheck: async () => undefined,
        },
      ),
    ).rejects.toThrow("must not run under sudo");
  });

  it("detects sudo from effective root even when SUDO_UID was stripped", () => {
    expect(
      isSudoInvocation({
        sudoUser: "sami",
        sudoUid: undefined,
        effectiveUid: 0,
      }),
    ).toBe(true);
  });

  it("probes current-user metadata without validating a Windows display username", async () => {
    vi.stubEnv("SUDO_USER", "John Smith");
    vi.stubEnv("SUDO_UID", "1000");
    vi.stubEnv("LOCALAPPDATA", "C:\\Users\\John Smith\\AppData\\Local");
    vi.stubEnv("ProgramData", "C:\\ProgramData-Username-Space-Test");
    expect(currentServiceLayoutMetadataPath("win32")).not.toContain(
      "ProgramData-Username-Space-Test",
    );
    expect(currentServiceLayoutMetadataPath("win32")).not.toContain("LOCALAPPDATA");
    expect(() =>
      serviceLayout("win32", {
        accountMode: "current",
        account: "123 John Smith",
        homeDir: "C:\\Users\\John Smith",
      }),
    ).not.toThrow();
    await expect(
      controlService("status", {
        platform: "win32",
        run: async (file, args) => ({
          stdout: file === "powershell.exe" && args.at(-1)?.includes("$specs=@(") ? "[]" : "Ready",
          stderr: "",
        }),
      }),
    ).resolves.toBe("Ready");
  });

  it("does not force-restart an active launchd service on start", () => {
    expect(darwinServiceIsAlreadyRunning("start", true)).toBe(true);
    expect(darwinServiceIsAlreadyRunning("restart", true)).toBe(false);
    expect(launchctlPrintShowsActiveService("state = running\npid = 42\n")).toBe(true);
    expect(launchctlPrintShowsActiveService("state = waiting\nlast exit code = 1\n")).toBe(false);
    const start = darwinActivationCommands({
      action: "start",
      domain: "system",
      target: "system/codes.shiori.shioricode",
      definitionPath: "/Library/LaunchDaemons/codes.shiori.shioricode.plist",
    });
    const restart = darwinActivationCommands({
      action: "restart",
      domain: "system",
      target: "system/codes.shiori.shioricode",
      definitionPath: "/Library/LaunchDaemons/codes.shiori.shioricode.plist",
    });
    expect(start.at(-1)?.args).toEqual(["kickstart", "system/codes.shiori.shioricode"]);
    expect(restart.at(-1)?.args).toEqual(["kickstart", "-k", "system/codes.shiori.shioricode"]);
  });

  it("terminates the trusted Windows runtime tree and configures failure restarts", async () => {
    vi.stubEnv("ProgramData", "C:\\ProgramData-Stop-Tree-Test");
    const layout = serviceLayout("win32", {
      stateDir: "C:\\ProgramData\\ShioriCode",
      workspaceDir: "D:\\Shiori Workspaces",
      logPath: "E:\\Shiori Logs\\server.log",
    });
    const stopScript = renderWindowsProcessStopScript(layout);
    expect(stopScript).toContain("Get-CimInstance Win32_Process");
    expect(stopScript).toContain("ExecutablePath");
    expect(stopScript).toContain("CommandLine");
    expect(stopScript).toContain('IndexOf("--base-dir"');
    expect(stopScript).toContain("GetOwner");
    expect(stopScript).toContain("ParentProcessId");
    expect(stopScript).toContain("taskkill.exe /PID $pidText /T /F");
    const settingsScript = renderWindowsTaskRestartScript(layout.serviceId);
    expect(settingsScript).toContain("-RestartCount 999");
    expect(settingsScript).toContain("Set-ScheduledTask");
    const calls: { file: string; args: readonly string[] }[] = [];
    await controlService("stop", {
      platform: "win32",
      run: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "", stderr: "" };
      },
    });
    expect(calls.map(({ file }) => file)).toEqual([
      "powershell.exe",
      "schtasks.exe",
      "powershell.exe",
    ]);
    expect(calls[0]?.args.at(-1)).toContain("$specs=@(");
    expect(calls[2]?.args.at(-1)).toContain("taskkill.exe /PID $pidText /T /F");
  });

  it("tears down both recorded and requested Windows layouts during migration", () => {
    vi.stubEnv("ProgramFiles", "C:\\Program Files");
    const previous = serviceLayout("win32", {
      account: "OldShioriCode",
      stateDir: "C:\\ProgramData\\Old ShioriCode",
    });
    const requested = serviceLayout("win32", {
      account: "ShioriCode",
      stateDir: "D:\\ShioriCode",
    });
    expect(windowsLayoutsToStop(previous, requested)).toEqual([previous, requested]);
    expect(windowsLayoutsToStop(requested, requested)).toEqual([requested]);
    expect(serviceRuntimeRoot(previous)).not.toBe(serviceRuntimeRoot(requested));
    const oldStopScript = renderWindowsProcessStopScript(previous);
    expect(oldStopScript).toContain("C:\\ProgramData\\Old ShioriCode\\runtime");
    expect(oldStopScript).toContain("C:\\Program Files\\ShioriCode Runtime");
  });

  it("creates Windows state and log directories even when the workspace is elsewhere", () => {
    const layout = serviceLayout("win32", {
      stateDir: "C:\\ProgramData\\ShioriCode",
      workspaceDir: "D:\\Shiori Workspaces",
      logPath: "E:\\Shiori Logs\\server.log",
    });
    expect(windowsServiceDirectories(layout)).toEqual([
      "C:\\ProgramData\\ShioriCode",
      "D:\\Shiori Workspaces",
      "E:\\Shiori Logs",
    ]);
    const runtimeAcl = windowsRuntimeProtectionArguments(layout, true);
    expect(runtimeAcl).toContain("ShioriCode:(OI)(CI)RX");
    expect(runtimeAcl).not.toContain("ShioriCode:(OI)(CI)M");
    expect(runtimeAcl.at(-1)).toBe("/T");
  });

  it("reads only a bounded tail and returns the latest 200 log lines", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-log-tail-"));
    try {
      const logPath = path.join(root, "server.log");
      const lines = Array.from({ length: 240 }, (_, index) => `line-${index}`);
      fs.writeFileSync(logPath, `${"p".repeat(300_000)}\n${lines.join("\n")}\n`);
      const tail = await readLogTail(logPath);
      expect(tail).not.toContain("line-39");
      expect(tail).toContain("line-40");
      expect(tail).toContain("line-239");
      expect(tail).not.toContain("p".repeat(1_000));
      fs.writeFileSync(logPath, "z".repeat(300_000));
      expect((await readLogTail(logPath)).length).toBe(256 * 1024);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects POSIX symlink boundaries and protected broad writable roots", () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), ".shioricode-boundary-"));
    try {
      const real = path.join(root, "real");
      const linked = path.join(root, "linked");
      fs.mkdirSync(real);
      fs.symlinkSync(real, linked);
      expect(() => validatePosixDirectoryBoundary(path.join(linked, "child"))).toThrow(
        "symlink or non-directory",
      );
      expect(() =>
        validatePosixWritableTargets(
          serviceLayout("linux", {
            accountMode: "current",
            account: "sami",
            stateDir: path.join(root, "state"),
            workspaceDir: "/etc",
            logPath: path.join(root, "logs", "server.log"),
          }),
        ),
      ).toThrow("protected POSIX path");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses one non-following Win32 handle for metadata validation and bounded reads", () => {
    const script = renderWindowsMetadataPreflightScript();
    expect(script).toContain("CreateFileW");
    expect(script).toContain("FILE_FLAG_OPEN_REPARSE_POINT");
    expect(script).toContain("GetFinalPathNameByHandleW");
    expect(script).toContain("GetSecurityInfo");
    expect(script).toContain("FILE_SHARE_READ");
    expect(script).toContain("S-1-5-18");
    expect(script).toContain("S-1-5-32-544");
    expect(script).toContain("untrustedMutationRights");
    expect(script).toContain("directoryCreateRights = 0x00000116");
    expect(script).toContain("LegacyAcl");
    expect(script).toContain("SharedDirectory");
    expect(script).toContain("$items=@([PSCustomObject]@{ Name=$spec.Primary })");
    expect(script).not.toContain("metadata ACL inheritance is not protected");
    expect(script).toContain("Select-Object -First 130");
    expect(script).toContain(String.raw`StartsWith(@"\\?\UNC\", StringComparison`);
    expect(script).toContain(String.raw`StartsWith(@"\\?\", StringComparison`);
    expect(script).not.toContain("ReadAllBytes");

    const fileScript = renderWindowsSafeFileReadScript(
      ["C:\\ProgramData\\ShioriCode\\service.cmd"],
      1024,
    );
    expect(fileScript).toContain("OpenNoFollow($path, $false)");
    expect(fileScript).toContain("ValidatePath($handle, $path, $false)");
    expect(fileScript).toContain("ReadBounded($handle, 1024)");
    expect(fileScript).not.toContain("Get-Content");
    const logTailScript = renderWindowsSafeFileReadScript(
      ["C:\\ProgramData\\ShioriCode\\server.log"],
      1024,
      true,
    );
    expect(logTailScript).toContain("[ShioriMetadataHandle]::OpenLogTailNoFollow($path)");
    expect(logTailScript).toContain("FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE");
    expect(renderWindowsMetadataPreflightScript()).not.toContain(
      "[ShioriMetadataHandle]::OpenLogTailNoFollow(",
    );

    const hardeningScript = renderWindowsMetadataAclHardeningScript(
      serviceLayout("win32"),
      {
        directoryPath: "C:\\ProgramData\\ShioriCodeService",
        directoryIdentity: "00000001:00000002:00000003",
        legacyAcl: true,
        sharedDirectory: true,
      },
      {
        directoryPath: "C:\\ProgramData\\ShioriCodeService",
        filePath: "C:\\ProgramData\\ShioriCodeService\\service-layout.json",
        directoryIdentity: "00000001:00000002:00000003",
        fileIdentity: "00000001:00000002:00000004",
        sharedDirectory: true,
      },
    );
    expect(hardeningScript).toContain("OpenForAclUpdate");
    expect(hardeningScript).toContain("HardenAcl($directoryHandle");
    expect(hardeningScript).toContain("HardenAcl($fileHandle");
    expect(hardeningScript).toContain("SetSecurityInfo");
    expect(hardeningScript.length).toBeLessThan(32_767);
    const directoryOnlyHardening = renderWindowsMetadataAclHardeningScript(serviceLayout("win32"), {
      directoryPath: "C:\\ProgramData\\ShioriCodeService",
      directoryIdentity: "00000001:00000002:00000003",
      legacyAcl: true,
      sharedDirectory: true,
    });
    expect(directoryOnlyHardening).toContain("HardenAcl($directoryHandle");
    expect(directoryOnlyHardening).not.toContain("HardenAcl($fileHandle");
  });

  it("builds protected replacement ACLs and scans reparse points before applying them", () => {
    const recursive = renderWindowsDirectoryAclScript({
      directory: "C:\\ProgramData\\ShioriCode",
      account: "ShioriCode",
      access: "modify",
      recursive: true,
      freshTree: true,
    });
    expect(recursive).toContain("$ErrorActionPreference='Stop'");
    expect(recursive).toContain("SetAccessRuleProtection($true, $false)");
    expect(recursive).toContain("NT AUTHORITY\\SYSTEM");
    expect(recursive).toContain("BUILTIN\\Administrators");
    expect(recursive).toContain("$serviceRights");
    expect(recursive.indexOf("$managedItems=@(")).toBeLessThan(
      recursive.indexOf("Set-ShioriDirectoryAcl $target;"),
    );
    const currentOwner = renderWindowsDirectoryAclScript({
      directory: "C:\\Users\\Sami\\.shioricode-service",
      account: "Sami",
      access: "modify",
      recursive: false,
      owner: "account",
    });
    expect(currentOwner).toContain("NTAccount('Sami')");

    const boundary = renderWindowsDirectoryBoundaryScript([
      "C:\\Program Files\\ShioriCode Runtime",
    ]);
    expect(boundary).toContain("while ($current)");
    expect(boundary).toContain("FileAttributes]::ReparsePoint");

    expect(() =>
      renderWindowsDirectoryAclScript({
        directory: "C:\\ProgramData\\ShioriCode",
        account: "ShioriCode",
        access: "modify",
        recursive: true,
      }),
    ).toThrow("freshly staged tree");

    const fileAcl = renderWindowsFileAclScript({
      filePath: "C:\\ProgramData\\ShioriCodeService\\service-layout.json",
      account: "ShioriCode",
      access: "none",
    });
    expect(fileAcl).toContain("FileSecurity");
    expect(fileAcl).toContain("SetAccessRuleProtection($true, $false)");
    expect(fileAcl).not.toContain("Get-ChildItem");
    const dedicatedDefinitionAcl = renderWindowsFileAclScript({
      filePath: "C:\\Program Files\\ShioriCode Runtime\\id\\ShioriCode-A.cmd",
      account: "ShioriCode",
      access: "read-execute",
      owner: "administrators",
    });
    expect(dedicatedDefinitionAcl).toContain("FileSystemRights]::ReadAndExecute");
    expect(dedicatedDefinitionAcl).not.toContain("FileSystemRights]::Modify");

    const adoption = renderWindowsDirectoryAdoptionScript(
      [
        { directory: "C:\\ProgramData\\ShioriCode", managed: true },
        {
          directory: "D:\\New ShioriCode Workspaces",
          managed: false,
          required: true,
        },
      ],
      "ShioriCode",
    );
    expect(adoption).toContain("untrusted mutation access");
    expect(adoption).toContain("untrusted replacement access");
    expect(adoption).toContain("nonempty unrecorded Windows service root");
    expect(adoption).toContain("Required=$true");
    expect(adoption).toContain("A required Windows service root is missing");
    expect(adoption).toContain("S-1-5-80-956008885");
    expect(adoption).toContain("WindowsBuiltInRole]::Administrator");
    expect(adoption).toContain("$replacementMask=[uint32]0x100D0040");
    expect(adoption).toContain("untrusted owner: $current");
    expect(adoption).toContain(
      "$componentAclTrustedSids=if ([string]::Equals($component.FullName,$targetFullPath",
    );
    expect(adoption).toContain(
      "$componentAclTrustedSids -notcontains $rule.IdentityReference.Value",
    );
    expect(adoption).toContain("$ancestorTrustedSids -notcontains $ownerSid");
    expect(adoption).not.toContain("$targetTrustedSids -notcontains $ownerSid");
    expect(adoption).not.toContain("-Recurse");
    expect(adoption.match(/PropagationFlags\]::InheritOnly/gu)).toHaveLength(2);

    const snapshot = renderWindowsAclSnapshotScript([
      { directory: "C:\\ProgramData\\ShioriCode", recursive: true },
      { directory: "C:\\Program Files\\ShioriCode Runtime", recursive: false },
    ]);
    expect(snapshot).toContain("GetSecurityDescriptorSddlForm");
    expect(snapshot).not.toContain("Get-ChildItem");
    expect(snapshot).not.toContain("-Recurse");
    expect(snapshot.indexOf("Refusing reparse point")).toBeLessThan(
      snapshot.indexOf("GetSecurityDescriptorSddlForm"),
    );
    const restore = renderWindowsAclRestoreScript([
      {
        filePath: "C:\\ProgramData\\ShioriCode",
        sddl: "O:BAG:BAD:P(A;;FA;;;BA)",
      },
    ]);
    expect(restore).toContain("Sort-Object { $_.Path.Length } -Descending");
    expect(restore).toContain("SetSecurityDescriptorSddlForm");
    expect(restore).toContain("Set-Acl");
    expect(restore.length).toBeLessThan(32_767);
    expect(() =>
      renderWindowsAclRestoreScript([
        { filePath: "C:\\one", sddl: "O:BAG:BAD:P(A;;FA;;;BA)" },
        { filePath: "C:\\two", sddl: "O:BAG:BAD:P(A;;FA;;;BA)" },
      ]),
    ).toThrow("one bounded root at a time");
    expect(() =>
      renderWindowsAclSnapshotScript(
        Array.from({ length: 17 }, (_, index) => ({
          directory: `C:\\ShioriCode-${index}`,
          recursive: false,
        })),
      ),
    ).toThrow("more than 16 Windows ACL roots");

    expect(
      normalizeWindowsAclSnapshotRoots([
        { directory: "C:\\ProgramData\\ShioriCode", recursive: true },
        {
          directory: "C:\\ProgramData\\ShioriCode\\workspaces",
          recursive: true,
        },
        {
          directory: "C:\\Program Files\\ShioriCode Runtime",
          recursive: false,
        },
        {
          directory: "C:\\Program Files\\ShioriCode Runtime\\active",
          recursive: true,
        },
      ]),
    ).toEqual([
      { directory: "C:\\ProgramData\\ShioriCode", recursive: false },
      {
        directory: "C:\\ProgramData\\ShioriCode\\workspaces",
        recursive: false,
      },
      { directory: "C:\\Program Files\\ShioriCode Runtime", recursive: false },
      {
        directory: "C:\\Program Files\\ShioriCode Runtime\\active",
        recursive: false,
      },
    ]);
  });

  it("refuses fresh Windows roots below or around a recorded writable root", () => {
    const layout = serviceLayout("win32", {
      workspaceDir: "C:\\ProgramData\\ShioriCode\\new-workspaces",
    });
    expect(() =>
      windowsUnmanagedServiceDirectories(
        layout,
        new Set([path.win32.resolve(layout.stateDir).toLowerCase()]),
      ),
    ).toThrow("through an existing managed tree");

    const freshLayout = serviceLayout("win32", {
      stateDir: "D:\\ShioriCode",
      workspaceDir: "E:\\ShioriCode Workspaces",
      logPath: "F:\\ShioriCode Logs\\server.log",
    });
    expect(windowsUnmanagedServiceDirectories(freshLayout, new Set())).toEqual([
      freshLayout.stateDir,
      path.win32.dirname(freshLayout.logPath),
      freshLayout.workspaceDir,
    ]);
  });

  it("uses SID-based Program Files checks and ignores poisoned path environment variables", () => {
    vi.stubEnv("ProgramFiles", "D:\\Attacker Controlled");
    vi.stubEnv("ProgramData", "D:\\Attacker Data");
    const layout = serviceLayout("win32");
    expect(serviceRuntimeRoot(layout)).toMatch(/^C:\\Program Files\\ShioriCode Runtime\\/u);
    expect(layout.stateDir).toBe("C:\\ProgramData\\ShioriCode");
    const probe = renderWindowsProgramFilesProbeScript();
    expect(probe).toContain("SpecialFolder]::ProgramFiles");
    expect(probe).toContain("S-1-5-32-544");
    expect(probe).toContain("S-1-5-80-956008885");
    expect(probe).toContain("$mutationMask=[uint32]0x500D0156");
    expect(probe).toContain("$trustedOwnerSids -notcontains $ruleSid");
    expect(probe).toContain("PropagationFlags]::InheritOnly");
    expect(probe).toContain("[IO.Path]::IsPathRooted($root)");
    expect(probe).not.toContain("IsPathFullyQualified");
    expect(probe).not.toContain("FileSystemRights]::FullControl");
    expect(probe).not.toContain("$untrustedSids");
    expect(probe).not.toContain("$env:ProgramFiles");
  });

  it("rejects Windows volume/system roots without false positives for usernames containing Windows", () => {
    expect(() =>
      validateWindowsWritableTargets(
        serviceLayout("win32", {
          stateDir: "C:\\",
          workspaceDir: "D:\\workspaces",
          logPath: "D:\\logs\\server.log",
        }),
      ),
    ).toThrow("volume root");
    expect(() =>
      validateWindowsWritableTargets(
        serviceLayout("win32", {
          workspaceDir: "C:\\Windows\\Temp\\ShioriCode",
        }),
      ),
    ).toThrow("protected Windows path");

    vi.stubEnv("USERPROFILE", "C:\\Users\\Windows Developer");
    const current = serviceLayout("win32", {
      accountMode: "current",
      account: "Windows Developer",
      homeDir: "D:\\Provider Home",
      stateDir: "C:\\Users\\Windows Developer\\.shioricode-service",
    });
    expect(() => validateWindowsWritableTargets(current)).not.toThrow();
    expect(() =>
      validateWindowsWritableTargets({
        ...current,
        stateDir: "D:\\External State",
      }),
    ).toThrow("trusted user profile");
  });

  it("prefers the canonical Windows metadata pointer over a newer stale history", () => {
    const base = serviceLayout("win32");
    const active = { ...base, managerId: "ShioriCode-A" };
    const stale = { ...base, managerId: "ShioriCode-B" };
    const primary = "C:\\ProgramData\\ShioriCodeService\\service-layout.json";
    const selected = installedLayoutFromRecords(
      "win32",
      [
        {
          layout: stale,
          metadataPath:
            "C:\\ProgramData\\ShioriCodeService\\service-layout.aaaaaaaaaaaaaaaaaaaa.json",
          writtenAtMs: 10_000,
        },
        { layout: active, metadataPath: primary, writtenAtMs: 1 },
      ],
      () => true,
    );
    expect(selected?.managerId).toBe("ShioriCode-A");
    expect(nextWindowsServiceManagerId(selected)).toBe("ShioriCode-B");
    expect(nextWindowsServiceManagerId({ ...base, managerId: "ShioriCode-B" })).toBe(
      "ShioriCode-A",
    );
  });

  it("binds dedicated Windows definitions to the matching protected A/B slot", () => {
    const legacy = {
      ...serviceLayout("win32"),
      runtimeRoot: "C:\\Program Files\\ShioriCode Runtime\\0123456789abcdef",
    };
    const slotA = windowsLayoutWithManagerSlot(legacy, "ShioriCode-A");
    const slotB = windowsLayoutWithManagerSlot(slotA, "ShioriCode-B");
    const current = {
      ...legacy,
      accountMode: "current" as const,
      runtimeRoot: undefined,
    };

    expect(windowsServiceDefinitionKind(legacy)).toBe("legacy");
    expect(windowsServiceDefinitionKind(current)).toBe("current");
    expect(slotA.definitionPath).toBe(`${legacy.runtimeRoot}\\ShioriCode-A.cmd`);
    expect(slotB.definitionPath).toBe(`${legacy.runtimeRoot}\\ShioriCode-B.cmd`);
    expect(windowsServiceDefinitionKind(slotA)).toBe("protected");
    expect(windowsServiceDefinitionKind(slotB)).toBe("protected");
    expect(windowsCandidateDefinitionPathsToSnapshot(slotB)).toEqual([slotB.definitionPath]);
    expect(windowsCandidateDefinitionPathsToSnapshot(slotB)).not.toContain(slotA.definitionPath);

    expect(
      windowsServiceDefinitionKind({
        ...slotA,
        managerId: "ShioriCode-B",
      }),
    ).toBe("invalid");
    expect(
      windowsServiceDefinitionKind({
        ...slotA,
        definitionPath: "C:\\ProgramData\\ShioriCode\\replacement.cmd",
      }),
    ).toBe("invalid");
    expect(() => windowsCandidateDefinitionPathsToSnapshot(legacy)).toThrow(
      "unsafe Windows service definition",
    );
  });

  it("rolls back failed health commits and preserves the original failure", async () => {
    const events: string[] = [];
    await expect(
      runTransactionalServiceInstall({
        installAndStart: async () => {
          events.push("install");
          return "candidate";
        },
        verifyAndCommit: async () => {
          events.push("verify");
          throw new Error("identity health failed");
        },
        rollback: async (error) => {
          events.push(`rollback:${error instanceof Error ? error.message : String(error)}`);
        },
      }),
    ).rejects.toThrow("identity health failed");
    expect(events).toEqual(["install", "verify", "rollback:identity health failed"]);

    await expect(
      runTransactionalServiceInstall({
        installAndStart: async () => {
          throw new Error("install failed");
        },
        verifyAndCommit: async () => undefined,
        rollback: async () => {
          throw new Error("restore failed");
        },
      }),
    ).rejects.toThrow("previous service could not be fully restored");
  });

  it("refuses both account-mode migration directions before lifecycle mutation", () => {
    const dedicated = serviceLayout("linux");
    const current = serviceLayout("linux", {
      accountMode: "current",
      account: "sami",
      homeDir: "/home/sami",
    });
    expect(() => validateServiceAccountModeTransition([current], dedicated)).toThrow(
      "Changing service account mode",
    );
    expect(() => validateServiceAccountModeTransition([dedicated], current)).toThrow(
      "Changing service account mode",
    );
  });

  it("distinguishes real missing-manager errors from transient command failures", () => {
    expect(
      isMissingServiceError(new Error("ERROR: The system cannot find the file specified.")),
    ).toBe(true);
    expect(isMissingServiceError(new Error("RPC server is unavailable"))).toBe(false);
    expect(isMissingServiceError({ stderr: "Access is denied" })).toBe(false);
  });

  it("resolves Windows installed layouts only through the validated PowerShell preflight", async () => {
    const run = vi.fn(async (_file: string, _args: readonly string[]) => ({
      stdout: "[]",
      stderr: "",
    }));
    await expect(findInstalledServiceLayout({ platform: "win32", run })).resolves.toBeNull();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toBe("powershell.exe");
    expect(run.mock.calls[0]?.[1].at(-1)).toContain("OpenNoFollow");

    await expect(
      findInstalledServiceLayout({
        platform: "win32",
        run: async () => ({
          stdout: JSON.stringify({
            Files: {
              Path: "C:\\Users\\Public\\service-layout.json",
              Content: Buffer.from("{}").toString("base64"),
              WrittenAtMs: 1,
              LegacyAcl: false,
              DirectoryIdentity: "00000001:00000002:00000003",
              FileIdentity: "00000001:00000002:00000004",
              SharedDirectory: false,
            },
            Directories: [],
          }),
          stderr: "",
        }),
      }),
    ).rejects.toThrow("outside the canonical namespace");

    await expect(
      findInstalledServiceLayout({
        platform: "win32",
        run: async () => ({
          stdout: JSON.stringify({
            Files: [],
            Directories: {
              Path: "C:\\ProgramData\\ShioriCodeService",
              Identity: "00000001:00000002:00000003",
              LegacyAcl: true,
              SharedDirectory: true,
            },
          }),
          stderr: "",
        }),
      }),
    ).resolves.toBeNull();
  });

  it("rejects POSIX symlink and FIFO logs without following or blocking", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-unsafe-log-"));
    try {
      const secret = path.join(root, "secret");
      const linked = path.join(root, "linked.log");
      fs.writeFileSync(secret, "must-not-leak");
      fs.symlinkSync(secret, linked);
      await expect(readLogTail(linked)).rejects.toThrow("non-regular service log");

      if (process.platform !== "win32") {
        const fifo = path.join(root, "server.fifo");
        execFileSync("mkfifo", [fifo]);
        await expect(readLogTail(fifo)).rejects.toThrow("non-regular service log");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads Windows service logs through the same bounded non-following handle", async () => {
    const layout = serviceLayout("win32");
    const calls: string[] = [];
    await expect(
      controlService("logs", {
        platform: "win32",
        run: async (_file, args) => {
          const script = args.at(-1) ?? "";
          calls.push(script);
          if (script.includes("$specs=@(")) return { stdout: "[]", stderr: "" };
          return {
            stdout: JSON.stringify({
              Path: layout.logPath,
              Missing: false,
              Content: Buffer.from("safe-line\n").toString("base64"),
              Truncated: false,
            }),
            stderr: "",
          };
        },
      }),
    ).resolves.toBe("safe-line");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("ReadTailBounded");
    expect(calls[1]).toContain("OpenLogTailNoFollow($path)");
    expect(calls[1]).toContain("FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE");
  });
});
