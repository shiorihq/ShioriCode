import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { decodeServerInstanceRecord, getServerInstancePath } from "shared/serverInstance";

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
  /** Windows uses two fixed task slots so an upgrade never overwrites the healthy slot. */
  readonly managerId?: string | undefined;
  readonly port: number;
  /** Resolved from the OS, not caller-controlled environment, for dedicated Windows installs. */
  readonly runtimeRoot?: string | undefined;
}

export interface ServiceInstallResult {
  readonly layout: ServiceLayout;
  readonly recoveryUsername: string | null;
  readonly recoveryPassword: string | null;
  readonly recoveryPasswordGenerated: boolean;
  readonly warnings: readonly string[];
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
  readonly healthCheck: (
    layout: ServiceLayout,
    expectation: ServiceHealthExpectation,
  ) => Promise<void>;
}

export interface ServiceHealthExpectation {
  readonly startedAfterMs: number;
}

interface StagedServiceRuntime {
  readonly dependencies: ServiceDependencies;
  readonly runtimeDir: string;
}

const SERVICE_PORT = 3773;
const RECOVERY_USERNAME = "recovery";
const SERVICE_LAYOUT_VERSION = 1;
const SERVICE_HEALTH_TIMEOUT_MS = 20_000;
const SERVICE_LOG_MAX_BYTES = 10 * 1024 * 1024;
const SERVICE_LOG_BACKUPS = 2;
const SERVICE_LOG_TAIL_BYTES = 256 * 1024;
const SERVICE_LOG_TAIL_LINES = 200;

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
  if (account === os.userInfo().username) return os.userInfo().homedir;
  if (platform === "linux") {
    try {
      const record = execFileSync("/usr/bin/getent", ["passwd", account], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const homeDir = record.split(":")[5];
      if (homeDir && path.isAbsolute(homeDir) && !/[\0\r\n]/u.test(homeDir)) return homeDir;
    } catch {
      if (isSudoInvocation()) {
        throw new Error(`Could not resolve the real home directory for ${account}`);
      }
    }
    return account === "root" ? "/root" : path.join("/home", account);
  }
  if (platform === "darwin") {
    try {
      const output = execFileSync(
        "/usr/bin/dscl",
        [".", "-read", `/Users/${account}`, "NFSHomeDirectory"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const homeDir = output.replace(/^NFSHomeDirectory:\s*/u, "").trim();
      if (path.isAbsolute(homeDir) && !/[\0\r\n]/u.test(homeDir)) return homeDir;
    } catch {
      if (isSudoInvocation()) {
        throw new Error(`Could not resolve the real home directory for ${account}`);
      }
    }
    return path.join("/Users", account);
  }
  return process.env.USERPROFILE || os.homedir();
}

function currentLinuxSystemdConfigDir(account: string): string {
  const accountHome = defaultExistingHomeDir("linux", account);
  const xdgConfigHome =
    account === invokingUsername() && !isSudoInvocation()
      ? process.env.XDG_CONFIG_HOME?.trim()
      : undefined;
  return xdgConfigHome && path.isAbsolute(xdgConfigHome) && !/[\0\r\n]/u.test(xdgConfigHome)
    ? xdgConfigHome
    : path.join(accountHome, ".config");
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

function validateServiceAccount(
  platform: ServicePlatform,
  accountMode: ServiceAccountMode,
  account: string,
): void {
  if (platform === "win32") {
    const validCurrentAccount =
      accountMode === "current" &&
      account === account.trim() &&
      account.length > 0 &&
      account.length <= 256 &&
      !/[\0\r\n"]/u.test(account);
    const validDedicatedAccount =
      accountMode === "dedicated" &&
      account.length <= 20 &&
      !/[\0-\x1f"/\\[\]:;|=,+*?<>]/u.test(account) &&
      !/[. ]$/u.test(account);
    if (validCurrentAccount || validDedicatedAccount) return;
    throw new Error(`Invalid Windows service username: ${account}`);
  }
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
  validateServiceAccount(platform, accountMode, account);
  switch (platform) {
    case "linux": {
      const dedicatedStateDir = "/var/lib/shioricode";
      const accountHome =
        accountMode === "dedicated" ? dedicatedStateDir : defaultExistingHomeDir(platform, account);
      const homeDir = options.homeDir ?? accountHome;
      const stateDir =
        options.stateDir ??
        (accountMode === "dedicated"
          ? dedicatedStateDir
          : path.join(accountHome, ".shioricode-service"));
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
            : path.join(currentLinuxSystemdConfigDir(account), "systemd/user/shioricode.service"),
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
      const accountHome =
        accountMode === "dedicated" ? dedicatedStateDir : defaultExistingHomeDir(platform, account);
      const homeDir = options.homeDir ?? accountHome;
      const stateDir =
        options.stateDir ??
        (accountMode === "dedicated"
          ? dedicatedStateDir
          : path.join(accountHome, ".shioricode-service"));
      return validateServiceLayout({
        platform,
        accountMode,
        account,
        homeDir,
        stateDir,
        workspaceDir:
          options.workspaceDir ??
          (accountMode === "dedicated"
            ? path.join(dedicatedStateDir, "workspaces")
            : path.join(stateDir, "workspaces")),
        definitionPath:
          accountMode === "dedicated"
            ? "/Library/LaunchDaemons/codes.shiori.shioricode.plist"
            : path.join(
                defaultExistingHomeDir(platform, account),
                "Library/LaunchAgents/codes.shiori.shioricode.plist",
              ),
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
      const programData = "C:\\ProgramData";
      const dedicatedStateDir = path.win32.join(programData, "ShioriCode");
      const accountHome =
        accountMode === "dedicated" ? dedicatedStateDir : defaultExistingHomeDir(platform, account);
      const homeDir = options.homeDir ?? accountHome;
      const stateDir =
        options.stateDir ??
        (accountMode === "dedicated"
          ? dedicatedStateDir
          : path.win32.join(accountHome, ".shioricode-service"));
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
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
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

function serviceManagerId(layout: ServiceLayout): string {
  return layout.platform === "win32" ? (layout.managerId ?? layout.serviceId) : layout.serviceId;
}

export type WindowsServiceDefinitionKind = "current" | "protected" | "legacy" | "invalid";

export function windowsServiceDefinitionKind(layout: ServiceLayout): WindowsServiceDefinitionKind {
  if (layout.platform !== "win32") return "invalid";
  const actual = path.win32.resolve(layout.definitionPath).toLowerCase();
  const legacy = path.win32.resolve(path.win32.join(layout.stateDir, "service.cmd")).toLowerCase();
  if (layout.accountMode === "current") {
    return actual === legacy ? "current" : "invalid";
  }
  if (actual === legacy) return "legacy";
  if (
    layout.runtimeRoot === undefined ||
    (layout.managerId !== "ShioriCode-A" && layout.managerId !== "ShioriCode-B")
  ) {
    return "invalid";
  }
  const protectedPath = path.win32
    .resolve(path.win32.join(layout.runtimeRoot, `${layout.managerId}.cmd`))
    .toLowerCase();
  return actual === protectedPath ? "protected" : "invalid";
}

export function windowsLayoutWithManagerSlot(
  layout: ServiceLayout,
  managerId: "ShioriCode-A" | "ShioriCode-B",
): ServiceLayout {
  if (layout.platform !== "win32") {
    throw new Error("Windows manager slots require a Windows layout");
  }
  return {
    ...layout,
    managerId,
    definitionPath:
      layout.accountMode === "dedicated"
        ? path.win32.join(serviceRuntimeRoot(layout), `${managerId}.cmd`)
        : path.win32.join(layout.stateDir, "service.cmd"),
  };
}

export function windowsCandidateDefinitionPathsToSnapshot(
  layout: ServiceLayout,
): readonly string[] {
  const kind = windowsServiceDefinitionKind(layout);
  if (kind !== "current" && kind !== "protected") {
    throw new Error("Refusing an unsafe Windows service definition path");
  }
  return [layout.definitionPath];
}

export function nextWindowsServiceManagerId(
  previousLayout: ServiceLayout | null,
): "ShioriCode-A" | "ShioriCode-B" {
  return previousLayout && serviceManagerId(previousLayout) === "ShioriCode-A"
    ? "ShioriCode-B"
    : "ShioriCode-A";
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

export function serviceRuntimeRoot(layout: ServiceLayout): string {
  if (layout.runtimeRoot) return layout.runtimeRoot;
  if (layout.accountMode === "current") {
    return (layout.platform === "win32" ? path.win32 : path.posix).join(layout.stateDir, "runtime");
  }
  const identity = createHash("sha256")
    .update(`${layout.account}\0${layout.stateDir}`)
    .digest("hex")
    .slice(0, 16);
  if (layout.platform === "linux") {
    return path.posix.join("/usr/local/lib/shioricode-runtime", identity);
  }
  if (layout.platform === "darwin") {
    return path.posix.join("/Library/Application Support/ShioriCode Runtime", identity);
  }
  return path.win32.join("C:\\Program Files", "ShioriCode Runtime", identity);
}

export function renderWindowsProgramFilesProbeScript(): string {
  return `$ErrorActionPreference='Stop'
$root=[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
if ([string]::IsNullOrWhiteSpace($root) -or -not [IO.Path]::IsPathRooted($root)) { throw 'Windows did not return a trusted Program Files path.' }
$item=Get-Item -LiteralPath $root -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Program Files must not be a reparse point.' }
$acl=Get-Acl -LiteralPath $root
$trustedOwnerSids=@('S-1-5-32-544','S-1-5-18','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$ownerSid=(New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
if ($trustedOwnerSids -notcontains $ownerSid) { throw "Program Files has an unexpected owner: $($acl.Owner)" }
$mutationMask=[uint32]0x500D0156
foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
  $ruleSid=$rule.IdentityReference.Value
  if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $trustedOwnerSids -notcontains $ruleSid -and (([uint32]$rule.FileSystemRights -band $mutationMask) -ne 0)) {
    throw "Program Files grants write access to $($rule.IdentityReference.Value)."
  }
}
[Console]::Out.Write($item.FullName)`;
}

async function resolveWindowsRuntimeLayout(
  deps: ServiceDependencies,
  layout: ServiceLayout,
): Promise<ServiceLayout> {
  if (layout.platform !== "win32" || layout.accountMode !== "dedicated") return layout;
  const result = await deps.run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    renderWindowsProgramFilesProbeScript(),
  ]);
  const programFiles = result.stdout.trim();
  if (!path.win32.isAbsolute(programFiles) || /[\0\r\n]/u.test(programFiles)) {
    throw new Error("Windows did not return a valid trusted Program Files path");
  }
  const identity = createHash("sha256")
    .update(`${layout.account}\0${layout.stateDir}`)
    .digest("hex")
    .slice(0, 16);
  return {
    ...layout,
    runtimeRoot: path.win32.join(programFiles, "ShioriCode Runtime", identity),
  };
}

function normalizedLayoutPath(layout: ServiceLayout, value: string): string {
  const pathApi = layout.platform === "win32" ? path.win32 : path.posix;
  const normalized = pathApi.resolve(value).replace(/[\\/]+$/, "");
  return layout.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function servicePathsOverlap(layout: ServiceLayout, left: string, right: string): boolean {
  const separator = layout.platform === "win32" ? "\\" : "/";
  const normalizedLeft = normalizedLayoutPath(layout, left);
  const normalizedRight = normalizedLayoutPath(layout, right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}${separator}`) ||
    normalizedRight.startsWith(`${normalizedLeft}${separator}`)
  );
}

function servicePathIsWithin(layout: ServiceLayout, candidate: string, parent: string): boolean {
  const separator = layout.platform === "win32" ? "\\" : "/";
  const normalizedCandidate = normalizedLayoutPath(layout, candidate);
  const normalizedParent = normalizedLayoutPath(layout, parent);
  return (
    normalizedCandidate === normalizedParent ||
    normalizedCandidate.startsWith(`${normalizedParent}${separator}`)
  );
}

export function validateDedicatedRuntimeSeparation(layout: ServiceLayout): void {
  if (layout.accountMode !== "dedicated") return;
  const runtimeRoot = serviceRuntimeRoot(layout);
  const pathApi = layout.platform === "win32" ? path.win32 : path.posix;
  for (const writablePath of [
    layout.stateDir,
    layout.workspaceDir,
    pathApi.dirname(layout.logPath),
  ]) {
    if (servicePathsOverlap(layout, runtimeRoot, writablePath)) {
      throw new Error(
        `The dedicated service runtime (${runtimeRoot}) must not overlap a service-writable path (${writablePath})`,
      );
    }
  }
}

export function validatePosixWritableTargets(layout: ServiceLayout): void {
  if (layout.platform === "win32") return;
  const pathApi = path.posix;
  const protectedRoots = new Set(
    [
      "/",
      "/etc",
      "/usr",
      "/usr/local",
      "/var",
      "/var/lib",
      "/var/log",
      "/home",
      "/opt",
      "/Library",
      "/Library/Application Support",
      "/Library/Logs",
      "/System",
      "/Applications",
      "/Users",
      "/Users/Shared",
    ].map((candidate) => pathApi.resolve(candidate)),
  );
  for (const directory of [layout.stateDir, layout.workspaceDir, pathApi.dirname(layout.logPath)]) {
    const resolved = pathApi.resolve(directory);
    if (
      protectedRoots.has(resolved) ||
      servicePathIsWithin(layout, layout.definitionPath, resolved)
    ) {
      throw new Error(`Refusing protected POSIX path as service-writable storage: ${directory}`);
    }
    validatePosixDirectoryBoundary(directory, posixBoundaryOptions(layout));
  }
}

function validateServiceWritableTargets(layout: ServiceLayout): void {
  validateDedicatedRuntimeSeparation(layout);
  if (layout.platform === "win32") validateWindowsWritableTargets(layout);
  else validatePosixWritableTargets(layout);
}

export function stageServiceExecutable(
  sourcePath: string,
  runtimeDir: string,
  platform: ServicePlatform,
): string {
  const realSourcePath = fs.realpathSync(sourcePath);
  const sourceBinDir = path.dirname(realSourcePath);
  const sourceRoot = path.dirname(sourceBinDir);
  const bundleRoot = path.join(runtimeDir, "runtime-bundle");
  const targetBinDir = path.join(bundleRoot, "bin");
  const targetPath = path.join(targetBinDir, platform === "win32" ? "runtime.exe" : "runtime");
  fs.mkdirSync(targetBinDir, { recursive: true, mode: 0o755 });
  fs.copyFileSync(realSourcePath, targetPath);
  if (platform !== "win32") fs.chmodSync(targetPath, 0o755);

  // Homebrew's Node executable is a thin Mach-O binary whose @rpath points to
  // ../lib/libnode*. Keep the executable in a bin/../lib bundle and copy the
  // matching split-runtime libraries. Self-contained Node/Bun executables have
  // no such files, so this remains a single-binary copy for those installs.
  const sourceLibDir = path.join(sourceRoot, "lib");
  if (fs.existsSync(sourceLibDir)) {
    for (const entry of fs.readdirSync(sourceLibDir, { withFileTypes: true })) {
      if (!/^libnode(?:\.|$)/.test(entry.name) || (!entry.isFile() && !entry.isSymbolicLink())) {
        continue;
      }
      const targetLibDir = path.join(bundleRoot, "lib");
      fs.mkdirSync(targetLibDir, { recursive: true, mode: 0o755 });
      fs.cpSync(path.join(sourceLibDir, entry.name), path.join(targetLibDir, entry.name), {
        dereference: true,
      });
    }
  }
  if (platform === "win32") {
    for (const entry of fs.readdirSync(sourceBinDir, { withFileTypes: true })) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".dll") continue;
      fs.copyFileSync(path.join(sourceBinDir, entry.name), path.join(targetBinDir, entry.name));
    }
  }
  return targetPath;
}

export function renderServiceHostScript(input: {
  readonly execPath: string;
  readonly cliPath: string;
  readonly logPath: string;
  readonly maxLogBytes?: number | undefined;
  readonly logBackups?: number | undefined;
}): string {
  const maxLogBytes = input.maxLogBytes ?? SERVICE_LOG_MAX_BYTES;
  const logBackups = input.logBackups ?? SERVICE_LOG_BACKUPS;
  return `import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";

const execPath = ${JSON.stringify(input.execPath)};
const cliPath = ${JSON.stringify(input.cliPath)};
const logPath = ${JSON.stringify(input.logPath)};
const maxLogBytes = ${maxLogBytes};
const logBackups = ${logBackups};

function rotateLog() {
  for (let index = logBackups; index >= 1; index -= 1) {
    const source = index === 1 ? logPath : \`\${logPath}.\${index - 1}\`;
    const target = \`\${logPath}.\${index}\`;
    try {
      fs.rmSync(target, { force: true });
      fs.renameSync(source, target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function appendLog(chunk) {
  let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  let currentSize = 0;
  try {
    currentSize = fs.statSync(logPath).size;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (currentSize + data.length > maxLogBytes) {
    rotateLog();
    if (data.length > maxLogBytes) data = data.subarray(data.length - maxLogBytes);
  }
  fs.appendFileSync(logPath, data);
}

const child = spawn(execPath, [cliPath, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
  windowsHide: true,
});
let terminating = false;

function childHasExited() {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalChildTree(signal) {
  if (!child.pid || childHasExited()) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && !childHasExited()) {
      throw new Error(\`taskkill failed with status \${result.status}\`);
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForChildExit(timeoutMs) {
  if (childHasExited()) return;
  await Promise.race([
    once(child, "close"),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function terminateChildTree(signal) {
  signalChildTree(signal);
  await waitForChildExit(1500);
  if (!childHasExited()) {
    signalChildTree("SIGKILL");
    await waitForChildExit(1500);
  }
  if (!childHasExited()) {
    throw new Error("ShioriCode child tree remained alive after SIGKILL");
  }
}

async function failHost(error) {
  if (terminating) return;
  terminating = true;
  child.stdout?.pause();
  child.stderr?.pause();
  try {
    process.stderr.write(\`ShioriCode service log failure: \${error?.stack ?? error}\\n\`);
  } catch {}
  try {
    await terminateChildTree("SIGTERM");
  } catch (terminationError) {
    try {
      process.stderr.write(\`Failed to terminate ShioriCode child tree: \${terminationError?.stack ?? terminationError}\\n\`);
    } catch {}
    // Keep supervising the still-live child instead of exiting and orphaning it.
    process.exitCode = 1;
    return;
  }
  process.exit(1);
}

function safelyAppendLog(chunk) {
  if (terminating) return;
  try {
    appendLog(chunk);
  } catch (error) {
    void failHost(error);
  }
}

child.stdout.on("data", safelyAppendLog);
child.stderr.on("data", safelyAppendLog);
child.on("error", (error) => void failHost(error));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (terminating) return;
    terminating = true;
    void terminateChildTree(signal).then(
      () => process.exit(signal === "SIGINT" ? 130 : 143),
      (error) => {
        try {
          process.stderr.write(\`Failed to terminate ShioriCode child tree: \${error?.stack ?? error}\\n\`);
        } catch {}
        process.exitCode = 1;
      },
    );
  });
}
child.on("close", (code, signal) => {
  if (terminating) return;
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
});
`;
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
    fs.cpSync(packageRoot, packageTarget, {
      recursive: true,
      dereference: true,
    });
    const execPath = stageServiceExecutable(deps.execPath, runtimeDir, layout.platform);
    const cliPath = path.join(packageTarget, "dist", "bin.mjs");
    const hostPath = path.join(runtimeDir, "service-host.mjs");
    fs.writeFileSync(
      hostPath,
      renderServiceHostScript({ execPath, cliPath, logPath: layout.logPath }),
      { mode: 0o640 },
    );
    return {
      runtimeDir,
      dependencies: {
        ...deps,
        execPath,
        cliPath: hostPath,
      },
    };
  } catch (error) {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    throw error;
  }
}

export function windowsRuntimeProtectionArguments(
  layout: ServiceLayout,
  recursive: boolean,
): readonly string[] {
  return [
    serviceRuntimeRoot(layout),
    "/inheritance:r",
    "/grant:r",
    "SYSTEM:(OI)(CI)F",
    "Administrators:(OI)(CI)F",
    `${layout.account}:(OI)(CI)RX`,
    ...(recursive ? ["/T"] : []),
  ];
}

export function renderWindowsDirectoryAclScript(input: {
  readonly directory: string;
  readonly account: string;
  readonly access: "modify" | "read-execute" | "none";
  readonly recursive: boolean;
  /** Required for recursion: the tree was staged before the service gained access. */
  readonly freshTree?: boolean | undefined;
  readonly owner?: "account" | "administrators" | undefined;
}): string {
  if (input.recursive && input.freshTree !== true) {
    throw new Error("Recursive Windows ACL replacement is limited to a freshly staged tree");
  }
  const serviceRights = input.access === "modify" ? "Modify" : "ReadAndExecute";
  const serviceDirectoryRule =
    input.access === "none"
      ? ""
      : "$security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($serviceIdentity,$serviceRights,$inheritance,$propagation,$allow)))";
  const serviceFileRule =
    input.access === "none"
      ? ""
      : "$security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($serviceIdentity,$serviceRights,$allow)))";
  const ownerIdentity = input.owner === "account" ? input.account : "BUILTIN\\Administrators";
  return `$ErrorActionPreference='Stop'
$target=${powershellSingleQuote(input.directory)}
$serviceIdentity=${powershellSingleQuote(input.account)}
$serviceRights=[Security.AccessControl.FileSystemRights]::${serviceRights}
function Set-ShioriDirectoryAcl([string]$path) {
  $security=New-Object Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner((New-Object Security.Principal.NTAccount(${powershellSingleQuote(ownerIdentity)})))
  $inheritance=[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $propagation=[Security.AccessControl.PropagationFlags]::None
  $allow=[Security.AccessControl.AccessControlType]::Allow
  $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('NT AUTHORITY\\SYSTEM','FullControl',$inheritance,$propagation,$allow)))
  $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('BUILTIN\\Administrators','FullControl',$inheritance,$propagation,$allow)))
  ${serviceDirectoryRule}
  Set-Acl -LiteralPath $path -AclObject $security
}
function Set-ShioriFileAcl([string]$path) {
  $security=New-Object Security.AccessControl.FileSecurity
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner((New-Object Security.Principal.NTAccount(${powershellSingleQuote(ownerIdentity)})))
  $allow=[Security.AccessControl.AccessControlType]::Allow
  $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('NT AUTHORITY\\SYSTEM','FullControl',$allow)))
  $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('BUILTIN\\Administrators','FullControl',$allow)))
  ${serviceFileRule}
  Set-Acl -LiteralPath $path -AclObject $security
}
$targetItem=Get-Item -LiteralPath $target -Force
if (($targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse point: $target" }
${
  input.recursive
    ? '$managedItems=@(Get-ChildItem -LiteralPath $target -Recurse -Force | Select-Object -First 100001); if ($managedItems.Count -gt 100000) { throw "Refusing to mutate ACLs for more than 100000 descendants: $target" }; foreach ($item in $managedItems) { if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse point: $($item.FullName)" } }; Set-ShioriDirectoryAcl $target; foreach ($item in $managedItems) { if ($item.PSIsContainer) { Set-ShioriDirectoryAcl $item.FullName } else { Set-ShioriFileAcl $item.FullName } }'
    : "Set-ShioriDirectoryAcl $target"
}`;
}

export function renderWindowsFileAclScript(input: {
  readonly filePath: string;
  readonly account: string;
  readonly access: "modify" | "read-execute" | "none";
  readonly owner?: "account" | "administrators" | undefined;
}): string {
  const serviceRights = input.access === "modify" ? "Modify" : "ReadAndExecute";
  const serviceRule =
    input.access === "none"
      ? ""
      : "$security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($serviceIdentity,$serviceRights,$allow)))";
  const ownerIdentity = input.owner === "account" ? input.account : "BUILTIN\\Administrators";
  return `$ErrorActionPreference='Stop'
$target=${powershellSingleQuote(input.filePath)}
$serviceIdentity=${powershellSingleQuote(input.account)}
$serviceRights=[Security.AccessControl.FileSystemRights]::${serviceRights}
$item=Get-Item -LiteralPath $target -Force
if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw "Refusing unsafe ACL file target: $target" }
$security=New-Object Security.AccessControl.FileSecurity
$security.SetAccessRuleProtection($true, $false)
$security.SetOwner((New-Object Security.Principal.NTAccount(${powershellSingleQuote(ownerIdentity)})))
$allow=[Security.AccessControl.AccessControlType]::Allow
$security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('NT AUTHORITY\\SYSTEM','FullControl',$allow)))
$security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('BUILTIN\\Administrators','FullControl',$allow)))
${serviceRule}
Set-Acl -LiteralPath $item.FullName -AclObject $security`;
}

export interface WindowsAclSnapshot {
  readonly filePath: string;
  readonly sddl: string;
}

export interface WindowsAclSnapshotRoot {
  readonly directory: string;
  /** ACL transactions intentionally snapshot exact roots only. */
  readonly recursive: boolean;
}

const WINDOWS_ACL_SNAPSHOT_ROOT_LIMIT = 16;
const WINDOWS_ACL_SDDL_LIMIT = 8 * 1024;
const WINDOWS_ACL_PATH_LIMIT = 512;

export function normalizeWindowsAclSnapshotRoots(
  requestedRoots: readonly WindowsAclSnapshotRoot[],
): readonly WindowsAclSnapshotRoot[] {
  const candidates = new Map<string, WindowsAclSnapshotRoot>();
  for (const { directory } of requestedRoots) {
    if (
      !path.win32.isAbsolute(directory) ||
      directory.length > WINDOWS_ACL_PATH_LIMIT ||
      /[\0\r\n]/u.test(directory)
    ) {
      throw new Error("Windows ACL roots must be bounded canonical absolute paths");
    }
    const normalized = path.win32.resolve(directory).toLowerCase();
    const existing = candidates.get(normalized);
    candidates.set(normalized, {
      directory: existing?.directory ?? directory,
      recursive: false,
    });
  }
  if (candidates.size > WINDOWS_ACL_SNAPSHOT_ROOT_LIMIT) {
    throw new Error(
      `Refusing to transact more than ${WINDOWS_ACL_SNAPSHOT_ROOT_LIMIT} Windows ACL roots`,
    );
  }
  return [...candidates.values()];
}

export function renderWindowsAclSnapshotScript(roots: readonly WindowsAclSnapshotRoot[]): string {
  const specs = normalizeWindowsAclSnapshotRoots(roots)
    .map(({ directory }) => `@{ Directory=${powershellSingleQuote(directory)} }`)
    .join(",");
  return `$ErrorActionPreference='Stop'
$specs=@(${specs})
$approved=@()
foreach ($spec in $specs) {
  $target=$spec.Directory
  if (-not (Test-Path -LiteralPath $target)) { continue }
  $root=Get-Item -LiteralPath $target -Force
  if (-not $root.PSIsContainer -or (($root.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw "Refusing unsafe ACL snapshot root: $target" }
  $acl=Get-Acl -LiteralPath $root.FullName
  $sddl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)
  if ($sddl.Length -gt ${WINDOWS_ACL_SDDL_LIMIT}) { throw "Refusing oversized ACL snapshot: $target" }
  $approved += @{ Path=$root.FullName; Sddl=$sddl }
}
[Console]::Out.Write(($approved | ConvertTo-Json -Compress))`;
}

export function renderWindowsAclRestoreScript(snapshots: readonly WindowsAclSnapshot[]): string {
  if (snapshots.length !== 1) {
    throw new Error("Windows ACLs must be restored one bounded root at a time");
  }
  const [snapshot] = snapshots;
  if (
    !snapshot ||
    !path.win32.isAbsolute(snapshot.filePath) ||
    snapshot.filePath.length > WINDOWS_ACL_PATH_LIMIT ||
    /[\0\r\n]/u.test(snapshot.filePath) ||
    snapshot.sddl.length > WINDOWS_ACL_SDDL_LIMIT
  ) {
    throw new Error("Refusing an oversized or invalid Windows ACL restore record");
  }
  const encoded = Buffer.from(JSON.stringify(snapshots), "utf8").toString("base64");
  return `$ErrorActionPreference='Stop'
$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powershellSingleQuote(encoded)}))
$records=@($json | ConvertFrom-Json) | Sort-Object { $_.Path.Length } -Descending
foreach ($record in $records) {
  if (-not (Test-Path -LiteralPath $record.Path)) { continue }
  $item=Get-Item -LiteralPath $record.Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse point during ACL restore: $($record.Path)" }
  $acl=Get-Acl -LiteralPath $item.FullName
  $acl.SetSecurityDescriptorSddlForm($record.Sddl, [Security.AccessControl.AccessControlSections]::All)
  Set-Acl -LiteralPath $item.FullName -AclObject $acl
}`;
}

async function snapshotWindowsAcls(
  deps: Pick<ServiceDependencies, "run">,
  requestedRoots: readonly WindowsAclSnapshotRoot[],
): Promise<readonly WindowsAclSnapshot[]> {
  const normalizedRoots = normalizeWindowsAclSnapshotRoots(requestedRoots);
  const roots = new Map<string, WindowsAclSnapshotRoot>();
  for (const root of normalizedRoots) {
    roots.set(path.win32.resolve(root.directory).toLowerCase(), root);
  }
  if (roots.size === 0) return [];
  const result = await deps.run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    renderWindowsAclSnapshotScript([...roots.values()]),
  ]);
  if (!result.stdout.trim()) return [];
  const parsed = JSON.parse(result.stdout) as unknown;
  const records = Array.isArray(parsed) ? parsed : [parsed];
  const approved = new Map<string, WindowsAclSnapshot>();
  for (const record of records) {
    if (
      typeof record !== "object" ||
      record === null ||
      typeof (record as { Path?: unknown }).Path !== "string" ||
      typeof (record as { Sddl?: unknown }).Sddl !== "string"
    ) {
      throw new Error("Windows ACL preflight returned an invalid snapshot");
    }
    const value = record as { readonly Path: string; readonly Sddl: string };
    const normalized = path.win32.resolve(value.Path).toLowerCase();
    if (
      !roots.has(normalized) ||
      approved.has(normalized) ||
      value.Sddl.length > WINDOWS_ACL_SDDL_LIMIT
    ) {
      throw new Error("Windows ACL preflight returned an unsafe snapshot");
    }
    approved.set(normalized, { filePath: value.Path, sddl: value.Sddl });
  }
  if (approved.size > roots.size) {
    throw new Error("Windows ACL preflight returned too many snapshots");
  }
  return [...approved.values()];
}

async function restoreWindowsAcls(
  deps: Pick<ServiceDependencies, "run">,
  snapshots: readonly WindowsAclSnapshot[],
): Promise<void> {
  if (snapshots.length === 0) return;
  for (const snapshot of snapshots) {
    await deps.run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      renderWindowsAclRestoreScript([snapshot]),
    ]);
  }
}

async function quarantineFreshWindowsDirectories(
  deps: Pick<ServiceDependencies, "run">,
  layout: ServiceLayout,
  directories: readonly string[],
): Promise<void> {
  const shallowestFirst = directories.toSorted((left, right) => left.length - right.length);
  if (layout.accountMode === "dedicated") {
    // Revoke access at stable top-level roots first. Once a parent is
    // admin-only, a persistent service-UID process cannot swap descendants.
    for (const directory of shallowestFirst) {
      if (fs.existsSync(directory)) {
        await applyWindowsDirectoryAcl(deps, layout, directory, "none", false);
      }
    }
  }
  // Remove only exact empty roots, deepest first. Nonempty roots remain
  // quarantined instead of recursively walking candidate-controlled state.
  for (const directory of shallowestFirst.toReversed()) {
    if (!fs.existsSync(directory)) continue;
    await validateWindowsDirectoryBoundaries(deps, [path.win32.dirname(directory), directory]);
    try {
      fs.rmdirSync(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    }
  }
}

export function renderWindowsDirectoryBoundaryScript(directories: readonly string[]): string {
  const targets = directories.map(powershellSingleQuote).join(",");
  return `$ErrorActionPreference='Stop'
$targets=@(${targets})
foreach ($target in $targets) {
  $current=[IO.Path]::GetFullPath($target)
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item=Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse point: $current" }
    }
    $parent=[IO.Directory]::GetParent($current)
    if ($null -eq $parent) { break }
    $current=$parent.FullName
  }
}`;
}

export function renderWindowsDirectoryAdoptionScript(
  directories: readonly {
    readonly directory: string;
    readonly managed: boolean;
    readonly required?: boolean;
  }[],
  account: string,
  accountMode: ServiceAccountMode = "dedicated",
): string {
  const specs = directories
    .map(
      ({ directory, managed, required = managed }) =>
        `@{ Directory=${powershellSingleQuote(directory)}; Managed=$${managed ? "true" : "false"}; Required=$${required ? "true" : "false"} }`,
    )
    .join(",");
  return `$ErrorActionPreference='Stop'
$specs=@(${specs})
$baseTrustedSids=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$currentMode=$${accountMode === "current" ? "true" : "false"}
$accountSid=$null
if ($currentMode -or $null -ne ($specs | Where-Object { $_.Managed } | Select-Object -First 1)) {
  $accountSid=(New-Object Security.Principal.NTAccount(${powershellSingleQuote(account)})).Translate([Security.Principal.SecurityIdentifier]).Value
}
$currentIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
$currentPrincipal=New-Object Security.Principal.WindowsPrincipal($currentIdentity)
if ($currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { $baseTrustedSids += $currentIdentity.User.Value }
$mutationMask=[uint32]0x500D0156
$replacementMask=[uint32]0x100D0040
foreach ($spec in $specs) {
  $target=$spec.Directory
  $ancestorTrustedSids=@($baseTrustedSids)
  if ($currentMode) { $ancestorTrustedSids += $accountSid }
  $targetTrustedSids=@($ancestorTrustedSids)
  if ($spec.Managed) { $targetTrustedSids += $accountSid }
  $targetFullPath=[IO.Path]::GetFullPath($target)
  $current=$targetFullPath
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $component=Get-Item -LiteralPath $current -Force
      if (($component.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse point: $current" }
      $componentAcl=Get-Acl -LiteralPath $component.FullName
      $componentOwnerSid=$componentAcl.Owner
      try { $componentOwnerSid=(New-Object Security.Principal.NTAccount($componentOwnerSid)).Translate([Security.Principal.SecurityIdentifier]).Value } catch {}
      if ($ancestorTrustedSids -notcontains $componentOwnerSid) { throw "Refusing a Windows service path with an untrusted owner: $current" }
      $componentAclTrustedSids=if ([string]::Equals($component.FullName,$targetFullPath,[StringComparison]::OrdinalIgnoreCase)) { $targetTrustedSids } else { $ancestorTrustedSids }
      foreach ($rule in $componentAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            $componentAclTrustedSids -notcontains $rule.IdentityReference.Value -and
            (([uint32]$rule.FileSystemRights -band $replacementMask) -ne 0)) {
          throw "Refusing a Windows service path with untrusted replacement access: $current"
        }
      }
    }
    $parent=[IO.Directory]::GetParent($current)
    if ($null -eq $parent) { break }
    $current=$parent.FullName
  }
  if (-not (Test-Path -LiteralPath $target)) {
    if ($spec.Required) { throw "A required Windows service root is missing: $target" }
    continue
  }
  $item=Get-Item -LiteralPath $target -Force
  if (-not $item.PSIsContainer) { throw "Refusing non-directory Windows service root: $target" }
  $acl=Get-Acl -LiteralPath $item.FullName
  $ownerSid=$acl.Owner
  try { $ownerSid=(New-Object Security.Principal.NTAccount($ownerSid)).Translate([Security.Principal.SecurityIdentifier]).Value } catch {}
  if ($ancestorTrustedSids -notcontains $ownerSid) { throw "Refusing a Windows service root with an untrusted owner: $target" }
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        $targetTrustedSids -notcontains $rule.IdentityReference.Value -and
        (([uint32]$rule.FileSystemRights -band $mutationMask) -ne 0)) {
      throw "Refusing a Windows service root with untrusted mutation access: $target"
    }
  }
  if (-not $spec.Managed -and $null -ne (Get-ChildItem -LiteralPath $target -Force | Select-Object -First 1)) {
    throw "Refusing to adopt a nonempty unrecorded Windows service root: $target"
  }
}`;
}

async function prevalidateWindowsUnmanagedDirectories(
  deps: Pick<ServiceDependencies, "run">,
  layout: ServiceLayout,
  directories: readonly string[],
  requiredDirectories: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (directories.length === 0) return;
  await deps.run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    renderWindowsDirectoryAdoptionScript(
      directories.map((directory) => ({
        directory,
        managed: false,
        required: requiredDirectories.has(path.win32.resolve(directory).toLowerCase()),
      })),
      layout.account,
      layout.accountMode,
    ),
  ]);
}

async function validateWindowsDirectoryBoundaries(
  deps: Pick<ServiceDependencies, "run">,
  directories: readonly string[],
): Promise<void> {
  await deps.run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    renderWindowsDirectoryBoundaryScript(directories),
  ]);
}

async function applyWindowsDirectoryAcl(
  deps: Pick<ServiceDependencies, "run">,
  layout: ServiceLayout,
  directory: string,
  access: "modify" | "read-execute" | "none",
  recursive: boolean,
  freshTree = false,
): Promise<void> {
  await deps.run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    renderWindowsDirectoryAclScript({
      directory,
      account: layout.account,
      access,
      recursive,
      freshTree,
      owner: layout.accountMode === "current" ? "account" : "administrators",
    }),
  ]);
}

async function applyWindowsFileAcl(
  deps: Pick<ServiceDependencies, "run">,
  layout: ServiceLayout,
  filePath: string,
  access: "modify" | "read-execute" | "none",
): Promise<void> {
  await deps.run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    renderWindowsFileAclScript({
      filePath,
      account: layout.account,
      access,
      owner: layout.accountMode === "current" ? "account" : "administrators",
    }),
  ]);
}

