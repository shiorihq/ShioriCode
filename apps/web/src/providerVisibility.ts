import { DEFAULT_PROVIDER_KIND, type ProviderKind, type ServerProvider } from "contracts";

import { type ProviderPickerKind, PROVIDER_OPTIONS } from "./session-logic";
import { isProviderEnabled, resolveSelectableProvider } from "./providerModels";

type AvailableProviderOption = {
  value: ProviderPickerKind;
  label: string;
  available: true;
};

function isAvailableProviderOption(
  option: (typeof PROVIDER_OPTIONS)[number],
): option is AvailableProviderOption {
  return option.available;
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);
export const AVAILABLE_PROVIDER_KINDS = AVAILABLE_PROVIDER_OPTIONS.map(
  (option) => option.value,
) as readonly ProviderKind[];

export function normalizeHiddenProviders(
  hiddenProviders: readonly ProviderKind[] | null | undefined,
): ProviderKind[] {
  const availableProviders = new Set<ProviderKind>(AVAILABLE_PROVIDER_KINDS);
  const seen = new Set<ProviderKind>();
  const normalized: ProviderKind[] = [];

  for (const provider of hiddenProviders ?? []) {
    if (!availableProviders.has(provider) || seen.has(provider)) {
      continue;
    }
    seen.add(provider);
    normalized.push(provider);
  }

  return normalized;
}

export function isProviderVisible(
  provider: ProviderKind,
  hiddenProviders: readonly ProviderKind[] | null | undefined,
): boolean {
  return !normalizeHiddenProviders(hiddenProviders).includes(provider);
}

export function setProviderVisibility(
  hiddenProviders: readonly ProviderKind[] | null | undefined,
  provider: ProviderKind,
  visible: boolean,
): ProviderKind[] {
  const hiddenSet = new Set(normalizeHiddenProviders(hiddenProviders));
  if (visible) {
    hiddenSet.delete(provider);
  } else {
    hiddenSet.add(provider);
  }
  return AVAILABLE_PROVIDER_KINDS.filter((candidate) => hiddenSet.has(candidate));
}

export function getVisibleProviderKinds(
  hiddenProviders: readonly ProviderKind[] | null | undefined,
): readonly ProviderKind[] {
  const hiddenSet = new Set(normalizeHiddenProviders(hiddenProviders));
  const visibleProviders = AVAILABLE_PROVIDER_KINDS.filter((provider) => !hiddenSet.has(provider));
  return visibleProviders.length > 0 ? visibleProviders : AVAILABLE_PROVIDER_KINDS;
}

export function getVisibleProviderOptions(
  hiddenProviders: readonly ProviderKind[] | null | undefined,
): typeof AVAILABLE_PROVIDER_OPTIONS {
  const visibleProviderSet = new Set(getVisibleProviderKinds(hiddenProviders));
  return AVAILABLE_PROVIDER_OPTIONS.filter((option) => visibleProviderSet.has(option.value));
}

export function resolveVisibleSelectableProvider(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind | null | undefined,
  hiddenProviders: readonly ProviderKind[] | null | undefined,
): ProviderKind {
  const requested = provider ?? DEFAULT_PROVIDER_KIND;
  const visibleProviders = getVisibleProviderKinds(hiddenProviders);
  const providerStatusesLoaded = providers.length > 0;
  const providerCanBeSelected = (candidate: ProviderKind) =>
    (!providerStatusesLoaded ||
      providers.some((providerStatus) => providerStatus.provider === candidate)) &&
    isProviderEnabled(providers, candidate);

  if (visibleProviders.includes(requested) && providerCanBeSelected(requested)) {
    return requested;
  }

  const fallback = visibleProviders.find((candidate) => providerCanBeSelected(candidate));
  return fallback ?? resolveSelectableProvider(providers, requested);
}
