import fsSync from "node:fs";
import os from "node:os";

import { assert, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Option, Path } from "effect";

import { NetService } from "shared/Net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { deriveServerPaths, ensureServerDirectories } from "./config";
import { resolveServerConfig } from "./cli";

it.layer(NodeServices.layer)("cli config resolution", (it) => {
  const openBootstrapFd = Effect.fn(function* (payload: Record<string, unknown>) {
    const fs = yield* FileSystem.FileSystem;
    const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-", suffix: ".ndjson" });
    yield* fs.writeFileString(filePath, `${JSON.stringify(payload)}\n`);
    const { fd } = yield* fs.open(filePath, { flag: "r" });
    return fd;
  });

  it.effect("falls back to effect/config values when flags are omitted", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(os.tmpdir(), "t3-cli-config-env-base");
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:5173"));
      const resolved = yield* resolveServerConfig(
        {
          mode: Option.none(),
          port: Option.none(),
          host: Option.none(),
          baseDir: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.none(),
          authToken: Option.none(),
          remote: Option.none(),
          requireAuth: Option.none(),
          unsafeNoAuth: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  SHIORICODE_LOG_LEVEL: "Warn",
                  SHIORICODE_MODE: "desktop",
                  SHIORICODE_PORT: "4001",
                  SHIORICODE_HOST: "0.0.0.0",
                  SHIORICODE_HOME: baseDir,
                  VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
                  SHIORICODE_NO_BROWSER: "true",
                  SHIORICODE_AUTH_TOKEN: "env-token",
                  SHIORICODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
                  SHIORICODE_LOG_WS_EVENTS: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Warn",
        mode: "desktop",
        port: 4001,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "0.0.0.0",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:5173"),
        noBrowser: true,
        authToken: "env-token",
        requireAuth: true,
        unsafeNoAuth: false,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: true,
      });
    }),
  );

  it.effect("uses CLI flags when provided", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(os.tmpdir(), "t3-cli-config-flags-base");
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:4173"));
      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(8788),
          host: Option.some("127.0.0.1"),
          baseDir: Option.some(baseDir),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          noBrowser: Option.some(true),
          authToken: Option.some("flag-token"),
          remote: Option.none(),
          requireAuth: Option.none(),
          unsafeNoAuth: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.some(true),
          logWebSocketEvents: Option.some(true),
        },
        Option.some("Debug"),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  SHIORICODE_LOG_LEVEL: "Warn",
                  SHIORICODE_MODE: "desktop",
                  SHIORICODE_PORT: "4001",
                  SHIORICODE_HOST: "0.0.0.0",
                  SHIORICODE_HOME: join(os.tmpdir(), "ignored-base"),
                  VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
                  SHIORICODE_NO_BROWSER: "false",
                  SHIORICODE_AUTH_TOKEN: "ignored-token",
                  SHIORICODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
                  SHIORICODE_LOG_WS_EVENTS: "false",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Debug",
        mode: "web",
        port: 8788,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:4173"),
        noBrowser: true,
        authToken: "flag-token",
        requireAuth: false,
        unsafeNoAuth: false,
        autoBootstrapProjectFromCwd: true,
        logWebSocketEvents: true,
      });
    }),
  );

  it.effect("uses bootstrap envelope values as fallbacks when flags and env are absent", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = "/tmp/t3-bootstrap-home";
      const fd = yield* openBootstrapFd({
        mode: "desktop",
        port: 4888,
        host: "127.0.0.2",
        shioriCodeHome: baseDir,
        devUrl: "http://127.0.0.1:5173",
        noBrowser: true,
        authToken: "bootstrap-token",
        requireAuth: true,
        unsafeNoAuth: false,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: true,
      });
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:5173"));

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.none(),
          port: Option.none(),
          host: Option.none(),
          baseDir: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.none(),
          authToken: Option.none(),
          remote: Option.none(),
          requireAuth: Option.none(),
          unsafeNoAuth: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  SHIORICODE_BOOTSTRAP_FD: String(fd),
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Info",
        mode: "desktop",
        port: 4888,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.2",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:5173"),
        noBrowser: true,
        authToken: "bootstrap-token",
        requireAuth: true,
        unsafeNoAuth: false,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: true,
      });
      assert.equal(join(baseDir, "dev"), resolved.stateDir);
    }),
  );

  it.effect("creates derived runtime directories during config resolution", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-config-dirs-" });

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("desktop"),
          port: Option.some(4888),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          devUrl: Option.some(new URL("http://127.0.0.1:5173")),
          noBrowser: Option.none(),
          authToken: Option.none(),
          remote: Option.none(),
          requireAuth: Option.none(),
          unsafeNoAuth: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );

      for (const directory of [
        resolved.stateDir,
        resolved.logsDir,
        resolved.providerLogsDir,
        resolved.terminalLogsDir,
        resolved.attachmentsDir,
        resolved.worktreesDir,
        path.dirname(resolved.serverLogPath),
      ]) {
        expect(yield* fs.exists(directory)).toBe(true);
      }
    }),
  );

  it.effect("defaults web mode to a loopback host when none is configured", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-config-loopback-" });

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(4888),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          devUrl: Option.none(),
          noBrowser: Option.none(),
          authToken: Option.none(),
          remote: Option.none(),
          requireAuth: Option.none(),
          unsafeNoAuth: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );

      expect(resolved.host).toBe("127.0.0.1");
    }),
  );

  it.effect("applies flag then env precedence over bootstrap envelope values", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(os.tmpdir(), "t3-cli-config-env-wins");
      const fd = yield* openBootstrapFd({
        mode: "desktop",
        port: 4888,
        host: "127.0.0.2",
        shioriCodeHome: "/tmp/t3-bootstrap-home",
        devUrl: "http://127.0.0.1:5173",
        noBrowser: false,
        authToken: "bootstrap-token",
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
      });
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:4173"));

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.none(),
          port: Option.some(8788),
          host: Option.some("127.0.0.1"),
          baseDir: Option.none(),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          noBrowser: Option.none(),
          authToken: Option.some("flag-token"),
          remote: Option.none(),
          requireAuth: Option.none(),
          unsafeNoAuth: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.some("Debug"),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  SHIORICODE_MODE: "web",
                  SHIORICODE_BOOTSTRAP_FD: String(fd),
                  SHIORICODE_HOME: baseDir,
                  SHIORICODE_NO_BROWSER: "true",
                  SHIORICODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
                  SHIORICODE_LOG_WS_EVENTS: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Debug",
        mode: "web",
        port: 8788,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:4173"),
        noBrowser: true,
        authToken: "flag-token",
        requireAuth: false,
        unsafeNoAuth: false,
        autoBootstrapProjectFromCwd: true,
        logWebSocketEvents: true,
      });
    }),
  );

  it.effect("preserves explicit false flags when environment values are true", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-false-flags-" });
      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(4888),
          host: Option.some("127.0.0.1"),
          baseDir: Option.some(baseDir),
          devUrl: Option.none(),
          noBrowser: Option.some(false),
          authToken: Option.none(),
          remote: Option.some(false),
          requireAuth: Option.some(false),
          unsafeNoAuth: Option.some(false),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.some(false),
          logWebSocketEvents: Option.some(false),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  SHIORICODE_NO_BROWSER: "true",
                  SHIORICODE_REMOTE: "true",
                  SHIORICODE_REQUIRE_AUTH: "true",
                  SHIORICODE_UNSAFE_NO_AUTH: "true",
                  SHIORICODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
                  SHIORICODE_LOG_WS_EVENTS: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved.noBrowser).toBe(false);
      expect(resolved.requireAuth).toBe(false);
      expect(resolved.unsafeNoAuth).toBe(false);
      expect(resolved.autoBootstrapProjectFromCwd).toBe(false);
      expect(resolved.logWebSocketEvents).toBe(false);
    }),
  );

  it.effect("honors remote and unsafe-no-auth from the bootstrap envelope", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-bootstrap-auth-" });
      const remoteFd = yield* openBootstrapFd({
        host: "127.0.0.42",
        remote: true,
        requireAuth: false,
        unsafeNoAuth: false,
      });
      const unsafeFd = yield* openBootstrapFd({
        host: "0.0.0.0",
        remote: true,
        requireAuth: true,
        unsafeNoAuth: true,
      });
      const resolve = (bootstrapFd: number) =>
        resolveServerConfig(
          {
            mode: Option.some("web"),
            port: Option.some(4888),
            host: Option.none(),
            baseDir: Option.some(baseDir),
            devUrl: Option.none(),
            noBrowser: Option.none(),
            authToken: Option.none(),
            remote: Option.none(),
            requireAuth: Option.none(),
            unsafeNoAuth: Option.none(),
            bootstrapFd: Option.some(bootstrapFd),
            autoBootstrapProjectFromCwd: Option.none(),
            logWebSocketEvents: Option.none(),
          },
          Option.none(),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
              NetService.layer,
            ),
          ),
        );

      const remote = yield* resolve(remoteFd);
      expect(remote.host).toBe("127.0.0.42");
      expect(remote.requireAuth).toBe(true);
      expect(remote.unsafeNoAuth).toBe(false);

      const unsafe = yield* resolve(unsafeFd);
      expect(unsafe.requireAuth).toBe(false);
      expect(unsafe.unsafeNoAuth).toBe(true);
    }),
  );

  it.effect("creates new base and state directories for the owner only", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-private-state-" });
      const baseDir = `${parentDir}/shiori-home`;

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(4888),
          host: Option.some("127.0.0.1"),
          baseDir: Option.some(baseDir),
          devUrl: Option.none(),
          noBrowser: Option.none(),
          authToken: Option.none(),
          remote: Option.none(),
          requireAuth: Option.none(),
          unsafeNoAuth: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );

      expect(fsSync.statSync(baseDir).mode & 0o777).toBe(0o700);
      expect(fsSync.statSync(resolved.stateDir).mode & 0o777).toBe(0o700);
    }),
  );

  it.effect("hardens a pre-existing default base directory on upgrade", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-default-upgrade-" });
      const baseDir = `${parentDir}/.shiori`;
      yield* fs.makeDirectory(baseDir);
      yield* fs.chmod(baseDir, 0o755);
      const derivedPaths = yield* deriveServerPaths(baseDir, undefined);

      yield* ensureServerDirectories(derivedPaths, { hardenBaseDir: true });

      expect(fsSync.statSync(baseDir).mode & 0o777).toBe(0o700);
      expect(fsSync.statSync(derivedPaths.stateDir).mode & 0o777).toBe(0o700);
    }),
  );

  it.effect("does not chmod a pre-existing shared base directory", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-shared-base-" });
      fsSync.chmodSync(baseDir, 0o755);

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(4888),
          host: Option.some("127.0.0.1"),
          baseDir: Option.some(baseDir),
          devUrl: Option.none(),
          noBrowser: Option.none(),
          authToken: Option.none(),
          remote: Option.none(),
          requireAuth: Option.none(),
          unsafeNoAuth: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );

      expect(fsSync.statSync(baseDir).mode & 0o777).toBe(0o755);
      expect(fsSync.statSync(resolved.stateDir).mode & 0o777).toBe(0o700);
    }),
  );
});
