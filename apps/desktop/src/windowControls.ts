import type { DesktopWindowControlsInset } from "contracts";

export const MACOS_TRAFFIC_LIGHT_POSITION = { x: 16, y: 18 } as const;

const MACOS_TRAFFIC_LIGHT_BUTTON_COUNT = 3;
const MACOS_TRAFFIC_LIGHT_BUTTON_DIAMETER_PX = 14;
const MACOS_TRAFFIC_LIGHT_BUTTON_GAP_PX = 8;
const MACOS_TRAFFIC_LIGHT_TRAILING_GUTTER_PX = 16;

export function resolveDesktopWindowControlsInset(
  platform: NodeJS.Platform,
): DesktopWindowControlsInset | null {
  if (platform !== "darwin") {
    return null;
  }

  const clusterWidth =
    MACOS_TRAFFIC_LIGHT_BUTTON_COUNT * MACOS_TRAFFIC_LIGHT_BUTTON_DIAMETER_PX +
    (MACOS_TRAFFIC_LIGHT_BUTTON_COUNT - 1) * MACOS_TRAFFIC_LIGHT_BUTTON_GAP_PX;

  return {
    left: Math.round(
      MACOS_TRAFFIC_LIGHT_POSITION.x + clusterWidth + MACOS_TRAFFIC_LIGHT_TRAILING_GUTTER_PX,
    ),
  };
}
