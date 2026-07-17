import { describe, expect, it } from "vitest";

import {
  desktopRemoteWsUrl,
  normalizeDesktopRemoteUrl,
  rememberDesktopRemote,
} from "./remoteConnection";

describe("desktop remote connection URLs", () => {
  it("normalizes link hostnames to a safe HTTPS origin", () => {
    expect(normalizeDesktopRemoteUrl("sc-example.link.shiori.codes/thread?id=1")).toBe(
      "https://sc-example.link.shiori.codes/",
    );
  });

  it("rejects insecure public and credential-bearing URLs", () => {
    expect(normalizeDesktopRemoteUrl("http://example.com")).toBeNull();
    expect(normalizeDesktopRemoteUrl("https://user:secret@example.com")).toBeNull();
  });

  it("permits HTTP loopback only when explicitly enabled for development", () => {
    expect(normalizeDesktopRemoteUrl("http://127.0.0.1:3773")).toBeNull();
    expect(
      normalizeDesktopRemoteUrl("http://127.0.0.1:3773", { allowInsecureLoopback: true }),
    ).toBe("http://127.0.0.1:3773/");
  });

  it("derives the remote WebSocket endpoint", () => {
    expect(desktopRemoteWsUrl("https://sc-example.link.shiori.codes/")).toBe(
      "wss://sc-example.link.shiori.codes/ws",
    );
  });

  it("keeps recent remotes unique and newest first", () => {
    expect(
      rememberDesktopRemote(
        ["https://one.example/", "https://two.example/"],
        "https://two.example/",
      ),
    ).toEqual(["https://two.example/", "https://one.example/"]);
  });
});
