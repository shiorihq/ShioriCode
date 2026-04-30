import { describe, expect, it } from "vitest";
import type { ResolvedKeybindingsConfig } from "contracts";

import {
  resolveAppSidebarShortcutCommand,
  resolveAppTitlebarWindowControlsLeftInset,
} from "./AppSidebarLayout.logic";

const APP_SIDEBAR_BINDINGS = [
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
  {
    command: "project.add",
    shortcut: {
      key: "o",
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
  {
    command: "pullRequests.open",
    shortcut: {
      key: "p",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: false,
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

describe("resolveAppSidebarShortcutCommand", () => {
  it("resolves the sidebar shortcut even after an editor already prevented the event", () => {
    expect(
      resolveAppSidebarShortcutCommand(
        createEvent({
          defaultPrevented: true,
          metaKey: true,
          key: "b",
        }),
        APP_SIDEBAR_BINDINGS,
        {
          terminalFocus: false,
          terminalOpen: false,
          platform: "MacIntel",
        },
      ),
    ).toBe("sidebar.toggle");
  });

  it("resolves project.add and pullRequests.open shortcuts", () => {
    expect(
      resolveAppSidebarShortcutCommand(
        createEvent({ metaKey: true, key: "o" }),
        APP_SIDEBAR_BINDINGS,
        {
          terminalFocus: false,
          terminalOpen: false,
          platform: "MacIntel",
        },
      ),
    ).toBe("project.add");

    expect(
      resolveAppSidebarShortcutCommand(
        createEvent({ metaKey: true, key: "p" }),
        APP_SIDEBAR_BINDINGS,
        {
          terminalFocus: false,
          terminalOpen: false,
          platform: "MacIntel",
        },
      ),
    ).toBe("pullRequests.open");
  });

  it("does not override unrelated prevented shortcuts", () => {
    expect(
      resolveAppSidebarShortcutCommand(
        createEvent({
          defaultPrevented: true,
          key: "k",
          metaKey: true,
        }),
        APP_SIDEBAR_BINDINGS,
        {
          terminalFocus: false,
          terminalOpen: false,
          platform: "MacIntel",
        },
      ),
    ).toBeNull();
  });

  it("respects the terminal-focus guard for guarded shortcuts", () => {
    expect(
      resolveAppSidebarShortcutCommand(
        createEvent({
          key: "b",
          metaKey: true,
        }),
        APP_SIDEBAR_BINDINGS,
        {
          terminalFocus: true,
          terminalOpen: true,
          platform: "MacIntel",
        },
      ),
    ).toBeNull();
  });
});

describe("resolveAppTitlebarWindowControlsLeftInset", () => {
  it("does not reserve content space while the sidebar is open", () => {
    expect(
      resolveAppTitlebarWindowControlsLeftInset({
        isElectron: true,
        isMac: true,
        sidebarOpen: true,
        windowControlsInset: 90,
      }),
    ).toBe(0);
  });

  it("reserves only the titlebar inset when the desktop mac sidebar is closed", () => {
    expect(
      resolveAppTitlebarWindowControlsLeftInset({
        isElectron: true,
        isMac: true,
        sidebarOpen: false,
        windowControlsInset: 90,
      }),
    ).toBe(90);
  });

  it("does not reserve titlebar space outside desktop mac", () => {
    expect(
      resolveAppTitlebarWindowControlsLeftInset({
        isElectron: false,
        isMac: true,
        sidebarOpen: false,
        windowControlsInset: 90,
      }),
    ).toBe(0);

    expect(
      resolveAppTitlebarWindowControlsLeftInset({
        isElectron: true,
        isMac: false,
        sidebarOpen: false,
        windowControlsInset: 90,
      }),
    ).toBe(0);
  });
});
