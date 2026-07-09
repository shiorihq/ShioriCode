import type {
  CodexCreditsUsageSnapshot,
  CodexIndividualLimitUsageSnapshot,
  CodexRateLimitUsageSnapshot,
  CodexUsageSnapshot,
  ProviderUsageWindowSnapshot,
} from "./Services/ProviderUsage.ts";

export type CodexPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "self_serve_business_usage_based"
  | "business"
  | "enterprise_cbp_usage_based"
  | "enterprise"
  | "edu"
  | "unknown";

export interface CodexAccountSnapshot {
  readonly type: "apiKey" | "chatgpt" | "amazonBedrock" | "unknown";
  readonly planType: CodexPlanType | null;
  readonly sparkEnabled: boolean;
}

export const CODEX_DEFAULT_MODEL = "gpt-5.6-luna";
const CODEX_SPARK_ENABLED_PLAN_TYPES = new Set<CodexPlanType>(["pro"]);
const CODEX_PLAN_TYPES = new Set<CodexPlanType>([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
]);

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readCodexPlanType(value: unknown): CodexPlanType {
  const planType = asString(value);
  if (planType && CODEX_PLAN_TYPES.has(planType as CodexPlanType)) {
    return planType as CodexPlanType;
  }
  return "unknown";
}

function normalizeCodexResetTimestamp(value: unknown): string | null {
  const epochSeconds = asNumber(value);
  if (epochSeconds === undefined) {
    return null;
  }
  return new Date(epochSeconds * 1000).toISOString();
}

function readCodexUsageWindow(value: unknown): ProviderUsageWindowSnapshot | null {
  const record = asObject(value);
  if (!record) {
    return null;
  }

  return {
    usedPercent: asNumber(record.usedPercent) ?? null,
    windowDurationMinutes: asNumber(record.windowDurationMins) ?? null,
    resetsAt: normalizeCodexResetTimestamp(record.resetsAt),
  };
}

function readCodexCreditsSnapshot(value: unknown): CodexCreditsUsageSnapshot | null {
  const record = asObject(value);
  if (!record) {
    return null;
  }

  return {
    hasCredits: record.hasCredits === true,
    unlimited: record.unlimited === true,
    balance: asString(record.balance) ?? null,
  };
}

function readCodexIndividualLimitSnapshot(
  value: unknown,
): CodexIndividualLimitUsageSnapshot | null {
  const record = asObject(value);
  if (!record) {
    return null;
  }

  return {
    limit: asString(record.limit) ?? null,
    used: asString(record.used) ?? null,
    remainingPercent: asNumber(record.remainingPercent) ?? null,
    resetsAt: normalizeCodexResetTimestamp(record.resetsAt),
  };
}

function readCodexRateLimitSnapshot(value: unknown): CodexRateLimitUsageSnapshot | null {
  const record = asObject(value);
  if (!record) {
    return null;
  }

  return {
    limitId: asString(record.limitId) ?? null,
    limitName: asString(record.limitName) ?? null,
    primary: readCodexUsageWindow(record.primary),
    secondary: readCodexUsageWindow(record.secondary),
    credits: readCodexCreditsSnapshot(record.credits),
    individualLimit: readCodexIndividualLimitSnapshot(record.individualLimit),
    planType: asString(record.planType) ?? null,
    rateLimitReachedType: asString(record.rateLimitReachedType) ?? null,
  };
}

export function readCodexAccountSnapshot(response: unknown): CodexAccountSnapshot {
  const record = asObject(response);
  const account = asObject(record?.account) ?? record;
  const accountType = asString(account?.type);

  if (accountType === "apiKey") {
    return {
      type: "apiKey",
      planType: null,
      sparkEnabled: false,
    };
  }

  if (accountType === "chatgpt") {
    const planType = readCodexPlanType(account?.planType);
    return {
      type: "chatgpt",
      planType,
      sparkEnabled: CODEX_SPARK_ENABLED_PLAN_TYPES.has(planType),
    };
  }

  if (accountType === "amazonBedrock") {
    return {
      type: "amazonBedrock",
      planType: null,
      sparkEnabled: false,
    };
  }

  return {
    type: "unknown",
    planType: null,
    sparkEnabled: false,
  };
}

export function codexAuthSubType(account: CodexAccountSnapshot | undefined): string | undefined {
  if (account?.type === "apiKey") {
    return "apiKey";
  }

  if (account?.type === "amazonBedrock") {
    return "amazonBedrock";
  }

  if (account?.type !== "chatgpt") {
    return undefined;
  }

  return account.planType && account.planType !== "unknown" ? account.planType : "chatgpt";
}

export function codexAuthSubLabel(account: CodexAccountSnapshot | undefined): string | undefined {
  switch (codexAuthSubType(account)) {
    case "apiKey":
      return "OpenAI API Key";
    case "amazonBedrock":
      return "Amazon Bedrock";
    case "chatgpt":
      return "ChatGPT Subscription";
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro Subscription";
    case "prolite":
      return "ChatGPT Pro Lite Subscription";
    case "team":
      return "ChatGPT Team Subscription";
    case "self_serve_business_usage_based":
      return "ChatGPT Business Usage-Based Subscription";
    case "business":
      return "ChatGPT Business Subscription";
    case "enterprise_cbp_usage_based":
      return "ChatGPT Enterprise Usage-Based Subscription";
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
      return "ChatGPT Edu Subscription";
    default:
      return undefined;
  }
}

export function readCodexUsageSnapshot(response: unknown): CodexUsageSnapshot {
  const record = asObject(response);
  const rateLimits = readCodexRateLimitSnapshot(record?.rateLimits);
  const rateLimitsByLimitIdRecord = asObject(record?.rateLimitsByLimitId);

  return {
    provider: "codex",
    source: "app-server",
    fetchedAt: new Date().toISOString(),
    rateLimits,
    rateLimitsByLimitId: Object.fromEntries(
      Object.entries(rateLimitsByLimitIdRecord ?? {})
        .map(([limitId, snapshot]) => [limitId, readCodexRateLimitSnapshot(snapshot)] as const)
        .filter((entry): entry is [string, CodexRateLimitUsageSnapshot] => entry[1] !== null),
    ),
  };
}

export function resolveCodexModelForAccount(
  model: string | undefined,
  _account: CodexAccountSnapshot,
): string | undefined {
  return model;
}
