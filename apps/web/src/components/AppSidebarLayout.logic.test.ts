import { describe, expect, it } from "vitest";
import type { ResolvedKeybindingsConfig } from "contracts";

import { shouldHandleSidebarToggleShortcut } from "./AppSidebarLayout.logic";

const SIDEBAR_TOGGLE_BINDINGS = [
  {
    command: "sidebar.toggle",
    shortcut: {
      key: "b",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    },
    whenAst: {
      type: "not",
      node: { type: "identifier", name: "terminalFocus" },
    },
  },
] satisfies ResolvedKeybindingsConfig;

function createEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    key: "b",
    metaKey: false,
    shiftKey: false,
    type: "keydown",
    ...overrides,
  } as KeyboardEvent;
}

describe("shouldHandleSidebarToggleShortcut", () => {
  it("handles the sidebar shortcut even after an editor already prevented the event", () => {
    expect(
      shouldHandleSidebarToggleShortcut(
        createEvent({
          defaultPrevented: true,
          metaKey: true,
        }),
        SIDEBAR_TOGGLE_BINDINGS,
        {
          terminalFocus: false,
          terminalOpen: false,
        },
      ),
    ).toBe(true);
  });

  it("does not override unrelated prevented shortcuts", () => {
    expect(
      shouldHandleSidebarToggleShortcut(
        createEvent({
          defaultPrevented: true,
          key: "k",
          metaKey: true,
        }),
        SIDEBAR_TOGGLE_BINDINGS,
        {
          terminalFocus: false,
          terminalOpen: false,
        },
      ),
    ).toBe(false);
  });

  it("respects the terminal-focus guard", () => {
    expect(
      shouldHandleSidebarToggleShortcut(
        createEvent({
          metaKey: true,
        }),
        SIDEBAR_TOGGLE_BINDINGS,
        {
          terminalFocus: true,
          terminalOpen: true,
        },
      ),
    ).toBe(false);
  });
});
