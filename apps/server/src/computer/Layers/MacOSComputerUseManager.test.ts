import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import { ServerSettingsService } from "../../serverSettings";
import { ComputerUseManager } from "../Services/ComputerUseManager";
import { ComputerUseManagerLive } from "./MacOSComputerUseManager";

const withEnvVar = <A, E, R>(
  name: string,
  value: string | undefined,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = previous;
        }
      }),
  );

it.layer(NodeServices.layer)("macOS computer use manager", (it) => {
  it.effect("rejects stale session close requests", () =>
    Effect.gen(function* () {
      const manager = yield* ComputerUseManager;
      const session = yield* manager.createSession;

      yield* manager.closeSession({ sessionId: session.id });

      const error = yield* manager.closeSession({ sessionId: session.id }).pipe(Effect.flip);

      assert.equal(error.code, "sessionNotFound");
      assert.include(error.message, session.id);
    }).pipe(
      Effect.provide(
        ComputerUseManagerLive.pipe(
          Layer.provide(
            ServerSettingsService.layerTest({
              computerUse: {
                enabled: true,
              },
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("rejects desktop actions while Computer Use is disabled", () =>
    Effect.gen(function* () {
      const manager = yield* ComputerUseManager;
      const error = yield* manager.listApps({}).pipe(Effect.flip);

      assert.equal(error.code, "disabled");
    }).pipe(
      Effect.provide(
        ComputerUseManagerLive.pipe(
          Layer.provide(
            ServerSettingsService.layerTest({
              computerUse: {
                enabled: false,
              },
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("forwards list-apps calls to the helper without app filtering", () =>
    Effect.gen(function* () {
      if (process.platform !== "darwin") {
        return;
      }

      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({
        prefix: "shioricode-computer-use-manager-test-",
      });
      const helperPath = `${tempDir}/ShioriComputerUseHelper`;
      const capturePath = `${tempDir}/capture.json`;

      yield* fs.writeFileString(
        helperPath,
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          "const command = process.argv[2];",
          "let stdin = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (chunk) => { stdin += chunk; });",
          "process.stdin.on('end', () => {",
          "  const input = stdin.trim() ? JSON.parse(stdin) : {};",
          "  fs.writeFileSync(process.env.SHIORICODE_CAPTURE_PATH, JSON.stringify({ command, input }));",
          "  process.stdout.write(JSON.stringify({",
          "    sessionId: input.sessionId,",
          "    checkedAt: '2026-06-04T00:00:00.000Z',",
          "    accessibilityTrusted: true,",
          "    apps: []",
          "  }));",
          "});",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(helperPath, 0o755);

      yield* withEnvVar(
        "SHIORICODE_COMPUTER_USE_HELPER_BINARY",
        helperPath,
        withEnvVar(
          "SHIORICODE_CAPTURE_PATH",
          capturePath,
          Effect.gen(function* () {
            const manager = yield* ComputerUseManager;
            const result = yield* manager.listApps({});
            const capture = JSON.parse(yield* fs.readFileString(capturePath)) as {
              readonly command: string;
              readonly input: Record<string, unknown>;
            };

            assert.deepEqual(result.apps, []);
            assert.equal(capture.command, "list-apps");
            assert.notProperty(capture.input, "approvedAppBundleIdentifiers");
          }).pipe(
            Effect.provide(
              ComputerUseManagerLive.pipe(
                Layer.provide(
                  ServerSettingsService.layerTest({
                    computerUse: {
                      enabled: true,
                    },
                  }),
                ),
              ),
            ),
          ),
        ),
      );
    }),
  );

  it.effect("forwards focus-window calls to the helper without approval checks", () =>
    Effect.gen(function* () {
      if (process.platform !== "darwin") {
        return;
      }

      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({
        prefix: "shioricode-computer-use-manager-test-",
      });
      const helperPath = `${tempDir}/ShioriComputerUseHelper`;
      const capturePath = `${tempDir}/capture.json`;

      yield* fs.writeFileString(
        helperPath,
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          "const command = process.argv[2];",
          "let stdin = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (chunk) => { stdin += chunk; });",
          "process.stdin.on('end', () => {",
          "  const input = stdin.trim() ? JSON.parse(stdin) : {};",
          "  fs.writeFileSync(process.env.SHIORICODE_CAPTURE_PATH, JSON.stringify({ command, input }));",
          "  process.stdout.write(JSON.stringify({",
          "    sessionId: input.sessionId,",
          "    ok: true,",
          "    message: 'Focused window.',",
          "    focusedWindow: { index: input.windowIndex, title: 'Target', bounds: null }",
          "  }));",
          "});",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(helperPath, 0o755);

      yield* withEnvVar(
        "SHIORICODE_COMPUTER_USE_HELPER_BINARY",
        helperPath,
        withEnvVar(
          "SHIORICODE_CAPTURE_PATH",
          capturePath,
          Effect.gen(function* () {
            const manager = yield* ComputerUseManager;
            const result = yield* manager.focusWindow({
              bundleIdentifier: "com.apple.Safari",
              windowIndex: 1,
            });
            const capture = JSON.parse(yield* fs.readFileString(capturePath)) as {
              readonly command: string;
              readonly input: {
                readonly bundleIdentifier?: string;
                readonly windowIndex?: number;
              };
            };

            assert.equal(result.ok, true);
            assert.equal(capture.command, "focus-window");
            assert.equal(capture.input.bundleIdentifier, "com.apple.Safari");
            assert.equal(capture.input.windowIndex, 1);
            assert.notProperty(capture.input, "approvedAppBundleIdentifiers");
          }).pipe(
            Effect.provide(
              ComputerUseManagerLive.pipe(
                Layer.provide(
                  ServerSettingsService.layerTest({
                    computerUse: {
                      enabled: true,
                    },
                  }),
                ),
              ),
            ),
          ),
        ),
      );
    }),
  );
});
