import { useHostedShioriState } from "~/convex/HostedShioriProvider";
import { useSettings } from "./useSettings";

export function useGoalsFeatureEnabled(): boolean {
  const goalsEnabled = useHostedShioriState().goalsEnabled;
  const localGoalsEnabled = useSettings().goals.enabled;

  return goalsEnabled && localGoalsEnabled;
}
