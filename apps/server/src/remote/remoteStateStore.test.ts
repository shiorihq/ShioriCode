import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RemoteStateStore } from "./remoteStateStore";

const tempDirs: string[] = [];

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shiori-remote-state-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("RemoteStateStore", () => {
  it("defaults to off when no file exists", () => {
    const store = new RemoteStateStore({ stateDir: makeStateDir() });
    expect(store.method).toBe("off");
  });

  it("round-trips the persisted intent across instances", () => {
    const stateDir = makeStateDir();
    new RemoteStateStore({ stateDir }).set("tailscale-funnel");

    const reloaded = new RemoteStateStore({ stateDir });
    expect(reloaded.method).toBe("tailscale-funnel");
  });

  it("round-trips link exposure intent", () => {
    const stateDir = makeStateDir();
    new RemoteStateStore({ stateDir }).set("shiori-link");
    expect(new RemoteStateStore({ stateDir }).method).toBe("shiori-link");
  });

  it("falls back to off on a corrupt or unknown file", () => {
    const stateDir = makeStateDir();
    fs.writeFileSync(path.join(stateDir, "remote.json"), "{not json");
    expect(new RemoteStateStore({ stateDir }).method).toBe("off");

    fs.writeFileSync(
      path.join(stateDir, "remote.json"),
      JSON.stringify({ version: 1, method: "carrier-pigeon" }),
    );
    expect(new RemoteStateStore({ stateDir }).method).toBe("off");
  });

  it("fails closed on a legacy 'custom' record from before Tailscale-only", () => {
    const stateDir = makeStateDir();
    fs.writeFileSync(
      path.join(stateDir, "remote.json"),
      JSON.stringify({ version: 1, method: "custom", customUrl: "https://code.example.com" }),
    );
    expect(new RemoteStateStore({ stateDir }).method).toBe("off");
  });

  it("persists with owner-only permissions", () => {
    const stateDir = makeStateDir();
    new RemoteStateStore({ stateDir }).set("tailscale-serve");
    const mode = fs.statSync(path.join(stateDir, "remote.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
