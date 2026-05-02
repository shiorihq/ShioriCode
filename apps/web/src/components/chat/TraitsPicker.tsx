import {
  type ClaudeModelOptions,
  type CodexModelOptions,
  type CursorModelOptions,
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProviderModel,
  type ShioriModelOptions,
  type ThreadId,
} from "contracts";
import {
  applyClaudePromptEffortPrefix,
  isClaudeUltrathinkPrompt,
  trimOrNull,
  getDefaultEffort,
  getDefaultContextWindow,
  hasContextWindowOption,
  resolveEffort,
} from "shared/model";
import { Fragment, memo, useCallback, useState, type ReactNode } from "react";
import type { VariantProps } from "class-variance-authority";
import { ChevronDownIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import { cn } from "~/lib/utils";
import { playFastModeBlitz } from "./fastModeBlitzFx";

type ProviderOptions = ProviderModelOptions[ProviderKind];
type TraitsPersistence =
  | {
      threadId: ThreadId;
      onModelOptionsChange?: never;
    }
  | {
      threadId?: undefined;
      onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
    };

const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";

function getRawEffort(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
): string | null {
  if (provider === "codex") {
    return trimOrNull((modelOptions as CodexModelOptions | undefined)?.reasoningEffort);
  }
  if (provider === "shiori") {
    return trimOrNull((modelOptions as ShioriModelOptions | undefined)?.reasoningEffort);
  }
  if (provider === "cursor") {
    return trimOrNull((modelOptions as CursorModelOptions | undefined)?.reasoning);
  }
  return trimOrNull((modelOptions as ClaudeModelOptions | undefined)?.effort);
}

function getRawContextWindow(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
): string | null {
  if (provider === "claudeAgent") {
    return trimOrNull((modelOptions as ClaudeModelOptions | undefined)?.contextWindow);
  }
  if (provider === "cursor") {
    return trimOrNull((modelOptions as CursorModelOptions | undefined)?.contextWindow);
  }
  return null;
}

function buildNextOptions(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
  patch: Record<string, unknown>,
): ProviderOptions {
  if (provider === "codex") {
    return { ...(modelOptions as CodexModelOptions | undefined), ...patch } as CodexModelOptions;
  }
  if (provider === "shiori") {
    return { ...(modelOptions as ShioriModelOptions | undefined), ...patch } as ShioriModelOptions;
  }
  if (provider === "cursor") {
    return { ...(modelOptions as CursorModelOptions | undefined), ...patch } as CursorModelOptions;
  }
  return { ...(modelOptions as ClaudeModelOptions | undefined), ...patch } as ClaudeModelOptions;
}

function getSelectedTraits(
  provider: ProviderKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  prompt: string,
  modelOptions: ProviderOptions | null | undefined,
  allowPromptInjectedEffort: boolean,
) {
  const caps = getProviderModelCapabilities(models, model, provider);
  const effortLevels = allowPromptInjectedEffort
    ? caps.reasoningEffortLevels
    : caps.reasoningEffortLevels.filter(
        (option) => !caps.promptInjectedEffortLevels.includes(option.value),
      );

  // Resolve effort from options (provider-specific key)
  const rawEffort = getRawEffort(provider, modelOptions);
  const effort = resolveEffort(caps, rawEffort) ?? null;

  // Thinking toggle (only for models that support it)
  const thinkingEnabled = caps.supportsThinkingToggle
    ? provider === "shiori"
      ? ((modelOptions as ShioriModelOptions | undefined)?.thinking ?? false)
      : provider === "cursor"
        ? ((modelOptions as CursorModelOptions | undefined)?.thinking ?? false)
        : ((modelOptions as ClaudeModelOptions | undefined)?.thinking ?? true)
    : null;

  // Fast mode
  const fastModeEnabled =
    caps.supportsFastMode &&
    (modelOptions as { fastMode?: boolean } | undefined)?.fastMode === true;

  // Context window
  const contextWindowOptions = caps.contextWindowOptions;
  const rawContextWindow = getRawContextWindow(provider, modelOptions);
  const defaultContextWindow = getDefaultContextWindow(caps);
  const contextWindow =
    rawContextWindow && hasContextWindowOption(caps, rawContextWindow)
      ? rawContextWindow
      : defaultContextWindow;

  // Prompt-controlled effort (e.g. ultrathink in prompt text)
  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    caps.promptInjectedEffortLevels.length > 0 &&
    isClaudeUltrathinkPrompt(prompt);

  // Check if "ultrathink" appears in the body text (not just our prefix)
  const ultrathinkInBodyText =
    ultrathinkPromptControlled && isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));

  return {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
  };
}

