import {
  type ClientOrchestrationCommand,
  type KanbanItem,
  type KanbanItemAssigneeRole,
  type KanbanItemStatus,
  type ProviderKind,
} from "contracts";

import { readNativeApi } from "~/nativeApi";

export const STATUSES: ReadonlyArray<{ status: KanbanItemStatus; label: string }> = [
  { status: "backlog", label: "Backlog" },
  { status: "todo", label: "Todo" },
  { status: "in_progress", label: "In Progress" },
  { status: "done", label: "Done" },
];

export interface StatusTheme {
  label: string;
  rail: string;
  dot: string;
  hoverBorder: string;
  hoverGlow: string;
  text: string;
}

export const STATUS_THEME: Record<KanbanItemStatus, StatusTheme> = {
  backlog: {
    label: "Backlog",
    rail: "bg-zinc-400 dark:bg-zinc-500",
    dot: "bg-zinc-500 dark:bg-zinc-400",
    hoverBorder: "border-zinc-500/40 dark:border-zinc-300/30",
    hoverGlow: "bg-zinc-500/[0.045] dark:bg-zinc-300/[0.04]",
    text: "text-zinc-600 dark:text-zinc-300",
  },
  todo: {
    label: "Todo",
    rail: "bg-sky-500",
    dot: "bg-sky-500",
    hoverBorder: "border-sky-500/45",
    hoverGlow: "bg-sky-500/[0.07]",
    text: "text-sky-700 dark:text-sky-300",
  },
  in_progress: {
    label: "In Progress",
    rail: "bg-amber-500",
    dot: "bg-amber-500",
    hoverBorder: "border-amber-500/55",
    hoverGlow: "bg-amber-500/[0.07]",
    text: "text-amber-700 dark:text-amber-300",
  },
  done: {
    label: "Done",
    rail: "bg-emerald-500",
    dot: "bg-emerald-500",
    hoverBorder: "border-emerald-500/45",
    hoverGlow: "bg-emerald-500/[0.06]",
    text: "text-emerald-700 dark:text-emerald-300",
  },
};

export const PROVIDERS: ReadonlyArray<{ provider: ProviderKind; label: string }> = [
  { provider: "codex", label: "Codex" },
  { provider: "claudeAgent", label: "Claude" },
  { provider: "kimiCode", label: "Kimi" },
  { provider: "gemini", label: "Gemini" },
  { provider: "cursor", label: "Cursor" },
  { provider: "shiori", label: "Shiori" },
];

export const ASSIGNEE_ROLE: KanbanItemAssigneeRole = "owner";

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function newSortKey(): string {
  return `${Date.now().toString().padStart(13, "0")}_${crypto.randomUUID()}`;
}

const KEY_LO = 0x21;
const KEY_HI = 0x7e;

export function keyBetween(prev: string | null, next: string | null): string {
  let i = 0;
  let prefix = "";
  while (true) {
    const ca = prev !== null && i < prev.length ? prev.charCodeAt(i) : KEY_LO - 1;
    const cb = next !== null && i < next.length ? next.charCodeAt(i) : KEY_HI + 1;
    if (ca === cb) {
      prefix += String.fromCharCode(ca);
      i++;
      continue;
    }
    if (cb - ca >= 2) {
      return prefix + String.fromCharCode(Math.floor((ca + cb) / 2));
    }
    prefix += String.fromCharCode(ca);
    i++;
    while (true) {
      const tail = prev !== null && i < prev.length ? prev.charCodeAt(i) : KEY_LO - 1;
      if (tail < KEY_HI) {
        return prefix + String.fromCharCode(Math.floor((tail + KEY_HI + 1) / 2));
      }
      prefix += String.fromCharCode(tail);
      i++;
    }
  }
}

export function providerLabel(provider: ProviderKind): string {
  return PROVIDERS.find((entry) => entry.provider === provider)?.label ?? provider;
}

export function sortKanbanItems(items: readonly KanbanItem[]): KanbanItem[] {
  return [...items].toSorted(
    (left, right) =>
      left.sortKey.localeCompare(right.sortKey) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

export function dispatchKanbanCommand(command: ClientOrchestrationCommand) {
  const api = readNativeApi();
  if (!api) return Promise.resolve();
  return api.orchestration.dispatchCommand(command).catch((error) => {
    console.warn("Failed to dispatch Kanban command.", error);
  });
}
