import { describe, expect, it } from "vitest";

import {
  isPrivateSystemFontFamily,
  normalizeUserFacingFontFamily,
  resolveUserFacingFontFamilyAlias,
} from "./fontFamily";

describe("fontFamily", () => {
  it("normalizes quoted public font families", () => {
    expect(normalizeUserFacingFontFamily('  "Geist Mono"  ')).toBe("Geist Mono");
    expect(normalizeUserFacingFontFamily("'SF Mono'")).toBe("SF Mono");
  });

  it("aliases known macOS private and PostScript font identifiers", () => {
    expect(isPrivateSystemFontFamily(".SFNS-Regular")).toBe(true);
    expect(isPrivateSystemFontFamily(".AppleSDGothicNeoI-Regular")).toBe(true);
    expect(normalizeUserFacingFontFamily(".SFNS-Regular")).toBe("SF Pro");
    expect(normalizeUserFacingFontFamily('".AppleSDGothicNeoI-Regular"')).toBe(
      "Apple SD Gothic Neo",
    );
    expect(normalizeUserFacingFontFamily("SFMono-Regular")).toBe("SF Mono");
    expect(normalizeUserFacingFontFamily("AvenirNext-DemiBold")).toBe("Avenir Next");
  });

  it("filters unknown private macOS font identifiers", () => {
    expect(normalizeUserFacingFontFamily(".UnknownPrivateFont-Regular")).toBeNull();
  });

  it("resolves aliases without requiring full normalization", () => {
    expect(resolveUserFacingFontFamilyAlias("System Font")).toBe("SF Pro");
    expect(resolveUserFacingFontFamilyAlias("HelveticaNeue-Bold")).toBe("Helvetica Neue");
    expect(resolveUserFacingFontFamilyAlias("SomeFont-Regular")).toBe("SomeFont-Regular");
  });

  it("returns null for empty values", () => {
    expect(normalizeUserFacingFontFamily("")).toBeNull();
    expect(normalizeUserFacingFontFamily("   ")).toBeNull();
    expect(normalizeUserFacingFontFamily(null)).toBeNull();
    expect(normalizeUserFacingFontFamily(undefined)).toBeNull();
  });
});
