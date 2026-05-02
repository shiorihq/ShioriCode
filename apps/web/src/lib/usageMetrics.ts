import type { ProviderKind } from "contracts";

import type { Thread } from "../types";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface LocalUsageWindowSummary {
  readonly turns: number;
  readonly approxTokens: number;
}

export interface LocalProviderUsageSummary {
  readonly provider: ProviderKind;
  readonly last5Hours: LocalUsageWindowSummary;
  readonly last7Days: LocalUsageWindowSummary;
}

const LOCAL_USAGE_PROVIDERS = [
  "codex",
  "claudeAgent",
  "shiori",
  "kimiCode",
  "gemini",
  "cursor",
] as const satisfies readonly ProviderKind[];

interface ProviderTurnUsageSample {
  readonly provider: ProviderKind;
  readonly timestampMs: number;
  readonly approxTokens: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sumValues(values: ReadonlyArray<number | null>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function deriveApproxTokensFromPayload(payload: unknown): number {
  const record = asRecord(payload);
  if (!record) {
    return 0;
  }

  const incrementalTokens = sumValues([
    asFiniteNonNegativeNumber(record.lastInputTokens),
    asFiniteNonNegativeNumber(record.lastCachedInputTokens),
    asFiniteNonNegativeNumber(record.lastOutputTokens),
    asFiniteNonNegativeNumber(record.lastReasoningOutputTokens),
  ]);
  if (incrementalTokens > 0) {
    return incrementalTokens;
  }

  const lastUsedTokens = asFiniteNonNegativeNumber(record.lastUsedTokens);
  if (lastUsedTokens !== null && lastUsedTokens > 0) {
    return lastUsedTokens;
  }

  const snapshotTokens = sumValues([
    asFiniteNonNegativeNumber(record.inputTokens),
    asFiniteNonNegativeNumber(record.cachedInputTokens),
    asFiniteNonNegativeNumber(record.outputTokens),
    asFiniteNonNegativeNumber(record.reasoningOutputTokens),
  ]);
  if (snapshotTokens > 0) {
    return snapshotTokens;
  }

  return (
    asFiniteNonNegativeNumber(record.totalProcessedTokens) ??
    asFiniteNonNegativeNumber(record.usedTokens) ??
    0
  );
}

function buildProviderTurnUsageSamples(
  threads: ReadonlyArray<Thread>,
): ReadonlyArray<ProviderTurnUsageSample> {
  const samplesByTurnKey = new Map<string, ProviderTurnUsageSample>();

  for (const thread of threads) {
    const provider = thread.modelSelection.provider;
    for (const activity of thread.activities) {
      if (activity.kind !== "context-window.updated") {
        continue;
      }

      const timestampMs = new Date(activity.createdAt).getTime();
      if (!Number.isFinite(timestampMs)) {
        continue;
      }

      const turnKey = `${thread.id}:${activity.turnId ?? activity.id}`;
      const nextSample: ProviderTurnUsageSample = {
        provider,
        timestampMs,
        approxTokens: deriveApproxTokensFromPayload(activity.payload),
      };
      const currentSample = samplesByTurnKey.get(turnKey);
      if (!currentSample || nextSample.timestampMs >= currentSample.timestampMs) {
        samplesByTurnKey.set(turnKey, nextSample);
      }
    }
  }

  return [...samplesByTurnKey.values()];
}

function summarizeWindow(
  samples: ReadonlyArray<ProviderTurnUsageSample>,
  provider: ProviderKind,
  cutoffMs: number,
): LocalUsageWindowSummary {
  let turns = 0;
  let approxTokens = 0;

  for (const sample of samples) {
    if (sample.provider !== provider || sample.timestampMs < cutoffMs) {
      continue;
    }
    turns += 1;
    approxTokens += sample.approxTokens;
  }

  return { turns, approxTokens };
}

export function deriveLocalProviderUsageSummaries(
  threads: ReadonlyArray<Thread>,
  now = Date.now(),
): ReadonlyArray<LocalProviderUsageSummary> {
  const samples = buildProviderTurnUsageSamples(threads);
  const last5HoursCutoffMs = now - FIVE_HOURS_MS;
  const last7DaysCutoffMs = now - SEVEN_DAYS_MS;

  return LOCAL_USAGE_PROVIDERS.map((provider) => ({
    provider,
    last5Hours: summarizeWindow(samples, provider, last5HoursCutoffMs),
    last7Days: summarizeWindow(samples, provider, last7DaysCutoffMs),
  }));
}
