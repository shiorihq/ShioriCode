/**
 * Split sizing is a presentation concern kept out of the layout model and the
 * URL: sizes are normalized fractions persisted to localStorage, keyed by a
 * stable signature of the split they belong to.
 */

import { Schema } from "effect";

import { firstPaneKey, type SplitNode } from "./model";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";

const SPLIT_SIZES_STORAGE_KEY = "pane_layout_split_sizes";
const MAX_STORED_SPLIT_ENTRIES = 64;

const StoredSplitSizes = Schema.Record(Schema.String, Schema.Array(Schema.Finite));
type StoredSplitSizes = typeof StoredSplitSizes.Type;

/**
 * Stable identity for a split: direction plus the leading pane key of each
 * child subtree. Sizes survive edits elsewhere in the tree and reset to equal
 * when the split's own children change.
 */
export function splitSizesKey(node: SplitNode): string {
  return `${node.direction}:${node.children.map(firstPaneKey).join("|")}`;
}

export function equalSizes(count: number): number[] {
  return count > 0 ? Array.from({ length: count }, () => 1 / count) : [];
}

/** Coerce stored or in-flight sizes into `count` positive fractions summing to 1. */
export function normalizeSizes(
  sizes: ReadonlyArray<number> | null | undefined,
  count: number,
): number[] {
  if (count <= 0) {
    return [];
  }
  if (
    !sizes ||
    sizes.length !== count ||
    sizes.some((size) => !Number.isFinite(size) || size <= 0)
  ) {
    return equalSizes(count);
  }
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return total > 0 ? sizes.map((size) => size / total) : equalSizes(count);
}

/**
 * Shift space across the divider at `dividerIndex` by `deltaFraction`,
 * keeping both neighbors at or above `minFraction`. Neighbors already below
 * the minimum (e.g. after a window shrink) are left untouched.
 */
export function applyResizeDelta(
  sizes: ReadonlyArray<number>,
  dividerIndex: number,
  deltaFraction: number,
  minFraction: number,
): number[] {
  const before = sizes[dividerIndex];
  const after = sizes[dividerIndex + 1];
  if (before === undefined || after === undefined) {
    return [...sizes];
  }

  const lowerBound = -(before - minFraction);
  const upperBound = after - minFraction;
  if (lowerBound > upperBound) {
    return [...sizes];
  }

  const delta = Math.max(lowerBound, Math.min(deltaFraction, upperBound));
  const next = [...sizes];
  next[dividerIndex] = before + delta;
  next[dividerIndex + 1] = after - delta;
  return next;
}

export function readStoredSplitSizes(sizesKey: string, count: number): number[] {
  return normalizeSizes(readStore()[sizesKey], count);
}

export function writeStoredSplitSizes(sizesKey: string, sizes: ReadonlyArray<number>): void {
  const store = readStore();
  // Re-insert last so the entry cap evicts the least recently written splits.
  const { [sizesKey]: _previous, ...rest } = store;
  const entries = Object.entries(rest);
  const trimmed = entries.slice(Math.max(0, entries.length + 1 - MAX_STORED_SPLIT_ENTRIES));
  try {
    setLocalStorageItem(
      SPLIT_SIZES_STORAGE_KEY,
      { ...Object.fromEntries(trimmed), [sizesKey]: [...sizes] },
      StoredSplitSizes,
    );
  } catch {
    // Persisting sizes is best-effort; layout still works with defaults.
  }
}

function readStore(): StoredSplitSizes {
  try {
    return getLocalStorageItem(SPLIT_SIZES_STORAGE_KEY, StoredSplitSizes) ?? {};
  } catch {
    return {};
  }
}
