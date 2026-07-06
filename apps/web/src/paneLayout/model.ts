/**
 * Pure layout-tree model for split-screen panes.
 *
 * A layout is a tree of panes (leaves) and splits (row/column branches). Pane
 * identity is an opaque string key, so the model stays agnostic of what a pane
 * renders — thread panes today, other pane kinds later. All operations are
 * pure and return normalized trees; sizes are a presentation concern and live
 * outside the model (see sizes.ts).
 *
 * Invariants of a normalized layout:
 * - every pane key appears at most once (first occurrence in traversal order wins)
 * - splits have at least two children
 * - a split never directly contains a split of the same direction
 */

export type SplitDirection = "row" | "column";

export type PaneEdge = "left" | "right" | "top" | "bottom";

export type PaneDropZone = PaneEdge | "center";

export interface PaneNode {
  readonly type: "pane";
  readonly key: string;
}

export interface SplitNode {
  readonly type: "split";
  readonly direction: SplitDirection;
  readonly children: ReadonlyArray<PaneLayoutNode>;
}

export type PaneLayoutNode = PaneNode | SplitNode;

export function pane(key: string): PaneNode {
  return { type: "pane", key };
}

export function split(
  direction: SplitDirection,
  children: ReadonlyArray<PaneLayoutNode>,
): SplitNode {
  return { type: "split", direction, children };
}

export function oppositeDirection(direction: SplitDirection): SplitDirection {
  return direction === "row" ? "column" : "row";
}

export function edgeSplitDirection(edge: PaneEdge): SplitDirection {
  return edge === "left" || edge === "right" ? "row" : "column";
}

export function edgeInsertsBefore(edge: PaneEdge): boolean {
  return edge === "left" || edge === "top";
}

export function flattenPaneKeys(node: PaneLayoutNode | null): string[] {
  if (node === null) {
    return [];
  }
  if (node.type === "pane") {
    return [node.key];
  }
  return node.children.flatMap((child) => flattenPaneKeys(child));
}

export function countPanes(node: PaneLayoutNode | null): number {
  return flattenPaneKeys(node).length;
}

export function containsPane(node: PaneLayoutNode | null, key: string): boolean {
  return flattenPaneKeys(node).includes(key);
}

/** First pane key in traversal order — a stable identity for a subtree. */
export function firstPaneKey(node: PaneLayoutNode): string {
  return node.type === "pane" ? (node.key ?? "") : (flattenPaneKeys(node)[0] ?? "");
}

export interface NormalizePaneLayoutOptions {
  readonly maxPaneCount?: number;
}

export function normalizePaneLayout(
  node: PaneLayoutNode | null,
  options: NormalizePaneLayoutOptions = {},
): PaneLayoutNode | null {
  if (node === null) {
    return null;
  }

  const maxPaneCount = options.maxPaneCount ?? Number.POSITIVE_INFINITY;
  const seen = new Set<string>();

  const rebuild = (current: PaneLayoutNode): PaneLayoutNode | null => {
    if (current.type === "pane") {
      const key = current.key.trim();
      if (key.length === 0 || seen.has(key) || seen.size >= maxPaneCount) {
        return null;
      }
      seen.add(key);
      return key === current.key ? current : pane(key);
    }

    const children: PaneLayoutNode[] = [];
    for (const child of current.children) {
      const rebuilt = rebuild(child);
      if (rebuilt === null) {
        continue;
      }
      if (rebuilt.type === "split" && rebuilt.direction === current.direction) {
        children.push(...rebuilt.children);
      } else {
        children.push(rebuilt);
      }
    }

    if (children.length === 0) {
      return null;
    }
    const [onlyChild] = children;
    if (children.length === 1 && onlyChild) {
      return onlyChild;
    }
    return split(current.direction, children);
  };

  return rebuild(node);
}

/**
 * Split the target pane along the given edge, placing the new pane on that
 * side. Callers must ensure `key` is not already present (use movePane to
 * relocate an existing pane). Falls back to a root-edge insert when the
 * target is missing.
 */
export function insertPaneAtEdge(
  node: PaneLayoutNode | null,
  targetKey: string,
  edge: PaneEdge,
  key: string,
): PaneLayoutNode {
  if (node === null || !containsPane(node, targetKey)) {
    return insertPaneAtRootEdge(node, edge, key);
  }

  const direction = edgeSplitDirection(edge);
  const replaceTarget = (current: PaneLayoutNode): PaneLayoutNode => {
    if (current.type === "pane") {
      if (current.key !== targetKey) {
        return current;
      }
      const children = edgeInsertsBefore(edge) ? [pane(key), current] : [current, pane(key)];
      return split(direction, children);
    }
    return split(current.direction, current.children.map(replaceTarget));
  };

  return normalizePaneLayout(replaceTarget(node)) ?? pane(key);
}

/** Insert a pane along an edge of the whole layout. */
export function insertPaneAtRootEdge(
  node: PaneLayoutNode | null,
  edge: PaneEdge,
  key: string,
): PaneLayoutNode {
  const inserted = pane(key);
  if (node === null) {
    return inserted;
  }
  const direction = edgeSplitDirection(edge);
  const children = edgeInsertsBefore(edge) ? [inserted, node] : [node, inserted];
  return normalizePaneLayout(split(direction, children)) ?? inserted;
}

export function removePane(node: PaneLayoutNode | null, key: string): PaneLayoutNode | null {
  if (node === null) {
    return null;
  }

  const strip = (current: PaneLayoutNode): PaneLayoutNode | null => {
    if (current.type === "pane") {
      return current.key === key ? null : current;
    }
    const children = current.children
      .map(strip)
      .filter((child): child is PaneLayoutNode => child !== null);
    if (children.length === 0) {
      return null;
    }
    return split(current.direction, children);
  };

  return normalizePaneLayout(strip(node));
}

/** Relocate an existing pane next to the target pane along the given edge. */
export function movePane(
  node: PaneLayoutNode,
  sourceKey: string,
  targetKey: string,
  edge: PaneEdge,
): PaneLayoutNode {
  if (sourceKey === targetKey) {
    return node;
  }
  if (!containsPane(node, sourceKey) || !containsPane(node, targetKey)) {
    return node;
  }
  const without = removePane(node, sourceKey);
  if (without === null) {
    return node;
  }
  return insertPaneAtEdge(without, targetKey, edge, sourceKey);
}

/** Swap the content of the target pane. Callers must ensure `key` is not already present. */
export function replacePaneKey(
  node: PaneLayoutNode,
  targetKey: string,
  key: string,
): PaneLayoutNode {
  const replace = (current: PaneLayoutNode): PaneLayoutNode => {
    if (current.type === "pane") {
      return current.key === targetKey ? pane(key) : current;
    }
    return split(current.direction, current.children.map(replace));
  };
  return normalizePaneLayout(replace(node)) ?? pane(key);
}
