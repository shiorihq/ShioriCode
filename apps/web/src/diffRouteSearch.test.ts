import { describe, expect, it } from "vitest";
import { ThreadId } from "contracts";

import {
  addThreadPaneId,
  closeThreadPane,
  encodeThreadPaneSearchValue,
  parseDiffRouteSearch,
  parseThreadPaneSearchValue,
  resolveDroppedThreadPaneIds,
  resolveVisibleThreadPaneIds,
  stripBrowserSearchParams,
} from "./diffRouteSearch";

describe("parseDiffRouteSearch", () => {
  it("parses valid diff search values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });
  });

  it("treats numeric and boolean diff toggles as open", () => {
    expect(
      parseDiffRouteSearch({
        diff: 1,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
    });

    expect(
      parseDiffRouteSearch({
        diff: true,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
    });
  });

  it("parses browser panel search values", () => {
    expect(
      parseDiffRouteSearch({
        browser: true,
      }),
    ).toEqual({
      browser: "1",
    });
  });

  it("parses and normalizes thread pane search values", () => {
    expect(
      parseDiffRouteSearch({
        panes: " thread-a,thread-b,,thread-a ",
      }),
    ).toEqual({
      panes: "thread-a,thread-b",
    });
  });

  it("drops turn and file values when diff is closed", () => {
    const parsed = parseDiffRouteSearch({
      diff: "0",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({});
  });

  it("drops file value when turn is not selected", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
    });
  });

  it("normalizes whitespace-only values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "  ",
      diffFilePath: "  ",
    });

    expect(parsed).toEqual({
      diff: "1",
    });
  });
});

describe("thread pane search helpers", () => {
  const threadA = ThreadId.makeUnsafe("thread-a");
  const threadB = ThreadId.makeUnsafe("thread-b");
  const threadC = ThreadId.makeUnsafe("thread-c");
  const threadD = ThreadId.makeUnsafe("thread-d");
  const threadE = ThreadId.makeUnsafe("thread-e");

  it("parses repeated values and removes duplicates", () => {
    expect(parseThreadPaneSearchValue(["thread-a,thread-b", "thread-b", "thread-c"])).toEqual([
      threadA,
      threadB,
      threadC,
    ]);
  });

  it("omits the pane search value when only one thread remains", () => {
    expect(encodeThreadPaneSearchValue([threadA])).toBeUndefined();
    expect(encodeThreadPaneSearchValue([threadA, threadB])).toBe("thread-a,thread-b");
  });

  it("keeps the focused thread in the existing pane order", () => {
    expect(
      resolveVisibleThreadPaneIds({
        focusedThreadId: threadB,
        paneThreadIds: [threadA, threadB, threadC],
        isThreadAvailable: () => true,
      }),
    ).toEqual([threadA, threadB, threadC]);
  });

  it("prepends a focused thread missing from the pane list", () => {
    expect(
      resolveVisibleThreadPaneIds({
        focusedThreadId: threadA,
        paneThreadIds: [threadB],
        isThreadAvailable: () => true,
      }),
    ).toEqual([threadA, threadB]);
  });

  it("drops unavailable secondary panes", () => {
    expect(
      resolveVisibleThreadPaneIds({
        focusedThreadId: threadA,
        paneThreadIds: [threadA, threadB, threadC],
        isThreadAvailable: (threadId) => threadId !== threadB,
      }),
    ).toEqual([threadA, threadC]);
  });

  it("adds a pane while preserving the focused thread and the newest target", () => {
    expect(
      addThreadPaneId({
        focusedThreadId: threadA,
        paneThreadIds: [threadA, threadB, threadC, threadD],
        threadId: threadE,
      }),
    ).toEqual([threadA, threadC, threadD, threadE]);
  });

  it("preserves existing pane order when the focused thread is not first", () => {
    expect(
      addThreadPaneId({
        focusedThreadId: threadB,
        paneThreadIds: [threadA, threadB, threadC],
        threadId: threadD,
      }),
    ).toEqual([threadA, threadB, threadC, threadD]);
  });

  it("focuses an already open dropped thread without reordering panes", () => {
    expect(
      resolveDroppedThreadPaneIds({
        focusedThreadId: threadA,
        paneThreadIds: [threadA, threadB, threadC, threadD],
        threadId: threadB,
      }),
    ).toEqual([threadA, threadB, threadC, threadD]);
  });

  it("keeps focus stable when closing a non-focused pane", () => {
    expect(
      closeThreadPane({
        focusedThreadId: threadC,
        paneThreadIds: [threadA, threadB, threadC, threadD],
        closingThreadId: threadB,
      }),
    ).toEqual({
      focusedThreadId: threadC,
      paneThreadIds: [threadA, threadC, threadD],
    });
  });

  it("focuses the right neighbor when closing the focused pane", () => {
    expect(
      closeThreadPane({
        focusedThreadId: threadB,
        paneThreadIds: [threadA, threadB, threadC, threadD],
        closingThreadId: threadB,
      }),
    ).toEqual({
      focusedThreadId: threadC,
      paneThreadIds: [threadA, threadC, threadD],
    });
  });

  it("focuses the left neighbor when closing the last focused pane", () => {
    expect(
      closeThreadPane({
        focusedThreadId: threadD,
        paneThreadIds: [threadA, threadB, threadD],
        closingThreadId: threadD,
      }),
    ).toEqual({
      focusedThreadId: threadB,
      paneThreadIds: [threadA, threadB],
    });
  });

  it("returns no focus when closing the final pane", () => {
    expect(
      closeThreadPane({
        focusedThreadId: threadA,
        paneThreadIds: [threadA],
        closingThreadId: threadA,
      }),
    ).toEqual({
      focusedThreadId: null,
      paneThreadIds: [],
    });
  });
});

describe("stripBrowserSearchParams", () => {
  it("removes only the browser panel flag", () => {
    expect(
      stripBrowserSearchParams({
        diff: "1",
        diffTurnId: "turn-1",
        browser: "1",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
    });
  });
});
