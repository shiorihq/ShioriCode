import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type ServicePlatform = "linux" | "darwin" | "win32";
export type ServiceAction = "start" | "stop" | "restart" | "status" | "logs" | "uninstall";
export type ServiceAccountMode = "dedicated" | "current";

export interface ServiceLayout {
  readonly platform: ServicePlatform;
  readonly accountMode: ServiceAccountMode;
  readonly account: string;
  readonly homeDir: string;
  readonly stateDir: string;
  readonly workspaceDir: string;
  readonly definitionPath: string;
  readonly logPath: string;
  readonly servicePath: string;
  readonly serviceId: string;
  readonly port: number;
}

export interface ServiceInstallResult {
  readonly layout: ServiceLayout;
  readonly recoveryUsername: string | null;
  readonly recoveryPassword: string | null;
  readonly recoveryPasswordGenerated: boolean;
}

export interface ServiceInstallOptions {
  readonly accountMode?: ServiceAccountMode | undefined;
  readonly account?: string | undefined;
  readonly homeDir?: string | undefined;
  readonly stateDir?: string | undefined;
  readonly workspaceDir?: string | undefined;
  readonly logPath?: string | undefined;
  readonly servicePath?: string | undefined;
  readonly port?: number | undefined;
  readonly recoveryUsername?: string | undefined;
  readonly recoveryPasswordFile?: string | undefined;
  readonly disableRecoveryLogin?: boolean | undefined;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface ServiceDependencies {
  readonly platform: ServicePlatform;
  readonly execPath: string;
  readonly cliPath: string;
  readonly run: (file: string, args: readonly string[]) => Promise<CommandResult>;
}

interface StagedServiceRuntime {
  readonly dependencies: ServiceDependencies;
  readonly runtimeDir: string;
}

const SERVICE_PORT = 3773;
const RECOVERY_USERNAME = "recovery";
const SERVICE_LAYOUT_VERSION = 1;

function invokingUsername(): string {
  const sudoUser = process.env.SUDO_USER?.trim();
  if (sudoUser && sudoUser !== "root") return sudoUser;
  return os.userInfo().username;
}

function invokingUid(): number {
  const sudoUid = Number(process.env.SUDO_UID);
  if (Number.isInteger(sudoUid) && sudoUid >= 0) return sudoUid;
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

function defaultAccount(platform: ServicePlatform): string {
  if (platform === "darwin") return "_shioricode";
  if (platform === "linux") return "shioricode";
  return "ShioriCode";
}

function defaultExistingHomeDir(platform: ServicePlatform, account: string) {
  if (account === os.userInfo().username) return os.homedir();
  if (platform === "darwin") return path.join("/Users", account);
  if (platform === "linux") return account === "root" ? "/root" : path.join("/home", account);
  return process.env.USERPROFILE || os.homedir();
}

function defaultServicePath(platform: ServicePlatform): string {
  if (platform === "darwin") {
    return "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  }
  if (platform === "linux") {
    return "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  }
  return process.env.Path ?? process.env.PATH ?? "";
}

function validateServiceAccount(account: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9._-]*\$?$/.test(account)) {
    throw new Error(`Invalid service username: ${account}`);
  }
}

function validateServiceLayout(layout: ServiceLayout): ServiceLayout {
  const isAbsolute = layout.platform === "win32" ? path.win32.isAbsolute : path.isAbsolute;
  for (const [label, value] of [
    ["home directory", layout.homeDir],
    ["state directory", layout.stateDir],
    ["workspace directory", layout.workspaceDir],
    ["service definition", layout.definitionPath],
    ["log file", layout.logPath],
  ] as const) {
    if (!isAbsolute(value) || /[\0\r\n]/.test(value)) {
      throw new Error(`The ${label} must be an absolute path without control characters`);
    }
  }
  if (/\0|\r|\n/.test(layout.servicePath)) {
    throw new Error("The service PATH cannot contain control characters");
  }
  if (!Number.isInteger(layout.port) || layout.port < 1 || layout.port > 65_535) {
    throw new Error(`Invalid service port: ${layout.port}`);
  }
  return layout;
}

function supportedPlatform(platform: NodeJS.Platform): ServicePlatform {
  if (platform === "linux" || platform === "darwin" || platform === "win32") return platform;
  throw new Error(`ShioriCode services are not supported on ${platform} yet`);
}

export function serviceLayout(
  platform: ServicePlatform,
  options: ServiceInstallOptions = {},
): ServiceLayout {
  const accountMode = options.accountMode ?? "dedicated";
  const account =
    options.account?.trim() ||
    (accountMode === "current" ? invokingUsername() : defaultAccount(platform));
  validateServiceAccount(account);
  switch (platform) {
    case "linux": {
      const dedicatedStateDir = "/var/lib/shioricode";
      const homeDir =
        options.homeDir ??
        (accountMode === "dedicated"
          ? dedicatedStateDir
          : defaultExistingHomeDir(platform, account));
      const stateDir =
        options.stateDir ??
        (accountMode === "dedicated"
          ? dedicatedStateDir
          : path.join(homeDir, ".shioricode-service"));
      return validateServiceLayout({
        platform,
        accountMode,
        account,
        homeDir,
        stateDir,
        workspaceDir: options.workspaceDir ?? path.join(stateDir, "workspaces"),
        definitionPath:
          accountMode === "dedicated"
            ? "/etc/systemd/system/shioricode.service"
            : path.join(homeDir, ".config/systemd/user/shioricode.service"),
        logPath:
          options.logPath ??
          (accountMode === "dedicated"
            ? "/var/log/shioricode/server.log"
            : path.join(stateDir, "server.log")),
        servicePath: options.servicePath ?? defaultServicePath(platform),
        serviceId: "shioricode.service",
        port: options.port ?? SERVICE_PORT,
      });
    }
    case "darwin": {
      const dedicatedStateDir = "/Library/Application Support/ShioriCode";
      const homeDir =
        options.homeDir ??
        (accountMode === "dedicated"
          ? dedicatedStateDir
          : defaultExistingHomeDir(platform, account));
      const stateDir =
        options.stateDir ??
        (accountMode === "dedicated"
          ? dedicatedStateDir
          : path.join(homeDir, ".shioricode-service"));
      return validateServiceLayout({
        platform,
        accountMode,
        account,
        homeDir,
        stateDir,
        workspaceDir:
          options.workspaceDir ??
          (accountMode === "dedicated"
            ? "/Users/Shared/ShioriCode/Workspaces"
            : path.join(stateDir, "workspaces")),
        definitionPath:
          accountMode === "dedicated"
            ? "/Library/LaunchDaemons/codes.shiori.shioricode.plist"
            : path.join(homeDir, "Library/LaunchAgents/codes.shiori.shioricode.plist"),
        logPath:
          options.logPath ??
          (accountMode === "dedicated"
            ? "/Library/Logs/ShioriCode/server.log"
            : path.join(stateDir, "server.log")),
        servicePath: options.servicePath ?? defaultServicePath(platform),
        serviceId: "codes.shiori.shioricode",
        port: options.port ?? SERVICE_PORT,
      });
    }
    case "win32": {
      const programData = process.env.ProgramData || "C:\\ProgramData";
      const dedicatedStateDir = path.win32.join(programData, "ShioriCode");
      const homeDir =
        options.homeDir ??
        (accountMode === "dedicated"
          ? dedicatedStateDir
          : defaultExistingHomeDir(platform, account));
      const stateDir =
        options.stateDir ??
        (accountMode === "dedicated"
          ? dedicatedStateDir
          : path.win32.join(homeDir, ".shioricode-service"));
      return validateServiceLayout({
        platform,
        accountMode,
        account,
        homeDir,
        stateDir,
        workspaceDir: options.workspaceDir ?? path.win32.join(stateDir, "workspaces"),
        definitionPath: path.win32.join(stateDir, "service.cmd"),
        logPath: options.logPath ?? path.win32.join(stateDir, "server.log"),
        servicePath: options.servicePath ?? defaultServicePath(platform),
        serviceId: "ShioriCode",
        port: options.port ?? SERVICE_PORT,
      });
    }
  }
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function windowsBatchQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function serviceArguments(layout: ServiceLayout, requireAuth: boolean): readonly string[] {
  const args = [
    "serve",
    "--mode",
    "web",
    "--host",
    "127.0.0.1",
    "--port",
    String(layout.port),
    "--base-dir",
    layout.stateDir,
    "--no-browser",
  ];
  if (requireAuth) args.splice(-1, 0, "--remote");
  return args;
}

function serviceRuntimeRoot(layout: ServiceLayout): string {
  return path.join(layout.stateDir, "runtime");
}

function stageServiceRuntime(
  deps: ServiceDependencies,
  layout: ServiceLayout,
): StagedServiceRuntime {
  const packageRoot = path.resolve(path.dirname(deps.cliPath), "..");
  const sourceBin = path.join(packageRoot, "dist", "bin.mjs");
  const sourceNodePty = path.join(packageRoot, "node_modules", "node-pty", "package.json");
  if (!fs.existsSync(sourceBin) || !fs.existsSync(sourceNodePty)) {
    throw new Error(
      "The ShioriCode service runtime is incomplete. Install the published package with `npm install -g shioricode`, then retry.",
    );
  }

  const runtimeRoot = serviceRuntimeRoot(layout);
  const runtimeDir = path.join(runtimeRoot, `${Date.now()}-${randomBytes(6).toString("hex")}`);
  const packageTarget = path.join(runtimeDir, "package");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o750 });
  try {
    fs.cpSync(packageRoot, packageTarget, { recursive: true, dereference: true });
  } catch (error) {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    throw error;
  }
  return {
    runtimeDir,
    dependencies: {
      ...deps,
      cliPath: path.join(packageTarget, "dist", "bin.mjs"),
    },
  };
}

function pruneStagedServiceRuntimes(layout: ServiceLayout, activeRuntimeDir: string): void {
  const runtimeRoot = serviceRuntimeRoot(layout);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runtimeRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const candidate = path.join(runtimeRoot, entry.name);
    if (!entry.isDirectory() || candidate === activeRuntimeDir) continue;
    try {
      fs.rmSync(candidate, { recursive: true, force: true });
    } catch {
      // Windows can briefly retain a lock on the previous Node executable.
    }
  }
}

