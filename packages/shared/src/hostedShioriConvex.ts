export const HOSTED_SHIORI_PRODUCTION_CONVEX_URL = "https://cautious-puma-129.convex.cloud";
export const HOSTED_SHIORI_DEVELOPMENT_CONVEX_URL = "https://modest-guanaco-471.convex.cloud";

export function resolveHostedShioriConvexUrl(
  envUrl: string | null | undefined,
  fallbackUrl = HOSTED_SHIORI_PRODUCTION_CONVEX_URL,
): string {
  const trimmed = envUrl?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallbackUrl;
}

export interface HostedShioriAuthTokenClaims {
  readonly iss: string | null;
  readonly aud: string | null;
  readonly sub: string | null;
  readonly iat: number | null;
  readonly exp: number | null;
}

const JWT_LIKE_TOKEN_PATTERN = /^[^.]+\.[^.]+\.[^.]+$/;

function decodeBase64UrlJson(segment: string): Record<string, unknown> | null {
  try {
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const decoded =
      typeof Buffer !== "undefined" ? Buffer.from(padded, "base64").toString("utf8") : atob(padded);
    const value = JSON.parse(decoded) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function hostedShioriConvexSiteUrl(convexUrl: string): string | null {
  const trimmed = convexUrl.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.endsWith(".convex.cloud")) {
      url.hostname = url.hostname.replace(/\.convex\.cloud$/u, ".convex.site");
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

export function decodeHostedShioriAuthTokenClaims(
  token: string | null | undefined,
): HostedShioriAuthTokenClaims | null {
  const trimmed = token?.trim() ?? "";
  if (!JWT_LIKE_TOKEN_PATTERN.test(trimmed)) {
    return null;
  }

  const [, payloadSegment] = trimmed.split(".");
  if (!payloadSegment) {
    return null;
  }

  const payload = decodeBase64UrlJson(payloadSegment);
  if (!payload) {
    return null;
  }

  return {
    iss: typeof payload.iss === "string" ? payload.iss : null,
    aud: typeof payload.aud === "string" ? payload.aud : null,
    sub: typeof payload.sub === "string" ? payload.sub : null,
    iat: typeof payload.iat === "number" ? payload.iat : null,
    exp: typeof payload.exp === "number" ? payload.exp : null,
  };
}

export function hostedShioriAuthTokenMatchesConvexUrl(input: {
  readonly token: string | null | undefined;
  readonly convexUrl: string;
}): boolean {
  const expectedIssuer = hostedShioriConvexSiteUrl(input.convexUrl);
  const claims = decodeHostedShioriAuthTokenClaims(input.token);
  return expectedIssuer !== null && claims?.iss === expectedIssuer && claims.aud === "convex";
}