async function prepareServiceRuntimeRoot(
  deps: ServiceDependencies,
  layout: ServiceLayout,
): Promise<void> {
  const runtimeRoot = serviceRuntimeRoot(layout);
  if (layout.platform === "win32") {
    await validateWindowsDirectoryBoundaries(deps, [path.win32.dirname(runtimeRoot), runtimeRoot]);
  }
  fs.mkdirSync(runtimeRoot, {
    recursive: true,
    mode: layout.accountMode === "dedicated" ? 0o755 : 0o750,
  });
  if (layout.accountMode === "current") {
    if (layout.platform !== "win32") fs.chmodSync(runtimeRoot, 0o750);
    return;
  }
  if (layout.platform === "win32") {
    const runtimeParent = path.win32.dirname(runtimeRoot);
    fs.mkdirSync(runtimeParent, { recursive: true });
    await applyWindowsDirectoryAcl(deps, layout, runtimeParent, "read-execute", false);
    await applyWindowsDirectoryAcl(deps, layout, runtimeRoot, "read-execute", false);
    return;
  }
  await deps.run("chown", [layout.platform === "darwin" ? "root:wheel" : "root:root", runtimeRoot]);
  await deps.run("chmod", ["0755", runtimeRoot]);
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

export async function verifyServiceAndPruneRuntimes(
  layout: ServiceLayout,
  activeRuntimeDir: string,
  expectation: ServiceHealthExpectation,
  healthCheck: ServiceDependencies["healthCheck"],
): Promise<void> {
  await healthCheck(layout, expectation);
  pruneStagedServiceRuntimes(layout, activeRuntimeDir);
}

async function protectStagedServiceRuntime(
  deps: ServiceDependencies,
  layout: ServiceLayout,
  runtimeDir: string,
): Promise<void> {
  if (layout.accountMode === "current") {
    if (layout.platform !== "win32") await deps.run("chmod", ["-R", "u=rwX,go=", runtimeDir]);
    return;
  }
  if (layout.platform === "win32") {
    await applyWindowsDirectoryAcl(deps, layout, runtimeDir, "read-execute", true, true);
    return;
  }
  await deps.run("chown", [
    "-R",
    layout.platform === "darwin" ? "root:wheel" : "root:root",
    runtimeDir,
  ]);
  await deps.run("chmod", ["-R", "u=rwX,go=rX", runtimeDir]);
  await deps.run("chmod", ["0755", serviceRuntimeRoot(layout)]);
}

function runtimeParentDirectories(executablePath: string): readonly string[] {
  const result: string[] = [];
  let current = path.dirname(executablePath);
  while (true) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) return result;
    current = parent;
  }
}

