import {
  type ImportedTheme,
  type ThemeAppearance,
  type ThemeMode,
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
} from "contracts/settings";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useLocalStorage } from "./useLocalStorage";
import { CLIENT_SETTINGS_STORAGE_KEY } from "../clientSettings";
import {
  applyStoredThemeToDocument,
  applyThemeToDocument,
  getThemeOptions,
  parseImportedThemeJson,
  removeImportedThemeFromSettings,
  resolveDocumentThemeState,
  upsertImportedTheme,
} from "../lib/theme";

const MEDIA_QUERY = "(prefers-color-scheme: dark)";

let lastDesktopTheme: ThemeMode | null = null;

function getSystemDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(MEDIA_QUERY).matches;
}

function subscribeToSystemDark(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }

  const query = window.matchMedia(MEDIA_QUERY);
  query.addEventListener("change", listener);
  return () => {
    query.removeEventListener("change", listener);
  };
}

function syncDesktopTheme(theme: ThemeMode) {
  const bridge = window.desktopBridge;
  if (!bridge || lastDesktopTheme === theme) {
    return;
  }

  lastDesktopTheme = theme;
  void bridge.setTheme(theme).catch(() => {
    if (lastDesktopTheme === theme) {
      lastDesktopTheme = null;
    }
  });
}

if (typeof document !== "undefined") {
  applyStoredThemeToDocument(getSystemDark());
}

export function useTheme() {
  const [clientSettings, setClientSettings] = useLocalStorage(
    CLIENT_SETTINGS_STORAGE_KEY,
    DEFAULT_CLIENT_SETTINGS,
    ClientSettingsSchema,
  );
  const systemDark = useSyncExternalStore(subscribeToSystemDark, getSystemDark, () => false);

  const { activeTheme, resolvedTheme } = useMemo(
    () => resolveDocumentThemeState(clientSettings, systemDark),
    [clientSettings, systemDark],
  );

  const themeOptionsByAppearance = useMemo(
    () => ({
      light: getThemeOptions(clientSettings, "light"),
      dark: getThemeOptions(clientSettings, "dark"),
    }),
    [clientSettings],
  );

  const setTheme = useCallback(
    (next: ThemeMode) => {
      setClientSettings((current) => ({
        ...current,
        themeMode: next,
      }));
      syncDesktopTheme(next);
    },
    [setClientSettings],
  );

  const setThemeAssignment = useCallback(
    (appearance: ThemeAppearance, themeId: string) => {
      setClientSettings((current) => ({
        ...current,
        ...(appearance === "light" ? { lightThemeId: themeId } : { darkThemeId: themeId }),
      }));
    },
    [setClientSettings],
  );

  const importTheme = useCallback(
    (jsonText: string): ImportedTheme => {
      let importedTheme: ImportedTheme | null = null;
      setClientSettings((current) => ({
        ...current,
        ...(() => {
          const nextTheme = parseImportedThemeJson(jsonText, current.importedThemes);
          importedTheme = nextTheme;
          return {
            importedThemes: upsertImportedTheme(current.importedThemes, nextTheme),
            ...(nextTheme.appearance === "light"
              ? { lightThemeId: nextTheme.id }
              : { darkThemeId: nextTheme.id }),
          };
        })(),
      }));
      if (!importedTheme) {
        throw new Error("Could not import theme.");
      }
      return importedTheme;
    },
    [setClientSettings],
  );

  const removeImportedTheme = useCallback(
    (themeId: string) => {
      setClientSettings((current) => removeImportedThemeFromSettings(current, themeId));
    },
    [setClientSettings],
  );

  useEffect(() => {
    applyThemeToDocument(clientSettings, systemDark, true);
    syncDesktopTheme(clientSettings.themeMode);
  }, [clientSettings, systemDark]);

  return {
    theme: clientSettings.themeMode,
    setTheme,
    resolvedTheme,
    activeTheme,
    importedThemes: clientSettings.importedThemes,
    lightThemeId: clientSettings.lightThemeId,
    darkThemeId: clientSettings.darkThemeId,
    setThemeAssignment,
    importTheme,
    removeImportedTheme,
    themeOptionsByAppearance,
  } as const;
}
