function stripFontFamilyQuotes(fontFamily: string): string {
  return fontFamily.trim().replace(/^['"]+|['"]+$/g, "");
}

const FONT_STYLE_SUFFIX_PATTERN =
  /-(?:Black|Bold|BoldItalic|Book|BookOblique|Condensed|CondensedBold|CondensedLight|DemiBold|DemiBoldItalic|ExtraBold|ExtraLight|Heavy|HeavyItalic|Italic|Light|LightOblique|Medium|MediumItalic|Oblique|Regular|Roman|SemiBold|SemiBoldItalic|Semibold|Thin|UltraLight|UltraLightItalic)$/u;

const FONT_FAMILY_ALIASES = new Map<string, string>([
  ["system font", "SF Pro"],
  [".sf ns", "SF Pro"],
  [".sfns", "SF Pro"],
  [".sfns-regular", "SF Pro"],
  [".sf ns display", "SF Pro"],
  [".sfnsdisplay", "SF Pro"],
  [".sfnsdisplay-regular", "SF Pro"],
  [".sf ns text", "SF Pro"],
  [".sfnstext", "SF Pro"],
  [".sfnstext-regular", "SF Pro"],
  [".sf compact", "SF Compact"],
  [".sfcompact", "SF Compact"],
  [".sfcompact-regular", "SF Compact"],
  [".sf compact display", "SF Compact"],
  [".sfcompactdisplay", "SF Compact"],
  [".sfcompactdisplay-regular", "SF Compact"],
  [".sf compact text", "SF Compact"],
  [".sfcompacttext", "SF Compact"],
  [".sfcompacttext-regular", "SF Compact"],
  [".sf mono", "SF Mono"],
  ["sfmono", "SF Mono"],
  ["sfmono-regular", "SF Mono"],
  ["applecoloremoji", "Apple Color Emoji"],
  ["applesdgothicneo", "Apple SD Gothic Neo"],
  ["applesdgothicneoi", "Apple SD Gothic Neo"],
  [".applesdgothicneoi", "Apple SD Gothic Neo"],
  ["avenir", "Avenir"],
  ["avenirnext", "Avenir Next"],
  ["avenirnextcondensed", "Avenir Next Condensed"],
  ["geezaprointerface", "Geeza Pro"],
  [".geeza pro interface", "Geeza Pro"],
  ["helveticaneue", "Helvetica Neue"],
  ["lucidagrandeui", "Lucida Grande"],
  [".lucida grande ui", "Lucida Grande"],
]);

function normalizeFontFamilyAliasKey(fontFamily: string): string {
  return fontFamily.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function resolveUserFacingFontFamilyAlias(fontFamily: string): string {
  const directAlias = FONT_FAMILY_ALIASES.get(normalizeFontFamilyAliasKey(fontFamily));
  if (directAlias) {
    return directAlias;
  }

  const baseFontFamily = fontFamily.replace(FONT_STYLE_SUFFIX_PATTERN, "");
  if (baseFontFamily !== fontFamily) {
    return FONT_FAMILY_ALIASES.get(normalizeFontFamilyAliasKey(baseFontFamily)) ?? fontFamily;
  }

  return fontFamily;
}

export function isPrivateSystemFontFamily(fontFamily: string): boolean {
  return fontFamily.startsWith(".");
}

export function normalizeUserFacingFontFamily(
  fontFamily: string | null | undefined,
): string | null {
  if (typeof fontFamily !== "string") {
    return null;
  }

  const normalized = stripFontFamilyQuotes(fontFamily);
  if (normalized.length === 0) {
    return null;
  }

  const aliased = resolveUserFacingFontFamilyAlias(normalized);
  return isPrivateSystemFontFamily(aliased) ? null : aliased;
}