export interface TraitsMenuContentProps {
  provider: ProviderKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  includeEffort?: boolean;
  includeFastMode?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
}

export function useUpdateModelOptions(
  provider: ProviderKind,
  persistence: TraitsPersistence,
): (nextOptions: ProviderOptions | undefined) => void {
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);

  return useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      if ("onModelOptionsChange" in persistence) {
        persistence.onModelOptionsChange(nextOptions);
        return;
      }
      setProviderModelOptions(persistence.threadId, provider, nextOptions, { persistSticky: true });
    },
    [persistence, provider, setProviderModelOptions],
  );
}

export function useResolvedTraits(input: {
  provider: ProviderKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  allowPromptInjectedEffort: boolean;
  updateModelOptions: (nextOptions: ProviderOptions | undefined) => void;
}) {
  const {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
  } = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    input.prompt,
    input.modelOptions,
    input.allowPromptInjectedEffort,
  );
  const defaultEffort = getDefaultEffort(caps);

  const handleEffortChange = useCallback(
    (value: string) => {
      if (!value) return;
      const nextOption = effortLevels.find((option) => option.value === value);
      if (!nextOption) return;
      if (caps.promptInjectedEffortLevels.includes(nextOption.value)) {
        const nextPrompt =
          input.prompt.trim().length === 0
            ? ULTRATHINK_PROMPT_PREFIX
            : applyClaudePromptEffortPrefix(input.prompt, "ultrathink");
        input.onPromptChange(nextPrompt);
        return;
      }
      if (ultrathinkInBodyText) return;
      if (ultrathinkPromptControlled) {
        const stripped = input.prompt.replace(/^Ultrathink:\s*/i, "");
        input.onPromptChange(stripped);
      }
      const effortKey =
        input.provider === "claudeAgent"
          ? "effort"
          : input.provider === "cursor"
            ? "reasoning"
            : "reasoningEffort";
      input.updateModelOptions(
        buildNextOptions(input.provider, input.modelOptions, {
          [effortKey]: nextOption.value,
        }),
      );
    },
    [
      ultrathinkPromptControlled,
      ultrathinkInBodyText,
      effortLevels,
      input,
      caps.promptInjectedEffortLevels,
    ],
  );

  return {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    defaultEffort,
    handleEffortChange,
  };
}

