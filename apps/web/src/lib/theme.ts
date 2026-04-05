import {
  type ImportedTheme,
  type ClientSettings,
  type TerminalThemeColors,
  type ThemeAppearance,
  type ThemeMode,
  type ThemeTokenValues,
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  ThemeAppearance as ThemeAppearanceSchema,
  ThemeTokenValues as ThemeTokenValuesSchema,
  TerminalThemeColors as TerminalThemeColorsSchema,
  THEME_TOKEN_KEYS,
} from "contracts/settings";
import { TrimmedNonEmptyString, TrimmedString } from "contracts";
import * as Schema from "effect/Schema";
import { readStoredClientSettings } from "../clientSettings";
import { applyFontSettingsToDocument } from "./fonts";
import { randomUUID } from "./utils";

export interface ThemeRecord extends ImportedTheme {
  source: "builtin" | "imported";
}

type ThemeImportFile = {
  version?: 1;
  id?: string;
  name: string;
  appearance: ThemeAppearance;
  author?: string;
  description?: string;
  radius?: string;
  tokens: ThemeTokenValues;
  terminal?: TerminalThemeColors;
};

const ThemeImportFileSchema = Schema.Struct({
  version: Schema.optionalKey(Schema.Literal(1)),
  id: Schema.optionalKey(TrimmedNonEmptyString),
  name: TrimmedNonEmptyString,
  appearance: ThemeAppearanceSchema,
  author: Schema.optionalKey(TrimmedString),
  description: Schema.optionalKey(TrimmedString),
  radius: Schema.optionalKey(TrimmedString),
  tokens: ThemeTokenValuesSchema,
  terminal: Schema.optionalKey(TerminalThemeColorsSchema),
});

const decodeThemeImportFile = Schema.decodeSync(Schema.fromJsonString(ThemeImportFileSchema));

function makeBuiltinTheme(theme: ImportedTheme): ThemeRecord {
  return {
    ...theme,
    source: "builtin",
  };
}

function isDefaultShioriThemeId(themeId: string): boolean {
  return themeId === DEFAULT_LIGHT_THEME_ID || themeId === DEFAULT_DARK_THEME_ID;
}

