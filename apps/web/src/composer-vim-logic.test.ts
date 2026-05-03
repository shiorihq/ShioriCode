import { describe, expect, it } from "vitest";

import {
  applyComposerVimKey,
  createComposerVimState,
  type ComposerVimState,
} from "./composer-vim-logic";
import { collapseExpandedComposerCursor } from "./composer-logic";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

function press(
  state: ComposerVimState,
  text: string,
  cursor: number,
  key: string,
  ctrlKey = false,
) {
  return applyComposerVimKey({ text, cursor, key, ctrlKey }, state);
}

function runKeys(
  text: string,
  cursor: number,
  keys: readonly string[],
  state = createComposerVimState("normal"),
) {
  return keys.reduce((current, key) => press(current.state, current.text, current.cursor, key), {
    state,
    text,
    cursor,
  });
}

describe("composer Vim mode transitions", () => {
  it("enters normal mode from insert and returns to insert", () => {
    const insert = createComposerVimState("insert");
    const escaped = press(insert, "hello", 5, "Escape");

    expect(escaped.state.mode).toBe("normal");
    expect(escaped.cursor).toBe(4);

    const inserted = press(escaped.state, escaped.text, escaped.cursor, "i");
    expect(inserted.state.mode).toBe("insert");
    expect(inserted.cursor).toBe(4);
  });

  it("enters and exits visual modes", () => {
    const visual = press(createComposerVimState("normal"), "hello", 0, "v");
    expect(visual.state.mode).toBe("visual");
    expect(visual.selection).toEqual({ anchor: 0, focus: 1 });

    const normal = press(visual.state, visual.text, visual.cursor, "Escape");
    expect(normal.state.mode).toBe("normal");

    const visualLine = press(normal.state, "one\ntwo", 0, "V");
    expect(visualLine.state.mode).toBe("visual-line");
    expect(visualLine.selection).toEqual({ anchor: 0, focus: 4 });
  });
});

describe("composer Vim movement", () => {
  it("moves with h/l and counts", () => {
    expect(runKeys("abcdef", 2, ["l"]).cursor).toBe(3);
    expect(runKeys("abcdef", 3, ["h"]).cursor).toBe(2);
    expect(runKeys("abcdef", 0, ["3", "l"]).cursor).toBe(3);
    expect(runKeys("abc", 2, ["l"]).cursor).toBe(2);
  });

  it("moves by words and line boundaries", () => {
    expect(runKeys("one two three", 0, ["w"]).cursor).toBe(4);
    expect(runKeys("one two three", 8, ["b"]).cursor).toBe(4);
    expect(runKeys("one two three", 0, ["e"]).cursor).toBe(2);
    expect(runKeys("  indented", 5, ["0"]).cursor).toBe(0);
    expect(runKeys("  indented", 0, ["^"]).cursor).toBe(2);
    expect(runKeys("  indented", 0, ["$"]).cursor).toBe("  indented".length - 1);
  });

  it("moves with gg/G and vertical counts", () => {
    const text = "one\ntwo\nthree";
    expect(runKeys(text, text.length, ["g", "g"]).cursor).toBe(0);
    expect(runKeys(text, 0, ["G"]).cursor).toBe("one\ntwo\n".length);
    expect(runKeys(text, 0, ["2", "j"]).cursor).toBe("one\ntwo\n".length);
  });
});

