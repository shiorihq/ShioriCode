import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readDesktopServerSettings, shouldConfirmBeforeQuit } from "./quitConfirmation";

describe("quitConfirmation", () => {
  const tempDirectories = new Set<string>();

  afterEach(() => {
    for (const tempDirectory of tempDirectories) {
      FS.rmSync(tempDirectory, { recursive: true, force: true });
    }
    tempDirectories.clear();
  });

  function createSettingsPath(contents?: unknown): string {
    const tempDirectory = FS.mkdtempSync(Path.join(OS.tmpdir(), "shioricode-quit-settings-"));
    tempDirectories.add(tempDirectory);
    const settingsPath = Path.join(tempDirectory, "settings.json");
    if (contents !== undefined) {
      FS.writeFileSync(settingsPath, JSON.stringify(contents), "utf8");
    }
    return settingsPath;
  }

  it("defaults to asking before quit when no settings file exists", () => {
    const settingsPath = createSettingsPath();

    expect(shouldConfirmBeforeQuit(settingsPath)).toBe(true);
    expect(readDesktopServerSettings(settingsPath).quitWithoutConfirmation).toBe(false);
  });

  it("skips the quit confirmation when the setting is enabled", () => {
    const settingsPath = createSettingsPath({ quitWithoutConfirmation: true });

    expect(shouldConfirmBeforeQuit(settingsPath)).toBe(false);
  });

  it("falls back to defaults when settings parsing fails", () => {
    const tempDirectory = FS.mkdtempSync(Path.join(OS.tmpdir(), "shioricode-quit-settings-"));
    tempDirectories.add(tempDirectory);
    const settingsPath = Path.join(tempDirectory, "settings.json");
    FS.writeFileSync(settingsPath, "{not valid json", "utf8");
    const onError = vi.fn();

    expect(shouldConfirmBeforeQuit(settingsPath, onError)).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
