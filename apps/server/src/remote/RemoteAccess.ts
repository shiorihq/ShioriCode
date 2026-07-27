/**
 * RemoteAccess - drives the Settings ▸ Remote panel.
 *
 * Owns how this machine's server is exposed beyond loopback: Tailscale Serve
 * (private — only devices on the owner's tailnet), Tailscale Funnel, or the
 * hosted ShioriCode Link relay. Every transport is outbound-only and stays
 * behind the environment owner sign-in. The server keeps running locally;
 * this only manages what sits in front of it.
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
  RemoteBeginLinkSignInInput,
  RemoteBeginLinkSignInResult,
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
  LinkRemote,
  type LinkAuthCallbackInput,
  type LinkHostedAccessPrincipal,
} from "./LinkRemote";
import {
  applyExposure,
  detectTailscale,
  findTailscaleCli,
  readServe,
  readServeConfirmed,
  releaseServeIfOurs,
} from "./tailscale";

export interface RemoteAccessApi {
  getStatus(): Effect.Effect<RemoteStatus>;
  setExposure(input: RemoteSetExposureInput): Effect.Effect<RemoteStatus, RemoteError>;
  beginLinkSignIn(
    input: RemoteBeginLinkSignInInput,
  ): Effect.Effect<RemoteBeginLinkSignInResult, RemoteError>;
  completeLinkSignIn(input: LinkAuthCallbackInput): Effect.Effect<void, RemoteError>;
  linkHostedAccessAvailable(): Effect.Effect<boolean>;
  beginLinkHostedAccess(state: string): Effect.Effect<string, RemoteError>;
  exchangeLinkHostedAccess(code: string): Effect.Effect<LinkHostedAccessPrincipal, RemoteError>;
  disconnectLinkAccount(): Effect.Effect<RemoteStatus, RemoteError>;
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
  if (method === "tailscale-funnel" || method === "shiori-link") return "public";
  if (method === "tailscale-serve") return "tailnet";
  return "loopback";
}

function noticeFor(input: {
  method: RemoteExposureMethod;
  desiredMethod: RemoteExposureMethod;
  requireAuth: boolean;
  authConfigured: boolean;
  tailscale: RemoteTailscaleStatus;
  link: RemoteStatus["link"];
  url: string | null;
}): string | null {
  const exposed = input.method !== "off";
  if (exposed && !input.requireAuth) {
    return "Remote access is exposed with sign-in DISABLED — anyone who can reach this URL has full access to this machine.";
  }
  if (exposed && !input.authConfigured) {
    return "This machine is exposed but no sign-in is set. Set a username and password now.";
  }
  const desiredTailscale =
    input.desiredMethod === "tailscale-serve" || input.desiredMethod === "tailscale-funnel";
  if (input.desiredMethod === "shiori-link" && !input.link.accountLinked) {
    return "Sign in to Shiori to restore this link environment.";
  }
  if (input.desiredMethod === "shiori-link" && input.method === "off") {
    return input.link.lastError ?? "The link connector is not running. Use Repair below.";
  }
  if (desiredTailscale && !input.tailscale.installed) {
    return "Remote access is turned on, but Tailscale is no longer installed on this machine.";
  }
  if (desiredTailscale && !input.tailscale.running) {
    return "Tailscale isn't connected — open the Tailscale app or run `tailscale up`, then use Repair below.";
  }
  if (desiredTailscale && input.method === "off") {
    return "Tailscale stopped serving ShioriCode (its config was reset elsewhere). Use Repair to turn it back on.";
  }
  if (exposed && input.url?.startsWith("http://")) {
    return "Served over HTTP (no TLS cert). Enable HTTPS on your tailnet for a padlock and the native iOS app.";
  }
  return null;
}

export function isAuthenticationConfiguredForExposure(input: {
  readonly method: RemoteExposureMethod;
  readonly localAuthConfigured: boolean;
  readonly linkHostedAccessConfigured: boolean;
}): boolean {
  return (
    input.localAuthConfigured ||
    (input.method === "shiori-link" && input.linkHostedAccessConfigured)
  );
}

export function remoteStartupCleanupDecision(input: {
  readonly desiredMethod: RemoteExposureMethod;
  readonly stateNeedsCleanup: boolean;
  readonly requiresTailscaleConfirmation: boolean;
  readonly authenticationConfigured: boolean;
  readonly unsafeNoAuth: boolean;
  readonly connectorCleanupRequired: boolean;
}): { readonly cleanupRequired: boolean; readonly connectorOnlyCleanup: boolean } {
  const connectorOnlyCleanup =
    input.desiredMethod === "off" &&
    input.connectorCleanupRequired &&
    !input.stateNeedsCleanup &&
    !input.requiresTailscaleConfirmation;
  return {
    connectorOnlyCleanup,
    cleanupRequired:
      input.stateNeedsCleanup ||
      (input.desiredMethod === "off" && input.requiresTailscaleConfirmation) ||
      (input.desiredMethod === "off" && input.connectorCleanupRequired) ||
      (input.desiredMethod !== "off" && !input.authenticationConfigured && !input.unsafeNoAuth),
  };
}

export interface ExposureTeardownDependencies {
  readonly detect: typeof detectTailscale;
  readonly release: typeof releaseServeIfOurs;
  readonly observe: typeof readServeConfirmed;
}

const defaultExposureTeardownDependencies: ExposureTeardownDependencies = {
  detect: detectTailscale,
  release: releaseServeIfOurs,
  observe: readServeConfirmed,
};

/**
 * Stop every exposure transport and prove Tailscale Serve is cleared. A CLI
 * that is absent or cannot reach tailscaled is uncertainty, not evidence that
 * a persisted serve/funnel configuration is off.
 */
