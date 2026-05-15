import type { NativeApi } from "contracts";

import { __resetWsNativeApiForTests, createWsNativeApi } from "./wsNativeApi";

let cachedApi: NativeApi | undefined;
let webConnectGateOpen = false;

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function hasLoopbackWebSocketUrl(): boolean {
  const rawUrl = (import.meta.env.VITE_WS_URL as string | undefined)?.trim();
  if (!rawUrl) {
    return false;
  }

  try {
    return isLoopbackHostname(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

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

  // In the packaged desktop app the Electron preload bridge is available
  // immediately, so the WS-backed native API should also be available
  // immediately. The auth gate only matters for the pure web build, where
  // opening the socket before auth would cause noisy 403 handshakes.
  if (window.desktopBridge) {
    cachedApi = createWsNativeApi();
    return cachedApi;
  }

  if (!webConnectGateOpen && !hasLoopbackWebSocketUrl()) return undefined;

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