async function runAsServiceAccount(
  deps: Pick<ServiceDependencies, "run">,
  layout: ServiceLayout,
  file: string,
  args: readonly string[],
): Promise<CommandResult> {
  if (layout.platform === "win32") {
    return await deps.run(file, args);
  }
  if (
    layout.accountMode === "current" &&
    layout.account === os.userInfo().username &&
    !(typeof process.getuid === "function" && process.getuid() === 0 && layout.account !== "root")
  ) {
    return await deps.run(file, args);
  }
  if (layout.platform === "linux") {
    return await deps.run("/usr/sbin/runuser", ["-u", layout.account, "--", file, ...args]);
  }
  return await deps.run("/usr/bin/sudo", ["-u", layout.account, file, ...args]);
}

async function validateServiceRuntimeExecutable(
  deps: ServiceDependencies,
  layout: ServiceLayout,
  executablePath: string,
): Promise<void> {
  if (layout.accountMode === "dedicated" && layout.platform === "win32") {
    const runtimeRoot = serviceRuntimeRoot(layout);
    const trustedRoots = [runtimeRoot, path.win32.dirname(path.win32.dirname(runtimeRoot))];
    if (!trustedRoots.some((root) => servicePathIsWithin(layout, executablePath, root))) {
      throw new Error(
        `The original Windows runtime is not under a protected system directory: ${executablePath}`,
      );
    }
  }
  if (layout.accountMode === "dedicated" && layout.platform !== "win32") {
    for (const candidate of [executablePath, ...runtimeParentDirectories(executablePath)]) {
      await runAsServiceAccount(deps, layout, "/usr/bin/test", ["!", "-w", candidate]);
    }
  }
  await runAsServiceAccount(deps, layout, executablePath, ["--version"]);
}

async function validateStagedRuntimeProtection(
  deps: ServiceDependencies,
  layout: ServiceLayout,
  runtimeDir: string,
): Promise<void> {
  if (layout.accountMode !== "dedicated" || layout.platform === "win32") return;
  for (const candidate of [runtimeDir, ...runtimeParentDirectories(runtimeDir)]) {
    await runAsServiceAccount(deps, layout, "/usr/bin/test", ["!", "-w", candidate]);
  }
}

export async function selectServiceRuntimeExecutable(
  stagedExecPath: string,
  originalExecPath: string,
  validate: (executablePath: string) => Promise<void>,
): Promise<string> {
  try {
    await validate(stagedExecPath);
    return stagedExecPath;
  } catch (stagedError) {
    try {
      await validate(originalExecPath);
      return originalExecPath;
    } catch (originalError) {
      const failure = new Error(
        "Neither the staged runtime nor the protected original runtime can execute as the service account",
        { cause: originalError },
      ) as Error & { errors: readonly unknown[] };
      failure.errors = [stagedError, originalError];
      throw failure;
    }
  }
}

function rewriteStagedServiceHost(
  staged: StagedServiceRuntime,
  layout: ServiceLayout,
  execPath: string,
): StagedServiceRuntime {
  const cliPath = path.join(staged.runtimeDir, "package", "dist", "bin.mjs");
  const hostPath = path.join(staged.runtimeDir, "service-host.mjs");
  fs.writeFileSync(
    hostPath,
    renderServiceHostScript({ execPath, cliPath, logPath: layout.logPath }),
    {
      mode: 0o640,
    },
  );
  return {
    ...staged,
    dependencies: { ...staged.dependencies, execPath },
  };
}

async function stageProtectedServiceRuntime(
  deps: ServiceDependencies,
  layout: ServiceLayout,
): Promise<StagedServiceRuntime> {
  await prepareServiceRuntimeRoot(deps, layout);
  let staged = stageServiceRuntime(deps, layout);
  try {
    await protectStagedServiceRuntime(deps, layout, staged.runtimeDir);
    await validateStagedRuntimeProtection(deps, layout, staged.runtimeDir);
    const selectedExecPath = await selectServiceRuntimeExecutable(
      staged.dependencies.execPath,
      deps.execPath,
      async (executablePath) =>
        await validateServiceRuntimeExecutable(deps, layout, executablePath),
    );
    if (selectedExecPath !== staged.dependencies.execPath) {
      staged = rewriteStagedServiceHost(staged, layout, selectedExecPath);
      await protectStagedServiceRuntime(deps, layout, staged.runtimeDir);
      await validateStagedRuntimeProtection(deps, layout, staged.runtimeDir);
    }
    return staged;
  } catch (error) {
    fs.rmSync(staged.runtimeDir, { recursive: true, force: true });
    throw error;
  }
}

async function configureStagedServiceRuntime(
  deps: ServiceDependencies,
  layout: ServiceLayout,
  configure: (staged: StagedServiceRuntime) => Promise<void>,
): Promise<StagedServiceRuntime> {
  const staged = await stageProtectedServiceRuntime(deps, layout);
  try {
    await configure(staged);
    return staged;
  } catch (error) {
    const failure = new Error("Failed to configure the staged service runtime", {
      cause: error,
    }) as Error & { stagedRuntime: StagedServiceRuntime };
    failure.stagedRuntime = staged;
    throw failure;
  }
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
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=${layout.accountMode === "current" ? "default.target" : "multi-user.target"}
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
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
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
	${command}\r
	`;
}

async function runDefault(file: string, args: readonly string[]): Promise<CommandResult> {
  const result = await execFile(file, [...args], { windowsHide: true });
  return { stdout: result.stdout, stderr: result.stderr };
}

function comparableServicePath(platform: ServicePlatform, value: string): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalized = pathApi.resolve(value).replace(/[\\/]+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
  platform: ServicePlatform = supportedPlatform(process.platform),
): Buffer {
  const linkStat = fs.lstatSync(filePath);
  if (!linkStat.isFile() || linkStat.isSymbolicLink()) {
    throw new Error(`Refusing to read a non-regular service file: ${filePath}`);
  }
  const handle = fs.openSync(
    filePath,
    fs.constants.O_RDONLY |
      fs.constants.O_NONBLOCK |
      (platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0)),
  );
  try {
    const before = fs.fstatSync(handle);
    if (!before.isFile() || before.size > maxBytes) {
      throw new Error(`Service file exceeds the ${maxBytes}-byte limit: ${filePath}`);
    }
    const output = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < output.length) {
      const bytesRead = fs.readSync(handle, output, offset, output.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new Error(`Service file exceeds the ${maxBytes}-byte limit: ${filePath}`);
    }
    const after = fs.fstatSync(handle);
    if (after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error(`Service file changed identity while being read: ${filePath}`);
    }
    return output.subarray(0, offset);
  } finally {
    fs.closeSync(handle);
  }
}

function readFreshServerIdentity(
  layout: ServiceLayout,
  expectation: ServiceHealthExpectation,
): ReturnType<typeof decodeServerInstanceRecord> {
  const record = decodeServerInstanceRecord(
    JSON.parse(
      readBoundedRegularFile(
        getServerInstancePath(layout.stateDir),
        64 * 1024,
        layout.platform,
      ).toString("utf8"),
    ),
  );
  const startedAtMs = Date.parse(record.startedAt);
  if (!Number.isFinite(startedAtMs) || startedAtMs < expectation.startedAfterMs) {
    throw new Error("the server instance record belongs to an older launch");
  }
  if (
    record.port !== layout.port ||
    comparableServicePath(layout.platform, record.baseDir) !==
      comparableServicePath(layout.platform, layout.stateDir)
  ) {
    throw new Error("the server instance record does not match this service layout");
  }
  if (record.pid <= 0 || !record.bootId) {
    throw new Error("the server instance record is missing process identity");
  }
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      throw new Error(`the recorded service process ${record.pid} is not running`, {
        cause: error,
      });
    }
  }
  return record;
}

export async function waitForServiceHealth(
  layout: ServiceLayout,
  expectation: ServiceHealthExpectation,
  timeoutMs = SERVICE_HEALTH_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "the service did not respond";
  while (Date.now() < deadline) {
    try {
      const identity = readFreshServerIdentity(layout, expectation);
      const response = await fetch(`http://127.0.0.1:${layout.port}/api/health`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, deadline - Date.now()))),
      });
      const body = (await response.json().catch(() => null)) as {
        readonly status?: unknown;
        readonly service?: unknown;
        readonly bootId?: unknown;
      } | null;
      if (
        response.ok &&
        body?.status === "ok" &&
        body.service === "shioricode" &&
        body.bootId === identity.bootId
      ) {
        return;
      }
      lastFailure = response.ok
        ? "the health endpoint did not match the newly launched server process"
        : `the health endpoint returned HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    const retryDelayMs = Math.min(250, Math.max(0, deadline - Date.now()));
    if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  throw new Error(
    `ShioriCode was started but did not become healthy on 127.0.0.1:${layout.port} within ${timeoutMs}ms: ${lastFailure}`,
  );
}

function defaultDependencies(): ServiceDependencies {
  const cliArg = process.argv[1];
  if (!cliArg) throw new Error("Could not resolve the ShioriCode executable path");
  return {
    platform: supportedPlatform(process.platform),
    execPath: fs.realpathSync(process.execPath),
    cliPath: fs.realpathSync(cliArg),
    run: runDefault,
    healthCheck: waitForServiceHealth,
  };
}

function requireAdministrator(platform: ServicePlatform): void {
  if (platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new Error("Service installation requires administrator privileges. Re-run with sudo.");
  }
}

export function isSudoInvocation(
  input: {
    readonly sudoUser: string | undefined;
    readonly sudoUid: string | undefined;
    readonly effectiveUid: number | undefined;
  } = {
    sudoUser: process.env.SUDO_USER,
    sudoUid: process.env.SUDO_UID,
    effectiveUid: typeof process.getuid === "function" ? process.getuid() : undefined,
  },
): boolean {
  const sudoUser = input.sudoUser?.trim();
  if (!sudoUser || sudoUser === "root") return false;
  const sudoUidRaw = input.sudoUid?.trim();
  const sudoUid = Number(sudoUidRaw);
  const hasValidSudoUid =
    sudoUidRaw !== undefined && sudoUidRaw !== "" && Number.isInteger(sudoUid) && sudoUid >= 0;
  const effectiveUidIsRoot = input.effectiveUid === 0;
  return effectiveUidIsRoot || hasValidSudoUid;
}

async function commandExists(run: ServiceDependencies["run"], file: string, args: string[]) {
  try {
    await run(file, args);
    return true;
  } catch {
    return false;
  }
}

export async function chownWritableServiceState(
  run: ServiceDependencies["run"],
  layout: ServiceLayout,
  owner: string,
): Promise<void> {
  await run("chown", [owner, layout.stateDir]);
  // Never recurse from an administrator process through a tree the service
  // account can mutate. New descendants are created as the service account;
  // existing descendants from an earlier install already have that identity.
  const targets = new Set<string>();
  const resolvedStateDir = path.resolve(layout.stateDir);
  const statePrefix = `${resolvedStateDir}${path.sep}`;
  for (const candidate of [layout.workspaceDir, path.dirname(layout.logPath)]) {
    const resolvedCandidate = path.resolve(candidate);
    if (resolvedCandidate === resolvedStateDir || resolvedCandidate.startsWith(statePrefix))
      continue;
    if (resolvedStateDir.startsWith(`${resolvedCandidate}${path.sep}`)) {
      throw new Error(
        `Refusing to change ownership of ${candidate} because it contains the service state directory`,
      );
    }
    targets.add(candidate);
  }
  for (const target of targets) {
    await run("chown", [owner, target]);
  }
}

export function validatePosixDirectoryBoundary(
  directory: string,
  options: {
    readonly requireTrustedAncestors?: boolean;
    readonly trustedWritableRoots?: readonly string[];
  } = {},
): void {
  const absolute = path.resolve(directory);
  const trustedWritableRoots = (options.trustedWritableRoots ?? []).map((root) =>
    path.resolve(root),
  );
  const isWithinTrustedWritableRoot = (candidate: string) =>
    trustedWritableRoots.some(
      (root) => candidate === root || candidate.startsWith(`${root}${path.sep}`),
    );
  const components = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  const rootStat = fs.lstatSync(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Refusing service-writable symlink or non-directory: ${current}`);
  }
  if (options.requireTrustedAncestors && (rootStat.uid !== 0 || (rootStat.mode & 0o022) !== 0)) {
    throw new Error(`Refusing untrusted privileged service path ancestor: ${current}`);
  }
  for (const component of components) {
    current = path.join(current, component);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Refusing service-writable symlink or non-directory: ${current}`);
      }
      if (
        options.requireTrustedAncestors &&
        current !== absolute &&
        !isWithinTrustedWritableRoot(current) &&
        (stat.uid !== 0 || (stat.mode & 0o022) !== 0)
      ) {
        throw new Error(`Refusing untrusted privileged service path ancestor: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
}

function posixBoundaryOptions(layout: ServiceLayout): {
  readonly requireTrustedAncestors: boolean;
  readonly trustedWritableRoots: readonly string[];
} {
  return {
    requireTrustedAncestors: layout.accountMode === "dedicated",
    trustedWritableRoots: layout.accountMode === "dedicated" ? [layout.stateDir] : [],
  };
}

export function posixDirectoryPreparationMode(
  layout: ServiceLayout,
  directory: string,
): "administrator" | "service-account" {
  if (layout.accountMode === "current") return "service-account";
  const stateDir = path.resolve(layout.stateDir);
  const absolute = path.resolve(directory);
  return absolute.startsWith(`${stateDir}${path.sep}`) ? "service-account" : "administrator";
}

export async function preparePosixWritableDirectory(
  deps: Pick<ServiceDependencies, "run">,
  directory: string,
  layout: ServiceLayout,
): Promise<void> {
  const absolute = path.resolve(directory);
  if (posixDirectoryPreparationMode(layout, absolute) === "service-account") {
    // A persistent process with the service UID may race any path below its
    // state root. Keep both creation and chmod at that UID so such a race can
    // never redirect an administrator operation.
    await runAsServiceAccount(deps, layout, "/bin/mkdir", ["-p", "--", absolute]);
    await runAsServiceAccount(deps, layout, "/bin/chmod", ["0750", "--", absolute]);
    validatePosixDirectoryBoundary(absolute);
    return;
  }

  // Administrator-created roots may only be reached through root-owned,
  // non-writable ancestors. The final component is excluded because it can be
  // an existing service-owned root whose parent prevents replacement.
  const options = {
    requireTrustedAncestors: true,
    trustedWritableRoots: [],
  } as const;
  validatePosixDirectoryBoundary(absolute, options);
  fs.mkdirSync(absolute, { recursive: true, mode: 0o750 });
  // Rewalk after creation so a changed component is detected before chmod.
  validatePosixDirectoryBoundary(absolute, options);
  let handle: number | undefined;
  try {
    handle = fs.openSync(
      absolute,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const stat = fs.fstatSync(handle);
    if (!stat.isDirectory()) {
      throw new Error(`Refusing service-writable symlink or non-directory: ${absolute}`);
    }
    fs.fchmodSync(handle, 0o750);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
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
      "--user-group",
      "--home-dir",
      layout.stateDir,
      "--no-create-home",
      "--shell",
      "/usr/sbin/nologin",
      layout.account,
    ]);
  } else if (layout.accountMode === "dedicated") {
    const primaryGroup = (await deps.run("id", ["-gn", layout.account])).stdout.trim();
    if (primaryGroup !== layout.account) {
      throw new Error(
        `The existing service user ${layout.account} must have the same-name primary group`,
      );
    }
  }
  await preparePosixWritableDirectory(deps, layout.stateDir, layout);
  if (layout.accountMode === "dedicated") {
    await deps.run("chown", [layout.account, layout.stateDir]);
  }
  for (const directory of new Set([layout.workspaceDir, path.dirname(layout.logPath)])) {
    await preparePosixWritableDirectory(deps, directory, layout);
    if (
      layout.accountMode === "dedicated" &&
      posixDirectoryPreparationMode(layout, directory) === "administrator"
    ) {
      await deps.run("chown", [layout.account, path.resolve(directory)]);
    }
  }
}

export function linuxServiceInstallCommands(layout: ServiceLayout): readonly {
  readonly file: string;
  readonly args: readonly string[];
}[] {
  const systemctl = layout.accountMode === "current" ? ["--user"] : [];
  return [
    ...(layout.accountMode === "current"
      ? [{ file: "loginctl", args: ["enable-linger", layout.account] }]
      : []),
    { file: "systemctl", args: [...systemctl, "daemon-reload"] },
    { file: "systemctl", args: [...systemctl, "enable", layout.serviceId] },
    { file: "systemctl", args: [...systemctl, "restart", layout.serviceId] },
  ];
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
    for (const directory of new Set([
      layout.stateDir,
      layout.workspaceDir,
      path.dirname(layout.logPath),
    ])) {
      await preparePosixWritableDirectory(deps, directory, layout);
    }
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

  const owner = `${layout.account}:${layout.account}`;
  await preparePosixWritableDirectory(deps, layout.stateDir, layout);
  await deps.run("chown", [owner, layout.stateDir]);
  for (const directory of new Set([layout.workspaceDir, path.dirname(layout.logPath)])) {
    await preparePosixWritableDirectory(deps, directory, layout);
    if (posixDirectoryPreparationMode(layout, directory) === "administrator") {
      await deps.run("chown", [owner, path.resolve(directory)]);
    }
  }
}

async function installLinux(
  deps: ServiceDependencies,
  layout: ServiceLayout,
  recoveryUsername: string | null,
  recoveryPassword: string | null,
): Promise<StagedServiceRuntime> {
  for (const directory of [layout.stateDir, layout.workspaceDir, path.dirname(layout.logPath)]) {
    validatePosixDirectoryBoundary(directory, posixBoundaryOptions(layout));
  }
  await ensureLinuxAccount(deps, layout);
  return await configureStagedServiceRuntime(deps, layout, async (staged) => {
    fs.mkdirSync(path.dirname(layout.definitionPath), {
      recursive: true,
      mode: 0o755,
    });
    writePrivateFileAtomically(
      layout.definitionPath,
      renderSystemdUnit({
        ...staged.dependencies,
        layout,
        recoveryUsername,
        recoveryPassword,
      }),
    );
    for (const command of linuxServiceInstallCommands(layout)) {
      await deps.run(command.file, command.args);
    }
  });
}

async function installMac(
  deps: ServiceDependencies,
  layout: ServiceLayout,
  recoveryUsername: string | null,
  recoveryPassword: string | null,
): Promise<StagedServiceRuntime> {
  for (const directory of [layout.stateDir, layout.workspaceDir, path.dirname(layout.logPath)]) {
    validatePosixDirectoryBoundary(directory, posixBoundaryOptions(layout));
  }
  await ensureMacAccount(deps, layout);
  return await configureStagedServiceRuntime(deps, layout, async (staged) => {
    fs.mkdirSync(path.dirname(layout.definitionPath), {
      recursive: true,
      mode: 0o755,
    });
    writePrivateFileAtomically(
      layout.definitionPath,
      renderLaunchDaemon({
        ...staged.dependencies,
        layout,
        recoveryUsername,
        recoveryPassword,
      }),
    );
    const domain = layout.accountMode === "dedicated" ? "system" : `gui/${invokingUid()}`;
    await ignoreMissingService(deps.run("launchctl", ["bootout", domain, layout.definitionPath]));
    await deps.run("launchctl", ["bootstrap", domain, layout.definitionPath]);
    await deps.run("launchctl", ["enable", `${domain}/${layout.serviceId}`]);
    await deps.run("launchctl", ["kickstart", "-k", `${domain}/${layout.serviceId}`]);
  });
}

function powershellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function windowsServiceDirectories(layout: ServiceLayout): readonly string[] {
  const directories = new Map<string, string>();
  for (const directory of [
    layout.stateDir,
    layout.workspaceDir,
    path.win32.dirname(layout.logPath),
  ]) {
    directories.set(path.win32.resolve(directory).toLowerCase(), directory);
  }
  return [...directories.values()];
}

