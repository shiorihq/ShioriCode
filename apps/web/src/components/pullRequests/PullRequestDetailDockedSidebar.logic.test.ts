import { afterEach, describe, expect, it, vi } from "vitest";

import { hasVisibleDiffContent } from "~/lib/diffVisibility";

function makeRoot(nodes: readonly unknown[]): ParentNode {
  return {
    querySelectorAll: () => nodes,
  } as unknown as ParentNode;
}

function makeNode(input?: {
  rectCount?: number;
  textContent?: string;
  style?: {
    display?: string;
    visibility?: string;
    opacity?: string;
  };
}) {
  return {
    getClientRects: () => ({ length: input?.rectCount ?? 0 }),
    textContent: input?.textContent ?? "",
    __style: {
      display: input?.style?.display ?? "block",
      visibility: input?.style?.visibility ?? "visible",
      opacity: input?.style?.opacity ?? "1",
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hasVisibleDiffContent", () => {
  it("returns false when there is no rendered diff content", () => {
    vi.stubGlobal("window", {
      getComputedStyle: (node: { __style: object }) => node.__style,
    });

    expect(hasVisibleDiffContent(makeRoot([]))).toBe(false);
  });

  it("returns true when diff content has visible text", () => {
    vi.stubGlobal("window", {
      getComputedStyle: (node: { __style: object }) => node.__style,
    });

    expect(hasVisibleDiffContent(makeRoot([makeNode({ textContent: "src/app.ts" })]))).toBe(true);
  });

  it("returns true when diff content has visible layout but no text", () => {
    vi.stubGlobal("window", {
      getComputedStyle: (node: { __style: object }) => node.__style,
    });

    expect(hasVisibleDiffContent(makeRoot([makeNode({ rectCount: 1 })]))).toBe(true);
  });

  it("ignores hidden diff content", () => {
    vi.stubGlobal("window", {
      getComputedStyle: (node: { __style: object }) => node.__style,
    });

    expect(
      hasVisibleDiffContent(
        makeRoot([
          makeNode({
            textContent: "src/app.ts",
            style: { display: "none" },
          }),
        ]),
      ),
    ).toBe(false);
  });
});
