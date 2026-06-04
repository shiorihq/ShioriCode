import { useGoalsFeatureFlagEnabled } from "../featureFlags";
import { useSettings } from "./useSettings";

export function useGoalsFeatureEnabled(): boolean {
  const goalsEnabled = useGoalsFeatureFlagEnabled();
  const localGoalsEnabled = useSettings().goals.enabled;

  return goalsEnabled && localGoalsEnabled;
}
