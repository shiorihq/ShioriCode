import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchShioriCodeEntitlements } from "./shioriCodeEntitlements.ts";

describe("fetchShioriCodeEntitlements", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a deployment flag error when paid access is active but disabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              allowed: false,
              plan: "max",
              status: "active",
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await Effect.runPromise(
      fetchShioriCodeEntitlements({
        apiBaseUrl: "http://127.0.0.1:3000",
        authToken: "header.payload.signature",
      }),
    );

    expect(result).toEqual({
      entitlements: {
        allowed: false,
        plan: "max",
        status: "active",
      },
      message:
        "ShioriCode is disabled for this Shiori deployment. Enable the `code_enabled` feature flag in Convex.",
      authFailure: false,
    });
  });

  it("classifies auth-like 500 responses as auth failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "Internal server error",
              message:
                '{"code":"Unauthenticated","message":"Could not verify OIDC token claim. Check that the token signature is valid and the token hasn\'t expired."}',
            }),
            { status: 500 },
          ),
      ),
    );

    const result = await Effect.runPromise(
      fetchShioriCodeEntitlements({
        apiBaseUrl: "http://127.0.0.1:3000",
        authToken: "header.payload.signature",
      }),
    );

    expect(result).toEqual({
      entitlements: null,
      message: "Shiori account token is unavailable or expired. Sign out and sign back in.",
      authFailure: true,
    });
  });
});
