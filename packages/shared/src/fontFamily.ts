function stripFontFamilyQuotes(fontFamily: string): string {
  return fontFamily.trim().replace(/^['"]+|['"]+$/g, "");
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

  return isPrivateSystemFontFamily(normalized) ? null : normalized;
}
