import {
  IconArrowLeftOutline24 as ArrowLeftIcon,
  IconChevronDownOutline24 as ChevronDownIcon,
  IconCopyOutline24 as CopyIcon,
  IconDownloadOutline24 as DownloadIcon,
  IconPaletteOutline24 as PaletteIcon,
  IconArrowDotRotateAnticlockwiseOutline24 as RotateCcwIcon,
  IconFloppyDiskOutline24 as SaveIcon,
} from "nucleo-core-outline-24";
import { type ChangeEvent, useCallback, useMemo, useRef, useState } from "react";
import {
  type ThemeAppearance,
  type ThemeTokenValues,
  type TerminalThemeColors,
  THEME_TOKEN_KEYS,
} from "contracts/settings";
import { useTheme } from "../../hooks/useTheme";
import { Link } from "@tanstack/react-router";
import { getDefaultThemeSeed } from "../../lib/theme";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./SettingsPanels";

// ── Token grouping for the UI ─────────────────────────────────

type TokenGroup = {
  label: string;
  description: string;
  tokens: ReadonlyArray<{ key: keyof ThemeTokenValues; label: string }>;
};

const TOKEN_GROUPS: readonly TokenGroup[] = [
  {
    label: "Base",
    description: "Main application background and text colors.",
    tokens: [
      { key: "background", label: "Background" },
      { key: "foreground", label: "Foreground" },
    ],
  },
  {
    label: "Primary",
    description: "Buttons, links, and key interactive elements.",
    tokens: [
      { key: "primary", label: "Primary" },
      { key: "primaryForeground", label: "Primary text" },
    ],
  },
  {
    label: "Secondary",
    description: "Secondary buttons and less prominent controls.",
    tokens: [
      { key: "secondary", label: "Secondary" },
      { key: "secondaryForeground", label: "Secondary text" },
    ],
  },
  {
    label: "Card",
    description: "Card surfaces and their text.",
    tokens: [
      { key: "card", label: "Card" },
      { key: "cardForeground", label: "Card text" },
    ],
  },
  {
    label: "Popover",
    description: "Dropdown menus, tooltips, and floating panels.",
    tokens: [
      { key: "popover", label: "Popover" },
      { key: "popoverForeground", label: "Popover text" },
    ],
  },
  {
    label: "Muted",
    description: "Subdued backgrounds and secondary text.",
    tokens: [
      { key: "muted", label: "Muted" },
      { key: "mutedForeground", label: "Muted text" },
    ],
  },
  {
    label: "Accent",
    description: "Hover states and highlighted areas.",
    tokens: [
      { key: "accent", label: "Accent" },
      { key: "accentForeground", label: "Accent text" },
    ],
  },
  {
    label: "Borders & Input",
    description: "Borders, input fields, and focus rings.",
    tokens: [
      { key: "border", label: "Border" },
      { key: "input", label: "Input border" },
      { key: "ring", label: "Focus ring" },
    ],
  },
  {
    label: "Destructive",
    description: "Errors, deletions, and dangerous actions.",
    tokens: [
      { key: "destructive", label: "Destructive" },
      { key: "destructiveForeground", label: "Destructive text" },
    ],
  },
  {
    label: "Status",
    description: "Informational, success, and warning indicators.",
    tokens: [
      { key: "info", label: "Info" },
      { key: "infoForeground", label: "Info text" },
      { key: "success", label: "Success" },
      { key: "successForeground", label: "Success text" },
      { key: "warning", label: "Warning" },
      { key: "warningForeground", label: "Warning text" },
    ],
  },
];

type TerminalColorGroup = {
  label: string;
  colors: ReadonlyArray<{ key: keyof TerminalThemeColors; label: string }>;
};