async function protectStagedServiceRuntime(
  deps: ServiceDependencies,
  layout: ServiceLayout,
): Promise<void> {
  if (layout.accountMode === "current") {
    if (layout.platform !== "win32")
      await deps.run("chmod", ["-R", "u+rX", serviceRuntimeRoot(layout)]);
    return;
  }
  const runtimeRoot = serviceRuntimeRoot(layout);
  if (layout.platform === "win32") {
    await deps.run("icacls.exe", [
      runtimeRoot,
      "/inheritance:r",
      "/grant:r",
      "Administrators:(OI)(CI)F",
      `${layout.account}:(OI)(CI)RX`,
      "/T",
    ]);
    return;
  }
  await deps.run("chown", [
    "-R",
    layout.platform === "darwin" ? "root:wheel" : "root:root",
    runtimeRoot,
  ]);
  await deps.run("chmod", ["-R", "a+rX", runtimeRoot]);
}

export function renderSystemdUnit(input: {
  readonly layout: ServiceLayout;
  readonly execPath: string;
  readonly cliPath: string;
  readonly recoveryUsername: string | null;
  readonly recoveryPassword: string | null;
}): string {
  const { layout } = input;
  const hasRecoveryLogin = input.recoveryUsername !== null && input.recoveryPassword !== null;
  const command = [input.execPath, input.cliPath, ...serviceArguments(layout, hasRecoveryLogin)]
    .map(systemdQuote)
    .join(" ");
  const account =
    layout.accountMode === "dedicated" ? `User=${layout.account}\nGroup=${layout.account}\n` : "";
  const recoveryLogin = hasRecoveryLogin
    ? `Environment=${systemdQuote(`SHIORICODE_USERNAME=${input.recoveryUsername}`)}\nEnvironment=${systemdQuote(`SHIORICODE_PASSWORD=${input.recoveryPassword}`)}\n`
    : "";
  return `[Unit]
Description=ShioriCode headless server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${account}WorkingDirectory=${systemdQuote(layout.workspaceDir)}
Environment=${systemdQuote(`HOME=${layout.homeDir}`)}
Environment=NODE_ENV=production
Environment=SHIORICODE_SERVICE=1
Environment=SHIORICODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false
Environment=${systemdQuote(`PATH=${layout.servicePath}`)}
${recoveryLogin}ExecStart=${command}
Restart=on-failure
RestartSec=3
SuccessExitStatus=130 143
LimitNOFILE=65535
StandardOutput=${systemdQuote(`append:${layout.logPath}`)}
StandardError=${systemdQuote(`append:${layout.logPath}`)}

[Install]
WantedBy=multi-user.target
`;
}

