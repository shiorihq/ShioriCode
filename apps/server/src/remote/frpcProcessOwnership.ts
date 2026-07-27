import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OWNERSHIP_VERSION = 1;
const MAX_OWNERSHIP_BYTES = 8 * 1024;
const TERM_POLL_ATTEMPTS = 30;
const KILL_POLL_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 100;
const IDENTITY_POLL_ATTEMPTS = 10;
const IDENTITY_POLL_INTERVAL_MS = 50;

export interface FrpcProcessSnapshot {
  readonly pid: number;
  readonly birthIdentity: string;
  readonly executablePath: string | null;
  readonly argv: readonly string[] | null;
  readonly commandLine: string | null;
}

export interface FrpcProcessController {
  inspect(pid: number): Promise<FrpcProcessSnapshot | null>;
  findConfigCandidates(configPath: string): Promise<readonly FrpcProcessSnapshot[]>;
  signal(pid: number, signal: NodeJS.Signals): void;
  wait(milliseconds: number): Promise<void>;
}

export interface FrpcLaunchOwnership {
  readonly launchId: string;
  readonly binaryPath: string;
  readonly configPath: string;
  readonly pid: number | null;
  readonly birthIdentity: string | null;
}

interface PersistedOwnership extends FrpcLaunchOwnership {
  readonly version: typeof OWNERSHIP_VERSION;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function execFileOutput(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: "utf8", windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function normalizeExecutable(value: string, platform: NodeJS.Platform): string {
  const normalized = path.normalize(value.replace(/ \(deleted\)$/, ""));
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathsEqual(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isManagedBinaryPath(
  value: unknown,
  directory: string,
  platform: NodeJS.Platform,
): value is string {
  if (typeof value !== "string" || !path.isAbsolute(value)) return false;
  const versionDirectory = path.dirname(value);
  const executableName = platform === "win32" ? "frpc.exe" : "frpc";
  return (
    pathsEqual(path.dirname(versionDirectory), directory, platform) &&
    /^frp-v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(path.basename(versionDirectory)) &&
    (platform === "win32"
      ? path.basename(value).toLowerCase() === executableName
      : path.basename(value) === executableName)
  );
}

function commandBinary(commandLine: string, configPath: string): string | null {
  const command = commandLine.trim();
  for (const suffix of [` -c ${configPath}`, ` -c "${configPath}"`]) {
    if (!command.endsWith(suffix)) continue;
    const prefix = command.slice(0, -suffix.length);
    if (prefix.startsWith('"') || prefix.endsWith('"')) {
      return prefix.startsWith('"') && prefix.endsWith('"') && prefix.length > 2
        ? prefix.slice(1, -1)
        : null;
    }
    return prefix || null;
  }
  return null;
}

function managedBinaryFromSnapshot(
  snapshot: FrpcProcessSnapshot,
  configPath: string,
  directory: string,
  platform: NodeJS.Platform,
): string | null {
  let binaryPath: string | null = null;
  if (snapshot.argv) {
    if (
      snapshot.argv.length !== 3 ||
      snapshot.argv[1] !== "-c" ||
      !pathsEqual(snapshot.argv[2] ?? "", configPath, platform)
    ) {
      return null;
    }
    binaryPath = snapshot.argv[0] ?? null;
  } else if (snapshot.commandLine) {
    binaryPath = commandBinary(snapshot.commandLine, configPath);
  }
  if (!isManagedBinaryPath(binaryPath, directory, platform)) return null;
  if (
    snapshot.executablePath !== null &&
    normalizeExecutable(snapshot.executablePath, platform) !==
      normalizeExecutable(binaryPath, platform)
  ) {
    return null;
  }
  return binaryPath;
}

function commandLineMatches(
  commandLine: string,
  binaryPath: string,
  configPath: string,
  platform: NodeJS.Platform,
): boolean {
  const normalized = platform === "win32" ? commandLine.trim().toLowerCase() : commandLine.trim();
  const binary = platform === "win32" ? binaryPath.toLowerCase() : binaryPath;
  const config = platform === "win32" ? configPath.toLowerCase() : configPath;
  return [
    `${binary} -c ${config}`,
    `"${binary}" -c "${config}"`,
    `"${binary}" -c ${config}`,
    `${binary} -c "${config}"`,
  ].includes(normalized);
}

function snapshotMatchesLaunch(
  snapshot: FrpcProcessSnapshot,
  launch: FrpcLaunchOwnership,
  platform: NodeJS.Platform,
): boolean {
  if (snapshot.argv) {
    if (
      snapshot.argv.length !== 3 ||
      snapshot.argv[1] !== "-c" ||
      path.normalize(snapshot.argv[2] ?? "") !== path.normalize(launch.configPath)
    ) {
      return false;
    }
    const argvExecutable = normalizeExecutable(snapshot.argv[0] ?? "", platform);
    if (argvExecutable !== normalizeExecutable(launch.binaryPath, platform)) return false;
  } else if (
    !snapshot.commandLine ||
    !commandLineMatches(snapshot.commandLine, launch.binaryPath, launch.configPath, platform)
  ) {
    return false;
  }

  return (
    snapshot.executablePath === null ||
    normalizeExecutable(snapshot.executablePath, platform) ===
      normalizeExecutable(launch.binaryPath, platform)
  );
}

function parseLinuxStartTime(stat: string): string {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) throw new Error("Could not validate the Link connector process identity");
  const fieldsAfterCommand = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const startTime = fieldsAfterCommand[19];
  if (!startTime || !/^\d+$/.test(startTime)) {
    throw new Error("Could not validate the Link connector process identity");
  }
  return startTime;
}

class DefaultFrpcProcessController implements FrpcProcessController {
  readonly #platform: NodeJS.Platform;
  #linuxBootId: string | null = null;

  constructor(platform: NodeJS.Platform) {
    this.#platform = platform;
  }

  async #inspectLinux(pid: number): Promise<FrpcProcessSnapshot | null> {
    const processDirectory = `/proc/${pid}`;
    try {
      const [stat, command, executablePath] = await Promise.all([
        fs.promises.readFile(path.join(processDirectory, "stat"), "utf8"),
        fs.promises.readFile(path.join(processDirectory, "cmdline")),
        fs.promises.readlink(path.join(processDirectory, "exe")),
      ]);
      this.#linuxBootId ??= (await fs.promises.readFile("/proc/sys/kernel/random/boot_id", "utf8"))
        .trim()
        .toLowerCase();
      const argv = command.toString("utf8").split("\0");
      if (argv.at(-1) === "") argv.pop();
      return {
        pid,
        birthIdentity: `linux:${this.#linuxBootId}:${parseLinuxStartTime(stat)}`,
        executablePath,
        argv,
        commandLine: null,
      };
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ESRCH")) return null;
      throw error;
    }
  }

  async #inspectDarwin(pid: number): Promise<FrpcProcessSnapshot | null> {
    try {
      const [birth, commandLine] = await Promise.all([
        execFileOutput("/bin/ps", ["-ww", "-p", String(pid), "-o", "lstart="]),
        execFileOutput("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="]),
      ]);
      const birthIdentity = birth.trim();
      if (!birthIdentity) return null;
      return {
        pid,
        birthIdentity: `darwin:${birthIdentity}`,
        // Darwin's `comm` column is truncated even with `-ww`. The exact,
        // wide argv rendering below plus PID birth time is the reliable
        // identity boundary on this platform.
        executablePath: null,
        argv: null,
        commandLine: commandLine.trim() || null,
      };
    } catch (error) {
      const exitCode =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : null;
      if (exitCode === 1 || isErrno(error, "ESRCH")) return null;
      throw error;
    }
  }

