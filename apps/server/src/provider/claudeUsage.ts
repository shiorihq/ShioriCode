import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

import type {
  ClaudeExtraUsageSnapshot,
  ClaudeUsageSnapshot,
  ClaudeUsageWindowSnapshot,
} from "./Services/ProviderUsage.ts";

const CLAUDE_OAUTH_USAGE_BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_REMOTE_OAUTH_TOKEN_PATH = "/home/claude/.claude/remote/.oauth_token";
const CLAUDE_KEYCHAIN_SERVICE_SUFFIX = "-credentials";
const CLAUDE_KEYCHAIN_TIMEOUT_MS = 2_000;
const CLAUDE_USAGE_FETCH_TIMEOUT_MS = 8_000;

interface ClaudeStoredOAuth {
  readonly accessToken: string;
  readonly refreshToken?: string | null;
  readonly expiresAt?: string | null;
  readonly scopes?: ReadonlyArray<string> | null;
  readonly subscriptionType?: string | null;
  readonly rateLimitTier?: string | null;
}

interface ClaudeCredentialsFile {
  readonly claudeAiOauth?: ClaudeStoredOAuth | null;
}

interface ClaudeOAuthUsageResponse {
  readonly five_hour?: unknown;
  readonly seven_day?: unknown;
  readonly seven_day_oauth_apps?: unknown;
  readonly seven_day_opus?: unknown;
  readonly seven_day_sonnet?: unknown;
  readonly extra_usage?: unknown;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getClaudeConfigHomeDir(): string {
  return (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")).normalize("NFC");
}

function getClaudeCredentialsPath(): string {
  return join(getClaudeConfigHomeDir(), ".credentials.json");
}

function getMacOsKeychainStorageServiceName(): string {
  const configDir = getClaudeConfigHomeDir();
  const isDefaultDir = !process.env.CLAUDE_CONFIG_DIR;
  const dirHash = isDefaultDir
    ? ""
    : `-${createHash("sha256").update(configDir).digest("hex").substring(0, 8)}`;
  return `Claude Code${CLAUDE_KEYCHAIN_SERVICE_SUFFIX}${dirHash}`;
}

function getUsername(): string {
  try {
    return process.env.USER || userInfo().username;
  } catch {
    return "claude-code-user";
  }
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function readTokenFromFileDescriptor(): string | null {
  const fdEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
  if (!fdEnv) {
    return null;
  }

  const fd = Number.parseInt(fdEnv, 10);
  if (!Number.isInteger(fd)) {
    return null;
  }

  try {
    const fdPath =
      process.platform === "darwin" || process.platform === "freebsd"
        ? `/dev/fd/${fd}`
        : `/proc/self/fd/${fd}`;
    const token = readFileSync(fdPath, "utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function readTokenFromWellKnownRemotePath(): string | null {
  try {
    const token = readFileSync(CLAUDE_REMOTE_OAUTH_TOKEN_PATH, "utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function readClaudeStoredOAuthFromKeychain(): ClaudeStoredOAuth | null {
  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const raw = execFileSync(
      "security",
      [
        "find-generic-password",
        "-a",
        getUsername(),
        "-w",
        "-s",
        getMacOsKeychainStorageServiceName(),
      ],
      { encoding: "utf8", timeout: CLAUDE_KEYCHAIN_TIMEOUT_MS },
    ).trim();
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as ClaudeCredentialsFile;
    return parsed.claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

function resolveClaudeStoredOAuth(): ClaudeStoredOAuth | null {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      scopes: null,
      subscriptionType: null,
      rateLimitTier: null,
    };
  }

  const fdToken = readTokenFromFileDescriptor() ?? readTokenFromWellKnownRemotePath();
  if (fdToken) {
    return {
      accessToken: fdToken,
      scopes: null,
      subscriptionType: null,
      rateLimitTier: null,
    };
  }

  const fileCredentials = readJsonFile<ClaudeCredentialsFile>(getClaudeCredentialsPath());
  if (fileCredentials?.claudeAiOauth?.accessToken) {
    return fileCredentials.claudeAiOauth;
  }

  return readClaudeStoredOAuthFromKeychain();
}

function buildUnavailableClaudeUsageSnapshot(
  storedOAuth: ClaudeStoredOAuth | null,
  reason: string,
): ClaudeUsageSnapshot {
  return {
    provider: "claudeAgent",
    source: "oauth-api",
    fetchedAt: new Date().toISOString(),
    available: false,
    unavailableReason: reason,
    auth: {
      subscriptionType: storedOAuth?.subscriptionType ?? null,
      rateLimitTier: storedOAuth?.rateLimitTier ?? null,
      scopes: storedOAuth?.scopes ? [...storedOAuth.scopes] : null,
    },
    windows: {
      fiveHour: null,
      sevenDay: null,
      sevenDayOpus: null,
      sevenDaySonnet: null,
      sevenDayOauthApps: null,
    },
    extraUsage: null,
  };
}

function readClaudeUsageWindow(value: unknown): ClaudeUsageWindowSnapshot | null {
  const record = asObject(value);
  if (!record) {
    return null;
  }

  return {
    usedPercent: asNumber(record.utilization),
    resetsAt: asString(record.resets_at),
  };
}

function readClaudeExtraUsage(value: unknown): ClaudeExtraUsageSnapshot | null {
  const record = asObject(value);
  if (!record) {
    return null;
  }

  return {
    isEnabled: record.is_enabled === true,
    monthlyLimit: asNumber(record.monthly_limit),
    usedCredits: asNumber(record.used_credits),
    usedPercent: asNumber(record.utilization),
  };
}

function readClaudeUsageResponse(
  response: ClaudeOAuthUsageResponse,
  storedOAuth: ClaudeStoredOAuth,
): ClaudeUsageSnapshot {
  return {
    provider: "claudeAgent",
    source: "oauth-api",
    fetchedAt: new Date().toISOString(),
    available: true,
    unavailableReason: null,
    auth: {
      subscriptionType: storedOAuth.subscriptionType ?? null,
      rateLimitTier: storedOAuth.rateLimitTier ?? null,
      scopes: storedOAuth.scopes ? [...storedOAuth.scopes] : null,
    },
    windows: {
      fiveHour: readClaudeUsageWindow(response.five_hour),
      sevenDay: readClaudeUsageWindow(response.seven_day),
      sevenDayOpus: readClaudeUsageWindow(response.seven_day_opus),
      sevenDaySonnet: readClaudeUsageWindow(response.seven_day_sonnet),
      sevenDayOauthApps: readClaudeUsageWindow(response.seven_day_oauth_apps),
    },
    extraUsage: readClaudeExtraUsage(response.extra_usage),
  };
}

export async function fetchClaudeUsageSnapshot(input?: {
  readonly signal?: AbortSignal;
}): Promise<ClaudeUsageSnapshot> {
  const storedOAuth = resolveClaudeStoredOAuth();
  if (!storedOAuth?.accessToken) {
    return buildUnavailableClaudeUsageSnapshot(
      storedOAuth,
      "No Claude OAuth token is available for usage reporting.",
    );
  }

  if (storedOAuth.scopes && !storedOAuth.scopes.includes("user:profile")) {
    return buildUnavailableClaudeUsageSnapshot(
      storedOAuth,
      "Claude usage reporting requires an OAuth token with user:profile scope.",
    );
  }

  const timeoutSignal = AbortSignal.timeout(CLAUDE_USAGE_FETCH_TIMEOUT_MS);
  const signal = input?.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  let response: Response;

  try {
    response = await fetch(
      `${process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/api/oauth/usage`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${storedOAuth.accessToken}`,
          "anthropic-beta": CLAUDE_OAUTH_USAGE_BETA_HEADER,
          "Content-Type": "application/json",
        },
        signal,
      },
    );
  } catch (error) {
    return buildUnavailableClaudeUsageSnapshot(
      storedOAuth,
      error instanceof Error && error.name === "TimeoutError"
        ? "Claude usage request timed out."
        : `Claude usage request failed: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    return buildUnavailableClaudeUsageSnapshot(
      storedOAuth,
      `Claude usage endpoint rejected the current OAuth token (${response.status}).`,
    );
  }

  if (response.status === 429 || response.status >= 500) {
    return buildUnavailableClaudeUsageSnapshot(
      storedOAuth,
      `Claude usage endpoint is temporarily unavailable (${response.status}).`,
    );
  }

  if (!response.ok) {
    return buildUnavailableClaudeUsageSnapshot(
      storedOAuth,
      `Claude usage request failed: ${response.status} ${response.statusText}`,
    );
  }

  const parsed = (await response.json().catch(() => null)) as ClaudeOAuthUsageResponse | null;
  if (!parsed) {
    return buildUnavailableClaudeUsageSnapshot(
      storedOAuth,
      "Claude usage endpoint returned malformed JSON.",
    );
  }
  return readClaudeUsageResponse(parsed, storedOAuth);
}
