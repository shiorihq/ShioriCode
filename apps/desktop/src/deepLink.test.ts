import { describe, expect, it } from "vitest";

import {
  extractDesktopDeepLinkArg,
  normalizeDesktopDeepLink,
  resolveDesktopDeepLinkWindowUrl,
} from "./deepLink";

const SCHEME = "shioricode";

describe("deepLink", () => {
  it("extracts the first matching deep link argument", () => {
    expect(
      extractDesktopDeepLinkArg(
        [
          "/Applications/ShioriCode.app/Contents/MacOS/ShioriCode",
          "--flag",
          "shioricode://app/index.html#/welcome?status=success",
        ],
        SCHEME,
      ),
    ).toBe("shioricode://app/index.html#/welcome?status=success");
  });

  it("rejects unsupported deep link hosts and paths", () => {
    expect(
      normalizeDesktopDeepLink("shioricode://malicious/index.html#/welcome", SCHEME),
    ).toBeNull();
    expect(normalizeDesktopDeepLink("shioricode://app/secret.txt#/welcome", SCHEME)).toBeNull();
  });

  it("canonicalizes supported deep links", () => {
    expect(
      normalizeDesktopDeepLink(
        " shioricode://app/?code=test-code&state=test-state#/welcome?plan=pro ",
        SCHEME,
      ),
    ).toBe("shioricode://app/index.html?code=test-code&state=test-state#/welcome?plan=pro");
  });

  it("maps deep links back to the dev server in development", () => {
    expect(
      resolveDesktopDeepLinkWindowUrl({
        rawUrl: "shioricode://app/index.html?code=test-code#/welcome?status=success",
        scheme: SCHEME,
        isDevelopment: true,
        devServerUrl: "http://127.0.0.1:5733/",
      }),
    ).toBe("http://127.0.0.1:5733/?code=test-code#/welcome?status=success");
  });

  it("returns the packaged protocol URL outside development", () => {
    expect(
      resolveDesktopDeepLinkWindowUrl({
        rawUrl: "shioricode://app/index.html#/welcome?status=cancelled",
        scheme: SCHEME,
        isDevelopment: false,
      }),
    ).toBe("shioricode://app/index.html#/welcome?status=cancelled");
  });
});
