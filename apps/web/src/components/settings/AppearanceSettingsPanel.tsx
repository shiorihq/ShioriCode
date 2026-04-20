import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { PaintbrushIcon, Undo2Icon, XIcon } from "lucide-react";
import {
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_UNIFIED_SETTINGS,
} from "contracts/settings";

import { isElectron } from "../../env";
import { loadFontCatalog } from "../../lib/fonts";
import { useTheme } from "../../hooks/useTheme";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { LoadingText } from "../ui/loading-text";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  DEFAULT_CODE_FONT_OPTION,
  DEFAULT_UI_FONT_OPTION,
  TIMESTAMP_FORMAT_LABELS,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  buildFontOptions,
  filterFontOptions,
} from "./SettingsPanels";

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

const APPEARANCE_THEME_LABELS = {
  light: "Light theme",
  dark: "Dark theme",
} as const;

function ResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Reset ${label} to default`}
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">Reset to default</TooltipPopup>
    </Tooltip>
  );
}

export function AppearanceSettingsPanel() {
  const {
    theme,
    setTheme,
    importedThemes,
    lightThemeId,
    darkThemeId,
    setThemeAssignment,
    importTheme,
    removeImportedTheme,
    themeOptionsByAppearance,
  } = useTheme();

  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [isImportingThemes, setIsImportingThemes] = useState(false);
  const [fontCatalog, setFontCatalog] = useState<{ all: string[]; monospace: string[] }>({
    all: [],
    monospace: [],
  });
  const [uiFontSearch, setUiFontSearch] = useState("");
  const [codeFontSearch, setCodeFontSearch] = useState("");
  const [isLoadingFonts, setIsLoadingFonts] = useState(false);
  const themeImportInputRef = useRef<HTMLInputElement | null>(null);

  const openThemeImportDialog = useCallback(() => {
    themeImportInputRef.current?.click();
  }, []);

  const handleThemeImport = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      if (files.length === 0) return;

      setIsImportingThemes(true);
      const importedThemeNames: string[] = [];

      for (const file of files) {
        try {
          const importedTheme = importTheme(await file.text());
          importedThemeNames.push(importedTheme.name);
        } catch (error) {
          toastManager.add({
            type: "error",
            title: `Could not import ${file.name}`,
            description: error instanceof Error ? error.message : "The theme file is invalid JSON.",
          });
        }
      }

      if (importedThemeNames.length > 0) {
        toastManager.add({
          type: "success",
          title:
            importedThemeNames.length === 1
              ? `Imported ${importedThemeNames[0]}`
              : `Imported ${importedThemeNames.length} themes`,
          description:
            importedThemeNames.length === 1
              ? "The imported theme is now selected for its appearance."
              : "Each imported theme is now selected for its matching appearance.",
        });
      }

      setIsImportingThemes(false);
    },
    [importTheme],
  );

  useEffect(() => {
    let cancelled = false;
    setIsLoadingFonts(true);

    void loadFontCatalog()
      .then((catalog) => {
        if (!cancelled) {
          setFontCatalog(catalog);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingFonts(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const uiFontOptions = useMemo(
    () => buildFontOptions(fontCatalog.all, settings.uiFontFamily, DEFAULT_UI_FONT_OPTION),
    [fontCatalog.all, settings.uiFontFamily],
  );
  const filteredUiFontOptions = useMemo(
    () => filterFontOptions(uiFontOptions, uiFontSearch),
    [uiFontOptions, uiFontSearch],
  );
  const codeFontOptions = useMemo(
    () =>
      buildFontOptions(fontCatalog.monospace, settings.codeFontFamily, DEFAULT_CODE_FONT_OPTION),
    [fontCatalog.monospace, settings.codeFontFamily],
  );
  const filteredCodeFontOptions = useMemo(
    () => filterFontOptions(codeFontOptions, codeFontSearch),
    [codeFontOptions, codeFontSearch],
  );
  const installedUiFontCount = Math.max(0, uiFontOptions.length - 1);
  const installedCodeFontCount = Math.max(0, codeFontOptions.length - 1);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Themes">
        <SettingsRow
          title="Theme mode"
          description="Choose when the app resolves to its light or dark appearance."
          resetAction={
            theme !== DEFAULT_UNIFIED_SETTINGS.themeMode ? (
              <ResetButton label="theme mode" onClick={() => setTheme("system")} />
            ) : null
          }
          control={
            <Select
              value={theme}
              onValueChange={(value) => {
                if (value === "system" || value === "light" || value === "dark") {
                  setTheme(value);
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
                <SelectValue>
                  {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {THEME_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title={APPEARANCE_THEME_LABELS.light}
          description="Used whenever the app resolves to its light appearance."
          resetAction={
            lightThemeId !== DEFAULT_LIGHT_THEME_ID ? (
              <ResetButton
                label="light theme"
                onClick={() => setThemeAssignment("light", DEFAULT_LIGHT_THEME_ID)}
              />
            ) : null
          }
          control={
            <Select
              value={lightThemeId}
              onValueChange={(value) => {
                if (value) setThemeAssignment("light", value);
              }}
            >
              <SelectTrigger className="w-full sm:w-52" aria-label="Light theme">
                <SelectValue>
                  {themeOptionsByAppearance.light.find((option) => option.id === lightThemeId)
                    ?.name ?? "Shiori Light"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {themeOptionsByAppearance.light.map((option) => (
                  <SelectItem hideIndicator key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title={APPEARANCE_THEME_LABELS.dark}
          description="Used whenever the app resolves to its dark appearance."
          resetAction={
            darkThemeId !== DEFAULT_DARK_THEME_ID ? (
              <ResetButton
                label="dark theme"
                onClick={() => setThemeAssignment("dark", DEFAULT_DARK_THEME_ID)}
              />
            ) : null
          }
          control={
            <Select
              value={darkThemeId}
              onValueChange={(value) => {
                if (value) setThemeAssignment("dark", value);
              }}
            >
              <SelectTrigger className="w-full sm:w-52" aria-label="Dark theme">
                <SelectValue>
                  {themeOptionsByAppearance.dark.find((option) => option.id === darkThemeId)
                    ?.name ?? "Shiori Dark"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {themeOptionsByAppearance.dark.map((option) => (
                  <SelectItem hideIndicator key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Import themes"
          description="Import JSON theme files. Each file targets either the light or dark appearance and becomes the active theme for that appearance."
          control={
            <>
              <input
                ref={themeImportInputRef}
                type="file"
                accept=".json,application/json"
                multiple
                className="hidden"
                onChange={handleThemeImport}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={isImportingThemes}
                onClick={openThemeImportDialog}
              >
                {isImportingThemes ? <LoadingText>Importing themes</LoadingText> : "Import JSON"}
              </Button>
            </>
          }
        >
          {importedThemes.length > 0 ? (
            <div className="mt-4 space-y-2">
              {importedThemes.map((customTheme) => (
                <div
                  key={customTheme.id}
                  className="flex flex-col gap-2 rounded-xl border border-border/80 bg-background/60 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-foreground">{customTheme.name}</p>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                        {customTheme.appearance}
                      </span>
                      {customTheme.appearance === "light" && lightThemeId === customTheme.id ? (
                        <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-primary">
                          Active
                        </span>
                      ) : null}
                      {customTheme.appearance === "dark" && darkThemeId === customTheme.id ? (
                        <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-primary">
                          Active
                        </span>
                      ) : null}
                    </div>
                    {customTheme.description ? (
                      <p className="text-xs text-muted-foreground">{customTheme.description}</p>
                    ) : null}
                    <p className="text-[11px] text-muted-foreground/80">
                      {customTheme.author ? `By ${customTheme.author}` : "Imported theme"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => setThemeAssignment(customTheme.appearance, customTheme.id)}
                    >
                      Use
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Remove ${customTheme.name}`}
                      onClick={() => removeImportedTheme(customTheme.id)}
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-dashed border-border/80 bg-background/40 px-3 py-4 text-xs text-muted-foreground">
              Imported themes will appear here after you add a JSON file.
            </div>
          )}

          <Link
            to="/settings/theme-builder"
            className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <PaintbrushIcon className="size-3" />
            Build your own theme
          </Link>
        </SettingsRow>
      </SettingsSection>

      {isElectron ? (
        <SettingsSection title="Window">
          <SettingsRow
            title="Translucent sidebar"
            description="Make the sidebar translucent so desktop content is visible behind it. macOS only."
            resetAction={
              settings.sidebarTranslucent !== DEFAULT_UNIFIED_SETTINGS.sidebarTranslucent ? (
                <ResetButton
                  label="translucent sidebar"
                  onClick={() => updateSettings({ sidebarTranslucent: false })}
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.sidebarTranslucent}
                onCheckedChange={(checked) =>
                  updateSettings({ sidebarTranslucent: Boolean(checked) })
                }
                aria-label="Enable translucent sidebar"
              />
            }
          />
        </SettingsSection>
      ) : null}

      <SettingsSection title="Interface">
        <SettingsRow
          title="Hide personal details"
          description="Mask personal details in the interface to reduce casual on-screen exposure."
          resetAction={
            settings.blurPersonalData !== DEFAULT_UNIFIED_SETTINGS.blurPersonalData ? (
              <ResetButton
                label="personal details masking"
                onClick={() =>
                  updateSettings({
                    blurPersonalData: DEFAULT_UNIFIED_SETTINGS.blurPersonalData,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.blurPersonalData}
              onCheckedChange={(checked) => updateSettings({ blurPersonalData: Boolean(checked) })}
              aria-label="Hide personal details"
            />
          }
        />

        <SettingsRow
          title="UI font"
          description="Choose the interface font. Installed fonts load from your system when available."
          status={
            isLoadingFonts
              ? "Loading installed fonts..."
              : installedUiFontCount > 0
                ? `${installedUiFontCount} installed fonts available.`
                : "Using system defaults only."
          }
          resetAction={
            settings.uiFontFamily !== DEFAULT_UNIFIED_SETTINGS.uiFontFamily ? (
              <ResetButton
                label="UI font"
                onClick={() =>
                  updateSettings({
                    uiFontFamily: DEFAULT_UNIFIED_SETTINGS.uiFontFamily,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.uiFontFamily}
              onOpenChange={(open) => {
                if (!open) {
                  setUiFontSearch("");
                }
              }}
              onValueChange={(value) => {
                if (value) {
                  updateSettings({ uiFontFamily: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-56" aria-label="UI font">
                <SelectValue>
                  {uiFontOptions.find((option) => option.value === settings.uiFontFamily)?.label ??
                    DEFAULT_UI_FONT_OPTION.label}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup
                align="end"
                alignItemWithTrigger={false}
                header={
                  <Input
                    autoFocus
                    value={uiFontSearch}
                    placeholder="Search fonts"
                    aria-label="Search UI fonts"
                    className="h-8"
                    onChange={(event) => setUiFontSearch(event.target.value)}
                    onKeyDown={(event) => event.stopPropagation()}
                  />
                }
                listClassName="max-h-[min(var(--available-height),18rem)]"
              >
                {filteredUiFontOptions.length > 0 ? (
                  filteredUiFontOptions.map((option) => (
                    <SelectItem hideIndicator key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))
                ) : (
                  <div className="px-3 py-2 text-sm text-muted-foreground">No fonts found.</div>
                )}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Code font"
          description="Choose the monospace font used for code, diffs, terminals, and inline shortcuts."
          status={
            isLoadingFonts
              ? "Loading installed fonts..."
              : installedCodeFontCount > 0
                ? `${installedCodeFontCount} monospace fonts available.`
                : "Using system monospace by default."
          }
          resetAction={
            settings.codeFontFamily !== DEFAULT_UNIFIED_SETTINGS.codeFontFamily ? (
              <ResetButton
                label="code font"
                onClick={() =>
                  updateSettings({
                    codeFontFamily: DEFAULT_UNIFIED_SETTINGS.codeFontFamily,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.codeFontFamily}
              onOpenChange={(open) => {
                if (!open) {
                  setCodeFontSearch("");
                }
              }}
              onValueChange={(value) => {
                if (value) {
                  updateSettings({ codeFontFamily: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-56" aria-label="Code font">
                <SelectValue>
                  {codeFontOptions.find((option) => option.value === settings.codeFontFamily)
                    ?.label ?? DEFAULT_CODE_FONT_OPTION.label}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup
                align="end"
                alignItemWithTrigger={false}
                header={
                  <Input
                    autoFocus
                    value={codeFontSearch}
                    placeholder="Search fonts"
                    aria-label="Search code fonts"
                    className="h-8"
                    onChange={(event) => setCodeFontSearch(event.target.value)}
                    onKeyDown={(event) => event.stopPropagation()}
                  />
                }
                listClassName="max-h-[min(var(--available-height),18rem)]"
              >
                {filteredCodeFontOptions.length > 0 ? (
                  filteredCodeFontOptions.map((option) => (
                    <SelectItem hideIndicator key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))
                ) : (
                  <div className="px-3 py-2 text-sm text-muted-foreground">No fonts found.</div>
                )}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Time format"
          description="System default follows your browser or OS clock preference."
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <ResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Diff line wrapping"
          description="Set the default wrap state when the diff panel opens."
          resetAction={
            settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap ? (
              <ResetButton
                label="diff line wrapping"
                onClick={() =>
                  updateSettings({
                    diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffWordWrap}
              onCheckedChange={(checked) => updateSettings({ diffWordWrap: Boolean(checked) })}
              aria-label="Wrap diff lines by default"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
