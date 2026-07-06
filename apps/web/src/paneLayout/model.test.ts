import { describe, expect, it } from "vitest";

import {
  containsPane,
  countPanes,
  firstPaneKey,
  flattenPaneKeys,
  insertPaneAtEdge,
  insertPaneAtRootEdge,
  movePane,
  normalizePaneLayout,
  pane,
  removePane,
  replacePaneKey,
  split,
} from "./model";

describe("normalizePaneLayout", () => {
  it("keeps a lone pane as-is", () => {
    expect(normalizePaneLayout(pane("a"))).toEqual(pane("a"));
  });

  it("drops duplicate panes keeping the first occurrence", () => {
    expect(normalizePaneLayout(split("row", [pane("a"), pane("b"), pane("a")]))).toEqual(
      split("row", [pane("a"), pane("b")]),
    );
  });

  it("drops blank pane keys and trims whitespace", () => {
    expect(normalizePaneLayout(split("row", [pane("  a "), pane("   ")]))).toEqual(pane("a"));
  });

  it("collapses single-child splits", () => {
    expect(normalizePaneLayout(split("row", [split("column", [pane("a")])]))).toEqual(pane("a"));
  });

  it("merges nested splits of the same direction", () => {
    expect(
      normalizePaneLayout(split("row", [pane("a"), split("row", [pane("b"), pane("c")])])),
    ).toEqual(split("row", [pane("a"), pane("b"), pane("c")]));
  });

  it("merges splits that become same-direction after collapsing", () => {
    expect(
      normalizePaneLayout(
        split("row", [pane("a"), split("column", [split("row", [pane("b"), pane("c")])])]),
      ),
    ).toEqual(split("row", [pane("a"), pane("b"), pane("c")]));
  });

  it("keeps opposite-direction nesting", () => {
    const layout = split("row", [pane("a"), split("column", [pane("b"), pane("c")])]);
    expect(normalizePaneLayout(layout)).toEqual(layout);
  });

  it("caps the pane count in traversal order", () => {
    expect(
      normalizePaneLayout(split("row", [pane("a"), pane("b"), pane("c")]), { maxPaneCount: 2 }),
    ).toEqual(split("row", [pane("a"), pane("b")]));
  });

  it("returns null for an empty layout", () => {
    expect(normalizePaneLayout(null)).toBeNull();
    expect(normalizePaneLayout(split("row", []))).toBeNull();
  });
});

describe("insertPaneAtEdge", () => {
  it("splits the target pane horizontally", () => {
    expect(insertPaneAtEdge(pane("a"), "a", "right", "b")).toEqual(
      split("row", [pane("a"), pane("b")]),
    );
    expect(insertPaneAtEdge(pane("a"), "a", "left", "b")).toEqual(
      split("row", [pane("b"), pane("a")]),
    );
  });

  it("splits the target pane vertically inside a row", () => {
    expect(insertPaneAtEdge(split("row", [pane("a"), pane("b")]), "b", "bottom", "c")).toEqual(
      split("row", [pane("a"), split("column", [pane("b"), pane("c")])]),
    );
  });

  it("inserts as a sibling when the edge direction matches the parent split", () => {
    expect(insertPaneAtEdge(split("row", [pane("a"), pane("b")]), "a", "right", "c")).toEqual(
      split("row", [pane("a"), pane("c"), pane("b")]),
    );
  });

  it("falls back to the root edge when the target is missing", () => {
    expect(insertPaneAtEdge(split("row", [pane("a"), pane("b")]), "missing", "top", "c")).toEqual(
      split("column", [pane("c"), split("row", [pane("a"), pane("b")])]),
    );
  });
});

describe("insertPaneAtRootEdge", () => {
  it("creates the pane when the layout is empty", () => {
    expect(insertPaneAtRootEdge(null, "right", "a")).toEqual(pane("a"));
  });

  it("appends along the root row without extra nesting", () => {
    expect(insertPaneAtRootEdge(split("row", [pane("a"), pane("b")]), "right", "c")).toEqual(
      split("row", [pane("a"), pane("b"), pane("c")]),
    );
  });

  it("wraps the layout when the edge runs the other way", () => {
    expect(insertPaneAtRootEdge(split("row", [pane("a"), pane("b")]), "bottom", "c")).toEqual(
      split("column", [split("row", [pane("a"), pane("b")]), pane("c")]),
    );
  });
});

describe("removePane", () => {
  it("collapses the split left behind", () => {
    expect(removePane(split("row", [pane("a"), pane("b")]), "a")).toEqual(pane("b"));
  });

  it("unnests when the collapse merges directions", () => {
    const layout = split("row", [
      pane("a"),
      split("column", [pane("b"), split("row", [pane("c"), pane("d")])]),
    ]);
    expect(removePane(layout, "b")).toEqual(split("row", [pane("a"), pane("c"), pane("d")]));
  });

  it("returns null when the last pane is removed", () => {
    expect(removePane(pane("a"), "a")).toBeNull();
  });

  it("ignores unknown keys", () => {
    const layout = split("row", [pane("a"), pane("b")]);
    expect(removePane(layout, "missing")).toEqual(layout);
  });
});

describe("movePane", () => {
  it("relocates a pane next to the target", () => {
    expect(movePane(split("row", [pane("a"), pane("b"), pane("c")]), "c", "a", "left")).toEqual(
      split("row", [pane("c"), pane("a"), pane("b")]),
    );
  });

  it("creates a cross-direction split when moving onto an edge", () => {
    expect(movePane(split("row", [pane("a"), pane("b"), pane("c")]), "c", "a", "top")).toEqual(
      split("row", [split("column", [pane("c"), pane("a")]), pane("b")]),
    );
  });

  it("is a no-op for identical source and target", () => {
    const layout = split("row", [pane("a"), pane("b")]);
    expect(movePane(layout, "a", "a", "left")).toBe(layout);
  });
});

describe("replacePaneKey", () => {
  it("swaps the pane content in place", () => {
    expect(replacePaneKey(split("row", [pane("a"), pane("b")]), "b", "c")).toEqual(
      split("row", [pane("a"), pane("c")]),
    );
  });
});

describe("tree helpers", () => {
  const layout = split("row", [pane("a"), split("column", [pane("b"), pane("c")])]);

  it("flattens pane keys in traversal order", () => {
    expect(flattenPaneKeys(layout)).toEqual(["a", "b", "c"]);
    expect(countPanes(layout)).toBe(3);
    expect(containsPane(layout, "b")).toBe(true);
    expect(containsPane(layout, "missing")).toBe(false);
  });

  it("resolves the first pane key of a subtree", () => {
    expect(firstPaneKey(layout)).toBe("a");
    expect(firstPaneKey(split("column", [pane("b"), pane("c")]))).toBe("b");
  });
});
