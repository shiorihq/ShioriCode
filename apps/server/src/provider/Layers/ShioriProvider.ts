import type {
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
  ServerProviderAuth,
  ServerProviderState,
} from "contracts";
import { Effect, Layer, Stream } from "effect";

import {
  buildPendingServerProvider,
  buildServerProvider,
  providerModelsFromSettings,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { ShioriProvider } from "../Services/ShioriProvider";
import { HostedShioriAuthTokenStore } from "../../hostedShioriAuthTokenStore.ts";
import { ServerSettingsService } from "../../serverSettings";
import { fetchShioriCodeEntitlements } from "../shioriCodeEntitlements";

const PROVIDER = "shiori" as const;
const JWT_LIKE_TOKEN_PATTERN = /^[^.]+\.[^.]+\.[^.]+$/;

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "openai/gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium", isDefault: true },
        { value: "high", label: "High" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
  {
    slug: "openai/gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium", isDefault: true },
        { value: "high", label: "High" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
  {
    slug: "anthropic/claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium", isDefault: true },
        { value: "high", label: "High" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: true,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
  {
    slug: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
  {
    slug: "qwen/qwen3.5-plus-02-15",
    name: "Qwen3.5 Plus",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: true,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
];

function hasHostedShioriAuthToken(token: string | null): boolean {
  return typeof token === "string" && JWT_LIKE_TOKEN_PATTERN.test(token.trim());
}

function buildShioriAuth(settings: {
  apiBaseUrl: string;
  authToken: string | null;
  entitlementPlan?: string | null;
}): Pick<ServerProviderAuth, "status" | "label"> {
  return hasHostedShioriAuthToken(settings.authToken)
    ? {
        status: "authenticated",
        label:
          typeof settings.entitlementPlan === "string" && settings.entitlementPlan.length > 0
            ? `Shiori · ${settings.entitlementPlan}`
            : "Signed in to Shiori",
      }
    : {
        status: "unknown",
        label: settings.apiBaseUrl
          ? "Sign in through the Shiori auth screen"
          : "Configure Shiori API base URL",
      };
}

const buildShioriProviderStatus = Effect.fn("buildShioriProviderStatus")(function* (settings: {
  enabled: boolean;
  apiBaseUrl: string;
  customModels: ReadonlyArray<string>;
  authToken: string | null;
}): Effect.fn.Return<ServerProvider> {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(BUILT_IN_MODELS, PROVIDER, settings.customModels);
  const entitlementProbe =
    settings.apiBaseUrl && hasHostedShioriAuthToken(settings.authToken)
      ? yield* fetchShioriCodeEntitlements({
          apiBaseUrl: settings.apiBaseUrl,
          authToken: settings.authToken,
        })
      : { entitlements: null, message: null };
  const auth = buildShioriAuth({
    ...settings,
    entitlementPlan: entitlementProbe.entitlements?.plan ?? null,
  });
  const accessRequiresPaidPlan = entitlementProbe.entitlements?.allowed === false;
  const probe = {
    installed: true,
    version: null,
    status: (settings.apiBaseUrl
      ? accessRequiresPaidPlan || entitlementProbe.message
        ? "warning"
        : "ready"
      : "warning") as Exclude<ServerProviderState, "disabled">,
    auth,
    ...(settings.apiBaseUrl
      ? accessRequiresPaidPlan
        ? {
            message: "ShioriCode requires an active paid Shiori subscription for hosted access.",
          }
        : entitlementProbe.message
          ? { message: entitlementProbe.message }
          : {}
      : {
          message: "Configure settings.providers.shiori.apiBaseUrl to enable Shiori API requests.",
        }),
  };

  return buildServerProvider({
    provider: PROVIDER,
    enabled: settings.enabled,
    checkedAt,
    models,
    probe,
  });
});

function buildPendingShioriProviderStatus(settings: {
  enabled: boolean;
  apiBaseUrl: string;
  customModels: ReadonlyArray<string>;
  authToken: string | null;
}): ServerProvider {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(BUILT_IN_MODELS, PROVIDER, settings.customModels);

  if (!settings.enabled) {
    return buildPendingServerProvider({
      provider: PROVIDER,
      enabled: false,
      installed: false,
      checkedAt,
      models,
      auth: buildShioriAuth(settings),
      message: "Shiori is disabled in ShioriCode settings.",
    });
  }

  if (!settings.apiBaseUrl) {
    return buildPendingServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models,
      auth: buildShioriAuth(settings),
      message: "Configure settings.providers.shiori.apiBaseUrl to enable Shiori API requests.",
    });
  }

  return buildPendingServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    auth: buildShioriAuth(settings),
    message: "Checking Shiori account access...",
  });
}

export const ShioriProviderLive = Layer.effect(
  ShioriProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const authTokenStore = yield* HostedShioriAuthTokenStore;

    return yield* makeManagedServerProvider({
      getSettings: Effect.all({
        settings: serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.providers.shiori),
        ),
        authToken: authTokenStore.getToken,
      }).pipe(
        Effect.map(({ settings, authToken }) => ({
          ...settings,
          authToken,
        })),
        Effect.orDie,
      ),
      streamSettings: Stream.merge(
        serverSettings.streamChanges.pipe(Stream.map(() => undefined)),
        authTokenStore.streamChanges.pipe(Stream.map(() => undefined)),
      ).pipe(
        Stream.mapEffect(() =>
          Effect.all({
            settings: serverSettings.getSettings.pipe(
              Effect.map((settings) => settings.providers.shiori),
            ),
            authToken: authTokenStore.getToken,
          }).pipe(
            Effect.map(({ settings, authToken }) => ({
              ...settings,
              authToken,
            })),
            Effect.orDie,
          ),
        ),
        Stream.orDie,
      ),
      haveSettingsChanged: (previous, next) =>
        previous.enabled !== next.enabled ||
        previous.apiBaseUrl !== next.apiBaseUrl ||
        JSON.stringify(previous.customModels) !== JSON.stringify(next.customModels) ||
        previous.authToken !== next.authToken,
      checkProvider: Effect.all({
        settings: serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.providers.shiori),
        ),
        authToken: authTokenStore.getToken,
      }).pipe(
        Effect.map(({ settings, authToken }) =>
          buildShioriProviderStatus({
            ...settings,
            authToken,
          }),
        ),
        Effect.flatten,
        Effect.orDie,
      ),
      buildInitialSnapshot: buildPendingShioriProviderStatus,
      refreshInterval: "60 seconds",
    });
  }),
);
