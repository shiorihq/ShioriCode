/**
 * RemoteAccess - drives the Settings ▸ Remote panel.
 *
 * Owns how this machine's server is exposed beyond loopback: Tailscale Serve
 * (private — only devices on the owner's tailnet) or Tailscale Funnel (a
 * public link, gated by the owner sign-in). Tailscale is deliberately the
 * only supported transport: it needs no ports, DNS, or certificates, and both
 * modes stay behind auth. The server keeps running locally; this only manages
 * what sits in front of it.
 *
 * Stability model:
 * - The owner's intent is persisted (`remote/remoteStateStore.ts`) and
 *   reconciled at startup, so exposure survives restarts and a drifted
 *   Tailscale config is re-applied instead of silently dropping.
 * - Auth flips live: enabling exposure raises `requireAuth` at runtime via
 *   `EnvironmentAuth.setRemoteExposed` — no `--remote` restart required. If
 *   credentials are missing at boot while exposure is desired, we fail closed
 *   by tearing the exposure down.
 * - Exposure mutations are serialized behind a lock so concurrent panel
 *   clicks can't interleave `serve reset`/apply calls.
 * - `/api/health` (public, side-effect free) carries a per-boot id so the
 *   connection test can verify a remote URL round-trips to THIS process.
 *
 * @module remote/RemoteAccess
 */
import { randomUUID } from "node:crypto";

import type {
  RemoteExposureMethod,
  RemoteProbeResult,
  RemoteSetExposureInput,
  RemoteStatus,
  RemoteTailscaleStatus,
} from "contracts";
import { RemoteError } from "contracts";
import { Effect, Layer, ServiceMap } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { EnvironmentAuth } from "../auth/EnvironmentAuth";
import { ServerConfig } from "../config";
import { RemoteStateStore } from "./remoteStateStore";
import {
  applyExposure,
  detectTailscale,
  findTailscaleCli,
  readServe,
  releaseServeIfOurs,
} from "./tailscale";

export interface RemoteAccessApi {
  getStatus(): Effect.Effect<RemoteStatus>;
  setExposure(input: RemoteSetExposureInput): Effect.Effect<RemoteStatus, RemoteError>;
  testConnection(): Effect.Effect<RemoteProbeResult>;
}

export class RemoteAccess extends ServiceMap.Service<RemoteAccess, RemoteAccessApi>()(
  "shiori/remote/RemoteAccess",
) {}

/** Identifies this server process; lets the probe prove a URL reaches us. */
export const SERVER_BOOT_ID = randomUUID();

/**
 * Public health endpoint used by the remote connection test (and generic
 * monitoring). Intentionally ungated: it reveals nothing but liveness and a
 * random per-boot id, and it must be reachable before login.
 */
export const remoteHealthRouteLayer = HttpRouter.add(
  "GET",
  "/api/health",
  Effect.succeed(
    HttpServerResponse.text(
      `${JSON.stringify({ status: "ok", service: "shioricode", bootId: SERVER_BOOT_ID })}\n`,
      { contentType: "application/json", headers: { "Cache-Control": "no-store" } },
    ),
  ),
);

async function probeUrl(url: string, bootId: string): Promise<RemoteProbeResult> {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
      headers: { Accept: "application/json" },
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        ok: false,
        url,
        latencyMs,
        error: `The URL responded with HTTP ${response.status} — the proxy is reachable but isn't forwarding to ShioriCode.`,
      };
    }
    const body = (await response.json().catch(() => null)) as { bootId?: string } | null;
    if (body?.bootId !== bootId) {
      return {
        ok: false,
        url,
        latencyMs,
        error: "The URL reached a server, but not this one — check what the proxy targets.",
      };
    }
    return { ok: true, url, latencyMs, error: null };
  } catch (cause) {
    const message =
      cause instanceof Error && cause.name === "TimeoutError"
        ? "Timed out after 8s — the URL isn't reachable from this machine."
        : cause instanceof Error
          ? cause.message
          : "Connection failed.";
    return { ok: false, url, latencyMs: null, error: message };
  }
}

function reachabilityFor(method: RemoteExposureMethod): RemoteStatus["reachability"] {
  if (method === "tailscale-funnel") return "public";
  if (method === "tailscale-serve") return "tailnet";
  return "loopback";
}

function noticeFor(input: {
  method: RemoteExposureMethod;
  desiredMethod: RemoteExposureMethod;
  requireAuth: boolean;
  authConfigured: boolean;
  tailscale: RemoteTailscaleStatus;
  url: string | null;
}): string | null {
  const exposed = input.method !== "off";
  if (exposed && !input.requireAuth) {
    return "Remote access is exposed with sign-in DISABLED — anyone who can reach this URL has full access to this machine.";
  }
  if (exposed && !input.authConfigured) {
    return "This machine is exposed but no sign-in is set. Set a username and password now.";
  }
  const desired = input.desiredMethod !== "off";
  if (desired && !input.tailscale.installed) {
    return "Remote access is turned on, but Tailscale is no longer installed on this machine.";
  }
  if (desired && !input.tailscale.running) {
    return "Tailscale isn't connected — open the Tailscale app or run `tailscale up`, then use Repair below.";
  }
  if (desired && input.method === "off") {
    return "Tailscale stopped serving ShioriCode (its config was reset elsewhere). Use Repair to turn it back on.";
  }
  if (exposed && input.url?.startsWith("http://")) {
    return "Served over HTTP (no TLS cert). Enable HTTPS on your tailnet for a padlock and the native iOS app.";
  }
  return null;
}

