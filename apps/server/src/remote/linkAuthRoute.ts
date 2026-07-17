import { Data, Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "../config";
import { safeEqualUtf8 } from "../auth/tokens";
import { RemoteAccess } from "./RemoteAccess";

class LinkAuthRouteError extends Data.TaggedError("LinkAuthRouteError")<{
  readonly message: string;
}> {}

const LinkAuthCallback = Schema.Struct({
  state: Schema.String,
  token: Schema.optional(Schema.String),
  refreshToken: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

function jsonResponse(body: unknown, status: number) {
  return HttpServerResponse.text(`${JSON.stringify(body)}\n`, {
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
  });
}

function readBearer(request: HttpServerRequest.HttpServerRequest): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "");
  return match?.[1]?.trim() || null;
}

export const linkAuthCallbackRouteLayer = HttpRouter.add(
  "POST",
  "/api/remote/link-auth-callback",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const remote = yield* RemoteAccess;
    const providedToken = readBearer(request);
    if (!config.authToken || !providedToken || !safeEqualUtf8(providedToken, config.authToken)) {
      return jsonResponse({ success: false, error: "Unauthorized" }, 401);
    }
    const body = yield* request.json.pipe(
      Effect.mapError(() => new LinkAuthRouteError({ message: "Invalid link sign-in callback" })),
    );
    const input = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(LinkAuthCallback)(body),
      catch: () => new LinkAuthRouteError({ message: "Invalid link sign-in callback" }),
    });
    yield* remote.completeLinkSignIn({
      state: input.state,
      ...(input.token ? { token: input.token } : {}),
      ...(input.refreshToken ? { refreshToken: input.refreshToken } : {}),
      ...(input.error ? { error: input.error } : {}),
    });
    return jsonResponse({ success: true }, 200);
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        jsonResponse(
          {
            success: false,
            error: error instanceof Error ? error.message : "Link sign-in failed",
          },
          400,
        ),
      ),
    ),
  ),
);
