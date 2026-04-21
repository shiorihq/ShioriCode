import type { NativeApi } from "contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hostedOAuthStartMock = vi.fn();
const hostedPasswordAuthMock = vi.fn();
const setShioriAuthTokenMock = vi.fn();
const openExternalMock = vi.fn();

const mockApi = {
  server: {
    hostedOAuthStart: hostedOAuthStartMock,
    hostedPasswordAuth: hostedPasswordAuthMock,
    setShioriAuthToken: setShioriAuthTokenMock,
  },
  shell: {
    openExternal: openExternalMock,
  },
} as unknown as Pick<NativeApi, "server" | "shell">;

vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => mockApi,
}));

import {
  resolveHostedShioriDesktopRedirectTarget,
  resolveHostedShioriRedirectTarget,
  signInWithHostedOAuthDesktop,
  toHostedShioriAuthErrorMessage,
  withHostedShioriRedirect,
} from "./hostedShioriAuth";
import { convexDeploymentUrl, convexStorageKey } from "../../convex/config";

const localStorageState = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => localStorageState.get(key) ?? null,
  setItem: (key: string, value: string) => {
    localStorageState.set(key, value);
  },
  removeItem: (key: string) => {
    localStorageState.delete(key);
  },
  clear: () => {
    localStorageState.clear();
  },
};

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: localStorageMock },
    configurable: true,
    writable: true,
  });
  localStorageMock.clear();
  hostedOAuthStartMock.mockReset();
  hostedPasswordAuthMock.mockReset();
  setShioriAuthTokenMock.mockReset();
  openExternalMock.mockReset();
});

describe("toHostedShioriAuthErrorMessage", () => {
  it("maps leaked invalid-secret errors to a friendly password message", () => {
    expect(toHostedShioriAuthErrorMessage(new Error("InvalidSecret"))).toBe(
      "Invalid email or password. Please try again.",
    );
    expect(toHostedShioriAuthErrorMessage("Server Error\nUncaught Error: InvalidSecret")).toBe(
      "Invalid email or password. Please try again.",
    );
  });

  it("maps rate-limit errors to a friendly retry message", () => {
    expect(toHostedShioriAuthErrorMessage(new Error("TooManyFailedAttempts"))).toBe(
      "Too many failed sign-in attempts. Please wait a moment and try again.",
    );
  });

  it("preserves other useful auth messages", () => {
    expect(
      toHostedShioriAuthErrorMessage(
        new Error("Temporary or disposable email addresses are not allowed"),
      ),
    ).toBe("Temporary or disposable email addresses are not allowed");
  });

  it("sanitizes leaked server stack traces for disposable email validation", () => {
    expect(
      toHostedShioriAuthErrorMessage(
        "Server Error\nUncaught Error: Temporary or disposable email addresses are not allowed at profile [as profile] (../../convex/auth.ts:167:12)\nCalled by client",
      ),
    ).toBe("Temporary or disposable email addresses are not allowed");
  });

  it("strips framework noise from unexpected server errors", () => {
    expect(
      toHostedShioriAuthErrorMessage(
        "Server Error\nUncaught Error: Something went wrong\n    at handler (/tmp/file.ts:1:1)",
      ),
    ).toBe("Something went wrong");
  });
});

describe("withHostedShioriRedirect", () => {
  it("adds the current location when one is available", () => {
    expect(
      withHostedShioriRedirect({ flow: "signIn" }, "shioricode://app/index.html#/settings"),
    ).toEqual({
      flow: "signIn",
      redirectTo: "shioricode://app/index.html#/settings",
    });
  });

  it("omits redirectTo when the location is blank", () => {
    expect(withHostedShioriRedirect({ flow: "signIn" }, "   ")).toEqual({ flow: "signIn" });
    expect(resolveHostedShioriRedirectTarget(undefined)).toBeUndefined();
  });
});

describe("resolveHostedShioriDesktopRedirectTarget", () => {
  it("converts the dev server URL to the desktop callback scheme", () => {
    expect(
      resolveHostedShioriDesktopRedirectTarget(
        "http://127.0.0.1:5733/?auth=signUp#/settings/account",
      ),
    ).toBe("shioricode://app/index.html?auth=signUp#/settings/account");
  });

  it("canonicalizes packaged desktop callback URLs", () => {
    expect(
      resolveHostedShioriDesktopRedirectTarget(
        " shioricode://app/index.html?auth=forgot#/settings/account ",
      ),
    ).toBe("shioricode://app/index.html?auth=forgot#/settings/account");
  });

  it("rejects missing or malformed callback locations", () => {
    expect(resolveHostedShioriDesktopRedirectTarget(undefined)).toBeUndefined();
    expect(resolveHostedShioriDesktopRedirectTarget("not a url")).toBeUndefined();
  });
});

describe("signInWithHostedOAuthDesktop", () => {
  it("stores the verifier and opens the provider redirect externally", async () => {
    hostedOAuthStartMock.mockResolvedValue({
      redirect: "https://accounts.example.test/oauth/start",
      verifier: "desktop-verifier",
    });

    await signInWithHostedOAuthDesktop({
      provider: "google",
      currentLocationHref: "http://127.0.0.1:5733/?auth=signIn#/settings/account",
    });

    expect(hostedOAuthStartMock).toHaveBeenCalledWith({
      provider: "google",
      redirectTo: "shioricode://app/index.html?auth=signIn#/settings/account",
    });
    expect(openExternalMock).toHaveBeenCalledWith("https://accounts.example.test/oauth/start");
    expect(
      window.localStorage.getItem(
        convexStorageKey("__convexAuthOAuthVerifier", convexDeploymentUrl),
      ),
    ).toBe("desktop-verifier");
  });

  it("fails fast when the desktop callback location is unavailable", async () => {
    await expect(
      signInWithHostedOAuthDesktop({
        provider: "github",
        currentLocationHref: "   ",
      }),
    ).rejects.toThrow("Unable to determine the desktop OAuth callback URL.");
    expect(hostedOAuthStartMock).not.toHaveBeenCalled();
  });
});
