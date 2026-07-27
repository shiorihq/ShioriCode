import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type FrpcLaunchOwnership,
  type FrpcProcessController,
  FrpcProcessOwnership,
  type FrpcProcessSnapshot,
} from "./frpcProcessOwnership";

const temporaryDirectories: string[] = [];

class FakeProcessController implements FrpcProcessController {
  readonly snapshots = new Map<number, FrpcProcessSnapshot>();
  readonly signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  terminateOnSignal = true;

  async inspect(pid: number): Promise<FrpcProcessSnapshot | null> {
    return this.snapshots.get(pid) ?? null;
  }

  async findConfigCandidates(configPath: string): Promise<readonly FrpcProcessSnapshot[]> {
    return [...this.snapshots.values()].filter(
      (snapshot) =>
        snapshot.argv?.length === 3 && snapshot.argv[1] === "-c" && snapshot.argv[2] === configPath,
    );
  }

  signal(pid: number, signal: NodeJS.Signals): void {
    this.signals.push({ pid, signal });
    if (!this.snapshots.has(pid)) {
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    }
    if (this.terminateOnSignal) this.snapshots.delete(pid);
  }

  async wait(): Promise<void> {}
}

function fixture(controller = new FakeProcessController()): {
  readonly stateDir: string;
  readonly binaryPath: string;
  readonly metadataPath: string;
  readonly controller: FakeProcessController;
  readonly ownership: FrpcProcessOwnership;
} {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-frpc-ownership-"));
  temporaryDirectories.push(stateDir);
  const binaryPath = path.join(stateDir, "link", "frp-v0.69.0", "frpc");
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, "fake", { mode: 0o700 });
  return {
    stateDir,
    binaryPath,
    metadataPath: path.join(stateDir, "link", "frpc-process.json"),
    controller,
    ownership: new FrpcProcessOwnership({
      stateDir,
      binaryPath,
      platform: "linux",
      controller,
    }),
  };
}

function snapshotFor(
  launch: FrpcLaunchOwnership,
  pid = 4242,
  birthIdentity = `boot:start:${pid}`,
): FrpcProcessSnapshot {
  return {
    pid,
    birthIdentity,
    executablePath: launch.binaryPath,
    argv: [launch.binaryPath, "-c", launch.configPath],
    commandLine: null,
  };
}