const BUILT_IN_THEME_RECORDS: readonly ThemeRecord[] = [
  makeBuiltinTheme({
    id: DEFAULT_LIGHT_THEME_ID,
    name: "Shiori Light",
    appearance: "light",
    author: "Built in",
    description: "The default ShioriCode light palette.",
    radius: "0.625rem",
    tokens: {
      background: "var(--color-white)",
      foreground: "var(--color-neutral-800)",
      card: "var(--color-white)",
      cardForeground: "var(--color-neutral-800)",
      popover: "var(--color-white)",
      popoverForeground: "var(--color-neutral-800)",
      primary: "oklch(0.671 0.101 241.4)",
      primaryForeground: "var(--color-white)",
      secondary: "--alpha(var(--color-black) / 4%)",
      secondaryForeground: "var(--color-neutral-800)",
      muted: "--alpha(var(--color-black) / 4%)",
      mutedForeground: "color-mix(in srgb, var(--color-neutral-500) 90%, var(--color-black))",
      accent: "--alpha(var(--color-black) / 4%)",
      accentForeground: "var(--color-neutral-800)",
      destructive: "var(--color-red-500)",
      destructiveForeground: "var(--color-red-700)",
      border: "--alpha(var(--color-black) / 8%)",
      input: "--alpha(var(--color-black) / 10%)",
      ring: "oklch(0.671 0.101 241.4)",
      info: "var(--color-blue-500)",
      infoForeground: "var(--color-blue-700)",
      success: "var(--color-emerald-500)",
      successForeground: "var(--color-emerald-700)",
      warning: "var(--color-amber-500)",
      warningForeground: "var(--color-amber-700)",
    },
    terminal: {
      background: "rgb(255, 255, 255)",
      foreground: "rgb(28, 33, 41)",
      cursor: "rgb(38, 56, 78)",
      selectionBackground: "rgba(37, 63, 99, 0.2)",
      scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
      scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
      scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
      black: "rgb(44, 53, 66)",
      red: "rgb(191, 70, 87)",
      green: "rgb(60, 126, 86)",
      yellow: "rgb(146, 112, 35)",
      blue: "rgb(72, 102, 163)",
      magenta: "rgb(132, 86, 149)",
      cyan: "rgb(53, 127, 141)",
      white: "rgb(210, 215, 223)",
      brightBlack: "rgb(112, 123, 140)",
      brightRed: "rgb(212, 95, 112)",
      brightGreen: "rgb(85, 148, 111)",
      brightYellow: "rgb(173, 133, 45)",
      brightBlue: "rgb(91, 124, 194)",
      brightMagenta: "rgb(153, 107, 172)",
      brightCyan: "rgb(70, 149, 164)",
      brightWhite: "rgb(236, 240, 246)",
    },
  }),
  makeBuiltinTheme({
    id: DEFAULT_DARK_THEME_ID,
    name: "Shiori Dark",
    appearance: "dark",
    author: "Built in",
    description: "The default ShioriCode dark palette.",
    radius: "0.625rem",
    tokens: {
      background: "color-mix(in srgb, var(--color-neutral-950) 95%, var(--color-white))",
      foreground: "var(--color-neutral-100)",
      card: "color-mix(in srgb, var(--background) 98%, var(--color-white))",
      cardForeground: "var(--color-neutral-100)",
      popover: "color-mix(in srgb, var(--background) 98%, var(--color-white))",
      popoverForeground: "var(--color-neutral-100)",
      primary: "oklch(0.771 0.101 241.4)",
      primaryForeground: "var(--color-white)",
      secondary: "--alpha(var(--color-white) / 4%)",
      secondaryForeground: "var(--color-neutral-100)",
      muted: "--alpha(var(--color-white) / 4%)",
      mutedForeground: "color-mix(in srgb, var(--color-neutral-500) 90%, var(--color-white))",
      accent: "--alpha(var(--color-white) / 4%)",
      accentForeground: "var(--color-neutral-100)",
      destructive: "color-mix(in srgb, var(--color-red-500) 90%, var(--color-white))",
      destructiveForeground: "var(--color-red-400)",
      border: "--alpha(var(--color-white) / 6%)",
      input: "--alpha(var(--color-white) / 8%)",
      ring: "oklch(0.771 0.101 241.4)",
      info: "var(--color-blue-500)",
      infoForeground: "var(--color-blue-400)",
      success: "var(--color-emerald-500)",
      successForeground: "var(--color-emerald-400)",
      warning: "var(--color-amber-500)",
      warningForeground: "var(--color-amber-400)",
    },
    terminal: {
      background: "rgb(14, 18, 24)",
      foreground: "rgb(237, 241, 247)",
      cursor: "rgb(180, 203, 255)",
      selectionBackground: "rgba(180, 203, 255, 0.25)",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
      black: "rgb(24, 30, 38)",
      red: "rgb(255, 122, 142)",
      green: "rgb(134, 231, 149)",
      yellow: "rgb(244, 205, 114)",
      blue: "rgb(137, 190, 255)",
      magenta: "rgb(208, 176, 255)",
      cyan: "rgb(124, 232, 237)",
      white: "rgb(210, 218, 230)",
      brightBlack: "rgb(110, 120, 136)",
      brightRed: "rgb(255, 168, 180)",
      brightGreen: "rgb(176, 245, 186)",
      brightYellow: "rgb(255, 224, 149)",
      brightBlue: "rgb(174, 210, 255)",
      brightMagenta: "rgb(229, 203, 255)",
      brightCyan: "rgb(167, 244, 247)",
      brightWhite: "rgb(244, 247, 252)",
    },
  }),
  makeBuiltinTheme({
    id: "builtin:catppuccin-latte",
    name: "Catppuccin Latte",
    appearance: "light",
    author: "Built in",
    description: "Soft warm neutrals with Catppuccin's Latte palette.",
    radius: "0.75rem",
    tokens: {
      background: "#eff1f5",
      foreground: "#4c4f69",
      card: "#ffffff",
      cardForeground: "#4c4f69",
      popover: "#ffffff",
      popoverForeground: "#4c4f69",
      primary: "#1e66f5",
      primaryForeground: "#eff1f5",
      secondary: "#dce0e8",
      secondaryForeground: "#4c4f69",
      muted: "#e6e9ef",
      mutedForeground: "#6c6f85",
      accent: "#ccd0da",
      accentForeground: "#4c4f69",
      destructive: "#d20f39",
      destructiveForeground: "#eff1f5",
      border: "#ccd0da",
      input: "#dce0e8",
      ring: "#7287fd",
      info: "#209fb5",
      infoForeground: "#e6e9ef",
      success: "#40a02b",
      successForeground: "#eff1f5",
      warning: "#df8e1d",
      warningForeground: "#eff1f5",
    },
    terminal: {
      background: "#eff1f5",
      foreground: "#4c4f69",
      cursor: "#dc8a78",
      selectionBackground: "rgba(114, 135, 253, 0.18)",
      scrollbarSliderBackground: "rgba(76, 79, 105, 0.12)",
      scrollbarSliderHoverBackground: "rgba(76, 79, 105, 0.22)",
      scrollbarSliderActiveBackground: "rgba(76, 79, 105, 0.28)",
      black: "#5c5f77",
      red: "#d20f39",
      green: "#40a02b",
      yellow: "#df8e1d",
      blue: "#1e66f5",
      magenta: "#ea76cb",
      cyan: "#179299",
      white: "#acb0be",
      brightBlack: "#6c6f85",
      brightRed: "#d20f39",
      brightGreen: "#40a02b",
      brightYellow: "#df8e1d",
      brightBlue: "#1e66f5",
      brightMagenta: "#8839ef",
      brightCyan: "#209fb5",
      brightWhite: "#bcc0cc",
    },
  }),
  makeBuiltinTheme({
    id: "builtin:catppuccin-mocha",
    name: "Catppuccin Mocha",
    appearance: "dark",
    author: "Built in",
    description: "Low-contrast dark theme using Catppuccin's Mocha palette.",
    radius: "0.75rem",
    tokens: {
      background: "#11111b",
      foreground: "#cdd6f4",
      card: "#181825",
      cardForeground: "#cdd6f4",
      popover: "#181825",
      popoverForeground: "#cdd6f4",
      primary: "#89b4fa",
      primaryForeground: "#11111b",
      secondary: "#313244",
      secondaryForeground: "#cdd6f4",
      muted: "#1e1e2e",
      mutedForeground: "#a6adc8",
      accent: "#45475a",
      accentForeground: "#cdd6f4",
      destructive: "#f38ba8",
      destructiveForeground: "#11111b",
      border: "#313244",
      input: "#45475a",
      ring: "#b4befe",
      info: "#74c7ec",
      infoForeground: "#11111b",
      success: "#a6e3a1",
      successForeground: "#11111b",
      warning: "#f9e2af",
      warningForeground: "#11111b",
    },
    terminal: {
      background: "#11111b",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      selectionBackground: "rgba(137, 180, 250, 0.2)",
      scrollbarSliderBackground: "rgba(205, 214, 244, 0.1)",
      scrollbarSliderHoverBackground: "rgba(205, 214, 244, 0.18)",
      scrollbarSliderActiveBackground: "rgba(205, 214, 244, 0.24)",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#cba6f7",
      brightCyan: "#74c7ec",
      brightWhite: "#a6adc8",
    },
  }),
  makeBuiltinTheme({
    id: "builtin:tokyo-night-day",
    name: "Tokyo Night Day",
    appearance: "light",
    author: "Built in",
    description: "Tokyo Night's daylight palette with crisp blue accents.",
    radius: "0.75rem",
    tokens: {
      background: "#e1e2e7",
      foreground: "#3760bf",
      card: "#d5d6db",
      cardForeground: "#3760bf",
      popover: "#d5d6db",
      popoverForeground: "#3760bf",
      primary: "#2e7de9",
      primaryForeground: "#ffffff",
      secondary: "#c4c8da",
      secondaryForeground: "#3760bf",
      muted: "#d5d6db",
      mutedForeground: "#6172b0",
      accent: "#b7c0e0",
      accentForeground: "#3760bf",
      destructive: "#f52a65",
      destructiveForeground: "#ffffff",
      border: "#b7c0e0",
      input: "#c4c8da",
      ring: "#2e7de9",
      info: "#007197",
      infoForeground: "#ffffff",
      success: "#587539",
      successForeground: "#ffffff",
      warning: "#8c6c3e",
      warningForeground: "#ffffff",
    },
    terminal: {
      background: "#e1e2e7",
      foreground: "#3760bf",
      cursor: "#2e7de9",
      selectionBackground: "rgba(46, 125, 233, 0.18)",
      scrollbarSliderBackground: "rgba(55, 96, 191, 0.12)",
      scrollbarSliderHoverBackground: "rgba(55, 96, 191, 0.2)",
      scrollbarSliderActiveBackground: "rgba(55, 96, 191, 0.28)",
      black: "#4c505e",
      red: "#f52a65",
      green: "#587539",
      yellow: "#8c6c3e",
      blue: "#2e7de9",
      magenta: "#9854f1",
      cyan: "#007197",
      white: "#a1a6c5",
      brightBlack: "#7c7f93",
      brightRed: "#f52a65",
      brightGreen: "#587539",
      brightYellow: "#8c6c3e",
      brightBlue: "#2e7de9",
      brightMagenta: "#9854f1",
      brightCyan: "#007197",
      brightWhite: "#3760bf",
    },
  }),
  makeBuiltinTheme({
    id: "builtin:tokyo-night",
    name: "Tokyo Night",
    appearance: "dark",
    author: "Built in",
    description: "The classic Tokyo Night palette with deep indigo surfaces.",
    radius: "0.75rem",
    tokens: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      card: "#1f2335",
      cardForeground: "#c0caf5",
      popover: "#1f2335",
      popoverForeground: "#c0caf5",
      primary: "#7aa2f7",
      primaryForeground: "#1a1b26",
      secondary: "#24283b",
      secondaryForeground: "#c0caf5",
      muted: "#1f2335",
      mutedForeground: "#9aa5ce",
      accent: "#2b3047",
      accentForeground: "#c0caf5",
      destructive: "#f7768e",
      destructiveForeground: "#1a1b26",
      border: "#2f3549",
      input: "#292e42",
      ring: "#7aa2f7",
      info: "#7dcfff",
      infoForeground: "#1a1b26",
      success: "#9ece6a",
      successForeground: "#1a1b26",
      warning: "#e0af68",
      warningForeground: "#1a1b26",
    },
    terminal: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      selectionBackground: "rgba(122, 162, 247, 0.2)",
      scrollbarSliderBackground: "rgba(192, 202, 245, 0.1)",
      scrollbarSliderHoverBackground: "rgba(192, 202, 245, 0.18)",
      scrollbarSliderActiveBackground: "rgba(192, 202, 245, 0.24)",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#f7768e",
      brightGreen: "#9ece6a",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#c0caf5",
    },
  }),
  makeBuiltinTheme({
    id: "builtin:absolutely-light",
    name: "Absolutely Light",
    appearance: "light",
    author: "Built in",
    description:
      "Warm off-white surfaces and terracotta accents inspired by Claude's Absolutely light theme.",
    radius: "0.75rem",
    tokens: {
      background: "#F9F9F7",
      foreground: "#2D2D2B",
      card: "#FFFFFF",
      cardForeground: "#2D2D2B",
      popover: "#FFFFFF",
      popoverForeground: "#2D2D2B",
      primary: "#CC7D5E",
      primaryForeground: "#F9F9F7",
      secondary: "#EFEFEC",
      secondaryForeground: "#2D2D2B",
      muted: "#F0F0ED",
      mutedForeground: "#5C5C57",
      accent: "#E8E8E3",
      accentForeground: "#2D2D2B",
      destructive: "#C53E3E",
      destructiveForeground: "#F9F9F7",
      border: "#DADAD5",
      input: "#E8E8E3",
      ring: "#CC7D5E",
      info: "#4A7AB8",
      infoForeground: "#F9F9F7",
      success: "#4F8F5A",
      successForeground: "#F9F9F7",
      warning: "#C9A227",
      warningForeground: "#2D2D2B",
    },
    terminal: {
      background: "#F9F9F7",
      foreground: "#2D2D2B",
      cursor: "#CC7D5E",
      selectionBackground: "rgba(204, 125, 94, 0.22)",
      scrollbarSliderBackground: "rgba(45, 45, 43, 0.12)",
      scrollbarSliderHoverBackground: "rgba(45, 45, 43, 0.2)",
      scrollbarSliderActiveBackground: "rgba(45, 45, 43, 0.28)",
      black: "#3D3D3A",
      red: "#C53E3E",
      green: "#4F8F5A",
      yellow: "#B8892E",
      blue: "#4A7AB8",
      magenta: "#A56B8C",
      cyan: "#3D8B8A",
      white: "#9A9893",
      brightBlack: "#6B6A65",
      brightRed: "#D95555",
      brightGreen: "#5BA868",
      brightYellow: "#C9A227",
      brightBlue: "#5A8AC8",
      brightMagenta: "#B87BA0",
      brightCyan: "#4A9E9C",
      brightWhite: "#2D2D2B",
    },
  }),
  makeBuiltinTheme({
    id: "builtin:absolutely-dark",
    name: "Absolutely Dark",
    appearance: "dark",
    author: "Built in",
    description:
      "Warm charcoal surfaces and terracotta accents inspired by Claude's Absolutely dark theme.",
    radius: "0.75rem",
    tokens: {
      background: "#2D2D2B",
      foreground: "#F9F9F7",
      card: "#333330",
      cardForeground: "#F9F9F7",
      popover: "#333330",
      popoverForeground: "#F9F9F7",
      primary: "#CC7D5E",
      primaryForeground: "#F9F9F7",
      secondary: "#383836",
      secondaryForeground: "#F9F9F7",
      muted: "#353533",
      mutedForeground: "#A8A8A3",
      accent: "#3D3D3A",
      accentForeground: "#F9F9F7",
      destructive: "#D95858",
      destructiveForeground: "#F9F9F7",
      border: "#454542",
      input: "#383836",
      ring: "#CC7D5E",
      info: "#6B9BD1",
      infoForeground: "#F9F9F7",
      success: "#6FA870",
      successForeground: "#F9F9F7",
      warning: "#D4A54A",
      warningForeground: "#2D2D2B",
    },
    terminal: {
      background: "#2D2D2B",
      foreground: "#F9F9F7",
      cursor: "#CC7D5E",
      selectionBackground: "rgba(204, 125, 94, 0.28)",
      scrollbarSliderBackground: "rgba(249, 249, 247, 0.1)",
      scrollbarSliderHoverBackground: "rgba(249, 249, 247, 0.16)",
      scrollbarSliderActiveBackground: "rgba(249, 249, 247, 0.22)",
      black: "#383836",
      red: "#D95858",
      green: "#6FA870",
      yellow: "#D4A54A",
      blue: "#6B9BD1",
      magenta: "#C49BC4",
      cyan: "#6BA8A6",
      white: "#C4C4BF",
      brightBlack: "#6B6A65",
      brightRed: "#E87070",
      brightGreen: "#82BC82",
      brightYellow: "#E4B85C",
      brightBlue: "#82B0E0",
      brightMagenta: "#D4B0D4",
      brightCyan: "#7FBEBC",
      brightWhite: "#F9F9F7",
    },
  }),
  makeBuiltinTheme({
    id: "builtin:raycast-light",
    name: "Raycast Light",
    appearance: "light",
    author: "Built in",
    description: "High-contrast white UI with coral accents inspired by Raycast's light theme.",
    radius: "0.625rem",
    tokens: {
      background: "#FFFFFF",
      foreground: "#030303",
      card: "#FAFAFA",
      cardForeground: "#030303",
      popover: "#FAFAFA",
      popoverForeground: "#030303",
      primary: "#FF6363",
      primaryForeground: "#FFFFFF",
      secondary: "#F0F0F0",
      secondaryForeground: "#030303",
      muted: "#F5F5F5",
      mutedForeground: "#5C5C5C",
      accent: "#EAEAEA",
      accentForeground: "#030303",
      destructive: "#E11D48",
      destructiveForeground: "#FFFFFF",
      border: "#E5E5E5",
      input: "#EBEBEB",
      ring: "#FF6363",
      info: "#2563EB",
      infoForeground: "#FFFFFF",
      success: "#16A34A",
      successForeground: "#FFFFFF",
      warning: "#CA8A04",
      warningForeground: "#030303",
    },
    terminal: {
      background: "#FFFFFF",
      foreground: "#030303",
      cursor: "#FF6363",
      selectionBackground: "rgba(255, 99, 99, 0.2)",
      scrollbarSliderBackground: "rgba(3, 3, 3, 0.12)",
      scrollbarSliderHoverBackground: "rgba(3, 3, 3, 0.2)",
      scrollbarSliderActiveBackground: "rgba(3, 3, 3, 0.28)",
      black: "#1A1A1A",
      red: "#E11D48",
      green: "#16A34A",
      yellow: "#CA8A04",
      blue: "#2563EB",
      magenta: "#A855F7",
      cyan: "#0891B2",
      white: "#737373",
      brightBlack: "#525252",
      brightRed: "#F43F5E",
      brightGreen: "#22C55E",
      brightYellow: "#EAB308",
      brightBlue: "#3B82F6",
      brightMagenta: "#C084FC",
      brightCyan: "#06B6D4",
      brightWhite: "#030303",
    },
  }),
  makeBuiltinTheme({
    id: "builtin:raycast-dark",
    name: "Raycast Dark",
    appearance: "dark",
    author: "Built in",
    description: "Near-black surfaces and coral accents inspired by Raycast's dark theme.",
    radius: "0.625rem",
    tokens: {
      background: "#101010",
      foreground: "#FEFEFE",
      card: "#181818",
      cardForeground: "#FEFEFE",
      popover: "#181818",
      popoverForeground: "#FEFEFE",
      primary: "#FF6363",
      primaryForeground: "#FEFEFE",
      secondary: "#242424",
      secondaryForeground: "#FEFEFE",
      muted: "#1A1A1A",
      mutedForeground: "#A3A3A3",
      accent: "#2A2A2A",
      accentForeground: "#FEFEFE",
      destructive: "#FB7185",
      destructiveForeground: "#101010",
      border: "#2E2E2E",
      input: "#242424",
      ring: "#FF6363",
      info: "#60A5FA",
      infoForeground: "#101010",
      success: "#4ADE80",
      successForeground: "#101010",
      warning: "#FACC15",
      warningForeground: "#101010",
    },
    terminal: {
      background: "#101010",
      foreground: "#FEFEFE",
      cursor: "#FF6363",
      selectionBackground: "rgba(255, 99, 99, 0.25)",
      scrollbarSliderBackground: "rgba(254, 254, 254, 0.1)",
      scrollbarSliderHoverBackground: "rgba(254, 254, 254, 0.16)",
      scrollbarSliderActiveBackground: "rgba(254, 254, 254, 0.22)",
      black: "#262626",
      red: "#FB7185",
      green: "#4ADE80",
      yellow: "#FACC15",
      blue: "#60A5FA",
      magenta: "#C084FC",
      cyan: "#22D3EE",
      white: "#A3A3A3",
      brightBlack: "#525252",
      brightRed: "#FDA4AF",
      brightGreen: "#86EFAC",
      brightYellow: "#FDE047",
      brightBlue: "#93C5FD",
      brightMagenta: "#D8B4FE",
      brightCyan: "#67E8F9",
      brightWhite: "#FEFEFE",
    },
  }),
  makeBuiltinTheme({
    id: "builtin:sakura-light",
    name: "Sakura Light",
    appearance: "light",
    author: "Built in",
    description: "Soft blush surfaces and cherry-blossom pinks for a calm spring palette.",
    radius: "0.75rem",
    tokens: {
      background: "#FFF8FA",
      foreground: "#4A3540",
      card: "#FFFFFF",
      cardForeground: "#4A3540",
      popover: "#FFFFFF",
      popoverForeground: "#4A3540",
      primary: "#E879A6",
      primaryForeground: "#FFFFFF",
      secondary: "#FCE7EF",
      secondaryForeground: "#4A3540",
      muted: "#FDF2F6",
      mutedForeground: "#7A6570",
      accent: "#F5D0DE",
      accentForeground: "#4A3540",
      destructive: "#DC2626",
      destructiveForeground: "#FFFFFF",
      border: "#F0C8D8",
      input: "#FCE7EF",
      ring: "#E879A6",
      info: "#7C9BD6",
      infoForeground: "#FFFFFF",
      success: "#4D9B6A",
      successForeground: "#FFFFFF",
      warning: "#D97706",
      warningForeground: "#FFFFFF",
    },
    terminal: {
      background: "#FFF8FA",
      foreground: "#4A3540",
      cursor: "#E879A6",
      selectionBackground: "rgba(232, 121, 166, 0.22)",
      scrollbarSliderBackground: "rgba(74, 53, 64, 0.1)",
      scrollbarSliderHoverBackground: "rgba(74, 53, 64, 0.18)",
      scrollbarSliderActiveBackground: "rgba(74, 53, 64, 0.26)",
      black: "#5C4552",
      red: "#DC2626",
      green: "#4D9B6A",
      yellow: "#D97706",
      blue: "#7C9BD6",
      magenta: "#E879A6",
      cyan: "#5BA8A8",
      white: "#B8A8B0",
      brightBlack: "#8A7680",
      brightRed: "#EF4444",
      brightGreen: "#5CBD7E",
      brightYellow: "#F59E0B",
      brightBlue: "#93B4E8",
      brightMagenta: "#F0A0C0",
      brightCyan: "#6EC5C5",
      brightWhite: "#4A3540",
    },
  }),
  makeBuiltinTheme({
    id: "builtin:sakura-dark",
    name: "Sakura Dark",
    appearance: "dark",
    author: "Built in",
    description: "Deep plum night tones with sakura pink highlights.",
    radius: "0.75rem",
    tokens: {
      background: "#1F161C",
      foreground: "#F5E8EE",
      card: "#2A1F26",
      cardForeground: "#F5E8EE",
      popover: "#2A1F26",
      popoverForeground: "#F5E8EE",
      primary: "#F0A0C0",
      primaryForeground: "#1F161C",
      secondary: "#352830",
      secondaryForeground: "#F5E8EE",
      muted: "#2E222A",
      mutedForeground: "#C4AAB8",
      accent: "#3D2F38",
      accentForeground: "#F5E8EE",
      destructive: "#F87171",
      destructiveForeground: "#1F161C",
      border: "#45333F",
      input: "#352830",
      ring: "#F0A0C0",
      info: "#93C5FD",
      infoForeground: "#1F161C",
      success: "#86EFAC",
      successForeground: "#1F161C",
      warning: "#FCD34D",
      warningForeground: "#1F161C",
    },
    terminal: {
      background: "#1F161C",
      foreground: "#F5E8EE",
      cursor: "#F0A0C0",
      selectionBackground: "rgba(240, 160, 192, 0.28)",
      scrollbarSliderBackground: "rgba(245, 232, 238, 0.1)",
      scrollbarSliderHoverBackground: "rgba(245, 232, 238, 0.16)",
      scrollbarSliderActiveBackground: "rgba(245, 232, 238, 0.22)",
      black: "#352830",
      red: "#F87171",
      green: "#86EFAC",
      yellow: "#FCD34D",
      blue: "#93C5FD",
      magenta: "#F0A0C0",
      cyan: "#7DD3FC",
      white: "#C4AAB8",
      brightBlack: "#6B5A65",
      brightRed: "#FCA5A5",
      brightGreen: "#BBF7D0",
      brightYellow: "#FDE68A",
      brightBlue: "#BFDBFE",
      brightMagenta: "#FBCFE8",
      brightCyan: "#A5F3FC",
      brightWhite: "#F5E8EE",
    },
  }),
];

