import { discoverLocalHarness } from "google-antigravity/connections/local";

import type {
  GeminiSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "contracts";
import { Effect, Equal, Layer, Stream } from "effect";

import {
  buildPendingServerProvider,
  buildServerProvider,
  providerModelsFromSettings,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { GeminiProvider } from "../Services/GeminiProvider";
import { ServerSettingsService } from "../../serverSettings";

const PROVIDER = "gemini" as const;
const SDK_DEFAULT_MODEL = "gemini-3.5-flash";
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
    name: "Antigravity (Default)",
    shortName: "Default",
    isCustom: false,
    multiModal: true,
    capabilities: GEMINI_MODEL_CAPABILITIES,
  },
  {
    slug: SDK_DEFAULT_MODEL,
    name: "Gemini 3.5 Flash",
    shortName: "3.5 Flash",
    isCustom: false,
    multiModal: true,
    capabilities: GEMINI_MODEL_CAPABILITIES,
  },
];

function modelsFromSettings(settings: GeminiSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    settings.customModels,
    GEMINI_MODEL_CAPABILITIES,
  );
}

function trimOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildPendingGeminiProviderStatus(settings: GeminiSettings): ServerProvider {
  const checkedAt = new Date().toISOString();
  const models = modelsFromSettings(settings);

  if (!settings.enabled) {
    return buildPendingServerProvider({
      provider: PROVIDER,
      enabled: false,
      installed: false,
      checkedAt,
      models,
      message: "Antigravity is disabled in ShioriCode settings.",
    });
  }

  return buildPendingServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    message: "Checking Antigravity local harness availability...",
  });
}

export const checkGeminiProviderStatus = Effect.fn("checkGeminiProviderStatus")(function* () {
  const geminiSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.gemini),
  );
  const checkedAt = new Date().toISOString();
  const models = modelsFromSettings(geminiSettings);

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
        message: "Antigravity is disabled in ShioriCode settings.",
      },
    });
  }

  const runtimePath = discoverLocalHarness(trimOrUndefined(geminiSettings.binaryPath));
  if (!runtimePath) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Antigravity localharness was not found. Set the provider binary path to localharness or configure ANTIGRAVITY_LOCALHARNESS_PATH.",
      },
    });
  }

  const hasApiKey = Boolean(process.env.GEMINI_API_KEY);
  const hasVertexProject = Boolean(trimOrUndefined(geminiSettings.googleCloudProject));
  const authenticated = hasApiKey || hasVertexProject;
  const authMessage = authenticated
    ? hasApiKey
      ? "Using GEMINI_API_KEY for Antigravity SDK authentication."
      : "Using Vertex AI project settings for Antigravity SDK authentication."
    : "Antigravity SDK requires GEMINI_API_KEY, or a Vertex AI project in provider settings.";

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: authenticated ? "ready" : "error",
      auth: {
        status: authenticated ? "authenticated" : "unauthenticated",
        type: hasApiKey ? "api-key" : "vertex-ai",
        ...(authenticated ? { label: hasApiKey ? "Gemini API key" : "Vertex AI" } : {}),
      },
      message: authMessage,
    },
  });
});

export const GeminiProviderLive = Layer.effect(
  GeminiProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const checkProvider = checkGeminiProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
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
