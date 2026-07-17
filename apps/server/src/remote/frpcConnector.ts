import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

export function resolveFrpAsset(platform = process.platform, arch = process.arch): FrpAsset {
  const asset = FRP_ASSETS[`${platform}-${arch}`];
  if (!asset) {
    throw new Error(`ShioriCode Link is not available for ${platform}/${arch} yet`);
  }
  return asset;
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
  readonly #configPath: string;
  readonly #verifiedPath: string;
  readonly #localPort: number;
  #credential: LinkConnectorCredential | null = null;
  #process: ChildProcess | null = null;
  #desired = false;
  #restartTimer: NodeJS.Timeout | null = null;
  #lastError: string | null = null;

  constructor(input: { readonly stateDir: string; readonly localPort: number }) {
    const asset = resolveFrpAsset();
    this.#directory = path.join(input.stateDir, "link", `frp-v${FRP_VERSION}`);
    this.#binaryPath = path.join(this.#directory, asset.executableName);
    this.#configPath = path.join(input.stateDir, "link", "frpc.toml");
    this.#verifiedPath = `${this.#binaryPath}.verified`;
    this.#localPort = input.localPort;
  }

  get installed(): boolean {
    const asset = resolveFrpAsset();
    try {
      return (
        fs.statSync(this.#binaryPath).isFile() &&
        fs.readFileSync(this.#verifiedPath, "utf8").trim() === asset.sha256
      );
    } catch {
      return false;
    }
  }

  get running(): boolean {
    return this.#process !== null && this.#process.exitCode === null;
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  async #download(): Promise<void> {
    const asset = resolveFrpAsset();
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
      if (asset.kind === "tar.gz") {
        await execFileAsync("tar", ["-xzf", archivePath, "-C", extractPath]);
      } else {
        await execFileAsync("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
          archivePath,
          extractPath,
        ]);
      }
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

  #writeConfig(credential: LinkConnectorCredential): void {
    fs.mkdirSync(path.dirname(this.#configPath), { recursive: true });
    fs.writeFileSync(
      this.#configPath,
      renderFrpcConfig({ credential, localPort: this.#localPort }),
      { mode: 0o600 },
    );
    fs.chmodSync(this.#configPath, 0o600);
  }

  async #spawn(): Promise<void> {
    if (!this.#desired || this.running || !this.#credential) return;
    this.#writeConfig(this.#credential);
    const child = spawn(this.#binaryPath, ["-c", this.#configPath], {
      detached: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.#process = child;
    child.stderr?.setEncoding("utf8");
    child.once("error", (error) => {
      this.#lastError = `Link connector failed to start: ${error.message}`;
    });
    child.once("exit", (code, signal) => {
      if (this.#process === child) this.#process = null;
      if (this.#desired) {
        this.#lastError = `Link connector exited (${signal ?? code ?? "unknown"})`;
        this.#scheduleRestart();
      }
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        if (child.exitCode === null) resolve();
        else reject(new Error("Link connector exited during startup"));
      }, 750);
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.off("error", onError);
      };
      child.once("error", onError);
    });
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

  async start(credential: LinkConnectorCredential): Promise<void> {
    this.#credential = credential;
    this.#desired = true;
    await this.ensureInstalled();
    await this.#spawn();
  }

  async stop(): Promise<void> {
    this.#desired = false;
    this.#credential = null;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    const child = this.#process;
    this.#process = null;
    if (!child || child.exitCode !== null) return;
    child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 3_000);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