function themeCssVariable(token: string): string {
  return `--${token.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}`;
}

function slugifyThemeSegment(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "theme";
}

function ensureUniqueImportedThemeId(
  explicitId: string | undefined,
  file: ThemeImportFile,
  existingThemes: ReadonlyArray<ImportedTheme>,
): string {
  if (explicitId) {
    return explicitId;
  }

  const baseId = `imported:${slugifyThemeSegment(file.name)}-${file.appearance}`;
  if (!existingThemes.some((theme) => theme.id === baseId)) {
    return baseId;
  }

  return `${baseId}-${randomUUID().slice(0, 8).toLowerCase()}`;
}

export function resolveThemeMode(mode: ThemeMode, systemDark: boolean): ThemeAppearance {
  if (mode === "system") {
    return systemDark ? "dark" : "light";
  }
  return mode;
}

export function parseImportedThemeJson(
  jsonText: string,
  existingThemes: ReadonlyArray<ImportedTheme>,
): ImportedTheme {
  const parsed = decodeThemeImportFile(jsonText);
  return {
    id: ensureUniqueImportedThemeId(parsed.id, parsed, existingThemes),
    name: parsed.name,
    appearance: parsed.appearance,
    author: parsed.author ?? "",
    description: parsed.description ?? "",
    radius: parsed.radius ?? "",
    tokens: parsed.tokens,
    ...(parsed.terminal ? { terminal: parsed.terminal } : {}),
  };
}

