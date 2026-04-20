import type {
  KimiCodeSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "contracts";
import { Effect, Layer, Option, Result, Stream } from "effect";
import { ChildProcessSpawner, ChildProcess } from "effect/unstable/process";
import { isLoggedIn, parseConfig } from "@moonshot-ai/kimi-agent-sdk";

import {
  buildPendingServerProvider,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { KimiCodeProvider } from "../Services/KimiCodeProvider";
import { ServerSettingsService } from "../../serverSettings";

const PROVIDER = "kimiCode" as const;
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "kimi-code/kimi-for-coding",
    name: "Kimi K2.6",
    isCustom: false,
    multiModal: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: true,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
];

function buildPendingKimiCodeProviderStatus(settings: KimiCodeSettings): ServerProvider {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(BUILT_IN_MODELS, PROVIDER, settings.customModels);

  if (!settings.enabled) {
    return buildPendingServerProvider({
      provider: PROVIDER,
      enabled: false,
      installed: false,
      checkedAt,
      models,
      message: "Kimi Code is disabled in ShioriCode settings.",
    });
  }

  return buildPendingServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    message: "Checking Kimi Code CLI availability...",
  });
}

function modelsFromConfig(_settings: KimiCodeSettings): ReadonlyArray<ServerProviderModel> {
  // Keep Kimi pinned to a single model, but use the configured model key that
  // the local Kimi CLI actually expects.
  const shareDir = _settings.shareDir.trim() || undefined;
  const config = parseConfig(shareDir);
  const selectedModel = config.models.find(
    (model) =>
      model.name.toLowerCase() === "kimi-k2.6" ||
      model.id === "kimi-code/kimi-for-coding" ||
      model.id === "kimi-for-coding",
  );
  if (!selectedModel) {
    return BUILT_IN_MODELS;
  }
  return [
    {
      slug: selectedModel.id,
      name: selectedModel.name,
      isCustom: false,
      multiModal: false,
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: true,
        contextWindowOptions: [],
        promptInjectedEffortLevels: [],
      } satisfies ModelCapabilities,
    },
  ];
}

const runKimiCommand = Effect.fn("runKimiCommand")(function* (args: ReadonlyArray<string>) {
  const settingsService = yield* ServerSettingsService;
  const kimiSettings = yield* settingsService.getSettings.pipe(
    Effect.map((settings) => settings.providers.kimiCode),
  );
  const binaryPath = kimiSettings.binaryPath.trim() || "kimi";
  const shareDir = kimiSettings.shareDir.trim();
  const command = ChildProcess.make(binaryPath, [...args], {
    shell: process.platform === "win32",
    env: {
      ...process.env,
      ...(shareDir ? { KIMI_SHARE_DIR: shareDir } : {}),
    },
  });
  return yield* spawnAndCollect(binaryPath, command);
});

export const checkKimiCodeProviderStatus = Effect.fn("checkKimiCodeProviderStatus")(function* () {
  const kimiSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.kimiCode),
  );
  const checkedAt = new Date().toISOString();
  const models = modelsFromConfig(kimiSettings);

  if (!kimiSettings.enabled) {
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
        message: "Kimi Code is disabled in ShioriCode settings.",
      },
    });
  }

  const versionProbe = yield* runKimiCommand(["--version"]).pipe(
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
          ? "Kimi Code CLI (`kimi`) is not installed or not on PATH."
          : `Failed to execute Kimi Code CLI health check: ${
              error instanceof Error ? error.message : String(error)
            }.`,
      },
    });
  }

  if (Result.isSuccess(versionProbe) && Option.isNone(versionProbe.success)) {
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
        message: "Timed out while checking Kimi Code CLI version.",
      },
    });
  }

  const versionResult =
    Result.isSuccess(versionProbe) && Option.isSome(versionProbe.success)
      ? versionProbe.success.value
      : null;
  const version = versionResult ? parseGenericCliVersion(versionResult.stdout) : null;
  const shareDir = kimiSettings.shareDir.trim() || undefined;
  const loggedIn = isLoggedIn(shareDir);

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
        ...(loggedIn ? { label: "Signed in to Kimi Code" } : {}),
      },
      ...(!loggedIn
        ? {
            message: "Kimi Code CLI is not authenticated. Run `kimi login` and try again.",
          }
        : {}),
    },
  });
});

export const KimiCodeProviderLive = Layer.effect(
  KimiCodeProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const checkProvider = checkKimiCodeProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<KimiCodeSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.kimiCode),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.kimiCode),
      ),
      haveSettingsChanged: (previous, next) =>
        previous.enabled !== next.enabled ||
        previous.binaryPath !== next.binaryPath ||
        previous.shareDir !== next.shareDir ||
        JSON.stringify(previous.customModels) !== JSON.stringify(next.customModels),
      checkProvider,
      buildInitialSnapshot: buildPendingKimiCodeProviderStatus,
      refreshInterval: "60 seconds",
    });
  }),
);
