// @ts-nocheck
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, PubSub, Ref, Stream } from "effect";

import { HostedShioriAuthTokenStore } from "../../hostedShioriAuthTokenStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ShioriProvider } from "../Services/ShioriProvider.ts";
import { ShioriProviderLive } from "./ShioriProvider.ts";

const jwtToken = "header.payload.signature";

const hostedShioriAuthTokenStoreTestLayer = Layer.effect(
  HostedShioriAuthTokenStore,
  Effect.gen(function* () {
    const tokenRef = yield* Ref.make<string | null>(null);
    const changes = yield* PubSub.unbounded<string | null>();

    return {
      getToken: Ref.get(tokenRef),
      setToken: (token: string | null) =>
        Ref.set(tokenRef, token).pipe(
          Effect.flatMap(() => PubSub.publish(changes, token)),
          Effect.asVoid,
        ),
      streamChanges: Stream.fromPubSub(changes),
    };
  }),
);

const shioriProviderTestLayer = ShioriProviderLive.pipe(
  Layer.provideMerge(
    ServerSettingsService.layerTest({
      providers: {
        shiori: {
          apiBaseUrl: "http://shiori.test",
        },
      },
    }),
  ),
  Layer.provideMerge(hostedShioriAuthTokenStoreTestLayer),
);

it.layer(shioriProviderTestLayer)("ShioriProviderLive", (it) => {
  describe("auth snapshot", () => {
    it.effect("reflects hosted auth state from the desktop login token store", () =>
      Effect.gen(function* () {
        const provider = yield* ShioriProvider;
        const authTokenStore = yield* HostedShioriAuthTokenStore;

        const initial = yield* provider.getSnapshot;
        assert.strictEqual(initial.auth.status, "unknown");

        yield* authTokenStore.setToken(jwtToken);

        const refreshed = yield* provider.getSnapshot;
        assert.strictEqual(refreshed.auth.status, "authenticated");
      }),
    );
  });
});