async function registeredLaunch(input: ReturnType<typeof fixture>): Promise<{
  readonly launch: FrpcLaunchOwnership;
  readonly snapshot: FrpcProcessSnapshot;
}> {
  const launch = input.ownership.prepare('connector-token = "secret"\n');
  const snapshot = snapshotFor(launch);
  input.controller.snapshots.set(snapshot.pid, snapshot);
  await input.ownership.register(launch, snapshot.pid);
  return { launch, snapshot };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("FrpcProcessOwnership", () => {
  it("atomically persists private launch identity and removes it only after normal stop", async () => {
    const input = fixture();
    const rename = vi.spyOn(fs, "renameSync");
    const link = vi.spyOn(fs, "linkSync");
    const { launch, snapshot } = await registeredLaunch(input);

    expect(fs.statSync(input.metadataPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(launch.configPath).mode & 0o777).toBe(0o600);
    expect(link).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), input.metadataPath);
    expect(rename.mock.calls.some(([, destination]) => destination === input.metadataPath)).toBe(
      true,
    );
    expect(
      fs.readdirSync(path.dirname(input.metadataPath)).some((entry) => entry.endsWith(".tmp")),
    ).toBe(false);

    await input.ownership.terminate();

    expect(input.controller.signals).toEqual([{ pid: snapshot.pid, signal: "SIGTERM" }]);
    expect(fs.existsSync(input.metadataPath)).toBe(false);
    expect(fs.existsSync(launch.configPath)).toBe(false);
  });

  it("removes the private temp file when writing or fsyncing fails", () => {
    const input = fixture();
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw new Error("disk sync failed");
    });

    expect(() => input.ownership.prepare("secret\n")).toThrow(/disk sync failed/i);

    expect(
      fs.readdirSync(path.join(input.stateDir, "link")).some((entry) => entry.endsWith(".tmp")),
    ).toBe(false);
    expect(input.ownership.cleanupRequired).toBe(false);
  });

  it("recovers and terminates a registered orphan from a new connector instance", async () => {
    const input = fixture();
    const { snapshot } = await registeredLaunch(input);
    const recovered = new FrpcProcessOwnership({
      stateDir: input.stateDir,
      binaryPath: input.binaryPath,
      platform: "linux",
      controller: input.controller,
    });

    expect(recovered.cleanupRequired).toBe(true);
    await recovered.terminate();

    expect(input.controller.signals).toEqual([{ pid: snapshot.pid, signal: "SIGTERM" }]);
    expect(recovered.cleanupRequired).toBe(false);
  });

  it("recovers the pre-registration crash window by scanning the unique config path", async () => {
    const input = fixture();
    const launch = input.ownership.prepare('connector-token = "secret"\n');
    const snapshot = snapshotFor(launch);
    input.controller.snapshots.set(snapshot.pid, snapshot);

    await input.ownership.terminate();

    expect(input.controller.signals).toEqual([{ pid: snapshot.pid, signal: "SIGTERM" }]);
    expect(input.ownership.cleanupRequired).toBe(false);
  });

  it("migrates and terminates an orphan launched with the legacy fixed config", async () => {
    const input = fixture();
    const legacyConfigPath = path.join(input.stateDir, "link", "frpc.toml");
    fs.writeFileSync(legacyConfigPath, 'connector-token = "legacy"\n', { mode: 0o600 });
    const legacyLaunch: FrpcLaunchOwnership = {
      launchId: "legacy",
      binaryPath: input.binaryPath,
      configPath: legacyConfigPath,
      pid: null,
      birthIdentity: null,
    };
    const snapshot = snapshotFor(legacyLaunch, 5151, "legacy-process-birth");
    input.controller.snapshots.set(snapshot.pid, snapshot);

    expect(input.ownership.cleanupRequired).toBe(true);
    await input.ownership.terminate();

    expect(input.controller.signals).toEqual([{ pid: snapshot.pid, signal: "SIGTERM" }]);
    expect(fs.existsSync(legacyConfigPath)).toBe(false);
    expect(input.ownership.cleanupRequired).toBe(false);
  });

  it("terminates a legacy orphan from a prior managed FRP version", async () => {
    const input = fixture();
    const legacyConfigPath = path.join(input.stateDir, "link", "frpc.toml");
    fs.writeFileSync(legacyConfigPath, 'connector-token = "legacy"\n', { mode: 0o600 });
    const priorBinaryPath = path.join(input.stateDir, "link", "frp-v0.68.0", "frpc");
    const legacyLaunch: FrpcLaunchOwnership = {
      launchId: "legacy-prior-version",
      binaryPath: priorBinaryPath,
      configPath: legacyConfigPath,
      pid: null,
      birthIdentity: null,
    };
    const snapshot = {
      ...snapshotFor(legacyLaunch, 5252, "old-version-process-birth"),
      executablePath: `${priorBinaryPath} (deleted)`,
    };
    input.controller.snapshots.set(snapshot.pid, snapshot);

    await input.ownership.terminate();

    expect(input.controller.signals).toEqual([{ pid: snapshot.pid, signal: "SIGTERM" }]);
    expect(fs.existsSync(legacyConfigPath)).toBe(false);
  });

  it("accepts canonical ownership metadata from a prior managed FRP version", async () => {
    const input = fixture();
    const priorBinaryPath = path.join(input.stateDir, "link", "frp-v0.68.0", "frpc");
    fs.mkdirSync(path.dirname(priorBinaryPath), { recursive: true });
    fs.writeFileSync(priorBinaryPath, "old frpc", { mode: 0o700 });
    const priorOwnership = new FrpcProcessOwnership({
      stateDir: input.stateDir,
      binaryPath: priorBinaryPath,
      platform: "linux",
      controller: input.controller,
    });
    const launch = priorOwnership.prepare('connector-token = "old"\n');
    const snapshot = snapshotFor(launch, 5353, "old-metadata-process-birth");
    input.controller.snapshots.set(snapshot.pid, snapshot);
    await priorOwnership.register(launch, snapshot.pid);

    await input.ownership.terminate();

    expect(input.controller.signals).toEqual([{ pid: snapshot.pid, signal: "SIGTERM" }]);
    expect(input.ownership.cleanupRequired).toBe(false);
  });

  it.each(["frpc.toml", "frpc-lost-launch.toml"])(
    "removes a stale %s config only after confirming no matching process exists",
    async (fileName) => {
      const input = fixture();
      const configPath = path.join(input.stateDir, "link", fileName);
      fs.writeFileSync(configPath, "stale\n", { mode: 0o600 });
      const findCandidates = vi.spyOn(input.controller, "findConfigCandidates");

      expect(input.ownership.cleanupRequired).toBe(true);
      await input.ownership.terminate();

      expect(findCandidates).toHaveBeenCalledTimes(10);
      expect(input.controller.signals).toEqual([]);
      expect(fs.existsSync(configPath)).toBe(false);
      expect(input.ownership.cleanupRequired).toBe(false);
    },
  );

  it("does not signal a stale PID that was reused by an unrelated process", async () => {
    const input = fixture();
    const { snapshot } = await registeredLaunch(input);
    input.controller.snapshots.set(snapshot.pid, {
      ...snapshot,
      birthIdentity: "new-process-birth",
      executablePath: "/usr/bin/unrelated",
      argv: ["/usr/bin/unrelated", "--serve"],
    });

    await input.ownership.terminate();

    expect(input.controller.signals).toEqual([]);
    expect(input.controller.snapshots.has(snapshot.pid)).toBe(true);
    expect(input.ownership.cleanupRequired).toBe(false);
  });

  it("fails closed when the recorded PID and birth are live but command identity changed", async () => {
    const input = fixture();
    const { snapshot } = await registeredLaunch(input);
    input.controller.snapshots.set(snapshot.pid, {
      ...snapshot,
      argv: [snapshot.executablePath ?? "frpc", "--unexpected"],
    });

    await expect(input.ownership.terminate()).rejects.toThrow(/cannot be verified/i);

    expect(input.controller.signals).toEqual([]);
    expect(input.ownership.cleanupRequired).toBe(true);
  });

  it("does not resolve shutdown while the verified process remains alive", async () => {
    const controller = new FakeProcessController();
    controller.terminateOnSignal = false;
    const input = fixture(controller);
    const { snapshot } = await registeredLaunch(input);

    await expect(input.ownership.terminate()).rejects.toThrow(/still running/i);

    expect(controller.signals).toEqual([
      { pid: snapshot.pid, signal: "SIGTERM" },
      { pid: snapshot.pid, signal: "SIGKILL" },
    ]);
    expect(input.ownership.cleanupRequired).toBe(true);
  });

  it.each(["directory", "symlink", "fifo"] as const)(
    "treats a %s ownership entry as uncertain and rejects it without blocking",
    async (kind) => {
      const input = fixture();
      if (kind === "directory") {
        fs.mkdirSync(input.metadataPath);
      } else if (kind === "symlink") {
        fs.symlinkSync(input.binaryPath, input.metadataPath);
      } else {
        const { execFileSync } = await import("node:child_process");
        execFileSync("mkfifo", [input.metadataPath]);
      }

      expect(input.ownership.cleanupRequired).toBe(true);
      await expect(input.ownership.terminate()).rejects.toThrow(/ownership record|private file/i);
      expect(input.controller.signals).toEqual([]);
    },
  );
});
