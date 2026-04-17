/**
 * Shared palette for the Shiori agent TUI.
 *
 * The accent is derived from the Shiori design system primary token
 * (`oklch(0.771 0.101 241.4)`) so the CLI matches the web and desktop UIs.
 *
 * We pick the hex accent on truecolor terminals, a darker variant on light
 * terminals, and a named color fallback on 16-color terminals so the UI stays
 * legible everywhere.
 */

type ColorTier = "truecolor" | "256" | "16";
type Appearance = "dark" | "light";

function detectColorTier(): ColorTier {
  const colorterm = process.env.COLORTERM?.toLowerCase() ?? "";
  if (colorterm.includes("truecolor") || colorterm.includes("24bit")) {
    return "truecolor";
  }
  const term = process.env.TERM?.toLowerCase() ?? "";
  if (term.includes("256color")) return "256";
  if (term === "dumb" || term === "" || term === "linux") return "16";
  // Most modern emulators (iTerm, Alacritty, Kitty, WezTerm, VS Code) set
  // COLORTERM=truecolor — if they didn't, default to 256 which is widely safe.
  return "256";
}

function detectAppearance(): Appearance {
  // Rough heuristic: COLORFGBG is exported by many terminals as "fg;bg" where
  // bg 15 (white) / 7 (light gray) means a light background.
  const colorFgBg = process.env.COLORFGBG;
  if (colorFgBg) {
    const segments = colorFgBg.split(";");
    const last = segments[segments.length - 1];
    if (last === "15" || last === "7") return "light";
  }
  return "dark";
}

const TIER = detectColorTier();
const APPEARANCE = detectAppearance();

// Truecolor hex values (Shiori primary in both appearances).
const DARK_ACCENT = "#7AC0EF";
const DARK_ACCENT_BRIGHT = "#A8D7F5";
const DARK_ACCENT_DIM = "#4B7FA8";
const LIGHT_ACCENT = "#4D9BD0";
const LIGHT_ACCENT_BRIGHT = "#2F7DB5";
const LIGHT_ACCENT_DIM = "#6CA4CE";

function pickAccent(): { base: string; bright: string; dim: string } {
  if (TIER === "16") {
    return { base: "cyan", bright: "cyanBright", dim: "cyan" };
  }
  if (APPEARANCE === "light") {
    return { base: LIGHT_ACCENT, bright: LIGHT_ACCENT_BRIGHT, dim: LIGHT_ACCENT_DIM };
  }
  return { base: DARK_ACCENT, bright: DARK_ACCENT_BRIGHT, dim: DARK_ACCENT_DIM };
}

const { base, bright, dim } = pickAccent();

export const palette = {
  accent: base,
  accentBright: bright,
  accentDim: dim,
  neutral: "gray",
  neutralBright: "whiteBright",
  running: "yellow",
  runningBright: "yellowBright",
  success: "green",
  successBright: "greenBright",
  danger: "red",
  dangerBright: "redBright",
  warning: "yellow",
} as const;

export const terminalAppearance: Appearance = APPEARANCE;

export type PaletteColor = (typeof palette)[keyof typeof palette];
