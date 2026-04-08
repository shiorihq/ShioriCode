import type { WorkLogEntry } from "../../session-logic";

function uniqueStrings(values: ReadonlyArray<string>): string[] {
  return values.filter((value, index, array) => array.indexOf(value) === index);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => asTrimmedString(entry))
        .filter((entry): entry is string => entry !== null)
    : [];
}

export function isSubagentWorkEntry(entry: WorkLogEntry): boolean {
  return entry.itemType === "collab_agent_tool_call" && typeof entry.itemId === "string";
}

export function findSubagentRootEntry(
  workEntries: ReadonlyArray<WorkLogEntry>,
  rootItemId: string | null | undefined,
): WorkLogEntry | null {
  if (!rootItemId) {
    return null;
  }
  return (
    workEntries.find(
      (entry) => entry.itemId === rootItemId && entry.itemType === "collab_agent_tool_call",
    ) ?? null
  );
}

export function collectSubagentDescendantEntries(
  workEntries: ReadonlyArray<WorkLogEntry>,
  rootItemId: string | null | undefined,
): WorkLogEntry[] {
  if (!rootItemId) {
    return [];
  }

  const descendantItemIds = new Set<string>([rootItemId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of workEntries) {
      if (!entry.itemId || !entry.parentItemId) {
        continue;
      }
      if (descendantItemIds.has(entry.parentItemId) && !descendantItemIds.has(entry.itemId)) {
        descendantItemIds.add(entry.itemId);
        changed = true;
      }
    }
  }

  return workEntries.filter(
    (entry) =>
      entry.itemId !== rootItemId &&
      ((entry.itemId && descendantItemIds.has(entry.itemId)) ||
        (entry.parentItemId && descendantItemIds.has(entry.parentItemId))),
  );
}

export function extractCodexProviderThreadIdsFromWorkEntry(entry: WorkLogEntry): string[] {
  const output = asRecord(entry.output);
  const item = asRecord(output?.item) ?? output;
  const result = asRecord(output?.result);
  return uniqueStrings([
    ...asStringArray(item?.receiverThreadIds),
    ...asStringArray(output?.receiverThreadIds),
    ...asStringArray(result?.receiverThreadIds),
  ]);
}

export function extractSubagentResultSummary(entry: WorkLogEntry): string | null {
  const output = asRecord(entry.output);
  const result = asRecord(output?.result);
  const directContent = asTrimmedString(result?.content) ?? asTrimmedString(result?.summary);
  if (directContent) {
    return directContent;
  }

  if (Array.isArray(result?.content)) {
    const text = result.content
      .map((block) => asTrimmedString(asRecord(block)?.text))
      .filter((value): value is string => value !== null)
      .join("\n\n");
    return text.length > 0 ? text : null;
  }

  return null;
}
