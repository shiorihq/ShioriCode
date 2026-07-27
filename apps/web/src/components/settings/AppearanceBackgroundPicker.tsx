import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { ImageIcon, UploadIcon } from "lucide-react";
import type { AppearanceBackgroundPresetId } from "contracts/settings";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import {
  APPEARANCE_BACKGROUND_PRESETS,
  customAppearanceBackgroundUrl,
  normalizeAppearanceBackgroundBlur,
  normalizeAppearanceBackgroundOpacity,
} from "../../lib/appearanceBackgrounds";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { LoadingText } from "../ui/loading-text";
import { toastManager } from "../ui/toast";

const MAX_BACKGROUND_BYTES = 12 * 1024 * 1024;

interface UploadResponse {
  readonly success?: boolean;
  readonly error?: string;
  readonly data?: { readonly version?: string };
}

function BackgroundRangeControl(props: {
  disabled: boolean;
  id: string;
  label: string;
  max: number;
  onCommit: (value: number) => void;
  onPreview: (value: number) => void;
  suffix: string;
  value: number;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <label htmlFor={props.id} className="text-xs font-medium">
          {props.label}
        </label>
        <output
          htmlFor={props.id}
          className="min-w-10 text-right font-mono text-[11px] text-muted-foreground"
        >
          {props.value}
          {props.suffix}
        </output>
      </div>
      <input
        id={props.id}
        type="range"
        min={0}
        max={props.max}
        step={1}
        value={props.value}
        disabled={props.disabled}
        className="h-1.5 w-full cursor-pointer accent-primary disabled:cursor-not-allowed"
        onChange={(event) => props.onPreview(event.currentTarget.valueAsNumber)}
        onPointerUp={(event) => props.onCommit(event.currentTarget.valueAsNumber)}
        onPointerCancel={(event) => props.onCommit(event.currentTarget.valueAsNumber)}
        onKeyUp={(event) => props.onCommit(event.currentTarget.valueAsNumber)}
        onBlur={(event) => props.onCommit(event.currentTarget.valueAsNumber)}
      />
    </div>
  );
}

function usePreviewedBackgroundSetting(options: {
  cssVariable: string;
  cssValue: (value: number) => string;
  normalize: (value: number | undefined) => number;
  onCommit: (value: number) => void;
  targetSelector: string;
  value: number | undefined;
}) {
  const normalizedValue = options.normalize(options.value);
  const [draftValue, setDraftValue] = useState(normalizedValue);
  const lastCommittedValueRef = useRef(normalizedValue);

  useEffect(() => {
    lastCommittedValueRef.current = normalizedValue;
    setDraftValue(normalizedValue);
  }, [normalizedValue]);

  const preview = useCallback(
    (nextValue: number) => {
      const normalized = options.normalize(nextValue);
      setDraftValue(normalized);
      // Promote the wallpaper layer for the duration of the drag.
      document.documentElement.toggleAttribute("data-app-wallpaper-tuning", true);
      document
        .querySelector<HTMLElement>(options.targetSelector)
        ?.style.setProperty(options.cssVariable, options.cssValue(normalized));
    },
    [options],
  );

  const commit = useCallback(
    (nextValue: number) => {
      const normalized = options.normalize(nextValue);
      preview(normalized);
      document.documentElement.toggleAttribute("data-app-wallpaper-tuning", false);
      if (normalized === lastCommittedValueRef.current) return;
      lastCommittedValueRef.current = normalized;
      options.onCommit(normalized);
    },
    [options, preview],
  );

  return { commit, draftValue, preview };
}

function BackgroundCard(props: {
  description: string;
  imageUrl: string | null;
  name: string;
  onClick: () => void;
  selected: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      className={cn(
        "group overflow-hidden rounded-xl border bg-card text-left shadow-xs transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-foreground/25 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        props.selected && "border-primary ring-2 ring-primary/25",
      )}
      onClick={props.onClick}
    >
      <div className="relative aspect-video overflow-hidden bg-muted">
        {props.imageUrl ? (
          <img
            src={props.imageUrl}
            alt=""
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex size-full items-center justify-center bg-[radial-gradient(circle_at_top,var(--muted),var(--background))] text-muted-foreground">
            <ImageIcon className="size-7" />
          </div>
        )}
        {props.selected ? (
          <span className="absolute top-2 right-2 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold tracking-wide text-primary-foreground shadow-sm">
            Active
          </span>
        ) : null}
      </div>
      <div className="space-y-0.5 px-3 py-2.5">
        <p className="text-xs font-medium text-card-foreground">{props.name}</p>
        <p className="truncate text-[11px] text-muted-foreground">{props.description}</p>
      </div>
    </button>
  );
}

