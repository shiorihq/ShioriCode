import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CodexUsageSnapshot, ProviderUsageWindowSnapshot } from "./Services/ProviderUsage.ts";

interface CodexOAuthCredentials {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string | null;
  readonly accountId: string | null;
}

interface CodexUsageResponse {
  readonly rate_limit?: {
    readonly primary_window?: unknown;
    readonly secondary_window?: unknown;
  };
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

function resolveCodexHomePath(homePath?: string): string {
  return homePath?.trim() ? homePath : join(homedir(), ".codex");
}

function parseCodexOAuthCredentials(data: string): CodexOAuthCredentials | null {
  const parsed = JSON.parse(data) as Record<string, unknown>;

  if (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim().length > 0) {
    return null;
  }

  const tokens = asObject(parsed.tokens);
  if (!tokens) {
    return null;
  }

  const accessToken = asString(tokens.access_token ?? tokens.accessToken);
  const refreshToken = asString(tokens.refresh_token ?? tokens.refreshToken);
  if (!accessToken || !refreshToken) {
    return null;
  }

  return {
    accessToken,
    refreshToken,
    idToken: asString(tokens.id_token ?? tokens.idToken),
    accountId: asString(tokens.account_id ?? tokens.accountId),
  };
}

function loadCodexOAuthCredentials(homePath?: string): CodexOAuthCredentials | null {
  try {
    const authPath = join(resolveCodexHomePath(homePath), "auth.json");
    return parseCodexOAuthCredentials(readFileSync(authPath, "utf8"));
  } catch {
    return null;
  }
}

function loadCodexBaseUrl(homePath?: string): string {
  try {
    const configPath = join(resolveCodexHomePath(homePath), "config.toml");
    const contents = readFileSync(configPath, "utf8");
    for (const rawLine of contents.split(/\r?\n/u)) {
      const line = rawLine.split("#", 1)[0]?.trim() ?? "";
      if (!line.startsWith("chatgpt_base_url")) continue;
      const [, rawValue] = line.split("=", 2);
      const cleaned = rawValue?.trim().replace(/^["']|["']$/gu, "");
      if (cleaned) {
        return cleaned;
      }
    }
  } catch {
    // fall through
  }

  return "https://chatgpt.com/backend-api";
}

function normalizeCodexBaseUrl(value: string): string {
  let trimmed = value.trim();
  while (trimmed.endsWith("/")) {
    trimmed = trimmed.slice(0, -1);
  }
  if (
    (trimmed.startsWith("https://chatgpt.com") || trimmed.startsWith("https://chat.openai.com")) &&
    !trimmed.includes("/backend-api")
  ) {
    trimmed += "/backend-api";
  }
  return trimmed;
}

function resolveCodexUsageUrl(homePath?: string): string {
  const normalizedBaseUrl = normalizeCodexBaseUrl(loadCodexBaseUrl(homePath));
  const path = normalizedBaseUrl.includes("/backend-api") ? "/wham/usage" : "/api/codex/usage";
  return `${normalizedBaseUrl}${path}`;
}

function toIsoFromEpochSeconds(value: unknown): string | null {
  const seconds = asNumber(value);
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

function mapWindow(window: unknown): ProviderUsageWindowSnapshot | null {
  const record = asObject(window);
  if (!record) {
    return null;
  }

  const durationSeconds =
    asNumber(record.limit_window_seconds) ?? asNumber(record.limitWindowSeconds);

  return {
    usedPercent: asNumber(record.used_percent) ?? asNumber(record.usedPercent),
    resetsAt: toIsoFromEpochSeconds(record.reset_at ?? record.resetAt),
    windowDurationMinutes: durationSeconds === null ? null : Math.round(durationSeconds / 60),
  };
}

export async function fetchCodexOAuthUsageSnapshot(input?: {
  readonly homePath?: string;
  readonly signal?: AbortSignal;
}): Promise<CodexUsageSnapshot | null> {
  const credentials = loadCodexOAuthCredentials(input?.homePath);
  if (!credentials) {
    return null;
  }

  const response = await fetch(resolveCodexUsageUrl(input?.homePath), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
      "User-Agent": "CodexBar",
      ...(credentials.accountId ? { "ChatGPT-Account-Id": credentials.accountId } : {}),
    },
    ...(input?.signal ? { signal: input.signal } : {}),
  });

  if (!response.ok) {
    return null;
  }

  const parsed = (await response.json()) as CodexUsageResponse;

  return {
    provider: "codex",
    source: "app-server",
    fetchedAt: new Date().toISOString(),
    rateLimits: {
      limitId: "codex",
      limitName: null,
      primary: mapWindow(parsed.rate_limit?.primary_window),
      secondary: mapWindow(parsed.rate_limit?.secondary_window),
      credits: null,
      planType: null,
    },
    rateLimitsByLimitId: {},
  };
}
