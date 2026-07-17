import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type ServicePlatform = "linux" | "darwin" | "win32";
export type ServiceAction = "start" | "stop" | "restart" | "status" | "logs" | "uninstall";

export interface ServiceLayout {
  readonly platform: ServicePlatform;
  readonly account: string;
  readonly stateDir: string;
  readonly workspaceDir: string;
  readonly definitionPath: string;
  readonly logPath: string;
  readonly serviceId: string;
}

export interface ServiceInstallResult {
  readonly layout: ServiceLayout;
  readonly recoveryUsername: string;
  readonly recoveryPassword: string;
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

function supportedPlatform(platform: NodeJS.Platform): ServicePlatform {
  if (platform === "linux" || platform === "darwin" || platform === "win32") return platform;
  throw new Error(`ShioriCode services are not supported on ${platform} yet`);
}

export function serviceLayout(platform: ServicePlatform): ServiceLayout {
  switch (platform) {
    case "linux":
      return {
        platform,
        account: "shioricode",
        stateDir: "/var/lib/shioricode",
        workspaceDir: "/var/lib/shioricode/workspaces",
        definitionPath: "/etc/systemd/system/shioricode.service",
        logPath: "/var/log/shioricode/server.log",
        serviceId: "shioricode.service",
      };
    case "darwin":
      return {
        platform,
        account: "_shioricode",
        stateDir: "/Library/Application Support/ShioriCode",
        workspaceDir: "/Users/Shared/ShioriCode/Workspaces",
        definitionPath: "/Library/LaunchDaemons/codes.shiori.shioricode.plist",
        logPath: "/Library/Logs/ShioriCode/server.log",
        serviceId: "codes.shiori.shioricode",
      };
    case "win32": {
      const programData = process.env.ProgramData || "C:\\ProgramData";
      const stateDir = path.win32.join(programData, "ShioriCode");
      return {
        platform,
        account: "ShioriCode",
        stateDir,
        workspaceDir: path.win32.join(stateDir, "workspaces"),
        definitionPath: path.win32.join(stateDir, "service.cmd"),
        logPath: path.win32.join(stateDir, "server.log"),
        serviceId: "ShioriCode",
      };
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

function serviceArguments(layout: ServiceLayout): readonly string[] {
  return [
    "serve",
    "--mode",
    "web",
    "--host",
    "127.0.0.1",
    "--port",
    String(SERVICE_PORT),
    "--base-dir",
    layout.stateDir,
    "--remote",
    "--no-browser",
  ];
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
  const nodeTarget = path.join(runtimeDir, layout.platform === "win32" ? "node.exe" : "node");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o750 });
  try {
    fs.cpSync(packageRoot, packageTarget, { recursive: true, dereference: true });
    fs.copyFileSync(deps.execPath, nodeTarget, fs.constants.COPYFILE_FICLONE);
    if (layout.platform !== "win32") fs.chmodSync(nodeTarget, 0o755);
  } catch (error) {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    throw error;
  }
  return {
    runtimeDir,
    dependencies: {
      ...deps,
      execPath: nodeTarget,
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
  readonly recoveryPassword: string;
}): string {
  const { layout } = input;
  const command = [input.execPath, input.cliPath, ...serviceArguments(layout)]
    .map(systemdQuote)
    .join(" ");
  return `[Unit]
Description=ShioriCode headless server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${layout.account}
Group=${layout.account}
WorkingDirectory=${layout.workspaceDir}
Environment=HOME=${layout.stateDir}
Environment=NODE_ENV=production
Environment=SHIORICODE_SERVICE=1
Environment=SHIORICODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=SHIORICODE_USERNAME=${RECOVERY_USERNAME}
Environment=SHIORICODE_PASSWORD=${input.recoveryPassword}
ExecStart=${command}
Restart=on-failure
RestartSec=3
SuccessExitStatus=130 143
LimitNOFILE=65535
StandardOutput=append:${layout.logPath}
StandardError=append:${layout.logPath}

[Install]
WantedBy=multi-user.target
`;
}

export function renderLaunchDaemon(input: {
  readonly layout: ServiceLayout;
  readonly execPath: string;
  readonly cliPath: string;
  readonly recoveryPassword: string;
}): string {
  const args = [input.execPath, input.cliPath, ...serviceArguments(input.layout)]
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${input.layout.serviceId}</string>
  <key>UserName</key>
  <string>${input.layout.account}</string>
  <key>GroupName</key>
  <string>${input.layout.account}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(input.layout.workspaceDir)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xmlEscape(input.layout.stateDir)}</string>
    <key>NODE_ENV</key><string>production</string>
    <key>SHIORICODE_SERVICE</key><string>1</string>
    <key>SHIORICODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD</key><string>false</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>SHIORICODE_USERNAME</key><string>${RECOVERY_USERNAME}</string>
    <key>SHIORICODE_PASSWORD</key><string>${xmlEscape(input.recoveryPassword)}</string>
  </dict>
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
  readonly recoveryPassword: string;
}): string {
  const command = [input.execPath, input.cliPath, ...serviceArguments(input.layout)]
    .map(windowsBatchQuote)
    .join(" ");
  return `@echo off\r
set "HOME=${input.layout.stateDir}"\r
set "NODE_ENV=production"\r
set "SHIORICODE_SERVICE=1"\r
set "SHIORICODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false"\r
set "SHIORICODE_USERNAME=${RECOVERY_USERNAME}"\r
set "SHIORICODE_PASSWORD=${input.recoveryPassword}"\r
cd /d ${windowsBatchQuote(input.layout.workspaceDir)}\r
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
    execPath: fs.realpathSync(process.execPath),
    cliPath: fs.realpathSync(cliArg),
    run: runDefault,
  };
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
  if (!(await commandExists(deps.run, "id", ["-u", layout.account]))) {
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
  fs.mkdirSync(layout.workspaceDir, { recursive: true, mode: 0o750 });
  fs.mkdirSync(path.dirname(layout.logPath), { recursive: true, mode: 0o750 });
  await deps.run("chown", ["-R", `${layout.account}:${layout.account}`, layout.stateDir]);
  await deps.run("chown", [
    "-R",
    `${layout.account}:${layout.account}`,
    path.dirname(layout.logPath),
  ]);
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
  recoveryPassword: string,
): Promise<void> {
  await ensureLinuxAccount(deps, layout);
  const staged = stageServiceRuntime(deps, layout);
  await protectStagedServiceRuntime(deps, layout);
  fs.writeFileSync(
    layout.definitionPath,
    renderSystemdUnit({ ...staged.dependencies, layout, recoveryPassword }),
    { mode: 0o600 },
  );
  await deps.run("systemctl", ["daemon-reload"]);
  await deps.run("systemctl", ["enable", layout.serviceId]);
  await deps.run("systemctl", ["restart", layout.serviceId]);
  pruneStagedServiceRuntimes(layout, staged.runtimeDir);
}

async function installMac(
  deps: ServiceDependencies,
  layout: ServiceLayout,
  recoveryPassword: string,
): Promise<void> {
  await ensureMacAccount(deps, layout);
  const staged = stageServiceRuntime(deps, layout);
  await protectStagedServiceRuntime(deps, layout);
  fs.writeFileSync(
    layout.definitionPath,
    renderLaunchDaemon({ ...staged.dependencies, layout, recoveryPassword }),
    { mode: 0o600 },
  );
  await deps.run("launchctl", ["bootout", "system", layout.definitionPath]).catch(() => {});
  await deps.run("launchctl", ["bootstrap", "system", layout.definitionPath]);
  await deps.run("launchctl", ["enable", `system/${layout.serviceId}`]);
  await deps.run("launchctl", ["kickstart", "-k", `system/${layout.serviceId}`]);
  pruneStagedServiceRuntimes(layout, staged.runtimeDir);
}

async function installWindows(
  deps: ServiceDependencies,
  layout: ServiceLayout,
  recoveryPassword: string,
): Promise<void> {
  const accountPassword = randomBytes(32).toString("base64url");
  const ps = renderWindowsAccountScript(layout.account, accountPassword);
  await deps.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  fs.mkdirSync(layout.workspaceDir, { recursive: true });
  await deps.run("icacls.exe", [
    layout.stateDir,
    "/inheritance:r",
    "/grant:r",
    "Administrators:(OI)(CI)F",
    `${layout.account}:(OI)(CI)M`,
    "/T",
  ]);
  const staged = stageServiceRuntime(deps, layout);
  await protectStagedServiceRuntime(deps, layout);
  fs.writeFileSync(
    layout.definitionPath,
    renderWindowsServiceScript({ ...staged.dependencies, layout, recoveryPassword }),
    "utf8",
  );
  await deps.run("schtasks.exe", ["/End", "/TN", layout.serviceId]).catch(() => {});
  await deps.run("schtasks.exe", [
    "/Create",
    "/TN",
    layout.serviceId,
    "/SC",
    "ONSTART",
    "/RU",
    `.\\${layout.account}`,
    "/RP",
    accountPassword,
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

export async function installService(
  overrides: Partial<ServiceDependencies> = {},
): Promise<ServiceInstallResult> {
  const defaults = defaultDependencies();
  const deps = { ...defaults, ...overrides };
  const layout = serviceLayout(deps.platform);
  requireAdministrator(deps.platform);
  const recoveryPassword = randomBytes(32).toString("base64url");

  if (deps.platform === "linux") await installLinux(deps, layout, recoveryPassword);
  if (deps.platform === "darwin") await installMac(deps, layout, recoveryPassword);
  if (deps.platform === "win32") await installWindows(deps, layout, recoveryPassword);

  return { layout, recoveryUsername: RECOVERY_USERNAME, recoveryPassword };
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
  const layout = serviceLayout(deps.platform);
  requireAdministrator(deps.platform);

  if (action === "logs") return await readLog(layout.logPath);

  if (deps.platform === "linux") {
    if (action === "uninstall") {
      await deps.run("systemctl", ["disable", "--now", layout.serviceId]).catch(() => {});
      fs.rmSync(layout.definitionPath, { force: true });
      await deps.run("systemctl", ["daemon-reload"]);
      return "Removed the systemd service. ShioriCode data and the service account were preserved.";
    }
    if (action === "status") {
      const result = await deps.run("systemctl", [
        "show",
        layout.serviceId,
        "--no-pager",
        "--property=LoadState,UnitFileState,ActiveState,SubState,MainPID,ExecMainStatus",
      ]);
      return result.stdout.trim();
    }
    const result = await deps.run("systemctl", [action, layout.serviceId]);
    return result.stdout.trim() || `Service ${action} complete.`;
  }

  if (deps.platform === "darwin") {
    const target = `system/${layout.serviceId}`;
    if (action === "uninstall") {
      await deps.run("launchctl", ["bootout", "system", layout.definitionPath]).catch(() => {});
      fs.rmSync(layout.definitionPath, { force: true });
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
      await deps.run("launchctl", ["bootout", "system", layout.definitionPath]);
      return "Service stop complete.";
    }
    if (action === "restart") {
      await deps.run("launchctl", ["bootout", "system", layout.definitionPath]).catch(() => {});
    }
    if (action === "start" || action === "restart") {
      await deps.run("launchctl", ["bootstrap", "system", layout.definitionPath]).catch(() => {});
      await deps.run("launchctl", ["enable", target]);
      await deps.run("launchctl", ["kickstart", "-k", target]);
    }
    return `Service ${action} complete.`;
  }

  if (action === "uninstall") {
    await deps.run("schtasks.exe", ["/End", "/TN", layout.serviceId]).catch(() => {});
    await deps.run("schtasks.exe", ["/Delete", "/TN", layout.serviceId, "/F"]);
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
    `Account: ${layout.account}`,
    `Data: ${layout.stateDir}`,
    `Workspaces: ${layout.workspaceDir}`,
    `Logs: ${layout.logPath}`,
    `Host: http://127.0.0.1:${SERVICE_PORT}`,
  ].join("\n");
}

export const currentServicePlatform = (): ServicePlatform => supportedPlatform(os.platform());

export function requireServiceAdministrator(platform = currentServicePlatform()): ServicePlatform {
  requireAdministrator(platform);
  return platform;
}

export function findInstalledServiceLayout(): ServiceLayout | null {
  const layout = serviceLayout(currentServicePlatform());
  return fs.existsSync(layout.definitionPath) ? layout : null;
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
  if (layout.platform === "win32") return;
  const owner = `${layout.account}:${layout.account}`;
  await runDefault("chown", [owner, layout.stateDir]);
  for (const entry of fs.readdirSync(layout.stateDir, { withFileTypes: true })) {
    if (entry.name === "runtime") continue;
    await runDefault("chown", ["-R", owner, path.join(layout.stateDir, entry.name)]);
  }
}
