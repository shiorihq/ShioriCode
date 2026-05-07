import type { ProviderKind } from "contracts";
import { PROVIDER_DISPLAY_NAMES } from "contracts";
import { useQuery as useServerQuery } from "@tanstack/react-query";
import { useQuery as useConvexQuery } from "convex/react";
import { useMemo } from "react";

import { hostedUsageStatsQuery } from "../../convex/api";
import { useHostedShioriState } from "../../convex/HostedShioriProvider";
import { useSettings } from "../../hooks/useSettings";
import { deriveLocalProviderUsageSummaries } from "../../lib/usageMetrics";
import { ensureNativeApi } from "../../nativeApi";
import { useStore } from "../../store";

type UsageMetric = {
  label: string;
  value: string;
  percent: number | null;
  danger?: boolean;
};

type ProviderUsage = {
  provider: ProviderKind;
  source: string;
  metrics: readonly UsageMetric[];
  message?: string;
};

const cardClasses =
  "relative overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-xs/5 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]";

function clampPercentage(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, value));
}

function toRemainingPercentage(usedPercent: number | null | undefined): number | null {
  const normalized = clampPercentage(usedPercent);
  return normalized === null ? null : Math.max(0, 100 - normalized);
}

function formatApproxTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 tokens";
  }
  if (value < 1_000) {
    return `${Math.round(value)} tokens`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k tokens`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k tokens`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m tokens`;
}

function formatTurnCount(value: number): string {
  return `${value} ${value === 1 ? "turn" : "turns"}`;
}

function UsageBar({ percent, danger = false }: { percent: number; danger?: boolean }) {
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={
          danger
            ? "rounded-full bg-rose-500 transition-all"
            : "rounded-full bg-foreground/25 transition-all"
        }
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function ProviderRow({ usage }: { usage: ProviderUsage }) {
  return (
    <div className="border-t border-border px-4 py-4 first:border-t-0 sm:px-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">
            {PROVIDER_DISPLAY_NAMES[usage.provider]}
          </h3>
          <p className="mt-1 text-[11px] text-muted-foreground">{usage.source}</p>
        </div>
      </div>

      {usage.message ? <p className="mt-3 text-sm text-muted-foreground">{usage.message}</p> : null}

      {usage.metrics.length > 0 ? (
        <div className="mt-3 space-y-3">
          {usage.metrics.map((metric) => (
            <div key={metric.label}>
              <div className="mb-1.5 flex items-baseline justify-between gap-4">
                <span className="text-[11px] text-muted-foreground">{metric.label}</span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {metric.value}
                </span>
              </div>
              {metric.percent !== null ? (
                <UsageBar
                  percent={metric.percent}
                  {...(metric.danger !== undefined ? { danger: metric.danger } : {})}
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function buildShioriAccountUsage(input: {
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  monthlyPercentLeft: number | null;
  fiveHourPercentLeft: number | null;
  isRateLimited: boolean;
  isBudgetExhausted: boolean;
}): ProviderUsage {
  if (input.isAuthLoading) {
    return {
      provider: "shiori",
      source: "Shiori account usage",
      metrics: [],
      message: "Loading account usage…",
    };
  }

  if (!input.isAuthenticated) {
    return {
      provider: "shiori",
      source: "Shiori account usage",
      metrics: [],
      message: "Sign in to Shiori to load account usage.",
    };
  }

  return {
    provider: "shiori",
    source: "Shiori account usage",
    metrics: [
      {
        label: "Monthly",
        value:
          input.monthlyPercentLeft !== null
            ? `${Math.round(input.monthlyPercentLeft)}% left`
            : "Unavailable",
        percent: input.monthlyPercentLeft,
        danger: input.isBudgetExhausted,
      },
      {
        label: "Session",
        value:
          input.fiveHourPercentLeft !== null
            ? `${Math.round(input.fiveHourPercentLeft)}% left`
            : "Unavailable",
        percent: input.fiveHourPercentLeft,
        danger: input.isRateLimited,
      },
    ],
  };
}

function buildRemoteProviderUsage(input: {
  provider: Extract<ProviderKind, "codex" | "claudeAgent">;
  source: string;
  isLoading: boolean;
  available: boolean;
  primaryPercent: number | null;
  secondaryPercent: number | null;
  primaryLabel: string;
  secondaryLabel: string;
  unavailableReason: string | null;
}): ProviderUsage {
  if (input.isLoading) {
    return {
      provider: input.provider,
      source: input.source,
      metrics: [],
      message: "Loading usage…",
    };
  }

  if (!input.available) {
    return {
      provider: input.provider,
      source: input.source,
      metrics: [],
      message: input.unavailableReason ?? "Usage is unavailable.",
    };
  }

  return {
    provider: input.provider,
    source: input.source,
    metrics: [
      {
        label: input.primaryLabel,
        value:
          input.primaryPercent !== null
            ? `${Math.round(input.primaryPercent)}% left`
            : "Unavailable",
        percent: input.primaryPercent,
      },
      {
        label: input.secondaryLabel,
        value:
          input.secondaryPercent !== null
            ? `${Math.round(input.secondaryPercent)}% left`
            : "Unavailable",
        percent: input.secondaryPercent,
      },
    ],
  };
}

function buildLocalProviderUsage(input: {
  provider: Extract<ProviderKind, "kimiCode" | "gemini" | "cursor">;
  last5Hours: { turns: number; approxTokens: number };
  last7Days: { turns: number; approxTokens: number };
}): ProviderUsage {
  const hasRecordedUsage = input.last5Hours.turns > 0 || input.last7Days.turns > 0;

  return {
    provider: input.provider,
    source: "Local token usage",
    metrics: [
      {
        label: "Last 5 hours",
        value: `${formatApproxTokens(input.last5Hours.approxTokens)} · ${formatTurnCount(
          input.last5Hours.turns,
        )}`,
        percent: null,
      },
      {
        label: "Last 7 days",
        value: `${formatApproxTokens(input.last7Days.approxTokens)} · ${formatTurnCount(
          input.last7Days.turns,
        )}`,
        percent: null,
      },
    ],
    ...(hasRecordedUsage ? {} : { message: "No local usage recorded yet." }),
  };
}

export function UsagePanel() {
  const settings = useSettings();
  const { isAuthenticated, isAuthLoading } = useHostedShioriState();
  const threads = useStore((store) => store.threads);

  const shioriEnabled = settings.providers.shiori.enabled;
  const codexEnabled = settings.providers.codex.enabled;
  const claudeEnabled = settings.providers.claudeAgent.enabled;
  const kimiCodeEnabled = settings.providers.kimiCode.enabled;
  const geminiEnabled = settings.providers.gemini.enabled;
  const cursorEnabled = settings.providers.cursor.enabled;

  const hostedUsageStats = useConvexQuery(
    hostedUsageStatsQuery,
    isAuthenticated && shioriEnabled ? {} : "skip",
  );
  const localUsageByProvider = useMemo(
    () =>
      new Map(deriveLocalProviderUsageSummaries(threads).map((usage) => [usage.provider, usage])),
    [threads],
  );

  const codexUsage = useServerQuery({
    queryKey: ["server", "providerUsage", "codex"],
    queryFn: () => ensureNativeApi().server.getProviderUsage("codex"),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    enabled: codexEnabled,
  });

  const claudeUsage = useServerQuery({
    queryKey: ["server", "providerUsage", "claudeAgent"],
    queryFn: () => ensureNativeApi().server.getProviderUsage("claudeAgent"),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    enabled: claudeEnabled,
  });

  const providerUsage = useMemo(() => {
    const codexSnapshot = codexUsage.data?.provider === "codex" ? codexUsage.data : null;
    const claudeSnapshot = claudeUsage.data?.provider === "claudeAgent" ? claudeUsage.data : null;
    const kimiCodeUsage = localUsageByProvider.get("kimiCode");
    const geminiUsage = localUsageByProvider.get("gemini");
    const cursorUsage = localUsageByProvider.get("cursor");

    const usages: ProviderUsage[] = [];

    if (shioriEnabled) {
      usages.push(
        buildShioriAccountUsage({
          isAuthenticated,
          isAuthLoading,
          monthlyPercentLeft: toRemainingPercentage(hostedUsageStats?.percentUsed),
          fiveHourPercentLeft: toRemainingPercentage(hostedUsageStats?.fiveHourPercentUsed),
          isRateLimited: hostedUsageStats?.isRateLimited ?? false,
          isBudgetExhausted: hostedUsageStats?.isBudgetExhausted ?? false,
        }),
      );
    }

    if (codexEnabled) {
      usages.push(
        buildRemoteProviderUsage({
          provider: "codex",
          source: "Codex account usage",
          isLoading: codexUsage.isLoading,
          available: codexSnapshot?.available ?? false,
          primaryPercent: toRemainingPercentage(codexSnapshot?.primary?.usedPercent),
          secondaryPercent: toRemainingPercentage(codexSnapshot?.secondary?.usedPercent),
          primaryLabel: "Session",
          secondaryLabel: "Weekly",
          unavailableReason: codexSnapshot?.unavailableReason ?? null,
        }),
      );
    }

    if (claudeEnabled) {
      usages.push(
        buildRemoteProviderUsage({
          provider: "claudeAgent",
          source: "Claude account usage",
          isLoading: claudeUsage.isLoading,
          available: claudeSnapshot?.available ?? false,
          primaryPercent: toRemainingPercentage(claudeSnapshot?.fiveHour?.usedPercent),
          secondaryPercent: toRemainingPercentage(claudeSnapshot?.sevenDay?.usedPercent),
          primaryLabel: "Session",
          secondaryLabel: "Weekly",
          unavailableReason: claudeSnapshot?.unavailableReason ?? null,
        }),
      );
    }

    if (kimiCodeEnabled) {
      usages.push(
        buildLocalProviderUsage({
          provider: "kimiCode",
          last5Hours: kimiCodeUsage?.last5Hours ?? { turns: 0, approxTokens: 0 },
          last7Days: kimiCodeUsage?.last7Days ?? { turns: 0, approxTokens: 0 },
        }),
      );
    }

    if (geminiEnabled) {
      usages.push(
        buildLocalProviderUsage({
          provider: "gemini",
          last5Hours: geminiUsage?.last5Hours ?? { turns: 0, approxTokens: 0 },
          last7Days: geminiUsage?.last7Days ?? { turns: 0, approxTokens: 0 },
        }),
      );
    }

    if (cursorEnabled) {
      usages.push(
        buildLocalProviderUsage({
          provider: "cursor",
          last5Hours: cursorUsage?.last5Hours ?? { turns: 0, approxTokens: 0 },
          last7Days: cursorUsage?.last7Days ?? { turns: 0, approxTokens: 0 },
        }),
      );
    }

    return usages;
  }, [
    claudeEnabled,
    claudeUsage.data,
    claudeUsage.isLoading,
    codexEnabled,
    codexUsage.data,
    codexUsage.isLoading,
    cursorEnabled,
    geminiEnabled,
    hostedUsageStats?.fiveHourPercentUsed,
    hostedUsageStats?.isBudgetExhausted,
    hostedUsageStats?.isRateLimited,
    hostedUsageStats?.percentUsed,
    isAuthenticated,
    isAuthLoading,
    kimiCodeEnabled,
    localUsageByProvider,
    shioriEnabled,
  ]);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <section className="space-y-3">
          <div className="space-y-1">
            <h2 className="text-[11px] font-medium text-muted-foreground">Usage</h2>
            <p className="text-sm text-muted-foreground">
              Account quota where available, plus local token usage from recorded turns.
            </p>
          </div>
          <div className={cardClasses}>
            {providerUsage.map((usage) => (
              <ProviderRow key={usage.provider} usage={usage} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
