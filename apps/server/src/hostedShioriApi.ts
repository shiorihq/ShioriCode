const JWT_LIKE_TOKEN_PATTERN = /^[^.]+\.[^.]+\.[^.]+$/;

export function normalizeHostedShioriApiBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/+$/, "");
}

export function isHostedShioriAuthToken(token: string | null): token is string {
  return typeof token === "string" && JWT_LIKE_TOKEN_PATTERN.test(token.trim());
}

export function createHostedShioriHeaders(authToken: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Convex-Auth-Token": authToken,
    "X-Shiori-Client": "electron",
    "User-Agent": "ShioriCode-macOS/1.0",
  };
}
