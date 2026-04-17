const MCP_REFRESH_TOKEN_ERROR_PATTERNS = [
  "tokenrefreshfailed",
  "invalid refresh token",
  "invalid_grant",
] as const;

export function isMcpRefreshTokenDiagnosticMessage(message: string | null | undefined): boolean {
  const normalized = message?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (!normalized.includes("rmcp::transport::worker")) {
    return false;
  }

  return MCP_REFRESH_TOKEN_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}
