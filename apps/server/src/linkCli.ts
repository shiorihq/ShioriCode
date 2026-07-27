import { execFile as execFileCallback, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { LinkControlPlaneClient } from "./remote/linkClient";
import { LinkRemoteStore } from "./remote/linkStore";
import { RemoteStateStore } from "./remote/remoteStateStore";
import {
  controlService,
  installedServiceLayout,
  linkServiceStateDir,
  requireServiceAdministrator,
  serviceLayout,
  type ServiceLayout,
} from "./serviceManager";

const execFile = promisify(execFileCallback);

const DEFAULT_SHIORI_ORIGIN = "https://shiori.codes";
const REQUEST_TIMEOUT_MS = 15_000;
const LINK_SERVICE_CHILD_ENV = "SHIORICODE_LINK_SERVICE_CHILD";

export interface DeviceStartResponse {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresIn: number;
  readonly interval: number;
}

export interface DeviceTokens {
  readonly token: string;
  readonly refreshToken: string;
}

function linkOrigin(
  configured = process.env.SHIORICODE_LINK_API_URL ?? DEFAULT_SHIORI_ORIGIN,
): string {
  const origin = configured.trim().replace(/\/$/, "");
  if (
    origin.length === 0 ||
    origin.length > 2_048 ||
    ["\0", "\r", "\n"].some((character) => origin.includes(character))
  )
    throw new Error("Invalid ShioriCode Link API URL");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("Invalid ShioriCode Link API URL");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("Invalid ShioriCode Link API URL");
  }
  return origin;
}