const TERMINAL_GROUPS: readonly TerminalColorGroup[] = [
  {
    label: "Chrome",
    colors: [
      { key: "background", label: "Background" },
      { key: "foreground", label: "Foreground" },
      { key: "cursor", label: "Cursor" },
      { key: "selectionBackground", label: "Selection" },
    ],
  },
  {
    label: "Scrollbar",
    colors: [
      { key: "scrollbarSliderBackground", label: "Scrollbar" },
      { key: "scrollbarSliderHoverBackground", label: "Scrollbar hover" },
      { key: "scrollbarSliderActiveBackground", label: "Scrollbar active" },
    ],
  },
  {
    label: "ANSI Colors",
    colors: [
      { key: "black", label: "Black" },
      { key: "red", label: "Red" },
      { key: "green", label: "Green" },
      { key: "yellow", label: "Yellow" },
      { key: "blue", label: "Blue" },
      { key: "magenta", label: "Magenta" },
      { key: "cyan", label: "Cyan" },
      { key: "white", label: "White" },
    ],
  },
  {
    label: "Bright ANSI Colors",
    colors: [
      { key: "brightBlack", label: "Bright black" },
      { key: "brightRed", label: "Bright red" },
      { key: "brightGreen", label: "Bright green" },
      { key: "brightYellow", label: "Bright yellow" },
      { key: "brightBlue", label: "Bright blue" },
      { key: "brightMagenta", label: "Bright magenta" },
      { key: "brightCyan", label: "Bright cyan" },
      { key: "brightWhite", label: "Bright white" },
    ],
  },
];

// ── Helpers ───────────────────────────────────────────────────
function makeDefaultThemeDraft(appearance: ThemeAppearance): {
  radius: string;
  tokens: ThemeTokenValues;
  terminalColors: TerminalThemeColors;
} {
  const { radius, tokens, terminal } = getDefaultThemeSeed(appearance);

  return {
    radius,
    tokens,
    terminalColors: terminal,
  };
}

/**
 * Attempt to coerce a CSS color string into a hex value suitable for
 * an `<input type="color">`.  Returns the original string when conversion
 * is not possible (e.g. CSS variables, color-mix, oklch).
 */
function rgbComponentToHex(n: string): string {
  return parseInt(n, 10).toString(16).padStart(2, "0");
}

function colorToHex(value: string): string {
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/i.test(trimmed)) return trimmed;
  if (/^#[0-9a-fA-F]{3}$/i.test(trimmed)) {
    const [, r, g, b] = /^#(.)(.)(.)$/i.exec(trimmed)!;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  // Try rgb(r, g, b)
  const rgbMatch = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(trimmed);
  if (rgbMatch) {
    return `#${rgbComponentToHex(rgbMatch[1]!)}${rgbComponentToHex(rgbMatch[2]!)}${rgbComponentToHex(rgbMatch[3]!)}`;
  }
  return trimmed;
}

function isValidHex(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/i.test(value.trim());
}

// ── Color swatch with picker ─────────────────────────────────

function ColorTokenInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const hex = colorToHex(value);
  const isHex = isValidHex(hex);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex items-center gap-2.5">
      <button
        type="button"
        className="group relative size-8 shrink-0 cursor-pointer rounded-lg border border-border shadow-xs/5 transition-shadow hover:ring-2 hover:ring-ring/24"
        style={{ backgroundColor: hex }}
        onClick={() => inputRef.current?.click()}
        aria-label={`Pick color for ${label}`}
      >
        <input
          ref={inputRef}
          type="color"
          value={isHex ? hex : "#000000"}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
          tabIndex={-1}
        />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Input
          size="sm"
          value={value}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
          className="font-mono text-xs"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </div>
  );
}

// ── Live preview ─────────────────────────────────────────────

