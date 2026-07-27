import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
    expect(store.needsCleanup).toBe(false);
    expect(store.requiresTailscaleConfirmation).toBe(false);
  });

  it("round-trips the persisted intent across instances", () => {
    const stateDir = makeStateDir();
    new RemoteStateStore({ stateDir }).setReconciled("tailscale-funnel");

    const reloaded = new RemoteStateStore({ stateDir });
    expect(reloaded.method).toBe("tailscale-funnel");
    expect(reloaded.needsCleanup).toBe(false);
    expect(reloaded.requiresTailscaleConfirmation).toBe(false);
  });

  it("round-trips link exposure intent", () => {
    const stateDir = makeStateDir();
    new RemoteStateStore({ stateDir }).setReconciled("shiori-link");
    expect(new RemoteStateStore({ stateDir }).method).toBe("shiori-link");
  });

  it("preserves Tailscale cleanup uncertainty when loading version 1 state", () => {
    const stateDir = makeStateDir();
    const statePath = path.join(stateDir, "remote.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify({ version: 1, method: "shiori-link", updatedAt: "2026-01-01T00:00:00Z" }),
    );

    const legacy = new RemoteStateStore({ stateDir });
    expect(legacy.method).toBe("shiori-link");
    expect(legacy.needsCleanup).toBe(false);
    expect(legacy.requiresTailscaleConfirmation).toBe(true);

    legacy.setReconciled("shiori-link");
    const migrated = new RemoteStateStore({ stateDir });
    expect(migrated.requiresTailscaleConfirmation).toBe(false);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).version).toBe(2);
  });

  it("does not trust a legacy off record that may have forgotten a Funnel", () => {
    const stateDir = makeStateDir();
    fs.writeFileSync(
      path.join(stateDir, "remote.json"),
      JSON.stringify({ version: 1, method: "off", updatedAt: "2026-01-01T00:00:00Z" }),
    );

    const legacy = new RemoteStateStore({ stateDir });
    expect(legacy.method).toBe("off");
    expect(legacy.requiresTailscaleConfirmation).toBe(true);
  });

  it("preserves Tailscale uncertainty across offline Link transitions", () => {
    const stateDir = makeStateDir();
    const store = new RemoteStateStore({ stateDir });
    store.setReconciled("tailscale-funnel");

    store.transitionWithoutTailscaleTeardown("shiori-link");
    expect(store.method).toBe("shiori-link");
    expect(store.requiresTailscaleConfirmation).toBe(true);

    store.transitionWithoutTailscaleTeardown("off");
    const reloaded = new RemoteStateStore({ stateDir });
    expect(reloaded.method).toBe("off");
    expect(reloaded.requiresTailscaleConfirmation).toBe(true);
  });

  it("keeps clean offline Link transitions trusted when prior state is reconciled off", () => {
    const store = new RemoteStateStore({ stateDir: makeStateDir() });

    store.transitionWithoutTailscaleTeardown("shiori-link");
    expect(store.requiresTailscaleConfirmation).toBe(false);
    store.transitionWithoutTailscaleTeardown("off");
    expect(store.requiresTailscaleConfirmation).toBe(false);
  });

  it("marks corrupt or unknown state for confirmed transport cleanup", () => {
    const stateDir = makeStateDir();
    fs.writeFileSync(path.join(stateDir, "remote.json"), "{not json");
    const corrupt = new RemoteStateStore({ stateDir });
    expect(corrupt.method).toBe("off");
    expect(corrupt.needsCleanup).toBe(true);
    expect(corrupt.requiresTailscaleConfirmation).toBe(true);

    fs.writeFileSync(
      path.join(stateDir, "remote.json"),
      JSON.stringify({ version: 1, method: "carrier-pigeon" }),
    );
    const unknown = new RemoteStateStore({ stateDir });
    expect(unknown.method).toBe("off");
    expect(unknown.needsCleanup).toBe(true);
  });

  it("fails closed on a legacy 'custom' record from before Tailscale-only", () => {
    const stateDir = makeStateDir();
    fs.writeFileSync(
      path.join(stateDir, "remote.json"),
      JSON.stringify({ version: 1, method: "custom", customUrl: "https://code.example.com" }),
    );
    const store = new RemoteStateStore({ stateDir });
    expect(store.method).toBe("off");
    expect(store.needsCleanup).toBe(true);
  });

  it("persists with owner-only permissions", () => {
    const stateDir = makeStateDir();
    new RemoteStateStore({ stateDir }).setReconciled("tailscale-serve");
    const mode = fs.statSync(path.join(stateDir, "remote.json")).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(fs.readdirSync(stateDir)).toEqual(["remote.json"]);
  });

  it("preserves the previous durable intent and reports atomic replace failures", () => {
    const stateDir = makeStateDir();
    const store = new RemoteStateStore({ stateDir });
    store.setReconciled("tailscale-serve");
    const statePath = path.join(stateDir, "remote.json");
    const before = fs.readFileSync(statePath, "utf8");
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("simulated rename failure");
    });

    try {
      expect(() => store.setReconciled("tailscale-funnel")).toThrow("simulated rename failure");
    } finally {
      rename.mockRestore();
    }

    expect(store.needsCleanup).toBe(false);
    expect(store.method).toBe("tailscale-serve");
    expect(fs.readFileSync(statePath, "utf8")).toBe(before);
    expect(new RemoteStateStore({ stateDir }).method).toBe("tailscale-serve");
    expect(fs.readdirSync(stateDir)).toEqual(["remote.json"]);
  });
});
