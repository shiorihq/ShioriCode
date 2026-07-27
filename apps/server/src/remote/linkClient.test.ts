import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LinkControlPlaneClient } from "./linkClient";
import { LinkRemoteStore } from "./linkStore";

interface ProvisionBody {
  environment: { id: string; endpoint: string };
  connector: {
    serverAddr: string;
    serverPort: number;
    serverTls: boolean;
    environmentId: string;
    token: string;
  };
}

const temporaryDirectories: string[] = [];

function makeClient(): {
  readonly stateDir: string;
  readonly store: LinkRemoteStore;
  readonly client: LinkControlPlaneClient;
} {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-link-client-"));
  temporaryDirectories.push(stateDir);
  const store = new LinkRemoteStore({ stateDir });
  store.setAccount({ accessToken: "old-access", refreshToken: "old-refresh" });
  return {
    stateDir,
    store,
    client: new LinkControlPlaneClient({ store, origin: "https://control.example" }),
  };
}

function validProvisionBody(): ProvisionBody {
  return {
    environment: { id: "record", endpoint: "https://example.link" },
    connector: {
      serverAddr: "relay.example.link",
      serverPort: 7443,
      serverTls: true,
      environmentId: "environment",
      token: "connector-token",
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("LinkControlPlaneClient", () => {
  it("does not refresh or persist tokens for a read-only list request", async () => {
    const { stateDir, store, client } = makeClient();
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.list()).rejects.toThrow(/list.*401/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.account).toEqual({ accessToken: "old-access", refreshToken: "old-refresh" });
    expect(new LinkRemoteStore({ stateDir }).account).toEqual({
      accessToken: "old-access",
      refreshToken: "old-refresh",
    });
  });

  it.each([
    [
      "zero port",
      (body: ProvisionBody): void => {
        body.connector.serverPort = 0;
      },
    ],
    [
      "negative port",
      (body: ProvisionBody): void => {
        body.connector.serverPort = -1;
      },
    ],
    [
      "oversized port",
      (body: ProvisionBody): void => {
        body.connector.serverPort = 70_000;
      },
    ],
    [
      "fractional port",
      (body: ProvisionBody): void => {
        body.connector.serverPort = 7443.5;
      },
    ],
    [
      "empty endpoint",
      (body: ProvisionBody): void => {
        body.environment.endpoint = "";
      },
    ],
    [
      "empty relay address",
      (body: ProvisionBody): void => {
        body.connector.serverAddr = "";
      },
    ],
    [
      "empty connector token",
      (body: ProvisionBody): void => {
        body.connector.token = "";
      },
    ],
  ] as const)("rejects a provision response with %s", async (_label, mutate) => {
    const { client } = makeClient();
    const body = validProvisionBody();
    mutate(body);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body, { status: 200 })),
    );

    await expect(
      client.provision({ instanceId: "instance", displayName: "server" }),
    ).rejects.toThrow(/invalid link connector credential/i);
  });

  it("accepts a complete provision response at the valid port boundary", async () => {
    const { client } = makeClient();
    const body = validProvisionBody();
    body.connector.serverPort = 65_535;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body, { status: 200 })),
    );

    const credential = await client.provision({ instanceId: "instance", displayName: "server" });

    expect(credential.serverPort).toBe(65_535);
    expect(credential.endpoint).toBe("https://example.link");
  });
});
