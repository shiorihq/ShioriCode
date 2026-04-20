import { describe, expect, it } from "vitest";
import {
  clearStoredClientSettings,
  readStoredClientSettings,
  writeLegacyThemeMode,
} from "../clientSettings";
import {
  buildLegacyClientSettingsMigrationPatch,
  migrateLegacyThemePreference,
} from "./useSettings";

describe("buildLegacyClientSettingsMigrationPatch", () => {
  it("migrates supported legacy client settings", () => {
    expect(
      buildLegacyClientSettingsMigrationPatch({
        confirmThreadDelete: false,
        blurPersonalData: true,
      }),
    ).toEqual({
      confirmThreadDelete: false,
      blurPersonalData: true,
    });
  });

  it("migrates the legacy standalone theme preference into client settings", () => {
    clearStoredClientSettings();
    writeLegacyThemeMode("dark");

    migrateLegacyThemePreference();

    expect(readStoredClientSettings().themeMode).toBe("dark");
  });
});
