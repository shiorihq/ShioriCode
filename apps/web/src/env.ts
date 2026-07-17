export function detectElectronRuntime(input: {
  readonly userAgent: string;
  readonly hasDesktopBridge: boolean;
}): boolean {
  return input.hasDesktopBridge || /\bElectron\/[\d.]+/i.test(input.userAgent);
}

/** True only for the Electron runtime, never for similarly named browser globals. */
export const isElectron =
  typeof window !== "undefined" &&
  detectElectronRuntime({
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    hasDesktopBridge: window.desktopBridge !== undefined,
  });
