import { describe, expect, it } from "vitest";

import { getCodeFontFamilyCssValue, getUiFontFamilyCssValue } from "./fonts";

describe("font helpers", () => {
  it("expands known macOS UI font aliases before the fallback stack", () => {
    expect(getUiFontFamilyCssValue(".SFNS-Regular")).toBe(
      '"SF Pro", "SF Pro Text", "SF Pro Display", "Söhne", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    );
  });

  it("expands known macOS monospace font aliases before the fallback stack", () => {
    expect(getCodeFontFamilyCssValue("SFMono-Regular")).toBe(
      '"SF Mono", "SFMono-Regular", "Geist Mono", ui-monospace, Consolas, "Liberation Mono", Menlo, monospace',
    );
  });

  it("expands known PostScript aliases before the fallback stack", () => {
    expect(getCodeFontFamilyCssValue(".AppleSDGothicNeoI-Regular")).toBe(
      '"Apple SD Gothic Neo", "AppleSDGothicNeo-Regular", "Geist Mono", ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    );
  });

  it("falls back to the system monospace stack for unknown private macOS font identifiers", () => {
    expect(getCodeFontFamilyCssValue(".UnknownPrivateFont-Regular")).toBe(
      '"Geist Mono", ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    );
  });
});
