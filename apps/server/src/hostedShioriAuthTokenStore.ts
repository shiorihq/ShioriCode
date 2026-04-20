import { Cause, Effect, FileSystem, Layer, Path, PubSub, Ref, ServiceMap, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "./config";
import { writeFileStringAtomically } from "./persistence/writeFileStringAtomically";

export interface HostedShioriAuthTokenStoreShape {
  readonly getToken: Effect.Effect<string | null>;
  readonly setToken: (token: string | null) => Effect.Effect<void>;
  readonly streamChanges: Stream.Stream<string | null>;
}

export class HostedShioriAuthTokenStore extends ServiceMap.Service<
  HostedShioriAuthTokenStore,
  HostedShioriAuthTokenStoreShape
>()("t3/HostedShioriAuthTokenStore") {}

export function getHostedShioriAuthTokenPath(stateDir: string): string {
  return `${stateDir}/hosted-shiori-auth-token`;
}

function normalizeToken(token: string | null): string | null {
  const trimmed = token?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

const HostedShioriAuthTokenFileMode = 0o600;

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export const HostedShioriAuthTokenStoreLive = Layer.effect(
  HostedShioriAuthTokenStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const { stateDir } = yield* ServerConfig;
    const tokenPath = getHostedShioriAuthTokenPath(stateDir);
    const changes = yield* PubSub.unbounded<string | null>();
    const persistSemaphore = yield* Semaphore.make(1);

    const readPersistedToken = Effect.gen(function* () {
      const exists = yield* fs.exists(tokenPath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) {
        return null;
      }

      const raw = yield* fs.readFileString(tokenPath).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to read hosted shiori auth token", {
            path: tokenPath,
            cause: describeError(cause),
          }).pipe(Effect.as("")),
        ),
      );
      return normalizeToken(raw);
    });

    const tokenRef = yield* Ref.make<string | null>(yield* readPersistedToken);

    const persistToken = (token: string | null) =>
      Effect.gen(function* () {
        if (token === null) {
          yield* fs.remove(tokenPath, { force: true });
          return;
        }

        yield* writeFileStringAtomically(tokenPath, token, {
          mode: HostedShioriAuthTokenFileMode,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, pathService),
        );
      });

    return {
      getToken: Ref.get(tokenRef),
      setToken: (token) =>
        persistSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const nextToken = normalizeToken(token);
            const current = yield* Ref.get(tokenRef);
            if (current === nextToken) {
              return;
            }

            const persistExit = yield* Effect.exit(persistToken(nextToken));
            if (persistExit._tag === "Failure") {
              yield* Effect.logWarning("failed to persist hosted shiori auth token", {
                path: tokenPath,
                cause: Cause.pretty(persistExit.cause),
              });
              return;
            }
            yield* Ref.set(tokenRef, nextToken);
            yield* PubSub.publish(changes, nextToken);
          }),
        ),
      streamChanges: Stream.fromPubSub(changes),
    } satisfies HostedShioriAuthTokenStoreShape;
  }),
);
