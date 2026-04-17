import { Box, Text, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import { palette } from "../theme";

export interface ComposerProps {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly focused: boolean;
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

export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  focused,
  onHistoryPrev,
  onHistoryNext,
}: ComposerProps) {
  const [cursor, setCursor] = useState(value.length);

  useEffect(() => {
    setCursor((current) => Math.min(current, value.length));
  }, [value]);

  const setText = useCallback(
    (nextText: string, nextCursor: number) => {
      onChange(nextText);
      setCursor(Math.max(0, Math.min(nextCursor, nextText.length)));
    },
    [onChange],
  );

  useInput(
    (input, key) => {
      if (disabled) {
        return;
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
      if (key.upArrow) {
        const { row, col } = cursorToRowCol(value, cursor);
        if (row > 0) {
          setCursor(rowColToCursor(value, row - 1, col));
          return;
        }
        onHistoryPrev?.();
        return;
      }
      if (key.downArrow) {
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

      if (input && input.length > 0) {
        setText(value.slice(0, cursor) + input + value.slice(cursor), cursor + input.length);
      }
    },
    { isActive: focused },
  );

  const rendered = useMemo(
    () => renderValue(value, cursor, focused, placeholder),
    [value, cursor, focused, placeholder],
  );

  return (
    <Box
      borderStyle="round"
      borderColor={focused ? palette.accent : palette.neutral}
      paddingX={1}
      flexDirection="row"
    >
      <Text color={focused ? palette.accent : palette.neutral}>{"› "}</Text>
      <Box flexDirection="column" flexGrow={1}>
        {rendered}
      </Box>
    </Box>
  );
}

function renderValue(
  value: string,
  cursor: number,
  focused: boolean,
  placeholder: string | undefined,
) {
  if (value.length === 0) {
    return (
      <Text>
        {focused ? <Text inverse> </Text> : null}
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
        <Text inverse>{at}</Text>
        {after}
      </Text>
    );
  });
}