function ThemePreview({ tokens }: { tokens: ThemeTokenValues }) {
  return (
    <div
      className="overflow-hidden rounded-xl border shadow-xs/5"
      style={
        {
          "--p-bg": tokens.background,
          "--p-fg": tokens.foreground,
          "--p-card": tokens.card,
          "--p-card-fg": tokens.cardForeground,
          "--p-primary": tokens.primary,
          "--p-primary-fg": tokens.primaryForeground,
          "--p-secondary": tokens.secondary,
          "--p-secondary-fg": tokens.secondaryForeground,
          "--p-muted": tokens.muted,
          "--p-muted-fg": tokens.mutedForeground,
          "--p-accent": tokens.accent,
          "--p-border": tokens.border,
          "--p-input": tokens.input,
          "--p-destructive": tokens.destructive,
          "--p-destructive-fg": tokens.destructiveForeground,
          "--p-info": tokens.info,
          "--p-success": tokens.success,
          "--p-warning": tokens.warning,
          borderColor: tokens.border,
        } as React.CSSProperties
      }
    >
      {/* Title bar */}
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ backgroundColor: tokens.card, borderBottom: `1px solid ${tokens.border}` }}
      >
        <div className="flex gap-1.5">
          <span className="size-2.5 rounded-full" style={{ backgroundColor: tokens.destructive }} />
          <span className="size-2.5 rounded-full" style={{ backgroundColor: tokens.warning }} />
          <span className="size-2.5 rounded-full" style={{ backgroundColor: tokens.success }} />
        </div>
        <span className="text-[10px] font-medium" style={{ color: tokens.mutedForeground }}>
          Preview
        </span>
      </div>

      {/* Body */}
      <div className="flex" style={{ backgroundColor: tokens.background }}>
        {/* Sidebar */}
        <div
          className="w-28 shrink-0 space-y-1 p-2"
          style={{ borderRight: `1px solid ${tokens.border}` }}
        >
          <div
            className="rounded-md px-2 py-1 text-[10px] font-medium"
            style={{ backgroundColor: tokens.accent, color: tokens.foreground }}
          >
            Active item
          </div>
          <div
            className="rounded-md px-2 py-1 text-[10px]"
            style={{ color: tokens.mutedForeground }}
          >
            Menu item
          </div>
          <div
            className="rounded-md px-2 py-1 text-[10px]"
            style={{ color: tokens.mutedForeground }}
          >
            Menu item
          </div>
        </div>

        {/* Main */}
        <div className="flex-1 space-y-2.5 p-3">
          <div className="space-y-1">
            <span className="text-xs font-semibold" style={{ color: tokens.foreground }}>
              Theme Preview
            </span>
            <p className="text-[10px] leading-relaxed" style={{ color: tokens.mutedForeground }}>
              This is how your theme will look in the application.
            </p>
          </div>

          {/* Card */}
          <div
            className="rounded-lg p-2.5"
            style={{
              backgroundColor: tokens.card,
              border: `1px solid ${tokens.border}`,
            }}
          >
            <span className="text-[10px] font-medium" style={{ color: tokens.cardForeground }}>
              Card component
            </span>
            <p className="mt-0.5 text-[10px]" style={{ color: tokens.mutedForeground }}>
              Cards contain grouped content.
            </p>
          </div>

          {/* Buttons */}
          <div className="flex flex-wrap gap-1.5">
            <span
              className="rounded-md px-2.5 py-1 text-[10px] font-medium"
              style={{ backgroundColor: tokens.primary, color: tokens.primaryForeground }}
            >
              Primary
            </span>
            <span
              className="rounded-md px-2.5 py-1 text-[10px] font-medium"
              style={{ backgroundColor: tokens.secondary, color: tokens.secondaryForeground }}
            >
              Secondary
            </span>
            <span
              className="rounded-md px-2.5 py-1 text-[10px] font-medium"
              style={{ backgroundColor: tokens.destructive, color: tokens.destructiveForeground }}
            >
              Delete
            </span>
          </div>

          {/* Input */}
          <div
            className="rounded-md px-2 py-1 text-[10px]"
            style={{
              backgroundColor: tokens.background,
              border: `1px solid ${tokens.input}`,
              color: tokens.mutedForeground,
            }}
          >
            Placeholder text...
          </div>

          {/* Status badges */}
          <div className="flex gap-1.5">
            <span
              className="rounded-full px-2 py-0.5 text-[9px] font-medium text-white"
              style={{ backgroundColor: tokens.info }}
            >
              Info
            </span>
            <span
              className="rounded-full px-2 py-0.5 text-[9px] font-medium text-white"
              style={{ backgroundColor: tokens.success }}
            >
              Success
            </span>
            <span
              className="rounded-full px-2 py-0.5 text-[9px] font-medium text-white"
              style={{ backgroundColor: tokens.warning }}
            >
              Warning
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────

