import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LinkRemote, type LinkAuthCallbackInput, type LinkRemoteConnector } from "./LinkRemote";
import { LinkRemoteStore, type LinkConnectorCredential } from "./linkStore";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function makeRemote(callbackScheme: string): Promise<LinkRemote> {
  const stateDir = await mkdtemp(join(tmpdir(), "shioricode-link-"));
  temporaryDirectories.push(stateDir);
  return new LinkRemote({ stateDir, localPort: 43123, callbackScheme });
}

const connectorCredential: LinkConnectorCredential = {
  environmentRecordId: "environment-record",
  environmentId: "environment",
  endpoint: "https://example.link",
  serverAddr: "relay.example.link",
  serverPort: 7443,
  serverTls: true,
  token: "connector-token",
  updatedAt: new Date(0).toISOString(),
};

function fakeConnector(running: boolean): LinkRemoteConnector & {
  readonly start: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
} {
  return {
    installed: true,
    running,
    lastError: null,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

describe("LinkRemote", () => {
  it("targets the development desktop protocol without waking production", async () => {
    const remote = await makeRemote("shioricode-dev");
    const result = remote.beginSignIn({ provider: "github" });
    const redirect = new URL(result.authUrl).searchParams.get("redirect");

    expect(redirect).toBe("shioricode-dev://app/index.html?link-auth=callback");
    await remote.dispose();
  });

  it("rejects arbitrary callback schemes", async () => {
    const remote = await makeRemote("javascript");
    const result = remote.beginSignIn({ provider: "github" });
    const redirect = new URL(result.authUrl).searchParams.get("redirect");

    expect(redirect).toBe("shioricode://app/index.html?link-auth=callback");
    await remote.dispose();
  });

  it.each([
    ["an error", (state: string): LinkAuthCallbackInput => ({ state, error: "denied" })],
    ["missing tokens", (state: string): LinkAuthCallbackInput => ({ state })],
  ] as const)("keeps pending auth when a mismatched callback reports %s", async (_label, input) => {
    const remote = await makeRemote("shioricode");
    const signIn = remote.beginSignIn({ provider: "github" });
    const expectedState = new URL(signIn.authUrl).searchParams.get("state");
    expect(expectedState).not.toBeNull();

    expect(() => remote.completeSignIn(input("attacker-state"))).toThrow(/invalid or expired/i);
    remote.completeSignIn({
      state: expectedState ?? "",
      token: "access",
      refreshToken: "refresh",
    });

    expect(remote.status().accountLinked).toBe(true);
    await remote.dispose();
  });

  it("keeps a healthy connector running when reprovisioning fails", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "shioricode-link-"));
    temporaryDirectories.push(stateDir);
    const store = new LinkRemoteStore({ stateDir });
    store.setAccount({ accessToken: "access", refreshToken: "refresh" });
    store.setConnector(connectorCredential);
    const connector = fakeConnector(true);
    const client = {
      provision: vi.fn(async () => {
        throw new Error("control plane unavailable");
      }),
      revoke: vi.fn(async () => undefined),
    };
    const remote = new LinkRemote({ stateDir, localPort: 43123, store, connector, client });

    await expect(remote.enable()).rejects.toThrow(/control plane unavailable/i);

    expect(client.provision).toHaveBeenCalledOnce();
    expect(connector.stop).not.toHaveBeenCalled();
    expect(remote.status().connectorRunning).toBe(true);
    await remote.dispose();
  });

  it("provisions before replacing the active connector credential", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "shioricode-link-"));
    temporaryDirectories.push(stateDir);
    const store = new LinkRemoteStore({ stateDir });
    store.setAccount({ accessToken: "access", refreshToken: "refresh" });
    const calls: string[] = [];
    const connector = fakeConnector(false);
    connector.stop.mockImplementation(async () => {
      calls.push("stop");
    });
    connector.start.mockImplementation(async () => {
      calls.push("start");
    });
    const client = {
      provision: vi.fn(async () => {
        calls.push("provision");
        return connectorCredential;
      }),
      revoke: vi.fn(async () => undefined),
    };
    const remote = new LinkRemote({ stateDir, localPort: 43123, store, connector, client });

    await remote.enable();

    expect(calls).toEqual(["provision", "stop", "start"]);
    expect(store.connector).toEqual(connectorCredential);
    await remote.dispose();
  });

  it("reports configured hosted access before the connector has started", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "shioricode-link-"));
    temporaryDirectories.push(stateDir);
    const store = new LinkRemoteStore({ stateDir });
    store.setAccount({ accessToken: "access", refreshToken: "refresh" });
    store.setConnector(connectorCredential);
    const connector = fakeConnector(false);
    const remote = new LinkRemote({
      stateDir,
      localPort: 43123,
      store,
      connector,
      client: {
        provision: vi.fn(async () => connectorCredential),
        revoke: vi.fn(async () => undefined),
      },
    });

    expect(remote.hostedAccessConfigured).toBe(true);
    expect(remote.hostedAccessAvailable).toBe(false);
    await remote.dispose();
  });
});
