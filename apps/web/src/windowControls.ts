import type { DesktopWindowControlsInset } from "contracts";

export const DEFAULT_MACOS_WINDOW_CONTROLS_LEFT_INSET_PX = 90;

export function resolveWindowControlsLeftInset(options: {
  isElectron: boolean;
  isMac: boolean;
  inset: DesktopWindowControlsInset | null | undefined;
}): number {
  if (!options.isElectron || !options.isMac) {
    return 0;
  }

  const left = options.inset?.left;
  return Number.isFinite(left) && typeof left === "number" && left > 0
    ? Math.round(left)
    : DEFAULT_MACOS_WINDOW_CONTROLS_LEFT_INSET_PX;
}
