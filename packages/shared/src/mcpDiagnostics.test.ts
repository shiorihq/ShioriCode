import { describe, expect, it } from "vitest";

import { isMcpRefreshTokenDiagnosticMessage } from "./mcpDiagnostics";

describe("isMcpRefreshTokenDiagnosticMessage", () => {
  it("matches revoked or invalid MCP refresh token diagnostics", () => {
    expect(
      isMcpRefreshTokenDiagnosticMessage(
        '2026-04-11T18:23:36.330237Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Auth(TokenRefreshFailed("Server returned error response: invalid_grant: Invalid refresh token"))',
      ),
    ).toBe(true);
  });

  it("ignores unrelated stderr warnings", () => {
    expect(
      isMcpRefreshTokenDiagnosticMessage("The filename or extension is too long. (os error 206)"),
    ).toBe(false);
  });
});
