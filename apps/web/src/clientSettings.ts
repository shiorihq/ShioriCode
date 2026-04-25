import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "contracts";
import * as Schema from "effect/Schema";

export const CLIENT_SETTINGS_STORAGE_KEY = "shioricode:client-settings:v1";
export const LEGACY_SETTINGS_KEY = "shioricode:app-settings:v1";
export const LEGACY_THEME_STORAGE_KEY = "shioricode:theme";

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (_) => store.get(_) ?? null,
    key: (_) => Array.from(store.keys()).at(_) ?? null,
    get length() {
      return store.size;
    },
    removeItem: (_) => store.delete(_),
    setItem: (_, value) => store.set(_, value),
  };
}

function isStorageLike(value: unknown): value is Storage {
  return (
    typeof value === "object" &&
    value !== null &&
    "getItem" in value &&
    typeof value.getItem === "function" &&
    "setItem" in value &&
    typeof value.setItem === "function" &&
    "removeItem" in value &&
    typeof value.removeItem === "function"
  );
}

const isomorphicLocalStorage: Storage = isStorageLike(
  typeof window !== "undefined" ? window.localStorage : undefined,
)
  ? window.localStorage
  : isStorageLike(globalThis.localStorage)
    ? globalThis.localStorage
    : createMemoryStorage();

const decodeClientSettings = Schema.decodeSync(Schema.fromJsonString(ClientSettingsSchema));
const encodeClientSettings = Schema.encodeSync(Schema.fromJsonString(ClientSettingsSchema));

export function resolveBlurPersonalDataSetting(input: {
  fallbackValue: boolean;
  hostedBlurPersonalData?: boolean | undefined;
  hostedBlurPersonalDataLoading?: boolean | undefined;
  isAuthenticated: boolean;
}): boolean {
  if (!input.isAuthenticated) {
    return input.fallbackValue;
  }
  if (input.hostedBlurPersonalData !== undefined) {
    return input.hostedBlurPersonalData;
  }
  if (input.hostedBlurPersonalDataLoading) {
    return true;
  }
  return input.fallbackValue;
}

export function readStoredClientSettings(): ClientSettings {
  const raw = isomorphicLocalStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY);
  const settings = (() => {
    if (!raw) {
      return DEFAULT_CLIENT_SETTINGS;
    }

    try {
      return decodeClientSettings(raw);
    } catch {
      return DEFAULT_CLIENT_SETTINGS;
    }
  })();

  const legacyThemeMode = readLegacyThemeMode();
  return legacyThemeMode ? { ...settings, themeMode: legacyThemeMode } : settings;
}

export function writeStoredClientSettings(settings: ClientSettings): void {
  isomorphicLocalStorage.setItem(CLIENT_SETTINGS_STORAGE_KEY, encodeClientSettings(settings));
}

export function readLegacyThemeMode(): ClientSettings["themeMode"] | null {
  const raw = isomorphicLocalStorage.getItem(LEGACY_THEME_STORAGE_KEY);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : null;
}

export function removeLegacyThemeMode(): void {
  isomorphicLocalStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
}

export function writeLegacyThemeMode(themeMode: ClientSettings["themeMode"]): void {
  isomorphicLocalStorage.setItem(LEGACY_THEME_STORAGE_KEY, themeMode);
}

export function clearStoredClientSettings(): void {
  isomorphicLocalStorage.clear();
}
