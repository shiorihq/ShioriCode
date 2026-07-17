import { describe, expect, it } from "vitest";

import {
  extractDesktopDeepLinkArg,
  normalizeDesktopDeepLink,
  parseDesktopLinkAuthCallback,
  parseDesktopProjectDeepLink,
  resolveDesktopDeepLinkWindowUrl,
} from "./deepLink";

const SCHEME = "shioricode";
const DEV_SCHEME = "shioricode-dev";

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

  it("keeps development callbacks isolated from the production app", () => {
    expect(
      resolveDesktopDeepLinkWindowUrl({
        rawUrl:
          "shioricode-dev://app/index.html?link-auth=callback&state=state-1&token=access&refreshToken=refresh",
        scheme: DEV_SCHEME,
        isDevelopment: true,
        devServerUrl: "http://127.0.0.1:5733/",
      }),
    ).toBe(
      "http://127.0.0.1:5733/?link-auth=callback&state=state-1&token=access&refreshToken=refresh",
    );
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

  it("extracts link auth callbacks for main-process handling", () => {
    expect(
      parseDesktopLinkAuthCallback(
        "shioricode://app/index.html?link-auth=callback&state=state-1&token=access&refreshToken=refresh",
        SCHEME,
      ),
    ).toEqual({
      state: "state-1",
      token: "access",
      refreshToken: "refresh",
    });
  });

  it("rejects incomplete or ambiguous link auth callbacks", () => {
    expect(
      parseDesktopLinkAuthCallback(
        "shioricode://app/index.html?link-auth=callback&state=state-1&token=access",
        SCHEME,
      ),
    ).toBeNull();
    expect(
      parseDesktopLinkAuthCallback(
        "shioricode://app/index.html?link-auth=callback&state=one&state=two&error=denied",
        SCHEME,
      ),
    ).toBeNull();
  });

  it("extracts project navigation emitted by shioricode open", () => {
    expect(
      parseDesktopProjectDeepLink("shioricode://app/index.html#/?project=project%20one", SCHEME),
    ).toBe("project one");
    expect(
      parseDesktopProjectDeepLink("shioricode://app/index.html#/?project=one&project=two", SCHEME),
    ).toBeNull();
  });
});
