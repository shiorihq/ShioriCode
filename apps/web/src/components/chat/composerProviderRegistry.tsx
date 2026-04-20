import {
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProviderModel,
  type KimiCodeModelOptions,
  type ShioriModelOptions,
  type ThreadId,
  type ClaudeModelOptions,
  type CodexModelOptions,
} from "contracts";
import { isClaudeUltrathinkPrompt, resolveEffort } from "shared/model";
import type { ReactNode } from "react";
import { getProviderModelCapabilities } from "../../providerModels";
import { EffortPicker, TraitsMenuContent, TraitsPicker } from "./TraitsPicker";
import {
  normalizeClaudeModelOptionsWithCapabilities,
  normalizeCodexModelOptionsWithCapabilities,
  normalizeKimiCodeModelOptionsWithCapabilities,
  normalizeShioriModelOptionsWithCapabilities,
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
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
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
  const { provider, model, models, prompt, modelOptions } = input;
  const caps = getProviderModelCapabilities(models, model, provider);
  const providerOptions = modelOptions?.[provider];

  // Resolve effort
  const rawEffort = providerOptions
    ? "effort" in providerOptions
      ? providerOptions.effort
      : "reasoningEffort" in providerOptions
        ? providerOptions.reasoningEffort
        : null
    : null;

  const promptEffort = resolveEffort(caps, rawEffort) ?? null;

  // Normalize options for dispatch
  const normalizedOptions =
    provider === "shiori"
      ? normalizeShioriModelOptionsWithCapabilities(caps, providerOptions as ShioriModelOptions)
      : provider === "kimiCode"
        ? normalizeKimiCodeModelOptionsWithCapabilities(
            caps,
            providerOptions as KimiCodeModelOptions,
          )
        : provider === "codex"
          ? normalizeCodexModelOptionsWithCapabilities(caps, providerOptions as CodexModelOptions)
          : normalizeClaudeModelOptionsWithCapabilities(
              caps,
              providerOptions as ClaudeModelOptions,
            );

  // Ultrathink styling (driven by capabilities data, not provider identity)
  const ultrathinkActive =
    caps.promptInjectedEffortLevels.length > 0 && isClaudeUltrathinkPrompt(prompt);

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: normalizedOptions,
    ...(ultrathinkActive ? { composerFrameClassName: "ultrathink-frame" } : {}),
    ...(ultrathinkActive
      ? { composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset]" }
      : {}),
    ...(ultrathinkActive ? { modelPickerIconClassName: "ultrathink-chroma" } : {}),
  };
}

function hasAuxiliaryTraitControls(
  models: ReadonlyArray<ServerProviderModel>,
  model: string,
  provider: ProviderKind,
): boolean {
  const caps = getProviderModelCapabilities(models, model, provider);
  return caps.supportsThinkingToggle || caps.contextWindowOptions.length > 1;
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
  shiori: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      hasAuxiliaryTraitControls(models, model, "shiori") ? (
        <TraitsMenuContent
          provider="shiori"
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
      hasEffortControls(models, model, "shiori") ? (
        <EffortPicker
          provider="shiori"
          models={models}
          threadId={threadId}
          model={model}
          modelOptions={modelOptions}
          prompt={prompt}
          onPromptChange={onPromptChange}
        />
      ) : null,
    renderTraitsPicker: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      hasAuxiliaryTraitControls(models, model, "shiori") ? (
        <TraitsPicker
          provider="shiori"
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
  kimiCode: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      hasAuxiliaryTraitControls(models, model, "kimiCode") ? (
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
      hasAuxiliaryTraitControls(models, model, "kimiCode") ? (
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
  codex: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      hasAuxiliaryTraitControls(models, model, "codex") ? (
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
      hasAuxiliaryTraitControls(models, model, "codex") ? (
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
    renderTraitsMenuContent: ({ threadId, model, models, modelOptions, prompt, onPromptChange }) =>
      hasAuxiliaryTraitControls(models, model, "claudeAgent") ? (
        <TraitsMenuContent
          provider="claudeAgent"
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
      hasAuxiliaryTraitControls(models, model, "claudeAgent") ? (
        <TraitsPicker
          provider="claudeAgent"
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
}): ReactNode {
  return composerProviderRegistry[input.provider].renderTraitsMenuContent({
    threadId: input.threadId,
    model: input.model,
    models: input.models,
    modelOptions: input.modelOptions,
    prompt: input.prompt,
    onPromptChange: input.onPromptChange,
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
