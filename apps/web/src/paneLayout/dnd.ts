/**
 * Native drag-and-drop helpers for pane layouts: the thread drag payload and
 * the geometry that maps a pointer position over a pane to a drop zone.
 */

import { ThreadId } from "contracts";

import type { PaneDropZone } from "./model";

export const THREAD_PANE_DRAG_MIME_TYPE = "application/x-shioricode-thread-id";

/** Fraction of each axis (from the edges inward) that counts as an edge zone. */
const EDGE_ZONE_RATIO = 0.25;

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

/**
 * Map a pointer position within a pane to a drop zone: the middle of the pane
 * targets the pane itself, the outer quarters target the nearest edge.
 */
export function resolveDropZone(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): PaneDropZone {
  if (rect.width <= 0 || rect.height <= 0) {
    return "center";
  }

  const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));

  const insideCenter =
    x >= EDGE_ZONE_RATIO &&
    x <= 1 - EDGE_ZONE_RATIO &&
    y >= EDGE_ZONE_RATIO &&
    y <= 1 - EDGE_ZONE_RATIO;
  if (insideCenter) {
    return "center";
  }

  const edgeDistances: ReadonlyArray<readonly [PaneDropZone, number]> = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  let nearest = edgeDistances[0]!;
  for (const candidate of edgeDistances) {
    if (candidate[1] < nearest[1]) {
      nearest = candidate;
    }
  }
  return nearest[0];
}
