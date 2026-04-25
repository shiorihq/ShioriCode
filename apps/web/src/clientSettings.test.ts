import { describe, expect, it } from "vitest";

import { DEFAULT_CLIENT_SETTINGS } from "contracts";
import { resolveBlurPersonalDataSetting } from "./clientSettings";

describe("client settings privacy helpers", () => {
  it("prefers the authenticated hosted preferences blur setting", () => {
    expect(
      resolveBlurPersonalDataSetting({
        fallbackValue: false,
        hostedBlurPersonalData: true,
        isAuthenticated: true,
      }),
    ).toBe(true);
  });

  it("masks personal details while authenticated hosted preferences are loading", () => {
    expect(
      resolveBlurPersonalDataSetting({
        fallbackValue: false,
        hostedBlurPersonalData: undefined,
        hostedBlurPersonalDataLoading: true,
        isAuthenticated: true,
      }),
    ).toBe(true);
  });

  it("falls back to the local client setting when hosted blur data is unavailable", () => {
    expect(
      resolveBlurPersonalDataSetting({
        fallbackValue: false,
        hostedBlurPersonalData: undefined,
        isAuthenticated: true,
      }),
    ).toBe(false);

    expect(
      resolveBlurPersonalDataSetting({
        fallbackValue: true,
        hostedBlurPersonalData: false,
        isAuthenticated: false,
      }),
    ).toBe(true);
  });
});

describe("client settings defaults", () => {
  it("keeps thread done sounds opt-in", () => {
    expect(DEFAULT_CLIENT_SETTINGS.threadDoneNotificationSoundEnabled).toBe(false);
    expect(DEFAULT_CLIENT_SETTINGS.threadDoneNotificationSound).toBe("chime");
  });
});
