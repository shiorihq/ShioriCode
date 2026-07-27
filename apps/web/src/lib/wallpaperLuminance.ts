/**
 * Perceptual luminance of the active appearance background.
 *
 * Two things read this: the theme resolver (`themeMode: "wallpaper"` picks the
 * appearance whose text will contrast with the photo) and the scrim (a
 * mid-luminance photo is the hard case for BOTH appearances, so it gets more
 * cover). Both need the answer synchronously on the very first paint, which
 * drives the shape of this module:
 *
 *   - one module-level cache keyed by URL, mirrored into localStorage, so a
 *     relaunch with the same wallpaper resolves before the image decodes and
 *     the window never flashes the wrong appearance;
 *   - a `useSyncExternalStore`-compatible snapshot, so the first async sample
 *     re-renders the theme without any component owning the lifecycle.
 *
 * Sampling is one 32x32 downscale per URL, ever. The cost is a rounding error
 * next to decoding the full-size photo the wallpaper already paints.
 */

const STORAGE_KEY = "shiori.wallpaper-luminance";

/** Below this mean luminance the photo needs light text over it. Sits slightly
 * under the midpoint because dark text on a mid-grey photo fails before light
 * text does — the dark end of a theme's ramp is further from mid-grey than the
 * light end. */
const DARK_THRESHOLD = 0.45;

/** Downscale target. Large enough that a small bright object cannot swing the
 * mean, small enough that the whole read is a single sub-millisecond pass. */
const SAMPLE_SIZE = 32;

interface LuminanceCache {
  /** The wallpaper URL in use at the last render, so a cold start knows which
   * entry to trust before server settings have loaded. */
  activeUrl: string | null;
  byUrl: Record<string, number>;
}

let cache: LuminanceCache = { activeUrl: null, byUrl: {} };
let hydrated = false;
const listeners = new Set<() => void>();
const inFlight = new Set<string>();

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  if (typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    const next = parsed as Partial<LuminanceCache>;
    const byUrl: Record<string, number> = {};
    for (const [url, value] of Object.entries(next.byUrl ?? {})) {
      if (typeof value === "number" && Number.isFinite(value)) {
        byUrl[url] = value;
      }
    }
    cache = {
      activeUrl: typeof next.activeUrl === "string" ? next.activeUrl : null,
      byUrl,
    };
  } catch {
    // A corrupt cache is not worth failing a boot over; re-sampling costs one
    // downscale.
  }
}

function persist(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Quota or private mode. The in-memory cache still works for this session.
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function srgbToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/**
 * Mean relative luminance (WCAG coefficients, averaged in linear light so a
 * photo of half black and half white reads as mid-grey rather than as the
 * gamma-encoded 0.73 an sRGB average would give).
 */
export function meanLuminanceFromPixels(pixels: Uint8ClampedArray): number {
  let total = 0;
  let counted = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = pixels[index + 3] ?? 0;
    if (alpha === 0) continue;
    total +=
      0.2126 * srgbToLinear(pixels[index] ?? 0) +
      0.7152 * srgbToLinear(pixels[index + 1] ?? 0) +
      0.0722 * srgbToLinear(pixels[index + 2] ?? 0);
    counted += 1;
  }
  return counted === 0 ? 0.5 : total / counted;
}

export function isDarkLuminance(luminance: number): boolean {
  return luminance < DARK_THRESHOLD;
}

/**
 * How much extra cover the scrim needs, 0 at either extreme and 1 at mid-grey.
 *
 * A very dark or very bright photo is easy: one appearance clears it by a wide
 * margin. Mid-grey is the only genuinely hard case, because neither end of the
 * ramp has room, so that is where the scrim earns its keep.
 */
export function scrimBoostFromLuminance(luminance: number): number {
  const distanceFromMid = Math.abs(luminance - 0.5) / 0.5;
  return Math.max(0, Math.min(1, 1 - distanceFromMid));
}

function sample(url: string): void {
  if (typeof document === "undefined" || inFlight.has(url)) return;
  inFlight.add(url);

  const image = new Image();
  // Presets and custom uploads are both same-origin, so the canvas never
  // taints; this only keeps a redirected upload from silently failing later.
  image.crossOrigin = "anonymous";
  image.decoding = "async";

  image.addEventListener("load", () => {
    inFlight.delete(url);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = SAMPLE_SIZE;
      canvas.height = SAMPLE_SIZE;
      const context = canvas.getContext("2d", { willReadFrequently: false });
      if (!context) return;
      context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      const { data } = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      cache = { ...cache, byUrl: { ...cache.byUrl, [url]: meanLuminanceFromPixels(data) } };
      persist();
      emit();
    } catch {
      // Tainted canvas or a decode the UA refused. Callers fall back to the
      // system appearance, which is the same behaviour as no wallpaper.
    }
  });

  image.addEventListener("error", () => {
    inFlight.delete(url);
  });

  image.src = url;
}

/**
 * Point the store at the wallpaper currently on screen. Samples it on first
 * sight and is a no-op afterwards, so callers can invoke it on every render.
 */
export function setActiveWallpaperUrl(url: string | null): void {
  hydrate();
  if (cache.activeUrl !== url) {
    cache = { ...cache, activeUrl: url };
    persist();
    emit();
  }
  if (url !== null && cache.byUrl[url] === undefined) {
    sample(url);
  }
}

/** Luminance of the active wallpaper, or null if there is none or it has not
 * been sampled yet. */
export function getActiveWallpaperLuminance(): number | null {
  hydrate();
  if (cache.activeUrl === null) return null;
  return cache.byUrl[cache.activeUrl] ?? null;
}

export function subscribeToWallpaperLuminance(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: drop every cached sample and listener. */
export function resetWallpaperLuminanceCacheForTests(): void {
  cache = { activeUrl: null, byUrl: {} };
  hydrated = false;
  inFlight.clear();
  listeners.clear();
}
