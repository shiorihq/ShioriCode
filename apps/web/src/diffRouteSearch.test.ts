import { describe, expect, it } from "vitest";

import {
  parseDiffRouteSearch,
  stripBrowserSearchParams,
  stripArtifactSearchParams,
  stripRightPanelSearchParam,
  stripRightSidebarSearchParams,
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
        panel: "browser",
      }),
    ).toEqual({
      browser: "1",
      panel: "browser",
    });
  });

  it("parses artifact panel search values", () => {
    expect(
      parseDiffRouteSearch({
        artifact: true,
        artifactPath: "docs/plan.md",
        panel: "artifact",
      }),
    ).toEqual({
      artifact: "1",
      artifactPath: "docs/plan.md",
      panel: "artifact",
    });
  });

  it("drops panel values without a matching open panel", () => {
    expect(
      parseDiffRouteSearch({
        browser: true,
        panel: "diff",
      }),
    ).toEqual({
      browser: "1",
    });
  });

  it("drops artifact panel values without a path", () => {
    expect(
      parseDiffRouteSearch({
        artifact: true,
        artifactPath: "  ",
      }),
    ).toEqual({});
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

describe("stripArtifactSearchParams", () => {
  it("removes artifact panel search state", () => {
    expect(
      stripArtifactSearchParams({
        artifact: "1",
        artifactPath: "docs/plan.md",
        panes: "thread-a,thread-b",
      }),
    ).toEqual({
      artifact: undefined,
      artifactPath: undefined,
      browser: undefined,
      diff: undefined,
      diffFilePath: undefined,
      diffTurnId: undefined,
      panel: undefined,
      panes: "thread-a,thread-b",
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

describe("stripRightPanelSearchParam", () => {
  it("removes only the active right panel selection", () => {
    expect(
      stripRightPanelSearchParam({
        diff: "1",
        browser: "1",
        panel: "browser",
      }),
    ).toEqual({
      diff: "1",
      browser: "1",
    });
  });
});

describe("stripRightSidebarSearchParams", () => {
  it("removes every right sidebar panel flag and preserves unrelated search", () => {
    expect(
      stripRightSidebarSearchParams({
        diff: "1",
        diffTurnId: "turn-1",
        diffFilePath: "src/app.ts",
        browser: "1",
        artifact: "1",
        artifactPath: "docs/plan.md",
        panel: "browser",
        panes: "thread-a,thread-b",
      }),
    ).toEqual({
      panes: "thread-a,thread-b",
    });
  });
});
