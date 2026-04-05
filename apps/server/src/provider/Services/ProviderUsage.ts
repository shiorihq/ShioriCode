export interface ProviderUsageWindowSnapshot {
  readonly usedPercent: number | null;
  readonly windowDurationMinutes: number | null;
  readonly resetsAt: string | null;
}

export interface CodexCreditsUsageSnapshot {
  readonly hasCredits: boolean;
  readonly unlimited: boolean;
  readonly balance: string | null;
}

export interface CodexRateLimitUsageSnapshot {
  readonly limitId: string | null;
  readonly limitName: string | null;
  readonly primary: ProviderUsageWindowSnapshot | null;
  readonly secondary: ProviderUsageWindowSnapshot | null;
  readonly credits: CodexCreditsUsageSnapshot | null;
  readonly planType: string | null;
}

export interface CodexUsageSnapshot {
  readonly provider: "codex";
  readonly source: "app-server";
  readonly fetchedAt: string;
  readonly rateLimits: CodexRateLimitUsageSnapshot | null;
  readonly rateLimitsByLimitId: Readonly<Record<string, CodexRateLimitUsageSnapshot>>;
}

export interface ClaudeExtraUsageSnapshot {
  readonly isEnabled: boolean;
  readonly monthlyLimit: number | null;
  readonly usedCredits: number | null;
  readonly usedPercent: number | null;
}

export interface ClaudeUsageWindowSnapshot {
  readonly usedPercent: number | null;
  readonly resetsAt: string | null;
}

export interface ClaudeUsageSnapshot {
  readonly provider: "claudeAgent";
  readonly source: "oauth-api";
  readonly fetchedAt: string;
  readonly available: boolean;
  readonly unavailableReason: string | null;
  readonly auth: {
    readonly subscriptionType: string | null;
    readonly rateLimitTier: string | null;
    readonly scopes: ReadonlyArray<string> | null;
  };
  readonly windows: {
    readonly fiveHour: ClaudeUsageWindowSnapshot | null;
    readonly sevenDay: ClaudeUsageWindowSnapshot | null;
    readonly sevenDayOpus: ClaudeUsageWindowSnapshot | null;
    readonly sevenDaySonnet: ClaudeUsageWindowSnapshot | null;
    readonly sevenDayOauthApps: ClaudeUsageWindowSnapshot | null;
  };
  readonly extraUsage: ClaudeExtraUsageSnapshot | null;
}
