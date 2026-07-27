import { describe, expect, it } from "vitest";

import {
  customAppearanceBackgroundUrl,
  normalizeAppearanceBackgroundBlur,
  normalizeAppearanceBackgroundOpacity,
  resolveAppearanceBackgroundUrl,
} from "./appearanceBackgrounds";

describe("appearance backgrounds", () => {
  it("resolves bundled presets", () => {
    expect(
      resolveAppearanceBackgroundUrl({
        kind: "preset",
        presetId: "japanese-winter",
        customVersion: "",
        opacity: 100,
        blur: 0,
        mainOpacity: 100,
        mainBlur: 0,
      }),
    ).toBe("/backgrounds/japanese-winter.webp");
  });

  it("resolves versioned host-backed custom images", () => {
    expect(customAppearanceBackgroundUrl("version-1")).toBe("/api/appearance/background/version-1");
  });

  it("does not render a background for the default setting", () => {
    expect(
      resolveAppearanceBackgroundUrl({
        kind: "none",
        customVersion: "",
        opacity: 100,
        blur: 0,
        mainOpacity: 100,
        mainBlur: 0,
      }),
    ).toBeNull();
  });

  it("normalizes background opacity for rendering", () => {
    expect(normalizeAppearanceBackgroundOpacity(undefined)).toBe(100);
    expect(normalizeAppearanceBackgroundOpacity(42.4)).toBe(42);
    expect(normalizeAppearanceBackgroundOpacity(-1)).toBe(0);
    expect(normalizeAppearanceBackgroundOpacity(101)).toBe(100);
  });

  it("normalizes background blur for rendering", () => {
    expect(normalizeAppearanceBackgroundBlur(undefined)).toBe(0);
    expect(normalizeAppearanceBackgroundBlur(8.4)).toBe(8);
    expect(normalizeAppearanceBackgroundBlur(-1)).toBe(0);
    expect(normalizeAppearanceBackgroundBlur(21)).toBe(20);
  });
});
