import { DEFAULT_MODEL_BY_PROVIDER, type ServerProvider } from "contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "contracts/settings";
import { describe, expect, it } from "vitest";

import { resolveConfigurableModelSelectionState } from "./modelSelection";

const providers: ReadonlyArray<ServerProvider> = [
  {
    provider: "gemini",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-04-04T10:00:00.000Z",
    models: [{ slug: "gemini-3-pro", name: "Gemini 3 Pro", isCustom: false, capabilities: null }],
  },
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-04-04T10:00:00.000Z",
    models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
  },
  {
    provider: "claudeAgent",
    enabled: false,
    installed: true,
    version: "1.0.0",
    status: "disabled",
    auth: { status: "authenticated" },
    checkedAt: "2026-04-04T10:00:00.000Z",
    models: [
      { slug: "claude-sonnet-5", name: "Claude Sonnet 5", isCustom: false, capabilities: null },
    ],
  },
] as const;

function makeSettings(overrides: Partial<UnifiedSettings> = {}): UnifiedSettings {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    ...overrides,
  };
}

describe("resolveConfigurableModelSelectionState", () => {
  it("keeps the selected model when the provider stays enabled", () => {
    const result = resolveConfigurableModelSelectionState(
      {
        provider: "codex",
        model: "gpt-5.4",
      },
      makeSettings(),
      providers,
    );

    expect(result).toEqual({
      provider: "codex",
      model: "gpt-5.4",
    });
  });

  it("falls back to the first enabled provider and its default model", () => {
    const result = resolveConfigurableModelSelectionState(
      {
        provider: "claudeAgent",
        model: "claude-sonnet-5",
      },
      makeSettings(),
      providers,
      {
        provider: "codex",
        model: DEFAULT_MODEL_BY_PROVIDER.codex,
      },
    );

    expect(result).toEqual({
      provider: "gemini",
      model: "gemini-3-pro",
    });
  });
});
