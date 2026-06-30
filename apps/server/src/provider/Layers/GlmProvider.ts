import type {
  GlmSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "contracts";
import { GLM_DEFAULT_API_BASE_URL, GLM_DEFAULT_API_KEY_ENV_VAR } from "contracts/settings";
import { Effect, Equal, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  formatModelSlugName,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { GlmProvider } from "../Services/GlmProvider";
import { ServerSettingsService } from "../../serverSettings";

const PROVIDER = "glm" as const;

const GLM_BASE_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "max", label: "Max", isDefault: true },
  ],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const GLM_5_2_MODEL_CAPABILITIES: ModelCapabilities = {
  ...GLM_BASE_MODEL_CAPABILITIES,
  contextWindowOptions: [
    { value: "200k", label: "200K" },
    { value: "1m", label: "1M", isDefault: true },
  ],
};

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "glm-5.2",
    name: "GLM-5.2",
    shortName: "5.2",
    isCustom: false,
    multiModal: true,
    capabilities: GLM_5_2_MODEL_CAPABILITIES,
  },
  {
    slug: "glm-5-turbo",
    name: "GLM-5-Turbo",
    shortName: "5 Turbo",
    isCustom: false,
    multiModal: true,
    capabilities: GLM_BASE_MODEL_CAPABILITIES,
  },
  {
    slug: "glm-4.7",
    name: "GLM-4.7",
    shortName: "4.7",
    isCustom: false,
    multiModal: true,
    capabilities: GLM_BASE_MODEL_CAPABILITIES,
  },
];

function trimOrDefault(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function modelsFromSettings(settings: GlmSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    settings.customModels,
    GLM_BASE_MODEL_CAPABILITIES,
  ).map((model) =>
    model.name === model.slug && model.isCustom
      ? { ...model, name: formatModelSlugName(model.slug) }
      : model,
  );
}

function getGlmModelBaseSlug(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\[[^\]]+\]$/u, "");
}

function buildInitialGlmProviderSnapshot(settings: GlmSettings): ServerProvider {
  const checkedAt = new Date().toISOString();
  const models = modelsFromSettings(settings);

  if (!settings.enabled) {
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
        message: "GLM is disabled in ShioriCode settings.",
      },
    });
  }

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
      message: "Checking GLM Coding Plan availability...",
    },
  });
}

const runGlmCommand = Effect.fn("runGlmCommand")(function* (args: ReadonlyArray<string>) {
  const settingsService = yield* ServerSettingsService;
  const glmSettings = yield* settingsService.getSettings.pipe(
    Effect.map((settings) => settings.providers.glm),
  );
  const command = ChildProcess.make(glmSettings.binaryPath, [...args], {
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(glmSettings.binaryPath, command);
});

export const checkGlmProviderStatus = Effect.fn("checkGlmProviderStatus")(function* () {
  const glmSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.glm),
  );
  const checkedAt = new Date().toISOString();
  const models = modelsFromSettings(glmSettings);
  const apiBaseUrl = trimOrDefault(glmSettings.apiBaseUrl, GLM_DEFAULT_API_BASE_URL);
  const apiKeyEnvVar = trimOrDefault(glmSettings.apiKeyEnvVar, GLM_DEFAULT_API_KEY_ENV_VAR);
  const settingsApiKey = glmSettings.apiKey.trim();
  const envApiKey = process.env[apiKeyEnvVar]?.trim() ?? "";

  if (!glmSettings.enabled) {
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
        message: "GLM is disabled in ShioriCode settings.",
      },
    });
  }

  const versionProbe = yield* runGlmCommand(["--version"]).pipe(
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
          ? "Claude Code CLI (`claude`) is required for GLM Coding Plan and was not found on PATH."
          : `Failed to execute GLM Claude Code health check: ${error instanceof Error ? error.message : String(error)}.`,
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
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Code CLI is installed but GLM health check timed out.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Claude Code CLI is installed but failed GLM health check. ${detail}`
          : "Claude Code CLI is installed but failed GLM health check.",
      },
    });
  }

  const hasSettingsApiKey = settingsApiKey.length > 0;
  const hasApiKey = hasSettingsApiKey || envApiKey.length > 0;
  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: parsedVersion,
      status: hasApiKey ? "ready" : "error",
      auth: {
        status: hasApiKey ? "authenticated" : "unauthenticated",
        type: "api-key",
        ...(hasApiKey
          ? { label: hasSettingsApiKey ? "Z.AI GLM Coding Plan key" : apiKeyEnvVar }
          : {}),
      },
      message: hasApiKey
        ? `Using ${hasSettingsApiKey ? "saved GLM API key" : apiKeyEnvVar} with ${apiBaseUrl}.`
        : "Add your Z.AI GLM Coding Plan API key in settings.",
    },
  });
});

export function getGlmModelCapabilities(model: string | null | undefined): ModelCapabilities {
  return getGlmModelBaseSlug(model) === "glm-5.2"
    ? GLM_5_2_MODEL_CAPABILITIES
    : GLM_BASE_MODEL_CAPABILITIES;
}

export const GlmProviderLive = Layer.effect(
  GlmProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const checkProvider = checkGlmProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<GlmSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.glm),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.glm),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
      buildInitialSnapshot: buildInitialGlmProviderSnapshot,
    });
  }),
);
