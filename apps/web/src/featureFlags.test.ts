import { describe, expect, it } from "vitest";

import { resolveFeatureFlagFromEnv } from "./featureFlags";

describe("resolveFeatureFlagFromEnv", () => {
  it("enables mobile pairing by default while keeping heavier integrations gated", () => {
    expect(resolveFeatureFlagFromEnv("shioricode_browser_use_enabled", {})).toBe(false);
    expect(resolveFeatureFlagFromEnv("shioricode_mobile_enabled", {})).toBe(true);
  });
});
