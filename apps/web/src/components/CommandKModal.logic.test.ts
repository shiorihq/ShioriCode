import { describe, expect, it } from "vitest";

import { shouldToggleCommandK, type CommandKShortcutEvent } from "./CommandKModal.logic";

function createShortcutEvent(
  overrides: Partial<CommandKShortcutEvent> = {},
): CommandKShortcutEvent {
  return {
    key: "k",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("shouldToggleCommandK", () => {
  it("allows cmd+k when the terminal is not focused", () => {
    expect(
      shouldToggleCommandK(createShortcutEvent({ metaKey: true }), {
        terminalFocused: false,
      }),
    ).toBe(true);
  });

  it("allows ctrl+k when the terminal is not focused", () => {
    expect(
      shouldToggleCommandK(createShortcutEvent({ ctrlKey: true }), {
        terminalFocused: false,
      }),
    ).toBe(true);
  });

  it("rejects non-k shortcuts", () => {
    expect(
      shouldToggleCommandK(createShortcutEvent({ ctrlKey: true, key: "j" }), {
        terminalFocused: false,
      }),
    ).toBe(false);
  });

  it("rejects shortcuts without a command modifier", () => {
    expect(
      shouldToggleCommandK(createShortcutEvent(), {
        terminalFocused: false,
      }),
    ).toBe(false);
  });

  it("rejects shift-modified shortcuts", () => {
    expect(
      shouldToggleCommandK(createShortcutEvent({ metaKey: true, shiftKey: true }), {
        terminalFocused: false,
      }),
    ).toBe(false);
  });

  it("rejects alt-modified shortcuts", () => {
    expect(
      shouldToggleCommandK(createShortcutEvent({ metaKey: true, altKey: true }), {
        terminalFocused: false,
      }),
    ).toBe(false);
  });

  it("rejects the shortcut while the terminal is focused", () => {
    expect(
      shouldToggleCommandK(createShortcutEvent({ metaKey: true }), {
        terminalFocused: true,
      }),
    ).toBe(false);
  });
});