export async function teardownExposureOnce(
  input: {
    readonly cli: string | null;
    readonly port: number;
    readonly disableLink: () => Promise<void>;
    readonly requireTailscaleConfirmation?: boolean;
  },
  dependencies: ExposureTeardownDependencies = defaultExposureTeardownDependencies,
): Promise<boolean> {
  await input.disableLink();
  const confirmationRequired = input.requireTailscaleConfirmation ?? true;
  if (!input.cli) {
    return !confirmationRequired;
  }
  const tailscale = await dependencies.detect(input.cli);
  if (!tailscale.installed || !tailscale.running) {
    return !confirmationRequired;
  }
  const before = await dependencies.observe(input.cli, input.port);
  if (before === null) {
    return !confirmationRequired;
  }
  if (before.method === "off") {
    return true;
  }
  await dependencies.release(input.cli, input.port);
  return (await dependencies.observe(input.cli, input.port))?.method === "off";
}

export async function disableExposureSafely(
  input: {
    readonly cli: string | null;
    readonly port: number;
    readonly requireTailscaleConfirmation: boolean;
    readonly disableLink: () => Promise<void>;
    readonly persistOff: () => void;
    readonly lowerAuth: () => void;
  },
  dependencies: ExposureTeardownDependencies = defaultExposureTeardownDependencies,
): Promise<void> {
  const cleared = await teardownExposureOnce(
    {
      cli: input.cli,
      port: input.port,
      disableLink: async () => undefined,
      requireTailscaleConfirmation: input.requireTailscaleConfirmation,
    },
    dependencies,
  );
  if (!cleared) {
    throw new Error(
      "Tailscale is not reachable, so remote exposure could not be confirmed off. Authentication remains required; start Tailscale and try again.",
    );
  }
  await input.disableLink();
  input.persistOff();
  input.lowerAuth();
}

/**
 * Preserve old Tailscale exposure provenance until a Link transition has
 * positively cleared it. An already-persisted legacy Link intent may keep
 * running with auth raised, but it is not migrated to trusted state until the
 * confirmation succeeds.
 */
export async function persistLinkIntentAfterTailscaleTeardown(
  input: {
    readonly cli: string | null;
    readonly port: number;
    readonly requiresTailscaleConfirmation: boolean;
    readonly mayRetainExistingLinkIntent: boolean;
    readonly persistLinkIntent: () => void;
  },
  dependencies: ExposureTeardownDependencies = defaultExposureTeardownDependencies,
): Promise<void> {
  if (!input.requiresTailscaleConfirmation) {
    input.persistLinkIntent();
    return;
  }
  const cleared = await teardownExposureOnce(
    {
      cli: input.cli,
      port: input.port,
      disableLink: async () => undefined,
      requireTailscaleConfirmation: true,
    },
    dependencies,
  );
  if (!cleared) {
    if (input.mayRetainExistingLinkIntent) return;
    throw new Error(
      "Tailscale is not reachable, so its previous exposure could not be confirmed off. Authentication remains required; start Tailscale and try again.",
    );
  }
  input.persistLinkIntent();
}

