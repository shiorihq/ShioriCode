import { describe, expect, it } from "vitest";

import {
  hostedShioriFeatureFlagEnvNames,
  parseHostedShioriFeatureFlagOverride,
  readHostedShioriFeatureFlagOverride,
} from "./hostedShioriFeatureFlags";

describe("hosted Shiori feature flag env overrides", () => {
  it("maps Convex flag keys to server and Vite env names", () => {
    expect(hostedShioriFeatureFlagEnvNames("shioricode_browser_use_enabled")).toEqual([
      "SHIORICODE_FEATURE_FLAG_SHIORICODE_BROWSER_USE_ENABLED",
      "VITE_SHIORICODE_FEATURE_FLAG_SHIORICODE_BROWSER_USE_ENABLED",
    ]);
  });

  it("parses common boolean env values", () => {
    expect(parseHostedShioriFeatureFlagOverride("true")).toBe(true);
    expect(parseHostedShioriFeatureFlagOverride("1")).toBe(true);
    expect(parseHostedShioriFeatureFlagOverride("off")).toBe(false);
    expect(parseHostedShioriFeatureFlagOverride("0")).toBe(false);
    expect(parseHostedShioriFeatureFlagOverride("later")).toBeUndefined();
  });

  it("prefers the non-Vite override when both are present", () => {
    expect(
      readHostedShioriFeatureFlagOverride("code_enabled", {
        SHIORICODE_FEATURE_FLAG_CODE_ENABLED: "false",
        VITE_SHIORICODE_FEATURE_FLAG_CODE_ENABLED: "true",
      }),
    ).toBe(false);
  });
});
