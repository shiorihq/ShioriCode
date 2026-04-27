// @ts-nocheck
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, PubSub, Ref, Stream } from "effect";
import { afterEach, vi } from "vitest";

import { HostedShioriAuthTokenStore } from "../../hostedShioriAuthTokenStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ShioriProvider } from "../Services/ShioriProvider.ts";
import { ShioriProviderLive } from "./ShioriProvider.ts";

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

const jwtToken = `${encodeBase64UrlJson({ alg: "RS256" })}.${encodeBase64UrlJson({
  iss: "https://cautious-puma-129.convex.site",
  aud: "convex",
  sub: "user|session",
})}.signature`;

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

afterEach(() => {
  vi.unstubAllGlobals();
});

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

    it.effect(
      "keeps the last good authenticated snapshot during transient entitlement auth failures",
      () =>
        Effect.gen(function* () {
          vi.stubGlobal(
            "fetch",
            vi
              .fn()
              .mockResolvedValueOnce(
                new Response(
                  JSON.stringify({
                    allowed: true,
                    plan: "pro",
                    status: "active",
                  }),
                  { status: 200 },
                ),
              )
              .mockResolvedValueOnce(
                new Response(
                  JSON.stringify({
                    error: "Internal server error",
                    message:
                      '{"code":"Unauthenticated","message":"Could not verify OIDC token claim. Check that the token signature is valid and the token hasn\'t expired."}',
                  }),
                  { status: 500 },
                ),
              ),
          );

          const provider = yield* ShioriProvider;
          const authTokenStore = yield* HostedShioriAuthTokenStore;

          yield* authTokenStore.setToken(jwtToken);

          const initial = yield* provider.refresh;
          assert.strictEqual(initial.status, "ready");
          assert.strictEqual(initial.auth.status, "authenticated");

          const refreshed = yield* provider.refresh;
          assert.strictEqual(refreshed.status, "ready");
          assert.strictEqual(refreshed.auth.status, "authenticated");
          assert.strictEqual(refreshed.message, initial.message);
        }),
    );
  });
});