async function jsonRequest<T>(
  pathname: string,
  init: RequestInit,
): Promise<{ readonly response: Response; readonly body: T | null }> {
  const response = await fetch(`${linkOrigin()}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Shiori-Client": "cli",
      ...init.headers,
    },
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

export async function waitForDeviceAuthorization(
  input: DeviceStartResponse,
): Promise<DeviceTokens> {
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
    let result: {
      readonly response: Response;
      readonly body: Partial<DeviceTokens> | null;
    };
    try {
      result = await jsonRequest<Partial<DeviceTokens>>("/api/shiori-code/link/device/token", {
        method: "POST",
        body: JSON.stringify({ deviceCode: input.deviceCode }),
      });
    } catch {
      // A device code remains valid across transient DNS, timeout, and connection
      // failures. Keep polling until the authorization server's deadline.
      continue;
    }
    const { response, body } = result;
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

export interface LinkServiceExecution {
  readonly layout: ServiceLayout;
  readonly serviceChild: boolean;
}

interface LinkServiceChildContext {
  readonly layout: ServiceLayout;
}

export interface LinkServiceChildValidation {
  readonly platform?: NodeJS.Platform;
  readonly effectiveUid?: number | undefined;
  readonly resolveUid?: (account: string) => Promise<number>;
}

async function resolveServiceAccountUid(account: string): Promise<number> {
  let stdout: string;
  try {
    ({ stdout } = await execFile("/usr/bin/id", ["-u", account], {
      encoding: "utf8",
    }));
  } catch {
    throw new Error(`Could not resolve the service account UID for ${account}`);
  }
  const value = stdout.trim();
  if (!/^\d+$/u.test(value))
    throw new Error(`Could not resolve the service account UID for ${account}`);
  const uid = Number(value);
  if (!Number.isSafeInteger(uid) || uid < 0)
    throw new Error(`Could not resolve the service account UID for ${account}`);
  return uid;
}

export async function decodeLinkServiceChildLayout(
  encoded = process.env[LINK_SERVICE_CHILD_ENV],
  validation: LinkServiceChildValidation = {},
): Promise<ServiceLayout | null> {
  if (!encoded) return null;
  if (encoded.length > 16 * 1024) throw new Error("Invalid Link service-child context");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid Link service-child context");
  }
  const candidate =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Partial<LinkServiceChildContext>).layout
      : undefined;
  const runtimePlatform = validation.platform ?? process.platform;
  if (
    !candidate ||
    (candidate.platform !== "linux" && candidate.platform !== "darwin") ||
    candidate.platform !== runtimePlatform ||
    (candidate.accountMode !== "dedicated" && candidate.accountMode !== "current") ||
    typeof candidate.account !== "string" ||
    typeof candidate.homeDir !== "string" ||
    typeof candidate.stateDir !== "string" ||
    typeof candidate.workspaceDir !== "string" ||
    typeof candidate.logPath !== "string" ||
    typeof candidate.servicePath !== "string" ||
    !path.posix.isAbsolute(candidate.homeDir) ||
    !path.posix.isAbsolute(candidate.stateDir) ||
    !path.posix.isAbsolute(candidate.workspaceDir) ||
    !path.posix.isAbsolute(candidate.logPath) ||
    ["\0", "\r", "\n"].some((character) =>
      `${candidate.account}${candidate.homeDir}${candidate.stateDir}${candidate.workspaceDir}${candidate.logPath}${candidate.servicePath}`.includes(
        character,
      ),
    )
  ) {
    throw new Error("Invalid Link service-child context");
  }
  const layout = serviceLayout(candidate.platform, {
    accountMode: candidate.accountMode,
    account: candidate.account,
    homeDir: candidate.homeDir,
    stateDir: candidate.stateDir,
    workspaceDir: candidate.workspaceDir,
    logPath: candidate.logPath,
    servicePath: candidate.servicePath,
    port: candidate.port,
  });
  const effectiveUid =
    validation.effectiveUid ??
    (typeof process.getuid === "function" ? process.getuid() : undefined);
  const accountUid = await (validation.resolveUid ?? resolveServiceAccountUid)(layout.account);
  if (effectiveUid === undefined || accountUid === 0 || effectiveUid !== accountUid) {
    throw new Error("Invalid Link service-child identity");
  }
  return layout;
}

async function resolveLinkServiceExecution(): Promise<LinkServiceExecution> {
  const childLayout = await decodeLinkServiceChildLayout();
  if (childLayout) return { layout: childLayout, serviceChild: true };
  const layout = await installedServiceLayout();
  if (layout.accountMode === "dedicated") requireServiceAdministrator(layout.platform);
  return { layout, serviceChild: false };
}

export function linkServiceChildCommand(
  layout: ServiceLayout,
  argv: readonly string[] = process.argv,
  origin = linkOrigin(),
): { readonly file: string; readonly args: readonly string[] } {
  if (layout.platform === "win32") throw new Error("Link service-child execution requires POSIX");
  if (!argv[1] || !path.posix.isAbsolute(argv[1]))
    throw new Error("Could not resolve the ShioriCode CLI entrypoint");
  const context = Buffer.from(
    JSON.stringify({ layout } satisfies LinkServiceChildContext),
    "utf8",
  ).toString("base64url");
  const environment = [
    "-i",
    "-u",
    "SUDO_USER",
    "-u",
    "SUDO_UID",
    "-u",
    "SUDO_GID",
    `${LINK_SERVICE_CHILD_ENV}=${context}`,
    `HOME=${layout.homeDir}`,
    `USER=${layout.account}`,
    `LOGNAME=${layout.account}`,
    `PATH=${layout.servicePath}`,
    `SHIORICODE_LINK_API_URL=${linkOrigin(origin)}`,
    process.execPath,
    ...argv.slice(1),
  ];
  return layout.platform === "linux"
    ? {
        file: "/usr/sbin/runuser",
        args: ["-u", layout.account, "--", "/usr/bin/env", ...environment],
      }
    : {
        file: "/usr/bin/sudo",
        args: ["-u", layout.account, "/usr/bin/env", ...environment],
      };
}

export function linkServiceAccountCommand(
  layout: ServiceLayout,
  file: string,
  args: readonly string[],
): { readonly file: string; readonly args: readonly string[] } {
  if (layout.platform === "win32") throw new Error("Link service-account execution requires POSIX");
  return layout.platform === "linux"
    ? {
        file: "/usr/sbin/runuser",
        args: ["-u", layout.account, "--", file, ...args],
      }
    : {
        file: "/usr/bin/sudo",
        args: ["-u", layout.account, file, ...args],
      };
}

async function assertLinkServiceChildAccess(layout: ServiceLayout): Promise<void> {
  const cliPath = process.argv[1];
  if (!cliPath || !path.posix.isAbsolute(cliPath))
    throw new Error("Could not resolve the ShioriCode CLI entrypoint");
  for (const [flag, candidate, label] of [
    ["-x", process.execPath, "runtime"],
    ["-r", cliPath, "CLI entrypoint"],
  ] as const) {
    const command = linkServiceAccountCommand(layout, "/usr/bin/test", [flag, candidate]);
    try {
      await execFile(command.file, [...command.args], { encoding: "utf8" });
    } catch {
      throw new Error(
        `The ${layout.account} service account cannot access the ShioriCode ${label}`,
      );
    }
  }
}

async function runLinkServiceChild(layout: ServiceLayout): Promise<void> {
  await assertLinkServiceChildAccess(layout);
  const command = linkServiceChildCommand(layout);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, [...command.args], {
      stdio: "inherit",
      windowsHide: true,
      shell: false,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Link service-child exited with ${signal ?? `code ${code ?? 1}`}`));
    });
  });
}

export interface LinkMutationReexecDependencies {
  readonly effectiveUid: () => number | undefined;
  readonly resolveUid: (account: string) => Promise<number>;
  readonly runChild: (layout: ServiceLayout) => Promise<void>;
  readonly restart: () => Promise<unknown>;
}

export function linkMutationRequiresServiceChild(
  layout: ServiceLayout,
  effectiveUid: number,
  accountUid: number,
): boolean {
  return layout.platform !== "win32" && effectiveUid !== accountUid;
}

