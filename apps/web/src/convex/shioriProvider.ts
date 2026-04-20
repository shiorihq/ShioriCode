import type { ModelCapabilities, ServerProvider, ServerProviderModel } from "contracts";
import { useMemo } from "react";

import { type HostedCatalogProvider, type HostedViewer } from "./api";
import { useHostedShioriState } from "./HostedShioriProvider";

const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

function buildHostedReasoningEffortLevels(
  supportsReasoningEffort: boolean | undefined,
): ModelCapabilities["reasoningEffortLevels"] {
  if (!supportsReasoningEffort) {
    return [];
  }

  return [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium", isDefault: true },
    { value: "high", label: "High" },
  ];
}

function buildHostedModelCapabilities(input: {
  reasoning: boolean;
  supportsReasoningEffort?: boolean;
  mandatoryReasoning?: boolean;
  reasoningId?: string;
}): ModelCapabilities {
  const supportsThinkingToggle =
    input.mandatoryReasoning !== true &&
    (input.supportsReasoningEffort === true ||
      (typeof input.reasoningId === "string" && input.reasoningId.trim().length > 0));

  return {
    ...EMPTY_CAPABILITIES,
    reasoningEffortLevels: buildHostedReasoningEffortLevels(input.supportsReasoningEffort),
    supportsThinkingToggle,
  };
}

function isCodingCapableModel(model: HostedCatalogProvider["models"][number]): boolean {
  return model.coding === true || (model.coding === undefined && model.toolCalling);
}

function hasExplicitCodingFlag(model: HostedCatalogProvider["models"][number]): boolean {
  return model.coding === true;
}

function resolveHostedModelSlug(providerId: string, modelId: string): string {
  return modelId.includes("/") ? modelId : `${providerId}/${modelId}`;
}

function flattenHostedShioriModelsByPredicate(
  providers: ReadonlyArray<HostedCatalogProvider>,
  shouldIncludeModel: (model: HostedCatalogProvider["models"][number]) => boolean,
): ServerProviderModel[] {
  return providers.flatMap((provider) =>
    provider.models
      .filter((model) => model.isEnabled && shouldIncludeModel(model))
      .map<ServerProviderModel>((model) => ({
        slug: resolveHostedModelSlug(provider.id, model.id),
        name: model.name,
        isCustom: false,
        multiModal: model.multiModal,
        capabilities: buildHostedModelCapabilities({
          reasoning: model.reasoning,
          ...(model.supportsReasoningEffort !== undefined
            ? { supportsReasoningEffort: model.supportsReasoningEffort }
            : {}),
          ...(model.mandatoryReasoning !== undefined
            ? { mandatoryReasoning: model.mandatoryReasoning }
            : {}),
          ...(model.reasoningId !== undefined ? { reasoningId: model.reasoningId } : {}),
        }),
      })),
  );
}

export function flattenHostedShioriModels(
  providers: ReadonlyArray<HostedCatalogProvider>,
): ServerProviderModel[] {
  return flattenHostedShioriModelsByPredicate(providers, isCodingCapableModel);
}

export function flattenHostedShioriSettingsModels(
  providers: ReadonlyArray<HostedCatalogProvider>,
): ServerProviderModel[] {
  return flattenHostedShioriModelsByPredicate(providers, hasExplicitCodingFlag);
}

function resolveHostedAuthLabel(viewer: HostedViewer | null | undefined): string | undefined {
  if (!viewer) {
    return "Shiori";
  }
  return viewer.email ?? viewer.name ?? "Shiori";
}

function hasHostedPaidPlan(isPaidSubscriber: boolean): boolean {
  return isPaidSubscriber;
}

export function mergeHostedShioriProvider(
  baseProvider: ServerProvider | undefined,
  input: {
    isAuthLoading: boolean;
    isAuthenticated: boolean;
    isSubscriptionLoading: boolean;
    isPaidSubscriber: boolean;
    viewer: HostedViewer | null | undefined;
    catalogProviders: ReadonlyArray<HostedCatalogProvider> | undefined;
  },
): ServerProvider | undefined {
  if (!baseProvider) {
    return baseProvider;
  }

  const dynamicModels =
    input.catalogProviders && input.catalogProviders.length > 0
      ? flattenHostedShioriModels(input.catalogProviders)
      : baseProvider.models;
  const disabledStatus = !baseProvider.enabled ? "disabled" : undefined;

  if (disabledStatus) {
    return {
      ...baseProvider,
      auth: {
        status: input.isAuthenticated ? "authenticated" : "unknown",
        ...(resolveHostedAuthLabel(input.viewer)
          ? { label: resolveHostedAuthLabel(input.viewer) }
          : {}),
      },
      models: dynamicModels,
      status: disabledStatus,
    };
  }

  if (input.isAuthLoading) {
    return {
      ...baseProvider,
      auth: {
        status: "unknown",
        label: "Checking session",
      },
      status: "warning",
      message: "Checking your Shiori account…",
      models: baseProvider.models,
    };
  }

  if (!input.isAuthenticated) {
    return {
      ...baseProvider,
      auth: {
        status: "unauthenticated",
        label: "Sign in required",
      },
      status: "warning",
      message: "Sign in to Shiori to load models and enable the provider.",
      models: baseProvider.models,
    };
  }

  if (input.isSubscriptionLoading) {
    return {
      ...baseProvider,
      auth: {
        status: "authenticated",
        label: resolveHostedAuthLabel(input.viewer),
      },
      status: "warning",
      message: "Checking your Shiori subscription…",
      models: baseProvider.models,
    };
  }

  if (!hasHostedPaidPlan(input.isPaidSubscriber)) {
    return {
      ...baseProvider,
      auth: {
        status: "authenticated",
        label: resolveHostedAuthLabel(input.viewer),
        type: "convex",
      },
      status: "warning",
      message: "ShioriCode requires an active paid Shiori subscription.",
      models: baseProvider.models,
    };
  }

  if (input.viewer === undefined || input.catalogProviders === undefined) {
    return {
      ...baseProvider,
      auth: {
        status: "authenticated",
        label: resolveHostedAuthLabel(input.viewer),
      },
      status: "warning",
      message: "Loading Shiori models…",
      models: baseProvider.models,
    };
  }

  return {
    ...baseProvider,
    auth: {
      status: "authenticated",
      label: resolveHostedAuthLabel(input.viewer),
      type: "convex",
    },
    status: dynamicModels.length > 0 ? "ready" : "warning",
    message:
      dynamicModels.length > 0
        ? undefined
        : "No Shiori models are currently available for this deployment.",
    models: dynamicModels,
  };
}

export function useMergedServerProviders(
  serverProviders: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  const {
    isAuthenticated,
    isAuthLoading,
    isSubscriptionLoading,
    isPaidSubscriber,
    viewer,
    catalogProviders,
  } = useHostedShioriState();

  return useMemo(() => {
    const shioriProvider = mergeHostedShioriProvider(
      serverProviders.find((provider) => provider.provider === "shiori"),
      {
        isAuthLoading,
        isAuthenticated,
        isSubscriptionLoading,
        isPaidSubscriber,
        viewer,
        catalogProviders,
      },
    );

    if (!shioriProvider) {
      return serverProviders;
    }

    return serverProviders.map((provider) =>
      provider.provider === "shiori" ? shioriProvider : provider,
    );
  }, [
    catalogProviders,
    isAuthLoading,
    isAuthenticated,
    isPaidSubscriber,
    isSubscriptionLoading,
    serverProviders,
    viewer,
  ]);
}
