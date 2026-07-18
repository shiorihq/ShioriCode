import os from "node:os";

import { LinkControlPlaneClient } from "./remote/linkClient";
import { LinkRemoteStore } from "./remote/linkStore";
import { RemoteStateStore } from "./remote/remoteStateStore";
import {
  controlService,
  installedServiceLayout,
  linkServiceStateDir,
  repairServiceStateOwnership,
  requireServiceAdministrator,
} from "./serviceManager";

const DEFAULT_SHIORI_ORIGIN = "https://shiori.codes";
const REQUEST_TIMEOUT_MS = 15_000;

interface DeviceStartResponse {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresIn: number;
  readonly interval: number;
}

interface DeviceTokens {
  readonly token: string;
  readonly refreshToken: string;
}

function linkOrigin(): string {
  return (process.env.SHIORICODE_LINK_API_URL ?? DEFAULT_SHIORI_ORIGIN).trim().replace(/\/$/, "");
}

async function jsonRequest<T>(
  pathname: string,
  init: RequestInit,
): Promise<{ readonly response: Response; readonly body: T | null }> {
  const response = await fetch(`${linkOrigin()}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", "X-Shiori-Client": "cli", ...init.headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => null)) as T | null;
  return { response, body };
}

async function startDeviceAuthorization(): Promise<DeviceStartResponse> {
  const { response, body } = await jsonRequest<Partial<DeviceStartResponse>>(
    "/api/shiori-code/link/device/start",
    { method: "POST", body: "{}" },
  );
  if (
    !response.ok ||
    !body ||
    typeof body.deviceCode !== "string" ||
    typeof body.userCode !== "string" ||
    typeof body.verificationUri !== "string" ||
    typeof body.verificationUriComplete !== "string" ||
    typeof body.expiresIn !== "number" ||
    typeof body.interval !== "number"
  ) {
    throw new Error(`Could not start GitHub sign-in (${response.status})`);
  }
  return body as DeviceStartResponse;
}

async function waitForDeviceAuthorization(input: DeviceStartResponse): Promise<DeviceTokens> {
  const deadline = Date.now() + input.expiresIn * 1_000;
  let intervalMs = Math.max(1_000, input.interval * 1_000);
  let tick = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (process.stdout.isTTY) {
      const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      process.stdout.write(`\r${frames[tick % frames.length]} Waiting for GitHub authorization…`);
      tick += 1;
    }
    const { response, body } = await jsonRequest<Partial<DeviceTokens>>(
      "/api/shiori-code/link/device/token",
      { method: "POST", body: JSON.stringify({ deviceCode: input.deviceCode }) },
    );
    if (response.ok && body?.token && body.refreshToken) {
      if (process.stdout.isTTY)
        process.stdout.write("\r✓ GitHub authorization complete.          \n");
      return { token: body.token, refreshToken: body.refreshToken };
    }
    if (response.status === 428) continue;
    if (response.status === 429) {
      intervalMs += 2_000;
      continue;
    }
    if (process.stdout.isTTY) process.stdout.write("\n");
    throw new Error(
      response.status === 410
        ? "The GitHub authorization code expired"
        : `GitHub authorization failed (${response.status})`,
    );
  }
  if (process.stdout.isTTY) process.stdout.write("\n");
  throw new Error("The GitHub authorization code expired");
}

function serviceLinkContext() {
  const layout = installedServiceLayout();
  if (layout.accountMode === "dedicated") requireServiceAdministrator(layout.platform);
  const store = new LinkRemoteStore({ stateDir: linkServiceStateDir(layout) });
  const client = new LinkControlPlaneClient({ store, origin: linkOrigin() });
  return { layout, store, client };
}

export async function connectLinkEnvironment(displayName: string): Promise<string> {
  const { layout, store, client } = serviceLinkContext();
  const authorization = await startDeviceAuthorization();
  console.log("\nConnect this ShioriCode server to your GitHub account:\n");
  console.log(`  ${authorization.verificationUriComplete}`);
  console.log(`\nCode: ${authorization.userCode}\n`);
  console.log("Open the URL on any computer. This command will wait here.");
  const tokens = await waitForDeviceAuthorization(authorization);
  store.setAccount({ accessToken: tokens.token, refreshToken: tokens.refreshToken });
  const connector = await client.provision({
    instanceId: store.instanceId,
    displayName: displayName.trim() || os.hostname() || "ShioriCode",
  });
  store.setConnector(connector);
  new RemoteStateStore({ stateDir: linkServiceStateDir(layout) }).set("shiori-link");
  await repairServiceStateOwnership(layout);
  await controlService("restart");
  return connector.endpoint;
}

export async function listLinkEnvironments(): Promise<string> {
  const { client } = serviceLinkContext();
  const environments = await client.list();
  if (environments.length === 0) return "No Link environments found.";
  return environments
    .map((environment) => {
      const connection = !environment.relay.reachable
        ? "relay unavailable"
        : environment.relay.online
          ? "online"
          : "offline";
      return `${environment.displayName}\n  ${environment.endpoint}\n  ${environment.status} · ${connection}`;
    })
    .join("\n\n");
}

export function linkStatus(): string {
  const { store } = serviceLinkContext();
  if (!store.account) return "GitHub account: not connected\nLink environment: not configured";
  const connector = store.connector;
  return connector
    ? `GitHub account: connected\nLink environment: ${connector.endpoint}`
    : "GitHub account: connected\nLink environment: not configured";
}

export async function disconnectLinkEnvironment(): Promise<string> {
  const { layout, store, client } = serviceLinkContext();
  const connector = store.connector;
  if (connector && store.account) await client.revoke(connector.environmentRecordId);
  store.clearAccount();
  new RemoteStateStore({ stateDir: linkServiceStateDir(layout) }).set("off");
  await repairServiceStateOwnership(layout);
  await controlService("restart");
  return "Disconnected GitHub and revoked this Link environment.";
}
