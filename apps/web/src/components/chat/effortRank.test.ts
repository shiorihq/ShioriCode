import { describe, expect, it } from "vitest";

import { isMaxEffort, orderEffortLevels, type EffortLevel } from "./effortRank";

const level = (value: string): EffortLevel => ({ value, label: value });
const levels = (...values: ReadonlyArray<string>): ReadonlyArray<EffortLevel> => values.map(level);

describe("orderEffortLevels", () => {
  it("sorts known levels faster→smarter regardless of provider order", () => {
    expect(
      orderEffortLevels(levels("high", "minimal", "ultrathink", "medium")).map((l) => l.value),
    ).toEqual(["minimal", "medium", "high", "ultrathink"]);
  });

  it("keeps the provider order when any level is unranked", () => {
    expect(orderEffortLevels(levels("high", "bespoke", "low")).map((l) => l.value)).toEqual([
      "high",
      "bespoke",
      "low",
    ]);
  });
});

describe("isMaxEffort", () => {
  it("matches the top-ranked level whatever it is named", () => {
    expect(isMaxEffort("ultrathink", levels("medium", "high", "ultrathink"))).toBe(true);
    expect(isMaxEffort("ultra", levels("low", "medium", "high", "xhigh", "ultra"))).toBe(true);
    expect(isMaxEffort("max", levels("low", "medium", "max"))).toBe(true);
  });

  it("rejects lower levels and values the model does not offer", () => {
    expect(isMaxEffort("high", levels("medium", "high", "ultrathink"))).toBe(false);
    expect(isMaxEffort("ultrathink", levels("low", "medium", "high"))).toBe(false);
    expect(isMaxEffort(null, levels("low", "high"))).toBe(false);
    expect(isMaxEffort(undefined, levels("low", "high"))).toBe(false);
  });

  it("never activates for models with fewer than two levels", () => {
    expect(isMaxEffort("high", levels("high"))).toBe(false);
    expect(isMaxEffort("high", [])).toBe(false);
  });

  it("uses the last unranked level when the provider order is preserved", () => {
    expect(isMaxEffort("bespoke", levels("low", "bespoke"))).toBe(true);
    expect(isMaxEffort("low", levels("low", "bespoke"))).toBe(false);
  });
});
