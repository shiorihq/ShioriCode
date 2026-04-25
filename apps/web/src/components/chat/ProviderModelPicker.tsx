import { type ProviderKind, type ProviderModelOptions, type ServerProvider } from "contracts";
import { resolveSelectableModel } from "shared/model";
import { memo, useMemo, useRef, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { type ProviderPickerKind, PROVIDER_OPTIONS } from "../../session-logic";
import { ChevronDownIcon, SearchIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import type { Icon } from "../Icons";
import { PROVIDER_BRAND_ICON_BY_PROVIDER, providerBrandIconClassName } from "./providerBrandIcons";
import { cn } from "~/lib/utils";
import {
  getProviderPickerState,
  getProviderModelCapabilities,
  getProviderModels,
  getProviderSnapshot,
} from "../../providerModels";

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderKind;
  label: string;
  available: true;
} {
  return option.available;
}

const PROVIDER_ICON_BY_PROVIDER: Record<ProviderPickerKind, Icon> = PROVIDER_BRAND_ICON_BY_PROVIDER;

const FastModeBoltIcon: Icon = (props) => (
  <svg {...props} viewBox="0 0 16 16" fill="currentColor">
    <path d="M9.982 1.055a.75.75 0 0 1 .64.88l-.74 4.065h2.945a.75.75 0 0 1 .557 1.252L7.27 14.032a.75.75 0 0 1-1.31-.6l.848-4.682H3.75a.75.75 0 0 1-.546-1.264l5.523-5.657a.75.75 0 0 1 1.255.226Z" />
  </svg>
);

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);

function displayModelOptionLabel(
  provider: ProviderKind,
  option: { slug: string; name: string },
): string {
  if (provider === "kimiCode" && option.slug === "kimi-code/kimi-for-coding") {
    return "Kimi K2.6";
  }
  return option.name;
}

function shouldShowLockedProviderModelSearch(provider: ProviderKind): boolean {
  return provider === "shiori" || provider === "kimiCode";
}

