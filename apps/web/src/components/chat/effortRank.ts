export interface EffortLevel {
  value: string;
  label: string;
  isDefault?: boolean | undefined;
}

/** Canonical faster→smarter rank; providers report levels in mixed orders. */
export const EFFORT_RANK: Record<string, number> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
  ultra: 6,
  ultracode: 7,
  ultrathink: 8,
};

/**
 * Order effort levels faster→smarter so the slider always runs left-to-right.
 * Unknown values keep the provider's order (assumed already meaningful).
 */
export function orderEffortLevels<T extends EffortLevel>(
  levels: ReadonlyArray<T>,
): ReadonlyArray<T> {
  if (!levels.every((level) => level.value in EFFORT_RANK)) return levels;
  return levels.toSorted((a, b) => EFFORT_RANK[a.value]! - EFFORT_RANK[b.value]!);
}

/**
 * Whether `value` is the smartest level the current model offers. The name of
 * that level differs per provider ("ultrathink", "ultra", "max", …), so callers
 * that highlight peak effort must compare against the model's own top level
 * rather than any single literal. Models with one level (or none) never qualify:
 * there is nothing to max out.
 */
export function isMaxEffort(
  value: string | null | undefined,
  levels: ReadonlyArray<EffortLevel>,
): boolean {
  if (!value || levels.length <= 1) return false;
  return orderEffortLevels(levels).at(-1)?.value === value;
}
