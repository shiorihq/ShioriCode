import { useEffect } from "react";
import { readHostedShioriFeatureFlagOverride } from "shared/hostedShioriFeatureFlags";

import { readNativeApi } from "./nativeApi";

/**
 * ShioriCode feature flags are resolved entirely from build-time/runtime env vars
 * (`import.meta.env`). There is no hosted account or remote dependency: each flag
 * has a local production default that can be overridden with its `VITE_*` env var.
 */
export type ShioriFeatureFlagKey =
  | "shioricode_mobile_enabled"
  | "shioricode_browser_use_enabled"
  | "shioricode_computer_use_enabled";

export const DEFAULT_FEATURE_FLAGS = {
  shioricode_mobile_enabled: true,
  shioricode_browser_use_enabled: false,
  shioricode_computer_use_enabled: false,
} satisfies Record<ShioriFeatureFlagKey, boolean>;

const featureFlagEnv = import.meta.env as Record<string, unknown>;

export function resolveFeatureFlagFromEnv(
  key: ShioriFeatureFlagKey,
  env: Record<string, unknown>,
): boolean {
  return readHostedShioriFeatureFlagOverride(key, env) ?? DEFAULT_FEATURE_FLAGS[key];
}

export function resolveFeatureFlag(key: ShioriFeatureFlagKey): boolean {
  return resolveFeatureFlagFromEnv(key, featureFlagEnv);
}

export function useMobileAppFeatureEnabled(): boolean {
  return resolveFeatureFlag("shioricode_mobile_enabled");
}

export function useBrowserUseFeatureEnabled(): boolean {
  return resolveFeatureFlag("shioricode_browser_use_enabled");
}

export function useComputerUseFeatureEnabled(): boolean {
  return resolveFeatureFlag("shioricode_computer_use_enabled");
}

/**
 * Pushes the env-resolved feature flags down to the server so runtime gating
 * (browser-use, mobile pairing, computer-use) stays consistent with the
 * client. Previously handled by the hosted account provider.
 */
export function FeatureFlagSettingsSync() {
  const mobileAppEnabled = useMobileAppFeatureEnabled();
  const browserUseEnabled = useBrowserUseFeatureEnabled();
  const computerUseEnabled = useComputerUseFeatureEnabled();

  useEffect(() => {
    const api = readNativeApi();
    if (!api) {
      return;
    }

    void api.server.updateSettings({
      browserUse: { enabled: browserUseEnabled },
      mobileApp: { enabled: mobileAppEnabled },
      ...(computerUseEnabled ? {} : { computerUse: { enabled: false } }),
    });
  }, [browserUseEnabled, computerUseEnabled, mobileAppEnabled]);

  return null;
}
