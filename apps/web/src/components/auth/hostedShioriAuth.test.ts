import { describe, expect, it } from "vitest";

import {
  resolveHostedShioriRedirectTarget,
  toHostedShioriAuthErrorMessage,
  withHostedShioriRedirect,
} from "./hostedShioriAuth";

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
