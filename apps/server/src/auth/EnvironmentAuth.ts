/**
 * EnvironmentAuth - the authorization boundary for ShioriCode.
 *
 * Resolves a principal from a request (WebSocket ticket, session cookie, session
 * bearer, or the legacy shared auth token), performs credential login, and
 * issues short-lived WebSocket tickets. `requireAuth` is derived from the
 * server's exposure intent: when ShioriCode is reachable beyond loopback, a
 * valid principal is mandatory on every data route and the WebSocket upgrade.
 *
 * Exposure intent is dynamic: the CLI flags (`--remote`, `--require-auth`, a
 * non-loopback bind) set a floor at startup, and `setRemoteExposed` flips the
 * requirement live when the owner turns remote access on/off in Settings — no
 * restart needed. All consumers read `requireAuth` per request.
 *
 * The static app shell stays public so the login page can load; only data
 * routes and the RPC socket are gated.
 *
 * @module auth/EnvironmentAuth
 */
import { Effect, Layer, Option, ServiceMap } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "../config";
import { CredentialStore } from "./credentialStore";
import { parseCookies } from "./cookies";
import {
  SessionStore,
  type SessionMetadata,
  type SessionRecord,
  type SessionSummary,
} from "./sessionStore";
import { safeEqualUtf8 } from "./tokens";

export const SESSION_COOKIE_NAME = "shioricode_session";

export interface AuthPrincipal {
  readonly kind: "session" | "legacy-token";
  readonly sessionId: string | null;
  readonly username: string;
}

export interface AuthSessionDescriptor {
  readonly requireAuth: boolean;
  readonly authConfigured: boolean;
  readonly authenticated: boolean;
  readonly username: string | null;
  readonly sessionId: string | null;
}

export interface AuthRequestContext {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
}

export interface LoginOutcome {
  readonly token: string;
  readonly session: SessionRecord;
}

export interface EnvironmentAuthApi {
  /**
   * Whether a valid principal is mandatory (server is remote-reachable).
   * Dynamic: read per request, never capture at startup.
   */
  readonly requireAuth: boolean;
  /**
   * Mark the server as remote-exposed (or not). Called by RemoteAccess when
   * exposure is turned on/off so auth flips live without a restart. The CLI
   * flags remain a floor: they can force auth on, this cannot force it off.
   */
  setRemoteExposed(exposed: boolean): void;
  /** Whether owner credentials have been configured. */
  readonly authConfigured: boolean;
  /** Configured owner username, if any. */
  readonly username: string | null;
  /** Whether session cookies should carry the Secure attribute. */
  readonly secureCookies: boolean;
  /** Lifetime, in seconds, of an issued session cookie. */
  readonly cookieMaxAgeSeconds: number;
  authenticateRequest(context: AuthRequestContext): AuthPrincipal | null;
  authenticateUpgrade(context: AuthRequestContext): AuthPrincipal | null;
  isAllowedUpgrade(context: AuthRequestContext): boolean;
  login(input: {
    readonly username: string;
    readonly password: string;
    readonly metadata?: SessionMetadata;
  }): LoginOutcome | null;
  createSession(input: {
    readonly username: string;
    readonly metadata?: SessionMetadata;
  }): LoginOutcome;
  /** Verify owner credentials without minting a session (used by the mobile API). */
  verifyCredentials(input: { readonly username: string; readonly password: string }): boolean;
  /** Set (or rotate) the owner credentials, persisted 0600. */
  setCredentials(input: { readonly username: string; readonly password: string }): void;
  logout(token: string | null): void;
  issueTicket(principal: AuthPrincipal): string | null;
  describe(principal: AuthPrincipal | null): AuthSessionDescriptor;
  listSessions(): ReadonlyArray<SessionSummary>;
  revokeSession(id: string): void;
}

export class EnvironmentAuth extends ServiceMap.Service<EnvironmentAuth, EnvironmentAuthApi>()(
  "shiori/auth/EnvironmentAuth",
) {}

