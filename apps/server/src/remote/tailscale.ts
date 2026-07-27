/**
 * Tailscale CLI integration for remote access.
 *
 * Discovery, status detection, and serve/funnel management by shelling out to
 * the `tailscale` CLI. Parsing prefers `serve status --json` (stable machine
 * format) and falls back to the human-readable text output for older CLIs; the
 * parsers are pure and exported for tests. Everything degrades gracefully when
 * Tailscale isn't installed.
 *
 * @module remote/tailscale
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { RemoteTailscaleStatus } from "contracts";

const PLATFORM_CLI_CANDIDATES = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/bin/tailscale",
  "/usr/sbin/tailscale",
  "C:\\Program Files\\Tailscale\\tailscale.exe",
];

export function findTailscaleCli(): string | null {
  const executable = process.platform === "win32" ? "tailscale.exe" : "tailscale";
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const candidates = [
    ...pathDirs.map((dir) => path.join(dir, executable)),
    ...PLATFORM_CLI_CANDIDATES,
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore and try the next candidate
    }
  }
  return null;
}

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runCli(
  cli: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      cli,
      args as string[],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code as number)
            : error
              ? 1
              : 0;
        resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
      },
    );
  });
}

/** Allow a dedicated daemon account to manage Tailscale on Linux. */
export async function setTailscaleOperator(cli: string | null, account: string): Promise<void> {
  if (!cli) {
    throw new Error(
      "Tailscale isn't installed. Install it and run `tailscale up` before enabling remote access.",
    );
  }
  const result = await runCli(cli, ["set", `--operator=${account}`], 15_000);
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || `Could not grant Tailscale operator access to ${account}.`,
    );
  }
}

async function runJson(
  cli: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<unknown | null> {
  const result = await runCli(cli, args, timeoutMs);
  if (result.code !== 0 || !result.stdout.trim()) {
    return null;
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return null;
  }
}

export async function detectTailscale(cli: string | null): Promise<RemoteTailscaleStatus> {
  if (!cli) {
    return {
      installed: false,
      running: false,
      backendState: null,
      dnsName: null,
      httpsEnabled: false,
    };
  }
  const status = (await runJson(cli, ["status", "--json"], 8000)) as {
    BackendState?: string;
    Self?: { DNSName?: string };
    CertDomains?: ReadonlyArray<string>;
  } | null;
  if (!status) {
    return {
      installed: true,
      running: false,
      backendState: null,
      dnsName: null,
      httpsEnabled: false,
    };
  }
  const dnsName =
    typeof status.Self?.DNSName === "string" ? status.Self.DNSName.replace(/\.$/, "") : null;
  return {
    installed: true,
    running: status.BackendState === "Running",
    backendState: typeof status.BackendState === "string" ? status.BackendState : null,
    dnsName,
    httpsEnabled: Array.isArray(status.CertDomains) && status.CertDomains.length > 0,
  };
}

export interface TailscaleSelfInfo {
  readonly running: boolean;
  readonly dnsName: string | null;
  readonly tailscaleIPv4: string | null;
}

/** This machine's tailnet addresses, for mobile pairing candidates. */
export async function detectTailscaleSelf(cli: string | null): Promise<TailscaleSelfInfo> {
  if (!cli) {
    return { running: false, dnsName: null, tailscaleIPv4: null };
  }
  const status = (await runJson(cli, ["status", "--json"], 8000)) as {
    BackendState?: string;
    Self?: { DNSName?: string; TailscaleIPs?: ReadonlyArray<string> };
  } | null;
  if (!status) {
    return { running: false, dnsName: null, tailscaleIPv4: null };
  }
  const dnsName =
    typeof status.Self?.DNSName === "string" ? status.Self.DNSName.replace(/\.$/, "") : null;
  const ips = Array.isArray(status.Self?.TailscaleIPs) ? status.Self.TailscaleIPs : [];
  const tailscaleIPv4 =
    ips.find((ip) => typeof ip === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? null;
  return { running: status.BackendState === "Running", dnsName, tailscaleIPv4 };
}

export interface ServeObservation {
  readonly method: "off" | "tailscale-serve" | "tailscale-funnel";
  readonly url: string | null;
}

const OFF: ServeObservation = { method: "off", url: null };

/** Whether a serve proxy target (e.g. "http://127.0.0.1:3773") is our port. */
function proxyTargetsPort(proxy: string, port: number): boolean {
  try {
    const url = new URL(proxy);
    const hostname = url.hostname.toLowerCase();
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]") &&
      Number(url.port || (url.protocol === "https:" ? 443 : 80)) === port
    );
  } catch {
    return false;
  }
}

function textTargetsPort(text: string, port: number): boolean {
  const urls = text.match(/https?:\/\/[^\s()]+/gi) ?? [];
  return urls.some((url) => proxyTargetsPort(url.replace(/[,;]+$/, ""), port));
}

