import { Effect, Layer, PubSub, Ref, ServiceMap, Stream } from "effect";

export interface HostedShioriAuthTokenStoreShape {
  readonly getToken: Effect.Effect<string | null>;
  readonly setToken: (token: string | null) => Effect.Effect<void>;
  readonly streamChanges: Stream.Stream<string | null>;
}

export class HostedShioriAuthTokenStore extends ServiceMap.Service<
  HostedShioriAuthTokenStore,
  HostedShioriAuthTokenStoreShape
>()("t3/HostedShioriAuthTokenStore") {}

export const HostedShioriAuthTokenStoreLive = Layer.effect(
  HostedShioriAuthTokenStore,
  Effect.gen(function* () {
    const tokenRef = yield* Ref.make<string | null>(null);
    const changes = yield* PubSub.unbounded<string | null>();

    return {
      getToken: Ref.get(tokenRef),
      setToken: (token) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(tokenRef);
          if (current === token) {
            return;
          }
          yield* Ref.set(tokenRef, token);
          yield* PubSub.publish(changes, token);
        }),
      streamChanges: Stream.fromPubSub(changes),
    } satisfies HostedShioriAuthTokenStoreShape;
  }),
);
