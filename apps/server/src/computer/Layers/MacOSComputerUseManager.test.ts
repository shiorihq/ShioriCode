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

  it.effect("passes approved app bundle identifiers to list-apps helper calls", () =>
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
          "    filteredByApprovedApps: Array.isArray(input.approvedAppBundleIdentifiers),",
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
              readonly input: {
                readonly approvedAppBundleIdentifiers?: ReadonlyArray<string>;
              };
            };

            assert.equal(result.filteredByApprovedApps, true);
            assert.equal(capture.command, "list-apps");
            assert.deepEqual(capture.input.approvedAppBundleIdentifiers, [
              "com.apple.finder",
              "com.apple.Terminal",
            ]);
          }).pipe(
            Effect.provide(
              ComputerUseManagerLive.pipe(
                Layer.provide(
                  ServerSettingsService.layerTest({
                    computerUse: {
                      enabled: true,
                      approvedApps: [
                        {
                          bundleIdentifier: "com.apple.finder",
                          name: "Finder",
                          approvedAt: "2026-06-04T00:00:00.000Z",
                        },
                        {
                          bundleIdentifier: "com.apple.Terminal",
                          name: "Terminal",
                          approvedAt: "2026-06-04T00:00:00.000Z",
                        },
                      ],
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

  it.effect("passes explicit empty approved app bundle identifiers to list-apps helper calls", () =>
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
          "    filteredByApprovedApps: Array.isArray(input.approvedAppBundleIdentifiers),",
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
              readonly input: {
                readonly approvedAppBundleIdentifiers?: ReadonlyArray<string>;
              };
            };

            assert.equal(result.filteredByApprovedApps, true);
            assert.equal(capture.command, "list-apps");
            assert.deepEqual(capture.input.approvedAppBundleIdentifiers, []);
          }).pipe(
            Effect.provide(
              ComputerUseManagerLive.pipe(
                Layer.provide(
                  ServerSettingsService.layerTest({
                    computerUse: {
                      enabled: true,
                      approvedApps: [],
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

  it.effect("rejects focus-app when no apps are approved before helper resolution", () =>
    Effect.gen(function* () {
      const manager = yield* ComputerUseManager;
      const error = yield* manager
        .focusApp({ bundleIdentifier: "com.apple.Safari" })
        .pipe(Effect.flip);

      assert.equal(error.code, "permissionDenied");
      assert.equal(
        error.message,
        "Computer Use focus is blocked because no apps are approved in Settings > Computer Use.",
      );
    }).pipe(
      Effect.provide(
        ComputerUseManagerLive.pipe(
          Layer.provide(
            ServerSettingsService.layerTest({
              computerUse: {
                enabled: true,
                approvedApps: [],
              },
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("passes approved app bundle identifiers to focus-window helper calls", () =>
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
                readonly approvedAppBundleIdentifiers?: ReadonlyArray<string>;
              };
            };

            assert.equal(result.ok, true);
            assert.equal(capture.command, "focus-window");
            assert.equal(capture.input.bundleIdentifier, "com.apple.Safari");
            assert.equal(capture.input.windowIndex, 1);
            assert.deepEqual(capture.input.approvedAppBundleIdentifiers, ["com.apple.Safari"]);
          }).pipe(
            Effect.provide(
              ComputerUseManagerLive.pipe(
                Layer.provide(
                  ServerSettingsService.layerTest({
                    computerUse: {
                      enabled: true,
                      approvedApps: [
                        {
                          bundleIdentifier: "com.apple.Safari",
                          name: "Safari",
                          approvedAt: "2026-06-04T00:00:00.000Z",
                        },
                      ],
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
