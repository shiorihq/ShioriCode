import type { Automation, AutomationStatus } from "contracts";

export type AutomationFilter = "all" | "active" | "paused";

export const AUTOMATION_FILTER_ORDER: readonly AutomationFilter[] = ["all", "active", "paused"];

export const AUTOMATION_FILTER_LABELS: Record<AutomationFilter, string> = {
  all: "All",
  active: "Active",
  paused: "Paused",
};

export interface AutomationIntervalPreset {
  readonly label: string;
  readonly rrule: string;
}

export const HEARTBEAT_INTERVALS: readonly AutomationIntervalPreset[] = [
  { label: "Every 15 minutes", rrule: "FREQ=MINUTELY;INTERVAL=15" },
  { label: "Every 30 minutes", rrule: "FREQ=MINUTELY;INTERVAL=30" },
  { label: "Hourly", rrule: "FREQ=HOURLY;INTERVAL=1" },
  { label: "Every 4 hours", rrule: "FREQ=HOURLY;INTERVAL=4" },
  { label: "Daily at 9:00", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" },
];

export function intervalLabel(rrule: string): string {
  return HEARTBEAT_INTERVALS.find((interval) => interval.rrule === rrule)?.label ?? "Custom";
}

export function automationMatchesFilter(
  automation: Pick<Automation, "status">,
  filter: AutomationFilter,
): boolean {
  if (filter === "all") return true;
  return automation.status === (filter satisfies AutomationStatus);
}

export function countAutomations(
  automations: ReadonlyArray<Pick<Automation, "status">>,
  filter: AutomationFilter,
): number {
  if (filter === "all") return automations.length;
  return automations.filter((automation) => automationMatchesFilter(automation, filter)).length;
}

export type AutomationStatusTone = "active" | "paused" | "failed";

export function automationStatusTone(
  automation: Pick<Automation, "status" | "lastRunStatus">,
): AutomationStatusTone {
  if (automation.lastRunStatus === "failed") return "failed";
  if (automation.status === "active") return "active";
  return "paused";
}