export function upsertImportedTheme(
  themes: ReadonlyArray<ImportedTheme>,
  nextTheme: ImportedTheme,
): ImportedTheme[] {
  const existingIndex = themes.findIndex((theme) => theme.id === nextTheme.id);
  if (existingIndex === -1) {
    return [...themes, nextTheme];
  }

  const nextThemes = [...themes];
  nextThemes[existingIndex] = nextTheme;
  return nextThemes;
}

export function removeImportedThemeFromSettings(
  settings: ClientSettings,
  themeId: string,
): ClientSettings {
  return {
    ...settings,
    importedThemes: settings.importedThemes.filter((theme) => theme.id !== themeId),
    lightThemeId:
      settings.lightThemeId === themeId ? DEFAULT_LIGHT_THEME_ID : settings.lightThemeId,
    darkThemeId: settings.darkThemeId === themeId ? DEFAULT_DARK_THEME_ID : settings.darkThemeId,
  };
}

export function getThemeOptions(
  settings: Pick<ClientSettings, "importedThemes">,
  appearance: ThemeAppearance,
): ThemeRecord[] {
  const builtinThemes = BUILT_IN_THEME_RECORDS.filter((theme) => theme.appearance === appearance);
  const importedThemes = settings.importedThemes
    .filter((theme) => theme.appearance === appearance)
    .map<ThemeRecord>((theme) => Object.assign({}, theme, { source: "imported" as const }));

  return [...builtinThemes, ...importedThemes];
}

