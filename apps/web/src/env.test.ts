import { describe, expect, it } from "vitest";

import { detectElectronRuntime } from "./env";

describe("detectElectronRuntime", () => {
  it("recognizes Electron from its user agent", () => {
    expect(
      detectElectronRuntime({
        userAgent: "Mozilla/5.0 Chrome/140.0 Electron/40.6.0 Safari/537.36",
        hasDesktopBridge: false,
      }),
    ).toBe(true);
  });

  it("recognizes the preload bridge even when the user agent is customized", () => {
    expect(detectElectronRuntime({ userAgent: "ShioriCode", hasDesktopBridge: true })).toBe(true);
  });

  it("does not classify Chromium browsers as Electron", () => {
    expect(
      detectElectronRuntime({
        userAgent: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36 Arc/1.104",
        hasDesktopBridge: false,
      }),
    ).toBe(false);
  });
});