export function AppearanceBackgroundPicker() {
  const { appearanceBackground: background } = useSettings();
  const { updateSettings } = useUpdateSettings();
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const customUrl = customAppearanceBackgroundUrl(background.customVersion);
  const sidebarOpacityControl = usePreviewedBackgroundSetting({
    cssVariable: "--app-wallpaper-opacity",
    cssValue: (value) => String(value / 100),
    normalize: normalizeAppearanceBackgroundOpacity,
    onCommit: (opacity) => updateSettings({ appearanceBackground: { ...background, opacity } }),
    targetSelector: '[data-app-wallpaper-image="shell"]',
    value: background.opacity,
  });
  const sidebarBlurControl = usePreviewedBackgroundSetting({
    cssVariable: "--app-wallpaper-blur",
    cssValue: (value) => `${value}px`,
    normalize: normalizeAppearanceBackgroundBlur,
    onCommit: (blur) => updateSettings({ appearanceBackground: { ...background, blur } }),
    targetSelector: '[data-app-wallpaper-image="shell"]',
    value: background.blur,
  });
  const mainOpacityControl = usePreviewedBackgroundSetting({
    cssVariable: "--app-wallpaper-opacity",
    cssValue: (value) => String(value / 100),
    normalize: normalizeAppearanceBackgroundOpacity,
    onCommit: (mainOpacity) =>
      updateSettings({ appearanceBackground: { ...background, mainOpacity } }),
    targetSelector: '[data-app-wallpaper-image="main"]',
    value: background.mainOpacity,
  });
  const mainBlurControl = usePreviewedBackgroundSetting({
    cssVariable: "--app-wallpaper-blur",
    cssValue: (value) => `${value}px`,
    normalize: normalizeAppearanceBackgroundBlur,
    onCommit: (mainBlur) => updateSettings({ appearanceBackground: { ...background, mainBlur } }),
    targetSelector: '[data-app-wallpaper-image="main"]',
    value: background.mainBlur,
  });

  const choosePreset = useCallback(
    (presetId: AppearanceBackgroundPresetId) => {
      updateSettings({
        appearanceBackground: { ...background, kind: "preset", presetId },
      });
    },
    [background, updateSettings],
  );

  const handleUpload = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size === 0 || file.size > MAX_BACKGROUND_BYTES) {
      toastManager.add({
        type: "error",
        title: "Could not use that image",
        description: "Choose a PNG, JPEG, or WebP image that is 12MB or smaller.",
      });
      return;
    }

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/appearance/background", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      const result = (await response.json().catch(() => ({}))) as UploadResponse;
      if (!response.ok || !result.success || !result.data?.version) {
        throw new Error(result.error || "The image could not be saved.");
      }
      toastManager.add({
        type: "success",
        title: "Background updated",
        description:
          "The image is stored on this ShioriCode host and is available to linked devices.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not upload background",
        description: error instanceof Error ? error.message : "The image could not be saved.",
      });
    } finally {
      setIsUploading(false);
    }
  }, []);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <BackgroundCard
          name="None"
          description="Use the theme's solid background"
          imageUrl={null}
          selected={background.kind === "none"}
          onClick={() => updateSettings({ appearanceBackground: { ...background, kind: "none" } })}
        />
        {APPEARANCE_BACKGROUND_PRESETS.map((preset) => (
          <BackgroundCard
            key={preset.id}
            name={preset.name}
            description={preset.description}
            imageUrl={preset.url}
            selected={background.kind === "preset" && background.presetId === preset.id}
            onClick={() => choosePreset(preset.id)}
          />
        ))}
        {customUrl ? (
          <BackgroundCard
            name="Uploaded image"
            description="Stored on this ShioriCode host"
            imageUrl={customUrl}
            selected={background.kind === "custom"}
            onClick={() =>
              updateSettings({ appearanceBackground: { ...background, kind: "custom" } })
            }
          />
        ) : null}
      </div>

      <div className={cn("grid gap-3 sm:grid-cols-2", background.kind === "none" && "opacity-50")}>
        <div className="space-y-4 rounded-xl border border-hairline bg-background/40 px-3 py-3">
          <p className="text-xs font-semibold text-foreground">Sidebar</p>
          <BackgroundRangeControl
            id="appearance-sidebar-background-opacity"
            label="Opacity"
            max={100}
            suffix="%"
            value={sidebarOpacityControl.draftValue}
            disabled={background.kind === "none"}
            onPreview={sidebarOpacityControl.preview}
            onCommit={sidebarOpacityControl.commit}
          />
          <BackgroundRangeControl
            id="appearance-sidebar-background-blur"
            label="Blur"
            max={20}
            suffix="px"
            value={sidebarBlurControl.draftValue}
            disabled={background.kind === "none"}
            onPreview={sidebarBlurControl.preview}
            onCommit={sidebarBlurControl.commit}
          />
        </div>
        <div className="space-y-4 rounded-xl border border-hairline bg-background/40 px-3 py-3">
          <p className="text-xs font-semibold text-foreground">Main chat</p>
          <BackgroundRangeControl
            id="appearance-main-background-opacity"
            label="Opacity"
            max={100}
            suffix="%"
            value={mainOpacityControl.draftValue}
            disabled={background.kind === "none"}
            onPreview={mainOpacityControl.preview}
            onCommit={mainOpacityControl.commit}
          />
          <BackgroundRangeControl
            id="appearance-main-background-blur"
            label="Blur"
            max={20}
            suffix="px"
            value={mainBlurControl.draftValue}
            disabled={background.kind === "none"}
            onPreview={mainBlurControl.preview}
            onCommit={mainBlurControl.commit}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-dashed border-hairline bg-background/40 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-medium text-foreground">Use your own image</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            PNG, JPEG, or WebP · up to 12MB · stored on the host device
          </p>
        </div>
        <input
          ref={uploadInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={handleUpload}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={isUploading}
          onClick={() => uploadInputRef.current?.click()}
        >
          <UploadIcon className="size-3.5" />
          {isUploading ? <LoadingText>Uploading</LoadingText> : customUrl ? "Replace" : "Upload"}
        </Button>
      </div>
    </div>
  );
}