function assignedThemeId(settings: ClientSettings, appearance: ThemeAppearance): string {
  return appearance === "light" ? settings.lightThemeId : settings.darkThemeId;
}

function defaultBuiltinThemeForAppearance(appearance: ThemeAppearance): ThemeRecord {
  const defaultThemeId = appearance === "light" ? DEFAULT_LIGHT_THEME_ID : DEFAULT_DARK_THEME_ID;
  const defaultTheme = BUILT_IN_THEME_RECORDS.find((theme) => theme.id === defaultThemeId);
  if (defaultTheme) {
    return defaultTheme;
  }

  const fallbackTheme = BUILT_IN_THEME_RECORDS.find((theme) => theme.appearance === appearance);
  if (fallbackTheme) {
    return fallbackTheme;
  }

  throw new Error(`Missing builtin theme for appearance ${appearance}`);
}

export function resolveThemeRecord(
  settings: ClientSettings,
  appearance: ThemeAppearance,
): ThemeRecord {
  const builtinTheme = defaultBuiltinThemeForAppearance(appearance);
  const options = getThemeOptions(settings, appearance);
  const selectedTheme = options.find((theme) => theme.id === assignedThemeId(settings, appearance));
  if (!selectedTheme || selectedTheme.source === "builtin") {
    return selectedTheme ?? builtinTheme;
  }

  return {
    ...selectedTheme,
    radius: selectedTheme.radius || builtinTheme.radius,
    terminal: selectedTheme.terminal ?? builtinTheme.terminal!,
  };
}

