import { useMemo } from "react";
import {
  IconClockOutline24 as Clock3,
  IconMediaPauseOutline24 as Pause,
  IconMediaPlayOutline24 as Play,
  IconRefreshOutline24 as RefreshCw,
  IconTrash2Outline24 as Trash2,
} from "nucleo-core-outline-24";

import { PROVIDER_DISPLAY_NAMES, type Automation } from "contracts";

import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import {
  AUTOMATION_FILTER_LABELS,
  AUTOMATION_FILTER_ORDER,
  type AutomationFilter,
  type AutomationStatusTone,
  automationMatchesFilter,
  automationStatusTone,
  countAutomations,
  intervalLabel,
} from "./automationShared";

const STATUS_RAIL_CLASS: Record<AutomationStatusTone, string> = {
  active: "bg-success",
  paused: "bg-muted-foreground/40",
  failed: "bg-destructive",
};

interface AutomationsListProps {
  automations: ReadonlyArray<Automation>;
  loading: boolean;
  loadError: string | null;
  filter: AutomationFilter;
  columnClass: string;
  onFilterChange: (filter: AutomationFilter) => void;
  onRefresh: () => void;
  onCreate: () => void;
  onRunNow: (automationId: Automation["id"]) => void;
  onToggleStatus: (automation: Automation) => void;
  onDelete: (automationId: Automation["id"]) => void;
}

function nextRunLabel(automation: Automation): string {
  if (automation.status === "paused") return "Paused";
  if (!automation.nextRunAt) return "Not scheduled";
  return `Next ${formatRelativeTimeLabel(automation.nextRunAt)}`;
}

function lastRunLabel(automation: Automation): string {
  if (!automation.lastRunAt) return "Never run";
  const prefix = automation.lastRunStatus === "failed" ? "Failed" : "Queued";
  return `${prefix} ${formatRelativeTimeLabel(automation.lastRunAt)}`;
}

