import "../../index.css";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ProviderKind,
  type ServerProviderModel,
  ThreadId,
} from "contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerPlusMenu } from "./ComposerPlusMenu";
import { useComposerDraftStore } from "../../composerDraftStore";

const CLAUDE_MODELS = [
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "max", label: "Max" },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
  {
    slug: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High", isDefault: true },
        { value: "max", label: "Max" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
] as const;

const CODEX_MODELS = [
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
] as const;

const GEMINI_MODELS = [
  {
    slug: "gemini-3-pro",
    name: "Gemini 3 Pro",
    isCustom: false,
    multiModal: false,
    capabilities: {
      reasoningEffortLevels: [],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
] as const;

const PROVIDER_KINDS = [
  "kimiCode",
  "gemini",
  "glm",
  "cursor",
  "codex",
  "claudeAgent",
] as const satisfies ReadonlyArray<ProviderKind>;

async function mountMenu(props?: { provider?: ProviderKind; model?: string; fastMode?: boolean }) {
  const threadId = ThreadId.makeUnsafe("thread-composer-plus-menu");
  const provider = props?.provider ?? "claudeAgent";
  const model =
    props?.model ??
    (provider === "claudeAgent"
      ? "claude-opus-4-6"
      : provider === "gemini"
        ? "gemini-3-pro"
        : provider === "codex"
          ? "gpt-5.4"
          : DEFAULT_MODEL_BY_PROVIDER[provider]);
  const models: ReadonlyArray<ServerProviderModel> =
    provider === "claudeAgent"
      ? CLAUDE_MODELS
      : provider === "gemini"
        ? GEMINI_MODELS
        : provider === "codex"
          ? CODEX_MODELS
          : [
              {
                slug: model,
                name: model,
                isCustom: false,
                capabilities: {
                  reasoningEffortLevels: [],
                  supportsFastMode: false,
                  supportsThinkingToggle: false,
                  contextWindowOptions: [],
                  promptInjectedEffortLevels: [],
                },
              },
            ];
  const modelOptions = props?.fastMode !== undefined ? { fastMode: props.fastMode } : undefined;
  const onToggleGoalMode = vi.fn();

  useComposerDraftStore.setState({
    draftsByThreadId: {
      [threadId]: {
        prompt: "",
        images: [],
        nonPersistedImageIds: [],
        persistedAttachments: [],
        terminalContexts: [],
        modelSelectionByProvider: {
          [provider]: {
            provider,
            model,
            ...(modelOptions ? { options: modelOptions } : {}),
          },
        },
        activeProvider: provider,
        runtimeMode: null,
        interactionMode: null,
      },
    },
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });

  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <ComposerPlusMenu
      threadId={threadId}
      provider={provider}
      models={models}
      model={model}
      modelOptions={modelOptions}
      planModeActive={false}
      onTogglePlanMode={vi.fn()}
      goalModeActive={false}
      onToggleGoalMode={onToggleGoalMode}
      onAddFiles={vi.fn()}
    />,
    { container: host },
  );

  return {
    onToggleGoalMode,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("ComposerPlusMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it.each(PROVIDER_KINDS)("keeps Shiori goal mode available for %s", async (provider) => {
    const mounted = await mountMenu({ provider });

    try {
      await page.getByRole("button", { name: "More options" }).click();
      const goalItem = page.getByRole("menuitemcheckbox", { name: "Goal" });

      await expect.element(goalItem).toBeEnabled();
      await goalItem.click();
      expect(mounted.onToggleGoalMode).toHaveBeenCalledOnce();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the updated Claude fast mode tradeoff copy", async () => {
    const mounted = await mountMenu();

    try {
      await page.getByRole("button", { name: "More options" }).click();
      await page.getByRole("menuitem", { name: "Speed" }).hover();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Default speed with normal credit usage");
        expect(text).toContain("About 2.5x faster, with credits used at 6x");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the original Codex fast mode tradeoff copy", async () => {
    const mounted = await mountMenu({ provider: "codex", model: "gpt-5.4" });

    try {
      await page.getByRole("button", { name: "More options" }).click();
      await page.getByRole("menuitem", { name: "Speed" }).hover();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Default speed with normal credit usage");
        expect(text).toContain("About 1.5x faster, with credits used at 2x");
        expect(text).not.toContain("About 2.5x faster, with credits used at 6x");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides Claude speed controls for models without fast mode support", async () => {
    const mounted = await mountMenu({ model: "claude-opus-4-7" });

    try {
      await page.getByRole("button", { name: "More options" }).click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").not.toContain("Speed");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("disables file attachments for models without multimodal support", async () => {
    const mounted = await mountMenu({ provider: "gemini", model: "gemini-3-pro" });

    try {
      await page.getByRole("button", { name: "More options" }).click();
      const addFilesItem = page.getByRole("menuitem", { name: /Add photos & files/i });

      await expect.element(addFilesItem).toHaveAttribute("data-disabled");
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Unsupported");
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
