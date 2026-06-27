/**
 * HTTP routes for credential login and session management.
 *
 *   POST /api/auth/login            { username, password } -> session cookie + bearer
 *   POST /api/auth/logout           revoke the current session, clear the cookie
 *   GET  /api/auth/session          report auth requirement + authenticated state
 *   POST /api/auth/websocket-ticket mint a short-lived single-use WS ticket
 *
 * @module auth/authRoutes
 */
import { Data, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { parseCookies, serializeCookie } from "./cookies";
import { EnvironmentAuth, SESSION_COOKIE_NAME } from "./EnvironmentAuth";

class AuthRouteError extends Data.TaggedError("AuthRouteError")<{
  readonly message: string;
}> {}

const NO_STORE = { "Cache-Control": "no-store" } as const;

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return HttpServerResponse.text(`${JSON.stringify(body)}\n`, {
    status,
    contentType: "application/json",
    headers: { ...NO_STORE, ...extraHeaders },
  });
}

const LoginRequest = Schema.Struct({
  username: Schema.String,
  password: Schema.String,
  label: Schema.optional(Schema.String),
});

/**
 * Whether the session cookie should be marked Secure. Tracks the real request
 * scheme (via the reverse proxy's X-Forwarded-Proto, falling back to the request
 * URL) so the cookie is Secure over HTTPS but still works over a plain-HTTP hop
 * on a trusted private network (e.g. a Tailscale `serve --http` endpoint, which
 * is WireGuard-encrypted on the wire regardless).
 */
function isSecureRequest(request: HttpServerRequest.HttpServerRequest): boolean {
  const forwardedProto = request.headers["x-forwarded-proto"];
  if (forwardedProto) {
    return forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
  }
  const url = HttpServerRequest.toURL(request);
  return Option.isSome(url) && url.value.protocol === "https:";
}

function readBearer(request: HttpServerRequest.HttpServerRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || null;
}

function clientMetadata(request: HttpServerRequest.HttpServerRequest, label?: string) {
  const forwardedFor = request.headers["x-forwarded-for"];
  const ip = forwardedFor ? forwardedFor.split(",")[0]?.trim() : undefined;
  return {
    label: label ?? undefined,
    userAgent: request.headers["user-agent"] ?? undefined,
    ip: ip || undefined,
  };
}

const loginRoute = HttpRouter.add(
  "POST",
  "/api/auth/login",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth;
    if (!auth.authConfigured) {
      return jsonResponse(
        { success: false, error: "No credentials are configured on this server." },
        503,
      );
    }
    const body = yield* request.json.pipe(
      Effect.mapError(() => new AuthRouteError({ message: "Invalid login request body." })),
    );
    const input = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(LoginRequest)(body),
      catch: () => new AuthRouteError({ message: "Invalid login request." }),
    });
    const outcome = auth.login({
      username: input.username,
      password: input.password,
      metadata: clientMetadata(request, input.label),
    });
    if (!outcome) {
      return jsonResponse({ success: false, error: "Invalid username or password." }, 401);
    }
    const cookie = serializeCookie(SESSION_COOKIE_NAME, outcome.token, {
      secure: isSecureRequest(request),
      sameSite: "Lax",
      maxAgeSeconds: auth.cookieMaxAgeSeconds,
    });
    return jsonResponse(
      {
        success: true,
        token: outcome.token,
        session: auth.describe({
          kind: "session",
          sessionId: outcome.session.id,
          username: outcome.session.username,
        }),
      },
      200,
      { "Set-Cookie": cookie },
    );
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        jsonResponse(
          { success: false, error: error instanceof Error ? error.message : "Login failed." },
          400,
        ),
      ),
    ),
  ),
);

const logoutRoute = HttpRouter.add(
  "POST",
  "/api/auth/logout",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth;
    const cookieToken = parseCookies(request.headers.cookie)[SESSION_COOKIE_NAME] ?? null;
    auth.logout(cookieToken ?? readBearer(request));
    const cleared = serializeCookie(SESSION_COOKIE_NAME, "", {
      secure: isSecureRequest(request),
      sameSite: "Lax",
      maxAgeSeconds: 0,
    });
    return jsonResponse({ success: true }, 200, { "Set-Cookie": cleared });
  }),
);

const sessionRoute = HttpRouter.add(
  "GET",
  "/api/auth/session",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth;
    const url = HttpServerRequest.toURL(request);
    const principal = Option.isSome(url)
      ? auth.authenticateRequest({ request, url: url.value })
      : null;
    return jsonResponse({ success: true, session: auth.describe(principal) });
  }),
);

const websocketTicketRoute = HttpRouter.add(
  "POST",
  "/api/auth/websocket-ticket",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth;
    const url = HttpServerRequest.toURL(request);
    const principal = Option.isSome(url)
      ? auth.authenticateRequest({ request, url: url.value })
      : null;
    if (auth.requireAuth && !principal) {
      return jsonResponse({ success: false, error: "Unauthorized" }, 401);
    }
    const ticket = principal ? auth.issueTicket(principal) : null;
    return jsonResponse({ success: true, ticket });
  }),
);

export const authRoutesLayer = Layer.mergeAll(
  loginRoute,
  logoutRoute,
  sessionRoute,
  websocketTicketRoute,
);
