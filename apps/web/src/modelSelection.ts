import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProvider,
} from "contracts";
import { normalizeModelSlug, resolveSelectableModel } from "shared/model";
import { getComposerProviderState } from "./components/chat/composerProviderRegistry";
import { UnifiedSettings } from "contracts/settings";
import {
  getDefaultServerModel,
  getProviderModels,
  resolveSelectableProvider,
} from "./providerModels";

const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;

export type ProviderCustomModelConfig = {
  provider: ProviderKind;
  title: string;
  description: string;
  placeholder: string;
  example: string;
  supportsCustomModels?: boolean;
};

export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
}

const PROVIDER_CUSTOM_MODEL_CONFIG: Record<ProviderKind, ProviderCustomModelConfig> = {
  shiori: {
    provider: "shiori",
    title: "Shiori",
    description: "Save additional Shiori model slugs for the picker and `/model` command.",
    placeholder: "your-shiori-model-slug",
    example: "anthropic/claude-sonnet-4-5",
  },
  kimiCode: {
    provider: "kimiCode",
    title: "Kimi Code",
    description: "Kimi Code is currently pinned to a single built-in model.",
    placeholder: "kimi-code/kimi-for-coding",
    example: "kimi-code/kimi-for-coding",
    supportsCustomModels: false,
  },
  codex: {
    provider: "codex",
    title: "Codex",
    description: "Save additional Codex model slugs for the picker and `/model` command.",
    placeholder: "your-codex-model-slug",
    example: "gpt-6.7-codex-ultra-preview",
  },
  claudeAgent: {
    provider: "claudeAgent",
    title: "Claude",
    description: "Save additional Claude model slugs for the picker and `/model` command.",
    placeholder: "your-claude-model-slug",
    example: "claude-sonnet-5-0",
  },
};

export const MODEL_PROVIDER_SETTINGS = Object.values(PROVIDER_CUSTOM_MODEL_CONFIG).filter(
  (providerConfig) => providerConfig.supportsCustomModels !== false,
);

export function normalizeCustomModelSlugs(
  models: Iterable<string | null | undefined>,
  builtInModelSlugs: ReadonlySet<string>,
  provider: ProviderKind = "codex",
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();

  for (const candidate of models) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (
      !normalized ||
      normalized.length > MAX_CUSTOM_MODEL_LENGTH ||
      builtInModelSlugs.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    normalizedModels.push(normalized);
    if (normalizedModels.length >= MAX_CUSTOM_MODEL_COUNT) {
      break;
    }
  }

  return normalizedModels;
}

export function getAppModelOptions(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = getProviderModels(providers, provider).map(
    ({ slug, name, isCustom }) => ({
      slug,
      name,
      isCustom,
    }),
  );
  const seen = new Set(options.map((option) => option.slug));
  const trimmedSelectedModel = selectedModel?.trim().toLowerCase();
  const builtInModelSlugs = new Set(
    getProviderModels(providers, provider)
      .filter((model) => !model.isCustom)
      .map((model) => model.slug),
  );

  if (provider !== "kimiCode") {
    const customModels = settings.providers[provider].customModels;
    for (const slug of normalizeCustomModelSlugs(customModels, builtInModelSlugs, provider)) {
      if (seen.has(slug)) {
        continue;
      }

      seen.add(slug);
      options.push({
        slug,
        name: slug,
        isCustom: true,
      });
    }

    const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
    const selectedModelMatchesExistingName =
      typeof trimmedSelectedModel === "string" &&
      options.some((option) => option.name.toLowerCase() === trimmedSelectedModel);
    if (
      normalizedSelectedModel &&
      !seen.has(normalizedSelectedModel) &&
      !selectedModelMatchesExistingName
    ) {
      options.push({
        slug: normalizedSelectedModel,
        name: normalizedSelectedModel,
        isCustom: true,
      });
    }
  }

  return options;
}

export function resolveAppModelSelection(
  provider: ProviderKind,
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedModel: string | null | undefined,
): string {
  const resolvedProvider = resolveSelectableProvider(providers, provider);
  const options = getAppModelOptions(settings, providers, resolvedProvider, selectedModel);
  return (
    resolveSelectableModel(resolvedProvider, selectedModel, options) ??
    getDefaultServerModel(providers, resolvedProvider)
  );
}

export function buildProviderModelSelection(
  provider: ProviderKind,
  model: string,
  options?: ProviderModelOptions[ProviderKind] | ProviderModelOptions[keyof ProviderModelOptions],
): ModelSelection {
  switch (provider) {
    case "shiori":
      return options !== undefined
        ? { provider, model, options: options as NonNullable<ProviderModelOptions["shiori"]> }
        : { provider, model };
    case "kimiCode":
      return options !== undefined
        ? { provider, model, options: options as NonNullable<ProviderModelOptions["kimiCode"]> }
        : { provider, model };
    case "codex":
      return options !== undefined
        ? { provider, model, options: options as NonNullable<ProviderModelOptions["codex"]> }
        : { provider, model };
    case "claudeAgent":
      return options !== undefined
        ? {
            provider,
            model,
            options: options as NonNullable<ProviderModelOptions["claudeAgent"]>,
          }
        : { provider, model };
  }
}

export function getCustomModelOptionsByProvider(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  selectedProvider?: ProviderKind | null,
  selectedModel?: string | null,
): Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>> {
  return {
    shiori: getAppModelOptions(
      settings,
      providers,
      "shiori",
      selectedProvider === "shiori" ? selectedModel : undefined,
    ),
    kimiCode: getAppModelOptions(
      settings,
      providers,
      "kimiCode",
      selectedProvider === "kimiCode" ? selectedModel : undefined,
    ),
    codex: getAppModelOptions(
      settings,
      providers,
      "codex",
      selectedProvider === "codex" ? selectedModel : undefined,
    ),
    claudeAgent: getAppModelOptions(
      settings,
      providers,
      "claudeAgent",
      selectedProvider === "claudeAgent" ? selectedModel : undefined,
    ),
  };
}

export function resolveAppModelSelectionState(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  return resolveConfigurableModelSelectionState(
    settings.textGenerationModelSelection,
    settings,
    providers,
    {
      provider: "codex" as const,
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
    },
  );
}

export function resolveConfigurableModelSelectionState(
  selection: ModelSelection | null | undefined,
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  fallbackSelection: ModelSelection = {
    provider: "codex" as const,
    model: DEFAULT_MODEL_BY_PROVIDER.codex,
  },
): ModelSelection {
  const resolvedSelection = selection ?? fallbackSelection;
  const provider = resolveSelectableProvider(providers, resolvedSelection.provider);

  // When the provider changed due to fallback (e.g. selected provider was disabled),
  // don't carry over the old provider's model — use the fallback provider's default.
  const selectedModel = provider === resolvedSelection.provider ? resolvedSelection.model : null;
  const model = resolveAppModelSelection(provider, settings, providers, selectedModel);
  const { modelOptionsForDispatch } = getComposerProviderState({
    provider,
    model,
    models: getProviderModels(providers, provider),
    prompt: "",
    modelOptions: {
      [provider]: provider === resolvedSelection.provider ? resolvedSelection.options : undefined,
    },
  });

  return buildProviderModelSelection(provider, model, modelOptionsForDispatch);
}
