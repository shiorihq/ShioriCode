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
    expect(store.customUrl).toBeNull();
  });

  it("round-trips the persisted intent across instances", () => {
    const stateDir = makeStateDir();
    new RemoteStateStore({ stateDir }).set("custom", "https://code.example.com");

    const reloaded = new RemoteStateStore({ stateDir });
    expect(reloaded.method).toBe("custom");
    expect(reloaded.customUrl).toBe("https://code.example.com");
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

  it("persists with owner-only permissions", () => {
    const stateDir = makeStateDir();
    new RemoteStateStore({ stateDir }).set("tailscale-serve", null);
    const mode = fs.statSync(path.join(stateDir, "remote.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