export function ThemeBuilderPanel() {
  const { themeOptionsByAppearance, importTheme } = useTheme();
  const initialDraft = makeDefaultThemeDraft("dark");

  const allThemes = useMemo(
    () => [...themeOptionsByAppearance.light, ...themeOptionsByAppearance.dark],
    [themeOptionsByAppearance],
  );

  // ── Builder state ───────────────────────────────────────────
  const [name, setName] = useState("");
  const [author, setAuthor] = useState("");
  const [description, setDescription] = useState("");
  const [appearance, setAppearance] = useState<ThemeAppearance>("dark");
  const [radius, setRadius] = useState(initialDraft.radius);
  const [tokens, setTokens] = useState<ThemeTokenValues>(initialDraft.tokens);
  const [terminalColors, setTerminalColors] = useState<TerminalThemeColors>(
    initialDraft.terminalColors,
  );
  const [terminalOpen, setTerminalOpen] = useState(false);

  const updateToken = useCallback((key: keyof ThemeTokenValues, value: string) => {
    setTokens((prev) => ({ ...prev, [key]: value }));
  }, []);

  const updateTerminalColor = useCallback((key: keyof TerminalThemeColors, value: string) => {
    setTerminalColors((prev) => ({ ...prev, [key]: value }));
  }, []);

  const loadBaseTheme = useCallback(
    (themeId: string | null) => {
      if (themeId == null) return;
      const base = allThemes.find((theme) => theme.id === themeId);
      if (!base) return;
      setAppearance(base.appearance);
      setTokens({ ...base.tokens });
      if (base.terminal) {
        setTerminalColors({ ...base.terminal });
      } else {
        setTerminalColors(makeDefaultThemeDraft(base.appearance).terminalColors);
      }
      if (base.radius) setRadius(base.radius);
    },
    [allThemes],
  );

  const handleAppearanceChange = useCallback((next: string | null) => {
    if (next !== "light" && next !== "dark") return;
    const defaults = makeDefaultThemeDraft(next);
    setAppearance(next);
    setRadius(defaults.radius);
    setTokens(defaults.tokens);
    setTerminalColors(defaults.terminalColors);
  }, []);

  const resetAll = useCallback(() => {
    const defaults = makeDefaultThemeDraft(appearance);
    setName("");
    setAuthor("");
    setDescription("");
    setRadius(defaults.radius);
    setTokens(defaults.tokens);
    setTerminalColors(defaults.terminalColors);
  }, [appearance]);

  // ── Build theme JSON ────────────────────────────────────────

  const buildThemeJson = useCallback(() => {
    return JSON.stringify(
      {
        version: 1,
        name: name.trim() || "Untitled Theme",
        appearance,
        author: author.trim() || undefined,
        description: description.trim() || undefined,
        radius,
        tokens,
        terminal: terminalColors,
      },
      null,
      2,
    );
  }, [name, author, description, appearance, radius, tokens, terminalColors]);

  const handleSave = useCallback(() => {
    const themeName = name.trim() || "Untitled Theme";
    try {
      importTheme(buildThemeJson());
      toastManager.add({
        type: "success",
        title: `Saved "${themeName}"`,
        description: `The theme is now active for your ${appearance} appearance.`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not save theme",
        description: error instanceof Error ? error.message : "The theme data is invalid.",
      });
    }
  }, [name, appearance, buildThemeJson, importTheme]);

  const handleExport = useCallback(() => {
    const json = buildThemeJson();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(name.trim() || "theme").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [name, buildThemeJson]);

  const handleCopyJson = useCallback(() => {
    void navigator.clipboard.writeText(buildThemeJson()).then(
      () => {
        toastManager.add({
          type: "success",
          title: "Copied to clipboard",
          description: "Theme JSON has been copied.",
        });
      },
      () => {
        toastManager.add({
          type: "error",
          title: "Copy failed",
          description: "Could not copy to clipboard.",
        });
      },
    );
  }, [buildThemeJson]);

  // ── Validate enough to save ─────────────────────────────────

  const hasAllTokens = THEME_TOKEN_KEYS.every((key) => tokens[key]?.trim());

  return (
    <SettingsPageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            to="/settings/appearance"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeftIcon className="size-3.5" />
            Appearance
          </Link>
          <span className="text-border">/</span>
          <div className="flex items-center gap-2">
            <PaletteIcon className="size-4 text-primary" />
            <h1 className="text-sm font-semibold text-foreground">Theme Builder</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={handleCopyJson} title="Copy JSON">
            <CopyIcon className="size-3.5" />
            Copy JSON
          </Button>
          <Button size="sm" variant="outline" onClick={handleExport}>
            <DownloadIcon className="size-3.5" />
            Export
          </Button>
          <Button size="sm" variant="default" disabled={!hasAllTokens} onClick={handleSave}>
            <SaveIcon className="size-3.5" />
            Save & Apply
          </Button>
        </div>
      </div>

      {/* Meta fields */}
      <SettingsSection title="Theme Details">
        <SettingsRow
          title="Name"
          description="Give your theme a recognizable name."
          control={
            <Input
              size="sm"
              value={name}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
              placeholder="My Theme"
              className="w-full sm:w-52"
            />
          }
        />
        <SettingsRow
          title="Author"
          description="Optional creator attribution."
          control={
            <Input
              size="sm"
              value={author}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setAuthor(event.target.value)}
              placeholder="Your name"
              className="w-full sm:w-52"
            />
          }
        />
        <SettingsRow
          title="Description"
          description="A short summary of the theme's look and feel."
          control={
            <Input
              size="sm"
              value={description}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setDescription(event.target.value)
              }
              placeholder="A warm dark palette with…"
              className="w-full sm:w-52"
            />
          }
        />
        <SettingsRow
          title="Appearance"
          description="Whether this theme targets light or dark mode."
          control={
            <Select value={appearance} onValueChange={handleAppearanceChange}>
              <SelectTrigger className="w-full sm:w-40" aria-label="Appearance">
                <SelectValue>{appearance === "light" ? "Light" : "Dark"}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="light">
                  Light
                </SelectItem>
                <SelectItem hideIndicator value="dark">
                  Dark
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Border radius"
          description="Default border radius for UI components."
          control={
            <Input
              size="sm"
              value={radius}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setRadius(event.target.value)}
              placeholder="0.625rem"
              className="w-full sm:w-40 font-mono text-xs"
            />
          }
        />
        <SettingsRow
          title="Start from base"
          description="Load colors from an existing theme to use as a starting point."
          control={
            <Select value="" onValueChange={loadBaseTheme}>
              <SelectTrigger className="w-full sm:w-52" aria-label="Base theme">
                <SelectValue>Choose a theme...</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {allThemes.map((theme) => (
                  <SelectItem hideIndicator key={theme.id} value={theme.id}>
                    {theme.name}
                    <span className="ml-1.5 text-muted-foreground">({theme.appearance})</span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      {/* Live preview */}
      <SettingsSection title="Live Preview">
        <div className="p-4">
          <ThemePreview tokens={tokens} />
        </div>
      </SettingsSection>

      {/* Token groups */}
      {TOKEN_GROUPS.map((group) => (
        <SettingsSection key={group.label} title={group.label}>
          <div className="px-4 py-4 sm:px-5">
            <p className="mb-4 text-xs text-muted-foreground">{group.description}</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {group.tokens.map((token) => (
                <ColorTokenInput
                  key={token.key}
                  label={token.label}
                  value={tokens[token.key]}
                  onChange={(next) => updateToken(token.key, next)}
                />
              ))}
            </div>
          </div>
        </SettingsSection>
      ))}

      {/* Terminal colors (collapsible) */}
      <Collapsible open={terminalOpen} onOpenChange={setTerminalOpen}>
        <SettingsSection
          title="Terminal Colors"
          headerAction={
            <CollapsibleTrigger
              className={cn(
                "inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground",
              )}
            >
              <ChevronDownIcon
                className={cn(
                  "size-3.5 transition-transform duration-200",
                  terminalOpen && "rotate-180",
                )}
              />
              {terminalOpen ? "Collapse" : "Expand"}
            </CollapsibleTrigger>
          }
        >
          <CollapsibleContent>
            {TERMINAL_GROUPS.map((group) => (
              <div
                key={group.label}
                className="border-t border-border px-4 py-4 first:border-t-0 sm:px-5"
              >
                <p className="mb-4 text-xs font-medium text-foreground">{group.label}</p>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {group.colors.map((color) => (
                    <ColorTokenInput
                      key={color.key}
                      label={color.label}
                      value={terminalColors[color.key]}
                      onChange={(next) => updateTerminalColor(color.key, next)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </CollapsibleContent>
        </SettingsSection>
      </Collapsible>

      {/* Reset */}
      <div className="flex justify-end pb-6">
        <Button size="sm" variant="ghost" onClick={resetAll}>
          <RotateCcwIcon className="size-3.5" />
          Reset all colors
        </Button>
      </div>
    </SettingsPageContainer>
  );
}
