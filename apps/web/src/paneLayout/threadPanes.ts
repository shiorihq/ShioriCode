/**
 * Thread-pane policy on top of the generic layout model: parsing/encoding the
 * `panes` search param, availability filtering, the pane-count cap with
 * eviction, drop semantics, and focus succession on close.
 */

import { ThreadId } from "contracts";

import {
  containsPane,
  countPanes,
  flattenPaneKeys,
  insertPaneAtEdge,
  insertPaneAtRootEdge,
  movePane,
  normalizePaneLayout,
  pane,
  removePane,
  replacePaneKey,
  type PaneDropZone,
  type PaneLayoutNode,
} from "./model";
import { encodePaneLayout, parsePaneLayoutValue } from "./serialization";

export const MAX_THREAD_PANE_COUNT = 4;

export function parseThreadPaneSearchValue(value: unknown): PaneLayoutNode | null {
  return normalizePaneLayout(parsePaneLayoutValue(value), {
    maxPaneCount: MAX_THREAD_PANE_COUNT,
  });
}

export function encodeThreadPaneSearchValue(layout: PaneLayoutNode | null): string | undefined {
  return encodePaneLayout(layout);
}

/** Round-trip a raw search value into its canonical encoded form. */
export function normalizeThreadPaneSearchParam(value: unknown): string | undefined {
  return encodeThreadPaneSearchValue(parseThreadPaneSearchValue(value));
}

export function threadPaneIds(layout: PaneLayoutNode | null): ThreadId[] {
  return flattenPaneKeys(layout).map((key) => ThreadId.makeUnsafe(key));
}

/**
 * Reconcile a parsed layout against the world: drop panes whose threads no
 * longer exist and make sure the focused thread has a pane.
 */
export function resolveThreadPaneLayout(input: {
  focusedThreadId: ThreadId;
  layout: PaneLayoutNode | null;
  isThreadAvailable: (threadId: ThreadId) => boolean;
}): PaneLayoutNode {
  let layout = normalizePaneLayout(input.layout, { maxPaneCount: MAX_THREAD_PANE_COUNT });

  for (const key of flattenPaneKeys(layout)) {
    const paneThreadId = ThreadId.makeUnsafe(key);
    if (paneThreadId !== input.focusedThreadId && !input.isThreadAvailable(paneThreadId)) {
      layout = removePane(layout, key);
    }
  }

  if (!containsPane(layout, input.focusedThreadId)) {
    layout = insertPaneAtRootEdge(layout, "left", input.focusedThreadId);
  }

  return evictToCap(layout ?? pane(input.focusedThreadId), [input.focusedThreadId]);
}

/** Open a thread in a new pane at the right edge, keeping the current focus. */
export function openThreadPaneBeside(input: {
  focusedThreadId: ThreadId | null;
  layout: PaneLayoutNode | null;
  threadId: ThreadId;
}): PaneLayoutNode {
  let layout = input.layout ?? (input.focusedThreadId ? pane(input.focusedThreadId) : null);
  if (layout !== null && input.focusedThreadId && !containsPane(layout, input.focusedThreadId)) {
    layout = insertPaneAtRootEdge(layout, "left", input.focusedThreadId);
  }
  if (layout !== null && containsPane(layout, input.threadId)) {
    return layout;
  }
  return evictToCap(insertPaneAtRootEdge(layout, "right", input.threadId), [
    input.focusedThreadId,
    input.threadId,
  ]);
}

export interface ThreadPaneDropResult {
  focusedThreadId: ThreadId;
  layout: PaneLayoutNode;
}

/**
 * Apply a drop onto a pane. Edge zones split the target (moving the pane if
 * the thread is already open); the center zone focuses an already-open thread
 * or swaps it into the target pane. The dropped thread takes focus.
 */
export function dropThreadOnPane(input: {
  droppedThreadId: ThreadId;
  focusedThreadId: ThreadId;
  layout: PaneLayoutNode;
  targetThreadId: ThreadId;
  zone: PaneDropZone;
}): ThreadPaneDropResult {
  const { droppedThreadId, focusedThreadId, layout, targetThreadId, zone } = input;

  if (droppedThreadId === targetThreadId) {
    return { focusedThreadId: droppedThreadId, layout };
  }

  if (zone === "center") {
    return containsPane(layout, droppedThreadId)
      ? { focusedThreadId: droppedThreadId, layout }
      : {
          focusedThreadId: droppedThreadId,
          layout: replacePaneKey(layout, targetThreadId, droppedThreadId),
        };
  }

  if (containsPane(layout, droppedThreadId)) {
    return {
      focusedThreadId: droppedThreadId,
      layout: movePane(layout, droppedThreadId, targetThreadId, zone),
    };
  }

  return {
    focusedThreadId: droppedThreadId,
    layout: evictToCap(insertPaneAtEdge(layout, targetThreadId, zone, droppedThreadId), [
      focusedThreadId,
      droppedThreadId,
      targetThreadId,
    ]),
  };
}

export interface CloseThreadPaneResult {
  focusedThreadId: ThreadId | null;
  layout: PaneLayoutNode | null;
}

/**
 * Close a pane. When the focused pane closes, focus moves to the pane that
 * took its position (or the last remaining one). A null focus means the last
 * pane was closed.
 */
export function closeThreadPane(input: {
  closingThreadId: ThreadId;
  focusedThreadId: ThreadId;
  layout: PaneLayoutNode;
}): CloseThreadPaneResult {
  const closingIndex = flattenPaneKeys(input.layout).indexOf(input.closingThreadId);
  const layout = removePane(input.layout, input.closingThreadId);
  const remainingKeys = flattenPaneKeys(layout);
  if (layout === null || remainingKeys.length === 0) {
    return { focusedThreadId: null, layout: null };
  }

  if (
    input.closingThreadId !== input.focusedThreadId &&
    remainingKeys.includes(input.focusedThreadId)
  ) {
    return { focusedThreadId: input.focusedThreadId, layout };
  }

  const nextFocusIndex = Math.min(Math.max(closingIndex, 0), remainingKeys.length - 1);
  const nextFocusKey = remainingKeys[nextFocusIndex] ?? remainingKeys[0];
  return {
    focusedThreadId: nextFocusKey ? ThreadId.makeUnsafe(nextFocusKey) : null,
    layout,
  };
}

/** Remove panes (earliest in traversal order first) until the cap is met. */
function evictToCap(
  layout: PaneLayoutNode,
  keepKeys: ReadonlyArray<string | null>,
): PaneLayoutNode {
  let current = layout;
  while (countPanes(current) > MAX_THREAD_PANE_COUNT) {
    const keys = flattenPaneKeys(current);
    const evictKey = keys.find((key) => !keepKeys.includes(key)) ?? keys[0];
    const next = evictKey === undefined ? null : removePane(current, evictKey);
    if (next === null || countPanes(next) >= countPanes(current)) {
      break;
    }
    current = next;
  }
  return current;
}
