import { describe, expect, it } from "vitest";

import { isPrivateSystemFontFamily, normalizeUserFacingFontFamily } from "./fontFamily";

describe("fontFamily", () => {
  it("normalizes quoted public font families", () => {
    expect(normalizeUserFacingFontFamily('  "Geist Mono"  ')).toBe("Geist Mono");
    expect(normalizeUserFacingFontFamily("'SF Mono'")).toBe("SF Mono");
  });

  it("filters private macOS font identifiers", () => {
    expect(isPrivateSystemFontFamily(".SFNS-Regular")).toBe(true);
    expect(isPrivateSystemFontFamily(".AppleSDGothicNeoI-Regular")).toBe(true);
    expect(normalizeUserFacingFontFamily(".SFNS-Regular")).toBeNull();
    expect(normalizeUserFacingFontFamily('".AppleSDGothicNeoI-Regular"')).toBeNull();
  });

  it("returns null for empty values", () => {
    expect(normalizeUserFacingFontFamily("")).toBeNull();
    expect(normalizeUserFacingFontFamily("   ")).toBeNull();
    expect(normalizeUserFacingFontFamily(null)).toBeNull();
    expect(normalizeUserFacingFontFamily(undefined)).toBeNull();
  });
});