export function renderLaunchDaemon(input: {
  readonly layout: ServiceLayout;
  readonly execPath: string;
  readonly cliPath: string;
  readonly recoveryUsername: string | null;
  readonly recoveryPassword: string | null;
}): string {
  const hasRecoveryLogin = input.recoveryUsername !== null && input.recoveryPassword !== null;
  const args = [input.execPath, input.cliPath, ...serviceArguments(input.layout, hasRecoveryLogin)]
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  const account =
    input.layout.accountMode === "dedicated"
      ? `  <key>UserName</key>\n  <string>${input.layout.account}</string>\n  <key>GroupName</key>\n  <string>${input.layout.account}</string>\n`
      : "";
  const recoveryLogin = hasRecoveryLogin
    ? `    <key>SHIORICODE_USERNAME</key><string>${xmlEscape(input.recoveryUsername)}</string>\n    <key>SHIORICODE_PASSWORD</key><string>${xmlEscape(input.recoveryPassword)}</string>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${input.layout.serviceId}</string>
${account}  <key>WorkingDirectory</key>
  <string>${xmlEscape(input.layout.workspaceDir)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xmlEscape(input.layout.homeDir)}</string>
    <key>NODE_ENV</key><string>production</string>
    <key>SHIORICODE_SERVICE</key><string>1</string>
    <key>SHIORICODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD</key><string>false</string>
    <key>PATH</key><string>${xmlEscape(input.layout.servicePath)}</string>
${recoveryLogin}  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>3</integer>
  <key>StandardOutPath</key><string>${xmlEscape(input.layout.logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(input.layout.logPath)}</string>
</dict>
</plist>
`;
}