export function windowsUnmanagedServiceDirectories(
  layout: ServiceLayout,
  managedDirectories: ReadonlySet<string>,
): readonly string[] {
  const fresh = windowsServiceDirectories(layout).filter(
    (directory) => !managedDirectories.has(path.win32.resolve(directory).toLowerCase()),
  );
  for (const directory of fresh) {
    const normalized = path.win32.resolve(directory).toLowerCase();
    for (const managed of managedDirectories) {
      if (normalized.startsWith(`${managed}\\`) || managed.startsWith(`${normalized}\\`)) {
        throw new Error(
          `Refusing to create a new Windows service root through an existing managed tree: ${directory}`,
        );
      }
    }
  }
  return fresh.toSorted((left, right) => left.length - right.length);
}

export function prepareWindowsServiceDirectories(layout: ServiceLayout): void {
  for (const directory of windowsServiceDirectories(layout)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

export function validateWindowsWritableTargets(layout: ServiceLayout): void {
  const protectedRoots: readonly {
    readonly root: string;
    readonly forbidDescendants: boolean;
  }[] = [
    { root: "C:\\Windows", forbidDescendants: true },
    { root: "C:\\Program Files", forbidDescendants: true },
    { root: "C:\\Program Files (x86)", forbidDescendants: true },
    { root: "C:\\ProgramData", forbidDescendants: false },
    ...(layout.accountMode === "dedicated"
      ? [
          {
            root: path.win32.dirname(path.win32.dirname(serviceRuntimeRoot(layout))),
            forbidDescendants: true,
          },
        ]
      : []),
    ...(layout.accountMode === "current"
      ? [
          {
            root: defaultExistingHomeDir("win32", layout.account),
            forbidDescendants: false,
          },
        ]
      : []),
  ];
  if (
    layout.accountMode === "current" &&
    !servicePathIsWithin(layout, layout.stateDir, defaultExistingHomeDir("win32", layout.account))
  ) {
    throw new Error("Current-account Windows state must remain inside the trusted user profile");
  }
  for (const directory of windowsServiceDirectories(layout)) {
    const resolved = path.win32.resolve(directory);
    if (resolved === path.win32.parse(resolved).root) {
      throw new Error(`Refusing to use a volume root as service-writable storage: ${directory}`);
    }
    for (const protectedRoot of protectedRoots) {
      const same = resolved.toLowerCase() === path.win32.resolve(protectedRoot.root).toLowerCase();
      if (
        same ||
        (protectedRoot.forbidDescendants &&
          servicePathIsWithin(layout, resolved, protectedRoot.root))
      ) {
        throw new Error(
          `Refusing protected Windows path as service-writable storage: ${directory}`,
        );
      }
    }
  }
}

export function renderWindowsProcessStopScript(layout: ServiceLayout): string {
  const runtimeRoot = serviceRuntimeRoot(layout);
  const legacyRuntimeRoot = path.win32.join(layout.stateDir, "runtime");
  return `$ErrorActionPreference='Stop'
$runtimeRoots=@(
  [IO.Path]::GetFullPath(${powershellSingleQuote(runtimeRoot)}).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
  [IO.Path]::GetFullPath(${powershellSingleQuote(legacyRuntimeRoot)}).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
) | Select-Object -Unique
$stateDir=[IO.Path]::GetFullPath(${powershellSingleQuote(layout.stateDir)})
$expectedOwner=${powershellSingleQuote(layout.account)}
$processes=Get-CimInstance Win32_Process | Where-Object {
  $executableInRuntime=$false
  if ($_.ExecutablePath) {
    $executablePath=[IO.Path]::GetFullPath($_.ExecutablePath)
    foreach ($runtimeRoot in $runtimeRoots) {
      if ($executablePath.StartsWith($runtimeRoot, [StringComparison]::OrdinalIgnoreCase)) {
        $executableInRuntime=$true
        break
      }
    }
  }
  $commandLineTargetsService=$_.CommandLine -and $_.CommandLine.IndexOf("--base-dir", [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine.IndexOf($stateDir, [StringComparison]::OrdinalIgnoreCase) -ge 0
  $executableInRuntime -or $commandLineTargetsService
}
$runtimePids=@{}
foreach ($process in $processes) { $runtimePids[[int]$process.ProcessId]=$true }
$roots=$processes | Where-Object { -not $runtimePids.ContainsKey([int]$_.ParentProcessId) }
foreach ($process in $roots) {
  $owner=Invoke-CimMethod -InputObject $process -MethodName GetOwner
  $qualifiedOwner=if ($owner.Domain) { "$($owner.Domain)\\$($owner.User)" } else { $owner.User }
  $ownerMatches=[string]::Equals($owner.User, $expectedOwner, [StringComparison]::OrdinalIgnoreCase) -or [string]::Equals($qualifiedOwner, $expectedOwner, [StringComparison]::OrdinalIgnoreCase)
  if ($owner.ReturnValue -ne 0 -or -not $ownerMatches) {
    throw "Refusing to terminate ShioriCode runtime PID $($process.ProcessId): process owner did not match the service account."
  }
  $pidText=[string]$process.ProcessId
  & taskkill.exe /PID $pidText /T /F | Out-Null
  if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue)) {
    throw "Failed to terminate ShioriCode runtime PID $pidText."
  }
}
$remaining=Get-CimInstance Win32_Process | Where-Object {
  $matchesRuntime=$false
  if ($_.ExecutablePath) {
    $executablePath=[IO.Path]::GetFullPath($_.ExecutablePath)
    foreach ($runtimeRoot in $runtimeRoots) {
      if ($executablePath.StartsWith($runtimeRoot, [StringComparison]::OrdinalIgnoreCase)) { $matchesRuntime=$true; break }
    }
  }
  $matchesState=$_.CommandLine -and $_.CommandLine.IndexOf("--base-dir", [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine.IndexOf($stateDir, [StringComparison]::OrdinalIgnoreCase) -ge 0
  $matchesRuntime -or $matchesState
}
if ($remaining) {
  throw "Failed to prove that all ShioriCode runtime processes exited."
}`;
}

export function renderWindowsTaskRestartScript(serviceId: string): string {
  return `$ErrorActionPreference='Stop'
$settings=New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Set-ScheduledTask -TaskName ${powershellSingleQuote(serviceId)} -Settings $settings | Out-Null`;
}

async function createWindowsTask(
  deps: ServiceDependencies,
  layout: ServiceLayout,
  accountPassword: string | null,
): Promise<void> {
  if (layout.accountMode === "dedicated" && !accountPassword) {
    throw new Error("A dedicated Windows task requires a service-account password");
  }
  await deps.run("schtasks.exe", [
    "/Create",
    "/TN",
    serviceManagerId(layout),
    "/SC",
    layout.accountMode === "dedicated" ? "ONSTART" : "ONLOGON",
    "/RU",
    layout.accountMode === "dedicated" ? `.\\${layout.account}` : layout.account,
    ...(accountPassword ? ["/RP", accountPassword] : ["/NP"]),
    "/TR",
    layout.definitionPath,
    "/F",
  ]);
  await deps.run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    renderWindowsTaskRestartScript(serviceManagerId(layout)),
  ]);
}

async function snapshotWindowsTask(
  deps: ServiceDependencies,
  serviceId: string,
): Promise<string | null> {
  try {
    const result = await deps.run("schtasks.exe", ["/Query", "/TN", serviceId, "/XML"]);
    return result.stdout.trim() || null;
  } catch (error) {
    if (isMissingServiceError(error)) return null;
    throw error;
  }
}

async function restoreWindowsTask(
  deps: ServiceDependencies,
  serviceId: string,
  taskXml: string,
  account: string,
  accountPassword: string,
): Promise<void> {
  const encodedXml = Buffer.from(taskXml, "utf16le").toString("base64");
  const script = `$ErrorActionPreference='Stop'
$xml=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(${powershellSingleQuote(encodedXml)}))
Register-ScheduledTask -TaskName ${powershellSingleQuote(serviceId)} -Xml $xml -User ${powershellSingleQuote(`.\\${account}`)} -Password ${powershellSingleQuote(accountPassword)} -Force | Out-Null`;
  await deps.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

async function stopWindowsServiceProcesses(
  deps: ServiceDependencies,
  layout: ServiceLayout,
): Promise<void> {
  await ignoreMissingService(deps.run("schtasks.exe", ["/End", "/TN", serviceManagerId(layout)]));
  await deps.run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    renderWindowsProcessStopScript(layout),
  ]);
}

async function ignoreMissingService<T>(operation: Promise<T>): Promise<T | undefined> {
  try {
    return await operation;
  } catch (error) {
    if (isMissingServiceError(error)) return undefined;
    throw error;
  }
}

export function isMissingServiceError(error: unknown): boolean {
  const detail = `${error instanceof Error ? error.message : String(error)} ${(error as { stderr?: unknown })?.stderr ?? ""}`;
  return /not (?:found|loaded|installed)|does not exist|cannot find|no files found/iu.test(detail);
}

export function windowsLayoutsToStop(
  previousLayout: ServiceLayout | null,
  requestedLayout: ServiceLayout,
): readonly ServiceLayout[] {
  if (!previousLayout) return [requestedLayout];
  const key = (layout: ServiceLayout) =>
    [serviceManagerId(layout), layout.account, layout.stateDir, serviceRuntimeRoot(layout)]
      .join("\0")
      .toLowerCase();
  return key(previousLayout) === key(requestedLayout)
    ? [requestedLayout]
    : [previousLayout, requestedLayout];
}

async function installWindows(
  deps: ServiceDependencies,
  layout: ServiceLayout,
  recoveryUsername: string | null,
  recoveryPassword: string | null,
  accountPassword: string | null,
  managedDirectories: ReadonlySet<string>,
  initiallyAbsentDirectories: ReadonlySet<string>,
  securedFreshDirectories: Set<string>,
): Promise<StagedServiceRuntime> {
  validateWindowsWritableTargets(layout);
  if (accountPassword) {
    await deps.run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      renderWindowsAccountPasswordScript(layout.account, accountPassword),
    ]);
    await deps.run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      renderWindowsAccountVisibilityScript(layout.account),
    ]);
  }
  const serviceDirectories = windowsServiceDirectories(layout);
  const unmanagedDirectories = windowsUnmanagedServiceDirectories(layout, managedDirectories);
  const managedServiceDirectories = serviceDirectories.filter((directory) =>
    managedDirectories.has(path.win32.resolve(directory).toLowerCase()),
  );
  await validateWindowsDirectoryBoundaries(deps, serviceDirectories);
  if (managedServiceDirectories.length > 0) {
    await deps.run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      renderWindowsDirectoryAdoptionScript(
        managedServiceDirectories.map((directory) => ({
          directory,
          managed: true,
        })),
        layout.account,
        layout.accountMode,
      ),
    ]);
  }
  for (const directory of unmanagedDirectories) {
    const adoption = [{ directory, managed: false, required: false }] as const;
    await deps.run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      renderWindowsDirectoryAdoptionScript(adoption, layout.account, layout.accountMode),
    ]);
    const parentDirectory = path.win32.dirname(directory);
    if (!fs.existsSync(parentDirectory)) {
      throw new Error(
        `Refusing to create a Windows service root through missing intermediate components: ${directory}`,
      );
    }
    try {
      // The sorted plan creates one component at a time. Never let an
      // administrator recursive mkdir traverse an attacker-won intermediate.
      fs.mkdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Revalidate the actual directory obtained after creation. If another
    // principal won the name race, its owner or write ACE makes this fail.
    await deps.run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      renderWindowsDirectoryAdoptionScript(
        [{ directory, managed: false, required: true }],
        layout.account,
        layout.accountMode,
      ),
    ]);
    await applyWindowsDirectoryAcl(
      deps,
      layout,
      directory,
      layout.accountMode === "dedicated" ? "none" : "modify",
      false,
    );
    if (initiallyAbsentDirectories.has(path.win32.resolve(directory).toLowerCase())) {
      securedFreshDirectories.add(directory);
    }
  }
  if (layout.accountMode === "dedicated") {
    // Every fresh root is admin-only before the service is granted access.
    // Descendants are granted first and the top-level root is granted last.
    for (const directory of unmanagedDirectories.toReversed()) {
      await applyWindowsDirectoryAcl(deps, layout, directory, "modify", false);
    }
  }
  return await configureStagedServiceRuntime(deps, layout, async (staged) => {
    writePrivateFileAtomically(
      layout.definitionPath,
      renderWindowsServiceScript({
        ...staged.dependencies,
        layout,
        recoveryUsername,
        recoveryPassword,
      }),
    );
    await applyWindowsFileAcl(
      deps,
      layout,
      layout.definitionPath,
      layout.accountMode === "dedicated" ? "read-execute" : "modify",
    );
    await createWindowsTask(deps, layout, accountPassword);
    await deps.run("schtasks.exe", ["/Run", "/TN", serviceManagerId(layout)]);
  });
}

export function renderWindowsAccountScript(account: string, accountPassword: string): string {
  return `${renderWindowsAccountPasswordScript(account, accountPassword)}
${renderWindowsAccountVisibilityScript(account)}`;
}

export function renderWindowsAccountPasswordScript(
  account: string,
  accountPassword: string,
): string {
  const escapedAccount = account.replaceAll("'", "''");
  const escapedPassword = accountPassword.replaceAll("'", "''");
  return `$ErrorActionPreference='Stop'
$name='${escapedAccount}'
$password=ConvertTo-SecureString '${escapedPassword}' -AsPlainText -Force
if (-not (Get-LocalUser -Name $name -ErrorAction SilentlyContinue)) {
  New-LocalUser -Name $name -Password $password -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword
} else {
  Set-LocalUser -Name $name -Password $password -AccountNeverExpires -PasswordNeverExpires $true -UserMayChangePassword $false
}`;
}

export function renderWindowsAccountVisibilityScript(account: string): string {
  const escapedAccount = account.replaceAll("'", "''");
  return `$ErrorActionPreference='Stop'
$name='${escapedAccount}'
$userList='HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\SpecialAccounts\\UserList'
New-Item -Path $userList -Force | Out-Null
New-ItemProperty -Path $userList -Name $name -PropertyType DWord -Value 0 -Force | Out-Null`;
}

function systemServiceLayoutMetadataPath(platform: ServicePlatform): string {
  if (platform === "linux") return "/etc/shioricode/service-layout.json";
  if (platform === "darwin") {
    return "/Library/Preferences/codes.shiori.shioricode.service-layout.json";
  }
  const programData = "C:\\ProgramData";
  return path.win32.join(programData, "ShioriCodeService", "service-layout.json");
}

export function currentServiceLayoutMetadataPath(platform: ServicePlatform): string {
  const metadataHome = defaultExistingHomeDir(platform, invokingUsername());
  if (platform === "linux") {
    return path.join(metadataHome, ".config/shioricode/service-layout.json");
  }
  if (platform === "darwin") {
    return path.join(
      metadataHome,
      "Library/Application Support/ShioriCode Service/service-layout.json",
    );
  }
  return path.win32.join(
    path.win32.join(metadataHome, "AppData", "Local"),
    "ShioriCodeService",
    "service-layout.json",
  );
}

function serviceLayoutMetadataPath(layout: ServiceLayout): string {
  if (layout.accountMode === "dedicated") return systemServiceLayoutMetadataPath(layout.platform);
  return currentServiceLayoutMetadataPath(layout.platform);
}

