import { ThreadId, TurnId } from "contracts";

export interface DiffRouteSearch {
  diff?: "1" | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
  browser?: "1" | undefined;
  panes?: string | undefined;
}

export const MAX_THREAD_PANE_COUNT = 4;
export const THREAD_PANE_DRAG_MIME_TYPE = "application/x-shioricode-thread-id";

function isPanelOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function stripDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diff" | "diffTurnId" | "diffFilePath"> {
  const { diff: _diff, diffTurnId: _diffTurnId, diffFilePath: _diffFilePath, ...rest } = params;
  return rest as Omit<T, "diff" | "diffTurnId" | "diffFilePath">;
}

export function stripBrowserSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "browser"> {
  const { browser: _browser, ...rest } = params;
  return rest as Omit<T, "browser">;
}

export function parseThreadPaneSearchValue(value: unknown): ThreadId[] {
  const rawValues = Array.isArray(value) ? value : [value];
  const threadIds: ThreadId[] = [];
  const seen = new Set<string>();

  for (const rawValue of rawValues) {
    if (typeof rawValue !== "string") {
      continue;
    }

    for (const rawThreadId of rawValue.split(",")) {
      const normalized = rawThreadId.trim();
      if (normalized.length === 0 || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      threadIds.push(ThreadId.makeUnsafe(normalized));
      if (threadIds.length >= MAX_THREAD_PANE_COUNT) {
        return threadIds;
      }
    }
  }

  return threadIds;
}

export function encodeThreadPaneSearchValue(threadIds: readonly ThreadId[]): string | undefined {
  const normalized = parseThreadPaneSearchValue(threadIds.join(","));
  return normalized.length > 1 ? normalized.join(",") : undefined;
}

export function writeThreadPaneDragData(dataTransfer: DataTransfer, threadId: ThreadId): void {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(THREAD_PANE_DRAG_MIME_TYPE, threadId);
  dataTransfer.setData("text/plain", threadId);
}

export function readThreadPaneDragData(dataTransfer: DataTransfer): ThreadId | null {
  const rawThreadId =
    dataTransfer.getData(THREAD_PANE_DRAG_MIME_TYPE) || dataTransfer.getData("text/plain");
  const threadId = rawThreadId.trim();
  return threadId.length > 0 ? ThreadId.makeUnsafe(threadId) : null;
}

export function hasThreadPaneDragData(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(THREAD_PANE_DRAG_MIME_TYPE);
}

export function resolveVisibleThreadPaneIds(input: {
  focusedThreadId: ThreadId;
  paneThreadIds: readonly ThreadId[];
  isThreadAvailable: (threadId: ThreadId) => boolean;
}): ThreadId[] {
  const focusedThreadId = input.focusedThreadId;
  const rawPaneThreadIds = input.paneThreadIds.includes(focusedThreadId)
    ? input.paneThreadIds
    : [focusedThreadId, ...input.paneThreadIds];
  const visibleThreadIds: ThreadId[] = [];
  const seen = new Set<string>();

  for (const paneThreadId of rawPaneThreadIds) {
    if (seen.has(paneThreadId)) {
      continue;
    }
    if (paneThreadId !== focusedThreadId && !input.isThreadAvailable(paneThreadId)) {
      continue;
    }
    seen.add(paneThreadId);
    visibleThreadIds.push(paneThreadId);
    if (visibleThreadIds.length >= MAX_THREAD_PANE_COUNT) {
      return visibleThreadIds;
    }
  }

  return visibleThreadIds.length > 0 ? visibleThreadIds : [focusedThreadId];
}

export function addThreadPaneId(input: {
  focusedThreadId: ThreadId | null;
  paneThreadIds: readonly ThreadId[];
  threadId: ThreadId;
}): ThreadId[] {
  const focusedThreadId = input.focusedThreadId ?? input.threadId;
  const existingThreadIds =
    input.paneThreadIds.length > 0 ? input.paneThreadIds : [focusedThreadId];
  const nextThreadIds = [
    ...(existingThreadIds.includes(focusedThreadId)
      ? existingThreadIds
      : [focusedThreadId, ...existingThreadIds]),
  ].filter((paneThreadId) => paneThreadId !== input.threadId);
  nextThreadIds.push(input.threadId);

  while (nextThreadIds.length > MAX_THREAD_PANE_COUNT) {
    const dropIndex = nextThreadIds.findIndex(
      (paneThreadId) => paneThreadId !== focusedThreadId && paneThreadId !== input.threadId,
    );
    nextThreadIds.splice(dropIndex >= 0 ? dropIndex : 0, 1);
  }

  return nextThreadIds;
}

export function resolveDroppedThreadPaneIds(input: {
  focusedThreadId: ThreadId;
  paneThreadIds: readonly ThreadId[];
  threadId: ThreadId;
}): ThreadId[] {
  return input.paneThreadIds.includes(input.threadId)
    ? [...input.paneThreadIds]
    : addThreadPaneId(input);
}

export function closeThreadPane(input: {
  focusedThreadId: ThreadId;
  paneThreadIds: readonly ThreadId[];
  closingThreadId: ThreadId;
}): { focusedThreadId: ThreadId | null; paneThreadIds: ThreadId[] } {
  const closingIndex = input.paneThreadIds.indexOf(input.closingThreadId);
  const nextPaneThreadIds = input.paneThreadIds.filter(
    (paneThreadId) => paneThreadId !== input.closingThreadId,
  );
  if (nextPaneThreadIds.length === 0) {
    return { focusedThreadId: null, paneThreadIds: [] };
  }

  if (input.closingThreadId !== input.focusedThreadId) {
    return {
      focusedThreadId: input.focusedThreadId,
      paneThreadIds: nextPaneThreadIds,
    };
  }

  const nextFocusIndex = Math.min(Math.max(closingIndex, 0), nextPaneThreadIds.length - 1);
  return {
    focusedThreadId: nextPaneThreadIds[nextFocusIndex] ?? nextPaneThreadIds[0] ?? null,
    paneThreadIds: nextPaneThreadIds,
  };
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const diff = isPanelOpenValue(search.diff) ? "1" : undefined;
  const diffTurnIdRaw = diff ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.makeUnsafe(diffTurnIdRaw) : undefined;
  const diffFilePath = diff && diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;
  const browser = isPanelOpenValue(search.browser) ? "1" : undefined;
  const panes = encodeThreadPaneSearchValue(parseThreadPaneSearchValue(search.panes));

  return {
    ...(diff ? { diff } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(browser ? { browser } : {}),
    ...(panes ? { panes } : {}),
  };
}
