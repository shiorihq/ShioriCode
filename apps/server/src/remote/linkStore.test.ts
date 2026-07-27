import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { hasPersistedLinkHostedAccess, LinkRemoteStore } from "./linkStore";

const tempDirectories: string[] = [];

function makeStore(): { stateDir: string; store: LinkRemoteStore } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-link-store-"));
  tempDirectories.push(stateDir);
  return { stateDir, store: new LinkRemoteStore({ stateDir }) };
}

afterEach(() => {
  vi.restoreAllMocks();
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

  it("fsyncs the temporary state before its atomic rename", () => {
    const fsync = vi.spyOn(fs, "fsyncSync");
    const { store } = makeStore();

    store.setAccount({ accessToken: "access", refreshToken: "refresh" });

    expect(fsync).toHaveBeenCalled();
  });

  it("propagates transient read failures without overwriting persisted credentials", () => {
    const { stateDir, store } = makeStore();
    store.setAccount({ accessToken: "access", refreshToken: "refresh" });
    const filePath = path.join(stateDir, "link-remote.json");
    const before = fs.readFileSync(filePath, "utf8");
    const failure = Object.assign(new Error("too many open files"), { code: "EMFILE" });
    vi.spyOn(fs, "openSync").mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => new LinkRemoteStore({ stateDir })).toThrow(failure);
    expect(fs.readFileSync(filePath, "utf8")).toBe(before);
  });

  it("does not replace a torn or malformed state file", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-link-store-"));
    tempDirectories.push(stateDir);
    const filePath = path.join(stateDir, "link-remote.json");
    fs.writeFileSync(filePath, '{"version":1,"instanceId":', { mode: 0o600 });
    const before = fs.readFileSync(filePath, "utf8");

    expect(() => new LinkRemoteStore({ stateDir })).toThrow(SyntaxError);
    expect(fs.readFileSync(filePath, "utf8")).toBe(before);
  });

  it("salvages valid identity and account fields when only the connector is invalid", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-link-store-"));
    tempDirectories.push(stateDir);
    const filePath = path.join(stateDir, "link-remote.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        instanceId: "stable-instance",
        account: { accessToken: "access", refreshToken: "refresh" },
        pendingAuth: null,
        connector: {
          environmentRecordId: "record",
          environmentId: "environment",
          endpoint: "https://example.link",
          serverAddr: "relay.example.link",
          serverPort: 70_000,
          serverTls: true,
          token: "secret",
          updatedAt: new Date(0).toISOString(),
        },
      }),
      { mode: 0o600 },
    );

    const store = new LinkRemoteStore({ stateDir });

    expect(store.instanceId).toBe("stable-instance");
    expect(store.account).toEqual({ accessToken: "access", refreshToken: "refresh" });
    expect(store.connector).toBeNull();
    expect(hasPersistedLinkHostedAccess(stateDir)).toBe(false);
  });

  it("can inspect a missing state directory without creating it", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-link-read-only-"));
    tempDirectories.push(parent);
    const stateDir = path.join(parent, "userdata");

    const store = new LinkRemoteStore({ stateDir, createIfMissing: false });

    expect(store.account).toBeNull();
    expect(fs.existsSync(stateDir)).toBe(false);
    expect(hasPersistedLinkHostedAccess(stateDir)).toBe(false);
    expect(fs.existsSync(stateDir)).toBe(false);
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
    const { stateDir, store } = makeStore();
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
    store.setAccount({ accessToken: "access", refreshToken: "refresh" });
    expect(hasPersistedLinkHostedAccess(stateDir)).toBe(true);
    store.clearConnector();
    expect(store.connector).toBeNull();
  });
});
