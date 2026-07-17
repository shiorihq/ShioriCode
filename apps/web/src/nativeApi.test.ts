import type { DesktopBridge, NativeApi } from "contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetNativeApiForTests,
  ensureNativeApi,
  hasDesktopNativeBridge,
  isRemoteDesktopConnection,
} from "./nativeApi";

vi.mock("./wsNativeApi", () => ({
  __resetWsNativeApiForTests: vi.fn(),
  createWsNativeApi: vi.fn(() => ({ mocked: true })),
}));

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
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns true when the Electron preload bridge is available", () => {
    getWindowForTest().desktopBridge = {
      getWsUrl: () => null,
    } as unknown as DesktopBridge;

    expect(hasDesktopNativeBridge()).toBe(true);
  });

  it("does not trust a nativeApi global injected into a regular browser", () => {
    getWindowForTest().nativeApi = {} as NativeApi;

    expect(hasDesktopNativeBridge()).toBe(false);
  });

  it("returns false when neither desktop bridge nor native api is available", () => {
    expect(hasDesktopNativeBridge()).toBe(false);
  });

  it("distinguishes a remote desktop target from its loopback backend", () => {
    getWindowForTest().desktopBridge = {
      getWsUrl: () => "wss://sc-example.link.shiori.codes/ws",
    } as unknown as DesktopBridge;
    expect(isRemoteDesktopConnection()).toBe(true);

    getWindowForTest().desktopBridge = {
      getWsUrl: () => "ws://127.0.0.1:3773/ws?token=local",
    } as unknown as DesktopBridge;
    expect(isRemoteDesktopConnection()).toBe(false);
  });

  it("creates the ws native api immediately when the Electron preload bridge exists", () => {
    getWindowForTest().desktopBridge = {
      getWsUrl: () => "ws://127.0.0.1:3000",
    } as unknown as DesktopBridge;

    expect(ensureNativeApi()).toEqual({ mocked: true });
  });

  it("creates the ws native api before hosted auth when bun dev provides a loopback ws url", () => {
    vi.stubEnv("VITE_WS_URL", "ws://localhost:3773");

    expect(ensureNativeApi()).toEqual({ mocked: true });
  });
});
