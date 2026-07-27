import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { type FrpcProcessController, FrpcProcessOwnership } from "./frpcProcessOwnership";
import type { LinkConnectorCredential } from "./linkStore";

const FRP_VERSION = "0.69.0";
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

interface FrpAsset {
  readonly archiveName: string;
  readonly archiveRoot: string;
  readonly sha256: string;
  readonly executableName: string;
  readonly kind: "tar.gz" | "zip";
}

export interface FrpExtractionCommand {
  readonly file: string;
  readonly args: readonly string[];
}

const FRP_ASSETS: Readonly<Record<string, FrpAsset>> = {
  "darwin-arm64": {
    archiveName: `frp_${FRP_VERSION}_darwin_arm64.tar.gz`,
    archiveRoot: `frp_${FRP_VERSION}_darwin_arm64`,
    sha256: "07663f5fa71330f074b25e32cc8bc4ae5ed40d9c2ee1690cbd981774475997a2",
    executableName: "frpc",
    kind: "tar.gz",
  },
  "darwin-x64": {
    archiveName: `frp_${FRP_VERSION}_darwin_amd64.tar.gz`,
    archiveRoot: `frp_${FRP_VERSION}_darwin_amd64`,
    sha256: "3bb1df7aa716a80ddd0b0f108b4e6487bc1e9dae60b22bb67fff6c890bfcc182",
    executableName: "frpc",
    kind: "tar.gz",
  },
  "linux-x64": {
    archiveName: `frp_${FRP_VERSION}_linux_amd64.tar.gz`,
    archiveRoot: `frp_${FRP_VERSION}_linux_amd64`,
    sha256: "6b90d1cd28fc661f170c0de90dde03d2c63e4fd7ce0ae2da2ca1c28014b8146e",
    executableName: "frpc",
    kind: "tar.gz",
  },
  "win32-x64": {
    archiveName: `frp_${FRP_VERSION}_windows_amd64.zip`,
    archiveRoot: `frp_${FRP_VERSION}_windows_amd64`,
    sha256: "0e38f6dbe7761d648ca5c6ee323b7309544f48c01e9476f553902f3bc0949089",
    executableName: "frpc.exe",
    kind: "zip",
  },
};

