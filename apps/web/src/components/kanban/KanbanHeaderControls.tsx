import { type ProviderKind } from "contracts";
import {
  IconBarsFilterOutline24 as ListFilterIcon,
  IconPlusOutline24 as PlusIcon,
  IconTriangleWarningOutline24 as TriangleAlertIcon,
} from "nucleo-core-outline-24";
import { type RefObject } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { cn } from "~/lib/utils";

import { type KanbanAgentFilter } from "./PrKanbanBoard";
import { PROVIDERS } from "./goalShared";

interface KanbanHeaderControlsProps {
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  agentFilter: KanbanAgentFilter;
  onAgentFilterChange: (value: KanbanAgentFilter) => void;
  blockedOnly: boolean;
  onBlockedOnlyChange: (value: boolean) => void;
  onClearFilters: () => void;
  canCreate: boolean;
  onNewTask: () => void;
  filtersOpen: boolean;
  onFiltersOpenChange: (open: boolean) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
}

export function KanbanHeaderControls({
  searchQuery,
  onSearchQueryChange,
  agentFilter,
  onAgentFilterChange,
  blockedOnly,
  onBlockedOnlyChange,
  onClearFilters,
  canCreate,
  onNewTask,
  filtersOpen,
  onFiltersOpenChange,
  searchInputRef,
}: KanbanHeaderControlsProps) {
  const filtersActive = searchQuery.trim().length > 0 || agentFilter !== "any" || blockedOnly;

  return (
    <div className="flex items-center gap-1.5">
      <Popover open={filtersOpen} onOpenChange={onFiltersOpenChange}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={filtersActive ? "Filters (active)" : "Filters"}
              className="relative text-muted-foreground hover:text-foreground"
            />
          }
        >
          <ListFilterIcon className="size-3.5" aria-hidden />
          {filtersActive ? (
            <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />
          ) : null}
        </PopoverTrigger>
        <PopoverPopup align="end" sideOffset={8} className="w-[18rem]">
          <div className="space-y-3">
            <Input
              ref={searchInputRef}
              size="sm"
              placeholder="Search goals"
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
              aria-label="Search goals"
              autoFocus
            />

            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-medium text-muted-foreground/75">Agent</label>
              <Select
                value={agentFilter}
                onValueChange={(next) => {
                  if (typeof next === "string" && next.length > 0) {
                    onAgentFilterChange(next as KanbanAgentFilter);
                  }
                }}
              >
                <SelectTrigger size="sm" aria-label="Filter by agent" className="w-full">
                  <SelectValue>{agentLabel(agentFilter)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="any">
                    All agents
                  </SelectItem>
                  <SelectItem hideIndicator value="unassigned">
                    Unassigned
                  </SelectItem>
                  {PROVIDERS.map((entry) => (
                    <SelectItem hideIndicator key={entry.provider} value={entry.provider}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={blockedOnly}
              onClick={() => onBlockedOnlyChange(!blockedOnly)}
              className={cn(
                "inline-flex h-7 w-full items-center gap-1.5 rounded-md border px-2.5 text-[11.5px] font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                blockedOnly
                  ? "border-destructive/45 bg-destructive/10 text-destructive"
                  : "border-border/55 bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              <TriangleAlertIcon className="size-3" aria-hidden />
              Blocked only
            </button>

            {filtersActive ? (
              <div className="flex justify-end pt-1">
                <Button type="button" size="xs" variant="ghost" onClick={onClearFilters}>
                  Clear
                </Button>
              </div>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>

      <Button type="button" size="xs" variant="outline" disabled={!canCreate} onClick={onNewTask}>
        <PlusIcon className="size-3" aria-hidden />
        New Goal
      </Button>
    </div>
  );
}

function agentLabel(value: KanbanAgentFilter): string {
  if (value === "any") return "All agents";
  if (value === "unassigned") return "Unassigned";
  return PROVIDERS.find((entry) => entry.provider === value)?.label ?? (value as ProviderKind);
}