export function resolveDocumentThemeState(settings: ClientSettings, systemDark: boolean) {
  const resolvedTheme = resolveThemeMode(settings.themeMode, systemDark);
  const activeTheme = resolveThemeRecord(settings, resolvedTheme);
  return {
    resolvedTheme,
    activeTheme,
  };
}

function withTransitionSuppression(
  root: HTMLElement,
  suppressTransitions: boolean,
  apply: () => void,
): void {
  if (
    !suppressTransitions ||
    !root.classList ||
    typeof root.classList.add !== "function" ||
    typeof root.classList.remove !== "function"
  ) {
    apply();
    return;
  }

  root.classList.add("no-transitions");
  apply();
  void root.offsetHeight;
  requestAnimationFrame(() => {
    root.classList.remove("no-transitions");
  });
}

function setThemeDataAttribute(
  root: HTMLElement,
  name: "themeId" | "themeAppearance",
  value: string,
): void {
  if (typeof root.setAttribute === "function") {
    root.setAttribute(name === "themeId" ? "data-theme-id" : "data-theme-appearance", value);
    return;
  }

  const datasetRoot = root as HTMLElement & {
    dataset?: Record<string, string>;
  };
  datasetRoot.dataset ??= {};
  datasetRoot.dataset[name] = value;
}

