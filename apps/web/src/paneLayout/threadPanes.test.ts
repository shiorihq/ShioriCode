import { describe, expect, it } from "vitest";
import { ThreadId } from "contracts";

import { pane, split } from "./model";
import {
  closeThreadPane,
  dropThreadOnPane,
  encodeThreadPaneSearchValue,
  normalizeThreadPaneSearchParam,
  openThreadPaneBeside,
  parseThreadPaneSearchValue,
  resolveThreadPaneLayout,
  threadPaneIds,
} from "./threadPanes";

const threadA = ThreadId.makeUnsafe("thread-a");
const threadB = ThreadId.makeUnsafe("thread-b");
const threadC = ThreadId.makeUnsafe("thread-c");
const threadD = ThreadId.makeUnsafe("thread-d");
const threadE = ThreadId.makeUnsafe("thread-e");

describe("parse/encode thread pane search values", () => {
  it("parses repeated values and removes duplicates", () => {
    expect(
      threadPaneIds(parseThreadPaneSearchValue(["thread-a,thread-b", "thread-b", "thread-c"])),
    ).toEqual([threadA, threadB, threadC]);
  });

  it("caps the pane count", () => {
    expect(
      threadPaneIds(parseThreadPaneSearchValue("thread-a,thread-b,thread-c,thread-d,thread-e")),
    ).toEqual([threadA, threadB, threadC, threadD]);
  });

  it("omits the pane search value when only one pane remains", () => {
    expect(encodeThreadPaneSearchValue(pane(threadA))).toBeUndefined();
    expect(encodeThreadPaneSearchValue(split("row", [pane(threadA), pane(threadB)]))).toBe(
      "thread-a,thread-b",
    );
  });

  it("normalizes raw search params to their canonical encoding", () => {
    expect(normalizeThreadPaneSearchParam(" thread-a,thread-b,,thread-a ")).toBe(
      "thread-a,thread-b",
    );
    expect(normalizeThreadPaneSearchParam("thread-a")).toBeUndefined();
    expect(normalizeThreadPaneSearchParam("thread-a,(thread-b,thread-c)")).toBe(
      "thread-a,(thread-b,thread-c)",
    );
  });
});

describe("resolveThreadPaneLayout", () => {
  it("keeps the focused thread in the existing pane structure", () => {
    const layout = split("row", [pane(threadA), split("column", [pane(threadB), pane(threadC)])]);
    expect(
      resolveThreadPaneLayout({
        focusedThreadId: threadB,
        layout,
        isThreadAvailable: () => true,
      }),
    ).toEqual(layout);
  });

  it("prepends a focused thread missing from the layout", () => {
    expect(
      resolveThreadPaneLayout({
        focusedThreadId: threadA,
        layout: pane(threadB),
        isThreadAvailable: () => true,
      }),
    ).toEqual(split("row", [pane(threadA), pane(threadB)]));
  });

  it("drops unavailable secondary panes and repairs the structure", () => {
    expect(
      resolveThreadPaneLayout({
        focusedThreadId: threadA,
        layout: split("row", [pane(threadA), split("column", [pane(threadB), pane(threadC)])]),
        isThreadAvailable: (threadId) => threadId !== threadB,
      }),
    ).toEqual(split("row", [pane(threadA), pane(threadC)]));
  });

  it("always yields a pane for the focused thread", () => {
    expect(
      resolveThreadPaneLayout({
        focusedThreadId: threadA,
        layout: null,
        isThreadAvailable: () => false,
      }),
    ).toEqual(pane(threadA));
  });
});

describe("openThreadPaneBeside", () => {
  it("opens the thread at the right edge", () => {
    expect(
      openThreadPaneBeside({ focusedThreadId: threadA, layout: pane(threadA), threadId: threadB }),
    ).toEqual(split("row", [pane(threadA), pane(threadB)]));
  });

  it("starts a layout from scratch when nothing is open", () => {
    expect(
      openThreadPaneBeside({ focusedThreadId: null, layout: null, threadId: threadA }),
    ).toEqual(pane(threadA));
  });

  it("keeps the structure when the thread is already open", () => {
    const layout = split("row", [pane(threadA), pane(threadB)]);
    expect(openThreadPaneBeside({ focusedThreadId: threadA, layout, threadId: threadB })).toEqual(
      layout,
    );
  });

  it("evicts the oldest non-focused pane at the cap", () => {
    expect(
      openThreadPaneBeside({
        focusedThreadId: threadA,
        layout: split("row", [pane(threadA), pane(threadB), pane(threadC), pane(threadD)]),
        threadId: threadE,
      }),
    ).toEqual(split("row", [pane(threadA), pane(threadC), pane(threadD), pane(threadE)]));
  });
});

