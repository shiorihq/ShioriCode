import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  McpServerEntry,
  ServerSettings,
  ServerSettingsPatch,
} from "contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { ServerConfig } from "./config";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings";

const makeServerSettingsLayer = () =>
  ServerSettingsLive.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "shioricode-server-settings-test-",
        }),
      ),
    ),
  );

it.layer(NodeServices.layer)("server settings", (it) => {
  it.effect("decodes nested settings patches", () =>
    Effect.sync(() => {
      const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

      assert.deepEqual(decodePatch({ providers: { codex: { binaryPath: "/tmp/codex" } } }), {
        providers: { codex: { binaryPath: "/tmp/codex" } },
      });

      assert.deepEqual(
        decodePatch({
          assistantPersonality: "friendly",
        }),
        {
          assistantPersonality: "friendly",
        },
      );

      assert.deepEqual(
        decodePatch({
          textGenerationModelSelection: {
            provider: "codex",
            options: {
              fastMode: false,
            },
          },
        }),
        {
          textGenerationModelSelection: {
            provider: "codex",
            options: {
              fastMode: false,
            },
          },
        },
      );

      assert.deepEqual(
        decodePatch({
          onboarding: {
            completedStepIds: ["connect-provider"],
          },
        }),
        {
          onboarding: {
            completedStepIds: ["connect-provider"],
          },
        },
      );
    }),
  );

  it.effect("deep merges nested settings updates without dropping siblings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/usr/local/bin/codex",
            homePath: "/Users/julius/.codex",
          },
          claudeAgent: {
            binaryPath: "/usr/local/bin/claude",
            customModels: ["claude-custom"],
          },
        },
        textGenerationModelSelection: {
          provider: "codex",
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: {
            reasoningEffort: "high",
            fastMode: true,
          },
        },
      });

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
        },
        textGenerationModelSelection: {
          options: {
            fastMode: false,
          },
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "/Users/julius/.codex",
        customModels: [],
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/usr/local/bin/claude",
        customModels: ["claude-custom"],
      });
      assert.deepEqual(next.textGenerationModelSelection, {
        provider: "codex",
        model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
        options: {
          reasoningEffort: "high",
          fastMode: false,
        },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves model when switching providers via textGenerationModelSelection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      // Start with Claude text generation selection
      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "high",
          },
        },
      });

      // Switch to Codex — the stale Claude "effort" in options must not
      // cause the update to lose the selected model.
      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          provider: "codex",
          model: "gpt-5.4",
          options: {
            reasoningEffort: "high",
          },
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        provider: "codex",
        model: "gpt-5.4",
        options: {
          reasoningEffort: "high",
        },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("falls back to an enabled provider for defaultModelSelection at read time", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      yield* serverSettings.updateSettings({
        defaultModelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
        providers: {
          claudeAgent: {
            enabled: false,
          },
          shiori: {
            enabled: true,
          },
          codex: {
            enabled: true,
          },
        },
      });

      const next = yield* serverSettings.getSettings;

      assert.deepEqual(next.defaultModelSelection, {
        provider: "shiori",
        model: "openai/gpt-5.4",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("trims provider path settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "  /opt/homebrew/bin/codex  ",
            homePath: "   ",
          },
          claudeAgent: {
            binaryPath: "  /opt/homebrew/bin/claude  ",
          },
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "",
        customModels: [],
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/claude",
        customModels: [],
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("defaults blank binary paths to provider executables", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "   ",
          },
          claudeAgent: {
            binaryPath: "",
          },
        },
      });

      assert.equal(next.providers.codex.binaryPath, "codex");
      assert.equal(next.providers.claudeAgent.binaryPath, "claude");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("writes only non-default server settings to disk", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
        },
      });

      assert.equal(next.providers.codex.binaryPath, "/opt/homebrew/bin/codex");

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.deepEqual(JSON.parse(raw), {
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
        },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("decodes MCP server entries in settings patch", () =>
    Effect.sync(() => {
      const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

      assert.deepEqual(
        decodePatch({
          mcpServers: {
            servers: [
              { name: "GitHub", transport: "stdio", command: "npx", args: ["-y", "mcp-github"] },
            ],
          },
        }),
        {
          mcpServers: {
            servers: [
              {
                name: "GitHub",
                transport: "stdio",
                command: "npx",
                args: ["-y", "mcp-github"],
                enabled: true,
                providers: [],
              },
            ],
          },
        },
      );
    }),
  );

  it.effect("decodes MCP server entries for all transport types", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownSync(McpServerEntry);

      // stdio
      assert.deepEqual(decode({ name: "fs", transport: "stdio", command: "node" }), {
        name: "fs",
        transport: "stdio",
        command: "node",
        enabled: true,
        providers: [],
      });

      // sse
      assert.deepEqual(decode({ name: "remote", transport: "sse", url: "https://x.com/sse" }), {
        name: "remote",
        transport: "sse",
        url: "https://x.com/sse",
        enabled: true,
        providers: [],
      });

      // http
      assert.deepEqual(
        decode({
          name: "api",
          transport: "http",
          url: "https://api.example.com",
          headers: { Authorization: "Bearer token" },
          envHttpHeaders: { "X-Team": "MCP_TEAM" },
          bearerTokenEnvVar: "API_TOKEN",
          oauthScopes: ["read", "write"],
          oauthResource: "https://api.example.com",
          providers: ["claudeAgent"],
        }),
        {
          name: "api",
          transport: "http",
          url: "https://api.example.com",
          headers: { Authorization: "Bearer token" },
          envHttpHeaders: { "X-Team": "MCP_TEAM" },
          bearerTokenEnvVar: "API_TOKEN",
          oauthScopes: ["read", "write"],
          oauthResource: "https://api.example.com",
          enabled: true,
          providers: ["claudeAgent"],
        },
      );
    }),
  );

  it.effect("backward-compatible when mcpServers is missing", () =>
    Effect.sync(() => {
      const settings = Schema.decodeUnknownSync(ServerSettings)({});
      assert.deepEqual(settings.mcpServers, { servers: [] });
    }),
  );

  it.effect("persists and round-trips MCP server settings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        mcpServers: {
          servers: [
            {
              name: "GitHub",
              transport: "stdio",
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-github"],
              enabled: true,
              providers: [],
            },
            {
              name: "API Server",
              transport: "http",
              url: "https://mcp.example.com",
              enabled: false,
              providers: ["claudeAgent"],
            },
          ],
        },
      });

      const written = next.mcpServers.servers;
      assert.equal(written.length, 2);
      const [first, second] = written;
      assert.ok(first !== undefined && second !== undefined);
      assert.equal(first.name, "GitHub");
      assert.equal(first.transport, "stdio");
      assert.equal(second.name, "API Server");
      assert.equal(second.enabled, false);
      assert.deepEqual(second.providers, ["claudeAgent"]);

      // Re-read to confirm round-trip
      const reread = yield* serverSettings.getSettings;
      assert.deepEqual(reread.mcpServers, next.mcpServers);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
});
