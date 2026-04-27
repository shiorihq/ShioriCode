import { describe, expect, it } from "vitest";

import {
  decodeHostedShioriAuthTokenClaims,
  hostedShioriAuthTokenMatchesConvexUrl,
  hostedShioriConvexSiteUrl,
  resolveHostedShioriConvexUrl,
} from "./hostedShioriConvex";

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function makeToken(payload: Record<string, unknown>): string {
  return `${encodeBase64UrlJson({ alg: "RS256" })}.${encodeBase64UrlJson(payload)}.signature`;
}

describe("hosted Shiori Convex helpers", () => {
  it("resolves Convex cloud URLs to their OIDC site issuer", () => {
    expect(hostedShioriConvexSiteUrl("https://modest-guanaco-471.convex.cloud")).toBe(
      "https://modest-guanaco-471.convex.site",
    );
    expect(hostedShioriConvexSiteUrl("https://cautious-puma-129.convex.site/")).toBe(
      "https://cautious-puma-129.convex.site",
    );
  });

  it("defaults hosted auth to production when no URL is configured", () => {
    expect(resolveHostedShioriConvexUrl("   ")).toBe("https://cautious-puma-129.convex.cloud");
  });

  it("uses the caller fallback when no URL is configured", () => {
    expect(resolveHostedShioriConvexUrl("   ", "https://modest-guanaco-471.convex.cloud")).toBe(
      "https://modest-guanaco-471.convex.cloud",
    );
  });

  it("decodes safe JWT claims without verifying or exposing token contents", () => {
    const token = makeToken({
      iss: "https://modest-guanaco-471.convex.site",
      aud: "convex",
      sub: "user|session",
      iat: 1,
      exp: 2,
    });

    expect(decodeHostedShioriAuthTokenClaims(token)).toEqual({
      iss: "https://modest-guanaco-471.convex.site",
      aud: "convex",
      sub: "user|session",
      iat: 1,
      exp: 2,
    });
  });

  it("rejects tokens minted for a different Convex deployment", () => {
    const prodToken = makeToken({
      iss: "https://cautious-puma-129.convex.site",
      aud: "convex",
    });

    expect(
      hostedShioriAuthTokenMatchesConvexUrl({
        token: prodToken,
        convexUrl: "https://modest-guanaco-471.convex.cloud",
      }),
    ).toBe(false);
  });
});
