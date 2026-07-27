import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildFrpExtractionCommand,
  FrpcConnector,
  renderFrpcConfig,
  resolveFrpAsset,
} from "./frpcConnector";
import type { FrpcProcessController, FrpcProcessSnapshot } from "./frpcProcessOwnership";
import type { LinkConnectorCredential } from "./linkStore";

const temporaryDirectories: string[] = [];

const credential: LinkConnectorCredential = {
  environmentRecordId: "record",
  environmentId: "env_12345678",
  endpoint: "https://sc-example.link.shiori.codes",
  serverAddr: "relay.link.shiori.codes",
  serverPort: 7443,
  serverTls: true,
  token: "connector-token",
  updatedAt: new Date(0).toISOString(),
};

type FakeChild = EventEmitter & {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  pid?: number;
  stderr: PassThrough;
  kill: ChildProcess["kill"];
  onKilled?: () => void;
};

function fakeChild(pid: number | null = 10_000): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    pid?: number;
    stderr: PassThrough;
    kill: ChildProcess["kill"];
    onKilled?: () => void;
  };
  child.exitCode = null;
  child.signalCode = null;
  if (pid !== null) child.pid = pid;
  child.stderr = new PassThrough();
  child.kill = vi.fn((signal: NodeJS.Signals | number = "SIGTERM") => {
    child.onKilled?.();
    child.exitCode = 0;
    const signalCode = typeof signal === "string" ? signal : "SIGTERM";
    child.signalCode = signalCode;
    queueMicrotask(() => child.emit("exit", 0, signalCode));
    return true;
  }) as ChildProcess["kill"];
  return child as unknown as ChildProcess;
}

function setExitCode(child: ChildProcess, exitCode: number): void {
  (child as unknown as { exitCode: number | null }).exitCode = exitCode;
}

class FakeProcessController implements FrpcProcessController {
  readonly snapshots = new Map<number, FrpcProcessSnapshot>();
  readonly children = new Map<number, FakeChild>();
  readonly signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

  track(child: ChildProcess, binaryPath: string, args: readonly string[]): void {
    if (child.pid === undefined) return;
    const fake = child as unknown as FakeChild;
    const snapshot: FrpcProcessSnapshot = {
      pid: child.pid,
      birthIdentity: `fake-birth-${child.pid}`,
      executablePath: binaryPath,
      argv: [binaryPath, ...args],
      commandLine: null,
    };
    this.snapshots.set(child.pid, snapshot);
    this.children.set(child.pid, fake);
    fake.onKilled = () => {
      this.snapshots.delete(child.pid ?? -1);
      this.children.delete(child.pid ?? -1);
    };
    child.once("exit", fake.onKilled);
  }

  async inspect(pid: number): Promise<FrpcProcessSnapshot | null> {
    return this.snapshots.get(pid) ?? null;
  }

  async findConfigCandidates(configPath: string): Promise<readonly FrpcProcessSnapshot[]> {
    return [...this.snapshots.values()].filter(
      (snapshot) => snapshot.argv?.[1] === "-c" && snapshot.argv[2] === configPath,
    );
  }

  signal(pid: number, signal: NodeJS.Signals): void {
    this.signals.push({ pid, signal });
    const child = this.children.get(pid);
    if (!child) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    child.kill(signal);
  }

  async wait(): Promise<void> {}
}

function installedConnectorFixture(
  spawnProcess: typeof spawn,
  processController = new FakeProcessController(),
): {
  readonly connector: FrpcConnector;
  readonly stateDir: string;
  readonly processController: FakeProcessController;
} {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-frpc-"));
  temporaryDirectories.push(stateDir);
  const asset = resolveFrpAsset("linux", "x64");
  const directory = path.join(stateDir, "link", "frp-v0.69.0");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, asset.executableName), "fake frpc");
  fs.writeFileSync(path.join(directory, `${asset.executableName}.verified`), `${asset.sha256}\n`);
  const trackedSpawn = ((file: string, args: readonly string[], options: unknown) => {
    const child = spawnProcess(file, [...args], options as never);
    processController.track(child, file, args);
    return child;
  }) as typeof spawn;
  return {
    connector: new FrpcConnector({
      stateDir,
      localPort: 3773,
      platform: "linux",
      arch: "x64",
      spawnProcess: trackedSpawn,
      processController,
    }),
    stateDir,
    processController,
  };
}