export const RemoteAccessLive = Layer.effect(
  RemoteAccess,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const auth = yield* EnvironmentAuth;
    const store = new RemoteStateStore({ stateDir: config.stateDir });
    const cli = findTailscaleCli();
    const port = config.port;

    // Serialize exposure mutations: concurrent clicks must not interleave
    // `serve reset` / apply calls.
    let mutationQueue: Promise<unknown> = Promise.resolve();
    const withExposureLock = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = mutationQueue.then(fn, fn);
      mutationQueue = run.catch(() => undefined);
      return run;
    };

    const buildStatus = async (): Promise<RemoteStatus> => {
      const desiredMethod = store.method;
      const [tailscale, serve] = await Promise.all([detectTailscale(cli), readServe(cli, port)]);

      const method: RemoteExposureMethod = serve.method;
      const url = serve.url;

      // Fail closed: exposure observed or desired means auth must be on. This
      // only ever raises; only an explicit "off" lowers it.
      if ((method !== "off" || desiredMethod !== "off") && auth.authConfigured) {
        auth.setRemoteExposed(true);
      }

      return {
        method,
        desiredMethod,
        enabled: method !== "off",
        url,
        reachability: reachabilityFor(method),
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
          method,
          desiredMethod,
          requireAuth: auth.requireAuth,
          authConfigured: auth.authConfigured,
          tailscale,
          url,
        }),
      };
    };

    const applyDesiredExposure = async (method: RemoteExposureMethod): Promise<RemoteStatus> => {
      if (method !== "off" && !auth.authConfigured && !config.unsafeNoAuth) {
        throw new Error("Set a username and password first — remote access requires a sign-in.");
      }
      if (method === "off") {
        await releaseServeIfOurs(cli, port);
      } else {
        const tailscale = await detectTailscale(cli);
        if (!tailscale.installed) {
          throw new Error("Tailscale isn't installed on this machine.");
        }
        if (!tailscale.running) {
          throw new Error(
            "Tailscale isn't connected — open the Tailscale app (or run `tailscale up`) and try again.",
          );
        }
        await applyExposure(cli, method, port, tailscale.httpsEnabled);
      }
      store.set(method);
      auth.setRemoteExposed(method !== "off");
      return await buildStatus();
    };

    /**
     * Startup reconcile. Synchronously restore the auth requirement so no
     * request races it, then (in the background, with retries for slow
     * tailscaled starts) re-apply a drifted Tailscale config.
     */
    const desiredAtBoot = store.method;
    if (desiredAtBoot !== "off") {
      if (auth.authConfigured || config.unsafeNoAuth) {
        auth.setRemoteExposed(true);
        const reconcileTailscale = Effect.gen(function* () {
          for (let attempt = 0; attempt < 8; attempt++) {
            const done = yield* Effect.promise(() =>
              withExposureLock(async () => {
                if (store.method !== desiredAtBoot) {
                  return true; // the owner changed exposure meanwhile; stand down
                }
                const [tailscale, serve] = await Promise.all([
                  detectTailscale(cli),
                  readServe(cli, port),
                ]);
                if (serve.method === desiredAtBoot) {
                  return true;
                }
                if (!tailscale.installed || !tailscale.running) {
                  return false; // wait for tailscaled to come up
                }
                try {
                  await applyExposure(cli, desiredAtBoot, port, tailscale.httpsEnabled);
                  return true;
                } catch {
                  return false;
                }
              }),
            );
            if (done) {
              return;
            }
            yield* Effect.sleep("15 seconds");
          }
          yield* Effect.logWarning("remote access: could not restore Tailscale exposure", {
            desired: desiredAtBoot,
          });
        });
        yield* Effect.forkDetach(reconcileTailscale);
      } else {
        // Fail closed: exposure was desired but the credentials are gone.
        // Tear the tunnel down rather than coming up reachable-but-open.
        store.set("off");
        yield* Effect.logWarning(
          "remote access: disabled at startup because no credentials are configured",
        );
        yield* Effect.forkDetach(
          Effect.promise(() => withExposureLock(() => releaseServeIfOurs(cli, port))),
        );
      }
    }

    return {
      getStatus: () => Effect.promise(() => buildStatus()),
      setExposure: (input) =>
        Effect.tryPromise({
          try: () => withExposureLock(() => applyDesiredExposure(input.method)),
          catch: (cause) =>
            new RemoteError({
              message: cause instanceof Error ? cause.message : "Failed to update remote access.",
              cause,
            }),
        }),
      testConnection: () =>
        Effect.promise(async () => {
          const url = (await readServe(cli, port)).url;
          if (!url) {
            return {
              ok: false,
              url: null,
              latencyMs: null,
              error: "Nothing to test yet — turn on remote access first.",
            } satisfies RemoteProbeResult;
          }
          return await probeUrl(url, SERVER_BOOT_ID);
        }),
    } satisfies RemoteAccessApi;
  }),
);
