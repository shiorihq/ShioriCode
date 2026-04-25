import { describe, expect, it } from "vitest";
import type { ProviderKind, ServerProvider } from "contracts";

import {
  getVisibleProviderKinds,
  normalizeHiddenProviders,
  resolveVisibleSelectableProvider,
  setProviderVisibility,
} from "./providerVisibility";

function provider(provider: ProviderKind, enabled = true): ServerProvider {
  return {
    provider,
    enabled,
    installed: true,
    version: null,
    status: enabled ? "ready" : "disabled",
    auth: { status: "authenticated" },
    checkedAt: "2026-04-23T10:00:00.000Z",
    models: [],
  };
}

describe("providerVisibility", () => {
  it("normalizes duplicate hidden providers", () => {
    expect(normalizeHiddenProviders(["codex", "codex", "claudeAgent"])).toEqual([
      "codex",
      "claudeAgent",
    ]);
  });

  it("updates hidden providers in provider order", () => {
    expect(setProviderVisibility(["claudeAgent"], "codex", false)).toEqual([
      "codex",
      "claudeAgent",
    ]);
    expect(setProviderVisibility(["codex", "claudeAgent"], "codex", true)).toEqual(["claudeAgent"]);
  });

  it("falls back to all providers when every provider is hidden", () => {
    expect(
      getVisibleProviderKinds(["shiori", "kimiCode", "gemini", "cursor", "codex", "claudeAgent"]),
    ).toContain("codex");
  });

  it("resolves to the first visible enabled provider", () => {
    expect(
      resolveVisibleSelectableProvider(
        [provider("shiori"), provider("codex"), provider("claudeAgent")],
        "shiori",
        ["shiori"],
      ),
    ).toBe("codex");
  });
});
