import {
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProviderModel,
  type KimiCodeModelOptions,
  type ThreadId,
  type ClaudeModelOptions,
  type CodexModelOptions,
  type CursorModelOptions,
  type GlmModelOptions,
} from "contracts";
import { resolveEffort } from "shared/model";
import type { ReactNode } from "react";
import { getProviderModelCapabilities } from "../../providerModels";
import { EffortPicker, TraitsMenuContent, TraitsPicker } from "./TraitsPicker";
import {
  normalizeClaudeModelOptionsWithCapabilities,
  normalizeCodexModelOptionsWithCapabilities,
  normalizeCursorModelOptionsWithCapabilities,
  normalizeGlmModelOptionsWithCapabilities,
  normalizeKimiCodeModelOptionsWithCapabilities,
} from "shared/model";

export type ComposerProviderStateInput = {
  provider: ProviderKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  prompt: string;
  modelOptions: ProviderModelOptions | null | undefined;
};

export type ComposerProviderState = {
  provider: ProviderKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ProviderModelOptions[ProviderKind] | undefined;
};

type ProviderRegistryEntry = {
  getState: (input: ComposerProviderStateInput) => ComposerProviderState;
  renderTraitsMenuContent: (input: {
    threadId: ThreadId;
    model: string;
    models: ReadonlyArray<ServerProviderModel>;
    modelOptions: ProviderModelOptions[ProviderKind] | undefined;
    prompt: string;
    onPromptChange: (prompt: string) => void;
    includeFastMode: boolean;
  }) => ReactNode;
  renderEffortPicker: (input: {
    threadId: ThreadId;
    model: string;
    models: ReadonlyArray<ServerProviderModel>;
    modelOptions: ProviderModelOptions[ProviderKind] | undefined;
    prompt: string;
    onPromptChange: (prompt: string) => void;
  }) => ReactNode;
  renderTraitsPicker: (input: {
    threadId: ThreadId;
    model: string;
    models: ReadonlyArray<ServerProviderModel>;
    modelOptions: ProviderModelOptions[ProviderKind] | undefined;
    prompt: string;
    onPromptChange: (prompt: string) => void;
  }) => ReactNode;
};

function getProviderStateFromCapabilities(
  input: ComposerProviderStateInput,
): ComposerProviderState {
  const { provider, model, models, modelOptions } = input;
  const caps = getProviderModelCapabilities(models, model, provider);
  const providerOptions = modelOptions?.[provider];

  // Resolve effort
  const rawEffort = providerOptions
    ? "effort" in providerOptions
      ? providerOptions.effort
      : "reasoningEffort" in providerOptions
        ? providerOptions.reasoningEffort
        : "reasoning" in providerOptions
          ? providerOptions.reasoning
          : null
    : null;

  const promptEffort = resolveEffort(caps, rawEffort) ?? null;

  // Normalize options for dispatch
  const normalizedOptions =
    provider === "kimiCode"
      ? normalizeKimiCodeModelOptionsWithCapabilities(caps, providerOptions as KimiCodeModelOptions)
      : provider === "gemini"
        ? undefined
        : provider === "glm"
          ? normalizeGlmModelOptionsWithCapabilities(caps, providerOptions as GlmModelOptions)
          : provider === "cursor"
            ? normalizeCursorModelOptionsWithCapabilities(
                caps,
                providerOptions as CursorModelOptions,
              )
            : provider === "codex"
              ? normalizeCodexModelOptionsWithCapabilities(
                  caps,
                  providerOptions as CodexModelOptions,
                )
              : normalizeClaudeModelOptionsWithCapabilities(
                  caps,
                  providerOptions as ClaudeModelOptions,
                );

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: normalizedOptions,
  };
}

function hasAuxiliaryTraitControls(
  models: ReadonlyArray<ServerProviderModel>,
  model: string,
  provider: ProviderKind,
  options?: { includeFastMode?: boolean },
): boolean {
  const caps = getProviderModelCapabilities(models, model, provider);
  return (
    caps.supportsThinkingToggle ||
    caps.contextWindowOptions.length > 1 ||
    (options?.includeFastMode === true && caps.supportsFastMode)
  );
}

function hasEffortControls(
  models: ReadonlyArray<ServerProviderModel>,
  model: string,
  provider: ProviderKind,
): boolean {
  const caps = getProviderModelCapabilities(models, model, provider);
  return caps.reasoningEffortLevels.length > 0;
}