export const RemoteAccessLive = Layer.effect(
  RemoteAccess,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const auth = yield* EnvironmentAuth;
    const store = new RemoteStateStore({ stateDir: config.stateDir });
    const link = new LinkRemote({ stateDir: config.stateDir, localPort: config.port });
    yield* Effect.addFinalizer(() => Effect.promise(() => link.dispose()));
    // Tailscale may be installed after ShioriCode starts, especially on a
    // freshly provisioned headless host. Re-discover it until it appears.
    let discoveredCli = findTailscaleCli();
    const tailscaleCli = () => (discoveredCli ??= findTailscaleCli());
    const port = config.port;

    // Serialize exposure mutations: concurrent clicks must not interleave
    // `serve reset` / apply calls.
    let mutationQueue: Promise<unknown> = Promise.resolve();
    const withExposureLock = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = mutationQueue.then(fn, fn);
      mutationQueue = run.catch(() => undefined);
      return run;
    };

    const hasConfiguredAuthFor = (method: RemoteExposureMethod): boolean =>
      isAuthenticationConfiguredForExposure({
        method,
        localAuthConfigured: auth.authConfigured,
        linkHostedAccessConfigured: link.hostedAccessConfigured,
      });

    const buildStatus = async (): Promise<RemoteStatus> => {
      const cli = tailscaleCli();
      const desiredMethod = store.method;
      const [tailscale, serve] = await Promise.all([detectTailscale(cli), readServe(cli, port)]);
      const linkStatus = link.status();
      const method: RemoteExposureMethod = linkStatus.connectorRunning
        ? "shiori-link"
        : serve.method;
      const url = method === "shiori-link" ? linkStatus.endpoint : serve.url;
      const authConfigured = hasConfiguredAuthFor(method) || hasConfiguredAuthFor(desiredMethod);

      // Fail closed: exposure observed or desired means auth must be on. This
      // only ever raises; only an explicit "off" lowers it.
      if (method !== "off" || desiredMethod !== "off" || link.managedProcessCleanupRequired) {
        auth.setRemoteExposed(true);
      }

      return {
        method,
        desiredMethod,
        enabled: method !== "off",
        url,
        reachability: reachabilityFor(method),
        requireAuth: auth.requireAuth,
        authConfigured,
        username: auth.username,
        port,
        link: linkStatus,
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
          authConfigured,
          tailscale,
          link: linkStatus,
          url,
        }),
      };
    };

    const applyDesiredExposure = async (method: RemoteExposureMethod): Promise<RemoteStatus> => {
      const cli = tailscaleCli();
      const previousMethod = store.method;
      const linkAccountCanAuthenticate = method === "shiori-link" && link.status().accountLinked;
      if (
        method !== "off" &&
        !auth.authConfigured &&
        !linkAccountCanAuthenticate &&
        !config.unsafeNoAuth
      ) {
        throw new Error("Set a username and password first — remote access requires a sign-in.");
      }
      let tailscale: RemoteTailscaleStatus | null = null;
      if (method === "tailscale-serve" || method === "tailscale-funnel") {
        tailscale = await detectTailscale(cli);
        if (!tailscale.installed) {
          throw new Error("Tailscale isn't installed on this machine.");
        }
        if (!tailscale.running) {
          throw new Error(
            "Tailscale isn't connected — open the Tailscale app (or run `tailscale up`) and try again.",
          );
        }
      }
      if (method !== "off") {
        // Raise auth before any transport transition. Durable intent is written
        // in each branch before its corresponding external transport starts.
        auth.setRemoteExposed(true);
      }
      if (method === "off") {
        const tailscaleMustBeConfirmed =
          store.needsCleanup ||
          store.requiresTailscaleConfirmation ||
          store.method === "tailscale-serve" ||
          store.method === "tailscale-funnel" ||
          cli !== null;
        await disableExposureSafely({
          cli,
          port,
          requireTailscaleConfirmation: tailscaleMustBeConfirmed,
          disableLink: () => link.disable(),
          persistOff: () => store.setReconciled("off"),
          lowerAuth: () => auth.setRemoteExposed(false),
        });
      } else if (method === "shiori-link") {
        const requiresConfirmedTransition =
          store.needsCleanup ||
          store.requiresTailscaleConfirmation ||
          previousMethod === "tailscale-serve" ||
          previousMethod === "tailscale-funnel";
        await persistLinkIntentAfterTailscaleTeardown({
          cli,
          port,
          requiresTailscaleConfirmation: requiresConfirmedTransition,
          mayRetainExistingLinkIntent:
            previousMethod === "shiori-link" &&
            store.requiresTailscaleConfirmation &&
            !store.needsCleanup,
          persistLinkIntent: () => store.setReconciled(method),
        });
        await link.enable();
      } else {
        if (!tailscale) {
          throw new Error("Could not inspect Tailscale before enabling remote access.");
        }
        // Persist intent before applying the network boundary. A failed write
        // must leave the current transport untouched.
        store.setReconciled(method);
        await applyExposure(cli, method, port, tailscale.httpsEnabled);
        await link.disable();
      }
      return await buildStatus();
    };

    /**
     * Startup reconcile. Synchronously restore the auth requirement so no
     * request races it, then (in the background, with retries for slow
     * tailscaled starts) re-apply a drifted Tailscale config.
     */
    const desiredAtBoot = store.method;
    const stateRevisionAtBoot = store.revision;
    const connectorCleanupAtBoot = link.managedProcessCleanupRequired;
    const startupCleanup = remoteStartupCleanupDecision({
      desiredMethod: desiredAtBoot,
      stateNeedsCleanup: store.needsCleanup,
      requiresTailscaleConfirmation: store.requiresTailscaleConfirmation,
      authenticationConfigured: hasConfiguredAuthFor(desiredAtBoot),
      unsafeNoAuth: config.unsafeNoAuth,
      connectorCleanupRequired: connectorCleanupAtBoot,
    });
    const cleanupAtBoot = startupCleanup.cleanupRequired;
    const connectorOnlyCleanupAtBoot = startupCleanup.connectorOnlyCleanup;
    if (cleanupAtBoot) {
      // Raise auth synchronously and retain the persisted intent until every
      // transport is confirmed off. If tailscaled is still starting, retry;
      // never interpret an unreachable daemon as an empty serve config.
      auth.setRemoteExposed(true);
      yield* Effect.logWarning(
        store.needsCleanup
          ? "remote access: persisted state is unreadable; confirming exposure is disabled"
          : desiredAtBoot === "off" && store.requiresTailscaleConfirmation
            ? "remote access: legacy exposure state needs confirmed cleanup"
            : desiredAtBoot === "off" && connectorCleanupAtBoot
              ? "remote access: a prior Link connector process needs confirmed cleanup"
              : "remote access: credentials are missing; confirming exposure is disabled",
      );
      const reconcileTeardown = Effect.gen(function* () {
        for (let attempt = 0; attempt < 8; attempt++) {
          const done = yield* Effect.promise(() =>
            withExposureLock(async () => {
              if (store.revision !== stateRevisionAtBoot) {
                return true; // the owner chose a new state while cleanup waited
              }
              try {
                const cleared = await teardownExposureOnce({
                  cli: tailscaleCli(),
                  port,
                  disableLink: () => link.disable(),
                  // A trusted `off` state plus only a connector record does
                  // not invent Tailscale uncertainty. Every other teardown,
                  // including a desired Serve/Funnel with missing auth, must
                  // still prove Tailscale is off before auth can be lowered.
                  requireTailscaleConfirmation: !connectorOnlyCleanupAtBoot,
                });
                if (cleared) {
                  store.setReconciled("off");
                  auth.setRemoteExposed(false);
                }
                return cleared;
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
        yield* Effect.logWarning(
          "remote access: exposure could not be confirmed off; authentication remains required",
          { desired: desiredAtBoot },
        );
      });
      yield* Effect.forkDetach(reconcileTeardown);
    } else if (desiredAtBoot !== "off") {
      if (hasConfiguredAuthFor(desiredAtBoot) || config.unsafeNoAuth) {
        auth.setRemoteExposed(true);
        const reconcileExposure = Effect.gen(function* () {
          for (let attempt = 0; attempt < 8; attempt++) {
            const done = yield* Effect.promise(() =>
              withExposureLock(async () => {
                if (store.method !== desiredAtBoot) {
                  return true; // the owner changed exposure meanwhile; stand down
                }
                if (desiredAtBoot === "shiori-link") {
                  const restored = link.running || (await link.restore());
                  if (store.requiresTailscaleConfirmation) {
                    const cleared = await teardownExposureOnce({
                      cli: tailscaleCli(),
                      port,
                      disableLink: async () => undefined,
                      requireTailscaleConfirmation: true,
                    });
                    if (!cleared) return false;
                    store.setReconciled("shiori-link");
                  }
                  return restored;
                }
                // A verified connector record can outlive the parent server.
                // Clear it before considering a desired Tailscale transport
                // reconciled, even when remote state itself was trustworthy.
                if (link.managedProcessCleanupRequired) {
                  try {
                    await link.disable();
                  } catch {
                    return false;
                  }
                }
                const [tailscale, serve] = await Promise.all([
                  detectTailscale(tailscaleCli()),
                  readServe(tailscaleCli(), port),
                ]);
                if (serve.method === desiredAtBoot) {
                  if (store.requiresTailscaleConfirmation) {
                    store.setReconciled(desiredAtBoot);
                  }
                  return true;
                }
                if (!tailscale.installed || !tailscale.running) {
                  return false; // wait for tailscaled to come up
                }
                try {
                  await applyExposure(tailscaleCli(), desiredAtBoot, port, tailscale.httpsEnabled);
                  if (store.requiresTailscaleConfirmation) {
                    store.setReconciled(desiredAtBoot);
                  }
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
          yield* Effect.logWarning("remote access: could not restore exposure", {
            desired: desiredAtBoot,
          });
        });
        yield* Effect.forkDetach(reconcileExposure);
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
      beginLinkSignIn: (input) =>
        Effect.try({
          try: () => link.beginSignIn(input),
          catch: (cause) =>
            new RemoteError({
              message: cause instanceof Error ? cause.message : "Could not start Shiori sign-in.",
              cause,
            }),
        }),
      completeLinkSignIn: (input) =>
        Effect.try({
          try: () => link.completeSignIn(input),
          catch: (cause) =>
            new RemoteError({
              message:
                cause instanceof Error ? cause.message : "Could not complete Shiori sign-in.",
              cause,
            }),
        }),
      linkHostedAccessAvailable: () => Effect.sync(() => link.hostedAccessAvailable),
      beginLinkHostedAccess: (state) =>
        Effect.try({
          try: () => link.beginHostedAccess(state),
          catch: (cause) =>
            new RemoteError({
              message: cause instanceof Error ? cause.message : "Could not start hosted sign-in.",
              cause,
            }),
        }),
      exchangeLinkHostedAccess: (code) =>
        Effect.tryPromise({
          try: () => link.exchangeHostedAccess(code),
          catch: (cause) =>
            new RemoteError({
              message:
                cause instanceof Error ? cause.message : "Could not complete hosted sign-in.",
              cause,
            }),
        }),
      disconnectLinkAccount: () =>
        Effect.tryPromise({
          try: () =>
            withExposureLock(async () => {
              if (store.method === "shiori-link") {
                const cli = tailscaleCli();
                const cleared = await teardownExposureOnce({
                  cli,
                  port,
                  disableLink: async () => undefined,
                  requireTailscaleConfirmation:
                    cli !== null || store.needsCleanup || store.requiresTailscaleConfirmation,
                });
                if (!cleared) {
                  throw new Error(
                    "Tailscale is not reachable, so remote exposure could not be confirmed off. Start Tailscale and try again before disconnecting Link.",
                  );
                }
              }
              await link.disconnectAccount();
              if (store.method === "shiori-link") {
                store.setReconciled("off");
                auth.setRemoteExposed(false);
              }
              return await buildStatus();
            }),
          catch: (cause) =>
            new RemoteError({
              message:
                cause instanceof Error ? cause.message : "Could not disconnect Shiori account.",
              cause,
            }),
        }),
      testConnection: () =>
        Effect.promise(async () => {
          const url = (await buildStatus()).url;
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