export function renderWindowsServiceScript(input: {
  readonly layout: ServiceLayout;
  readonly execPath: string;
  readonly cliPath: string;
  readonly recoveryUsername: string | null;
  readonly recoveryPassword: string | null;
}): string {
  const hasRecoveryLogin = input.recoveryUsername !== null && input.recoveryPassword !== null;
  const command = [
    input.execPath,
    input.cliPath,
    ...serviceArguments(input.layout, hasRecoveryLogin),
  ]
    .map(windowsBatchQuote)
    .join(" ");
  const recoveryLogin = hasRecoveryLogin
    ? `set "SHIORICODE_USERNAME=${input.recoveryUsername}"\r\nset "SHIORICODE_PASSWORD=${input.recoveryPassword}"\r\n`
    : "";
  return `@echo off\r
set "HOME=${input.layout.homeDir}"\r
set "NODE_ENV=production"\r
set "SHIORICODE_SERVICE=1"\r
set "SHIORICODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false"\r
set "PATH=${input.layout.servicePath}"\r
${recoveryLogin}cd /d ${windowsBatchQuote(input.layout.workspaceDir)}\r
${command} >> ${windowsBatchQuote(input.layout.logPath)} 2>&1\r
`;
}

async function runDefault(file: string, args: readonly string[]): Promise<CommandResult> {
  const result = await execFile(file, [...args], { windowsHide: true });
  return { stdout: result.stdout, stderr: result.stderr };
}

function defaultDependencies(): ServiceDependencies {
  const cliArg = process.argv[1];
  if (!cliArg) throw new Error("Could not resolve the ShioriCode executable path");
  return {
    platform: supportedPlatform(process.platform),
    execPath: stableNodeExecutable(),
    cliPath: fs.realpathSync(cliArg),
    run: runDefault,
  };
}

function stableNodeExecutable(): string {
  if (process.platform === "win32") return process.execPath;
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
  for (const entry of pathEntries) {
    if (!entry) continue;
    const candidate = path.join(entry, "node");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep looking for the stable executable exposed through PATH.
    }
  }
  return process.execPath;
}

function requireAdministrator(platform: ServicePlatform): void {
  if (platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new Error("Service installation requires administrator privileges. Re-run with sudo.");
  }
}

async function commandExists(run: ServiceDependencies["run"], file: string, args: string[]) {
  try {
    await run(file, args);
    return true;
  } catch {
    return false;
  }
}

async function ensureLinuxAccount(deps: ServiceDependencies, layout: ServiceLayout): Promise<void> {
  const accountExists = await commandExists(deps.run, "id", ["-u", layout.account]);
  if (!accountExists && layout.accountMode === "current") {
    throw new Error(`The requested existing service user ${layout.account} does not exist`);
  }
  if (!accountExists) {
    await deps.run("useradd", [
      "--system",
      "--home-dir",
      layout.stateDir,
      "--create-home",
      "--shell",
      "/usr/sbin/nologin",
      layout.account,
    ]);
  }
  fs.mkdirSync(layout.stateDir, { recursive: true, mode: 0o750 });
  fs.mkdirSync(layout.workspaceDir, { recursive: true, mode: 0o750 });
  fs.mkdirSync(path.dirname(layout.logPath), { recursive: true, mode: 0o750 });
  if (layout.accountMode === "current") return;
  await deps.run("chown", ["-R", layout.account, layout.stateDir]);
  await deps.run("chown", ["-R", layout.account, path.dirname(layout.logPath)]);
}

async function nextMacSystemId(deps: ServiceDependencies): Promise<number> {
  const [users, groups] = await Promise.all([
    deps.run("dscl", [".", "-list", "/Users", "UniqueID"]),
    deps.run("dscl", [".", "-list", "/Groups", "PrimaryGroupID"]),
  ]);
  const used = new Set(
    `${users.stdout}\n${groups.stdout}`
      .split("\n")
      .map((line) => Number(line.trim().split(/\s+/).at(-1)))
      .filter(Number.isInteger),
  );
  for (let uid = 499; uid >= 400; uid -= 1) {
    if (!used.has(uid)) return uid;
  }
  throw new Error("Could not allocate a macOS system user ID");
}

