import { describe, expect, it } from "vitest";

import { resolveDesktopWindowControlsInset } from "./windowControls";

describe("resolveDesktopWindowControlsInset", () => {
  it("matches the configured macOS traffic-light layout", () => {
    expect(resolveDesktopWindowControlsInset("darwin")).toEqual({ left: 90 });
  });

  it("does not reserve inset on non-macOS platforms", () => {
    expect(resolveDesktopWindowControlsInset("linux")).toBeNull();
    expect(resolveDesktopWindowControlsInset("win32")).toBeNull();
  });
});