export function applyThemeToDocument(
  settings: ClientSettings,
  systemDark: boolean,
  suppressTransitions = false,
): void {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  if (
    !root ||
    !root.style ||
    typeof root.style.setProperty !== "function" ||
    !root.classList ||
    typeof root.classList.toggle !== "function"
  ) {
    return;
  }

  const { activeTheme, resolvedTheme } = resolveDocumentThemeState(settings, systemDark);
  applyFontSettingsToDocument(settings);

  withTransitionSuppression(root, suppressTransitions, () => {
    root.classList.toggle("dark", resolvedTheme === "dark");
    setThemeDataAttribute(root, "themeId", activeTheme.id);
    setThemeDataAttribute(root, "themeAppearance", activeTheme.appearance);

    if (isDefaultShioriThemeId(activeTheme.id)) {
      root.style.removeProperty("--radius");
      for (const tokenKey of THEME_TOKEN_KEYS) {
        root.style.removeProperty(themeCssVariable(tokenKey));
      }
      return;
    }

    root.style.setProperty("--radius", activeTheme.radius);
    for (const tokenKey of THEME_TOKEN_KEYS) {
      root.style.setProperty(themeCssVariable(tokenKey), activeTheme.tokens[tokenKey]);
    }
  });
}

export function applyStoredThemeToDocument(systemDark: boolean): void {
  applyThemeToDocument(readStoredClientSettings(), systemDark);
}

export function resolveTerminalThemeColors(
  settings: ClientSettings,
  appearance: ThemeAppearance,
): TerminalThemeColors {
  const activeTheme = resolveThemeRecord(settings, appearance);
  return activeTheme.terminal ?? defaultBuiltinThemeForAppearance(appearance).terminal!;
}

export function getDocumentTerminalThemeColors(): TerminalThemeColors {
  const root = typeof document === "undefined" ? null : document.documentElement;
  const appearance =
    root?.classList.contains("dark") === true ? ("dark" as const) : ("light" as const);
  const settings = readStoredClientSettings();
  return resolveTerminalThemeColors(settings, appearance);
}
