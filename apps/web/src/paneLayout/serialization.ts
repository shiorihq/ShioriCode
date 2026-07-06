/**
 * URL serialization for pane layouts.
 *
 * Grammar: a comma-separated list splits in the current direction; a
 * parenthesized group nests a list in the opposite direction. The root
 * direction is "row", so:
 *
 *   "t1,t2"      → row [t1, t2]
 *   "t1,(t2,t3)" → row [t1, column [t2, t3]]
 *   "(t1,t2)"    → column [t1, t2]
 *
 * Legacy flat values ("t1,t2,t3") parse naturally as a single row. Malformed
 * input degrades gracefully to a flat row of the pane keys it contains.
 */

import {
  countPanes,
  normalizePaneLayout,
  oppositeDirection,
  pane,
  split,
  type PaneLayoutNode,
  type SplitDirection,
  type SplitNode,
} from "./model";

const GROUP_OPEN = "(";
const GROUP_CLOSE = ")";
const SEPARATOR = ",";
const MAX_NESTING_DEPTH = 6;
const ROOT_DIRECTION: SplitDirection = "row";

export function encodePaneLayout(node: PaneLayoutNode | null): string | undefined {
  const normalized = normalizePaneLayout(node);
  if (normalized === null || countPanes(normalized) < 2) {
    return undefined;
  }
  return normalized.type === "split" && normalized.direction === ROOT_DIRECTION
    ? encodeSplitBody(normalized)
    : encodeItem(normalized, ROOT_DIRECTION);
}

function encodeSplitBody(node: SplitNode): string {
  return node.children.map((child) => encodeItem(child, node.direction)).join(SEPARATOR);
}

function encodeItem(node: PaneLayoutNode, direction: SplitDirection): string {
  if (node.type === "pane") {
    return node.key;
  }
  // A normalized split nested in `direction` always runs the opposite way.
  return `${GROUP_OPEN}${encodeSplitBody(node)}${GROUP_CLOSE}`;
}

export function parsePaneLayoutValue(value: unknown): PaneLayoutNode | null {
  const raw = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").join(SEPARATOR)
    : typeof value === "string"
      ? value
      : null;
  if (raw === null || raw.trim().length === 0) {
    return null;
  }

  try {
    const cursor = { index: 0 };
    const parsed = parseList(raw, cursor, ROOT_DIRECTION, 0);
    if (cursor.index < raw.length) {
      throw new MalformedLayoutError();
    }
    return normalizePaneLayout(parsed);
  } catch (error) {
    if (error instanceof MalformedLayoutError) {
      return parseFlatFallback(raw);
    }
    throw error;
  }
}

class MalformedLayoutError extends Error {
  constructor() {
    super("Malformed pane layout value");
  }
}

function parseList(
  input: string,
  cursor: { index: number },
  direction: SplitDirection,
  depth: number,
): PaneLayoutNode | null {
  if (depth > MAX_NESTING_DEPTH) {
    throw new MalformedLayoutError();
  }

  const children: PaneLayoutNode[] = [];
  let buffer = "";
  const flushBuffer = () => {
    const key = buffer.trim();
    buffer = "";
    if (key.length > 0) {
      children.push(pane(key));
    }
  };

  while (cursor.index < input.length) {
    const char = input[cursor.index];
    if (char === SEPARATOR) {
      flushBuffer();
      cursor.index += 1;
      continue;
    }
    if (char === GROUP_OPEN) {
      if (buffer.trim().length > 0) {
        throw new MalformedLayoutError();
      }
      cursor.index += 1;
      const child = parseList(input, cursor, oppositeDirection(direction), depth + 1);
      if (input[cursor.index] !== GROUP_CLOSE) {
        throw new MalformedLayoutError();
      }
      cursor.index += 1;
      if (child !== null) {
        children.push(child);
      }
      continue;
    }
    if (char === GROUP_CLOSE) {
      if (depth === 0) {
        throw new MalformedLayoutError();
      }
      break;
    }
    buffer += char;
    cursor.index += 1;
  }
  flushBuffer();

  if (children.length === 0) {
    return null;
  }
  const [onlyChild] = children;
  if (children.length === 1 && onlyChild) {
    return onlyChild;
  }
  return split(direction, children);
}

function parseFlatFallback(raw: string): PaneLayoutNode | null {
  const keys = raw
    .split(/[(),]/)
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  if (keys.length === 0) {
    return null;
  }
  return normalizePaneLayout(split(ROOT_DIRECTION, keys.map(pane)));
}
