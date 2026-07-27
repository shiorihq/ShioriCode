import type { AppearanceBackground, AppearanceBackgroundPresetId } from "contracts/settings";

export interface AppearanceBackgroundPreset {
  readonly id: AppearanceBackgroundPresetId;
  readonly name: string;
  readonly description: string;
  readonly url: string;
}

export const APPEARANCE_BACKGROUND_PRESETS: ReadonlyArray<AppearanceBackgroundPreset> = [
  {
    id: "evening-journey",
    name: "Evening Journey",
    description: "A rural train at blue hour",
    url: "/backgrounds/evening-journey.webp",
  },
  {
    id: "japanese-spring",
    name: "Spring",
    description: "Cherry blossoms beside the river",
    url: "/backgrounds/japanese-spring.webp",
  },
  {
    id: "japanese-summer",
    name: "Summer",
    description: "Rain-washed rice terraces",
    url: "/backgrounds/japanese-summer.webp",
  },
  {
    id: "japanese-autumn",
    name: "Autumn",
    description: "Maples around a mountain temple",
    url: "/backgrounds/japanese-autumn.webp",
  },
  {
    id: "japanese-winter",
    name: "Winter",
    description: "A snow-covered mountain village",
    url: "/backgrounds/japanese-winter.webp",
  },
];

export function customAppearanceBackgroundUrl(version: string): string | null {
  const normalized = version.trim();
  return normalized ? `/api/appearance/background/${encodeURIComponent(normalized)}` : null;
}

export function normalizeAppearanceBackgroundOpacity(opacity: number | undefined): number {
  if (opacity === undefined || !Number.isFinite(opacity)) return 100;
  return Math.round(Math.min(100, Math.max(0, opacity)));
}

export function normalizeAppearanceBackgroundBlur(blur: number | undefined): number {
  if (blur === undefined || !Number.isFinite(blur)) return 0;
  return Math.round(Math.min(20, Math.max(0, blur)));
}

export function resolveAppearanceBackgroundUrl(
  background: AppearanceBackground | undefined,
): string | null {
  if (!background) return null;
  if (background.kind === "custom") {
    return customAppearanceBackgroundUrl(background.customVersion);
  }
  if (background.kind !== "preset" || !background.presetId) {
    return null;
  }
  return (
    APPEARANCE_BACKGROUND_PRESETS.find((preset) => preset.id === background.presetId)?.url ?? null
  );
}