  async #readWindowsProcesses(): Promise<readonly FrpcProcessSnapshot[]> {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$result = @(Get-CimInstance Win32_Process | ForEach-Object {",
      "  [pscustomobject]@{",
      "    pid = [int]$_.ProcessId",
      "    birthIdentity = [string]$_.CreationDate",
      "    executablePath = [string]$_.ExecutablePath",
      "    commandLine = [string]$_.CommandLine",
      "  }",
      "})",
      "ConvertTo-Json -InputObject $result -Compress",
    ].join("\n");
    const output = await execFileOutput("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    const parsed = JSON.parse(output) as unknown;
    const entries = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    const snapshots: FrpcProcessSnapshot[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const value = entry as Record<string, unknown>;
      if (
        !Number.isInteger(value.pid) ||
        (value.pid as number) <= 0 ||
        typeof value.birthIdentity !== "string" ||
        value.birthIdentity.length === 0
      ) {
        continue;
      }
      snapshots.push({
        pid: value.pid as number,
        birthIdentity: `win32:${value.birthIdentity}`,
        executablePath:
          typeof value.executablePath === "string" && value.executablePath.length > 0
            ? value.executablePath
            : null,
        argv: null,
        commandLine:
          typeof value.commandLine === "string" && value.commandLine.length > 0
            ? value.commandLine
            : null,
      });
    }
    return snapshots;
  }

  async inspect(pid: number): Promise<FrpcProcessSnapshot | null> {
    if (this.#platform === "linux") return await this.#inspectLinux(pid);
    if (this.#platform === "darwin") return await this.#inspectDarwin(pid);
    if (this.#platform === "win32") {
      return (await this.#readWindowsProcesses()).find((snapshot) => snapshot.pid === pid) ?? null;
    }
    throw new Error(`Cannot validate Link connector processes on ${this.#platform}`);
  }

  async findConfigCandidates(configPath: string): Promise<readonly FrpcProcessSnapshot[]> {
    if (this.#platform === "linux") {
      const entries = await fs.promises.readdir("/proc", { withFileTypes: true });
      const snapshots = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
          .map(async (entry) => {
            const pid = Number(entry.name);
            let argv: string[];
            try {
              const command = await fs.promises.readFile(`/proc/${pid}/cmdline`);
              argv = command.toString("utf8").split("\0");
              if (argv.at(-1) === "") argv.pop();
            } catch (error) {
              // Scanning /proc commonly crosses short-lived or inaccessible
              // unrelated processes. Direct inspection of a recorded PID does
              // not use this exception and remains fail-closed.
              if (
                isErrno(error, "ENOENT") ||
                isErrno(error, "ESRCH") ||
                isErrno(error, "EACCES") ||
                isErrno(error, "EPERM")
              ) {
                return null;
              }
              throw error;
            }
            if (
              argv.length !== 3 ||
              argv[1] !== "-c" ||
              path.normalize(argv[2] ?? "") !== path.normalize(configPath)
            ) {
              return null;
            }
            // Once argv matches our private config path, any inability to read
            // the executable or birth marker is ownership uncertainty and
            // must propagate instead of being discarded as an unrelated PID.
            return await this.#inspectLinux(pid);
          }),
      );
      return snapshots.filter((snapshot): snapshot is FrpcProcessSnapshot => snapshot !== null);
    }
    if (this.#platform === "darwin") {
      const output = await execFileOutput("/bin/ps", ["-ww", "-axo", "pid=,command="]);
      const candidates = output
        .split("\n")
        .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
        .filter(
          (match): match is RegExpExecArray =>
            match !== null && match[2] !== undefined && match[2].includes(configPath),
        )
        .map((match) => Number(match[1]));
      const snapshots = await Promise.all(
        candidates.map(async (pid) => await this.#inspectDarwin(pid)),
      );
      return snapshots.filter((snapshot): snapshot is FrpcProcessSnapshot => snapshot !== null);
    }
    if (this.#platform === "win32") {
      const config = configPath.toLowerCase();
      return (await this.#readWindowsProcesses()).filter((snapshot) =>
        Boolean(snapshot.commandLine?.toLowerCase().includes(config)),
      );
    }
    throw new Error(`Cannot validate Link connector processes on ${this.#platform}`);
  }

  signal(pid: number, signal: NodeJS.Signals): void {
    process.kill(pid, signal);
  }

  async wait(milliseconds: number): Promise<void> {
    await wait(milliseconds);
  }
}

function ensurePrivateDirectory(directory: string, platform: NodeJS.Platform): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("The Link connector state directory is not a private directory");
  }
  if (platform !== "win32") fs.chmodSync(directory, 0o700);
}