function serviceLayoutIdentity(layout: ServiceLayout): string {
  return createHash("sha256")
    .update(
      [
        layout.platform,
        layout.accountMode,
        layout.account,
        layout.stateDir,
        layout.definitionPath,
        layout.serviceId,
        layout.managerId ?? "",
        serviceRuntimeRoot(layout),
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 20);
}

export function serviceLayoutHistoryPath(layout: ServiceLayout): string {
  const primaryPath = serviceLayoutMetadataPath(layout);
  const pathApi = layout.platform === "win32" ? path.win32 : path.posix;
  const extension = pathApi.extname(primaryPath);
  return pathApi.join(
    pathApi.dirname(primaryPath),
    `${pathApi.basename(primaryPath, extension)}.${serviceLayoutIdentity(layout)}${extension}`,
  );
}

function syncParentDirectory(filePath: string): void {
  let directory: number | undefined;
  try {
    directory = fs.openSync(path.dirname(filePath), "r");
    fs.fsyncSync(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EPERM" && code !== "EISDIR") throw error;
  } finally {
    if (directory !== undefined) fs.closeSync(directory);
  }
}

export function writePrivateFileAtomically(
  filePath: string,
  contents: string | Buffer,
  owner: { readonly uid: number; readonly gid: number } | null = null,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle: number | undefined;
  try {
    handle = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(handle, contents);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.chmodSync(temporaryPath, 0o600);
    if (owner) fs.chownSync(temporaryPath, owner.uid, owner.gid);
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
    syncParentDirectory(filePath);
  } catch (error) {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {}
    }
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {}
    throw error;
  }
}

export function writeServiceLayout(layout: ServiceLayout): readonly string[] {
  const primaryPath = serviceLayoutMetadataPath(layout);
  const historyPath = serviceLayoutHistoryPath(layout);
  const owner =
    layout.accountMode === "dedicated" && layout.platform !== "win32" ? { uid: 0, gid: 0 } : null;
  const payload = `${JSON.stringify(
    { version: SERVICE_LAYOUT_VERSION, writtenAtMs: Date.now(), layout },
    null,
    2,
  )}\n`;
  // Commit provenance first. A crash or torn replacement of the convenience
  // pointer can therefore never erase the only record of a custom layout.
  writePrivateFileAtomically(historyPath, payload, owner);
  writePrivateFileAtomically(primaryPath, payload, owner);
  return [historyPath, primaryPath];
}

export interface RecordedServiceLayout {
  readonly layout: ServiceLayout;
  readonly metadataPath: string;
  readonly writtenAtMs: number;
}

function metadataNamespace(
  metadataPath: string,
  platform: ServicePlatform,
): ServiceAccountMode | null {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalizedCandidate = pathApi.normalize(metadataPath);
  for (const [mode, primaryPath] of [
    ["current", currentServiceLayoutMetadataPath(platform)],
    ["dedicated", systemServiceLayoutMetadataPath(platform)],
  ] as const) {
    const normalizedPrimary = pathApi.normalize(primaryPath);
    if (normalizedCandidate === normalizedPrimary) return mode;
    const extension = pathApi.extname(normalizedPrimary);
    const historyPrefix = `${pathApi.basename(normalizedPrimary, extension)}.`;
    if (
      pathApi.dirname(normalizedCandidate) === pathApi.dirname(normalizedPrimary) &&
      pathApi.basename(normalizedCandidate).startsWith(historyPrefix) &&
      pathApi.basename(normalizedCandidate).endsWith(extension)
    ) {
      return mode;
    }
  }
  return null;
}

function expectedCurrentMetadataUid(account: string): number | null {
  if (account !== invokingUsername()) return null;
  const sudoUid = Number(process.env.SUDO_UID);
  if (Number.isInteger(sudoUid) && sudoUid >= 0) return sudoUid;
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function validatePosixMetadataFile(
  metadataPath: string,
  namespace: ServiceAccountMode,
  account: string,
  stat: fs.Stats,
): boolean {
  if ((stat.mode & 0o077) !== 0) return false;
  const expectedUid = namespace === "dedicated" ? 0 : expectedCurrentMetadataUid(account);
  if (expectedUid === null || stat.uid !== expectedUid) return false;
  try {
    const parent = fs.lstatSync(path.dirname(metadataPath));
    return parent.isDirectory() && !parent.isSymbolicLink();
  } catch {
    return false;
  }
}

function validateRecordedLayoutNamespace(
  layout: ServiceLayout,
  namespace: ServiceAccountMode,
): boolean {
  try {
    validateServiceAccount(layout.platform, layout.accountMode, layout.account);
  } catch {
    return false;
  }
  if (layout.accountMode !== namespace) return false;
  const pathApi = layout.platform === "win32" ? path.win32 : path.posix;
  const samePath = (left: string, right: string) =>
    layout.platform === "win32"
      ? pathApi.resolve(left).toLowerCase() === pathApi.resolve(right).toLowerCase()
      : pathApi.resolve(left) === pathApi.resolve(right);
  if (layout.platform === "linux" && layout.serviceId !== "shioricode.service") return false;
  if (layout.platform === "darwin" && layout.serviceId !== "codes.shiori.shioricode") return false;
  if (layout.platform === "win32") {
    if (layout.serviceId !== "ShioriCode") return false;
    if (
      layout.managerId !== undefined &&
      layout.managerId !== "ShioriCode-A" &&
      layout.managerId !== "ShioriCode-B"
    ) {
      return false;
    }
    const definitionKind = windowsServiceDefinitionKind(layout);
    if (
      (namespace === "current" && definitionKind !== "current") ||
      (namespace === "dedicated" && definitionKind !== "legacy" && definitionKind !== "protected")
    ) {
      return false;
    }
    if (namespace === "current") {
      if (layout.account.toLowerCase() !== invokingUsername().toLowerCase()) return false;
      if (layout.runtimeRoot !== undefined) return false;
      const profile = defaultExistingHomeDir("win32", layout.account);
      if (!servicePathIsWithin(layout, layout.stateDir, profile)) return false;
    } else if (layout.runtimeRoot !== undefined) {
      const identity = createHash("sha256")
        .update(`${layout.account}\0${layout.stateDir}`)
        .digest("hex")
        .slice(0, 16);
      if (
        path.win32.basename(layout.runtimeRoot).toLowerCase() !== identity ||
        path.win32.basename(path.win32.dirname(layout.runtimeRoot)).toLowerCase() !==
          "shioricode runtime"
      ) {
        return false;
      }
    }
    return true;
  }
  if (namespace === "current" && layout.account !== invokingUsername()) return false;
  const canonicalDefinition =
    layout.platform === "linux"
      ? namespace === "dedicated"
        ? "/etc/systemd/system/shioricode.service"
        : path.join(currentLinuxSystemdConfigDir(layout.account), "systemd/user/shioricode.service")
      : namespace === "dedicated"
        ? "/Library/LaunchDaemons/codes.shiori.shioricode.plist"
        : path.join(
            defaultExistingHomeDir("darwin", layout.account),
            "Library/LaunchAgents/codes.shiori.shioricode.plist",
          );
  const isRecordedSudoXdgUnit =
    layout.platform === "linux" &&
    namespace === "current" &&
    isSudoInvocation() &&
    path.basename(layout.definitionPath) === "shioricode.service" &&
    path.basename(path.dirname(layout.definitionPath)) === "user" &&
    path.basename(path.dirname(path.dirname(layout.definitionPath))) === "systemd";
  return (
    (samePath(layout.definitionPath, canonicalDefinition) || isRecordedSudoXdgUnit) &&
    layout.runtimeRoot === undefined
  );
}

function readServiceLayoutRecord(
  metadataPath: string,
  platform: ServicePlatform,
): RecordedServiceLayout | null {
  let handle: number | undefined;
  try {
    const namespace = metadataNamespace(metadataPath, platform);
    if (!namespace) return null;
    handle = fs.openSync(
      metadataPath,
      fs.constants.O_RDONLY |
        fs.constants.O_NONBLOCK |
        (platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0)),
    );
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null;
    const contents = Buffer.alloc(1024 * 1024 + 1);
    let offset = 0;
    while (offset < contents.length) {
      const bytesRead = fs.readSync(handle, contents, offset, contents.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > 1024 * 1024) return null;
    const parsed = JSON.parse(contents.subarray(0, offset).toString("utf8")) as {
      readonly version?: unknown;
      readonly writtenAtMs?: unknown;
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
      typeof layout.port !== "number" ||
      (layout.runtimeRoot !== undefined && typeof layout.runtimeRoot !== "string")
    ) {
      return null;
    }
    const validated = validateServiceLayout(layout as ServiceLayout);
    if (!validateRecordedLayoutNamespace(validated, namespace)) return null;
    if (
      platform !== "win32" &&
      !validatePosixMetadataFile(metadataPath, namespace, validated.account, stat)
    ) {
      return null;
    }
    if (
      validated.runtimeRoot &&
      (platform !== "win32" || !path.win32.isAbsolute(validated.runtimeRoot))
    ) {
      return null;
    }
    return {
      layout: validated,
      metadataPath,
      writtenAtMs: stat.mtimeMs,
    };
  } catch {
    return null;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function decodeWindowsServiceLayoutRecord(
  metadataPath: string,
  contents: string,
  writtenAtMs: number,
): RecordedServiceLayout | null {
  try {
    const namespace = metadataNamespace(metadataPath, "win32");
    if (!namespace) return null;
    const parsed = JSON.parse(contents) as {
      readonly version?: unknown;
      readonly layout?: Partial<ServiceLayout>;
    };
    const layout = parsed.layout;
    if (
      parsed.version !== SERVICE_LAYOUT_VERSION ||
      layout?.platform !== "win32" ||
      (layout.accountMode !== "dedicated" && layout.accountMode !== "current") ||
      typeof layout.account !== "string" ||
      typeof layout.homeDir !== "string" ||
      typeof layout.stateDir !== "string" ||
      typeof layout.workspaceDir !== "string" ||
      typeof layout.definitionPath !== "string" ||
      typeof layout.logPath !== "string" ||
      typeof layout.servicePath !== "string" ||
      typeof layout.serviceId !== "string" ||
      typeof layout.port !== "number" ||
      (layout.runtimeRoot !== undefined && typeof layout.runtimeRoot !== "string")
    ) {
      return null;
    }
    const validated = validateServiceLayout(layout as ServiceLayout);
    if (!validateRecordedLayoutNamespace(validated, namespace)) return null;
    return { layout: validated, metadataPath, writtenAtMs };
  } catch {
    return null;
  }
}

function newestRecordedLayouts(
  records: readonly RecordedServiceLayout[],
): readonly RecordedServiceLayout[] {
  const newestByIdentity = new Map<string, RecordedServiceLayout>();
  for (const record of records) {
    const identity = serviceLayoutIdentity(record.layout);
    const existing = newestByIdentity.get(identity);
    if (!existing || record.writtenAtMs > existing.writtenAtMs) {
      newestByIdentity.set(identity, record);
    }
  }
  return [...newestByIdentity.values()].toSorted(
    (left, right) => right.writtenAtMs - left.writtenAtMs,
  );
}

function metadataCandidates(platform: ServicePlatform): readonly string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const primaryPaths = [
    currentServiceLayoutMetadataPath(platform),
    systemServiceLayoutMetadataPath(platform),
  ];
  const candidates = new Set(primaryPaths);
  for (const primaryPath of primaryPaths) {
    const directory = pathApi.dirname(primaryPath);
    const extension = pathApi.extname(primaryPath);
    const prefix = `${pathApi.basename(primaryPath, extension)}.`;
    let entries: string[];
    try {
      entries = fs.readdirSync(directory);
    } catch {
      continue;
    }
    const historyPattern = new RegExp(
      `^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[a-f0-9]{20}${extension.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
      "u",
    );
    const histories = entries.filter((entry) => historyPattern.test(entry));
    // A bounded provenance journal is enough to cover migrations while
    // preventing attacker-created directory floods from driving unbounded I/O.
    if (histories.length > 128) continue;
    for (const entry of histories) {
      candidates.add(pathApi.join(directory, entry));
    }
  }
  return [...candidates];
}

export function readRecordedServiceLayouts(
  platform: ServicePlatform,
  candidates: readonly string[] = metadataCandidates(platform),
): readonly RecordedServiceLayout[] {
  return newestRecordedLayouts(
    candidates
      .map((metadataPath) => readServiceLayoutRecord(metadataPath, platform))
      .filter((record): record is RecordedServiceLayout => record !== null),
  );
}

function readAllRecordedServiceLayouts(
  platform: ServicePlatform,
  candidates: readonly string[] = metadataCandidates(platform),
): readonly RecordedServiceLayout[] {
  return candidates
    .map((metadataPath) => readServiceLayoutRecord(metadataPath, platform))
    .filter((record): record is RecordedServiceLayout => record !== null);
}

function unrecoverableLayoutMetadataPaths(
  platform: ServicePlatform,
  candidates: readonly string[] = metadataCandidates(platform),
): readonly string[] {
  const validRecords = readAllRecordedServiceLayouts(platform, candidates);
  const failures: string[] = [];
  for (const primaryPath of [
    currentServiceLayoutMetadataPath(platform),
    systemServiceLayoutMetadataPath(platform),
  ]) {
    if (!fs.existsSync(primaryPath) || readServiceLayoutRecord(primaryPath, platform)) continue;
    const namespace = metadataNamespace(primaryPath, platform);
    const recovered = validRecords.some(
      (record) =>
        record.metadataPath !== primaryPath &&
        metadataNamespace(record.metadataPath, platform) === namespace,
    );
    if (!recovered) failures.push(primaryPath);
  }
  return failures;
}

function assertRecoverableLayoutMetadata(
  platform: ServicePlatform,
  candidates: readonly string[] = metadataCandidates(platform),
): void {
  const failures = unrecoverableLayoutMetadataPaths(platform, candidates);
  if (failures.length === 0) return;
  throw new Error(
    `Refusing service lifecycle changes because layout metadata is corrupt and has no valid provenance record: ${failures.join(", ")}`,
  );
}

function removeExactMetadataPointers(platform: ServicePlatform): void {
  for (const [namespace, metadataPath] of [
    ["current", currentServiceLayoutMetadataPath(platform)],
    ["dedicated", systemServiceLayoutMetadataPath(platform)],
  ] as const) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(metadataPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isDirectory())
      throw new Error(`Refusing to remove metadata directory: ${metadataPath}`);
    if (platform !== "win32") {
      const expectedUid =
        namespace === "dedicated" ? 0 : expectedCurrentMetadataUid(invokingUsername());
      if (expectedUid === null || stat.uid !== expectedUid) {
        throw new Error(`Refusing to remove metadata with an unexpected owner: ${metadataPath}`);
      }
    }
    fs.rmSync(metadataPath, { force: true });
  }
}

export function renderWindowsMetadataValidationScript(
  _records: readonly RecordedServiceLayout[],
): string {
  // Validation and reading are intentionally inseparable: the returned
  // script validates canonical handles, ACLs, and bounded contents in one
  // PowerShell process instead of blessing paths for Node to reopen later.
  return renderWindowsMetadataPreflightScript();
}

export function renderWindowsMetadataPreflightScript(): string {
  const specs = [
    {
      primaryPath: currentServiceLayoutMetadataPath("win32"),
      includeCurrentIdentity: true,
    },
    {
      primaryPath: systemServiceLayoutMetadataPath("win32"),
      includeCurrentIdentity: false,
    },
  ];
  const entries = specs
    .map(({ primaryPath, includeCurrentIdentity }) => {
      const directory = path.win32.dirname(primaryPath);
      const primaryName = path.win32.basename(primaryPath);
      const extension = path.win32.extname(primaryName);
      const stem = path.win32.basename(primaryName, extension);
      return `@{ Directory=${powershellSingleQuote(directory)}; Primary=${powershellSingleQuote(primaryName)}; History=${powershellSingleQuote(`^${stem.replaceAll(".", "\\.")}\\.[a-f0-9]{20}\\${extension}$`)}; IncludeCurrent=$${includeCurrentIdentity ? "true" : "false"} }`;
    })
    .join(",");
  return `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class ShioriMetadataHandle {
  private const uint GENERIC_READ = 0x80000000;
  private const uint FILE_SHARE_READ = 0x00000001;
  private const uint FILE_SHARE_WRITE = 0x00000002;
  private const uint FILE_SHARE_DELETE = 0x00000004;
  private const uint OPEN_EXISTING = 3;
  private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
  private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
  private const uint OWNER_SECURITY_INFORMATION = 0x00000001;
  private const uint DACL_SECURITY_INFORMATION = 0x00000004;
  private const uint PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
  private const uint READ_CONTROL = 0x00020000;
  private const uint WRITE_DAC = 0x00040000;

  [StructLayout(LayoutKind.Sequential)]
  private struct FileTime { public uint Low; public uint High; }

  [StructLayout(LayoutKind.Sequential)]
  private struct ByHandleFileInformation {
    public uint FileAttributes;
    public FileTime CreationTime;
    public FileTime LastAccessTime;
    public FileTime LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
    IntPtr security, uint creation, uint flags, IntPtr template);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle,
    out ByHandleFileInformation information);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,
    StringBuilder path, uint length, uint flags);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern uint GetSecurityInfo(SafeFileHandle handle, int objectType,
    uint securityInformation, out IntPtr owner, out IntPtr group, out IntPtr dacl,
    out IntPtr sacl, out IntPtr securityDescriptor);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
    IntPtr securityDescriptor, uint revision, uint securityInformation,
    out IntPtr stringSecurityDescriptor, out uint stringLength);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
    string stringSecurityDescriptor, uint revision, out IntPtr securityDescriptor,
    out uint securityDescriptorSize);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool GetSecurityDescriptorDacl(IntPtr securityDescriptor,
    out bool daclPresent, out IntPtr dacl, out bool daclDefaulted);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern uint SetSecurityInfo(SafeFileHandle handle, int objectType,
    uint securityInformation, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr memory);

  private static Win32Exception Error() { return new Win32Exception(Marshal.GetLastWin32Error()); }

  public static SafeFileHandle OpenNoFollow(string path, bool directory) {
    uint flags = FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0);
    SafeFileHandle handle = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, IntPtr.Zero,
      OPEN_EXISTING, flags, IntPtr.Zero);
    if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
    return handle;
  }

  public static SafeFileHandle OpenLogTailNoFollow(string path) {
    SafeFileHandle handle = CreateFileW(path, GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero,
      OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
    return handle;
  }

  public static SafeFileHandle OpenForAclUpdate(string path, bool directory) {
    uint flags = FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0);
    SafeFileHandle handle = CreateFileW(path, READ_CONTROL | WRITE_DAC,
      FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING, flags, IntPtr.Zero);
    if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
    return handle;
  }

  private static ByHandleFileInformation Information(SafeFileHandle handle) {
    ByHandleFileInformation information;
    if (!GetFileInformationByHandle(handle, out information)) throw Error();
    return information;
  }

  private static string FinalPath(SafeFileHandle handle) {
    StringBuilder buffer = new StringBuilder(512);
    uint needed = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
    if (needed == 0) throw Error();
    if (needed >= buffer.Capacity) {
      buffer = new StringBuilder((int)needed + 1);
      needed = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
      if (needed == 0 || needed >= buffer.Capacity) throw Error();
    }
    string result = buffer.ToString();
    if (result.StartsWith(@"\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) return @"\\\\" + result.Substring(8);
    if (result.StartsWith(@"\\\\?\\", StringComparison.OrdinalIgnoreCase)) return result.Substring(4);
    return result;
  }

  public static void ValidatePath(SafeFileHandle handle, string expectedPath, bool directory) {
    ByHandleFileInformation information = Information(handle);
    if ((information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw new IOException("ShioriCode metadata path is a reparse point.");
    bool isDirectory = (information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    if (isDirectory != directory) throw new IOException("ShioriCode metadata path has the wrong file type.");
    string expected = Path.GetFullPath(expectedPath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    string actual = FinalPath(handle).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    if (!String.Equals(expected, actual, StringComparison.OrdinalIgnoreCase)) throw new IOException("ShioriCode metadata path escaped its canonical namespace.");
  }

  public static long LastWriteMilliseconds(SafeFileHandle handle) {
    FileTime time = Information(handle).LastWriteTime;
    long value = ((long)time.High << 32) | time.Low;
    return new DateTimeOffset(DateTime.FromFileTimeUtc(value)).ToUnixTimeMilliseconds();
  }

  public static long Length(SafeFileHandle handle) {
    ByHandleFileInformation information = Information(handle);
    ulong length = ((ulong)information.FileSizeHigh << 32) | information.FileSizeLow;
    if (length > Int64.MaxValue) throw new IOException("ShioriCode file is too large.");
    return (long)length;
  }

  public static string Identity(SafeFileHandle handle) {
    ByHandleFileInformation information = Information(handle);
    return information.VolumeSerialNumber.ToString("x8") + ":" +
      information.FileIndexHigh.ToString("x8") + ":" + information.FileIndexLow.ToString("x8");
  }

  public static int ValidateAcl(SafeFileHandle handle, string[] allowedOwnerSids,
      string[] trustedWriteSids, bool allowUntrustedDirectoryCreate) {
    IntPtr owner, group, dacl, sacl, descriptor;
    uint result = GetSecurityInfo(handle, 1, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      out owner, out group, out dacl, out sacl, out descriptor);
    if (result != 0) throw new Win32Exception((int)result);
    IntPtr text = IntPtr.Zero;
    try {
      uint textLength;
      if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1,
          OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, out text, out textLength)) throw Error();
      RawSecurityDescriptor security = new RawSecurityDescriptor(Marshal.PtrToStringUni(text));
      string ownerSid = security.Owner == null ? "" : security.Owner.Value;
      if (Array.IndexOf(allowedOwnerSids, ownerSid) < 0) throw new UnauthorizedAccessException("ShioriCode metadata has an untrusted owner.");
      if (security.DiscretionaryAcl == null) throw new UnauthorizedAccessException("ShioriCode metadata has no DACL.");
      int legacyFlags = (security.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 ? 1 : 0;
      const int untrustedMutationRights = unchecked((int)0x500D0156);
      const int directoryCreateRights = 0x00000116;
      foreach (GenericAce ace in security.DiscretionaryAcl) {
        QualifiedAce qualified = ace as QualifiedAce;
        if (qualified != null && (qualified.AceFlags & AceFlags.InheritOnly) != 0) {
          legacyFlags |= 1;
          continue;
        }
        if (qualified != null && qualified.AceQualifier == AceQualifier.AccessAllowed &&
            Array.IndexOf(trustedWriteSids, qualified.SecurityIdentifier.Value) < 0) {
          int mutationRights = qualified.AccessMask & untrustedMutationRights;
          if (mutationRights != 0 &&
              (!allowUntrustedDirectoryCreate || (mutationRights & ~directoryCreateRights) != 0)) {
            throw new UnauthorizedAccessException("ShioriCode metadata grants untrusted mutation access.");
          }
          if (mutationRights != 0) legacyFlags |= 2;
          legacyFlags |= 1;
        }
      }
      return legacyFlags;
    } finally {
      if (text != IntPtr.Zero) LocalFree(text);
      if (descriptor != IntPtr.Zero) LocalFree(descriptor);
    }
  }

  public static void HardenAcl(SafeFileHandle handle, string expectedPath, bool directory,
      string expectedIdentity, string serviceSid, bool grantService) {
    ValidatePath(handle, expectedPath, directory);
    if (!String.Equals(Identity(handle), expectedIdentity, StringComparison.OrdinalIgnoreCase)) {
      throw new IOException("ShioriCode metadata identity changed before ACL hardening.");
    }
    string inheritance = directory ? "OICI" : "";
    string serviceAce = grantService
      ? "(A;" + inheritance + ";0x1301bf;;;" + serviceSid + ")"
      : "";
    string sddl = "D:P" +
      "(A;" + inheritance + ";FA;;;S-1-5-18)" +
      "(A;" + inheritance + ";FA;;;S-1-5-32-544)" + serviceAce;
    IntPtr descriptor = IntPtr.Zero;
    try {
      uint descriptorSize;
      if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1,
          out descriptor, out descriptorSize)) throw Error();
      bool daclPresent, daclDefaulted;
      IntPtr dacl;
      if (!GetSecurityDescriptorDacl(descriptor, out daclPresent, out dacl, out daclDefaulted) ||
          !daclPresent || dacl == IntPtr.Zero) throw Error();
      uint result = SetSecurityInfo(handle, 1,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
      if (result != 0) throw new Win32Exception((int)result);
    } finally {
      if (descriptor != IntPtr.Zero) LocalFree(descriptor);
    }
  }

  public static byte[] ReadBounded(SafeFileHandle handle, int maximumBytes) {
    ByHandleFileInformation information = Information(handle);
    ulong length = ((ulong)information.FileSizeHigh << 32) | information.FileSizeLow;
    if (length > (ulong)maximumBytes) throw new IOException("Oversized ShioriCode metadata file.");
    byte[] contents = new byte[(int)length];
    using (FileStream stream = new FileStream(handle, FileAccess.Read, 4096, false)) {
      int offset = 0;
      while (offset < contents.Length) {
        int read = stream.Read(contents, offset, contents.Length - offset);
        if (read == 0) throw new EndOfStreamException("ShioriCode metadata was truncated while reading.");
        offset += read;
      }
    }
    return contents;
  }

  public static byte[] ReadTailBounded(SafeFileHandle handle, int maximumBytes) {
    ByHandleFileInformation information = Information(handle);
    ulong length = ((ulong)information.FileSizeHigh << 32) | information.FileSizeLow;
    int count = (int)Math.Min(length, (ulong)maximumBytes);
    byte[] contents = new byte[count];
    using (FileStream stream = new FileStream(handle, FileAccess.Read, 4096, false)) {
      stream.Seek((long)length - count, SeekOrigin.Begin);
      int offset = 0;
      while (offset < contents.Length) {
        int read = stream.Read(contents, offset, contents.Length - offset);
        if (read == 0) throw new EndOfStreamException("ShioriCode file was truncated while reading.");
        offset += read;
      }
    }
    return contents;
  }
}
'@
$specs=@(${entries})
$approved=@()
$approvedDirectories=@()
foreach ($spec in $specs) {
  $directoryHandle=$null
  try {
    $directoryHandle=[ShioriMetadataHandle]::OpenNoFollow($spec.Directory, $true)
  } catch {
    $native=$_.Exception
    while ($native.InnerException) { $native=$native.InnerException }
    if ($native -is [ComponentModel.Win32Exception] -and ($native.NativeErrorCode -eq 2 -or $native.NativeErrorCode -eq 3)) { continue }
    throw
  }
  try {
    $trustedSids=@('S-1-5-18','S-1-5-32-544')
    $currentIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
    $currentPrincipal=New-Object Security.Principal.WindowsPrincipal($currentIdentity)
    $currentIsAdmin=$currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($spec.IncludeCurrent -or $currentIsAdmin) { $trustedSids += $currentIdentity.User.Value }
    [ShioriMetadataHandle]::ValidatePath($directoryHandle, $spec.Directory, $true)
    $directoryFlags=[ShioriMetadataHandle]::ValidateAcl($directoryHandle, $trustedSids, $trustedSids, $true)
    $directoryIdentity=[ShioriMetadataHandle]::Identity($directoryHandle)
    $sharedDirectory=($directoryFlags -band 2) -ne 0
    $approvedDirectories += @{ Path=$spec.Directory; Identity=$directoryIdentity; LegacyAcl=($directoryFlags -ne 0); SharedDirectory=$sharedDirectory }
    if ($sharedDirectory) {
      # A legacy ProgramData directory can grant create-child without granting
      # replacement. Never enumerate attacker-addable history in that case.
      $items=@([PSCustomObject]@{ Name=$spec.Primary })
    } else {
      $items=@(Get-ChildItem -LiteralPath $spec.Directory -Filter 'service-layout*.json' -Force | Select-Object -First 130)
      if ($items.Count -gt 129) { throw 'Too many ShioriCode metadata records.' }
      $items=@($items | Where-Object { $_.Name -eq $spec.Primary -or $_.Name -match $spec.History })
    }
    foreach ($item in $items) {
      $fileHandle=$null
      try {
        $expectedPath=[IO.Path]::Combine($spec.Directory, $item.Name)
        try {
          $fileHandle=[ShioriMetadataHandle]::OpenNoFollow($expectedPath, $false)
        } catch {
          $native=$_.Exception
          while ($native.InnerException) { $native=$native.InnerException }
          if ($native -is [ComponentModel.Win32Exception] -and ($native.NativeErrorCode -eq 2 -or $native.NativeErrorCode -eq 3)) { continue }
          throw
        }
        [ShioriMetadataHandle]::ValidatePath($fileHandle, $expectedPath, $false)
        $fileFlags=[ShioriMetadataHandle]::ValidateAcl($fileHandle, $trustedSids, $trustedSids, $false)
        $fileIdentity=[ShioriMetadataHandle]::Identity($fileHandle)
        $writtenAt=[ShioriMetadataHandle]::LastWriteMilliseconds($fileHandle)
        $bytes=[ShioriMetadataHandle]::ReadBounded($fileHandle, 1048576)
        $approved += @{ Path=$expectedPath; Content=[Convert]::ToBase64String($bytes); WrittenAtMs=$writtenAt; LegacyAcl=(($directoryFlags -ne 0) -or ($fileFlags -ne 0)); DirectoryIdentity=$directoryIdentity; FileIdentity=$fileIdentity; SharedDirectory=$sharedDirectory }
      } finally {
        if ($null -ne $fileHandle) { $fileHandle.Dispose() }
      }
    }
  } finally {
    $directoryHandle.Dispose()
  }
}
[Console]::Out.Write((@{ Files=$approved; Directories=$approvedDirectories } | ConvertTo-Json -Compress -Depth 4))`;
}

export function renderWindowsSafeFileReadScript(
  filePaths: readonly string[],
  maximumBytes: number,
  fromTail = false,
): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 8 * 1024 * 1024) {
    throw new Error("Invalid bounded Windows file-read size");
  }
  for (const filePath of filePaths) {
    if (!path.win32.isAbsolute(filePath) || /[\0\r\n]/u.test(filePath)) {
      throw new Error("Windows file snapshots require canonical absolute paths");
    }
  }
  const preflight = renderWindowsMetadataPreflightScript();
  const marker = "$specs=@(";
  const markerIndex = preflight.indexOf(marker);
  if (markerIndex < 0) throw new Error("Windows safe-handle prelude is unavailable");
  const prelude = preflight.slice(0, markerIndex);
  const paths = filePaths.map(powershellSingleQuote).join(",");
  const reader = fromTail ? "ReadTailBounded" : "ReadBounded";
  const opener = fromTail
    ? "[ShioriMetadataHandle]::OpenLogTailNoFollow($path)"
    : "[ShioriMetadataHandle]::OpenNoFollow($path, $false)";
  return `${prelude}$paths=@(${paths})
$approved=@()
foreach ($path in $paths) {
  $handle=$null
  try {
    try {
      $handle=${opener}
    } catch {
      $native=$_.Exception
      while ($native.InnerException) { $native=$native.InnerException }
      if ($native -is [ComponentModel.Win32Exception] -and ($native.NativeErrorCode -eq 2 -or $native.NativeErrorCode -eq 3)) {
        $approved += @{ Path=$path; Missing=$true; Content=''; Truncated=$false }
        continue
      }
      throw
    }
    [ShioriMetadataHandle]::ValidatePath($handle, $path, $false)
    $length=[ShioriMetadataHandle]::Length($handle)
    $bytes=[ShioriMetadataHandle]::${reader}($handle, ${maximumBytes})
    $approved += @{ Path=$path; Missing=$false; Content=[Convert]::ToBase64String($bytes); Truncated=($length -gt $bytes.Length) }
  } finally {
    if ($null -ne $handle) { $handle.Dispose() }
  }
}
[Console]::Out.Write(($approved | ConvertTo-Json -Compress))`;
}

interface WindowsSafeFileRead {
  readonly filePath: string;
  readonly contents: Buffer | null;
  readonly truncated: boolean;
}

async function readWindowsSafeFiles(
  deps: Pick<ServiceDependencies, "run">,
  filePaths: readonly string[],
  maximumBytes: number,
  fromTail = false,
): Promise<readonly WindowsSafeFileRead[]> {
  const requested = new Map<string, string>();
  for (const filePath of filePaths) {
    const normalized = path.win32.resolve(filePath).toLowerCase();
    if (requested.has(normalized)) continue;
    requested.set(normalized, filePath);
  }
  if (requested.size === 0) return [];
  const result = await deps.run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    renderWindowsSafeFileReadScript([...requested.values()], maximumBytes, fromTail),
  ]);
  const parsed = JSON.parse(result.stdout) as unknown;
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.length !== requested.size) {
    throw new Error("Windows safe file reader returned an incomplete result");
  }
  const approved = new Map<string, WindowsSafeFileRead>();
  for (const entry of entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { Path?: unknown }).Path !== "string" ||
      typeof (entry as { Missing?: unknown }).Missing !== "boolean" ||
      typeof (entry as { Content?: unknown }).Content !== "string" ||
      typeof (entry as { Truncated?: unknown }).Truncated !== "boolean"
    ) {
      throw new Error("Windows safe file reader returned an invalid result");
    }
    const value = entry as {
      readonly Path: string;
      readonly Missing: boolean;
      readonly Content: string;
      readonly Truncated: boolean;
    };
    const normalized = path.win32.resolve(value.Path).toLowerCase();
    const requestedPath = requested.get(normalized);
    if (!requestedPath || approved.has(normalized)) {
      throw new Error("Windows safe file reader returned an unexpected path");
    }
    if (value.Missing && (value.Content !== "" || value.Truncated)) {
      throw new Error("Windows safe file reader returned invalid bounded contents");
    }
    const contents = value.Missing ? null : Buffer.from(value.Content, "base64");
    if (
      contents &&
      (contents.toString("base64") !== value.Content || contents.length > maximumBytes)
    ) {
      throw new Error("Windows safe file reader returned invalid bounded contents");
    }
    approved.set(normalized, {
      filePath: requestedPath,
      contents,
      truncated: value.Truncated,
    });
  }
  return [...requested.keys()].map((normalized) => {
    const value = approved.get(normalized);
    if (!value) throw new Error("Windows safe file reader omitted a requested path");
    return value;
  });
}

interface ValidatedWindowsMetadata {
  readonly candidates: readonly string[];
  readonly legacyAclCandidates: readonly string[];
  readonly aclIdentities: readonly WindowsMetadataAclIdentity[];
  readonly directoryIdentities: readonly WindowsMetadataDirectoryIdentity[];
  readonly records: readonly RecordedServiceLayout[];
  readonly snapshots: readonly ServiceFileSnapshot[];
}

export interface WindowsMetadataAclIdentity {
  readonly filePath: string;
  readonly directoryPath: string;
  readonly directoryIdentity: string;
  readonly fileIdentity: string;
  readonly sharedDirectory: boolean;
}

export interface WindowsMetadataDirectoryIdentity {
  readonly directoryPath: string;
  readonly directoryIdentity: string;
  readonly legacyAcl: boolean;
  readonly sharedDirectory: boolean;
}

async function validatedWindowsMetadataCandidates(
  deps: Pick<ServiceDependencies, "run">,
): Promise<ValidatedWindowsMetadata> {
  const result = await deps.run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    renderWindowsMetadataPreflightScript(),
  ]);
  if (!result.stdout.trim()) {
    return {
      candidates: [],
      legacyAclCandidates: [],
      aclIdentities: [],
      directoryIdentities: [],
      records: [],
      snapshots: [],
    };
  }
  const parsed = JSON.parse(result.stdout) as unknown;
  const envelope =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { Files?: unknown; Directories?: unknown })
      : null;
  const snapshots = Array.isArray(parsed)
    ? parsed
    : Array.isArray(envelope?.Files)
      ? envelope.Files
      : envelope?.Files
        ? [envelope.Files]
        : [];
  const directorySnapshots = Array.isArray(envelope?.Directories)
    ? envelope.Directories
    : envelope?.Directories
      ? [envelope.Directories]
      : [];
  if (
    !snapshots.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { Path?: unknown }).Path === "string" &&
        typeof (entry as { Content?: unknown }).Content === "string" &&
        typeof (entry as { WrittenAtMs?: unknown }).WrittenAtMs === "number" &&
        typeof (entry as { LegacyAcl?: unknown }).LegacyAcl === "boolean" &&
        typeof (entry as { DirectoryIdentity?: unknown }).DirectoryIdentity === "string" &&
        typeof (entry as { FileIdentity?: unknown }).FileIdentity === "string" &&
        typeof (entry as { SharedDirectory?: unknown }).SharedDirectory === "boolean",
    )
  ) {
    throw new Error("Windows metadata preflight returned an invalid candidate list");
  }
  if (
    !directorySnapshots.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { Path?: unknown }).Path === "string" &&
        typeof (entry as { Identity?: unknown }).Identity === "string" &&
        typeof (entry as { LegacyAcl?: unknown }).LegacyAcl === "boolean" &&
        typeof (entry as { SharedDirectory?: unknown }).SharedDirectory === "boolean",
    )
  ) {
    throw new Error("Windows metadata preflight returned an invalid directory list");
  }
  const candidates: string[] = [];
  const legacyAclCandidates: string[] = [];
  const aclIdentities: WindowsMetadataAclIdentity[] = [];
  const directoryIdentities: WindowsMetadataDirectoryIdentity[] = [];
  const records: RecordedServiceLayout[] = [];
  const fileSnapshots: ServiceFileSnapshot[] = [];
  for (const snapshot of snapshots as {
    readonly Path: string;
    readonly Content: string;
    readonly WrittenAtMs: number;
    readonly LegacyAcl: boolean;
    readonly DirectoryIdentity: string;
    readonly FileIdentity: string;
    readonly SharedDirectory: boolean;
  }[]) {
    const namespace = metadataNamespace(snapshot.Path, "win32");
    const basename = path.win32.basename(snapshot.Path);
    const isPrimary = [
      currentServiceLayoutMetadataPath("win32"),
      systemServiceLayoutMetadataPath("win32"),
    ].some((primary) => primary.toLowerCase() === snapshot.Path.toLowerCase());
    if (!namespace || (!isPrimary && !/^service-layout\.[a-f0-9]{20}\.json$/u.test(basename))) {
      throw new Error("Windows metadata preflight returned a path outside the canonical namespace");
    }
    if (
      !/^[a-f0-9]{8}:[a-f0-9]{8}:[a-f0-9]{8}$/iu.test(snapshot.DirectoryIdentity) ||
      !/^[a-f0-9]{8}:[a-f0-9]{8}:[a-f0-9]{8}$/iu.test(snapshot.FileIdentity) ||
      (snapshot.SharedDirectory && !isPrimary)
    ) {
      throw new Error("Windows metadata preflight returned an invalid file identity");
    }
    const contents = Buffer.from(snapshot.Content, "base64");
    if (contents.length > 1024 * 1024) throw new Error("Windows metadata exceeds size limit");
    candidates.push(snapshot.Path);
    if (snapshot.LegacyAcl) legacyAclCandidates.push(snapshot.Path);
    aclIdentities.push({
      filePath: snapshot.Path,
      directoryPath: path.win32.dirname(snapshot.Path),
      directoryIdentity: snapshot.DirectoryIdentity,
      fileIdentity: snapshot.FileIdentity,
      sharedDirectory: snapshot.SharedDirectory,
    });
    fileSnapshots.push({
      filePath: snapshot.Path,
      contents,
      mode: null,
      uid: null,
      gid: null,
    });
    const record = decodeWindowsServiceLayoutRecord(
      snapshot.Path,
      contents.toString("utf8"),
      snapshot.WrittenAtMs,
    );
    if (record) records.push(record);
  }
  for (const primaryPath of [
    currentServiceLayoutMetadataPath("win32"),
    systemServiceLayoutMetadataPath("win32"),
  ]) {
    const primaryPresent = candidates.some(
      (candidate) => candidate.toLowerCase() === primaryPath.toLowerCase(),
    );
    const primaryValid = records.some(
      (record) => record.metadataPath.toLowerCase() === primaryPath.toLowerCase(),
    );
    const namespace = metadataNamespace(primaryPath, "win32");
    const recovered = records.some(
      (record) => metadataNamespace(record.metadataPath, "win32") === namespace,
    );
    if (primaryPresent && !primaryValid && !recovered) {
      throw new Error(
        `Refusing service lifecycle changes because Windows layout metadata is corrupt: ${primaryPath}`,
      );
    }
  }
  for (const snapshot of directorySnapshots as {
    readonly Path: string;
    readonly Identity: string;
    readonly LegacyAcl: boolean;
    readonly SharedDirectory: boolean;
  }[]) {
    const canonical = [
      path.win32.dirname(currentServiceLayoutMetadataPath("win32")),
      path.win32.dirname(systemServiceLayoutMetadataPath("win32")),
    ].find((candidate) => candidate.toLowerCase() === snapshot.Path.toLowerCase());
    if (
      !canonical ||
      !/^[a-f0-9]{8}:[a-f0-9]{8}:[a-f0-9]{8}$/iu.test(snapshot.Identity) ||
      directoryIdentities.some(
        (candidate) => candidate.directoryPath.toLowerCase() === canonical.toLowerCase(),
      )
    ) {
      throw new Error("Windows metadata preflight returned an invalid directory identity");
    }
    directoryIdentities.push({
      directoryPath: canonical,
      directoryIdentity: snapshot.Identity,
      legacyAcl: snapshot.LegacyAcl,
      sharedDirectory: snapshot.SharedDirectory,
    });
  }
  for (const file of aclIdentities) {
    const directory = directoryIdentities.find(
      (candidate) =>
        path.win32.resolve(candidate.directoryPath).toLowerCase() ===
        path.win32.resolve(file.directoryPath).toLowerCase(),
    );
    if (
      !directory ||
      directory.directoryIdentity.toLowerCase() !== file.directoryIdentity.toLowerCase() ||
      directory.sharedDirectory !== file.sharedDirectory
    ) {
      throw new Error("Windows metadata file identity does not match its directory handle");
    }
  }
  return {
    candidates,
    legacyAclCandidates,
    aclIdentities,
    directoryIdentities,
    records,
    snapshots: fileSnapshots,
  };
}

async function hardenWindowsLegacyMetadata(
  deps: Pick<ServiceDependencies, "run">,
  layout: ServiceLayout,
  metadata: ValidatedWindowsMetadata,
): Promise<void> {
  const namespaceDirectories = metadata.directoryIdentities.filter(
    (candidate) =>
      metadataNamespace(
        path.win32.join(candidate.directoryPath, "service-layout.json"),
        "win32",
      ) === layout.accountMode,
  );
  const namespaceFiles = metadata.aclIdentities.filter(
    (candidate) => metadataNamespace(candidate.filePath, "win32") === layout.accountMode,
  );
  for (const directory of namespaceDirectories) {
    const files = namespaceFiles.filter(
      (candidate) =>
        path.win32.resolve(candidate.directoryPath).toLowerCase() ===
        path.win32.resolve(directory.directoryPath).toLowerCase(),
    );
    if (
      !directory.legacyAcl &&
      !files.some((candidate) => metadata.legacyAclCandidates.includes(candidate.filePath))
    ) {
      continue;
    }
    await deps.run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      renderWindowsMetadataAclHardeningScript(layout, directory),
    ]);
    for (const file of files) {
      await deps.run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        renderWindowsMetadataAclHardeningScript(layout, directory, file),
      ]);
    }
  }
}

export function renderWindowsMetadataAclHardeningScript(
  layout: ServiceLayout,
  directory: WindowsMetadataDirectoryIdentity,
  file?: WindowsMetadataAclIdentity,
): string {
  if (
    !path.win32.isAbsolute(directory.directoryPath) ||
    !/^[a-f0-9]{8}:[a-f0-9]{8}:[a-f0-9]{8}$/iu.test(directory.directoryIdentity) ||
    (file !== undefined &&
      (!path.win32.isAbsolute(file.filePath) ||
        path.win32.resolve(path.win32.dirname(file.filePath)).toLowerCase() !==
          path.win32.resolve(directory.directoryPath).toLowerCase() ||
        file.directoryIdentity.toLowerCase() !== directory.directoryIdentity.toLowerCase() ||
        !/^[a-f0-9]{8}:[a-f0-9]{8}:[a-f0-9]{8}$/iu.test(file.fileIdentity)))
  ) {
    throw new Error("Invalid identity-bound Windows metadata ACL request");
  }
  const preflight = renderWindowsMetadataPreflightScript();
  const markerIndex = preflight.indexOf("$specs=@(");
  if (markerIndex < 0) throw new Error("Windows metadata handle prelude is unavailable");
  const prelude = preflight.slice(0, markerIndex);
  const fileHardening = file
    ? `$filePath=${powershellSingleQuote(file.filePath)}
$fileIdentity=${powershellSingleQuote(file.fileIdentity)}
$fileHandle=[ShioriMetadataHandle]::OpenForAclUpdate($filePath, $false)
[ShioriMetadataHandle]::HardenAcl($fileHandle, $filePath, $false, $fileIdentity, $serviceSid, $grantService)`
    : "";
  return `${prelude}$directoryPath=${powershellSingleQuote(directory.directoryPath)}
$directoryIdentity=${powershellSingleQuote(directory.directoryIdentity)}
$grantService=$${layout.accountMode === "current" ? "true" : "false"}
$serviceSid=if ($grantService) { (New-Object Security.Principal.NTAccount(${powershellSingleQuote(layout.account)})).Translate([Security.Principal.SecurityIdentifier]).Value } else { 'S-1-5-18' }
$directoryHandle=$null
$fileHandle=$null
try {
  $directoryHandle=[ShioriMetadataHandle]::OpenForAclUpdate($directoryPath, $true)
  [ShioriMetadataHandle]::HardenAcl($directoryHandle, $directoryPath, $true, $directoryIdentity, $serviceSid, $grantService)
  ${fileHardening}
} finally {
  if ($null -ne $fileHandle) { $fileHandle.Dispose() }
  if ($null -ne $directoryHandle) { $directoryHandle.Dispose() }
}`;
}

async function prepareWindowsMetadataDirectory(
  deps: Pick<ServiceDependencies, "run">,
  layout: ServiceLayout,
  metadata: ValidatedWindowsMetadata,
): Promise<{
  readonly metadata: ValidatedWindowsMetadata;
  readonly existedBefore: boolean;
}> {
  const directoryPath = path.win32.dirname(serviceLayoutMetadataPath(layout));
  const existing = metadata.directoryIdentities.find(
    (candidate) =>
      path.win32.resolve(candidate.directoryPath).toLowerCase() ===
      path.win32.resolve(directoryPath).toLowerCase(),
  );
  if (existing) {
    await hardenWindowsLegacyMetadata(deps, layout, metadata);
    return { metadata, existedBefore: true };
  }

  // The canonical directory was absent in the handle preflight. Validate its
  // stable parent, create exactly one component, then reopen it through the
  // metadata handle validator. Never enroll a later path by name alone.
  await prevalidateWindowsUnmanagedDirectories(deps, layout, [directoryPath]);
  const parentDirectory = path.win32.dirname(directoryPath);
  if (!fs.existsSync(parentDirectory)) {
    throw new Error(
      `Refusing to create Windows metadata through missing intermediate components: ${directoryPath}`,
    );
  }
  try {
    fs.mkdirSync(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const refreshed = await validatedWindowsMetadataCandidates(deps);
  const created = refreshed.directoryIdentities.find(
    (candidate) =>
      path.win32.resolve(candidate.directoryPath).toLowerCase() ===
      path.win32.resolve(directoryPath).toLowerCase(),
  );
  if (
    !created ||
    refreshed.candidates.some(
      (candidate) =>
        path.win32.resolve(path.win32.dirname(candidate)).toLowerCase() ===
        path.win32.resolve(directoryPath).toLowerCase(),
    )
  ) {
    throw new Error("Windows metadata directory changed during secure creation");
  }
  await deps.run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    renderWindowsMetadataAclHardeningScript(layout, created),
  ]);
  return { metadata: refreshed, existedBefore: false };
}

function validateWindowsRecordedRuntimeRoots(
  records: readonly RecordedServiceLayout[],
  trustedProgramFiles: string,
): void {
  const trustedRuntimeParent = path.win32.join(trustedProgramFiles, "ShioriCode Runtime");
  for (const record of records) {
    if (record.layout.accountMode !== "dedicated") continue;
    if (
      !servicePathIsWithin(record.layout, serviceRuntimeRoot(record.layout), trustedRuntimeParent)
    ) {
      throw new Error(
        `Recorded Windows runtime is outside the trusted Program Files boundary: ${serviceRuntimeRoot(record.layout)}`,
      );
    }
  }
}

function readInstalledServiceLayout(
  platform: ServicePlatform,
  candidates: readonly string[] = metadataCandidates(platform),
): ServiceLayout | null {
  assertRecoverableLayoutMetadata(platform, candidates);
  return installedLayoutFromRecords(platform, readRecordedServiceLayouts(platform, candidates));
}

export function installedLayoutFromRecords(
  platform: ServicePlatform,
  records: readonly RecordedServiceLayout[],
  definitionExists: (definitionPath: string) => boolean = fs.existsSync,
): ServiceLayout | null {
  for (const accountMode of ["dedicated", "current"] as const) {
    const liveRecords = records.filter(
      (record) =>
        record.layout.accountMode === accountMode && definitionExists(record.layout.definitionPath),
    );
    const primary = liveRecords.find(
      (record) =>
        record.metadataPath.toLowerCase() ===
        serviceLayoutMetadataPath(record.layout).toLowerCase(),
    );
    if (primary) return primary.layout;
    if (liveRecords[0]) return liveRecords[0].layout;
  }
  const legacy = serviceLayout(platform);
  return definitionExists(legacy.definitionPath) ? legacy : null;
}

interface ServiceFileSnapshot {
  readonly filePath: string;
  readonly contents: Buffer | null;
  readonly mode: number | null;
  readonly uid: number | null;
  readonly gid: number | null;
}

function snapshotServiceFiles(filePaths: Iterable<string>): readonly ServiceFileSnapshot[] {
  return [...new Set(filePaths)].map((filePath) => {
    let handle: number | undefined;
    try {
      const linkStat = fs.lstatSync(filePath);
      if (!linkStat.isFile() || linkStat.isSymbolicLink() || linkStat.size > 8 * 1024 * 1024) {
        throw new Error(`Refusing to snapshot unsafe service file: ${filePath}`);
      }
      handle = fs.openSync(
        filePath,
        fs.constants.O_RDONLY |
          fs.constants.O_NONBLOCK |
          (process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0)),
      );
      const stat = fs.fstatSync(handle);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) {
        throw new Error(`Refusing to snapshot unsafe service file: ${filePath}`);
      }
      const contents = Buffer.alloc(8 * 1024 * 1024 + 1);
      let offset = 0;
      while (offset < contents.length) {
        const bytesRead = fs.readSync(handle, contents, offset, contents.length - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > 8 * 1024 * 1024) {
        throw new Error(`Refusing to snapshot oversized service file: ${filePath}`);
      }
      return {
        filePath,
        contents: contents.subarray(0, offset),
        mode: stat.mode & 0o777,
        uid: stat.uid,
        gid: stat.gid,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { filePath, contents: null, mode: null, uid: null, gid: null };
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
    }
  });
}

function restoreServiceFiles(snapshots: readonly ServiceFileSnapshot[]): void {
  for (const snapshot of snapshots) {
    if (snapshot.contents === null) {
      fs.rmSync(snapshot.filePath, { force: true });
      continue;
    }
    writePrivateFileAtomically(snapshot.filePath, snapshot.contents);
    if (snapshot.mode !== null) fs.chmodSync(snapshot.filePath, snapshot.mode);
    if (process.platform !== "win32" && snapshot.uid !== null && snapshot.gid !== null) {
      fs.chownSync(snapshot.filePath, snapshot.uid, snapshot.gid);
    }
  }
}

export async function runTransactionalServiceInstall<T>(steps: {
  readonly installAndStart: () => Promise<T>;
  readonly verifyAndCommit: (result: T) => Promise<void>;
  readonly rollback: (error: unknown) => Promise<void>;
}): Promise<T> {
  try {
    const result = await steps.installAndStart();
    await steps.verifyAndCommit(result);
    return result;
  } catch (error) {
    try {
      await steps.rollback(error);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Service installation failed and the previous service could not be fully restored",
      );
    }
    throw error;
  }
}

function uniqueServiceLayouts(layouts: readonly ServiceLayout[]): readonly ServiceLayout[] {
  const result = new Map<string, ServiceLayout>();
  for (const layout of layouts) result.set(serviceLayoutIdentity(layout), layout);
  return [...result.values()];
}

export function validateServiceAccountModeTransition(
  priorLayouts: readonly ServiceLayout[],
  requestedLayout: ServiceLayout,
): void {
  if (priorLayouts.some((candidate) => candidate.accountMode !== requestedLayout.accountMode)) {
    throw new Error(
      "Changing service account mode in place is unsafe. Uninstall the existing service in its owning account context, then install the new mode.",
    );
  }
  const normalizeAccount = (account: string) =>
    requestedLayout.platform === "win32" ? account.toLowerCase() : account;
  if (
    priorLayouts.some(
      (candidate) =>
        normalizeAccount(candidate.account) !== normalizeAccount(requestedLayout.account),
    )
  ) {
    throw new Error(
      "Changing the service account in place is unsafe. Uninstall the existing service first.",
    );
  }
}

async function linuxSystemctl(
  deps: ServiceDependencies,
  layout: ServiceLayout,
  args: readonly string[],
): Promise<CommandResult> {
  if (layout.accountMode === "dedicated") return await deps.run("systemctl", args);
  const canUseCurrentBus =
    layout.account === invokingUsername() &&
    !(typeof process.getuid === "function" && process.getuid() === 0 && layout.account !== "root");
  if (canUseCurrentBus) return await deps.run("systemctl", ["--user", ...args]);
  const uidResult = await deps.run("id", ["-u", layout.account]);
  const uid = uidResult.stdout.trim();
  if (!/^\d+$/u.test(uid)) {
    throw new Error(`Could not resolve the user-manager UID for ${layout.account}`);
  }
  return await deps.run("/usr/sbin/runuser", [
    "-u",
    layout.account,
    "--",
    "env",
    `XDG_RUNTIME_DIR=/run/user/${uid}`,
    `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`,
    "systemctl",
    "--user",
    ...args,
  ]);
}

async function darwinServiceDomain(
  deps: ServiceDependencies,
  layout: ServiceLayout,
): Promise<string> {
  if (layout.accountMode === "dedicated") return "system";
  if (layout.account === invokingUsername()) return `gui/${invokingUid()}`;
  const result = await deps.run("id", ["-u", layout.account]);
  const uid = result.stdout.trim();
  if (!/^\d+$/u.test(uid))
    throw new Error(`Could not resolve the launchd UID for ${layout.account}`);
  return `gui/${uid}`;
}

async function stopServiceLayout(deps: ServiceDependencies, layout: ServiceLayout): Promise<void> {
  if (layout.platform === "linux") {
    await ignoreMissingService(
      linuxSystemctl(deps, layout, ["disable", "--now", layout.serviceId]),
    );
    return;
  }
  if (layout.platform === "darwin") {
    const domain = await darwinServiceDomain(deps, layout);
    await ignoreMissingService(deps.run("launchctl", ["bootout", domain, layout.definitionPath]));
    return;
  }
  await stopWindowsServiceProcesses(deps, layout);
}

async function startServiceLayout(deps: ServiceDependencies, layout: ServiceLayout): Promise<void> {
  if (layout.platform === "linux") {
    await linuxSystemctl(deps, layout, ["daemon-reload"]);
    await linuxSystemctl(deps, layout, ["enable", layout.serviceId]);
    await linuxSystemctl(deps, layout, ["restart", layout.serviceId]);
    return;
  }
  if (layout.platform === "darwin") {
    const domain = await darwinServiceDomain(deps, layout);
    await deps.run("launchctl", ["bootstrap", domain, layout.definitionPath]);
    await deps.run("launchctl", ["enable", `${domain}/${layout.serviceId}`]);
    await deps.run("launchctl", ["kickstart", "-k", `${domain}/${layout.serviceId}`]);
    return;
  }
  await createWindowsTask(deps, layout, null);
  await deps.run("schtasks.exe", ["/Run", "/TN", layout.serviceId]);
}

async function removeServiceDefinition(
  deps: ServiceDependencies,
  layout: ServiceLayout,
): Promise<boolean> {
  if (layout.platform === "win32") {
    const kind = windowsServiceDefinitionKind(layout);
    if (kind === "invalid") {
      throw new Error("Refusing an unsafe Windows service definition path");
    }
    if (kind === "legacy") return false;
    fs.rmSync(layout.definitionPath, { force: true });
    return true;
  }
  if (
    layout.accountMode === "current" &&
    (isSudoInvocation() || layout.account !== os.userInfo().username)
  ) {
    await runAsServiceAccount(deps, layout, "/bin/rm", ["-f", "--", layout.definitionPath]);
    return true;
  }
  fs.rmSync(layout.definitionPath, { force: true });
  return true;
}

async function restoreServicePermissions(
  deps: ServiceDependencies,
  previousLayout: ServiceLayout,
  candidateLayout: ServiceLayout,
): Promise<void> {
  if (previousLayout.platform === "win32") {
    // Recorded service-writable roots were never rewritten during install, so
    // rollback must not path-walk or mutate them either. Only the protected
    // runtime roots may need their non-service-writable ACLs reconstructed.
    if (previousLayout.accountMode === "dedicated") {
      const runtimeRoot = serviceRuntimeRoot(previousLayout);
      const runtimeParent = path.win32.dirname(runtimeRoot);
      if (fs.existsSync(runtimeParent)) {
        await applyWindowsDirectoryAcl(deps, previousLayout, runtimeParent, "read-execute", false);
      }
      if (fs.existsSync(runtimeRoot)) {
        await applyWindowsDirectoryAcl(deps, previousLayout, runtimeRoot, "read-execute", false);
      }
    }
    return;
  }
  if (!fs.existsSync(previousLayout.stateDir)) return;
  const primaryGroup =
    previousLayout.accountMode === "current"
      ? (await deps.run("id", ["-gn", previousLayout.account])).stdout.trim()
      : previousLayout.account;
  if (!primaryGroup)
    throw new Error(`Could not resolve primary group for ${previousLayout.account}`);
  const owner = `${previousLayout.account}:${primaryGroup}`;
  if (previousLayout.accountMode === "dedicated") {
    await chownWritableServiceState(deps.run, previousLayout, owner);
    return;
  }
  const targets = new Set<string>();
  if (
    normalizedLayoutPath(previousLayout, previousLayout.stateDir) ===
    normalizedLayoutPath(candidateLayout, candidateLayout.stateDir)
  ) {
    targets.add(candidateLayout.stateDir);
  }
  if (
    normalizedLayoutPath(previousLayout, previousLayout.workspaceDir) ===
    normalizedLayoutPath(candidateLayout, candidateLayout.workspaceDir)
  ) {
    targets.add(candidateLayout.workspaceDir);
  }
  if (
    normalizedLayoutPath(previousLayout, path.dirname(previousLayout.logPath)) ===
    normalizedLayoutPath(candidateLayout, path.dirname(candidateLayout.logPath))
  ) {
    targets.add(path.dirname(candidateLayout.logPath));
  }
  for (const target of targets) await deps.run("chown", [owner, target]);
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
  if (
    (options.accountMode ?? "dedicated") === "current" &&
    deps.platform !== "win32" &&
    isSudoInvocation()
  ) {
    throw new Error(
      "Current-account service installation must not run under sudo. Re-run the command as the target user so its state and service definition remain user-owned.",
    );
  }
  let layout = serviceLayout(deps.platform, options);
  if (layout.accountMode === "current" && layout.account !== invokingUsername()) {
    throw new Error("Current-account services must run as the invoking OS user");
  }
  if (layout.accountMode === "dedicated") requireAdministrator(deps.platform);
  layout = await resolveWindowsRuntimeLayout(deps, layout);
  validateServiceWritableTargets(layout);
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

  let windowsMetadata =
    deps.platform === "win32" ? await validatedWindowsMetadataCandidates(deps) : undefined;
  const validMetadataRecords =
    windowsMetadata?.records ?? readAllRecordedServiceLayouts(deps.platform);
  const newestRecords = windowsMetadata
    ? newestRecordedLayouts(windowsMetadata.records)
    : readRecordedServiceLayouts(deps.platform);
  const recordedLayouts = newestRecords.map(({ layout }) => layout);
  const installedLayout = windowsMetadata
    ? installedLayoutFromRecords(deps.platform, newestRecords)
    : readInstalledServiceLayout(deps.platform);
  if (deps.platform === "win32") {
    layout = windowsLayoutWithManagerSlot(
      layout,
      // Alternate between two fixed, validated task slots. The healthy slot
      // remains intact until its replacement has passed identity health.
      nextWindowsServiceManagerId(installedLayout),
    );
    const trustedProgramFiles = path.win32.dirname(path.win32.dirname(serviceRuntimeRoot(layout)));
    validateWindowsRecordedRuntimeRoots(validMetadataRecords, trustedProgramFiles);
  }
  const priorLayouts = uniqueServiceLayouts([
    ...recordedLayouts,
    ...(installedLayout ? [installedLayout] : []),
  ]);
  const previouslyManagedWindowsDirectories = new Set(
    priorLayouts.flatMap((candidate) =>
      candidate.platform === "win32"
        ? windowsServiceDirectories(candidate).map((directory) =>
            path.win32.resolve(directory).toLowerCase(),
          )
        : [],
    ),
  );
  const candidateWindowsAclDirectories =
    deps.platform === "win32"
      ? windowsUnmanagedServiceDirectories(layout, previouslyManagedWindowsDirectories)
      : [];
  const windowsDirectoriesAbsentBeforeInstall = candidateWindowsAclDirectories.filter(
    (directory) => !fs.existsSync(directory),
  );
  const windowsDirectoriesPresentBeforeInstall = candidateWindowsAclDirectories.filter(
    (directory) => !windowsDirectoriesAbsentBeforeInstall.includes(directory),
  );
  const initiallyPresentWindowsDirectories = new Set(
    windowsDirectoriesPresentBeforeInstall.map((directory) =>
      path.win32.resolve(directory).toLowerCase(),
    ),
  );
  const initiallyAbsentWindowsDirectories = new Set(
    windowsDirectoriesAbsentBeforeInstall.map((directory) =>
      path.win32.resolve(directory).toLowerCase(),
    ),
  );
  if (deps.platform === "win32") {
    // Prove every pre-existing adoption target before a task is stopped or an
    // ACL snapshot is taken. Unsafe attacker-owned roots are never enrolled in
    // rollback and therefore never receive a privileged path-based restore.
    await prevalidateWindowsUnmanagedDirectories(
      deps,
      layout,
      candidateWindowsAclDirectories,
      initiallyPresentWindowsDirectories,
    );
  }
  validateServiceAccountModeTransition(priorLayouts, layout);
  for (const priorLayout of priorLayouts) validateServiceWritableTargets(priorLayout);
  let windowsMetadataDirectoryExistedBefore = false;
  if (windowsMetadata) {
    const preparedMetadata = await prepareWindowsMetadataDirectory(deps, layout, windowsMetadata);
    windowsMetadata = preparedMetadata.metadata;
    windowsMetadataDirectoryExistedBefore = preparedMetadata.existedBefore;
  }
  const layoutsToStop = uniqueServiceLayouts([...priorLayouts, layout]);
  const validMetadataPaths = new Set(validMetadataRecords.map((record) => record.metadataPath));
  const intendedPrimaryPath = serviceLayoutMetadataPath(layout);
  const intendedHistoryPath = serviceLayoutHistoryPath(layout);
  const metadataPathsToSnapshot = [...validMetadataPaths];
  const syntheticSnapshots: ServiceFileSnapshot[] = [];
  for (const intendedPath of [intendedPrimaryPath, intendedHistoryPath]) {
    if (!fs.existsSync(intendedPath)) {
      if (windowsMetadata) {
        syntheticSnapshots.push({
          filePath: intendedPath,
          contents: null,
          mode: null,
          uid: null,
          gid: null,
        });
      } else {
        metadataPathsToSnapshot.push(intendedPath);
      }
      continue;
    }
    if (validMetadataPaths.has(intendedPath)) {
      metadataPathsToSnapshot.push(intendedPath);
      continue;
    }
    if (intendedPath !== intendedPrimaryPath) {
      throw new Error(`Refusing to overwrite unsafe service provenance file: ${intendedPath}`);
    }
    // A corrupt primary with valid history is recoverable. If commit later
    // fails, remove the new pointer and continue using that history.
    syntheticSnapshots.push({
      filePath: intendedPath,
      contents: null,
      mode: null,
      uid: null,
      gid: null,
    });
  }
  const definitionPathsToSnapshot =
    deps.platform === "win32"
      ? windowsCandidateDefinitionPathsToSnapshot(layout)
      : [
          ...priorLayouts
            .filter(
              (candidate) =>
                candidate.accountMode === "dedicated" || layout.accountMode === "current",
            )
            .map((candidate) => candidate.definitionPath),
          layout.definitionPath,
        ];
  const windowsDefinitionSnapshots = windowsMetadata
    ? (await readWindowsSafeFiles(deps, definitionPathsToSnapshot, 8 * 1024 * 1024)).map(
        (snapshot): ServiceFileSnapshot => ({
          filePath: snapshot.filePath,
          contents: snapshot.contents,
          mode: null,
          uid: null,
          gid: null,
        }),
      )
    : [];
  const fileSnapshots = [
    ...snapshotServiceFiles([
      ...(windowsMetadata ? [] : definitionPathsToSnapshot),
      ...(windowsMetadata ? [] : metadataPathsToSnapshot),
    ]),
    ...windowsDefinitionSnapshots,
    ...(windowsMetadata?.snapshots.filter((snapshot) =>
      validMetadataPaths.has(snapshot.filePath),
    ) ?? []),
    ...syntheticSnapshots,
  ];
  const previousWindowsTasks = new Map<string, string>();
  if (deps.platform === "win32") {
    for (const previous of priorLayouts) {
      const managerId = serviceManagerId(previous);
      const taskXml = await snapshotWindowsTask(deps, managerId);
      if (taskXml) previousWindowsTasks.set(managerId, taskXml);
    }
  }
  const windowsAccountPassword =
    deps.platform === "win32" && layout.accountMode === "dedicated"
      ? randomBytes(32).toString("base64url")
      : null;
  const startedAfterMs = Date.now();
  let stagedRuntime: StagedServiceRuntime | undefined;
  const securedFreshWindowsDirectories = new Set<string>();
  const windowsAclRoots = new Map<string, WindowsAclSnapshotRoot>();
  if (deps.platform === "win32") {
    for (const directory of windowsDirectoriesPresentBeforeInstall) {
      windowsAclRoots.set(path.win32.resolve(directory).toLowerCase(), {
        directory,
        recursive: false,
      });
    }
    if (layout.accountMode === "dedicated") {
      const runtimeRoot = serviceRuntimeRoot(layout);
      for (const directory of [path.win32.dirname(runtimeRoot), runtimeRoot]) {
        windowsAclRoots.set(path.win32.resolve(directory).toLowerCase(), {
          directory,
          recursive: false,
        });
      }
    }
    if (windowsMetadataDirectoryExistedBefore) {
      const metadataDirectory = path.win32.dirname(intendedPrimaryPath);
      windowsAclRoots.set(path.win32.resolve(metadataDirectory).toLowerCase(), {
        directory: metadataDirectory,
        recursive: false,
      });
    }
  }
  let windowsAclSnapshots: readonly WindowsAclSnapshot[] | undefined;

  await runTransactionalServiceInstall({
    installAndStart: async () => {
      for (const previous of layoutsToStop) {
        await stopServiceLayout(deps, previous);
        if (
          deps.platform === "win32" &&
          serviceLayoutIdentity(previous) !== serviceLayoutIdentity(layout)
        ) {
          await ignoreMissingService(
            deps.run("schtasks.exe", ["/Change", "/TN", serviceManagerId(previous), "/Disable"]),
          );
        }
      }
      if (deps.platform === "win32") {
        windowsAclSnapshots = await snapshotWindowsAcls(deps, [...windowsAclRoots.values()]);
      }
      try {
        switch (deps.platform) {
          case "linux":
            stagedRuntime = await installLinux(
              deps,
              layout,
              recoveryUsername,
              recoveryPassword.password,
            );
            break;
          case "darwin":
            stagedRuntime = await installMac(
              deps,
              layout,
              recoveryUsername,
              recoveryPassword.password,
            );
            break;
          case "win32":
            stagedRuntime = await installWindows(
              deps,
              layout,
              recoveryUsername,
              recoveryPassword.password,
              windowsAccountPassword,
              previouslyManagedWindowsDirectories,
              initiallyAbsentWindowsDirectories,
              securedFreshWindowsDirectories,
            );
            break;
        }
      } catch (error) {
        const failedRuntime = (error as { stagedRuntime?: StagedServiceRuntime }).stagedRuntime;
        if (failedRuntime) stagedRuntime = failedRuntime;
        throw error;
      }
      if (!stagedRuntime) throw new Error("The service runtime was not staged");
      return stagedRuntime;
    },
    verifyAndCommit: async (installedRuntime) => {
      await deps.healthCheck(layout, { startedAfterMs });
      const metadataPaths = writeServiceLayout(layout);
      if (layout.platform === "win32") {
        const metadataDirectory = path.win32.dirname(
          metadataPaths[0] ?? serviceLayoutMetadataPath(layout),
        );
        await applyWindowsDirectoryAcl(
          deps,
          layout,
          metadataDirectory,
          layout.accountMode === "dedicated" ? "none" : "modify",
          false,
        );
        for (const metadataPath of metadataPaths) {
          await applyWindowsFileAcl(
            deps,
            layout,
            metadataPath,
            layout.accountMode === "dedicated" ? "none" : "modify",
          );
        }
      }
      pruneStagedServiceRuntimes(layout, installedRuntime.runtimeDir);
    },
    rollback: async () => {
      const failures: unknown[] = [];
      let candidateStopped = false;
      try {
        await stopServiceLayout(deps, layout);
        if (deps.platform === "win32") {
          await ignoreMissingService(
            deps.run("schtasks.exe", ["/Delete", "/TN", serviceManagerId(layout), "/F"]),
          );
        }
        candidateStopped = true;
      } catch (error) {
        failures.push(error);
      }
      try {
        restoreServiceFiles(fileSnapshots);
      } catch (error) {
        failures.push(error);
      }
      if (
        candidateStopped &&
        deps.platform === "win32" &&
        securedFreshWindowsDirectories.size > 0
      ) {
        try {
          await quarantineFreshWindowsDirectories(deps, layout, [
            ...securedFreshWindowsDirectories,
          ]);
        } catch (error) {
          failures.push(error);
        }
      }
      let exactWindowsAclsRestored = false;
      if (deps.platform === "win32" && windowsAclSnapshots !== undefined) {
        try {
          await restoreWindowsAcls(deps, windowsAclSnapshots);
          exactWindowsAclsRestored = true;
        } catch (error) {
          failures.push(error);
        }
      }
      if (installedLayout) {
        try {
          const rollbackStartedAfterMs = Date.now();
          if (!exactWindowsAclsRestored) {
            await restoreServicePermissions(deps, installedLayout, layout);
          }
          if (deps.platform === "win32") {
            const previousManagerId = serviceManagerId(installedLayout);
            const previousTask = previousWindowsTasks.get(previousManagerId);
            if (
              previousTask &&
              installedLayout.accountMode === "dedicated" &&
              layout.accountMode === "dedicated" &&
              installedLayout.account.toLowerCase() === layout.account.toLowerCase() &&
              windowsAccountPassword
            ) {
              // The failed attempt may have stopped before or after changing
              // the local-account password. Force the known generated value
              // idempotently before re-registering the healthy prior task.
              await deps.run("powershell.exe", [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                renderWindowsAccountPasswordScript(installedLayout.account, windowsAccountPassword),
              ]);
              await restoreWindowsTask(
                deps,
                previousManagerId,
                previousTask,
                installedLayout.account,
                windowsAccountPassword,
              );
            } else {
              await ignoreMissingService(
                deps.run("schtasks.exe", ["/Change", "/TN", previousManagerId, "/Enable"]),
              );
            }
            await deps.run("schtasks.exe", ["/Run", "/TN", previousManagerId]);
          } else {
            await startServiceLayout(deps, installedLayout);
          }
          await deps.healthCheck(installedLayout, {
            startedAfterMs: rollbackStartedAfterMs,
          });
        } catch (error) {
          failures.push(error);
        }
      }
      if (candidateStopped && stagedRuntime) {
        try {
          fs.rmSync(stagedRuntime.runtimeDir, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to restore the previous service installation");
      }
    },
  });

  // Superseded managers are retired only after the transaction is committed.
  // A cleanup failure leaves the new, healthy service authoritative and never
  // attempts an impossible rollback after deleting an old definition/task.
  const warnings: string[] = [];
  try {
    if (layout.platform === "win32") {
      for (const previous of priorLayouts) {
        if (serviceManagerId(previous) !== serviceManagerId(layout)) {
          await ignoreMissingService(
            deps.run("schtasks.exe", ["/Delete", "/TN", serviceManagerId(previous), "/F"]),
          );
        }
        if (
          path.win32.resolve(previous.definitionPath).toLowerCase() !==
          path.win32.resolve(layout.definitionPath).toLowerCase()
        ) {
          const removed = await removeServiceDefinition(deps, previous);
          if (!removed) {
            warnings.push(
              `A legacy service definition was preserved for manual administrator cleanup: ${previous.definitionPath}`,
            );
          }
        }
      }
      const activeHistoryPath = serviceLayoutHistoryPath(layout).toLowerCase();
      for (const record of validMetadataRecords) {
        if (record.layout.accountMode !== layout.accountMode) continue;
        const metadataPath = record.metadataPath.toLowerCase();
        if (
          metadataPath === serviceLayoutMetadataPath(layout).toLowerCase() ||
          metadataPath === activeHistoryPath
        ) {
          continue;
        }
        fs.rmSync(record.metadataPath, { force: true });
      }
    } else {
      const activePrimaryPath = serviceLayoutMetadataPath(layout);
      const activeHistoryPath = serviceLayoutHistoryPath(layout);
      for (const record of validMetadataRecords) {
        if (
          record.metadataPath === activePrimaryPath ||
          record.metadataPath === activeHistoryPath
        ) {
          continue;
        }
        fs.rmSync(record.metadataPath, { force: true });
      }
      for (const previous of priorLayouts) {
        if (previous.accountMode === layout.accountMode) continue;
        await removeServiceDefinition(deps, previous);
      }
    }
  } catch (error) {
    warnings.push(
      `The new service is healthy, but a superseded manager could not be fully removed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    layout,
    recoveryUsername,
    recoveryPassword: recoveryPassword.password,
    recoveryPasswordGenerated: recoveryPassword.generated,
    warnings,
  };
}

function formatServiceLogTail(contents: Buffer, truncated: boolean): string {
  let content = contents.toString("utf8");
  if (truncated) {
    const firstNewline = content.indexOf("\n");
    if (firstNewline >= 0) content = content.slice(firstNewline + 1);
  }
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-SERVICE_LOG_TAIL_LINES).join("\n").trim();
}

async function readWindowsLogTail(
  deps: Pick<ServiceDependencies, "run">,
  logPath: string,
): Promise<string> {
  const [snapshot] = await readWindowsSafeFiles(deps, [logPath], SERVICE_LOG_TAIL_BYTES, true);
  if (!snapshot || snapshot.contents === null) return "No service logs yet.";
  return formatServiceLogTail(snapshot.contents, snapshot.truncated);
}

export async function readLogTail(logPath: string): Promise<string> {
  let handle: number | undefined;
  try {
    const linkStat = fs.lstatSync(logPath);
    if (!linkStat.isFile() || linkStat.isSymbolicLink()) {
      throw new Error(`Refusing to read a non-regular service log: ${logPath}`);
    }
    handle = fs.openSync(
      logPath,
      fs.constants.O_RDONLY |
        fs.constants.O_NONBLOCK |
        (process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0)),
    );
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) throw new Error(`Refusing to read a non-regular service log: ${logPath}`);
    const start = Math.max(0, stat.size - SERVICE_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(stat.size, SERVICE_LOG_TAIL_BYTES));
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, start);
    return formatServiceLogTail(buffer.subarray(0, bytesRead), start > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "No service logs yet.";
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

export function darwinActivationCommands(input: {
  readonly action: "start" | "restart";
  readonly domain: string;
  readonly target: string;
  readonly definitionPath: string;
}): readonly {
  readonly args: readonly string[];
  readonly ignoreFailure: boolean;
}[] {
  return [
    ...(input.action === "restart"
      ? [
          {
            args: ["bootout", input.domain, input.definitionPath],
            ignoreFailure: true,
          },
        ]
      : []),
    {
      args: ["bootstrap", input.domain, input.definitionPath],
      ignoreFailure: true,
    },
    { args: ["enable", input.target], ignoreFailure: false },
    {
      args: ["kickstart", ...(input.action === "restart" ? ["-k"] : []), input.target],
      ignoreFailure: false,
    },
  ];
}

export function darwinServiceIsAlreadyRunning(
  action: "start" | "restart",
  isActive: boolean,
): boolean {
  return action === "start" && isActive;
}

export function launchctlPrintShowsActiveService(output: string): boolean {
  return /^\s*state\s*=\s*running\s*$/m.test(output) || /^\s*pid\s*=\s*[1-9]\d*\s*$/m.test(output);
}

async function darwinServiceIsActive(
  run: ServiceDependencies["run"],
  target: string,
): Promise<boolean> {
  try {
    const result = await run("launchctl", ["print", target]);
    return launchctlPrintShowsActiveService(result.stdout);
  } catch {
    return false;
  }
}

export async function controlService(
  action: ServiceAction,
  overrides: Partial<ServiceDependencies> = {},
): Promise<string> {
  const defaults = defaultDependencies();
  const deps = { ...defaults, ...overrides };
  const windowsMetadata =
    deps.platform === "win32" ? await validatedWindowsMetadataCandidates(deps) : undefined;
  const knownRecords = windowsMetadata?.records ?? readAllRecordedServiceLayouts(deps.platform);
  const layout =
    (windowsMetadata
      ? installedLayoutFromRecords(deps.platform, newestRecordedLayouts(knownRecords))
      : readInstalledServiceLayout(deps.platform)) ?? serviceLayout(deps.platform);
  const knownLayouts = uniqueServiceLayouts([
    ...knownRecords.map((record) => record.layout),
    layout,
  ]);
  for (const knownLayout of knownLayouts) validateServiceWritableTargets(knownLayout);
  if (deps.platform === "win32") {
    if (knownRecords.some((record) => record.layout.accountMode === "dedicated")) {
      const trustedLayout = await resolveWindowsRuntimeLayout(deps, serviceLayout("win32"));
      const trustedProgramFiles = path.win32.dirname(
        path.win32.dirname(serviceRuntimeRoot(trustedLayout)),
      );
      validateWindowsRecordedRuntimeRoots(knownRecords, trustedProgramFiles);
    }
  }
  const mutatesService = action !== "status" && action !== "logs";
  if (
    layout.accountMode === "dedicated" ||
    (mutatesService && knownLayouts.some((candidate) => candidate.accountMode === "dedicated"))
  ) {
    requireAdministrator(deps.platform);
  }
  if (windowsMetadata && mutatesService) {
    await hardenWindowsLegacyMetadata(deps, layout, windowsMetadata);
  }

  if (action === "logs") {
    if (layout.accountMode === "current" && isSudoInvocation()) {
      throw new Error("Refusing to read current-account service logs through sudo");
    }
    if (layout.platform === "win32") return await readWindowsLogTail(deps, layout.logPath);
    return await readLogTail(layout.logPath);
  }

  if (deps.platform === "linux") {
    if (action === "uninstall") {
      for (const candidate of knownLayouts) {
        await ignoreMissingService(
          linuxSystemctl(deps, candidate, ["disable", "--now", candidate.serviceId]),
        );
        await removeServiceDefinition(deps, candidate);
        await linuxSystemctl(deps, candidate, ["daemon-reload"]);
      }
      for (const record of knownRecords) {
        fs.rmSync(record.metadataPath, { force: true });
      }
      removeExactMetadataPointers(deps.platform);
      return "Removed the systemd service. ShioriCode data and the service account were preserved.";
    }
    if (action === "status") {
      const result = await linuxSystemctl(deps, layout, [
        "show",
        layout.serviceId,
        "--no-pager",
        "--property=LoadState,UnitFileState,ActiveState,SubState,MainPID,ExecMainStatus",
      ]);
      return result.stdout.trim();
    }
    for (const candidate of knownLayouts) {
      if (action === "stop" || serviceLayoutIdentity(candidate) !== serviceLayoutIdentity(layout)) {
        await ignoreMissingService(
          linuxSystemctl(deps, candidate, [
            ...(action === "stop" ? [] : ["disable"]),
            ...(action === "stop" ? ["stop"] : ["--now"]),
            candidate.serviceId,
          ]),
        );
      }
    }
    if (action === "stop") return "Service stop complete.";
    const result = await linuxSystemctl(deps, layout, [action, layout.serviceId]);
    return result.stdout.trim() || `Service ${action} complete.`;
  }

  if (deps.platform === "darwin") {
    const domain = await darwinServiceDomain(deps, layout);
    const target = `${domain}/${layout.serviceId}`;
    if (action === "uninstall") {
      for (const candidate of knownLayouts) {
        await stopServiceLayout(deps, candidate);
        await removeServiceDefinition(deps, candidate);
      }
      for (const record of knownRecords) {
        fs.rmSync(record.metadataPath, { force: true });
      }
      removeExactMetadataPointers(deps.platform);
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
      for (const candidate of knownLayouts) await stopServiceLayout(deps, candidate);
      return "Service stop complete.";
    }
    if (action === "start" || action === "restart") {
      for (const candidate of knownLayouts) {
        if (serviceLayoutIdentity(candidate) !== serviceLayoutIdentity(layout)) {
          await stopServiceLayout(deps, candidate);
        }
      }
      const isActive = action === "start" && (await darwinServiceIsActive(deps.run, target));
      if (darwinServiceIsAlreadyRunning(action, isActive)) {
        return "Service is already running.";
      }
      for (const command of darwinActivationCommands({
        action,
        domain,
        target,
        definitionPath: layout.definitionPath,
      })) {
        const running = deps.run("launchctl", command.args);
        if (command.ignoreFailure) await running.catch(() => {});
        else await running;
      }
    }
    return `Service ${action} complete.`;
  }

  if (action === "uninstall") {
    const preservedLegacyDefinitions: string[] = [];
    for (const candidate of knownLayouts) {
      await stopWindowsServiceProcesses(deps, candidate);
      await ignoreMissingService(
        deps.run("schtasks.exe", ["/Delete", "/TN", serviceManagerId(candidate), "/F"]),
      );
      if (!(await removeServiceDefinition(deps, candidate))) {
        preservedLegacyDefinitions.push(candidate.definitionPath);
      }
    }
    for (const record of knownRecords) {
      fs.rmSync(record.metadataPath, { force: true });
    }
    removeExactMetadataPointers(deps.platform);
    return `Removed the Windows background task. ShioriCode data and the service account were preserved.${
      preservedLegacyDefinitions.length > 0
        ? ` Legacy definitions were left for manual administrator cleanup: ${preservedLegacyDefinitions.join(", ")}.`
        : ""
    }`;
  }
  if (action === "status") {
    return (
      await deps.run("schtasks.exe", [
        "/Query",
        "/TN",
        serviceManagerId(layout),
        "/V",
        "/FO",
        "LIST",
      ])
    ).stdout.trim();
  }
  if (action === "stop") {
    for (const candidate of knownLayouts) await stopWindowsServiceProcesses(deps, candidate);
  }
  if (action === "start") {
    for (const candidate of knownLayouts) {
      if (serviceLayoutIdentity(candidate) !== serviceLayoutIdentity(layout)) {
        await stopWindowsServiceProcesses(deps, candidate);
      }
    }
    await deps.run("schtasks.exe", ["/Run", "/TN", serviceManagerId(layout)]);
  }
  if (action === "restart") {
    for (const candidate of knownLayouts) await stopWindowsServiceProcesses(deps, candidate);
    await deps.run("schtasks.exe", ["/Run", "/TN", serviceManagerId(layout)]);
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

export async function findInstalledServiceLayout(
  overrides: Partial<Pick<ServiceDependencies, "platform" | "run">> = {},
): Promise<ServiceLayout | null> {
  const platform = overrides.platform ?? currentServicePlatform();
  if (platform !== "win32") return readInstalledServiceLayout(platform);
  const metadata = await validatedWindowsMetadataCandidates({
    run: overrides.run ?? runDefault,
  });
  return installedLayoutFromRecords(platform, newestRecordedLayouts(metadata.records));
}

export async function installedServiceLayout(): Promise<ServiceLayout> {
  const layout = await findInstalledServiceLayout();
  if (!layout) {
    throw new Error(
      "The ShioriCode service is not installed. Run `shioricode service install` first.",
    );
  }
  return layout;
}

export function linkServiceStateDir(layout: ServiceLayout): string {
  return path.join(layout.stateDir, "userdata");
}