const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function parseOrigin(value: string | null): URL | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function isDesktopAppOrigin(origin: URL | null): boolean {
  return origin?.protocol === "shioricode:" && origin.hostname === "app";
}

function sessionPrincipal(session: SessionRecord): AuthPrincipal {
  return { kind: "session", sessionId: session.id, username: session.username };
}

function readAuthorizationBearer(request: HttpServerRequest.HttpServerRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || null;
}

function resolveConfiguredAllowedOrigins(): ReadonlySet<string> {
  const origins = new Set<string>();
  const raw = process.env.SHIORICODE_ALLOWED_ORIGINS;
  if (raw) {
    for (const entry of raw.split(",")) {
      const parsed = parseOrigin(entry.trim());
      if (parsed) {
        origins.add(parsed.origin);
      }
    }
  }
  return origins;
}

export function isRemoteWebSocketOriginAllowed(input: {
  readonly origin: URL | null;
  readonly requestUrl: URL;
  readonly devOrigin: string | null;
  readonly configuredAllowedOrigins: ReadonlySet<string>;
}): boolean {
  const { origin, requestUrl, devOrigin, configuredAllowedOrigins } = input;
  if (!origin || configuredAllowedOrigins.size === 0) {
    return true;
  }
  return (
    origin.origin === requestUrl.origin ||
    origin.origin === devOrigin ||
    configuredAllowedOrigins.has(origin.origin)
  );
}

