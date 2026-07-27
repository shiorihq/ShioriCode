import * as NodeServices from "@effect/platform-node/NodeServices";
import fsSync from "node:fs";
import path from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { deriveServerPaths, type ServerConfigShape } from "./config";
import { LinkRemoteStore } from "./remote/linkStore";
import { RemoteStateStore } from "./remote/remoteStateStore";
import {
  buildServerInstanceUrl,
  clearServerInstanceRecord,
  hardenExistingServerInstanceRecordBeforeListen,
  hasConfiguredStartupAuthentication,
  writeServerInstanceRecord,
} from "./server";

const makeConfig = Effect.fn(function* (baseDir: string, overrides?: Partial<ServerConfigShape>) {
  const derivedPaths = yield* deriveServerPaths(baseDir, undefined);
  return {
    logLevel: "Error",
    mode: "web",
    port: 3773,
    host: "127.0.0.1",
    cwd: process.cwd(),
    baseDir,
    ...derivedPaths,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    requireAuth: false,
    unsafeNoAuth: false,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    ...overrides,
  } satisfies ServerConfigShape;
});

it.layer(NodeServices.layer)("server instance record", (it) => {
  it.effect("brackets bare IPv6 hosts in the WebSocket URL", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "shiori-instance-ipv6-" });
      const bare = yield* makeConfig(baseDir, { host: "::1" });
      const tailnet = yield* makeConfig(baseDir, { host: "fd7a:115c:a1e0::42" });
      const bracketed = yield* makeConfig(baseDir, { host: "[fd7a:115c:a1e0::43]" });

      expect(buildServerInstanceUrl(bare)).toBe("ws://[::1]:3773/ws");
      expect(buildServerInstanceUrl(tailnet)).toBe("ws://[fd7a:115c:a1e0::42]:3773/ws");
      expect(buildServerInstanceUrl(bracketed)).toBe("ws://[fd7a:115c:a1e0::43]:3773/ws");
    }),
  );

  it.effect("writes credentials in an owner-only record", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "shiori-instance-mode-" });
      const config = yield* makeConfig(baseDir, { authToken: "top-secret" });

      yield* writeServerInstanceRecord(fs, config);
      const record = yield* fs.readFileString(config.serverInstancePath);
      expect(record).toContain("top-secret");
      expect(JSON.parse(record).bootId).toEqual(expect.any(String));
      if (process.platform !== "win32") {
        expect((yield* fs.stat(config.serverInstancePath)).mode & 0o777).toBe(0o600);
      }
    }),
  );

  it.effect("atomically replaces a legacy world-readable record", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "shiori-instance-upgrade-" });
      const config = yield* makeConfig(baseDir, { authToken: "replacement-secret" });
      yield* fs.writeFileString(config.serverInstancePath, "legacy-record", { mode: 0o644 });
      yield* fs.chmod(config.serverInstancePath, 0o644);
      const previousInode = fsSync.statSync(config.serverInstancePath).ino;
      const temporaryWriteOptions: unknown[] = [];
      const observingFs = {
        ...fs,
        writeFileString: (path, contents, options) => {
          if (path.endsWith(".tmp")) temporaryWriteOptions.push(options);
          return fs.writeFileString(path, contents, options);
        },
      } satisfies FileSystem.FileSystem;

      yield* writeServerInstanceRecord(observingFs, config);

      const current = fsSync.statSync(config.serverInstancePath);
      expect(temporaryWriteOptions).toEqual([{ flag: "wx", mode: 0o600 }]);
      expect(current.ino).not.toBe(previousInode);
      expect(current.mode & 0o777).toBe(0o600);
      expect(yield* fs.readFileString(config.serverInstancePath)).toContain("replacement-secret");
    }),
  );

  it.effect("hardens a legacy record during the pre-listen startup phase", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "shiori-instance-prelisten-" });
      const config = yield* makeConfig(baseDir);
      yield* fs.writeFileString(config.serverInstancePath, "legacy", { mode: 0o644 });
      yield* fs.chmod(config.serverInstancePath, 0o644);

      hardenExistingServerInstanceRecordBeforeListen(config.serverInstancePath);

      expect(fsSync.statSync(config.serverInstancePath).mode & 0o777).toBe(0o600);
    }),
  );

  it.effect("fails closed when a secure legacy-record replacement cannot be published", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "shiori-instance-failure-" });
      const config = yield* makeConfig(baseDir, { authToken: "still-valid-secret" });
      yield* fs.writeFileString(config.serverInstancePath, "legacy-still-valid-secret", {
        mode: 0o644,
      });
      yield* fs.chmod(config.serverInstancePath, 0o644);
      let routesMarkedReady = false;
      const failingFs = {
        ...fs,
        rename: (oldPath, _newPath) =>
          fs.rename(oldPath, path.join(baseDir, "missing-parent", "server-instance.json")),
      } satisfies FileSystem.FileSystem;

      yield* Effect.flip(
        Effect.gen(function* () {
          yield* writeServerInstanceRecord(failingFs, config);
          routesMarkedReady = true;
        }),
      );

      expect(routesMarkedReady).toBe(false);
      expect(fsSync.statSync(config.serverInstancePath).mode & 0o777).toBe(0o600);
      expect(yield* fs.readFileString(config.serverInstancePath)).toBe("legacy-still-valid-secret");
    }),
  );

  it.effect("turns URL construction errors into a catchable write failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "shiori-instance-invalid-" });
      const config = yield* makeConfig(baseDir, { host: "invalid host" });

      const error = yield* Effect.flip(writeServerInstanceRecord(fs, config));
      expect(error).toBeInstanceOf(Error);
      expect(yield* fs.exists(config.serverInstancePath)).toBe(false);
    }),
  );

  it.effect("removes a corrupt record during shutdown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "shiori-instance-corrupt-" });
      const config = yield* makeConfig(baseDir);
      yield* fs.writeFileString(config.serverInstancePath, "{not-json");

      yield* clearServerInstanceRecord(fs, config);
      expect(yield* fs.exists(config.serverInstancePath)).toBe(false);
    }),
  );

  it.effect("accepts a fully configured Link account as startup authentication", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "shiori-instance-link-auth-" });
      const config = yield* makeConfig(baseDir, { requireAuth: true });
      const link = new LinkRemoteStore({ stateDir: config.stateDir });
      link.setAccount({ accessToken: "access-token", refreshToken: "refresh-token" });
      link.setConnector({
        environmentRecordId: "record-1",
        environmentId: "environment-1",
        endpoint: "https://example.shiori.link",
        serverAddr: "relay.example.com",
        serverPort: 7000,
        serverTls: true,
        token: "connector-token",
        updatedAt: "2026-07-23T00:00:00.000Z",
      });
      new RemoteStateStore({ stateDir: config.stateDir }).setReconciled("shiori-link");

      expect(hasConfiguredStartupAuthentication(config, {})).toBe(true);
    }),
  );
});