function urlForHostPort(hostPort: string): string | null {
  const match = /^(.+):(\d+)$/.exec(hostPort);
  if (!match) {
    return null;
  }
  const [, host, servePort] = match;
  if (servePort === "443") return `https://${host}`;
  if (servePort === "80") return `http://${host}`;
  // Non-default ports: 443-adjacent ports are still TLS in serve configs.
  return `https://${host}:${servePort}`;
}

/**
 * Parse `tailscale serve status --json` output (a ServeConfig object). Only
 * reports a config that proxies to OUR port; anything else is someone else's.
 */
export function parseServeStatusJson(config: unknown, port: number): ServeObservation {
  if (typeof config !== "object" || config === null) {
    return OFF;
  }
  const record = config as {
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
    AllowFunnel?: Record<string, boolean>;
  };
  for (const [hostPort, entry] of Object.entries(record.Web ?? {})) {
    const handlers = entry?.Handlers ?? {};
    const proxy = handlers["/"]?.Proxy;
    if (typeof proxy !== "string" || !proxyTargetsPort(proxy, port)) {
      continue;
    }
    const url = urlForHostPort(hostPort);
    const funnel = record.AllowFunnel?.[hostPort] === true;
    return { method: funnel ? "tailscale-funnel" : "tailscale-serve", url };
  }
  return OFF;
}

/** Fallback parser for the human-readable `tailscale serve status` output. */
export function parseServeStatusText(text: string, port: number): ServeObservation {
  const trimmed = text.trim();
  if (!trimmed || /no serve config/i.test(trimmed)) {
    return OFF;
  }
  if (!textTargetsPort(trimmed, port)) {
    return OFF;
  }
  const urlMatch = trimmed.match(/https?:\/\/[^\s(]+/);
  const url = urlMatch ? urlMatch[0].replace(/\/+$/, "") : null;
  return { method: /funnel/i.test(trimmed) ? "tailscale-funnel" : "tailscale-serve", url };
}

/** Read the current serve config, but only report it when it targets OUR port. */
export async function readServe(cli: string | null, port: number): Promise<ServeObservation> {
  return (await readServeConfirmed(cli, port)) ?? OFF;
}

/**
 * Read serve state without collapsing CLI/daemon failures into "off". Used by
 * fail-closed teardown, where only a successful status response can prove that
 * a persisted funnel is gone.
 */
export async function readServeConfirmed(
  cli: string | null,
  port: number,
): Promise<ServeObservation | null> {
  if (!cli) {
    return null;
  }
  const jsonResult = await runCli(cli, ["serve", "status", "--json"], 8000);
  if (jsonResult.code === 0 && jsonResult.stdout.trim()) {
    try {
      return parseServeStatusJson(JSON.parse(jsonResult.stdout) as unknown, port);
    } catch {
      // Fall through to the text command. Older versions can print non-JSON
      // diagnostics even when the process exits successfully.
    }
  }
  const result = await runCli(cli, ["serve", "status"], 8000);
  if (result.code !== 0) {
    return null;
  }
  return parseServeStatusText(result.stdout, port);
}

/**
 * Point Tailscale Serve/Funnel at our port (clearing whatever was there), or
 * clear it for "off". Throws with an owner-readable message on failure.
 */
export async function applyExposure(
  cli: string | null,
  method: "off" | "tailscale-serve" | "tailscale-funnel",
  port: number,
  httpsEnabled: boolean,
): Promise<void> {
  if (!cli) {
    throw new Error("Tailscale isn't installed on this machine.");
  }
  // Clear any existing serve/funnel config before applying the new one.
  const reset = await runCli(cli, ["serve", "reset"], 10_000);
  if (reset.code !== 0) {
    throw new Error(reset.stderr.trim() || "Failed to reset the existing Tailscale Serve config.");
  }
  if (method === "off") {
    return;
  }
  if (method === "tailscale-funnel") {
    if (!httpsEnabled) {
      throw new Error(
        "Public access (Funnel) needs HTTPS certificates enabled on your tailnet first.",
      );
    }
    const result = await runCli(
      cli,
      ["funnel", "--bg", "--https=443", `127.0.0.1:${port}`],
      60_000,
    );
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "Failed to start Tailscale Funnel.");
    }
    return;
  }
  // tailscale-serve: HTTPS when the tailnet supports certs, otherwise HTTP
  // (still WireGuard-encrypted on the wire). Never run --https without certs:
  // it blocks indefinitely trying to provision one.
  const args = httpsEnabled
    ? ["serve", "--bg", "--https=443", `127.0.0.1:${port}`]
    : ["serve", "--bg", "--http=80", `127.0.0.1:${port}`];
  const result = await runCli(cli, args, 60_000);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "Failed to start Tailscale Serve.");
  }
}

/** Clear the serve config, but only when it currently targets our port. */
export async function releaseServeIfOurs(cli: string | null, port: number): Promise<void> {
  if (!cli) {
    return;
  }
  const observed = await readServe(cli, port);
  if (observed.method !== "off") {
    const result = await runCli(cli, ["serve", "reset"], 10_000);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "Failed to turn off Tailscale remote access.");
    }
  }
}
