import { describe, expect, it } from "vitest";

import { encodePaneLayout, parsePaneLayoutValue } from "./serialization";
import { pane, split } from "./model";

describe("parsePaneLayoutValue", () => {
  it("parses legacy flat lists as a row", () => {
    expect(parsePaneLayoutValue("a,b,c")).toEqual(split("row", [pane("a"), pane("b"), pane("c")]));
  });

  it("parses a single pane", () => {
    expect(parsePaneLayoutValue("a")).toEqual(pane("a"));
  });

  it("parses nested groups with alternating directions", () => {
    expect(parsePaneLayoutValue("a,(b,c)")).toEqual(
      split("row", [pane("a"), split("column", [pane("b"), pane("c")])]),
    );
    expect(parsePaneLayoutValue("a,(b,(c,d))")).toEqual(
      split("row", [pane("a"), split("column", [pane("b"), split("row", [pane("c"), pane("d")])])]),
    );
  });

  it("parses a column-first root", () => {
    expect(parsePaneLayoutValue("(a,b)")).toEqual(split("column", [pane("a"), pane("b")]));
  });

  it("joins repeated search values", () => {
    expect(parsePaneLayoutValue(["a,b", "c"])).toEqual(
      split("row", [pane("a"), pane("b"), pane("c")]),
    );
  });

  it("trims whitespace and drops empty and duplicate entries", () => {
    expect(parsePaneLayoutValue(" a , b ,, a ")).toEqual(split("row", [pane("a"), pane("b")]));
  });

  it("returns null for empty or non-string values", () => {
    expect(parsePaneLayoutValue(undefined)).toBeNull();
    expect(parsePaneLayoutValue(42)).toBeNull();
    expect(parsePaneLayoutValue("   ")).toBeNull();
    expect(parsePaneLayoutValue(",,,")).toBeNull();
  });

  it("degrades malformed input to a flat row of its pane keys", () => {
    expect(parsePaneLayoutValue("a,(b,c")).toEqual(split("row", [pane("a"), pane("b"), pane("c")]));
    expect(parsePaneLayoutValue("a)b,c")).toEqual(split("row", [pane("a"), pane("b"), pane("c")]));
    expect(parsePaneLayoutValue("a(b),c")).toEqual(split("row", [pane("a"), pane("b"), pane("c")]));
  });
});

describe("encodePaneLayout", () => {
  it("omits layouts with fewer than two panes", () => {
    expect(encodePaneLayout(null)).toBeUndefined();
    expect(encodePaneLayout(pane("a"))).toBeUndefined();
  });

  it("encodes a flat row without grouping", () => {
    expect(encodePaneLayout(split("row", [pane("a"), pane("b")]))).toBe("a,b");
  });

  it("encodes nesting with parentheses", () => {
    expect(
      encodePaneLayout(split("row", [pane("a"), split("column", [pane("b"), pane("c")])])),
    ).toBe("a,(b,c)");
    expect(encodePaneLayout(split("column", [pane("a"), pane("b")]))).toBe("(a,b)");
  });

  it("round-trips every layout shape", () => {
    const layouts = [
      split("row", [pane("a"), pane("b"), pane("c")]),
      split("row", [pane("a"), split("column", [pane("b"), pane("c")])]),
      split("column", [split("row", [pane("a"), pane("b")]), pane("c")]),
      split("row", [split("column", [pane("a"), split("row", [pane("b"), pane("c")])]), pane("d")]),
    ];
    for (const layout of layouts) {
      const encoded = encodePaneLayout(layout);
      expect(encoded).toBeDefined();
      expect(parsePaneLayoutValue(encoded)).toEqual(layout);
    }
  });
});
