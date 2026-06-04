import { useCallback, useState } from "react";
import {
  IconChevronDownOutline24 as ChevronDownIcon,
  IconMagnifierOutline24 as SearchIcon,
} from "nucleo-core-outline-24";
import { useQueryClient } from "@tanstack/react-query";
import type { McpServerEntry } from "contracts";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "../ui/collapsible";

// Shared building blocks for the Skills, MCP, and Plugins settings pages.

export const MCP_SERVERS_QUERY_KEY = ["settings", "mcpServers", "effective"] as const;
export const SKILLS_QUERY_KEY = ["settings", "skills", "effective"] as const;

const EMPTY_MCP_SERVERS: readonly McpServerEntry[] = [];

// ── Search Filter ───────────────────────────────────────────────

export function SectionSearchFilter({
  value,
  onChange,
  placeholder,
  resultCount,
  totalCount,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  resultCount: number;
  totalCount: number;
}) {
  const isFiltering = value.length > 0;
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-2 sm:px-5">
      <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
      />
      {isFiltering ? (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {resultCount} / {totalCount}
        </span>
      ) : null}
    </div>
  );
}

// ── Collapsible Source Group ────────────────────────────────────

export function SourceGroup({
  source,
  count,
  defaultOpen,
  children,
}: {
  source: string;
  count: number;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 border-t border-border px-4 py-2.5 first:border-t-0 hover:bg-accent/40 sm:px-5">
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
            !open && "-rotate-90",
          )}
        />
        <span className="text-xs font-medium capitalize text-foreground">{source}</span>
        <Badge variant="secondary" className="text-[10px] tabular-nums">
          {count}
        </Badge>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div>{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

// ── Grouping helpers ────────────────────────────────────────────

const SOURCE_ORDER: readonly string[] = ["shiori", "codex", "claude"];

export function groupBySource<T extends { source: string }>(items: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const existing = groups.get(item.source);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(item.source, [item]);
    }
  }
  // Sort groups by canonical source order
  const sorted = new Map<string, T[]>();
  for (const source of SOURCE_ORDER) {
    const group = groups.get(source);
    if (group) sorted.set(source, group);
  }
  // Append any remaining sources not in the canonical order
  for (const [source, group] of groups) {
    if (!sorted.has(source)) sorted.set(source, group);
  }
  return sorted;
}

export function matchesSearch(query: string, ...fields: (string | undefined)[]): boolean {
  const q = query.toLowerCase();
  return fields.some((f) => f?.toLowerCase().includes(q));
}

// ── MCP server settings hook ────────────────────────────────────

/**
 * Reads the persisted MCP server list from settings and exposes a writer that
 * keeps the effective MCP/skills queries in sync. Shared by the MCP and Plugins
 * pages, which both mutate the same `settings.mcpServers.servers` array.
 */
export function useMcpServerSettings() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const queryClient = useQueryClient();
  const servers = settings.mcpServers?.servers ?? EMPTY_MCP_SERVERS;

  const persistServers = useCallback(
    (next: McpServerEntry[]) => {
      updateSettings({ mcpServers: { servers: next } });
      void queryClient.invalidateQueries({ queryKey: MCP_SERVERS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY });
    },
    [queryClient, updateSettings],
  );

  return { servers, persistServers, queryClient };
}
