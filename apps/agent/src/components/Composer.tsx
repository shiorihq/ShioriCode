import { Box, Text, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import { palette } from "../theme";

export type EditorMode = "normal" | "vim";
export type VimMode = "INSERT" | "NORMAL";

export interface ComposerProps {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly focused: boolean;
  readonly navigationDisabled?: boolean;
  readonly reserveEmptyQuestionMark?: boolean;
  readonly editorMode: EditorMode;
  readonly vimMode: VimMode;
  readonly onVimModeChange: (mode: VimMode) => void;
  readonly onHistoryPrev?: () => void;
  readonly onHistoryNext?: () => void;
}

function splitLines(text: string): string[] {
  return text.split("\n");
}

function cursorToRowCol(text: string, cursor: number): { row: number; col: number } {
  const before = text.slice(0, cursor);
  const lines = splitLines(before);
  return { row: lines.length - 1, col: lines[lines.length - 1]?.length ?? 0 };
}

function rowColToCursor(text: string, row: number, col: number): number {
  const lines = splitLines(text);
  const safeRow = Math.max(0, Math.min(row, lines.length - 1));
  const line = lines[safeRow] ?? "";
  const safeCol = Math.max(0, Math.min(col, line.length));
  let cursor = 0;
  for (let index = 0; index < safeRow; index += 1) {
    cursor += (lines[index]?.length ?? 0) + 1;
  }
  return cursor + safeCol;
}

function currentLineStart(text: string, cursor: number): number {
  const { row } = cursorToRowCol(text, cursor);
  return rowColToCursor(text, row, 0);
}

function currentLineEnd(text: string, cursor: number): number {
  const { row } = cursorToRowCol(text, Math.min(cursor, text.length));
  const line = splitLines(text)[row] ?? "";
  const end = rowColToCursor(text, row, line.length);
  return line.length === 0 ? end : end - 1;
}

function currentLineAppendPosition(text: string, cursor: number): number {
  const { row } = cursorToRowCol(text, Math.min(cursor, text.length));
  const line = splitLines(text)[row] ?? "";
  return rowColToCursor(text, row, line.length);
}

function clampNormalCursor(text: string, cursor: number): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.max(0, Math.min(cursor, text.length - 1));
}

function moveVerticalNormal(text: string, cursor: number, delta: number): number {
  const { row, col } = cursorToRowCol(text, Math.min(cursor, text.length));
  const lines = splitLines(text);
  const nextRow = Math.max(0, Math.min(lines.length - 1, row + delta));
  const nextLine = lines[nextRow] ?? "";
  if (nextLine.length === 0) {
    return rowColToCursor(text, nextRow, 0);
  }
  return clampNormalCursor(text, rowColToCursor(text, nextRow, Math.min(col, nextLine.length - 1)));
}

function isWordChar(char: string | undefined): boolean {
  return typeof char === "string" && /^[A-Za-z0-9_]$/.test(char);
}

function nextWordStart(text: string, cursor: number): number {
  if (text.length === 0) {
    return 0;
  }
  let index = clampNormalCursor(text, cursor);
  if (isWordChar(text[index])) {
    while (index < text.length && isWordChar(text[index])) {
      index += 1;
    }
  } else {
    index += 1;
  }
  while (index < text.length && !isWordChar(text[index])) {
    index += 1;
  }
  return clampNormalCursor(text, index >= text.length ? text.length - 1 : index);
}

function previousWordStart(text: string, cursor: number): number {
  if (text.length === 0) {
    return 0;
  }
  let index = clampNormalCursor(text, cursor);
  if (index === 0) {
    return 0;
  }
  index -= 1;
  while (index > 0 && !isWordChar(text[index])) {
    index -= 1;
  }
  while (index > 0 && isWordChar(text[index - 1])) {
    index -= 1;
  }
  return index;
}

function endOfWord(text: string, cursor: number): number {
  if (text.length === 0) {
    return 0;
  }
  let index = clampNormalCursor(text, cursor);
  while (index < text.length && !isWordChar(text[index])) {
    index += 1;
  }
  if (index >= text.length) {
    return text.length - 1;
  }
  while (index < text.length - 1 && isWordChar(text[index + 1])) {
    index += 1;
  }
  return index;
}

