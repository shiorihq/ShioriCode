/**
 * RemoteAccess - drives the Settings ▸ Remote panel.
 *
 * Reports how this machine's server is currently exposed (Tailscale Serve /
 * Funnel) and lets the UI switch it. The server keeps running locally; this only
 * manages the tunnel/proxy in front. Tailscale is driven by shelling out to its
 * CLI; detection is best-effort so the panel degrades gracefully when Tailscale
 * isn't installed.
 *
 * @module remote/RemoteAccess
 */
import { execFile } from "node:child_process";
import fs from "node:fs";

import type {
  RemoteExposureMethod,
  RemoteReachability,
  RemoteStatus,
  RemoteTailscaleStatus,
} from "contracts";
import { RemoteError } from "contracts";
import { Effect, Layer, ServiceMap } from "effect";

import { EnvironmentAuth } from "../auth/EnvironmentAuth";
import { ServerConfig } from "../config";

export interface RemoteAccessApi {
  getStatus(): Effect.Effect<RemoteStatus>;
  setExposure(method: RemoteExposureMethod): Effect.Effect<RemoteStatus, RemoteError>;
}

export class RemoteAccess extends ServiceMap.Service<RemoteAccess, RemoteAccessApi>()(
  "shiori/remote/RemoteAccess",
) {}

const TAILSCALE_CLI_CANDIDATES = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/bin/tailscale",
];

function findTailscaleCli(): string | null {
  for (const candidate of TAILSCALE_CLI_CANDIDATES) {
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

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(cli: string, args: ReadonlyArray<string>, timeoutMs: number): Promise<CliResult> {
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

async function detectTailscale(cli: string | null): Promise<RemoteTailscaleStatus> {
  if (!cli) {
    return { installed: false, running: false, dnsName: null, httpsEnabled: false };
  }
  const status = (await runJson(cli, ["status", "--json"], 8000)) as {
    BackendState?: string;
    Self?: { DNSName?: string };
    CertDomains?: ReadonlyArray<string>;
  } | null;
  if (!status) {
    return { installed: true, running: false, dnsName: null, httpsEnabled: false };
  }
  const dnsName =
    typeof status.Self?.DNSName === "string" ? status.Self.DNSName.replace(/\.$/, "") : null;
  return {
    installed: true,
    running: status.BackendState === "Running",
    dnsName,
    httpsEnabled: Array.isArray(status.CertDomains) && status.CertDomains.length > 0,
  };
}

/** Read the current serve config, but only report it when it targets OUR port. */
async function readServe(
  cli: string | null,
  port: number,
): Promise<{ method: RemoteExposureMethod; url: string | null }> {
  if (!cli) {
    return { method: "off", url: null };
  }
  const result = await runCli(cli, ["serve", "status"], 8000);
  const text = result.stdout.trim();
  if (result.code !== 0 || !text || /no serve config/i.test(text)) {
    return { method: "off", url: null };
  }
  const targetsOurPort = text.includes(`127.0.0.1:${port}`) || text.includes(`localhost:${port}`);
  if (!targetsOurPort) {
    return { method: "off", url: null };
  }
  const urlMatch = text.match(/https?:\/\/[^\s(]+/);
  const url = urlMatch ? urlMatch[0].replace(/\/+$/, "") : null;
  const method: RemoteExposureMethod = /funnel/i.test(text)
    ? "tailscale-funnel"
    : "tailscale-serve";
  return { method, url };
}

async function applyExposure(
  cli: string | null,
  method: RemoteExposureMethod,
  port: number,
  httpsEnabled: boolean,
): Promise<void> {
  if (!cli) {
    throw new Error("Tailscale isn't installed on this machine.");
  }
  // Clear any existing serve/funnel config before applying the new one.
  await runCli(cli, ["serve", "reset"], 10_000);
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

function reachabilityFor(method: RemoteExposureMethod): RemoteReachability {
  if (method === "tailscale-funnel") return "public";
  if (method === "tailscale-serve") return "tailnet";
  return "loopback";
}

function noticeFor(input: {
  method: RemoteExposureMethod;
  requireAuth: boolean;
  tailscale: RemoteTailscaleStatus;
  url: string | null;
}): string | null {
  if (!input.requireAuth && input.method === "off") {
    return "Restart ShioriCode with `--remote` or `--require-auth` before exposing it beyond this Mac.";
  }
  if (!input.requireAuth && input.method !== "off") {
    return "Remote access is exposed, but this server was not started with remote authentication enabled.";
  }
  if (!input.tailscale.installed) {
    return "Tailscale isn't installed. Install it to expose this machine privately.";
  }
  if (input.method !== "off" && !input.tailscale.running) {
    return "Tailscale is exposed but the daemon isn't connected — run `tailscale up`.";
  }
  if (input.method !== "off" && input.url?.startsWith("http://")) {
    return "Served over HTTP (no TLS cert). Enable HTTPS on your tailnet for a padlock and the native iOS app.";
  }
  return null;
}

export const RemoteAccessLive = Layer.effect(
  RemoteAccess,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const auth = yield* EnvironmentAuth;
    const cli = findTailscaleCli();
    const port = config.port;

    const buildStatus = async (): Promise<RemoteStatus> => {
      const [tailscale, serve] = await Promise.all([detectTailscale(cli), readServe(cli, port)]);
      return {
        method: serve.method,
        enabled: serve.method !== "off",
        url: serve.url,
        reachability: reachabilityFor(serve.method),
        requireAuth: auth.requireAuth,
        authConfigured: auth.authConfigured,
        username: auth.username,
        port,
        tailscale,
        sessions: auth.listSessions().map((session) => ({
          id: session.id,
          username: session.username,
          label: session.label,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          lastSeenAt: session.lastSeenAt,
        })),
        notice: noticeFor({
          method: serve.method,
          requireAuth: auth.requireAuth,
          tailscale,
          url: serve.url,
        }),
      };
    };

    return {
      getStatus: () => Effect.promise(() => buildStatus()),
      setExposure: (method) =>
        Effect.tryPromise({
          try: async () => {
            if (method !== "off" && !auth.requireAuth && !config.unsafeNoAuth) {
              throw new Error(
                "Restart ShioriCode with `--remote` or `--require-auth` before exposing it.",
              );
            }
            if (method !== "off" && !auth.authConfigured && !config.unsafeNoAuth) {
              throw new Error("Set owner credentials before exposing this server.");
            }
            const tailscale = await detectTailscale(cli);
            await applyExposure(cli, method, port, tailscale.httpsEnabled);
            return await buildStatus();
          },
          catch: (cause) =>
            new RemoteError({
              message: cause instanceof Error ? cause.message : "Failed to update remote access.",
              cause,
            }),
        }),
    } satisfies RemoteAccessApi;
  }),
);
