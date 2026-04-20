/**
 * True when running inside the Electron preload bridge, false in a regular browser.
 * Desktop preload exposes `window.desktopBridge` immediately; `window.nativeApi`
 * may be populated later by the web app once auth allows the WS-backed client.
 */
export const isElectron =
  typeof window !== "undefined" &&
  (window.desktopBridge !== undefined || window.nativeApi !== undefined);
