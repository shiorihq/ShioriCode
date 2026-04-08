import { type ChangeEvent, useCallback, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { PaintbrushIcon, Undo2Icon, XIcon } from "lucide-react";
import {
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_UNIFIED_SETTINGS,
} from "contracts/settings";

import { isElectron } from "../../env";
import { useTheme } from "../../hooks/useTheme";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { LoadingText } from "../ui/loading-text";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./SettingsPanels";

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
    </SettingsPageContainer>
  );
}
