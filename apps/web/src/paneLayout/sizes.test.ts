import { describe, expect, it } from "vitest";

import { pane, split } from "./model";
import { applyResizeDelta, equalSizes, normalizeSizes, splitSizesKey } from "./sizes";

describe("splitSizesKey", () => {
  it("keys a split by direction and each child's leading pane", () => {
    expect(splitSizesKey(split("row", [pane("a"), split("column", [pane("b"), pane("c")])]))).toBe(
      "row:a|b",
    );
  });
});

describe("normalizeSizes", () => {
  it("defaults to equal fractions", () => {
    expect(normalizeSizes(null, 2)).toEqual([0.5, 0.5]);
    expect(equalSizes(0)).toEqual([]);
  });

  it("rescales valid sizes to sum to one", () => {
    expect(normalizeSizes([1, 3], 2)).toEqual([0.25, 0.75]);
  });

  it("rejects size lists with the wrong length or invalid entries", () => {
    expect(normalizeSizes([1, 2, 3], 2)).toEqual([0.5, 0.5]);
    expect(normalizeSizes([0.5, 0], 2)).toEqual([0.5, 0.5]);
    expect(normalizeSizes([0.5, Number.NaN], 2)).toEqual([0.5, 0.5]);
  });
});

describe("applyResizeDelta", () => {
  const rounded = (sizes: number[]) => sizes.map((size) => Math.round(size * 1000) / 1000);

  it("shifts space across the divider", () => {
    expect(rounded(applyResizeDelta([0.5, 0.5], 0, 0.1, 0.1))).toEqual([0.6, 0.4]);
  });

  it("clamps so neighbors stay at the minimum", () => {
    expect(rounded(applyResizeDelta([0.5, 0.5], 0, 0.9, 0.1))).toEqual([0.9, 0.1]);
    expect(rounded(applyResizeDelta([0.5, 0.5], 0, -0.9, 0.1))).toEqual([0.1, 0.9]);
  });

  it("only touches the divider's neighbors", () => {
    expect(rounded(applyResizeDelta([0.4, 0.4, 0.2], 1, 0.1, 0.05))).toEqual([0.4, 0.5, 0.1]);
  });

  it("leaves sizes untouched when neighbors are already below the minimum", () => {
    expect(applyResizeDelta([0.05, 0.05, 0.9], 0, 0.02, 0.1)).toEqual([0.05, 0.05, 0.9]);
  });

  it("ignores out-of-range divider indexes", () => {
    expect(applyResizeDelta([0.5, 0.5], 1, 0.1, 0.1)).toEqual([0.5, 0.5]);
  });
});