function fsyncDirectory(directory: string, platform: NodeJS.Platform): void {
  if (platform === "win32") return;
  const directoryHandle = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(directoryHandle);
  } finally {
    fs.closeSync(directoryHandle);
  }
}

function writePrivateFileAtomic(
  filePath: string,
  contents: string,
  platform: NodeJS.Platform,
  exclusive = false,
): void {
  const directory = path.dirname(filePath);
  ensurePrivateDirectory(directory, platform);
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let handle: number | null = null;
  try {
    handle = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(handle, contents, "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    if (exclusive) {
      fs.linkSync(temporaryPath, filePath);
      fs.unlinkSync(temporaryPath);
    } else {
      fs.renameSync(temporaryPath, filePath);
    }
    if (platform !== "win32") fs.chmodSync(filePath, 0o600);
    fsyncDirectory(directory, platform);
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        // Preserve the write/fsync error; the private temp is removed below.
      }
    }
    fs.rmSync(temporaryPath, { force: true });
  }
}

function parseOwnership(
  raw: string,
  directory: string,
  platform: NodeJS.Platform,
): PersistedOwnership {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The Link connector ownership record is malformed");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("The Link connector ownership record is malformed");
  }
  const value = parsed as Record<string, unknown>;
  const launchId = value.launchId;
  const pid = value.pid;
  const birthIdentity = value.birthIdentity;
  if (
    value.version !== OWNERSHIP_VERSION ||
    typeof launchId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(launchId) ||
    !isManagedBinaryPath(value.binaryPath, directory, platform) ||
    value.configPath !== path.join(directory, `frpc-${launchId}.toml`) ||
    !(
      (pid === null && birthIdentity === null) ||
      (Number.isInteger(pid) &&
        (pid as number) > 0 &&
        typeof birthIdentity === "string" &&
        birthIdentity.length > 0 &&
        birthIdentity.length <= 512)
    )
  ) {
    throw new Error("The Link connector ownership record is invalid");
  }
  return {
    version: OWNERSHIP_VERSION,
    launchId,
    binaryPath: value.binaryPath,
    configPath: value.configPath as string,
    pid: pid as number | null,
    birthIdentity: birthIdentity as string | null,
  };
}