describe("composer Vim edits", () => {
  it("deletes characters with x/X", () => {
    expect(runKeys("abc", 1, ["x"]).text).toBe("ac");
    expect(runKeys("abc", 2, ["X"]).text).toBe("ac");
  });

  it("supports line and motion delete/change commands", () => {
    expect(runKeys("one\ntwo\nthree", 0, ["d", "d"]).text).toBe("two\nthree");
    expect(runKeys("one\ntwo\nthree", 0, ["2", "d", "d"]).text).toBe("three");
    expect(runKeys("one two", 0, ["d", "w"]).text).toBe("two");
    expect(runKeys("one two", 4, ["d", "$"]).text).toBe("one ");
    expect(runKeys("one two\nthree", 0, ["d", "$"]).text).toBe("\nthree");
    expect(runKeys("one two", 4, ["d", "Shift", "$"]).text).toBe("one ");

    const changedWord = runKeys("one two", 0, ["c", "w"]);
    expect(changedWord.text).toBe("two");
    expect(changedWord.state.mode).toBe("insert");

    const changedLine = runKeys("one\ntwo", 0, ["c", "c"]);
    expect(changedLine.text).toBe("two");
    expect(changedLine.state.mode).toBe("insert");
  });

  it("supports D/C and replace", () => {
    expect(runKeys("one two", 4, ["D"]).text).toBe("one ");
    const deletedLastCharacter = runKeys("abc", 2, ["x"]);
    expect(deletedLastCharacter.text).toBe("ab");
    expect(deletedLastCharacter.cursor).toBe(1);
    expect(press(deletedLastCharacter.state, deletedLastCharacter.text, 1, "x").text).toBe("a");

    const changed = runKeys("one two", 4, ["C"]);
    expect(changed.text).toBe("one ");
    expect(changed.state.mode).toBe("insert");

    expect(runKeys("abc", 1, ["r", "z"]).text).toBe("azc");
  });

  it("opens new lines and places the cursor on the inserted line", () => {
    const openedBelow = runKeys("one\ntwo", 1, ["o"]);
    expect(openedBelow.text).toBe("one\n\ntwo");
    expect(openedBelow.cursor).toBe("one\n".length);
    expect(openedBelow.state.mode).toBe("insert");

    const openedAbove = runKeys("one\ntwo", 5, ["O"]);
    expect(openedAbove.text).toBe("one\n\ntwo");
    expect(openedAbove.cursor).toBe("one\n".length);
    expect(openedAbove.state.mode).toBe("insert");
  });
});

describe("composer Vim yank and paste", () => {
  it("duplicates lines with yy/p/P", () => {
    const yanked = runKeys("one\ntwo", 0, ["y", "y"]);
    expect(yanked.state.register).toEqual({ text: "one\n", linewise: true });

    expect(press(yanked.state, yanked.text, yanked.cursor, "p").text).toBe("one\none\ntwo");
    expect(runKeys("one\ntwo", 4, ["y", "y", "P"]).text).toBe("one\ntwo\ntwo");
  });

  it("yanks words and visual selections into the internal register", () => {
    const yanked = runKeys("one two", 0, ["y", "w"]);
    expect(yanked.state.register).toEqual({ text: "one", linewise: false });
    expect(press(yanked.state, yanked.text, yanked.cursor, "p").text).toBe("oonene two");

    const visual = runKeys("abcdef", 1, ["v", "l", "l", "y"]);
    expect(visual.state.register).toEqual({ text: "bcd", linewise: false });
    expect(press(visual.state, visual.text, visual.cursor, "p").text).toBe("abbcdcdef");
  });

  it("applies paste counts", () => {
    const yanked = runKeys("one two", 0, ["y", "w"]);
    expect(runKeys(yanked.text, yanked.cursor, ["3", "p"], yanked.state).text).toBe(
      "ooneoneonene two",
    );

    const yankedLine = runKeys("one\ntwo", 0, ["y", "y"]);
    expect(runKeys(yankedLine.text, yankedLine.cursor, ["3", "p"], yankedLine.state).text).toBe(
      "one\none\none\none\ntwo",
    );
  });
});

describe("composer Vim inline token offsets", () => {
  it("does not split mention tokens during movement, delete, yank, or paste", () => {
    const text = "open @AGENTS.md next";
    const mentionCursor = collapseExpandedComposerCursor(text, "open @AGENTS.md".length);

    expect(runKeys(text, mentionCursor, ["h"]).cursor).toBe("open ".length);
    expect(runKeys(text, "open ".length, ["x"]).text).toBe("open  next");

    const yanked = runKeys(text, "open ".length, ["y", "w"]);
    expect(yanked.state.register.text).toBe("@AGENTS.md");
    expect(press(yanked.state, yanked.text, yanked.cursor, "p").text).toContain("@AGENTS.md");
  });

  it("does not split terminal context placeholders", () => {
    const text = `open ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} next`;
    const tokenCursor = "open ".length;

    expect(runKeys(text, tokenCursor, ["x"]).text).toBe("open  next");

    const yanked = runKeys(text, tokenCursor, ["y", "w"]);
    expect(yanked.state.register.text).toBe(INLINE_TERMINAL_CONTEXT_PLACEHOLDER);
    expect(press(yanked.state, yanked.text, yanked.cursor, "p").text).toContain(
      INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
    );
  });
});
