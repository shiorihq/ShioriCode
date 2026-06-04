import { useEffect } from "react";
import { readHostedShioriFeatureFlagOverride } from "shared/hostedShioriFeatureFlags";

import { readNativeApi } from "./nativeApi";

/**
 * ShioriCode feature flags are resolved entirely from build-time/runtime env vars
 * (`import.meta.env`). There is no hosted account or remote dependency: each flag
 * defaults to `false` and is only enabled when its `VITE_*` override is set.
 */
export type ShioriFeatureFlagKey =
  | "shioricode_mobile_enabled"
  | "shioricode_browser_use_enabled"
  | "shioricode_computer_use_enabled"
  | "shioricode_goals_enabled";

const featureFlagEnv = import.meta.env as Record<string, unknown>;

export function resolveFeatureFlag(key: ShioriFeatureFlagKey): boolean {
  return readHostedShioriFeatureFlagOverride(key, featureFlagEnv) ?? false;
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

export function useGoalsFeatureFlagEnabled(): boolean {
  return resolveFeatureFlag("shioricode_goals_enabled");
}

/**
 * Pushes the env-resolved feature flags down to the server so runtime gating
 * (browser-use, mobile pairing, goals, computer-use) stays consistent with the
 * client. Previously handled by the hosted account provider.
 */
export function FeatureFlagSettingsSync() {
  const mobileAppEnabled = useMobileAppFeatureEnabled();
  const browserUseEnabled = useBrowserUseFeatureEnabled();
  const computerUseEnabled = useComputerUseFeatureEnabled();
  const goalsEnabled = useGoalsFeatureFlagEnabled();

  useEffect(() => {
    const api = readNativeApi();
    if (!api) {
      return;
    }

    void api.server.updateSettings({
      browserUse: { enabled: browserUseEnabled },
      mobileApp: { enabled: mobileAppEnabled },
      goals: { enabled: goalsEnabled },
      ...(computerUseEnabled ? {} : { computerUse: { enabled: false } }),
    });
  }, [browserUseEnabled, computerUseEnabled, goalsEnabled, mobileAppEnabled]);

  return null;
}
