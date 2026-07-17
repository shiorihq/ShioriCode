import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LinkRemoteStore } from "./linkStore";

const tempDirectories: string[] = [];

function makeStore(): { stateDir: string; store: LinkRemoteStore } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-link-store-"));
  tempDirectories.push(stateDir);
  return { stateDir, store: new LinkRemoteStore({ stateDir }) };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("LinkRemoteStore", () => {
  it("persists a stable instance identity with owner-only permissions", () => {
    const { stateDir, store } = makeStore();
    const filePath = path.join(stateDir, "link-remote.json");
    const inode = fs.statSync(filePath).ino;
    const reloaded = new LinkRemoteStore({ stateDir });
    expect(reloaded.instanceId).toBe(store.instanceId);
    expect(fs.statSync(filePath).ino).toBe(inode);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("accepts exactly the pending non-expired auth state", () => {
    const { store } = makeStore();
    store.setPendingAuth({
      state: "expected-state",
      expiresAt: new Date(2_000).toISOString(),
    });
    expect(() =>
      store.completeAuth({
        state: "wrong-state",
        accessToken: "access",
        refreshToken: "refresh",
        now: 1_000,
      }),
    ).toThrow(/invalid or expired/i);
    store.completeAuth({
      state: "expected-state",
      accessToken: "access",
      refreshToken: "refresh",
      now: 1_000,
    });
    expect(store.account).toEqual({ accessToken: "access", refreshToken: "refresh" });
  });

  it("persists and clears the one-time connector credential", () => {
    const { store } = makeStore();
    store.setConnector({
      environmentRecordId: "environment-record",
      environmentId: "env_12345678",
      endpoint: "https://sc-example.link.shiori.codes",
      serverAddr: "relay.link.shiori.codes",
      serverPort: 7443,
      serverTls: true,
      token: "connector-secret",
      updatedAt: new Date(0).toISOString(),
    });
    expect(store.connector?.token).toBe("connector-secret");
    store.clearConnector();
    expect(store.connector).toBeNull();
  });
});