function EffortMenuGroup(props: {
  effort: string;
  effortLevels: ReadonlyArray<{ value: string; label: string; isDefault?: boolean | undefined }>;
  ultrathinkPromptControlled: boolean;
  ultrathinkInBodyText: boolean;
  defaultEffort: string | null;
  onValueChange: (value: string) => void;
}) {
  return (
    <MenuGroup>
      <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">Effort</div>
      {props.ultrathinkInBodyText ? (
        <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
          Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change effort.
        </div>
      ) : null}
      <MenuRadioGroup
        value={props.ultrathinkPromptControlled ? "ultrathink" : props.effort}
        onValueChange={props.onValueChange}
      >
        {props.effortLevels.map((option) => (
          <MenuRadioItem
            key={option.value}
            value={option.value}
            disabled={props.ultrathinkInBodyText}
          >
            {option.label}
            {option.value === props.defaultEffort ? " (default)" : ""}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </MenuGroup>
  );
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  provider,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  includeEffort = true,
  includeFastMode = true,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const updateModelOptions = useUpdateModelOptions(provider, persistence);
  const {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    defaultEffort,
    handleEffortChange,
  } = useResolvedTraits({
    provider,
    models,
    model,
    prompt,
    onPromptChange,
    modelOptions,
    allowPromptInjectedEffort,
    updateModelOptions,
  });

  const sections: Array<{ key: string; content: ReactNode }> = [];

  if (includeEffort && effort) {
    sections.push({
      key: "effort",
      content: (
        <EffortMenuGroup
          effort={effort}
          effortLevels={effortLevels}
          ultrathinkPromptControlled={ultrathinkPromptControlled}
          ultrathinkInBodyText={ultrathinkInBodyText}
          defaultEffort={defaultEffort}
          onValueChange={handleEffortChange}
        />
      ),
    });
  }

  if (caps.supportsThinkingToggle && thinkingEnabled !== null) {
    const thinkingDefault = provider !== "shiori";
    sections.push({
      key: "thinking",
      content: (
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Thinking</div>
          <MenuRadioGroup
            value={thinkingEnabled ? "on" : "off"}
            onValueChange={(value) => {
              updateModelOptions(
                buildNextOptions(provider, modelOptions, { thinking: value === "on" }),
              );
            }}
          >
            <MenuRadioItem value="on">On{thinkingDefault ? " (default)" : ""}</MenuRadioItem>
            <MenuRadioItem value="off">Off{!thinkingDefault ? " (default)" : ""}</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      ),
    });
  }

  if (includeFastMode && caps.supportsFastMode) {
    sections.push({
      key: "fastMode",
      content: (
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Fast Mode</div>
          <MenuRadioGroup
            value={fastModeEnabled ? "on" : "off"}
            onValueChange={(value) => {
              const nextFastMode = value === "on";
              if (nextFastMode !== fastModeEnabled) {
                playFastModeBlitz(nextFastMode);
              }
              updateModelOptions(
                buildNextOptions(provider, modelOptions, { fastMode: nextFastMode }),
              );
            }}
          >
            <MenuRadioItem value="off">off</MenuRadioItem>
            <MenuRadioItem value="on">on</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      ),
    });
  }

  if (contextWindowOptions.length > 1) {
    sections.push({
      key: "contextWindow",
      content: (
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
            Context Window
          </div>
          <MenuRadioGroup
            value={contextWindow ?? defaultContextWindow ?? ""}
            onValueChange={(value) => {
              updateModelOptions(
                buildNextOptions(provider, modelOptions, {
                  contextWindow: value,
                }),
              );
            }}
          >
            {contextWindowOptions.map((option) => (
              <MenuRadioItem key={option.value} value={option.value}>
                {option.label}
                {option.value === defaultContextWindow ? " (default)" : ""}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      ),
    });
  }

  if (sections.length === 0) {
    return null;
  }

  return (
    <>
      {sections.map((section, index) => (
        <Fragment key={section.key}>
          {index > 0 ? <MenuDivider /> : null}
          {section.content}
        </Fragment>
      ))}
    </>
  );
});

function EffortBars(props: {
  levels: ReadonlyArray<{ value: string; label: string }>;
  currentIndex: number;
  className?: string;
}) {
  const total = props.levels.length;
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex h-3.5 items-end gap-[2px]", props.className)}
    >
      {props.levels.map((level, i) => {
        const isActive = i <= props.currentIndex;
        const heightPercent = 35 + (i / Math.max(total - 1, 1)) * 65;
        return (
          <span
            key={level.value}
            className={cn(
              "w-[3px] rounded-[1.5px] transition-opacity duration-150 ease-out",
              isActive ? "bg-foreground" : "bg-foreground/25",
            )}
            style={{ height: `${heightPercent}%` }}
          />
        );
      })}
    </span>
  );
}

export const EffortPicker = memo(function EffortPicker({
  provider,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  triggerClassName,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const updateModelOptions = useUpdateModelOptions(provider, persistence);
  const {
    effort,
    effortLevels,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    handleEffortChange,
  } = useResolvedTraits({
    provider,
    models,
    model,
    prompt,
    onPromptChange,
    modelOptions,
    allowPromptInjectedEffort,
    updateModelOptions,
  });

  if (!effort) {
    return null;
  }

  const currentIndex = effortLevels.findIndex((option) => option.value === effort);
  const triggerLabel = ultrathinkPromptControlled
    ? "Ultrathink"
    : (effortLevels.find((option) => option.value === effort)?.label ?? effort);
  const isLocked = ultrathinkInBodyText || ultrathinkPromptControlled;
  const nextLabel = !isLocked
    ? (effortLevels[(currentIndex + 1) % effortLevels.length]?.label ?? null)
    : null;
  const title = ultrathinkInBodyText
    ? 'Your prompt contains "ultrathink" — remove it to change effort.'
    : ultrathinkPromptControlled
      ? "Ultrathink (controlled by prompt)"
      : nextLabel
        ? `Intelligence: ${triggerLabel} — click for ${nextLabel}`
        : `Intelligence: ${triggerLabel}`;

  const handleClick = () => {
    if (isLocked || effortLevels.length === 0) return;
    const nextIndex = (currentIndex + 1) % effortLevels.length;
    const next = effortLevels[nextIndex];
    if (next) handleEffortChange(next.value);
  };

  return (
    <button
      type="button"
      data-chat-effort-picker="true"
      title={title}
      aria-label={`Intelligence: ${triggerLabel}. Click to cycle.`}
      disabled={isLocked}
      onClick={handleClick}
      className={cn(
        "group/effort-picker inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-sm font-normal text-foreground outline-none transition-colors duration-150 ease-out hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring sm:h-6 sm:px-2.5 sm:text-xs",
        isLocked && "pointer-events-none opacity-60",
        triggerClassName,
      )}
    >
      <EffortBars levels={effortLevels} currentIndex={currentIndex} />
      <span className="min-w-0 truncate">{triggerLabel}</span>
    </button>
  );
});

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  allowPromptInjectedEffort = true,
  includeEffort = true,
  includeFastMode = true,
  triggerVariant,
  triggerClassName,
  ...persistence
}: TraitsMenuContentProps & TraitsPersistence) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
  } = getSelectedTraits(provider, models, model, prompt, modelOptions, allowPromptInjectedEffort);

  const effortLabel = effort
    ? (effortLevels.find((l) => l.value === effort)?.label ?? effort)
    : null;
  const contextWindowLabel =
    contextWindowOptions.length > 1 && contextWindow !== defaultContextWindow
      ? (contextWindowOptions.find((o) => o.value === contextWindow)?.label ?? null)
      : null;
  const thinkingLabel =
    thinkingEnabled !== null ? `Thinking ${thinkingEnabled ? "On" : "Off"}` : null;
  const triggerLabel = [
    includeEffort ? (ultrathinkPromptControlled ? "Ultrathink" : effortLabel) : null,
    thinkingLabel,
    ...(includeFastMode && caps.supportsFastMode && fastModeEnabled ? ["Fast"] : []),
    ...(contextWindowLabel ? [contextWindowLabel] : []),
  ]
    .filter(Boolean)
    .join(" · ");

  const isCodexStyle = provider === "codex";

  const hasVisibleSections =
    (includeEffort && effort !== null) ||
    caps.supportsThinkingToggle ||
    (includeFastMode && caps.supportsFastMode) ||
    contextWindowOptions.length > 1;

  if (!hasVisibleSections) {
    return null;
  }

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={triggerVariant ?? "ghost"}
            className={cn(
              isCodexStyle
                ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap px-2 font-normal sm:max-w-48 sm:px-2.5 [&_svg]:mx-0"
                : "shrink-0 whitespace-nowrap px-2 font-normal sm:px-2.5",
              triggerClassName,
            )}
          />
        }
      >
        {isCodexStyle ? (
          <span className="flex min-w-0 w-full items-center gap-2 overflow-hidden">
            {triggerLabel}
            <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" />
          </span>
        ) : (
          <>
            <span>{triggerLabel}</span>
            <ChevronDownIcon aria-hidden="true" className="size-3 opacity-70" />
          </>
        )}
      </MenuTrigger>
      <MenuPopup align="start">
        <TraitsMenuContent
          provider={provider}
          models={models}
          model={model}
          prompt={prompt}
          onPromptChange={onPromptChange}
          modelOptions={modelOptions}
          allowPromptInjectedEffort={allowPromptInjectedEffort}
          includeEffort={includeEffort}
          includeFastMode={includeFastMode}
          {...persistence}
        />
      </MenuPopup>
    </Menu>
  );
});