describe("dropThreadOnPane", () => {
  const layout = split("row", [pane(threadA), pane(threadB)]);

  it("splits the target on an edge drop and focuses the dropped thread", () => {
    expect(
      dropThreadOnPane({
        droppedThreadId: threadC,
        focusedThreadId: threadA,
        layout,
        targetThreadId: threadB,
        zone: "bottom",
      }),
    ).toEqual({
      focusedThreadId: threadC,
      layout: split("row", [pane(threadA), split("column", [pane(threadB), pane(threadC)])]),
    });
  });

  it("moves an already open thread instead of duplicating it", () => {
    expect(
      dropThreadOnPane({
        droppedThreadId: threadB,
        focusedThreadId: threadA,
        layout,
        targetThreadId: threadA,
        zone: "left",
      }),
    ).toEqual({
      focusedThreadId: threadB,
      layout: split("row", [pane(threadB), pane(threadA)]),
    });
  });

  it("focuses an already open thread on a center drop without changing the layout", () => {
    expect(
      dropThreadOnPane({
        droppedThreadId: threadB,
        focusedThreadId: threadA,
        layout,
        targetThreadId: threadA,
        zone: "center",
      }),
    ).toEqual({ focusedThreadId: threadB, layout });
  });

  it("swaps a new thread into the target pane on a center drop", () => {
    expect(
      dropThreadOnPane({
        droppedThreadId: threadC,
        focusedThreadId: threadA,
        layout,
        targetThreadId: threadB,
        zone: "center",
      }),
    ).toEqual({
      focusedThreadId: threadC,
      layout: split("row", [pane(threadA), pane(threadC)]),
    });
  });

  it("is a no-op when a thread is dropped onto itself", () => {
    expect(
      dropThreadOnPane({
        droppedThreadId: threadB,
        focusedThreadId: threadA,
        layout,
        targetThreadId: threadB,
        zone: "left",
      }),
    ).toEqual({ focusedThreadId: threadB, layout });
  });

  it("evicts to the cap on edge drops, keeping focus, target, and dropped panes", () => {
    expect(
      dropThreadOnPane({
        droppedThreadId: threadE,
        focusedThreadId: threadA,
        layout: split("row", [pane(threadA), pane(threadB), pane(threadC), pane(threadD)]),
        targetThreadId: threadD,
        zone: "right",
      }),
    ).toEqual({
      focusedThreadId: threadE,
      layout: split("row", [pane(threadA), pane(threadC), pane(threadD), pane(threadE)]),
    });
  });
});

describe("closeThreadPane", () => {
  const layout = split("row", [pane(threadA), pane(threadB), pane(threadC), pane(threadD)]);

  it("keeps focus stable when closing a non-focused pane", () => {
    expect(closeThreadPane({ closingThreadId: threadB, focusedThreadId: threadC, layout })).toEqual(
      {
        focusedThreadId: threadC,
        layout: split("row", [pane(threadA), pane(threadC), pane(threadD)]),
      },
    );
  });

  it("focuses the pane that takes the closed pane's position", () => {
    expect(closeThreadPane({ closingThreadId: threadB, focusedThreadId: threadB, layout })).toEqual(
      {
        focusedThreadId: threadC,
        layout: split("row", [pane(threadA), pane(threadC), pane(threadD)]),
      },
    );
  });

  it("focuses the previous pane when closing the last one", () => {
    expect(
      closeThreadPane({
        closingThreadId: threadD,
        focusedThreadId: threadD,
        layout: split("row", [pane(threadA), pane(threadB), pane(threadD)]),
      }),
    ).toEqual({
      focusedThreadId: threadB,
      layout: split("row", [pane(threadA), pane(threadB)]),
    });
  });

  it("returns no focus when closing the final pane", () => {
    expect(
      closeThreadPane({
        closingThreadId: threadA,
        focusedThreadId: threadA,
        layout: pane(threadA),
      }),
    ).toEqual({ focusedThreadId: null, layout: null });
  });
});
