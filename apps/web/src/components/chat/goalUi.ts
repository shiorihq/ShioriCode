import {
  THREAD_GOAL_OBJECTIVE_MAX_SCALARS,
  type ThreadGoal,
  type ThreadGoalUserStatus,
} from "contracts";

export interface GoalUpdatePatch {
  readonly objective?: string;
  readonly status?: ThreadGoalUserStatus;
  readonly tokenBudget?: number | null;
}

export type GoalEditorMode = "edit" | "resumeBudget";

export type GoalEditSubmission =
  | { readonly ok: true; readonly patch: GoalUpdatePatch }
  | { readonly ok: false; readonly error: string };

export function formatGoalElapsedSeconds(seconds: number): string {
  const normalizedSeconds = Math.max(0, Math.floor(seconds));
  if (normalizedSeconds < 60) {
    return `${normalizedSeconds}s`;
  }

  const minutes = Math.floor(normalizedSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h ${remainingMinutes}m`;
  }

  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export function formatGoalTokenCount(tokens: number): string {
  const normalizedTokens = Math.max(0, Math.floor(tokens));
  if (normalizedTokens < 1_000) {
    return String(normalizedTokens);
  }

  const scales = [
    { threshold: 1_000_000_000_000, divisor: 1_000_000_000_000, suffix: "T" },
    { threshold: 1_000_000_000, divisor: 1_000_000_000, suffix: "B" },
    { threshold: 1_000_000, divisor: 1_000_000, suffix: "M" },
    { threshold: 1_000, divisor: 1_000, suffix: "K" },
  ] as const;
  const scale = scales.find((candidate) => normalizedTokens >= candidate.threshold)!;
  const scaled = normalizedTokens / scale.divisor;
  const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  return `${scaled
    .toFixed(decimals)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*?)0+$/, "$1")}${scale.suffix}`;
}

export function goalTokenProgressPercent(goal: Pick<ThreadGoal, "tokenBudget" | "tokensUsed">) {
  if (goal.tokenBudget === null) {
    return null;
  }
  return Math.min(100, Math.max(0, (goal.tokensUsed / goal.tokenBudget) * 100));
}

function parseOptionalPositiveInteger(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function countUnicodeScalars(value: string): number | null {
  let count = 0;
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0);
    if (codePoint === undefined || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return null;
    }
    count += 1;
  }
  return count;
}

export function resolveGoalEditSubmission(input: {
  readonly goal: ThreadGoal;
  readonly mode: GoalEditorMode;
  readonly objective: string;
  readonly tokenBudgetInput: string;
}): GoalEditSubmission {
  const objective = input.objective.trim();
  if (objective.length === 0) {
    return { ok: false, error: "Enter a goal objective." };
  }
  const scalarCount = countUnicodeScalars(objective);
  if (scalarCount === null || scalarCount > THREAD_GOAL_OBJECTIVE_MAX_SCALARS) {
    return {
      ok: false,
      error: `Use valid Unicode text within ${THREAD_GOAL_OBJECTIVE_MAX_SCALARS.toLocaleString()} characters.`,
    };
  }

  const tokenBudget = parseOptionalPositiveInteger(input.tokenBudgetInput);
  if (tokenBudget === undefined) {
    return { ok: false, error: "Token budget must be a positive whole number, or blank." };
  }
  if (
    input.mode === "resumeBudget" &&
    tokenBudget !== null &&
    tokenBudget <= input.goal.tokensUsed
  ) {
    return {
      ok: false,
      error: `Set a budget above ${formatGoalTokenCount(input.goal.tokensUsed)} tokens, or leave it blank for no limit.`,
    };
  }

  const patch: {
    objective?: string;
    status?: ThreadGoalUserStatus;
    tokenBudget?: number | null;
  } = {};
  if (objective !== input.goal.objective) {
    patch.objective = objective;
  }
  if (tokenBudget !== input.goal.tokenBudget || input.mode === "resumeBudget") {
    patch.tokenBudget = tokenBudget;
  }
  if (input.mode === "resumeBudget") {
    patch.status = "active";
  } else if (input.goal.status === "complete") {
    // Editing a terminal goal reactivates Shiori's existing lifecycle while
    // retaining its accumulated accounting fields.
    patch.status = "active";
  }
  return { ok: true, patch };
}

export function mutationErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}
