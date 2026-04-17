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
    });
  });
});