async function readMacNumericAttribute(
  deps: ServiceDependencies,
  record: string,
  attribute: "UniqueID" | "PrimaryGroupID",
): Promise<number | undefined> {
  try {
    const result = await deps.run("dscl", [".", "-read", record, attribute]);
    const value = Number(result.stdout.trim().split(/\s+/).at(-1));
    return Number.isInteger(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function ensureMacAccount(deps: ServiceDependencies, layout: ServiceLayout): Promise<void> {
  if (layout.accountMode === "current") {
    if (!(await commandExists(deps.run, "id", ["-u", layout.account]))) {
      throw new Error(`The requested existing service user ${layout.account} does not exist`);
    }
    fs.mkdirSync(layout.stateDir, { recursive: true, mode: 0o750 });
    fs.mkdirSync(layout.workspaceDir, { recursive: true, mode: 0o750 });
    fs.mkdirSync(path.dirname(layout.logPath), { recursive: true, mode: 0o750 });
    return;
  }
  const userRecord = `/Users/${layout.account}`;
  const groupRecord = `/Groups/${layout.account}`;
  const existingUid = await readMacNumericAttribute(deps, userRecord, "UniqueID");
  const existingGid = await readMacNumericAttribute(deps, groupRecord, "PrimaryGroupID");
  if (existingUid !== undefined && existingGid !== undefined && existingUid !== existingGid) {
    throw new Error(`The existing macOS ${layout.account} user and group IDs do not match`);
  }
  const serviceId = existingUid ?? existingGid ?? (await nextMacSystemId(deps));

  await deps.run("dscl", [".", "-create", groupRecord]);
  await deps.run("dscl", [".", "-create", groupRecord, "RealName", "ShioriCode Service"]);
  await deps.run("dscl", [".", "-create", groupRecord, "PrimaryGroupID", String(serviceId)]);
  await deps.run("dscl", [".", "-create", groupRecord, "Password", "*"]);

  await deps.run("dscl", [".", "-create", userRecord]);
  await deps.run("dscl", [".", "-create", userRecord, "RealName", "ShioriCode Service"]);
  await deps.run("dscl", [".", "-create", userRecord, "UniqueID", String(serviceId)]);
  await deps.run("dscl", [".", "-create", userRecord, "PrimaryGroupID", String(serviceId)]);
  await deps.run("dscl", [".", "-create", userRecord, "NFSHomeDirectory", layout.stateDir]);
  await deps.run("dscl", [".", "-create", userRecord, "UserShell", "/usr/bin/false"]);
  await deps.run("dscl", [".", "-create", userRecord, "IsHidden", "1"]);
  await deps.run("dscl", [".", "-create", userRecord, "Password", "*"]);

  fs.mkdirSync(layout.stateDir, { recursive: true, mode: 0o750 });
  fs.mkdirSync(layout.workspaceDir, { recursive: true, mode: 0o750 });
  fs.mkdirSync(path.dirname(layout.logPath), { recursive: true, mode: 0o750 });
  await deps.run("chown", ["-R", `${layout.account}:${layout.account}`, layout.stateDir]);
  await deps.run("chown", [
    "-R",
    `${layout.account}:${layout.account}`,
    path.dirname(layout.logPath),
  ]);
}

async function installLinux(
  deps: ServiceDependencies,
  layout: ServiceLayout,
  recoveryUsername: string | null,
  recoveryPassword: string | null,
): Promise<void> {
  await ensureLinuxAccount(deps, layout);
  const staged = stageServiceRuntime(deps, layout);
  await protectStagedServiceRuntime(deps, layout);
  fs.mkdirSync(path.dirname(layout.definitionPath), { recursive: true, mode: 0o755 });
  fs.writeFileSync(
    layout.definitionPath,
    renderSystemdUnit({
      ...staged.dependencies,
      layout,
      recoveryUsername,
      recoveryPassword,
    }),
    { mode: 0o600 },
  );
  const systemctl = layout.accountMode === "current" ? ["--user"] : [];
  await deps.run("systemctl", [...systemctl, "daemon-reload"]);
  await deps.run("systemctl", [...systemctl, "enable", layout.serviceId]);
  await deps.run("systemctl", [...systemctl, "restart", layout.serviceId]);
  pruneStagedServiceRuntimes(layout, staged.runtimeDir);
}

async function installMac(
  deps: ServiceDependencies,
  layout: ServiceLayout,
  recoveryUsername: string | null,
  recoveryPassword: string | null,
): Promise<void> {
  await ensureMacAccount(deps, layout);
  const staged = stageServiceRuntime(deps, layout);
  await protectStagedServiceRuntime(deps, layout);
  fs.mkdirSync(path.dirname(layout.definitionPath), { recursive: true, mode: 0o755 });
  fs.writeFileSync(
    layout.definitionPath,
    renderLaunchDaemon({
      ...staged.dependencies,
      layout,
      recoveryUsername,
      recoveryPassword,
    }),
    { mode: 0o600 },
  );
  const domain = layout.accountMode === "dedicated" ? "system" : `gui/${invokingUid()}`;
  await deps.run("launchctl", ["bootout", domain, layout.definitionPath]).catch(() => {});
  await deps.run("launchctl", ["bootstrap", domain, layout.definitionPath]);
  await deps.run("launchctl", ["enable", `${domain}/${layout.serviceId}`]);
  await deps.run("launchctl", ["kickstart", "-k", `${domain}/${layout.serviceId}`]);
  pruneStagedServiceRuntimes(layout, staged.runtimeDir);
}

async function installWindows(
  deps: ServiceDependencies,
  layout: ServiceLayout,
  recoveryUsername: string | null,
  recoveryPassword: string | null,
): Promise<void> {
  const accountPassword =
    layout.accountMode === "dedicated" ? randomBytes(32).toString("base64url") : null;
  if (accountPassword) {
    const ps = renderWindowsAccountScript(layout.account, accountPassword);
    await deps.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  }
  fs.mkdirSync(layout.workspaceDir, { recursive: true });
  if (layout.accountMode === "dedicated") {
    await deps.run("icacls.exe", [
      layout.stateDir,
      "/inheritance:r",
      "/grant:r",
      "Administrators:(OI)(CI)F",
      `${layout.account}:(OI)(CI)M`,
      "/T",
    ]);
  }
  const staged = stageServiceRuntime(deps, layout);
  await protectStagedServiceRuntime(deps, layout);
  fs.writeFileSync(
    layout.definitionPath,
    renderWindowsServiceScript({
      ...staged.dependencies,
      layout,
      recoveryUsername,
      recoveryPassword,
    }),
    "utf8",
  );
  await deps.run("schtasks.exe", ["/End", "/TN", layout.serviceId]).catch(() => {});
  const accountArguments = accountPassword
    ? ["/RU", `.\\${layout.account}`, "/RP", accountPassword]
    : ["/RU", layout.account, "/NP"];
  await deps.run("schtasks.exe", [
    "/Create",
    "/TN",
    layout.serviceId,
    "/SC",
    layout.accountMode === "dedicated" ? "ONSTART" : "ONLOGON",
    ...accountArguments,
    "/TR",
    layout.definitionPath,
    "/F",
  ]);
  await deps.run("schtasks.exe", ["/Run", "/TN", layout.serviceId]);
  pruneStagedServiceRuntimes(layout, staged.runtimeDir);
}

export function renderWindowsAccountScript(account: string, accountPassword: string): string {
  const escapedAccount = account.replaceAll("'", "''");
  const escapedPassword = accountPassword.replaceAll("'", "''");
  return `$name='${escapedAccount}'
$password=ConvertTo-SecureString '${escapedPassword}' -AsPlainText -Force
if (-not (Get-LocalUser -Name $name -ErrorAction SilentlyContinue)) {
  New-LocalUser -Name $name -Password $password -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword
} else {
  Set-LocalUser -Name $name -Password $password -AccountNeverExpires -PasswordNeverExpires $true -UserMayChangePassword $false
}
$userList='HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\SpecialAccounts\\UserList'
New-Item -Path $userList -Force | Out-Null
New-ItemProperty -Path $userList -Name $name -PropertyType DWord -Value 0 -Force | Out-Null`;
}

function systemServiceLayoutMetadataPath(platform: ServicePlatform): string {
  if (platform === "linux") return "/etc/shioricode/service-layout.json";
  if (platform === "darwin") {
    return "/Library/Preferences/codes.shiori.shioricode.service-layout.json";
  }
  const programData = process.env.ProgramData || "C:\\ProgramData";
  return path.win32.join(programData, "ShioriCodeService", "service-layout.json");
}

function serviceLayoutMetadataPath(layout: ServiceLayout): string {
  if (layout.accountMode === "dedicated") return systemServiceLayoutMetadataPath(layout.platform);
  const metadataHome = defaultExistingHomeDir(layout.platform, invokingUsername());
  if (layout.platform === "linux") {
    return path.join(metadataHome, ".config/shioricode/service-layout.json");
  }
  if (layout.platform === "darwin") {
    return path.join(
      metadataHome,
      "Library/Application Support/ShioriCode Service/service-layout.json",
    );
  }
  return path.win32.join(
    process.env.LOCALAPPDATA || path.win32.join(metadataHome, "AppData", "Local"),
    "ShioriCodeService",
    "service-layout.json",
  );
}

function writeServiceLayout(layout: ServiceLayout): void {
  const metadataPath = serviceLayoutMetadataPath(layout);
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true, mode: 0o755 });
  fs.writeFileSync(
    metadataPath,
    `${JSON.stringify({ version: SERVICE_LAYOUT_VERSION, layout }, null, 2)}\n`,
    { mode: 0o600 },
  );
  if (layout.accountMode === "dedicated" && layout.platform !== "win32") {
    fs.chownSync(metadataPath, 0, 0);
    fs.chmodSync(metadataPath, 0o600);
  }
}

function readServiceLayout(metadataPath: string, platform: ServicePlatform): ServiceLayout | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
      readonly version?: unknown;
      readonly layout?: Partial<ServiceLayout>;
    };
    const layout = parsed.layout;
    if (
      parsed.version !== SERVICE_LAYOUT_VERSION ||
      layout?.platform !== platform ||
      (layout.accountMode !== "dedicated" && layout.accountMode !== "current") ||
      typeof layout.account !== "string" ||
      typeof layout.homeDir !== "string" ||
      typeof layout.stateDir !== "string" ||
      typeof layout.workspaceDir !== "string" ||
      typeof layout.definitionPath !== "string" ||
      typeof layout.logPath !== "string" ||
      typeof layout.servicePath !== "string" ||
      typeof layout.serviceId !== "string" ||
      typeof layout.port !== "number"
    ) {
      return null;
    }
    return layout as ServiceLayout;
  } catch {
    return null;
  }
}

