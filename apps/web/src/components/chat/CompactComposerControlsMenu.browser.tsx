import { DEFAULT_MODEL_BY_PROVIDER, ModelSelection, ThreadId } from "contracts";
import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { TraitsMenuContent } from "./TraitsPicker";
import { useComposerDraftStore } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";

async function mountMenu(props?: { modelSelection?: ModelSelection; prompt?: string }) {
  const threadId = ThreadId.makeUnsafe("thread-compact-menu");
  const provider = props?.modelSelection?.provider ?? "claudeAgent";
  const draftsByThreadId = {} as ReturnType<
    typeof useComposerDraftStore.getState
  >["draftsByThreadId"];
  const model = props?.modelSelection?.model ?? DEFAULT_MODEL_BY_PROVIDER[provider];

  draftsByThreadId[threadId] = {
    prompt: props?.prompt ?? "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    modelSelectionByProvider: {
      [provider]: {
        provider,
        model,
        ...(props?.modelSelection?.options ? { options: props.modelSelection.options } : {}),
      },
    },
    activeProvider: provider,
    runtimeMode: null,
    interactionMode: null,
  };
  useComposerDraftStore.setState({
    draftsByThreadId,
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  const host = document.createElement("div");
  document.body.append(host);
  const onPromptChange = vi.fn();
  const onRuntimeModeChange = vi.fn();
  const providerOptions = props?.modelSelection?.options;
  const models =
    provider === "claudeAgent"
      ? [
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
                { value: "ultrathink", label: "Ultrathink" },
              ],
              supportsFastMode: true,
              supportsThinkingToggle: false,
              contextWindowOptions: [],
              promptInjectedEffortLevels: ["ultrathink"],
            },
          },
          {
            slug: "claude-haiku-4-5",
            name: "Claude Haiku 4.5",
            isCustom: false,
            capabilities: {
              reasoningEffortLevels: [],
              supportsFastMode: false,
              supportsThinkingToggle: true,
              contextWindowOptions: [],
              promptInjectedEffortLevels: [],
            },
          },
          {
            slug: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            isCustom: false,
            capabilities: {
              reasoningEffortLevels: [
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High", isDefault: true },
                { value: "ultrathink", label: "Ultrathink" },
              ],
              supportsFastMode: false,
              supportsThinkingToggle: false,
              contextWindowOptions: [],
              promptInjectedEffortLevels: ["ultrathink"],
            },
          },
        ]
      : [
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
        ];
  const caps = getProviderModelCapabilities(models, model, provider);
  const traitsMenuContent =
    caps.supportsThinkingToggle || caps.contextWindowOptions.length > 1 ? (
      <TraitsMenuContent
        provider={provider}
        models={models}
        threadId={threadId}
        model={model}
        prompt={props?.prompt ?? ""}
        modelOptions={providerOptions}
        onPromptChange={onPromptChange}
        includeEffort={false}
        includeFastMode={false}
      />
    ) : null;
  const screen = await render(
    <CompactComposerControlsMenu
      activePlan={false}
      planSidebarOpen={false}
      runtimeMode="approval-required"
      traitsMenuContent={traitsMenuContent}
      onTogglePlanSidebar={vi.fn()}
      onRuntimeModeChange={onRuntimeModeChange}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    onRuntimeModeChange,
  };
}

describe("CompactComposerControlsMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("keeps fast mode and effort out of the overflow menu", async () => {
    await using _ = await mountMenu({
      modelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).not.toContain("Fast Mode");
      expect(text).not.toContain("Effort");
    });
  });

  it("still hides fast mode controls for non-Opus Claude models", async () => {
    await using _ = await mountMenu({
      modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").not.toContain("Fast Mode");
    });
  });

  it("shows a Claude thinking on/off section for Haiku", async () => {
    await using _ = await mountMenu({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-haiku-4-5",
        options: { thinking: true },
      },
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Thinking");
      expect(text).toContain("On (default)");
      expect(text).toContain("Off");
      expect(text).toContain("Access");
      expect(text).toContain("Supervised");
      expect(text).toContain("Full access");
    });
  });

  it("lets compact overflow switch access mode when other controls are available", async () => {
    await using mounted = await mountMenu({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-haiku-4-5",
        options: { thinking: true },
      },
    });

    await page.getByLabelText("More composer controls").click();
    await page.getByRole("menuitemradio", { name: "Full access" }).click();

    expect(mounted.onRuntimeModeChange).toHaveBeenCalledWith("full-access");
  });

  it("does not render an overflow trigger when no compact-only controls are available", async () => {
    await using _ = await mountMenu({
      modelSelection: { provider: "codex", model: DEFAULT_MODEL_BY_PROVIDER.codex },
    });

    await expect.element(page.getByLabelText("More composer controls")).not.toBeInTheDocument();
  });
});
