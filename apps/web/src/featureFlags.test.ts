import { describe, expect, it } from "vitest";

import { resolveFeatureFlagFromEnv } from "./featureFlags";

describe("resolveFeatureFlagFromEnv", () => {
  it("enables goals by default in production builds", () => {
    expect(resolveFeatureFlagFromEnv("shioricode_goals_enabled", {})).toBe(true);
  });

  it("keeps gated integrations disabled by default", () => {
    expect(resolveFeatureFlagFromEnv("shioricode_browser_use_enabled", {})).toBe(false);
    expect(resolveFeatureFlagFromEnv("shioricode_computer_use_enabled", {})).toBe(false);
    expect(resolveFeatureFlagFromEnv("shioricode_mobile_enabled", {})).toBe(false);
  });

  it("lets env overrides disable goals", () => {
    expect(
      resolveFeatureFlagFromEnv("shioricode_goals_enabled", {
        VITE_SHIORICODE_FEATURE_FLAG_SHIORICODE_GOALS_ENABLED: "false",
      }),
    ).toBe(false);
  });
});