function readInstalledServiceLayout(platform: ServicePlatform): ServiceLayout | null {
  const current = serviceLayout(platform, { accountMode: "current" });
  const currentLayout = readServiceLayout(serviceLayoutMetadataPath(current), platform);
  if (currentLayout && fs.existsSync(currentLayout.definitionPath)) return currentLayout;
  const systemLayout = readServiceLayout(systemServiceLayoutMetadataPath(platform), platform);
  if (systemLayout && fs.existsSync(systemLayout.definitionPath)) return systemLayout;
  const legacy = serviceLayout(platform);
  return fs.existsSync(legacy.definitionPath) ? legacy : null;
}

function recoveryPasswordFromOptions(options: ServiceInstallOptions): {
  readonly password: string;
  readonly generated: boolean;
} {
  if (!options.recoveryPasswordFile) {
    return { password: randomBytes(32).toString("base64url"), generated: true };
  }
  const password = fs.readFileSync(options.recoveryPasswordFile, "utf8").replace(/\r?\n$/, "");
  if (!password) throw new Error("The recovery password file is empty");
  if (/[\0\r\n]/.test(password)) {
    throw new Error("The recovery password file must contain exactly one password line");
  }
  return { password, generated: false };
}

export async function installService(
  options: ServiceInstallOptions = {},
  overrides: Partial<ServiceDependencies> = {},
): Promise<ServiceInstallResult> {
  const defaults = defaultDependencies();
  const deps = { ...defaults, ...overrides };
  const layout = serviceLayout(deps.platform, options);
  if (layout.accountMode === "current" && layout.account !== invokingUsername()) {
    throw new Error("Current-account services must run as the invoking OS user");
  }
  if (layout.accountMode === "dedicated") requireAdministrator(deps.platform);
  if (options.disableRecoveryLogin && (options.recoveryUsername || options.recoveryPasswordFile)) {
    throw new Error(
      "--no-recovery-login cannot be combined with recovery username/password options",
    );
  }
  const recoveryUsername = options.disableRecoveryLogin
    ? null
    : options.recoveryUsername?.trim() || RECOVERY_USERNAME;
  if (recoveryUsername !== null && !/^[A-Za-z0-9._@-]{1,128}$/.test(recoveryUsername)) {
    throw new Error("The recovery username contains unsupported characters");
  }
  const recoveryPassword = options.disableRecoveryLogin
    ? { password: null, generated: false }
    : recoveryPasswordFromOptions(options);
  if (
    deps.platform === "win32" &&
    recoveryPassword.password !== null &&
    /[%"]/.test(recoveryPassword.password)
  ) {
    throw new Error('Windows recovery passwords cannot contain `%` or `"`');
  }

  if (deps.platform === "linux") {
    await installLinux(deps, layout, recoveryUsername, recoveryPassword.password);
  }
  if (deps.platform === "darwin") {
    await installMac(deps, layout, recoveryUsername, recoveryPassword.password);
  }
  if (deps.platform === "win32") {
    await installWindows(deps, layout, recoveryUsername, recoveryPassword.password);
  }
  writeServiceLayout(layout);

  return {
    layout,
    recoveryUsername,
    recoveryPassword: recoveryPassword.password,
    recoveryPasswordGenerated: recoveryPassword.generated,
  };
}

async function readLog(logPath: string): Promise<string> {
  try {
    const content = await fs.promises.readFile(logPath, "utf8");
    return content.split("\n").slice(-200).join("\n").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "No service logs yet.";
    throw error;
  }
}

export async function controlService(
  action: ServiceAction,
  overrides: Partial<ServiceDependencies> = {},
): Promise<string> {
  const defaults = defaultDependencies();
  const deps = { ...defaults, ...overrides };
  const layout = readInstalledServiceLayout(deps.platform) ?? serviceLayout(deps.platform);
  if (layout.accountMode === "dedicated") requireAdministrator(deps.platform);

  if (action === "logs") return await readLog(layout.logPath);

  if (deps.platform === "linux") {
    const systemctl = layout.accountMode === "current" ? ["--user"] : [];
    if (action === "uninstall") {
      await deps
        .run("systemctl", [...systemctl, "disable", "--now", layout.serviceId])
        .catch(() => {});
      fs.rmSync(layout.definitionPath, { force: true });
      await deps.run("systemctl", [...systemctl, "daemon-reload"]);
      fs.rmSync(serviceLayoutMetadataPath(layout), { force: true });
      return "Removed the systemd service. ShioriCode data and the service account were preserved.";
    }
    if (action === "status") {
      const result = await deps.run("systemctl", [
        ...systemctl,
        "show",
        layout.serviceId,
        "--no-pager",
        "--property=LoadState,UnitFileState,ActiveState,SubState,MainPID,ExecMainStatus",
      ]);
      return result.stdout.trim();
    }
    const result = await deps.run("systemctl", [...systemctl, action, layout.serviceId]);
    return result.stdout.trim() || `Service ${action} complete.`;
  }

  if (deps.platform === "darwin") {
    const domain = layout.accountMode === "dedicated" ? "system" : `gui/${invokingUid()}`;
    const target = `${domain}/${layout.serviceId}`;
    if (action === "uninstall") {
      await deps.run("launchctl", ["bootout", domain, layout.definitionPath]).catch(() => {});
      fs.rmSync(layout.definitionPath, { force: true });
      fs.rmSync(serviceLayoutMetadataPath(layout), { force: true });
      return "Removed the launch daemon. ShioriCode data and the service account were preserved.";
    }
    if (action === "status") {
      try {
        return (await deps.run("launchctl", ["print", target])).stdout.trim();
      } catch {
        return "Service is not loaded.";
      }
    }
    if (action === "stop") {
      await deps.run("launchctl", ["bootout", domain, layout.definitionPath]);
      return "Service stop complete.";
    }
    if (action === "restart") {
      await deps.run("launchctl", ["bootout", domain, layout.definitionPath]).catch(() => {});
    }
    if (action === "start" || action === "restart") {
      await deps.run("launchctl", ["bootstrap", domain, layout.definitionPath]).catch(() => {});
      await deps.run("launchctl", ["enable", target]);
      await deps.run("launchctl", ["kickstart", "-k", target]);
    }
    return `Service ${action} complete.`;
  }

  if (action === "uninstall") {
    await deps.run("schtasks.exe", ["/End", "/TN", layout.serviceId]).catch(() => {});
    await deps.run("schtasks.exe", ["/Delete", "/TN", layout.serviceId, "/F"]);
    fs.rmSync(serviceLayoutMetadataPath(layout), { force: true });
    return "Removed the Windows background task. ShioriCode data and the service account were preserved.";
  }
  if (action === "status") {
    return (
      await deps.run("schtasks.exe", ["/Query", "/TN", layout.serviceId, "/V", "/FO", "LIST"])
    ).stdout.trim();
  }
  if (action === "stop") await deps.run("schtasks.exe", ["/End", "/TN", layout.serviceId]);
  if (action === "start") await deps.run("schtasks.exe", ["/Run", "/TN", layout.serviceId]);
  if (action === "restart") {
    await deps.run("schtasks.exe", ["/End", "/TN", layout.serviceId]).catch(() => {});
    await deps.run("schtasks.exe", ["/Run", "/TN", layout.serviceId]);
  }
  return `Service ${action} complete.`;
}

export function serviceSummary(
  layout = serviceLayout(supportedPlatform(process.platform)),
): string {
  return [
    `Platform: ${layout.platform}`,
    `Service: ${layout.serviceId}`,
    `Account: ${layout.account} (${layout.accountMode})`,
    `Home: ${layout.homeDir}`,
    `Data: ${layout.stateDir}`,
    `Workspaces: ${layout.workspaceDir}`,
    `Logs: ${layout.logPath}`,
    `PATH: ${layout.servicePath}`,
    `Host: http://127.0.0.1:${layout.port}`,
  ].join("\n");
}

export const currentServicePlatform = (): ServicePlatform => supportedPlatform(os.platform());

export function requireServiceAdministrator(platform = currentServicePlatform()): ServicePlatform {
  requireAdministrator(platform);
  return platform;
}

export function findInstalledServiceLayout(): ServiceLayout | null {
  const platform = currentServicePlatform();
  return readInstalledServiceLayout(platform);
}

export function installedServiceLayout(): ServiceLayout {
  const layout = findInstalledServiceLayout();
  if (!layout) {
    throw new Error(
      "The ShioriCode service is not installed. Run `shioricode service install` first.",
    );
  }
  return layout;
}

export function linkServiceStateDir(layout = installedServiceLayout()): string {
  return path.join(layout.stateDir, "userdata");
}

export async function repairServiceStateOwnership(
  layout = installedServiceLayout(),
): Promise<void> {
  if (layout.platform === "win32" || layout.accountMode === "current") return;
  await runDefault("chown", [layout.account, layout.stateDir]);
  for (const entry of fs.readdirSync(layout.stateDir, { withFileTypes: true })) {
    if (entry.name === "runtime") continue;
    await runDefault("chown", ["-R", layout.account, path.join(layout.stateDir, entry.name)]);
  }
}
