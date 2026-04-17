import { statSync } from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import { ServerConfig } from "./config";
import {
  getHostedShioriAuthTokenPath,
  HostedShioriAuthTokenStore,
  HostedShioriAuthTokenStoreLive,
} from "./hostedShioriAuthTokenStore";

const makeTokenStoreLayer = (baseDir: string) =>
  HostedShioriAuthTokenStoreLive.pipe(
    Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir))),
  );

it.layer(NodeServices.layer)("hosted shiori auth token store", (it) => {
  it.effect("persists tokens across fresh service instances", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "hosted-shiori-token-store-" });

      yield* Effect.gen(function* () {
        const store = yield* HostedShioriAuthTokenStore;
        yield* store.setToken("header.payload.signature");
      }).pipe(Effect.provide(makeTokenStoreLayer(baseDir)));

      const restoredToken = yield* Effect.gen(function* () {
        const store = yield* HostedShioriAuthTokenStore;
        return yield* store.getToken;
      }).pipe(Effect.provide(Layer.fresh(makeTokenStoreLayer(baseDir))));

      assert.strictEqual(restoredToken, "header.payload.signature");
    }),
  );

  it.effect("removes the persisted token file when clearing auth", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "hosted-shiori-token-clear-" });
      const tokenPath = getHostedShioriAuthTokenPath(path.join(baseDir, "userdata"));

      yield* Effect.gen(function* () {
        const store = yield* HostedShioriAuthTokenStore;
        yield* store.setToken("header.payload.signature");
        yield* store.setToken(null);
      }).pipe(Effect.provide(makeTokenStoreLayer(baseDir)));

      assert.strictEqual(yield* fs.exists(tokenPath), false);
    }),
  );

  it.effect("writes the persisted token with restrictive permissions on posix", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "hosted-shiori-token-mode-" });
      const tokenPath = getHostedShioriAuthTokenPath(path.join(baseDir, "userdata"));

      yield* Effect.gen(function* () {
        const store = yield* HostedShioriAuthTokenStore;
        yield* store.setToken("header.payload.signature");
      }).pipe(Effect.provide(makeTokenStoreLayer(baseDir)));

      if (process.platform !== "win32") {
        const mode = statSync(tokenPath).mode & 0o777;
        assert.strictEqual(mode, 0o600);
      }
    }),
  );
});