export class FrpcProcessOwnership {
  readonly #directory: string;
  readonly #ownershipPath: string;
  readonly #binaryPath: string;
  readonly #platform: NodeJS.Platform;
  readonly #controller: FrpcProcessController;

  constructor(input: {
    readonly stateDir: string;
    readonly binaryPath: string;
    readonly platform: NodeJS.Platform;
    readonly controller?: FrpcProcessController;
  }) {
    this.#directory = path.join(input.stateDir, "link");
    this.#ownershipPath = path.join(this.#directory, "frpc-process.json");
    this.#binaryPath = input.binaryPath;
    this.#platform = input.platform;
    this.#controller = input.controller ?? new DefaultFrpcProcessController(input.platform);
  }

  get cleanupRequired(): boolean {
    try {
      fs.lstatSync(this.#ownershipPath);
      return true;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) return true;
    }
    try {
      return fs.readdirSync(this.#directory).some((entry) => this.#isConnectorConfig(entry));
    } catch (error) {
      return !isErrno(error, "ENOENT");
    }
  }

  get metadataPath(): string {
    return this.#ownershipPath;
  }

  #read(): PersistedOwnership | null {
    let handle: number;
    try {
      handle = fs.openSync(
        this.#ownershipPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | fs.constants.O_NONBLOCK,
      );
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      if (isErrno(error, "ELOOP")) {
        throw new Error("The Link connector ownership record is not a trusted private file", {
          cause: error,
        });
      }
      throw error;
    }
    try {
      const stat = fs.fstatSync(handle);
      if (
        !stat.isFile() ||
        stat.size <= 0 ||
        stat.size > MAX_OWNERSHIP_BYTES ||
        (this.#platform !== "win32" && (stat.mode & 0o077) !== 0) ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      ) {
        throw new Error("The Link connector ownership record is not a trusted private file");
      }
      return parseOwnership(fs.readFileSync(handle, "utf8"), this.#directory, this.#platform);
    } finally {
      fs.closeSync(handle);
    }
  }

  #write(record: PersistedOwnership, exclusive = false): void {
    writePrivateFileAtomic(
      this.#ownershipPath,
      `${JSON.stringify(record)}\n`,
      this.#platform,
      exclusive,
    );
  }

  #removeIfCurrent(record: FrpcLaunchOwnership): void {
    const current = this.#read();
    if (current && current.launchId !== record.launchId) return;
    if (current) {
      fs.unlinkSync(this.#ownershipPath);
      fsyncDirectory(this.#directory, this.#platform);
    }
    fs.rmSync(record.configPath, { force: true });
  }

  #isConnectorConfig(entry: string): boolean {
    return entry === "frpc.toml" || /^frpc-[0-9A-Za-z-]+\.toml$/.test(entry);
  }

  #connectorConfigPaths(): readonly string[] {
    try {
      return fs
        .readdirSync(this.#directory)
        .filter((entry) => this.#isConnectorConfig(entry))
        .map((entry) => path.join(this.#directory, entry))
        .toSorted();
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
  }

  prepare(config: string): FrpcLaunchOwnership {
    if (this.#read()) {
      throw new Error("A previous Link connector process must be reconciled before launch");
    }
    ensurePrivateDirectory(this.#directory, this.#platform);
    if (this.#connectorConfigPaths().length > 0) {
      throw new Error("Previous Link connector configuration must be reconciled before launch");
    }
    const launchId = randomUUID();
    const record: PersistedOwnership = {
      version: OWNERSHIP_VERSION,
      launchId,
      binaryPath: this.#binaryPath,
      configPath: path.join(this.#directory, `frpc-${launchId}.toml`),
      pid: null,
      birthIdentity: null,
    };
    writePrivateFileAtomic(record.configPath, config, this.#platform);
    try {
      this.#write(record, true);
      return record;
    } catch (error) {
      fs.rmSync(record.configPath, { force: true });
      throw error;
    }
  }

  async register(launch: FrpcLaunchOwnership, pid: number): Promise<FrpcLaunchOwnership> {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error("The Link connector did not expose a valid process id");
    }
    let snapshot: FrpcProcessSnapshot | null = null;
    for (let attempt = 0; attempt < IDENTITY_POLL_ATTEMPTS; attempt++) {
      const observed = await this.#controller.inspect(pid);
      if (observed && snapshotMatchesLaunch(observed, launch, this.#platform)) {
        snapshot = observed;
        break;
      }
      await this.#controller.wait(IDENTITY_POLL_INTERVAL_MS);
    }
    if (!snapshot || !snapshotMatchesLaunch(snapshot, launch, this.#platform)) {
      throw new Error("Could not validate the Link connector process after launch");
    }
    const current = this.#read();
    if (!current || current.launchId !== launch.launchId) {
      throw new Error("The Link connector ownership record changed during launch");
    }
    const registered: PersistedOwnership = {
      ...current,
      pid,
      birthIdentity: snapshot.birthIdentity,
    };
    this.#write(registered);
    return registered;
  }

  markExited(launch: FrpcLaunchOwnership): void {
    this.#removeIfCurrent(launch);
  }

  async #findOwnedSnapshot(record: PersistedOwnership): Promise<FrpcProcessSnapshot | null> {
    if (record.pid !== null && record.birthIdentity !== null) {
      const recordedProcess = await this.#controller.inspect(record.pid);
      if (recordedProcess && recordedProcess.birthIdentity === record.birthIdentity) {
        if (snapshotMatchesLaunch(recordedProcess, record, this.#platform)) {
          return recordedProcess;
        }
        throw new Error(
          "The recorded Link connector process is alive but its command identity cannot be verified",
        );
      }
      const candidates = await this.#controller.findConfigCandidates(record.configPath);
      if (candidates.length > 0) {
        throw new Error(
          "The Link connector process identity changed; refusing to signal an unverified process",
        );
      }
      return null;
    }

    let candidates: readonly FrpcProcessSnapshot[] = [];
    for (let attempt = 0; attempt < IDENTITY_POLL_ATTEMPTS; attempt++) {
      candidates = await this.#controller.findConfigCandidates(record.configPath);
      if (candidates.length > 0) break;
      await this.#controller.wait(IDENTITY_POLL_INTERVAL_MS);
    }
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) {
      throw new Error("Multiple unverified Link connector processes match the pending launch");
    }
    const candidate = candidates[0];
    if (!candidate || !snapshotMatchesLaunch(candidate, record, this.#platform)) {
      throw new Error("Could not validate the pending Link connector process");
    }
    const registered: PersistedOwnership = {
      ...record,
      pid: candidate.pid,
      birthIdentity: candidate.birthIdentity,
    };
    this.#write(registered);
    return candidate;
  }

  async #stillOwned(record: FrpcLaunchOwnership, snapshot: FrpcProcessSnapshot): Promise<boolean> {
    const current = await this.#controller.inspect(snapshot.pid);
    if (current === null || current.birthIdentity !== snapshot.birthIdentity) return false;
    if (!snapshotMatchesLaunch(current, record, this.#platform)) {
      throw new Error(
        "The Link connector process identity changed during shutdown; refusing further signals",
      );
    }
    return true;
  }

  async #waitUntilGone(
    record: FrpcLaunchOwnership,
    snapshot: FrpcProcessSnapshot,
    attempts: number,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (!(await this.#stillOwned(record, snapshot))) return true;
      await this.#controller.wait(POLL_INTERVAL_MS);
    }
    return !(await this.#stillOwned(record, snapshot));
  }

  async #signalIfStillOwned(
    record: FrpcLaunchOwnership,
    snapshot: FrpcProcessSnapshot,
    signal: NodeJS.Signals,
  ): Promise<boolean> {
    if (!(await this.#stillOwned(record, snapshot))) return false;
    try {
      this.#controller.signal(snapshot.pid, signal);
      return true;
    } catch (error) {
      if (!(await this.#stillOwned(record, snapshot))) return false;
      throw error;
    }
  }

  async #terminateSnapshot(
    launch: FrpcLaunchOwnership,
    snapshot: FrpcProcessSnapshot,
  ): Promise<void> {
    await this.#signalIfStillOwned(launch, snapshot, "SIGTERM");
    if (await this.#waitUntilGone(launch, snapshot, TERM_POLL_ATTEMPTS)) return;
    await this.#signalIfStillOwned(launch, snapshot, "SIGKILL");
    if (!(await this.#waitUntilGone(launch, snapshot, KILL_POLL_ATTEMPTS))) {
      throw new Error(
        "The Link connector is still running after shutdown; authentication remains required",
      );
    }
  }

  async #findConfigCandidates(configPath: string): Promise<readonly FrpcProcessSnapshot[]> {
    for (let attempt = 0; attempt < IDENTITY_POLL_ATTEMPTS; attempt++) {
      const candidates = await this.#controller.findConfigCandidates(configPath);
      if (candidates.length > 0) return candidates;
      await this.#controller.wait(IDENTITY_POLL_INTERVAL_MS);
    }
    return [];
  }

  async #reconcileUnrecordedConfig(configPath: string): Promise<void> {
    // A legacy parent could have been killed between writing its fixed config
    // and materializing frpc. Re-scan empty results briefly before treating the
    // file as stale. Repeat after termination to catch a late materialization.
    for (let round = 0; round < 3; round++) {
      const candidates = await this.#findConfigCandidates(configPath);
      if (candidates.length === 0) {
        const current = this.#read();
        if (current) {
          throw new Error("Link connector ownership changed during legacy process cleanup");
        }
        try {
          fs.unlinkSync(configPath);
          fsyncDirectory(this.#directory, this.#platform);
        } catch (error) {
          if (!isErrno(error, "ENOENT")) throw error;
        }
        return;
      }
      const seen = new Set<string>();
      for (const candidate of candidates) {
        const identity = `${candidate.pid}:${candidate.birthIdentity}`;
        const binaryPath = managedBinaryFromSnapshot(
          candidate,
          configPath,
          this.#directory,
          this.#platform,
        );
        if (seen.has(identity) || !binaryPath) {
          throw new Error("Could not uniquely validate an unrecorded Link connector process");
        }
        seen.add(identity);
        const launch: FrpcLaunchOwnership = {
          launchId: `unrecorded:${path.basename(configPath)}`,
          binaryPath,
          configPath,
          pid: candidate.pid,
          birthIdentity: candidate.birthIdentity,
        };
        await this.#terminateSnapshot(launch, candidate);
      }
    }
    throw new Error(
      "An unrecorded Link connector kept reappearing during cleanup; authentication remains required",
    );
  }

  async terminate(): Promise<void> {
    const record = this.#read();
    if (record) {
      const snapshot = await this.#findOwnedSnapshot(record);
      if (snapshot) await this.#terminateSnapshot(record, snapshot);
      this.#removeIfCurrent(record);
    }
    for (const configPath of this.#connectorConfigPaths()) {
      await this.#reconcileUnrecordedConfig(configPath);
    }
  }
}