export async function reexecLinkMutationIfNeeded(
  execution: LinkServiceExecution,
  dependencies: LinkMutationReexecDependencies = {
    effectiveUid: () => (typeof process.getuid === "function" ? process.getuid() : undefined),
    resolveUid: resolveServiceAccountUid,
    runChild: runLinkServiceChild,
    restart: async () => await controlService("restart"),
  },
): Promise<boolean> {
  const { layout } = execution;
  if (execution.serviceChild || layout.platform === "win32") {
    return false;
  }
  const effectiveUid = dependencies.effectiveUid();
  if (effectiveUid === undefined) throw new Error("Could not resolve the effective UID for Link");
  const accountUid = await dependencies.resolveUid(layout.account);
  if (!linkMutationRequiresServiceChild(layout, effectiveUid, accountUid)) return false;
  if (accountUid === 0) throw new Error("Refusing to run a Link service child as root");
  await dependencies.runChild(layout);
  await dependencies.restart();
  return true;
}

export interface LinkMutationDispatchDependencies {
  readonly resolveExecution: () => Promise<LinkServiceExecution>;
  readonly reexec: (execution: LinkServiceExecution) => Promise<boolean>;
}

export async function dispatchLinkMutation<T>(
  mutate: (execution: LinkServiceExecution) => Promise<T>,
  dependencies: LinkMutationDispatchDependencies = {
    resolveExecution: resolveLinkServiceExecution,
    reexec: reexecLinkMutationIfNeeded,
  },
): Promise<T | null> {
  const execution = await dependencies.resolveExecution();
  if (await dependencies.reexec(execution)) return null;
  try {
    return await mutate(execution);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (execution.layout.platform !== "win32" && (code === "EACCES" || code === "EPERM")) {
      throw new Error(
        `The ${execution.layout.account} service account cannot update Link state at ${linkServiceStateDir(execution.layout)}. Legacy files may still belong to an administrator; manually reassign or remove those files as an administrator. ShioriCode will not recursively change their ownership.`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function serviceLinkContext(
  input: { readonly readOnly?: boolean } = {},
  execution?: LinkServiceExecution,
) {
  const resolved = execution ?? (await resolveLinkServiceExecution());
  const { layout } = resolved;
  const store = new LinkRemoteStore({
    stateDir: linkServiceStateDir(layout),
    createIfMissing: input.readOnly !== true,
  });
  const client = new LinkControlPlaneClient({ store, origin: linkOrigin() });
  return { ...resolved, store, client };
}

export async function connectLinkEnvironment(
  displayName: string,
  dependencies?: LinkMutationDispatchDependencies,
): Promise<string | null> {
  return await dispatchLinkMutation(async (execution) => {
    const { layout, serviceChild, store, client } = await serviceLinkContext({}, execution);
    const authorization = await startDeviceAuthorization();
    console.log("\nConnect this ShioriCode server to your GitHub account:\n");
    console.log(`  ${authorization.verificationUriComplete}`);
    console.log(`\nCode: ${authorization.userCode}\n`);
    console.log("Open the URL on any computer. This command will wait here.");
    const tokens = await waitForDeviceAuthorization(authorization);
    store.setAccount({
      accessToken: tokens.token,
      refreshToken: tokens.refreshToken,
    });
    const connector = await client.provision({
      instanceId: store.instanceId,
      displayName: displayName.trim() || os.hostname() || "ShioriCode",
    });
    store.setConnector(connector);
    new RemoteStateStore({
      stateDir: linkServiceStateDir(layout),
    }).transitionWithoutTailscaleTeardown("shiori-link");
    if (!serviceChild) await controlService("restart");
    return connector.endpoint;
  }, dependencies);
}

export async function listLinkEnvironments(): Promise<string> {
  const { client } = await serviceLinkContext({ readOnly: true });
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

export async function linkStatus(): Promise<string> {
  const { store } = await serviceLinkContext({ readOnly: true });
  if (!store.account) return "GitHub account: not connected\nLink environment: not configured";
  const connector = store.connector;
  return connector
    ? `GitHub account: connected\nLink environment: ${connector.endpoint}`
    : "GitHub account: connected\nLink environment: not configured";
}

export async function disconnectLinkEnvironment(
  dependencies?: LinkMutationDispatchDependencies,
): Promise<string | null> {
  return await dispatchLinkMutation(async (execution) => {
    const { layout, serviceChild, store, client } = await serviceLinkContext({}, execution);
    const connector = store.connector;
    if (connector && store.account) await client.revoke(connector.environmentRecordId);
    store.clearAccount();
    const remoteState = new RemoteStateStore({
      stateDir: linkServiceStateDir(layout),
    });
    if (remoteState.method === "shiori-link") {
      remoteState.transitionWithoutTailscaleTeardown("off");
    }
    if (!serviceChild) await controlService("restart");
    return "Disconnected GitHub and revoked this Link environment.";
  }, dependencies);
}