export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  focused,
  navigationDisabled = false,
  reserveEmptyQuestionMark = false,
  editorMode,
  vimMode,
  onVimModeChange,
  onHistoryPrev,
  onHistoryNext,
}: ComposerProps) {
  const [cursor, setCursor] = useState(value.length);

  useEffect(() => {
    setCursor((current) => Math.min(current, value.length));
  }, [value]);

  useEffect(() => {
    if (editorMode === "normal" && vimMode !== "INSERT") {
      onVimModeChange("INSERT");
    }
  }, [editorMode, vimMode, onVimModeChange]);

  const setText = useCallback(
    (nextText: string, nextCursor: number) => {
      onChange(nextText);
      setCursor(Math.max(0, Math.min(nextCursor, nextText.length)));
    },
    [onChange],
  );

  const enterInsertMode = useCallback(
    (nextCursor: number) => {
      setCursor(Math.max(0, Math.min(nextCursor, value.length)));
      onVimModeChange("INSERT");
    },
    [onVimModeChange, value.length],
  );

  const enterNormalMode = useCallback(() => {
    const nextCursor =
      cursor > 0 && value[cursor - 1] !== "\n" ? cursor - 1 : Math.min(cursor, value.length);
    setCursor(clampNormalCursor(value, nextCursor));
    onVimModeChange("NORMAL");
  }, [cursor, onVimModeChange, value]);

  useInput(
    (input, key) => {
      if (disabled) {
        return;
      }

      if (editorMode === "vim") {
        if (key.escape && vimMode === "INSERT") {
          enterNormalMode();
          return;
        }
        if (key.escape && vimMode === "NORMAL") {
          return;
        }

        if (vimMode === "NORMAL") {
          if (key.return) {
            const trimmed = value.trim();
            if (trimmed.length === 0) {
              return;
            }
            onSubmit(trimmed);
            return;
          }

          if (key.leftArrow || input === "h") {
            setCursor((current) => clampNormalCursor(value, current - 1));
            return;
          }
          if (key.rightArrow || input === "l") {
            setCursor((current) => clampNormalCursor(value, current + 1));
            return;
          }
          if (!navigationDisabled && (key.upArrow || input === "k")) {
            const { row } = cursorToRowCol(value, Math.min(cursor, value.length));
            if (row > 0) {
              setCursor(moveVerticalNormal(value, cursor, -1));
              return;
            }
            onHistoryPrev?.();
            return;
          }
          if (!navigationDisabled && (key.downArrow || input === "j")) {
            const { row } = cursorToRowCol(value, Math.min(cursor, value.length));
            const rowCount = splitLines(value).length;
            if (row < rowCount - 1) {
              setCursor(moveVerticalNormal(value, cursor, 1));
              return;
            }
            onHistoryNext?.();
            return;
          }

          switch (input) {
            case "0":
              setCursor(currentLineStart(value, cursor));
              return;
            case "$":
              setCursor(currentLineEnd(value, cursor));
              return;
            case "w":
              setCursor(nextWordStart(value, cursor));
              return;
            case "b":
              setCursor(previousWordStart(value, cursor));
              return;
            case "e":
              setCursor(endOfWord(value, cursor));
              return;
            case "i":
              enterInsertMode(cursor);
              return;
            case "a":
              enterInsertMode(Math.min(value.length, cursor + 1));
              return;
            case "I":
              enterInsertMode(currentLineStart(value, cursor));
              return;
            case "A":
              enterInsertMode(currentLineAppendPosition(value, cursor));
              return;
            case "o": {
              const insertAt = currentLineAppendPosition(value, cursor);
              setText(value.slice(0, insertAt) + "\n" + value.slice(insertAt), insertAt + 1);
              onVimModeChange("INSERT");
              return;
            }
            case "O": {
              const insertAt = currentLineStart(value, cursor);
              setText(value.slice(0, insertAt) + "\n" + value.slice(insertAt), insertAt);
              onVimModeChange("INSERT");
              return;
            }
            case "x":
              if (value.length === 0) {
                return;
              }
              setText(
                value.slice(0, cursor) + value.slice(cursor + 1),
                clampNormalCursor(value.slice(0, cursor) + value.slice(cursor + 1), cursor),
              );
              return;
            case "/":
              setText(value.slice(0, cursor) + "/" + value.slice(cursor), cursor + 1);
              onVimModeChange("INSERT");
              return;
            default:
              return;
          }
        }
      }

      if (key.return) {
        // Shift+Enter or option+Enter (meta) inserts a newline; plain Enter submits.
        if (key.shift || key.meta) {
          setText(value.slice(0, cursor) + "\n" + value.slice(cursor), cursor + 1);
          return;
        }
        const trimmed = value.trim();
        if (trimmed.length === 0) {
          return;
        }
        onSubmit(trimmed);
        return;
      }

      if (key.leftArrow) {
        setCursor((current) => Math.max(0, current - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((current) => Math.min(value.length, current + 1));
        return;
      }
      if (!navigationDisabled && key.upArrow) {
        const { row, col } = cursorToRowCol(value, cursor);
        if (row > 0) {
          setCursor(rowColToCursor(value, row - 1, col));
          return;
        }
        onHistoryPrev?.();
        return;
      }
      if (!navigationDisabled && key.downArrow) {
        const { row, col } = cursorToRowCol(value, cursor);
        const rowCount = splitLines(value).length;
        if (row < rowCount - 1) {
          setCursor(rowColToCursor(value, row + 1, col));
          return;
        }
        onHistoryNext?.();
        return;
      }

      if (key.ctrl && input === "a") {
        const { row } = cursorToRowCol(value, cursor);
        setCursor(rowColToCursor(value, row, 0));
        return;
      }
      if (key.ctrl && input === "e") {
        const { row } = cursorToRowCol(value, cursor);
        const line = splitLines(value)[row] ?? "";
        setCursor(rowColToCursor(value, row, line.length));
        return;
      }
      if (key.ctrl && input === "u") {
        const { row } = cursorToRowCol(value, cursor);
        const start = rowColToCursor(value, row, 0);
        setText(value.slice(0, start) + value.slice(cursor), start);
        return;
      }
      if (key.ctrl && input === "k") {
        const { row } = cursorToRowCol(value, cursor);
        const line = splitLines(value)[row] ?? "";
        const end = rowColToCursor(value, row, line.length);
        setText(value.slice(0, cursor) + value.slice(end), cursor);
        return;
      }
      if (key.ctrl && input === "w") {
        const upTo = value.slice(0, cursor);
        const match = upTo.match(/(\S+\s*|\s+)$/);
        const removed = match ? match[0].length : 1;
        setText(value.slice(0, cursor - removed) + value.slice(cursor), cursor - removed);
        return;
      }

      if (key.backspace || key.delete) {
        if (cursor === 0) {
          return;
        }
        setText(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
        return;
      }

      if (key.ctrl || key.meta) {
        return;
      }

      if (reserveEmptyQuestionMark && value.length === 0 && input === "?") {
        return;
      }

      if (input && input.length > 0) {
        setText(value.slice(0, cursor) + input + value.slice(cursor), cursor + input.length);
      }
    },
    { isActive: focused },
  );

  const rendered = useMemo(
    () => renderValue(value, cursor, focused, placeholder, editorMode, vimMode),
    [value, cursor, focused, placeholder, editorMode, vimMode],
  );

  return (
    <Box
      borderStyle="round"
      borderColor={focused ? palette.accent : palette.neutral}
      paddingX={1}
      flexDirection="column"
    >
      <Box flexDirection="row">
        <Text color={focused ? palette.accent : palette.neutral}>{"› "}</Text>
        <Box flexDirection="column" flexGrow={1}>
          {rendered}
        </Box>
      </Box>
    </Box>
  );
}

function renderValue(
  value: string,
  cursor: number,
  focused: boolean,
  placeholder: string | undefined,
  editorMode: EditorMode,
  vimMode: VimMode,
) {
  if (value.length === 0) {
    return (
      <Text>
        {focused ? (
          <Text inverse>{editorMode === "vim" && vimMode === "NORMAL" ? "·" : " "}</Text>
        ) : null}
        <Text dimColor>{placeholder ?? "Type a message…"}</Text>
      </Text>
    );
  }

  const lines = splitLines(value);
  const { row: cursorRow, col: cursorCol } = cursorToRowCol(value, cursor);

  return lines.map((line, rowIndex) => {
    const rowKey = `row:${rowIndex}:${line}`;
    if (!focused || rowIndex !== cursorRow) {
      return <Text key={rowKey}>{line.length === 0 ? " " : line}</Text>;
    }
    const before = line.slice(0, cursorCol);
    const at = line[cursorCol] ?? " ";
    const after = line.slice(cursorCol + 1);
    return (
      <Text key={rowKey}>
        {before}
        <Text inverse>{editorMode === "vim" && vimMode === "NORMAL" && at === " " ? "·" : at}</Text>
        {after}
      </Text>
    );
  });
}
