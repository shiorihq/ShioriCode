import type { ProviderKind, ProviderModelOptions, ServerProviderModel, ThreadId } from "contracts";
import { memo, useCallback, useRef } from "react";
import { PaperclipIcon, PlusIcon, ZapIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  getProviderModelCapabilities,
  providerModelSupportsImageAttachments,
} from "../../providerModels";
import { playFastModeBlitz } from "./fastModeBlitzFx";

export interface ComposerPlusMenuProps {
  threadId: ThreadId;
  provider: ProviderKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  planModeActive: boolean;
  onTogglePlanMode: () => void;
  onAddFiles: (files: File[]) => void;
}

export const ComposerPlusMenu = memo(function ComposerPlusMenu({
  threadId,
  provider,
  models,
  model,
  modelOptions,
  planModeActive,
  onTogglePlanMode,
  onAddFiles,
}: ComposerPlusMenuProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);

  const caps = getProviderModelCapabilities(models, model, provider);
  const supportsImageAttachments = providerModelSupportsImageAttachments(models, model, provider);
  const thinkingEnabled = caps.supportsThinkingToggle
    ? provider === "shiori"
      ? ((modelOptions as { thinking?: boolean } | undefined)?.thinking ?? false)
      : ((modelOptions as { thinking?: boolean } | undefined)?.thinking ?? true)
    : null;
  const fastModeEnabled =
    caps.supportsFastMode &&
    (modelOptions as { fastMode?: boolean } | undefined)?.fastMode === true;
  const fastModeDescription =
    provider === "claudeAgent"
      ? "About 2.5x faster, with credits used at 6x"
      : "About 1.5x faster, with credits used at 2x";

  const handleThinkingToggle = useCallback(() => {
    const next = { ...(modelOptions as Record<string, unknown>), thinking: !thinkingEnabled };
    setProviderModelOptions(threadId, provider, next as ProviderModelOptions[ProviderKind], {
      persistSticky: true,
    });
  }, [modelOptions, thinkingEnabled, setProviderModelOptions, threadId, provider]);

  const handleSpeedChange = useCallback(
    (value: string) => {
      const nextFastMode = value === "fast";
      if (nextFastMode !== fastModeEnabled) {
        playFastModeBlitz(nextFastMode);
      }
      const next = { ...(modelOptions as Record<string, unknown>), fastMode: nextFastMode };
      setProviderModelOptions(threadId, provider, next as ProviderModelOptions[ProviderKind], {
        persistSticky: true,
      });
    },
    [fastModeEnabled, modelOptions, provider, setProviderModelOptions, threadId],
  );

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      if (files.length > 0) {
        onAddFiles(files);
      }
      // Reset so the same file can be re-selected
      event.target.value = "";
    },
    [onAddFiles],
  );

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        disabled={!supportsImageAttachments}
        className="hidden"
        onChange={handleFileInputChange}
      />
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 px-1.5 text-muted-foreground/70 hover:text-foreground/80"
              aria-label="More options"
              type="button"
            />
          }
        >
          <PlusIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="start" side="top" sideOffset={8}>
          <MenuItem
            disabled={!supportsImageAttachments}
            onClick={() => {
              fileInputRef.current?.click();
            }}
          >
            <PaperclipIcon className="size-4 shrink-0" />
            <span>Add photos & files</span>
            {!supportsImageAttachments ? (
              <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                Unsupported
              </span>
            ) : null}
          </MenuItem>

          <MenuDivider />

          <MenuCheckboxItem
            variant="switch"
            checked={planModeActive}
            onClick={(e) => {
              e.preventDefault();
              onTogglePlanMode();
            }}
          >
            Plan mode
          </MenuCheckboxItem>

          {thinkingEnabled !== null ? (
            <MenuCheckboxItem
              variant="switch"
              checked={thinkingEnabled}
              onClick={(e) => {
                e.preventDefault();
                handleThinkingToggle();
              }}
            >
              Thinking
            </MenuCheckboxItem>
          ) : null}

          {caps.supportsFastMode ? (
            <>
              <MenuDivider />
              <MenuSub>
                <MenuSubTrigger>
                  <ZapIcon className="size-4 shrink-0" />
                  Speed
                </MenuSubTrigger>
                <MenuSubPopup>
                  <MenuRadioGroup
                    value={fastModeEnabled ? "fast" : "standard"}
                    onValueChange={handleSpeedChange}
                  >
                    <MenuRadioItem value="standard">
                      <div className="flex flex-col">
                        <span>Standard</span>
                        <span className="text-muted-foreground text-xs">
                          Default speed with normal credit usage
                        </span>
                      </div>
                    </MenuRadioItem>
                    <MenuRadioItem value="fast">
                      <div className="flex flex-col">
                        <span>Fast</span>
                        <span className="text-muted-foreground text-xs">{fastModeDescription}</span>
                      </div>
                    </MenuRadioItem>
                  </MenuRadioGroup>
                </MenuSubPopup>
              </MenuSub>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
    </>
  );
});