function execFileAsync(file: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function connectorCleanupFailure(
  message: string,
  cause: unknown,
  cleanupErrors: readonly unknown[],
): AggregateError {
  return new AggregateError([cause, ...cleanupErrors], message, { cause });
}

export function resolveFrpAsset(platform = process.platform, arch = process.arch): FrpAsset {
  const asset = FRP_ASSETS[`${platform}-${arch}`];
  if (!asset) {
    throw new Error(`ShioriCode Link is not available for ${platform}/${arch} yet`);
  }
  return asset;
}

export function buildFrpExtractionCommand(
  kind: FrpAsset["kind"],
  archivePath: string,
  extractPath: string,
): FrpExtractionCommand {
  return {
    file: "tar",
    args: [kind === "tar.gz" ? "-xzf" : "-xf", archivePath, "-C", extractPath],
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function renderFrpcConfig(input: {
  readonly credential: LinkConnectorCredential;
  readonly localPort: number;
}): string {
  const { credential } = input;
  return [
    `serverAddr = ${tomlString(credential.serverAddr)}`,
    `serverPort = ${credential.serverPort}`,
    `user = ${tomlString(credential.environmentId)}`,
    "loginFailExit = false",
    'transport.protocol = "tcp"',
    `transport.tls.enable = ${credential.serverTls}`,
    "transport.heartbeatInterval = 15",
    "transport.heartbeatTimeout = 45",
    'auth.additionalScopes = ["HeartBeats", "NewWorkConns"]',
    'log.to = "console"',
    'log.level = "warn"',
    `metadatas.environment_id = ${tomlString(credential.environmentId)}`,
    `metadatas.connector_token = ${tomlString(credential.token)}`,
    "",
    "[[proxies]]",
    'name = "shioricode"',
    'type = "http"',
    'localIP = "127.0.0.1"',
    `localPort = ${input.localPort}`,
    'subdomain = "link"',
    "transport.useEncryption = false",
    "transport.useCompression = false",
    "",
  ].join("\n");
}

export class FrpcConnector {
  readonly #directory: string;
  readonly #binaryPath: string;
  readonly #verifiedPath: string;
  readonly #localPort: number;
  readonly #platform: NodeJS.Platform;
  readonly #arch: NodeJS.Architecture;
  readonly #spawnProcess: typeof spawn;
  readonly #ownership: FrpcProcessOwnership;
  #credential: LinkConnectorCredential | null = null;
  #process: ChildProcess | null = null;
  #processStarted = false;
  #desired = false;
  #restartTimer: NodeJS.Timeout | null = null;
  #lastError: string | null = null;

  constructor(input: {
    readonly stateDir: string;
    readonly localPort: number;
    readonly platform?: NodeJS.Platform;
    readonly arch?: NodeJS.Architecture;
    readonly spawnProcess?: typeof spawn;
    readonly processController?: FrpcProcessController;
  }) {
    this.#platform = input.platform ?? process.platform;
    this.#arch = input.arch ?? process.arch;
    this.#spawnProcess = input.spawnProcess ?? spawn;
    this.#directory = path.join(input.stateDir, "link", `frp-v${FRP_VERSION}`);
    this.#binaryPath = path.join(this.#directory, this.#platform === "win32" ? "frpc.exe" : "frpc");
    this.#verifiedPath = `${this.#binaryPath}.verified`;
    this.#localPort = input.localPort;
    this.#ownership = new FrpcProcessOwnership({
      stateDir: input.stateDir,
      binaryPath: this.#binaryPath,
      platform: this.#platform,
      ...(input.processController ? { controller: input.processController } : {}),
    });
  }

  get installed(): boolean {
    try {
      const asset = resolveFrpAsset(this.#platform, this.#arch);
      return (
        fs.statSync(this.#binaryPath).isFile() &&
        fs.readFileSync(this.#verifiedPath, "utf8").trim() === asset.sha256
      );
    } catch {
      return false;
    }
  }

  get running(): boolean {
    return (
      this.#process !== null &&
      this.#processStarted &&
      this.#process.exitCode === null &&
      this.#process.signalCode === null
    );
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  /** A prior launch may still be reachable even when this process has no child handle. */
  get cleanupRequired(): boolean {
    return this.#ownership.cleanupRequired;
  }

  async #download(): Promise<void> {
    const asset = resolveFrpAsset(this.#platform, this.#arch);
    fs.mkdirSync(this.#directory, { recursive: true });
    const response = await fetch(
      `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${asset.archiveName}`,
      { signal: AbortSignal.timeout(60_000) },
    );
    if (!response.ok) throw new Error(`Could not download the Link connector (${response.status})`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_DOWNLOAD_BYTES) {
      throw new Error("Link connector download is unexpectedly large");
    }
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error("Link connector download is unexpectedly large");
    }
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== asset.sha256) {
      throw new Error("Link connector checksum verification failed");
    }

    const archivePath = path.join(this.#directory, `${asset.archiveName}.${randomUUID()}.download`);
    const extractPath = path.join(this.#directory, `extract-${randomUUID()}`);
    fs.writeFileSync(archivePath, archive, { mode: 0o600 });
    fs.mkdirSync(extractPath, { mode: 0o700 });
    try {
      const extraction = buildFrpExtractionCommand(asset.kind, archivePath, extractPath);
      await execFileAsync(extraction.file, extraction.args);
      const extractedBinary = path.join(extractPath, asset.archiveRoot, asset.executableName);
      if (!fs.statSync(extractedBinary).isFile()) {
        throw new Error("Link connector archive did not contain frpc");
      }
      fs.copyFileSync(extractedBinary, this.#binaryPath);
      if (process.platform !== "win32") fs.chmodSync(this.#binaryPath, 0o700);
      fs.writeFileSync(this.#verifiedPath, `${asset.sha256}\n`, { mode: 0o600 });
    } finally {
      fs.rmSync(archivePath, { force: true });
      fs.rmSync(extractPath, { recursive: true, force: true });
    }
  }

  async ensureInstalled(): Promise<void> {
    if (!this.installed) await this.#download();
  }

  async #spawn(): Promise<void> {
    if (!this.#desired || this.#process !== null || !this.#credential) return;
    await this.#ownership.terminate();
    if (!this.#desired || this.#process !== null || !this.#credential) return;
    const launch = this.#ownership.prepare(
      renderFrpcConfig({ credential: this.#credential, localPort: this.#localPort }),
    );
    let child: ChildProcess;
    try {
      child = this.#spawnProcess(this.#binaryPath, ["-c", launch.configPath], {
        detached: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      this.#ownership.markExited(launch);
      throw error;
    }
    this.#process = child;
    this.#processStarted = false;
    child.stderr?.setEncoding("utf8");
    child.once("error", (error) => {
      if (this.#process !== child) return;
      this.#lastError = `Link connector process error: ${error.message}`;
      // ChildProcess can emit `error` after a successful spawn (for example,
      // when a later signal operation fails). An error event is not proof that
      // the OS process exited, so retain ownership until an exit is observed.
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
        this.#process = null;
        this.#processStarted = false;
        try {
          this.#ownership.markExited(launch);
        } catch (cleanupError) {
          this.#lastError =
            cleanupError instanceof Error ? cleanupError.message : "Link connector cleanup failed";
        }
        if (this.#desired) this.#scheduleRestart();
      }
    });
    child.once("exit", (code, signal) => {
      if (this.#process !== child) return;
      this.#process = null;
      this.#processStarted = false;
      try {
        this.#ownership.markExited(launch);
      } catch (error) {
        this.#lastError =
          error instanceof Error ? error.message : "Link connector ownership cleanup failed";
      }
      if (this.#desired) {
        this.#lastError = `Link connector exited (${signal ?? code ?? "unknown"})`;
        this.#scheduleRestart();
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout | null = null;
        const onSpawn = () => {
          void this.#ownership
            .register(launch, child.pid ?? 0)
            .then((registered) => {
              if (this.#process !== child || child.exitCode !== null) {
                throw new Error("Link connector exited during startup");
              }
              void registered;
              this.#processStarted = true;
              timer = setTimeout(() => {
                cleanup();
                if (this.#process === child && this.#processStarted && child.exitCode === null) {
                  resolve();
                } else {
                  reject(new Error("Link connector exited during startup"));
                }
              }, 750);
            })
            .catch((error: unknown) => {
              cleanup();
              reject(error);
            });
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          child.off("spawn", onSpawn);
          child.off("error", onError);
          child.off("exit", onExit);
        };
        const onExit = () => {
          cleanup();
          reject(new Error("Link connector exited during startup"));
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
        child.once("exit", onExit);
      });
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        await this.#terminateChildHandle(child);
      } catch (caught) {
        cleanupErrors.push(caught);
      }
      // A pending pid-less record may not find a just-materializing process.
      // Only let ownership cleanup remove it after the trusted ChildProcess
      // handle has positively observed exit.
      if (cleanupErrors.length === 0) {
        if (this.#process === child) {
          this.#process = null;
          this.#processStarted = false;
        }
        try {
          await this.#ownership.terminate();
        } catch (caught) {
          cleanupErrors.push(caught);
        }
      }
      if (this.#desired && cleanupErrors.length === 0) this.#scheduleRestart();
      if (cleanupErrors.length > 0) {
        throw connectorCleanupFailure(
          "Link connector startup failed and its process could not be confirmed stopped",
          error,
          cleanupErrors,
        );
      }
      throw error;
    }
    this.#lastError = null;
  }

  #scheduleRestart(): void {
    if (this.#restartTimer || !this.#desired) return;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.#spawn().catch((error: unknown) => {
        this.#lastError = error instanceof Error ? error.message : "Link connector failed";
        this.#scheduleRestart();
      });
    }, 5_000);
    this.#restartTimer.unref();
  }

  #childExited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
  }

  async #waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (this.#childExited(child)) return true;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(this.#childExited(child));
      }, timeoutMs);
      const onExit = () => {
        cleanup();
        resolve(true);
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.off("exit", onExit);
      };
      child.once("exit", onExit);
    });
  }

  async #terminateChildHandle(child: ChildProcess): Promise<void> {
    if (this.#childExited(child)) return;
    try {
      child.kill("SIGTERM");
    } catch (error) {
      if (!this.#childExited(child)) throw error;
    }
    if (await this.#waitForChildExit(child, 3_000)) return;
    try {
      child.kill("SIGKILL");
    } catch (error) {
      if (!this.#childExited(child)) throw error;
    }
    if (!(await this.#waitForChildExit(child, 2_000))) {
      throw new Error(
        "The Link connector child is still running after shutdown; authentication remains required",
      );
    }
  }

  async start(credential: LinkConnectorCredential): Promise<void> {
    this.#credential = credential;
    this.#desired = true;
    try {
      // Reconcile an orphan before downloads or a replacement launch. This is
      // deliberately independent of the in-memory ChildProcess handle.
      await this.#ownership.terminate();
      await this.ensureInstalled();
      await this.#spawn();
    } catch (error) {
      let cleanupError: unknown = null;
      try {
        await this.stop();
      } catch (caught) {
        cleanupError = caught;
      }
      if (cleanupError) {
        throw connectorCleanupFailure(
          "Link connector failed to start and could not be confirmed stopped",
          error,
          [cleanupError],
        );
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#desired = false;
    this.#credential = null;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    const child = this.#process;
    if (child) {
      await this.#terminateChildHandle(child);
      if (this.#process === child) {
        this.#process = null;
        this.#processStarted = false;
      }
    }
    await this.#ownership.terminate();
    this.#process = null;
    this.#processStarted = false;
  }
}
