import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ServerConfig } from "../config";
import {
  EnvironmentAuth,
  EnvironmentAuthLive,
  isRemoteWebSocketOriginAllowed,
} from "./EnvironmentAuth";

it("does not treat the local Vite origin as a production WebSocket allowlist", () => {
  assert.isTrue(
    isRemoteWebSocketOriginAllowed({
      origin: new URL("https://sc-example.link.shiori.codes"),
      requestUrl: new URL("http://127.0.0.1:3773/ws"),
      devOrigin: "http://127.0.0.1:5733",
      configuredAllowedOrigins: new Set(),
    }),
  );
});

it("enforces explicitly configured production WebSocket origins", () => {
  const input = {
    requestUrl: new URL("http://127.0.0.1:3773/ws"),
    devOrigin: "http://127.0.0.1:5733",
    configuredAllowedOrigins: new Set(["https://allowed.example"]),
  };

  assert.isTrue(
    isRemoteWebSocketOriginAllowed({
      ...input,
      origin: new URL("https://allowed.example"),
    }),
  );
  assert.isFalse(
    isRemoteWebSocketOriginAllowed({
      ...input,
      origin: new URL("https://rejected.example"),
    }),
  );
});

const testLayer = EnvironmentAuthLive.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "shiori-auth-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(testLayer)("EnvironmentAuth", (it) => {
  it.effect("flips requireAuth live when remote exposure toggles", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth;

      assert.isFalse(auth.requireAuth, "loopback start requires no auth");

      auth.setRemoteExposed(true);
      assert.isTrue(auth.requireAuth, "enabling exposure raises the requirement at runtime");
      assert.isTrue(auth.describe(null).requireAuth, "describe() reflects the live value");
      assert.isTrue(auth.secureCookies);

      auth.setRemoteExposed(false);
      assert.isFalse(auth.requireAuth, "turning exposure off lowers it again");
    }),
  );

  it.effect("credentials set at runtime are immediately usable for login", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth;

      auth.setCredentials({ username: "owner", password: "correct horse battery" });
      assert.isTrue(auth.authConfigured);
      assert.isNull(auth.login({ username: "owner", password: "wrong" }));

      const outcome = auth.login({ username: "owner", password: "correct horse battery" });
      assert.isNotNull(outcome);
      assert.strictEqual(outcome?.session.username, "owner");
    }),
  );

  it.effect("creates a session for an identity verified by ShioriCode Link", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth;
      const outcome = auth.createSession({ username: "GitHub Owner" });

      assert.strictEqual(outcome.session.username, "GitHub Owner");
      assert.strictEqual(auth.listSessions()[0]?.username, "GitHub Owner");
    }),
  );
});
