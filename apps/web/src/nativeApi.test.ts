import type { DesktopBridge, NativeApi } from "contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetNativeApiForTests, hasDesktopNativeBridge } from "./nativeApi";

function getWindowForTest(): Window & typeof globalThis {
  return globalThis.window as Window & typeof globalThis;
}

describe("hasDesktopNativeBridge", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {} as Window & typeof globalThis);
  });

  afterEach(() => {
    __resetNativeApiForTests();
    Reflect.deleteProperty(getWindowForTest(), "desktopBridge");
    Reflect.deleteProperty(getWindowForTest(), "nativeApi");
    vi.unstubAllGlobals();
  });

  it("returns true when the Electron preload bridge is available", () => {
    getWindowForTest().desktopBridge = {
      getWsUrl: () => null,
    } as unknown as DesktopBridge;

    expect(hasDesktopNativeBridge()).toBe(true);
  });

  it("returns true when a native api is injected directly", () => {
    getWindowForTest().nativeApi = {} as NativeApi;

    expect(hasDesktopNativeBridge()).toBe(true);
  });

  it("returns false when neither desktop bridge nor native api is available", () => {
    expect(hasDesktopNativeBridge()).toBe(false);
  });
});