function LockedProviderModelList(props: {
  model: string;
  lockedProvider: ProviderKind;
  modelOptions: ReadonlyArray<{ slug: string; name: string }>;
  searchEnabled: boolean;
  searchQuery: string;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onSearchChange: (query: string) => void;
  onModelChange: (provider: ProviderKind, model: string) => void;
  onClose: () => void;
}) {
  const effectiveSearchQuery = props.searchEnabled ? props.searchQuery : "";
  const filteredModels = useMemo(() => {
    if (!effectiveSearchQuery) return props.modelOptions;
    const q = effectiveSearchQuery.toLowerCase();
    return props.modelOptions.filter((m) => m.name.toLowerCase().includes(q));
  }, [effectiveSearchQuery, props.modelOptions]);

  return (
    <>
      {props.searchEnabled ? (
        <div className="sticky top-0 z-10 bg-popover px-1 pb-1">
          <div className="flex items-center gap-2 rounded-md border border-input bg-transparent px-2 py-1.5">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
            <input
              ref={props.searchInputRef}
              autoFocus
              type="text"
              value={props.searchQuery}
              placeholder="Search models…"
              className="h-5 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
              onChange={(e) => props.onSearchChange(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
        </div>
      ) : null}
      <MenuGroup>
        <MenuRadioGroup
          value={props.model}
          onValueChange={(value) => props.onModelChange(props.lockedProvider, value)}
        >
          {filteredModels.map((modelOption) => (
            <MenuRadioItem
              key={`${props.lockedProvider}:${modelOption.slug}`}
              value={modelOption.slug}
              onClick={props.onClose}
            >
              {displayModelOptionLabel(props.lockedProvider, modelOption)}
            </MenuRadioItem>
          ))}
          {filteredModels.length === 0 && (
            <div className="px-2 py-4 text-center text-sm text-muted-foreground/60">
              No models found
            </div>
          )}
        </MenuRadioGroup>
      </MenuGroup>
    </>
  );
}

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  provider: ProviderKind;
  model: string;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  modelOptions?: ProviderModelOptions[ProviderKind];
  activeProviderIconClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  onProviderModelChange: (provider: ProviderKind, model: string) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const activeProvider = props.lockedProvider ?? props.provider;
  const selectedProviderOptions = props.modelOptionsByProvider[activeProvider];
  const selectedModelLabel = (() => {
    const selectedOption = selectedProviderOptions.find((option) => option.slug === props.model);
    return selectedOption ? displayModelOptionLabel(activeProvider, selectedOption) : props.model;
  })();
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[activeProvider];
  const fastModeActive = useMemo(() => {
    if (!props.providers || !props.modelOptions || !("fastMode" in props.modelOptions)) {
      return false;
    }
    if (props.modelOptions.fastMode !== true) {
      return false;
    }
    const activeProviderModels = getProviderModels(props.providers, activeProvider);
    return getProviderModelCapabilities(activeProviderModels, props.model, activeProvider)
      .supportsFastMode;
  }, [activeProvider, props.model, props.modelOptions, props.providers]);
  const handleModelChange = (provider: ProviderKind, value: string) => {
    if (props.disabled) return;
    if (!value) return;
    const resolvedModel = resolveSelectableModel(
      provider,
      value,
      props.modelOptionsByProvider[provider],
    );
    if (!resolvedModel) return;
    props.onProviderModelChange(provider, resolvedModel);
    setIsMenuOpen(false);
  };

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
        if (!open) setSearchQuery("");
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={props.triggerVariant ?? "ghost"}
            data-chat-provider-model-picker="true"
            style={props.compact ? { paddingInlineEnd: "12px" } : undefined}
            className={cn(
              "group/provider-model-picker justify-start whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 [&_svg]:mx-0",
              props.compact ? "max-w-42 min-w-0 shrink" : "sm:px-3",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn("flex items-center gap-2", props.compact ? "max-w-36 sm:pl-1" : undefined)}
        >
          <span className="relative flex size-4 shrink-0 items-center justify-center">
            {fastModeActive ? (
              <>
                <FastModeBoltIcon
                  aria-hidden="true"
                  data-chat-provider-model-picker-fast-icon="true"
                  className="size-4 shrink-0 text-muted-foreground/70 transition-opacity duration-150 group-hover/provider-model-picker:opacity-0 group-focus-visible/provider-model-picker:opacity-0"
                />
                <ProviderIcon
                  aria-hidden="true"
                  data-chat-provider-model-picker-provider-icon="true"
                  className={cn(
                    "absolute inset-0 size-4 shrink-0 opacity-0 transition-opacity duration-150 group-hover/provider-model-picker:opacity-100 group-focus-visible/provider-model-picker:opacity-100",
                    providerBrandIconClassName(activeProvider, "text-muted-foreground/70"),
                    props.activeProviderIconClassName,
                  )}
                />
              </>
            ) : (
              <ProviderIcon
                aria-hidden="true"
                data-chat-provider-model-picker-provider-icon="true"
                className={cn(
                  "size-4 shrink-0",
                  providerBrandIconClassName(activeProvider, "text-muted-foreground/70"),
                  props.activeProviderIconClassName,
                )}
              />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate whitespace-nowrap">{selectedModelLabel}</span>
          <ChevronDownIcon
            aria-hidden="true"
            data-chat-provider-model-picker-chevron="true"
            className="size-3 shrink-0 opacity-60"
          />
        </span>
      </MenuTrigger>
      <MenuPopup
        align="start"
        scrollFade={props.lockedProvider !== null}
        className={
          props.lockedProvider !== null ? "[--available-height:min(24rem,70vh)]" : undefined
        }
      >
        {props.lockedProvider !== null ? (
          <LockedProviderModelList
            model={props.model}
            lockedProvider={props.lockedProvider}
            modelOptions={props.modelOptionsByProvider[props.lockedProvider]}
            searchEnabled={shouldShowLockedProviderModelSearch(props.lockedProvider)}
            searchQuery={searchQuery}
            searchInputRef={searchInputRef}
            onSearchChange={setSearchQuery}
            onModelChange={handleModelChange}
            onClose={() => setIsMenuOpen(false)}
          />
        ) : (
          <>
            {AVAILABLE_PROVIDER_OPTIONS.map((option) => {
              const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
              const liveProvider = props.providers
                ? getProviderSnapshot(props.providers, option.value)
                : undefined;
              const providerMenuState = getProviderPickerState(liveProvider);
              if (!providerMenuState.selectable) {
                return (
                  <MenuItem key={option.value} disabled>
                    <OptionIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0 opacity-80",
                        providerBrandIconClassName(option.value, "text-muted-foreground/85"),
                      )}
                    />
                    <span>{option.label}</span>
                    <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                      {providerMenuState.badgeLabel}
                    </span>
                  </MenuItem>
                );
              }
              return (
                <MenuSub key={option.value}>
                  <MenuSubTrigger>
                    <OptionIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0",
                        providerBrandIconClassName(option.value, "text-muted-foreground/85"),
                      )}
                    />
                    {option.label}
                    {providerMenuState.badgeLabel ? (
                      <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                        {providerMenuState.badgeLabel}
                      </span>
                    ) : null}
                  </MenuSubTrigger>
                  <MenuSubPopup className="[--available-height:min(24rem,70vh)]" sideOffset={4}>
                    <MenuGroup>
                      <MenuRadioGroup
                        value={props.provider === option.value ? props.model : ""}
                        onValueChange={(value) => handleModelChange(option.value, value)}
                      >
                        {props.modelOptionsByProvider[option.value].map((modelOption) => (
                          <MenuRadioItem
                            key={`${option.value}:${modelOption.slug}`}
                            value={modelOption.slug}
                            onClick={() => setIsMenuOpen(false)}
                          >
                            {displayModelOptionLabel(option.value, modelOption)}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                  </MenuSubPopup>
                </MenuSub>
              );
            })}
          </>
        )}
      </MenuPopup>
    </Menu>
  );
});
