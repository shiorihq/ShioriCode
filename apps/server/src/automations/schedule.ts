export class AutomationScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationScheduleError";
  }
}

type ParsedRrule = {
  freq: "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY";
  interval: number;
  byHour: readonly number[];
  byMinute: readonly number[];
  byDay: readonly number[];
};

const WEEKDAY_INDEX_BY_RRULE_DAY = new Map([
  ["SU", 0],
  ["MO", 1],
  ["TU", 2],
  ["WE", 3],
  ["TH", 4],
  ["FR", 5],
  ["SA", 6],
]);

const MAX_SEARCH_MINUTES = 60 * 24 * 366 * 2;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AutomationScheduleError(`Invalid RRULE interval '${value}'.`);
  }
  return parsed;
}

function parseNumberList(value: string | undefined, min: number, max: number): readonly number[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  return value.split(",").map((rawValue) => {
    const parsed = Number(rawValue);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new AutomationScheduleError(`Invalid RRULE numeric value '${rawValue}'.`);
    }
    return parsed;
  });
}

function parseByDay(value: string | undefined): readonly number[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  return value.split(",").map((rawValue) => {
    const day = WEEKDAY_INDEX_BY_RRULE_DAY.get(rawValue.toUpperCase());
    if (day === undefined) {
      throw new AutomationScheduleError(`Invalid RRULE weekday '${rawValue}'.`);
    }
    return day;
  });
}

export function parseAutomationRrule(rrule: string): ParsedRrule {
  const fields = new Map<string, string>();
  for (const segment of rrule.split(";")) {
    const [rawKey, ...rawValueParts] = segment.split("=");
    const key = rawKey?.trim().toUpperCase();
    const value = rawValueParts.join("=").trim();
    if (!key || !value) {
      continue;
    }
    fields.set(key, value);
  }

  const freq = fields.get("FREQ")?.toUpperCase();
  if (freq !== "MINUTELY" && freq !== "HOURLY" && freq !== "DAILY" && freq !== "WEEKLY") {
    throw new AutomationScheduleError("RRULE must use MINUTELY, HOURLY, DAILY, or WEEKLY.");
  }

  return {
    freq,
    interval: parsePositiveInt(fields.get("INTERVAL"), 1),
    byHour: parseNumberList(fields.get("BYHOUR"), 0, 23),
    byMinute: parseNumberList(fields.get("BYMINUTE"), 0, 59),
    byDay: parseByDay(fields.get("BYDAY")),
  };
}

function minuteFloor(date: Date): Date {
  const next = new Date(date);
  next.setSeconds(0, 0);
  return next;
}

function wholeMinutesSinceEpoch(date: Date): number {
  return Math.floor(date.getTime() / 60_000);
}

function wholeHoursSinceEpoch(date: Date): number {
  return Math.floor(date.getTime() / 3_600_000);
}

function wholeDaysSinceEpoch(date: Date): number {
  return Math.floor(date.getTime() / 86_400_000);
}

function wholeWeeksSinceEpoch(date: Date): number {
  return Math.floor(wholeDaysSinceEpoch(date) / 7);
}

function includesOrDefault(values: readonly number[], value: number, fallback: number): boolean {
  return values.length > 0 ? values.includes(value) : value === fallback;
}

function matchesRule(date: Date, rule: ParsedRrule): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const day = date.getDay();

  switch (rule.freq) {
    case "MINUTELY":
      return wholeMinutesSinceEpoch(date) % rule.interval === 0;
    case "HOURLY":
      return (
        wholeHoursSinceEpoch(date) % rule.interval === 0 &&
        includesOrDefault(rule.byMinute, minute, 0)
      );
    case "DAILY":
      return (
        wholeDaysSinceEpoch(date) % rule.interval === 0 &&
        includesOrDefault(rule.byHour, hour, 9) &&
        includesOrDefault(rule.byMinute, minute, 0)
      );
    case "WEEKLY":
      return (
        wholeWeeksSinceEpoch(date) % rule.interval === 0 &&
        (rule.byDay.length > 0 ? rule.byDay.includes(day) : day === 1) &&
        includesOrDefault(rule.byHour, hour, 9) &&
        includesOrDefault(rule.byMinute, minute, 0)
      );
  }
}

export function computeNextAutomationRunAt(rrule: string, afterDate = new Date()): string {
  const rule = parseAutomationRrule(rrule);
  const candidate = minuteFloor(new Date(afterDate.getTime() + 60_000));

  for (let offset = 0; offset < MAX_SEARCH_MINUTES; offset += 1) {
    const date = new Date(candidate.getTime() + offset * 60_000);
    if (matchesRule(date, rule)) {
      return date.toISOString();
    }
  }

  throw new AutomationScheduleError("RRULE did not produce a run within two years.");
}

export function summarizeAutomationRrule(rrule: string): string {
  const rule = parseAutomationRrule(rrule);
  switch (rule.freq) {
    case "MINUTELY":
      return rule.interval === 1 ? "Every minute" : `Every ${rule.interval} minutes`;
    case "HOURLY":
      return rule.interval === 1 ? "Hourly" : `Every ${rule.interval} hours`;
    case "DAILY":
      return "Daily";
    case "WEEKLY":
      return "Weekly";
  }
}
