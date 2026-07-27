import { type ProviderKind, type ProviderModelOptions, type ServerProvider } from "contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProviderModelPicker } from "./ProviderModelPicker";
import { getCustomModelOptionsByProvider } from "../../modelSelection";
import { DEFAULT_UNIFIED_SETTINGS } from "contracts/settings";

function effort(value: string, isDefault = false) {
  return {
    value,
    label: value,
    ...(isDefault ? { isDefault: true } : {}),
  };
}

const TEST_PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models: [
      {
        slug: "gpt-5-codex",
        name: "GPT-5 Codex",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
      {
        slug: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
  },
  {
    provider: "claudeAgent",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models: [
      {
        slug: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            effort("low"),
            effort("medium", true),
            effort("high"),
            effort("max"),
          ],
          supportsFastMode: true,
          supportsThinkingToggle: true,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
      {
        slug: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            effort("low"),
            effort("medium", true),
            effort("high"),
            effort("max"),
          ],
          supportsFastMode: false,
          supportsThinkingToggle: true,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
      {
        slug: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
          supportsFastMode: false,
          supportsThinkingToggle: true,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
  },
];

function buildCodexProvider(models: ServerProvider["models"]): ServerProvider {
  return {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models,
  };
}

function buildKimiCodeProvider(models: ServerProvider["models"]): ServerProvider {
  return {
    provider: "kimiCode",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models,
  };
}

async function mountPicker(props: {
  provider: ProviderKind;
  model: string;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProvider>;
  modelOptions?: { fastMode?: boolean };
  onModelOptionsChange?: (nextOptions: ProviderModelOptions[ProviderKind] | undefined) => void;
  effort?: {
    value: string;
    label: string;
    levels: ReadonlyArray<{ value: string; label: string; isDefault?: boolean | undefined }>;
    onChange: (value: string) => void;
    locked?: boolean;
  } | null;
  compact?: boolean;
  triggerVariant?: "ghost" | "outline";
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const onProviderModelChange = vi.fn();
  const providers = props.providers ?? TEST_PROVIDERS;
  const modelOptionsByProvider = getCustomModelOptionsByProvider(
    DEFAULT_UNIFIED_SETTINGS,
    providers,
    props.provider,
    props.model,
  );
  const screen = await render(
    <ProviderModelPicker
      provider={props.provider}
      model={props.model}
      lockedProvider={props.lockedProvider}
      providers={providers}
      modelOptionsByProvider={modelOptionsByProvider}
      modelOptions={props.modelOptions}
      {...(props.effort !== undefined ? { effort: props.effort } : {})}
      {...(props.onModelOptionsChange !== undefined
        ? { onModelOptionsChange: props.onModelOptionsChange }
        : {})}
      {...(props.compact !== undefined ? { compact: props.compact } : {})}
      {...(props.triggerVariant !== undefined ? { triggerVariant: props.triggerVariant } : {})}
      onProviderModelChange={onProviderModelChange}
    />,
    { container: host },
  );

  return {
    onProviderModelChange,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("ProviderModelPicker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows provider submenus when provider switching is allowed", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Model");
      });
      await page.getByRole("menuitem", { name: "Model" }).hover();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Codex");
        expect(text).toContain("Claude");
        expect(text).not.toContain("Claude Sonnet 5");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the effort slider above the fast-mode switch and updates model options", async () => {
    const onModelOptionsChange = vi.fn();
    const onEffortChange = vi.fn();
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
      modelOptions: { fastMode: false },
      onModelOptionsChange,
      effort: {
        value: "high",
        label: "High",
        levels: [effort("low"), effort("medium"), effort("high", true), effort("max")],
        onChange: onEffortChange,
      },
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        const effortIndex = text.indexOf("Faster");
        const fastModeIndex = text.indexOf("Fast mode");
        expect(effortIndex).toBeGreaterThanOrEqual(0);
        expect(fastModeIndex).toBeGreaterThanOrEqual(0);
        expect(effortIndex).toBeLessThan(fastModeIndex);
      });

      await page.getByRole("radio", { name: "max", exact: true }).click();
      expect(onEffortChange).toHaveBeenCalledWith("max");

      await page.getByRole("menuitemcheckbox", { name: "Fast mode" }).click();

      expect(onModelOptionsChange).toHaveBeenCalledWith({ fastMode: true });
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens provider submenus with a visible gap from the parent menu", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitem", { name: "Model" }).hover();
      const providerTrigger = page.getByRole("menuitem", { name: "Codex" });
      await providerTrigger.hover();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("GPT-5 Codex");
      });

      const providerTriggerElement = Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).find((element) => element.textContent?.includes("Codex"));
      if (!providerTriggerElement) {
        throw new Error("Expected the Codex provider trigger to be mounted.");
      }

      const providerTriggerRect = providerTriggerElement.getBoundingClientRect();
      const modelElement = Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
      ).find((element) => element.textContent?.includes("GPT-5 Codex"));
      if (!modelElement) {
        throw new Error("Expected the submenu model option to be mounted.");
      }

      const submenuPopup = modelElement.closest('[data-slot="menu-sub-content"]');
      if (!(submenuPopup instanceof HTMLElement)) {
        throw new Error("Expected submenu popup to be mounted.");
      }

      const submenuRect = submenuPopup.getBoundingClientRect();

      expect(submenuRect.left).toBeGreaterThanOrEqual(providerTriggerRect.right);
      expect(submenuRect.left - providerTriggerRect.right).toBeGreaterThanOrEqual(2);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps extra right inset after the chevron in compact mode", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
      compact: true,
    });

    try {
      const trigger = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (element) => element.dataset.chatProviderModelPicker === "true",
      );
      if (!trigger) {
        throw new Error("Expected the provider model picker trigger to be mounted.");
      }

      const chevron = trigger.querySelector<SVGElement>(
        '[data-chat-provider-model-picker-chevron="true"]',
      );
      if (!chevron) {
        throw new Error("Expected the provider model picker chevron to be mounted.");
      }

      const triggerRect = trigger.getBoundingClientRect();
      const chevronRect = chevron.getBoundingClientRect();

      expect(triggerRect.right - chevronRect.right).toBeGreaterThanOrEqual(10);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the provider icon and chevron visible in regular mode", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      const trigger = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (element) => element.dataset.chatProviderModelPicker === "true",
      );
      if (!trigger) {
        throw new Error("Expected the provider model picker trigger to be mounted.");
      }

      const providerIcon = trigger.querySelector<SVGElement>(
        '[data-chat-provider-model-picker-provider-icon="true"]',
      );
      const chevron = trigger.querySelector<SVGElement>(
        '[data-chat-provider-model-picker-chevron="true"]',
      );
      if (!providerIcon || !chevron) {
        throw new Error("Expected the provider icon and chevron to be mounted.");
      }

      expect(providerIcon.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(chevron.getBoundingClientRect().width).toBeGreaterThan(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it.skip("shows a fast-mode icon and reveals the provider icon on hover", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      modelOptions: { fastMode: true },
    });

    try {
      const trigger = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (element) => element.dataset.chatProviderModelPicker === "true",
      );
      if (!trigger) {
        throw new Error("Expected the provider model picker trigger to be mounted.");
      }

      const fastIcon = trigger.querySelector<SVGElement>(
        '[data-chat-provider-model-picker-fast-icon="true"]',
      );
      const providerIcon = trigger.querySelector<SVGElement>(
        '[data-chat-provider-model-picker-provider-icon="true"]',
      );
      if (!fastIcon || !providerIcon) {
        throw new Error("Expected both the fast icon and provider icon to be mounted.");
      }

      expect(window.getComputedStyle(fastIcon).opacity).toBe("1");
      expect(window.getComputedStyle(providerIcon).opacity).toBe("0");

      await page.getByRole("button").hover();

      await vi.waitFor(() => {
        expect(window.getComputedStyle(fastIcon).opacity).toBe("0");
        expect(window.getComputedStyle(providerIcon).opacity).toBe("1");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows locked-provider models in the model submenu without provider switching", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitem", { name: "Model" }).hover();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Sonnet 5");
        expect(text).toContain("Claude Haiku 4.5");
        expect(text).not.toContain("Codex");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides search when a non-kimiCode provider is locked", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitem", { name: "Model" }).hover();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Claude Sonnet 5");
      });
      expect(document.querySelector('input[placeholder="Search models…"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows search when the kimiCode provider is locked", async () => {
    const mounted = await mountPicker({
      provider: "kimiCode",
      model: "openai/gpt-5",
      lockedProvider: "kimiCode",
      providers: [
        buildKimiCodeProvider([
          {
            slug: "openai/gpt-5",
            name: "GPT-5",
            isCustom: false,
            capabilities: {
              reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
              supportsFastMode: false,
              supportsThinkingToggle: true,
              contextWindowOptions: [],
              promptInjectedEffortLevels: [],
            },
          },
          {
            slug: "anthropic/claude-sonnet-4-5",
            name: "Claude Sonnet 4.5",
            isCustom: false,
            capabilities: {
              reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
              supportsFastMode: false,
              supportsThinkingToggle: true,
              contextWindowOptions: [],
              promptInjectedEffortLevels: [],
            },
          },
          {
            slug: "google/gemini-2.5-pro",
            name: "Gemini 2.5 Pro",
            isCustom: false,
            capabilities: {
              reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
              supportsFastMode: false,
              supportsThinkingToggle: true,
              contextWindowOptions: [],
              promptInjectedEffortLevels: [],
            },
          },
        ]),
      ],
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitem", { name: "Model" }).hover();

      await vi.waitFor(() => {
        expect(document.querySelector('input[placeholder="Search models…"]')).not.toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("only shows codex spark when the server reports it for the account", async () => {
    const providersWithoutSpark: ReadonlyArray<ServerProvider> = [
      buildCodexProvider([
        {
          slug: "gpt-5.3-codex",
          name: "GPT-5.3 Codex",
          isCustom: false,
          capabilities: {
            reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
            supportsFastMode: true,
            supportsThinkingToggle: false,
            contextWindowOptions: [],
            promptInjectedEffortLevels: [],
          },
        },
      ]),
      TEST_PROVIDERS[1]!,
    ];
    const providersWithSpark: ReadonlyArray<ServerProvider> = [
      buildCodexProvider([
        {
          slug: "gpt-5.3-codex",
          name: "GPT-5.3 Codex",
          isCustom: false,
          capabilities: {
            reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
            supportsFastMode: true,
            supportsThinkingToggle: false,
            contextWindowOptions: [],
            promptInjectedEffortLevels: [],
          },
        },
        {
          slug: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          isCustom: false,
          capabilities: {
            reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
            supportsFastMode: true,
            supportsThinkingToggle: false,
            contextWindowOptions: [],
            promptInjectedEffortLevels: [],
          },
        },
      ]),
      TEST_PROVIDERS[1]!,
    ];

    const hidden = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
      providers: providersWithoutSpark,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitem", { name: "Model" }).hover();
      await page.getByRole("menuitem", { name: "Codex" }).hover();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("GPT-5.3 Codex");
        expect(text).not.toContain("GPT-5.3 Codex Spark");
      });
    } finally {
      await hidden.cleanup();
    }

    const visible = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
      providers: providersWithSpark,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitem", { name: "Model" }).hover();
      await page.getByRole("menuitem", { name: "Codex" }).hover();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("GPT-5.3 Codex Spark");
      });
    } finally {
      await visible.cleanup();
    }
  });

  it("dispatches the canonical slug when a model is selected", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitem", { name: "Model" }).hover();
      await page.getByRole("menuitemradio", { name: "Claude Sonnet 5" }).click();

      expect(mounted.onProviderModelChange).toHaveBeenCalledWith("claudeAgent", "claude-sonnet-5");
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides disabled providers from provider switching", async () => {
    const disabledProviders = TEST_PROVIDERS.slice();
    const claudeIndex = disabledProviders.findIndex(
      (provider) => provider.provider === "claudeAgent",
    );
    if (claudeIndex >= 0) {
      const claudeProvider = disabledProviders[claudeIndex]!;
      disabledProviders[claudeIndex] = {
        ...claudeProvider,
        enabled: false,
        status: "disabled",
      };
    }
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      providers: disabledProviders,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitem", { name: "Model" }).hover();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Codex");
        expect(text).not.toContain("Claude");
        expect(text).not.toContain("Disabled");
        expect(text).not.toContain("Claude Sonnet 5");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps warning providers selectable while showing a checking badge", async () => {
    const warningProviders = TEST_PROVIDERS.slice();
    const claudeIndex = warningProviders.findIndex(
      (provider) => provider.provider === "claudeAgent",
    );
    if (claudeIndex >= 0) {
      const claudeProvider = warningProviders[claudeIndex]!;
      warningProviders[claudeIndex] = {
        ...claudeProvider,
        status: "warning",
        message: "Checking Claude CLI availability...",
      };
    }

    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      providers: warningProviders,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitem", { name: "Model" }).hover();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude");
        expect(text).toContain("Checking");
        expect(text).not.toContain("Unavailable");
      });

      await page.getByRole("menuitem", { name: /Claude/ }).hover();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Claude Sonnet 5");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("accepts outline trigger styling", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      triggerVariant: "outline",
    });

    try {
      const button = document.querySelector("button");
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("Expected picker trigger button to be rendered.");
      }
      expect(button.className).toContain("border-edge");
      expect(button.className).toContain("bg-transparent");
    } finally {
      await mounted.cleanup();
    }
  });
});
