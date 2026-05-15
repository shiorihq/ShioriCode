import { describe, expect, it } from "vitest";

import { computeNextAutomationRunAt, parseAutomationRrule } from "./schedule.ts";

describe("automation schedules", () => {
  it("parses supported heartbeat RRULE frequencies", () => {
    expect(parseAutomationRrule("FREQ=MINUTELY;INTERVAL=30")).toMatchObject({
      freq: "MINUTELY",
      interval: 30,
    });
    expect(parseAutomationRrule("FREQ=DAILY;BYHOUR=9;BYMINUTE=0")).toMatchObject({
      freq: "DAILY",
      byHour: [9],
      byMinute: [0],
    });
  });

  it("computes the next minutely run after the supplied instant", () => {
    expect(
      computeNextAutomationRunAt("FREQ=MINUTELY;INTERVAL=15", new Date("2026-05-14T08:07:13.000Z")),
    ).toBe("2026-05-14T08:15:00.000Z");
  });

  it("computes the next daily wall-clock run", () => {
    const after = new Date(2026, 4, 14, 8, 59, 0, 0);
    const expected = new Date(2026, 4, 14, 9, 0, 0, 0).toISOString();
    expect(computeNextAutomationRunAt("FREQ=DAILY;BYHOUR=9;BYMINUTE=0", after)).toBe(expected);
  });
});
