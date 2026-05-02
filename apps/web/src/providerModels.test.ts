import { describe, expect, it } from "vitest";

import type { ProviderKind, ServerProvider, ServerProviderModel } from "contracts";

import {
  getProviderPickerState,
  getProviderUnavailableReason,
  getProviderModelDisplayName,
  isProviderDisabledSnapshot,
  isPendingProviderCheckStatus,
  providerModelSupportsImageAttachments,
} from "./providerModels";

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

  it("returns null while the provider is still being checked in the background", () => {
    expect(
      getProviderUnavailableReason(
        [
          buildProvider("codex", {
            status: "warning",
            message: "Checking Codex CLI availability...",
          }),
        ],
        "codex",
      ),
    ).toBeNull();
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

describe("isPendingProviderCheckStatus", () => {
  it("detects transient provider checking messages", () => {
    expect(
      isPendingProviderCheckStatus(
        buildProvider("codex", {
          status: "warning",
          message: "Checking Codex CLI availability...",
        }),
      ),
    ).toBe(true);
  });
});

describe("getProviderPickerState", () => {
  it("identifies disabled provider snapshots", () => {
    expect(isProviderDisabledSnapshot(buildProvider("codex"))).toBe(false);
    expect(
      isProviderDisabledSnapshot(
        buildProvider("codex", {
          enabled: false,
          status: "disabled",
        }),
      ),
    ).toBe(true);
  });

  it("keeps pending background checks selectable", () => {
    expect(
      getProviderPickerState(
        buildProvider("codex", {
          status: "warning",
          message: "Checking Codex CLI availability...",
        }),
      ),
    ).toEqual({
      selectable: true,
      badgeLabel: "Checking",
    });
  });

  it("disables blocking warnings in the picker", () => {
    expect(
      getProviderPickerState(
        buildProvider("shiori", {
          status: "warning",
          message: "ShioriCode requires an active paid Shiori subscription.",
        }),
      ),
    ).toEqual({
      selectable: false,
      badgeLabel: null,
    });
  });
});

describe("providerModelSupportsImageAttachments", () => {
  it("returns false when the selected model is explicitly non-multimodal", () => {
    const models: ServerProviderModel[] = [
      {
        slug: "zhipu/glm-5.1",
        name: "GLM-5.1",
        isCustom: false,
        multiModal: false,
        capabilities: null,
      },
    ];

    expect(providerModelSupportsImageAttachments(models, "zhipu/glm-5.1", "shiori")).toBe(false);
  });

  it("defaults to allowing attachments when capability metadata is missing", () => {
    const models: ServerProviderModel[] = [
      {
        slug: "openai/gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        capabilities: null,
      },
    ];

    expect(providerModelSupportsImageAttachments(models, "openai/gpt-5.4", "shiori")).toBe(true);
  });
});

describe("getProviderModelDisplayName", () => {
  it("prefers the resolved model display name", () => {
    const models: ServerProviderModel[] = [
      {
        slug: "zhipu/glm-5.1",
        name: "GLM-5.1",
        isCustom: false,
        multiModal: false,
        capabilities: null,
      },
    ];

    expect(getProviderModelDisplayName(models, "zhipu/glm-5.1", "shiori")).toBe("GLM-5.1");
  });
});
