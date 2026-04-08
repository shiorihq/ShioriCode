import fs from "node:fs";
import { spawnSync } from "node:child_process";

import { compareCodexCliVersions, parseCodexCliVersion } from "./codexCliVersion";

export const DEFAULT_CODEX_BINARY_PATH = "codex";
export const MACOS_CODEX_APP_BINARY_PATH = "/Applications/Codex.app/Contents/Resources/codex";
export const MINIMUM_CODEX_REASONING_SUMMARY_VERSION = "0.118.0-alpha.1";

function isExecutable(path: string): boolean {
  try {
    fs.accessSync(path, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function readCodexBinaryVersion(binaryPath: string): string | null {
  if (binaryPath.trim().length === 0) {
    return null;
  }

  const result = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 4_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return null;
  }

  return parseCodexCliVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

export function resolvePreferredCodexBinaryPath(configuredBinaryPath: string): string {
  const normalized = configuredBinaryPath.trim() || DEFAULT_CODEX_BINARY_PATH;
  if (normalized !== DEFAULT_CODEX_BINARY_PATH) {
    return normalized;
  }

  if (process.platform !== "darwin" || !isExecutable(MACOS_CODEX_APP_BINARY_PATH)) {
    return normalized;
  }

  const defaultVersion = readCodexBinaryVersion(normalized);
  const appVersion = readCodexBinaryVersion(MACOS_CODEX_APP_BINARY_PATH);
  if (!appVersion) {
    return normalized;
  }
  if (!defaultVersion || compareCodexCliVersions(appVersion, defaultVersion) > 0) {
    return MACOS_CODEX_APP_BINARY_PATH;
  }

  return normalized;
}

export function supportsCodexReasoningSummary(binaryPath: string): boolean {
  const version = readCodexBinaryVersion(binaryPath);
  if (!version) {
    return false;
  }

  return compareCodexCliVersions(version, MINIMUM_CODEX_REASONING_SUMMARY_VERSION) >= 0;
}
