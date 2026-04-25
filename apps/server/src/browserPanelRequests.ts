import {
  BrowserPanelCommand,
  BrowserPanelNavigateRequest,
  type BrowserPanelCommand as BrowserPanelCommandType,
  type BrowserPanelCommandResult as BrowserPanelCommandResultType,
  type BrowserPanelNavigateRequest as BrowserPanelNavigateRequestType,
} from "contracts";
import {
  Data,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  PubSub,
  Ref,
  Schema,
  ServiceMap,
  Stream,
} from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "./config";

class BrowserPanelRequestError extends Data.TaggedError("BrowserPanelRequestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface BrowserPanelRequestsShape {
  readonly publishNavigate: (request: BrowserPanelNavigateRequestType) => Effect.Effect<void>;
  readonly runCommand: (
    command: BrowserPanelCommandType,
    options?: { readonly timeoutMs?: number },
  ) => Effect.Effect<BrowserPanelCommandResultType>;
  readonly completeCommand: (result: BrowserPanelCommandResultType) => Effect.Effect<void>;
  readonly stream: Stream.Stream<BrowserPanelCommandType>;
}

export class BrowserPanelRequests extends ServiceMap.Service<
  BrowserPanelRequests,
  BrowserPanelRequestsShape
>()("shiori/browserPanelRequests") {}

export const BrowserPanelRequestsLive = Layer.effect(
  BrowserPanelRequests,
  Effect.gen(function* () {
    const pubSub = yield* PubSub.unbounded<BrowserPanelCommandType>();
    const pending = yield* Ref.make(
      new Map<string, Deferred.Deferred<BrowserPanelCommandResultType>>(),
    );
    return {
      publishNavigate: (request) =>
        PubSub.publish(pubSub, { ...request, type: "navigate" }).pipe(Effect.asVoid),
      runCommand: (command, options) =>
        Effect.gen(function* () {
          const deferred = yield* Deferred.make<BrowserPanelCommandResultType>();
          yield* Ref.update(pending, (existing) => {
            const next = new Map(existing);
            next.set(command.id, deferred);
            return next;
          });
          yield* PubSub.publish(pubSub, command);
          const result = yield* Deferred.await(deferred).pipe(
            Effect.timeoutOption(Duration.millis(options?.timeoutMs ?? 15_000)),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.succeed({
                    id: command.id,
                    threadId: command.threadId,
                    ok: false,
                    error: "Timed out waiting for the built-in browser panel.",
                  }),
                onSome: Effect.succeed,
              }),
            ),
          );
          yield* Ref.update(pending, (existing) => {
            const next = new Map(existing);
            next.delete(command.id);
            return next;
          });
          return result;
        }),
      completeCommand: (result) =>
        Effect.gen(function* () {
          const deferred = yield* Ref.get(pending).pipe(Effect.map((map) => map.get(result.id)));
          if (deferred) {
            yield* Deferred.succeed(deferred, result).pipe(Effect.ignore);
          }
        }),
      stream: Stream.fromPubSub(pubSub),
    } satisfies BrowserPanelRequestsShape;
  }),
);

function jsonResponse(body: unknown, status = 200) {
  return HttpServerResponse.text(`${JSON.stringify(body)}\n`, {
    status,
    contentType: "application/json",
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function requestToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim() || null;
  }
  const url = HttpServerRequest.toURL(request);
  if (Option.isSome(url)) {
    return url.value.searchParams.get("token");
  }
  return null;
}

export const browserPanelRequestRouteLayer = HttpRouter.add(
  "POST",
  "/api/browser-panel/navigate",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const browserPanelRequests = yield* BrowserPanelRequests;

    if (config.authToken && requestToken(request) !== config.authToken) {
      return jsonResponse({ success: false, error: "Unauthorized" }, 401);
    }

    const body = yield* request.json.pipe(
      Effect.mapError(() => new Error("Invalid browser navigation request body.")),
    );
    const navigateRequest = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(BrowserPanelNavigateRequest)(body),
      catch: (error) =>
        new BrowserPanelRequestError({
          message: "Invalid browser navigation request.",
          cause: error,
        }),
    });
    yield* browserPanelRequests.publishNavigate(navigateRequest);
    return jsonResponse({ success: true });
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        jsonResponse(
          { success: false, error: error instanceof Error ? error.message : "Navigation failed" },
          400,
        ),
      ),
    ),
  ),
);

export const browserPanelCommandRouteLayer = HttpRouter.add(
  "POST",
  "/api/browser-panel/command",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const browserPanelRequests = yield* BrowserPanelRequests;

    if (config.authToken && requestToken(request) !== config.authToken) {
      return jsonResponse({ success: false, error: "Unauthorized" }, 401);
    }

    const body = yield* request.json.pipe(
      Effect.mapError(() => new Error("Invalid browser command request body.")),
    );
    const command = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(BrowserPanelCommand)(body),
      catch: (error) =>
        new BrowserPanelRequestError({
          message: "Invalid browser command request.",
          cause: error,
        }),
    });
    const result = yield* browserPanelRequests.runCommand(command);
    return jsonResponse({ success: true, result });
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        jsonResponse(
          {
            success: false,
            error: error instanceof Error ? error.message : "Browser command failed",
          },
          400,
        ),
      ),
    ),
  ),
);