function installedConnector(
  spawnProcess: typeof spawn,
  processController = new FakeProcessController(),
): FrpcConnector {
  return installedConnectorFixture(spawnProcess, processController).connector;
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("frpcConnector", () => {
  it("pins supported release assets to their published checksums", () => {
    expect(resolveFrpAsset("darwin", "arm64").sha256).toBe(
      "07663f5fa71330f074b25e32cc8bc4ae5ed40d9c2ee1690cbd981774475997a2",
    );
    expect(() => resolveFrpAsset("linux", "arm64")).toThrow(/not available/i);
  });

  it("does not resolve unsupported platform assets during construction or status", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-frpc-unsupported-"));
    temporaryDirectories.push(stateDir);

    const connector = new FrpcConnector({
      stateDir,
      localPort: 3773,
      platform: "linux",
      arch: "arm64",
    });

    expect(connector.installed).toBe(false);
    await expect(connector.ensureInstalled()).rejects.toThrow(/not available for linux\/arm64/i);
  });

  it("extracts Windows zip assets with argument-safe tar invocation", () => {
    const command = buildFrpExtractionCommand(
      "zip",
      String.raw`C:\Program Files\Shiori Code\frp.zip`,
      String.raw`C:\Program Data\Shiori Code\extract`,
    );

    expect(command).toEqual({
      file: "tar",
      args: [
        "-xf",
        String.raw`C:\Program Files\Shiori Code\frp.zip`,
        "-C",
        String.raw`C:\Program Data\Shiori Code\extract`,
      ],
    });
  });

  it("clears a failed spawn and does not report it as running", async () => {
    const child = fakeChild(null);
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
      return child;
    }) as unknown as typeof spawn;
    const connector = installedConnector(spawnProcess);

    await expect(connector.start(credential)).rejects.toThrow(/spawn ENOENT/i);

    expect(connector.running).toBe(false);
    expect(connector.lastError).toMatch(/spawn ENOENT/i);
  });

  it("rolls back restart intent when the initial process exits during startup", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        child.emit("spawn");
        setExitCode(child, 1);
        child.emit("exit", 1, null);
      });
      return child;
    }) as unknown as typeof spawn;
    const connector = installedConnector(spawnProcess);

    await expect(connector.start(credential)).rejects.toThrow(/exited during startup/i);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(connector.running).toBe(false);
  });

  it("retains a live child after a post-start process error", async () => {
    vi.useFakeTimers();
    const children: ChildProcess[] = [];
    const spawnProcess = vi.fn(() => {
      const child = fakeChild();
      children.push(child);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as unknown as typeof spawn;
    const connector = installedConnector(spawnProcess);

    const started = connector.start(credential);
    await vi.advanceTimersByTimeAsync(750);
    await started;
    expect(connector.running).toBe(true);

    children[0]?.emit("error", new Error("runtime pipe failure"));
    expect(connector.running).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    await connector.stop();
  });

  it("stops the trusted live child when its ownership metadata disappeared", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as unknown as typeof spawn;
    const { connector, stateDir } = installedConnectorFixture(spawnProcess);

    const started = connector.start(credential);
    await vi.advanceTimersByTimeAsync(750);
    await started;
    fs.unlinkSync(path.join(stateDir, "link", "frpc-process.json"));

    await connector.stop();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(connector.running).toBe(false);
    expect(connector.cleanupRequired).toBe(false);
  });

  it("retains fail-closed ownership when launch identity and child exit cannot be confirmed", async () => {
    const processController = new FakeProcessController();
    processController.inspect = vi.fn(async () => null);
    processController.findConfigCandidates = vi.fn(async () => []);
    const child = fakeChild();
    child.kill = vi.fn(() => {
      throw new Error("signal failed");
    }) as ChildProcess["kill"];
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as unknown as typeof spawn;
    const { connector, stateDir } = installedConnectorFixture(spawnProcess, processController);

    await expect(connector.start(credential)).rejects.toThrow(/could not be confirmed stopped/i);

    expect(child.kill).toHaveBeenCalled();
    expect(connector.cleanupRequired).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "link", "frpc-process.json"))).toBe(true);
    expect(processController.signals).toEqual([]);
  });

  it("renders an outbound TLS proxy with relay identity metadata", () => {
    const config = renderFrpcConfig({
      localPort: 3773,
      credential: {
        environmentRecordId: "record",
        environmentId: "env_12345678",
        endpoint: "https://sc-example.link.shiori.codes",
        serverAddr: "relay.link.shiori.codes",
        serverPort: 7443,
        serverTls: true,
        token: "connector-token",
        updatedAt: new Date(0).toISOString(),
      },
    });
    expect(config).toContain('serverAddr = "relay.link.shiori.codes"');
    expect(config).toContain("serverPort = 7443");
    expect(config).toContain("transport.tls.enable = true");
    expect(config).toContain("transport.heartbeatInterval = 15");
    expect(config).toContain("transport.heartbeatTimeout = 45");
    expect(config).toContain('auth.additionalScopes = ["HeartBeats", "NewWorkConns"]');
    expect(config).toContain('metadatas.environment_id = "env_12345678"');
    expect(config).toContain('metadatas.connector_token = "connector-token"');
    expect(config).toContain("localPort = 3773");
    expect(config).toContain('type = "http"');
    expect(config).toContain("transport.useEncryption = false");
  });
});
