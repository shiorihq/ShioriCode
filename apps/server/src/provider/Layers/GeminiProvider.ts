import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import type {
  GeminiSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "contracts";
import { Effect, Equal, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerSettingsService } from "../../serverSettings";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import {
  buildPendingServerProvider,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot";
import { detectGeminiAcpFlag, normalizeGeminiAcpFlag } from "../acp/GeminiAcpSupport";
import { GeminiProvider } from "../Services/GeminiProvider";

const PROVIDER = "gemini" as const;
const GEMINI_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Gemini (Auto)",
    shortName: "Auto",
    isCustom: false,
    multiModal: true,
    capabilities: GEMINI_MODEL_CAPABILITIES,
  },
];

function buildPendingGeminiProviderStatus(settings: GeminiSettings): ServerProvider {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    settings.customModels,
    GEMINI_MODEL_CAPABILITIES,
  );

  if (!settings.enabled) {
    return buildPendingServerProvider({
      provider: PROVIDER,
      enabled: false,
      installed: false,
      checkedAt,
      models,
      message: "Gemini is disabled in ShioriCode settings.",
    });
  }

  return buildPendingServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    message: "Checking Gemini CLI availability...",
  });
}

function hasGeminiOAuthCache(): boolean {
  const geminiDir = nodePath.join(nodeOs.homedir(), ".gemini");
  return (
    nodeFs.existsSync(nodePath.join(geminiDir, "oauth_creds.json")) ||
    nodeFs.existsSync(nodePath.join(geminiDir, "google_accounts.json"))
  );
}

const runGeminiCommand = Effect.fn("runGeminiCommand")(function* (args: ReadonlyArray<string>) {
  const geminiSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.gemini),
  );
  const binaryPath = geminiSettings.binaryPath.trim() || "gemini";
  const command = ChildProcess.make(binaryPath, [...args], {
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(binaryPath, command);
});

export const checkGeminiProviderStatus = Effect.fn("checkGeminiProviderStatus")(function* () {
  const geminiSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.gemini),
  );
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    geminiSettings.customModels,
    GEMINI_MODEL_CAPABILITIES,
  );

  if (!geminiSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Gemini is disabled in ShioriCode settings.",
      },
    });
  }

  const versionProbe = yield* runGeminiCommand(["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Gemini CLI (`gemini`) is not installed or not on PATH."
          : `Failed to execute Gemini CLI health check: ${
              error instanceof Error ? error.message : String(error)
            }.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Timed out while checking Gemini CLI version.",
      },
    });
  }

  const versionResult = versionProbe.success.value;
  const version = parseGenericCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  const explicitFlag = geminiSettings.acpFlag.trim();
  const normalizedExplicitFlag = normalizeGeminiAcpFlag(explicitFlag);
  if (explicitFlag && !normalizedExplicitFlag) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Gemini ACP flag must be either `--acp` or `--experimental-acp` when configured.",
      },
    });
  }

  const binaryPath = geminiSettings.binaryPath.trim() || "gemini";
  const acpFlag =
    normalizedExplicitFlag ??
    (yield* detectGeminiAcpFlag(binaryPath).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.map((result) => (Option.isSome(result) ? result.value : "--acp")),
    ));
  const loggedIn = hasGeminiOAuthCache();
  const usingLegacyFlag = acpFlag === "--experimental-acp";
  const hasApiKeyEnv = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  const messages = [
    !loggedIn
      ? "Gemini CLI is not authenticated. Run `gemini` and choose Sign in with Google."
      : "",
    usingLegacyFlag
      ? "This Gemini CLI exposes ACP as `--experimental-acp`; upgrade for `--acp`."
      : "",
    hasApiKeyEnv
      ? "Gemini API key environment variables are present, but ShioriCode clears them for this provider so subscription OAuth is used."
      : "",
  ].filter((message) => message.length > 0);

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: loggedIn ? "ready" : "error",
      auth: {
        status: loggedIn ? "authenticated" : "unauthenticated",
        type: "oauth-personal",
        ...(loggedIn ? { label: "Signed in with Google" } : {}),
      },
      ...(messages.length > 0 ? { message: messages.join(" ") } : {}),
    },
  });
});

export const GeminiProviderLive = Layer.effect(
  GeminiProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const checkProvider = checkGeminiProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<GeminiSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.gemini),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.gemini),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
      buildInitialSnapshot: buildPendingGeminiProviderStatus,
    });
  }),
);
