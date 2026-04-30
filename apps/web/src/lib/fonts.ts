import {
  DEFAULT_CODE_FONT_FAMILY,
  DEFAULT_UI_FONT_FAMILY,
  type ClientSettings,
} from "contracts/settings";
import { normalizeUserFacingFontFamily } from "shared/fontFamily";

type CssFontFamily = {
  name: string;
  quoted?: boolean;
};

const SYSTEM_SANS_FONT_FAMILIES: readonly CssFontFamily[] = [
  { name: "Söhne", quoted: true },
  { name: "system-ui" },
  { name: "-apple-system" },
  { name: "BlinkMacSystemFont" },
  { name: "Segoe UI", quoted: true },
  { name: "sans-serif" },
];
const SYSTEM_MONO_FONT_FAMILIES: readonly CssFontFamily[] = [
  { name: "Geist Mono", quoted: true },
  { name: "ui-monospace" },
  { name: "SFMono-Regular", quoted: true },
  { name: "Consolas" },
  { name: "Liberation Mono", quoted: true },
  { name: "Menlo" },
  { name: "monospace" },
];

const SYSTEM_SANS_STACK = formatCssFontFamilyStack(SYSTEM_SANS_FONT_FAMILIES);
const SYSTEM_MONO_STACK = formatCssFontFamilyStack(SYSTEM_MONO_FONT_FAMILIES);

const CSS_FONT_FAMILY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "Apple SD Gothic Neo": ["AppleSDGothicNeo-Regular"],
  Avenir: ["Avenir-Roman"],
  "Avenir Next": ["AvenirNext-Regular"],
  "Avenir Next Condensed": ["AvenirNextCondensed-Regular"],
  "Geeza Pro": ["GeezaProInterface"],
  "Helvetica Neue": ["HelveticaNeue"],
  "Lucida Grande": ["LucidaGrandeUI"],
  "SF Compact": ["SF Compact Text", "SF Compact Display"],
  "SF Mono": ["SFMono-Regular"],
  "SF Pro": ["SF Pro Text", "SF Pro Display"],
};

type LocalFontData = {
  family: string;
};

type QueryLocalFontsFn = () => Promise<readonly LocalFontData[]>;

type FontCatalog = {
  all: string[];
  monospace: string[];
};

let fontCatalogPromise: Promise<FontCatalog> | null = null;

function dedupeFontFamilies(fontFamilies: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const fontFamily of fontFamilies) {
    const normalized = normalizeUserFacingFontFamily(fontFamily);
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.set(key, normalized);
    }
  }

  return Array.from(seen.values()).toSorted((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
}

function escapeFontFamily(fontFamily: string): string {
  return `"${fontFamily.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function formatCssFontFamily(fontFamily: CssFontFamily): string {
  return fontFamily.quoted ? escapeFontFamily(fontFamily.name) : fontFamily.name;
}

function formatCssFontFamilyStack(fontFamilies: readonly CssFontFamily[]): string {
  return fontFamilies.map(formatCssFontFamily).join(", ");
}

function getFontFamilyStackWithAliases(
  fontFamily: string,
  fallbackFontFamilies: readonly CssFontFamily[],
): string {
  const aliases = CSS_FONT_FAMILY_ALIASES[fontFamily] ?? [];
  const fontFamilies: CssFontFamily[] = [
    { name: fontFamily, quoted: true },
    ...aliases.map((alias) => ({ name: alias, quoted: true })),
    ...fallbackFontFamilies,
  ];
  const seen = new Set<string>();

  return fontFamilies
    .filter((candidate) => {
      const key = candidate.name.toLocaleLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map(formatCssFontFamily)
    .join(", ");
}

function measureTextWidth(context: CanvasRenderingContext2D, fontFamily: string, sample: string) {
  context.font = `16px ${escapeFontFamily(fontFamily)}, monospace`;
  return context.measureText(sample).width;
}

export function isLikelyMonospaceFont(fontFamily: string): boolean {
  if (typeof document === "undefined") {
    return false;
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    return false;
  }

  const narrow = measureTextWidth(context, fontFamily, "iiiiiiii");
  const wide = measureTextWidth(context, fontFamily, "WWWWWWWW");
  return Math.abs(narrow - wide) < 0.1;
}

function getQueryLocalFonts(): QueryLocalFontsFn | null {
  const globalWithFonts = globalThis as typeof globalThis & {
    queryLocalFonts?: QueryLocalFontsFn;
  };

  return typeof globalWithFonts.queryLocalFonts === "function"
    ? globalWithFonts.queryLocalFonts.bind(globalThis)
    : null;
}

async function loadBrowserFontFamilies(): Promise<string[]> {
  const queryLocalFonts = getQueryLocalFonts();
  if (!queryLocalFonts) {
    return [];
  }

  try {
    const localFonts = await queryLocalFonts();
    return dedupeFontFamilies(localFonts.map((font) => font.family));
  } catch {
    return [];
  }
}

async function loadDesktopFontFamilies(): Promise<string[]> {
  const bridge = window.desktopBridge;
  if (!bridge?.listSystemFonts) {
    return [];
  }

  try {
    return dedupeFontFamilies(await bridge.listSystemFonts());
  } catch {
    return [];
  }
}

async function loadFontCatalogInternal(): Promise<FontCatalog> {
  const desktopFonts = await loadDesktopFontFamilies();
  const browserFonts = desktopFonts.length === 0 ? await loadBrowserFontFamilies() : [];
  const all = dedupeFontFamilies([...desktopFonts, ...browserFonts]);

  return {
    all,
    monospace: all.filter(isLikelyMonospaceFont),
  };
}

export async function loadFontCatalog(): Promise<FontCatalog> {
  if (!fontCatalogPromise) {
    fontCatalogPromise = loadFontCatalogInternal();
  }

  return fontCatalogPromise;
}

export function getUiFontFamilyCssValue(fontFamily: string): string {
  if (fontFamily === DEFAULT_UI_FONT_FAMILY) {
    return SYSTEM_SANS_STACK;
  }

  const normalized = normalizeUserFacingFontFamily(fontFamily);
  return normalized
    ? getFontFamilyStackWithAliases(normalized, SYSTEM_SANS_FONT_FAMILIES)
    : SYSTEM_SANS_STACK;
}

export function getCodeFontFamilyCssValue(fontFamily: string): string {
  if (fontFamily === DEFAULT_CODE_FONT_FAMILY) {
    return SYSTEM_MONO_STACK;
  }

  const normalized = normalizeUserFacingFontFamily(fontFamily);
  return normalized
    ? getFontFamilyStackWithAliases(normalized, SYSTEM_MONO_FONT_FAMILIES)
    : SYSTEM_MONO_STACK;
}

export function applyFontSettingsToDocument(
  settings: Pick<ClientSettings, "uiFontFamily" | "codeFontFamily">,
): void {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  if (!root || !root.style || typeof root.style.setProperty !== "function") {
    return;
  }

  root.style.setProperty("--font-sans", getUiFontFamilyCssValue(settings.uiFontFamily));
  root.style.setProperty("--font-mono", getCodeFontFamilyCssValue(settings.codeFontFamily));
}
