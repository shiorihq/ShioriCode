import * as FS from "node:fs";

import * as Schema from "effect/Schema";
import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  type ServerSettings as ServerSettingsShape,
} from "contracts/settings";

export function readDesktopServerSettings(
  settingsPath: string,
  onError?: (message: string, error: unknown) => void,
): ServerSettingsShape {
  try {
    if (!FS.existsSync(settingsPath)) {
      return DEFAULT_SERVER_SETTINGS;
    }

    const raw = FS.readFileSync(settingsPath, "utf8");
    return Schema.decodeUnknownSync(ServerSettings)(JSON.parse(raw));
  } catch (error: unknown) {
    onError?.("Failed to read desktop settings; using defaults instead.", error);
    return DEFAULT_SERVER_SETTINGS;
  }
}

export function shouldConfirmBeforeQuit(
  settingsPath: string,
  onError?: (message: string, error: unknown) => void,
): boolean {
  return !readDesktopServerSettings(settingsPath, onError).quitWithoutConfirmation;
}