const composerProviderRegistry: Record<ProviderKind, ProviderRegistryEntry> = {
  kimiCode: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      hasAuxiliaryTraitControls(models, model, "kimiCode", { includeFastMode: false }) ? (
        <TraitsMenuContent
          provider="kimiCode"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
          includeEffort={false}
          includeFastMode={false}
        />
      ) : null,
    renderEffortPicker: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      hasEffortControls(models, model, "kimiCode") ? (
        <EffortPicker
          provider="kimiCode"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ) : null,
    renderTraitsPicker: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      hasAuxiliaryTraitControls(models, model, "kimiCode", { includeFastMode: false }) ? (
        <TraitsPicker
          provider="kimiCode"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
          includeEffort={false}
          includeFastMode={false}
        />
      ) : null,
  },
  gemini: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: () => null,
    renderEffortPicker: () => null,
    renderTraitsPicker: () => null,
  },
  glm: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      hasAuxiliaryTraitControls(models, model, "glm", { includeFastMode: false }) ? (
        <TraitsMenuContent
          provider="glm"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
          includeEffort={false}
          includeFastMode={false}
        />
      ) : null,
    renderEffortPicker: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      hasEffortControls(models, model, "glm") ? (
        <EffortPicker
          provider="glm"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ) : null,
    renderTraitsPicker: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      hasAuxiliaryTraitControls(models, model, "glm", { includeFastMode: false }) ? (
        <TraitsPicker
          provider="glm"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
          includeEffort={false}
          includeFastMode={false}
        />
      ) : null,
  },
  cursor: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({
      threadId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
      includeFastMode,
    }) =>
      hasAuxiliaryTraitControls(models, model, "cursor", { includeFastMode }) ? (
        <TraitsMenuContent
          provider="cursor"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
          includeEffort={false}
          includeFastMode={includeFastMode}
        />
      ) : null,
    renderEffortPicker: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      hasEffortControls(models, model, "cursor") ? (
        <EffortPicker
          provider="cursor"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ) : null,
    renderTraitsPicker: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      hasAuxiliaryTraitControls(models, model, "cursor", { includeFastMode: true }) ? (
        <TraitsPicker
          provider="cursor"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
          includeEffort={false}
          includeFastMode
        />
      ) : null,
  },
  codex: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      hasAuxiliaryTraitControls(models, model, "codex", { includeFastMode: false }) ? (
        <TraitsMenuContent
          provider="codex"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
          includeEffort={false}
          includeFastMode={false}
        />
      ) : null,
    renderEffortPicker: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      hasEffortControls(models, model, "codex") ? (
        <EffortPicker
          provider="codex"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ) : null,
    renderTraitsPicker: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      hasAuxiliaryTraitControls(models, model, "codex", { includeFastMode: false }) ? (
        <TraitsPicker
          provider="codex"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
          includeEffort={false}
          includeFastMode={false}
        />
      ) : null,
  },
  claudeAgent: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({
      threadId,
      model,
      models,
      modelOptions,
      prompt,
      onPromptChange,
      includeFastMode,
    }) =>
      hasAuxiliaryTraitControls(models, model, "claudeAgent", { includeFastMode }) ? (
        <TraitsMenuContent
          provider="claudeAgent"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
          includeEffort={false}
          includeFastMode={includeFastMode}
        />
      ) : null,
    renderEffortPicker: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      hasEffortControls(models, model, "claudeAgent") ? (
        <EffortPicker
          provider="claudeAgent"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ) : null,
    renderTraitsPicker: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      hasAuxiliaryTraitControls(models, model, "claudeAgent", { includeFastMode: true }) ? (
        <TraitsPicker
          provider="claudeAgent"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
          includeEffort={false}
          includeFastMode
        />
      ) : null,
  },
};

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  return composerProviderRegistry[input.provider].getState(input);
}

export function renderProviderTraitsMenuContent(input: {
  provider: ProviderKind;
  threadId: ThreadId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  includeFastMode?: boolean;
}): ReactNode {
  return composerProviderRegistry[input.provider].renderTraitsMenuContent({
    threadId: input.threadId,
    model: input.model,
    models: input.models,
    modelOptions: input.modelOptions,
    prompt: input.prompt,
    onPromptChange: input.onPromptChange,
    includeFastMode: input.includeFastMode ?? true,
  });
}

export function renderProviderTraitsPicker(input: {
  provider: ProviderKind;
  threadId: ThreadId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
}): ReactNode {
  return composerProviderRegistry[input.provider].renderTraitsPicker({
    threadId: input.threadId,
    model: input.model,
    models: input.models,
    modelOptions: input.modelOptions,
    prompt: input.prompt,
    onPromptChange: input.onPromptChange,
  });
}

export function renderProviderEffortPicker(input: {
  provider: ProviderKind;
  threadId: ThreadId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
}): ReactNode {
  return composerProviderRegistry[input.provider].renderEffortPicker({
    threadId: input.threadId,
    model: input.model,
    models: input.models,
    modelOptions: input.modelOptions,
    prompt: input.prompt,
    onPromptChange: input.onPromptChange,
  });
}
