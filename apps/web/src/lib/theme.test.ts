import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODE_FONT_FAMILY,
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_THEME_MODE,
  DEFAULT_UI_FONT_FAMILY,
  type ClientSettings,
} from "contracts/settings";
import {
  getThemeOptions,
  parseImportedThemeJson,
  removeImportedThemeFromSettings,
  upsertImportedTheme,
} from "./theme";

function makeSettings(overrides: Partial<ClientSettings> = {}): ClientSettings {
  return {
    confirmThreadDelete: true,
    diffWordWrap: false,
    newThreadIcon: "navigation",
    sidebarProjectSortOrder: "updated_at",
    sidebarThreadSortOrder: "updated_at",
    sidebarTranslucent: true,
    timestampFormat: "locale",
    themeMode: DEFAULT_THEME_MODE,
    lightThemeId: DEFAULT_LIGHT_THEME_ID,
    darkThemeId: DEFAULT_DARK_THEME_ID,
    uiFontFamily: DEFAULT_UI_FONT_FAMILY,
    codeFontFamily: DEFAULT_CODE_FONT_FAMILY,
    importedThemes: [],
    ...overrides,
  };
}

describe("theme helpers", () => {
  it("parses explicit theme ids from import JSON", () => {
    const importedTheme = parseImportedThemeJson(
      JSON.stringify({
        id: "midnight-lattice",
        name: "Midnight Lattice",
        appearance: "dark",
        tokens: {
          background: "#000000",
          foreground: "#ffffff",
          card: "#050505",
          cardForeground: "#ffffff",
          popover: "#050505",
          popoverForeground: "#ffffff",
          primary: "#8ab4ff",
          primaryForeground: "#08111f",
          secondary: "#101010",
          secondaryForeground: "#ffffff",
          muted: "#0b0b0b",
          mutedForeground: "#cccccc",
          accent: "#101010",
          accentForeground: "#ffffff",
          destructive: "#ff5a67",
          destructiveForeground: "#ffffff",
          border: "#1f1f1f",
          input: "#161616",
          ring: "#8ab4ff",
          info: "#60a5fa",
          infoForeground: "#dbeafe",
          success: "#34d399",
          successForeground: "#d1fae5",
          warning: "#fbbf24",
          warningForeground: "#fef3c7",
        },
      }),
      [],
    );

    expect(importedTheme.id).toBe("midnight-lattice");
    expect(importedTheme.appearance).toBe("dark");
  });

  it("adds built-in themes ahead of imported options", () => {
    const importedTheme = parseImportedThemeJson(
      JSON.stringify({
        id: "dawn",
        name: "Dawn",
        appearance: "light",
        tokens: {
          background: "#ffffff",
          foreground: "#111111",
          card: "#ffffff",
          cardForeground: "#111111",
          popover: "#ffffff",
          popoverForeground: "#111111",
          primary: "#2563eb",
          primaryForeground: "#ffffff",
          secondary: "#f3f4f6",
          secondaryForeground: "#111111",
          muted: "#f3f4f6",
          mutedForeground: "#4b5563",
          accent: "#eff6ff",
          accentForeground: "#111111",
          destructive: "#dc2626",
          destructiveForeground: "#ffffff",
          border: "#e5e7eb",
          input: "#d1d5db",
          ring: "#2563eb",
          info: "#2563eb",
          infoForeground: "#dbeafe",
          success: "#059669",
          successForeground: "#d1fae5",
          warning: "#d97706",
          warningForeground: "#fef3c7",
        },
      }),
      [],
    );

    const options = getThemeOptions(makeSettings({ importedThemes: [importedTheme] }), "light");

    expect(options[0]?.id).toBe(DEFAULT_LIGHT_THEME_ID);
    expect(options.some((option) => option.id === "builtin:catppuccin-latte")).toBe(true);
    expect(options.some((option) => option.id === "builtin:tokyo-night-day")).toBe(true);
    expect(options.at(-1)?.id).toBe("dawn");
  });

  it("includes bundled dark Catppuccin and Tokyo Night options", () => {
    const options = getThemeOptions(makeSettings(), "dark");

    expect(options.map((option) => option.id)).toContain("builtin:catppuccin-mocha");
    expect(options.map((option) => option.id)).toContain("builtin:tokyo-night");
  });

  it("falls back to built-in themes when an imported theme is removed", () => {
    const importedTheme = parseImportedThemeJson(
      JSON.stringify({
        id: "midnight-lattice",
        name: "Midnight Lattice",
        appearance: "dark",
        tokens: {
          background: "#000000",
          foreground: "#ffffff",
          card: "#050505",
          cardForeground: "#ffffff",
          popover: "#050505",
          popoverForeground: "#ffffff",
          primary: "#8ab4ff",
          primaryForeground: "#08111f",
          secondary: "#101010",
          secondaryForeground: "#ffffff",
          muted: "#0b0b0b",
          mutedForeground: "#cccccc",
          accent: "#101010",
          accentForeground: "#ffffff",
          destructive: "#ff5a67",
          destructiveForeground: "#ffffff",
          border: "#1f1f1f",
          input: "#161616",
          ring: "#8ab4ff",
          info: "#60a5fa",
          infoForeground: "#dbeafe",
          success: "#34d399",
          successForeground: "#d1fae5",
          warning: "#fbbf24",
          warningForeground: "#fef3c7",
        },
      }),
      [],
    );
    const nextSettings = removeImportedThemeFromSettings(
      makeSettings({
        darkThemeId: importedTheme.id,
        importedThemes: [importedTheme],
      }),
      importedTheme.id,
    );

    expect(nextSettings.darkThemeId).toBe(DEFAULT_DARK_THEME_ID);
    expect(nextSettings.importedThemes).toEqual([]);
  });

  it("replaces imported themes with matching ids", () => {
    const first = parseImportedThemeJson(
      JSON.stringify({
        id: "dawn",
        name: "Dawn",
        appearance: "light",
        tokens: {
          background: "#ffffff",
          foreground: "#111111",
          card: "#ffffff",
          cardForeground: "#111111",
          popover: "#ffffff",
          popoverForeground: "#111111",
          primary: "#2563eb",
          primaryForeground: "#ffffff",
          secondary: "#f3f4f6",
          secondaryForeground: "#111111",
          muted: "#f3f4f6",
          mutedForeground: "#4b5563",
          accent: "#eff6ff",
          accentForeground: "#111111",
          destructive: "#dc2626",
          destructiveForeground: "#ffffff",
          border: "#e5e7eb",
          input: "#d1d5db",
          ring: "#2563eb",
          info: "#2563eb",
          infoForeground: "#dbeafe",
          success: "#059669",
          successForeground: "#d1fae5",
          warning: "#d97706",
          warningForeground: "#fef3c7",
        },
      }),
      [],
    );
    const second = {
      ...first,
      name: "Dawn v2",
    };

    expect(upsertImportedTheme([first], second)).toEqual([second]);
  });
});
