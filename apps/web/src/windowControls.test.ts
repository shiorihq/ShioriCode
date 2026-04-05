import { describe, expect, it } from "vitest";

import {
  DEFAULT_MACOS_WINDOW_CONTROLS_LEFT_INSET_PX,
  resolveWindowControlsLeftInset,
} from "./windowControls";

describe("resolveWindowControlsLeftInset", () => {
  it("uses the native inset when available", () => {
    expect(
      resolveWindowControlsLeftInset({
        isElectron: true,
        isMac: true,
        inset: { left: 104 },
      }),
    ).toBe(104);
  });

  it("falls back to the macOS default when inset lookup fails", () => {
    expect(
      resolveWindowControlsLeftInset({
        isElectron: true,
        isMac: true,
        inset: null,
      }),
    ).toBe(DEFAULT_MACOS_WINDOW_CONTROLS_LEFT_INSET_PX);
  });

  it("does not reserve inset outside Electron macOS", () => {
    expect(
      resolveWindowControlsLeftInset({
        isElectron: false,
        isMac: true,
        inset: { left: 104 },
      }),
    ).toBe(0);
    expect(
      resolveWindowControlsLeftInset({
        isElectron: true,
        isMac: false,
        inset: { left: 104 },
      }),
    ).toBe(0);
  });
});
