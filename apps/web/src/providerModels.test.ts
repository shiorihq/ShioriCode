import type { ProviderKind, ServerProvider } from "contracts";
import { describe, expect, it } from "vitest";

import { getProviderUnavailableReason } from "./providerModels";

function buildProvider(
  provider: ProviderKind,
  overrides?: Partial<ServerProvider>,
): ServerProvider {
  return {
    provider,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-04-11T21:22:00.000Z",
    models: [],
    ...overrides,
  };
}

describe("getProviderUnavailableReason", () => {
  it("returns null when the provider is ready", () => {
    expect(getProviderUnavailableReason([buildProvider("shiori")], "shiori")).toBeNull();
  });

  it("returns the provider message when the provider is warning", () => {
    expect(
      getProviderUnavailableReason(
        [
          buildProvider("shiori", {
            status: "warning",
            message: "ShioriCode requires an active paid Shiori subscription.",
          }),
        ],
        "shiori",
      ),
    ).toBe("ShioriCode requires an active paid Shiori subscription.");
  });

  it("returns a default disabled message when the provider is disabled", () => {
    expect(
      getProviderUnavailableReason(
        [
          buildProvider("claudeAgent", {
            enabled: false,
            status: "disabled",
          }),
        ],
        "claudeAgent",
      ),
    ).toBe("Claude is disabled in settings.");
  });

  it("returns a default unavailable message for errors without a specific message", () => {
    expect(
      getProviderUnavailableReason(
        [
          buildProvider("codex", {
            status: "error",
          }),
        ],
        "codex",
      ),
    ).toBe("Codex provider is unavailable.");
  });
});
