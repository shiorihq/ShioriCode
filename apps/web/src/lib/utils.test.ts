import { afterEach, assert, describe, it } from "vitest";

import { isWindowsPlatform, resolveDataRouteUrl } from "./utils";

describe("isWindowsPlatform", () => {
  it("matches Windows platform identifiers", () => {
    assert.isTrue(isWindowsPlatform("Win32"));
    assert.isTrue(isWindowsPlatform("Windows"));
    assert.isTrue(isWindowsPlatform("windows_nt"));
  });

  it("does not match darwin", () => {
    assert.isFalse(isWindowsPlatform("darwin"));
  });
});

describe("resolveDataRouteUrl", () => {
  // The web test runner has no DOM, and `resolveServerUrl` eagerly reads
  // `window.desktopBridge?.getWsUrl()` and `window.location.origin`, so stub a
  // minimal window that models the desktop app carrying a `?token=` on its ws URL.
  const setWsUrl = (wsUrl: string | null) => {
    (globalThis as { window?: unknown }).window = {
      desktopBridge: { getWsUrl: () => wsUrl },
      location: { origin: "http://localhost", protocol: "http:" },
    };
  };

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("carries the WebSocket auth token onto the data-route URL and coerces ws→http", () => {
    setWsUrl("ws://127.0.0.1:50811/ws?token=SECRET");
    const url = new URL(resolveDataRouteUrl("/attachments/thread-abc"));
    assert.equal(url.protocol, "http:");
    assert.equal(url.host, "127.0.0.1:50811");
    assert.equal(url.pathname, "/attachments/thread-abc");
    assert.equal(url.searchParams.get("token"), "SECRET");
  });

  it("coerces wss→https", () => {
    setWsUrl("wss://remote.example.ts.net/ws?token=SECRET");
    const url = new URL(resolveDataRouteUrl("/attachments/thread-abc"));
    assert.equal(url.protocol, "https:");
    assert.equal(url.searchParams.get("token"), "SECRET");
  });

  it("merges extra params without clobbering the token", () => {
    setWsUrl("ws://127.0.0.1:50811/ws?token=SECRET");
    const url = new URL(resolveDataRouteUrl("/api/project-favicon", { cwd: "/Users/me/proj x" }));
    assert.equal(url.searchParams.get("token"), "SECRET");
    assert.equal(url.searchParams.get("cwd"), "/Users/me/proj x");
  });
});
