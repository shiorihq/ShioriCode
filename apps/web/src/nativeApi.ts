import type { NativeApi } from "contracts";

import { __resetWsNativeApiForTests, createWsNativeApi } from "./wsNativeApi";

let cachedApi: NativeApi | undefined;
let webConnectGateOpen = false;

export function hasDesktopNativeBridge(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return window.nativeApi !== undefined || window.desktopBridge !== undefined;
}

/**
 * Opens (or closes) the gate that allows the web build to create the WebSocket
 * native-API client. Kept closed until the user is authenticated so we don't
 * hammer the server with 403-bound handshakes on the sign-in screen.
 */
export function setNativeApiWebConnectGate(open: boolean) {
  webConnectGateOpen = open;
}

export function readNativeApi(): NativeApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  if (window.nativeApi) {
    cachedApi = window.nativeApi;
    return cachedApi;
  }

  if (!webConnectGateOpen) return undefined;

  cachedApi = createWsNativeApi();
  return cachedApi;
}

export function ensureNativeApi(): NativeApi {
  const api = readNativeApi();
  if (!api) {
    throw new Error("Native API not found");
  }
  return api;
}

export function __resetNativeApiForTests() {
  cachedApi = undefined;
  webConnectGateOpen = false;
  __resetWsNativeApiForTests();
}
