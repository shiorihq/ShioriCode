import { describe, expect, it } from "vitest";

import { normalizeCustomUrl } from "./RemoteAccess";

describe("normalizeCustomUrl", () => {
  it("normalizes bare hosts to an https origin", () => {
    expect(normalizeCustomUrl("code.example.com")).toBe("https://code.example.com");
    expect(normalizeCustomUrl("  https://code.example.com/  ")).toBe("https://code.example.com");
  });

  it("keeps explicit ports and http scheme", () => {
    expect(normalizeCustomUrl("http://192.168.1.20:8443")).toBe("http://192.168.1.20:8443");
  });

  it("rejects empty, malformed, and non-http inputs", () => {
    expect(() => normalizeCustomUrl(undefined)).toThrow(/Enter the URL/);
    expect(() => normalizeCustomUrl("   ")).toThrow(/Enter the URL/);
    expect(() => normalizeCustomUrl("ftp://example.com")).toThrow(/must start with/);
    expect(() => normalizeCustomUrl("https://")).toThrow(/isn't a valid URL/);
  });

  it("rejects embedded credentials and subpaths", () => {
    expect(() => normalizeCustomUrl("https://user:pass@example.com")).toThrow(/username\/password/);
    expect(() => normalizeCustomUrl("https://example.com/code")).toThrow(/bare origin/);
    expect(() => normalizeCustomUrl("https://example.com/?q=1")).toThrow(/bare origin/);
  });
});
