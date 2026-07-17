import { randomBytes } from "node:crypto";

import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { RemoteAccess } from "../remote/RemoteAccess";
import { parseCookies, serializeCookie } from "./cookies";
import { EnvironmentAuth, SESSION_COOKIE_NAME } from "./EnvironmentAuth";
import { authClientMetadata } from "./httpAuth";
import { safeEqualUtf8 } from "./tokens";

const LINK_ACCESS_STATE_COOKIE = "shioricode_link_access_state";
const LINK_ACCESS_STATE_MAX_AGE_SECONDS = 10 * 60;

function errorResponse(message: string, status: number) {
  return HttpServerResponse.text(`${JSON.stringify({ success: false, error: message })}\n`, {
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
  });
}

const startRoute = HttpRouter.add(
  "GET",
  "/api/auth/link/start",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const remote = yield* RemoteAccess;
    const state = randomBytes(32).toString("base64url");
    const target = yield* remote.beginLinkHostedAccess(state);
    const stateCookie = serializeCookie(LINK_ACCESS_STATE_COOKIE, state, {
      // This callback is deliberately bound to the HTTPS Link hostname. Do
      // not rely on the relay preserving X-Forwarded-Proto for cookie safety.
      secure: true,
      sameSite: "Lax",
      maxAgeSeconds: LINK_ACCESS_STATE_MAX_AGE_SECONDS,
      path: "/api/auth/link/callback",
    });
    return HttpServerResponse.redirect(target, {
      headers: { "Cache-Control": "no-store", "Set-Cookie": stateCookie },
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        errorResponse(
          error instanceof Error ? error.message : "Hosted sign-in is unavailable",
          503,
        ),
      ),
    ),
  ),
);

const callbackRoute = HttpRouter.add(
  "GET",
  "/api/auth/link/callback",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return errorResponse("Invalid hosted sign-in callback", 400);
    const state = url.value.searchParams.get("state");
    const code = url.value.searchParams.get("code");
    const expectedState = parseCookies(request.headers.cookie)[LINK_ACCESS_STATE_COOKIE] ?? null;
    if (!state || !code || !expectedState || !safeEqualUtf8(state, expectedState)) {
      return errorResponse("Invalid or expired hosted sign-in callback", 400);
    }

    const remote = yield* RemoteAccess;
    const principal = yield* remote.exchangeLinkHostedAccess(code);
    const auth = yield* EnvironmentAuth;
    const outcome = auth.createSession({
      username: principal.username,
      metadata: authClientMetadata(request, "ShioriCode Link · GitHub"),
    });
    const sessionCookie = serializeCookie(SESSION_COOKIE_NAME, outcome.token, {
      secure: true,
      sameSite: "Lax",
      maxAgeSeconds: auth.cookieMaxAgeSeconds,
    });
    return HttpServerResponse.redirect("/", {
      headers: { "Cache-Control": "no-store", "Set-Cookie": sessionCookie },
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        errorResponse(error instanceof Error ? error.message : "Hosted sign-in failed", 401),
      ),
    ),
  ),
);

export const linkAccessRoutesLayer = Layer.mergeAll(startRoute, callbackRoute);
