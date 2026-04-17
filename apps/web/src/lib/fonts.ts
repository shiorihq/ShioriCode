import {
  DEFAULT_CODE_FONT_FAMILY,
  DEFAULT_UI_FONT_FAMILY,
  type ClientSettings,
} from "contracts/settings";
import { normalizeUserFacingFontFamily } from "shared/fontFamily";

const SYSTEM_SANS_STACK = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const SYSTEM_MONO_STACK =
  'ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

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
  return normalized ? `${escapeFontFamily(normalized)}, ${SYSTEM_SANS_STACK}` : SYSTEM_SANS_STACK;
}

export function getCodeFontFamilyCssValue(fontFamily: string): string {
  if (fontFamily === DEFAULT_CODE_FONT_FAMILY) {
    return SYSTEM_MONO_STACK;
  }

  const normalized = normalizeUserFacingFontFamily(fontFamily);
  return normalized ? `${escapeFontFamily(normalized)}, ${SYSTEM_MONO_STACK}` : SYSTEM_MONO_STACK;
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