export const EnvironmentAuthLive = Layer.effect(
  EnvironmentAuth,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const credentials = new CredentialStore({
      stateDir: config.stateDir,
      envUsername: process.env.SHIORICODE_USERNAME,
      envPassword: process.env.SHIORICODE_PASSWORD,
    });
    const sessions = new SessionStore({ stateDir: config.stateDir });
    const legacyToken = config.authToken ?? null;
    const configuredAllowedOrigins = resolveConfiguredAllowedOrigins();
    const devOrigin = config.devUrl?.origin ?? null;

    // Dynamic exposure state: the config flags are the floor (a `--remote`
    // start always requires auth); RemoteAccess raises/lowers the runtime bit
    // as the owner toggles exposure in Settings.
    let remoteExposed = false;
    const isAuthRequired = () => !config.unsafeNoAuth && (config.requireAuth || remoteExposed);

    const legacyPrincipal = (): AuthPrincipal => ({
      kind: "legacy-token",
      sessionId: null,
      username: credentials.username ?? "owner",
    });

    const matchesLegacy = (candidate: string | null): boolean =>
      candidate !== null && legacyToken !== null && safeEqualUtf8(candidate, legacyToken);

    const resolvePrincipal = (
      context: AuthRequestContext,
      options: { readonly allowTicket: boolean },
    ): AuthPrincipal | null => {
      const { request, url } = context;

      if (options.allowTicket) {
        const ticket = url.searchParams.get("wsTicket");
        if (ticket) {
          const session = sessions.consumeTicket(ticket);
          if (session) {
            return sessionPrincipal(session);
          }
        }
      }

      const cookieToken = parseCookies(request.headers.cookie)[SESSION_COOKIE_NAME];
      if (cookieToken) {
        const session = sessions.verifyToken(cookieToken);
        if (session) {
          return sessionPrincipal(session);
        }
      }

      const bearer = readAuthorizationBearer(request);
      if (bearer) {
        const session = sessions.verifyToken(bearer);
        if (session) {
          return sessionPrincipal(session);
        }
      }

      if (legacyToken) {
        const queryToken = url.searchParams.get("token");
        if (matchesLegacy(bearer) || matchesLegacy(queryToken)) {
          return legacyPrincipal();
        }
      }

      return null;
    };

    const isAllowedUpgrade = (context: AuthRequestContext): boolean => {
      const { request, url } = context;
      const rawOrigin = request.headers.origin ?? null;
      const origin = parseOrigin(rawOrigin);

      if (rawOrigin && !origin) {
        return false;
      }
      if (isDesktopAppOrigin(origin)) {
        return true;
      }
      if (origin && origin.protocol !== "http:" && origin.protocol !== "https:") {
        return false;
      }

      const originAllowed = (candidate: URL): boolean =>
        candidate.origin === url.origin ||
        candidate.origin === devOrigin ||
        configuredAllowedOrigins.has(candidate.origin);

      if (!isAuthRequired()) {
        // Loopback dev: defeat DNS rebinding by requiring a loopback Host, and
        // reject clearly cross-origin browser requests.
        const hostHeader = request.headers.host ?? url.host;
        const hostname = hostHeader.split(":")[0] ?? hostHeader;
        const hostAllowed =
          isLoopbackHostname(hostname) ||
          (config.host !== undefined &&
            hostname === config.host.replace(/^\[/, "").replace(/\]$/, "")) ||
          configuredAllowedOrigins.has(`${url.protocol}//${hostHeader}`);
        if (!hostAllowed) {
          return false;
        }
        if (origin && !originAllowed(origin)) {
          return false;
        }
        return true;
      }

      // Remote: the session credential + SameSite cookie is the real boundary.
      // If an allowlist is configured, enforce it as defense-in-depth; otherwise
      // accept (a reverse proxy obscures the browser-facing origin).
      if (
        !isRemoteWebSocketOriginAllowed({
          origin,
          requestUrl: url,
          devOrigin,
          configuredAllowedOrigins,
        })
      ) {
        return false;
      }
      return true;
    };

    return {
      get requireAuth() {
        return isAuthRequired();
      },
      setRemoteExposed: (exposed) => {
        remoteExposed = exposed;
      },
      get authConfigured() {
        return credentials.isConfigured || legacyToken !== null;
      },
      get username() {
        return credentials.username;
      },
      get secureCookies() {
        return isAuthRequired();
      },
      cookieMaxAgeSeconds: SESSION_COOKIE_MAX_AGE_SECONDS,
      authenticateRequest: (context) => resolvePrincipal(context, { allowTicket: false }),
      authenticateUpgrade: (context) => resolvePrincipal(context, { allowTicket: true }),
      isAllowedUpgrade,
      login: (input) => {
        if (!credentials.verify(input.username, input.password)) {
          return null;
        }
        const username = input.username.trim();
        return input.metadata
          ? sessions.create({ username, metadata: input.metadata })
          : sessions.create({ username });
      },
      createSession: (input) => sessions.create(input),
      verifyCredentials: (input) => credentials.verify(input.username, input.password),
      setCredentials: (input) => credentials.setCredentials(input.username, input.password),
      logout: (token) => {
        if (token) {
          sessions.revokeByToken(token);
        }
      },
      issueTicket: (principal) =>
        principal.kind === "session" && principal.sessionId
          ? sessions.issueTicket(principal.sessionId)
          : null,
      describe: (principal) => ({
        requireAuth: isAuthRequired(),
        authConfigured: credentials.isConfigured || legacyToken !== null,
        authenticated: principal !== null,
        username: principal?.username ?? null,
        sessionId: principal?.sessionId ?? null,
      }),
      listSessions: () => sessions.list(),
      revokeSession: (id) => sessions.revoke(id),
    } satisfies EnvironmentAuthApi;
  }),
);

/**
 * Resolve the request URL, or fail the route with a 400 when it is malformed.
 * Shared by auth-gated routes that need both the request and its URL.
 */
export const requireRequestUrl = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return yield* Effect.fail(new Error("Invalid request URL."));
  }
  return { request, url: url.value };
});

/**
 * Gate a data route. Returns a 401 response when authentication is required but
 * the request carries no valid principal, or `null` when the request may
 * proceed. Used by the attachment, favicon, and browser-panel routes so the one
 * authorization decision lives in a single place.
 */
export const authorizeDataRequest = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth;
  if (!auth.requireAuth) {
    return null;
  }
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  const principal = Option.isSome(url)
    ? auth.authenticateRequest({ request, url: url.value })
    : null;
  if (!principal) {
    return HttpServerResponse.text("Unauthorized", {
      status: 401,
      headers: { "Cache-Control": "no-store", "WWW-Authenticate": "Bearer" },
    });
  }
  return null;
});
