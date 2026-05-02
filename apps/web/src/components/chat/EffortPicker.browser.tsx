import "../../index.css";

import {
  type ClaudeModelOptions,
  type CodexModelOptions,
  type ShioriModelOptions,
  ThreadId,
} from "contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { EffortPicker } from "./TraitsPicker";
import { useComposerDraftStore } from "../../composerDraftStore";

const TEST_MODELS = {
  codex: [
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
  ],
  claudeAgent: [
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
  ],
  shiori: [
    {
      slug: "openai/gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      capabilities: {
        reasoningEffortLevels: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium", isDefault: true },
          { value: "high", label: "High" },
        ],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        contextWindowOptions: [],
        promptInjectedEffortLevels: [],
      },
    },
  ],
} as const;

async function mountEffortPicker(props: {
  provider: "codex" | "claudeAgent" | "shiori";
  model: string;
  prompt?: string;
  options?: ClaudeModelOptions | CodexModelOptions | ShioriModelOptions;
}) {
  const threadId = ThreadId.makeUnsafe(`thread-effort-${props.provider}`);
  useComposerDraftStore.setState({
    draftsByThreadId: {
      [threadId]: {
        prompt: props.prompt ?? "",
        images: [],
        nonPersistedImageIds: [],
        persistedAttachments: [],
        terminalContexts: [],
        modelSelectionByProvider: {
          [props.provider]: {
            provider: props.provider,
            model: props.model,
            ...(props.options ? { options: props.options } : {}),
          },
        },
        activeProvider: props.provider,
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
    <EffortPicker
      provider={props.provider}
      models={TEST_MODELS[props.provider]}
      threadId={threadId}
      model={props.model}
      modelOptions={props.options}
      prompt={props.prompt ?? ""}
      onPromptChange={() => {}}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    threadId,
    [Symbol.asyncDispose]: cleanup,
    cleanup,
  };
}

describe("EffortPicker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("renders codex effort as a standalone picker without fast mode text", async () => {
    await using _ = await mountEffortPicker({
      provider: "codex",
      model: "gpt-5.4",
      options: { fastMode: true },
    });

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("High");
      expect(text).not.toContain("Fast");
    });

    await page.getByRole("button").click();

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toMatchObject({
      provider: "codex",
      options: {
        fastMode: true,
        reasoningEffort: "xhigh",
      },
    });
    expect(document.body.textContent ?? "").not.toContain("Fast Mode");
  });

  it("shows prompt-controlled ultrathink in the standalone picker", async () => {
    await using _ = await mountEffortPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      prompt: "Ultrathink:\nInvestigate this",
      options: { effort: "high", fastMode: true },
    });

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Ultrathink");
    });

    const button = page.getByRole("button", {
      name: "Intelligence: Ultrathink. Click to cycle.",
    });
    await expect.element(button).toBeDisabled();
    await expect.element(button).toHaveAttribute("title", "Ultrathink (controlled by prompt)");
    expect(document.body.textContent ?? "").not.toContain("Fast Mode");
  });

  it("persists sticky model options when the effort changes", async () => {
    await using _ = await mountEffortPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      options: { effort: "medium" },
    });

    await page.getByRole("button").click();

    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent,
    ).toMatchObject({
      provider: "claudeAgent",
      options: {
        effort: "high",
      },
    });
  });

  it("persists Shiori reasoning effort with the provider-specific option key", async () => {
    await using _ = await mountEffortPicker({
      provider: "shiori",
      model: "openai/gpt-5.4",
      options: { reasoningEffort: "medium" },
    });

    await page.getByRole("button").click();

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.shiori).toMatchObject({
      provider: "shiori",
      options: {
        reasoningEffort: "high",
      },
    });
  });

  it("cycles the effort without opening a selector", async () => {
    await using _ = await mountEffortPicker({
      provider: "shiori",
      model: "openai/gpt-5.4",
      options: { reasoningEffort: "medium" },
    });

    await page.getByRole("button").click();

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.shiori).toMatchObject({
      provider: "shiori",
      options: {
        reasoningEffort: "high",
      },
    });
    expect(document.body.textContent ?? "").not.toContain("Effort");
  });
});
