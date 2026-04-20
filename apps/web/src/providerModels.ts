import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelCapabilities,
  type ProviderKind,
  PROVIDER_DISPLAY_NAMES,
  type ServerProvider,
  type ServerProviderModel,
} from "contracts";
import { normalizeModelSlug } from "shared/model";

const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

function findProviderModel(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderKind,
): ServerProviderModel | undefined {
  const slug = normalizeModelSlug(model, provider);
  return models.find((candidate) => candidate.slug === slug);
}

export function getProviderModels(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): ReadonlyArray<ServerProviderModel> {
  return providers.find((candidate) => candidate.provider === provider)?.models ?? [];
}

export function getProviderSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): ServerProvider | undefined {
  return providers.find((candidate) => candidate.provider === provider);
}

export function isProviderEnabled(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): boolean {
  return getProviderSnapshot(providers, provider)?.enabled ?? true;
}

export function resolveSelectableProvider(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind | null | undefined,
): ProviderKind {
  const requested = provider ?? "codex";
  if (isProviderEnabled(providers, requested)) {
    return requested;
  }
  return providers.find((candidate) => candidate.enabled)?.provider ?? requested;
}

export function isPendingProviderCheckStatus(snapshot: ServerProvider | null | undefined): boolean {
  return (
    snapshot?.status === "warning" &&
    typeof snapshot.message === "string" &&
    /^Checking\b/i.test(snapshot.message.trim())
  );
}

export function getProviderPickerState(snapshot: ServerProvider | null | undefined): {
  selectable: boolean;
  badgeLabel: string | null;
} {
  if (!snapshot) {
    return {
      selectable: true,
      badgeLabel: null,
    };
  }

  if (!snapshot.enabled || snapshot.status === "disabled") {
    return {
      selectable: false,
      badgeLabel: "Disabled",
    };
  }

  if (!snapshot.installed) {
    return {
      selectable: false,
      badgeLabel: "Not installed",
    };
  }

  if (snapshot.status === "warning") {
    return isPendingProviderCheckStatus(snapshot)
      ? {
          selectable: true,
          badgeLabel: "Checking",
        }
      : {
          selectable: false,
          badgeLabel: "Unavailable",
        };
  }

  if (snapshot.status === "error") {
    return {
      selectable: false,
      badgeLabel: "Unavailable",
    };
  }

  return {
    selectable: true,
    badgeLabel: null,
  };
}

export function getProviderUnavailableReason(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): string | null {
  const snapshot = getProviderSnapshot(providers, provider);
  if (!snapshot || snapshot.status === "ready" || isPendingProviderCheckStatus(snapshot)) {
    return null;
  }

  const providerLabel = PROVIDER_DISPLAY_NAMES[provider] ?? provider;
  if (!snapshot.enabled || snapshot.status === "disabled") {
    return `${providerLabel} is disabled in settings.`;
  }
  if (snapshot.message && snapshot.message.trim().length > 0) {
    return snapshot.message;
  }
  return snapshot.status === "error"
    ? `${providerLabel} provider is unavailable.`
    : `${providerLabel} provider is not ready yet. Resolve the provider warning before starting a turn.`;
}

export function getProviderModelCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderKind,
): ModelCapabilities {
  return findProviderModel(models, model, provider)?.capabilities ?? EMPTY_CAPABILITIES;
}

export function getProviderModelDisplayName(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderKind,
): string {
  return (
    findProviderModel(models, model, provider)?.name ??
    normalizeModelSlug(model, provider) ??
    model ??
    DEFAULT_MODEL_BY_PROVIDER[provider]
  );
}

export function providerModelSupportsImageAttachments(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderKind,
): boolean {
  return findProviderModel(models, model, provider)?.multiModal ?? true;
}

export function getDefaultServerModel(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): string {
  const models = getProviderModels(providers, provider);
  return (
    models.find((model) => !model.isCustom)?.slug ??
    models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[provider]
  );
}