export function AutomationsList({
  automations,
  loading,
  loadError,
  filter,
  columnClass,
  onFilterChange,
  onRefresh,
  onCreate,
  onRunNow,
  onToggleStatus,
  onDelete,
}: AutomationsListProps) {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );
  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread] as const)),
    [threads],
  );

  const filterCounts = useMemo<Record<AutomationFilter, number>>(() => {
    const counts = {} as Record<AutomationFilter, number>;
    for (const key of AUTOMATION_FILTER_ORDER) {
      counts[key] = countAutomations(automations, key);
    }
    return counts;
  }, [automations]);

  const visibleAutomations = useMemo(
    () => automations.filter((automation) => automationMatchesFilter(automation, filter)),
    [automations, filter],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center border-b border-border/40">
        <div className={cn(columnClass, "flex h-full items-center justify-between gap-3")}>
          <div
            role="radiogroup"
            aria-label="Automation filter"
            className="inline-flex items-center rounded-full border border-border/60 bg-background/60 p-[2px]"
          >
            {AUTOMATION_FILTER_ORDER.map((value) => {
              const isActive = value === filter;
              const count = filterCounts[value];
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  onClick={() => onFilterChange(value)}
                  className={cn(
                    "inline-flex h-5 items-center gap-1 rounded-full px-2 text-[10.5px] font-medium leading-none transition-colors",
                    isActive
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span>{AUTOMATION_FILTER_LABELS[value]}</span>
                  <span className="text-[9px] tabular-nums opacity-70">{count}</span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={onRefresh}
                    aria-label="Refresh automations"
                  >
                    <RefreshCw className="size-3.5" aria-hidden />
                  </Button>
                }
              />
              <TooltipPopup>Refresh</TooltipPopup>
            </Tooltip>
            <Button type="button" size="xs" onClick={onCreate}>
              <Clock3 className="size-3.5" aria-hidden />
              New automation
            </Button>
          </div>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn(columnClass, "flex flex-col gap-1 pt-2 pb-4")}>
          {loading && automations.length === 0 ? (
            <p className="px-2 py-8 text-sm text-muted-foreground">Loading automations...</p>
          ) : loadError && automations.length === 0 ? (
            <div className="p-6">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <RefreshCw />
                  </EmptyMedia>
                  <EmptyTitle className="text-pretty">Couldn&apos;t load automations</EmptyTitle>
                  <EmptyDescription className="text-pretty">{loadError}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button onClick={onRefresh} size="sm">
                    <RefreshCw className="size-3.5" aria-hidden />
                    Retry
                  </Button>
                </EmptyContent>
              </Empty>
            </div>
          ) : visibleAutomations.length === 0 ? (
            <div className="p-6">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Clock3 />
                  </EmptyMedia>
                  <EmptyTitle className="text-pretty">
                    {automations.length === 0 ? "No automations yet" : "No matching automations"}
                  </EmptyTitle>
                  <EmptyDescription className="text-pretty">
                    {automations.length === 0
                      ? "Create an automation to start a new thread on a schedule."
                      : "Try a different filter or create a new automation."}
                  </EmptyDescription>
                </EmptyHeader>
                {automations.length === 0 ? (
                  <EmptyContent>
                    <Button onClick={onCreate} size="sm">
                      <Clock3 className="size-3.5" aria-hidden />
                      New automation
                    </Button>
                  </EmptyContent>
                ) : null}
              </Empty>
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5 pb-2">
              {visibleAutomations.map((automation) => {
                const workspaceLabel =
                  (automation.projectId ? projectById.get(automation.projectId)?.name : null) ??
                  automation.projectlessCwd ??
                  "Projectless";
                const lastRunThread = automation.lastRunThreadId
                  ? threadById.get(automation.lastRunThreadId)
                  : undefined;
                const tone = automationStatusTone(automation);
                return (
                  <li key={automation.id}>
                    <div
                      className={cn(
                        "group/automation flex w-full min-w-0 items-stretch gap-3 rounded-md py-2.5 pl-2 pr-2.5",
                        "hover:bg-sidebar-accent/50",
                      )}
                    >
                      <span
                        className={cn(
                          "w-[3px] shrink-0 self-stretch rounded-full transition-opacity",
                          STATUS_RAIL_CLASS[tone],
                          "opacity-80 group-hover/automation:opacity-100",
                        )}
                        aria-hidden
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight text-foreground">
                            {automation.title}
                          </span>
                          <span className="shrink-0 rounded-sm border border-border/60 px-1 py-px text-[9px] font-medium uppercase tracking-wider text-muted-foreground/80">
                            {intervalLabel(automation.scheduleRrule)}
                          </span>
                        </div>
                        <span className="truncate text-[11px] text-muted-foreground/70">
                          {PROVIDER_DISPLAY_NAMES[automation.modelSelection.provider]} ·{" "}
                          {workspaceLabel}
                        </span>
                        {lastRunThread ? (
                          <span className="truncate text-[11px] text-muted-foreground/60">
                            Last run: {lastRunThread.title}
                          </span>
                        ) : null}
                        <p className="line-clamp-2 text-[11px] leading-[1.45] text-muted-foreground/60">
                          {automation.prompt}
                        </p>
                        <span className="mt-0.5 text-[10.5px] text-muted-foreground/55">
                          {nextRunLabel(automation)} · {lastRunLabel(automation)}
                          {automation.lastRunError ? ` · ${automation.lastRunError}` : ""}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-start gap-1 self-start pt-0.5">
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                className="text-muted-foreground hover:text-foreground"
                                onClick={() => onRunNow(automation.id)}
                                aria-label="Run automation now"
                              >
                                <Play className="size-3.5" aria-hidden />
                              </Button>
                            }
                          />
                          <TooltipPopup>Run now</TooltipPopup>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                className="text-muted-foreground hover:text-foreground"
                                onClick={() => onToggleStatus(automation)}
                                aria-label={
                                  automation.status === "active"
                                    ? "Pause automation"
                                    : "Resume automation"
                                }
                              >
                                {automation.status === "active" ? (
                                  <Pause className="size-3.5" aria-hidden />
                                ) : (
                                  <Play className="size-3.5" aria-hidden />
                                )}
                              </Button>
                            }
                          />
                          <TooltipPopup>
                            {automation.status === "active" ? "Pause" : "Resume"}
                          </TooltipPopup>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                className="text-muted-foreground hover:text-destructive"
                                onClick={() => onDelete(automation.id)}
                                aria-label={`Delete automation ${automation.title}`}
                              >
                                <Trash2 className="size-3.5" aria-hidden />
                              </Button>
                            }
                          />
                          <TooltipPopup>Delete</TooltipPopup>
                        </Tooltip>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
