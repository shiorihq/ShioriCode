import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";
import { clampCollapsedComposerCursor } from "./composer-logic";

export type ComposerVimMode = "insert" | "normal" | "visual" | "visual-line";

type ComposerVimOperator = "delete" | "change" | "yank";

export interface ComposerVimRegister {
  text: string;
  linewise: boolean;
}

export interface ComposerVimState {
  mode: ComposerVimMode;
  countBuffer: string;
  pendingOperator: {
    operator: ComposerVimOperator;
    count: number;
  } | null;
  pendingGCount: number | null;
  register: ComposerVimRegister;
  visualAnchor: number | null;
  awaitingReplace: {
    count: number;
  } | null;
}

export interface ComposerVimInput {
  text: string;
  cursor: number;
  key: string;
  ctrlKey?: boolean;
}

export interface ComposerVimCommandResult {
  handled: boolean;
  state: ComposerVimState;
  text: string;
  cursor: number;
  selection: { anchor: number; focus: number } | null;
  undo?: boolean;
  redo?: boolean;
}

type AtomicSegment = {
  collapsedStart: number;
  collapsedEnd: number;
  expandedStart: number;
  expandedEnd: number;
  text: string;
};

type MotionKey =
  | "h"
  | "j"
  | "k"
  | "l"
  | "ArrowLeft"
  | "ArrowDown"
  | "ArrowUp"
  | "ArrowRight"
  | "0"
  | "^"
  | "$"
  | "w"
  | "W"
  | "b"
  | "B"
  | "e"
  | "E"
  | "g"
  | "G";

const EMPTY_REGISTER: ComposerVimRegister = { text: "", linewise: false };
const ATOMIC_PLACEHOLDER = "\uFFFC";

export function createComposerVimState(mode: ComposerVimMode = "insert"): ComposerVimState {
  return {
    mode,
    countBuffer: "",
    pendingOperator: null,
    pendingGCount: null,
    register: EMPTY_REGISTER,
    visualAnchor: null,
    awaitingReplace: null,
  };
}

function cloneState(state: ComposerVimState): ComposerVimState {
  return {
    mode: state.mode,
    countBuffer: state.countBuffer,
    pendingOperator: state.pendingOperator ? { ...state.pendingOperator } : null,
    pendingGCount: state.pendingGCount,
    register: { ...state.register },
    visualAnchor: state.visualAnchor,
    awaitingReplace: state.awaitingReplace ? { ...state.awaitingReplace } : null,
  };
}

function buildAtomicSegments(text: string): AtomicSegment[] {
  const segments = splitPromptIntoComposerSegments(text);
  const atomicSegments: AtomicSegment[] = [];
  let expandedOffset = 0;
  let collapsedOffset = 0;

  for (const segment of segments) {
    if (segment.type === "text") {
      const length = segment.text.length;
      atomicSegments.push({
        collapsedStart: collapsedOffset,
        collapsedEnd: collapsedOffset + length,
        expandedStart: expandedOffset,
        expandedEnd: expandedOffset + length,
        text: segment.text,
      });
      collapsedOffset += length;
      expandedOffset += length;
      continue;
    }

    const expandedText = segment.type === "mention" ? `@${segment.path}` : ATOMIC_PLACEHOLDER;
    atomicSegments.push({
      collapsedStart: collapsedOffset,
      collapsedEnd: collapsedOffset + 1,
      expandedStart: expandedOffset,
      expandedEnd: expandedOffset + expandedText.length,
      text: ATOMIC_PLACEHOLDER,
    });
    collapsedOffset += 1;
    expandedOffset += expandedText.length;
  }

  return atomicSegments;
}

function collapsedTextForSegments(segments: readonly AtomicSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

function collapsedLength(text: string): number {
  return collapsedTextForSegments(buildAtomicSegments(text)).length;
}

function expandedOffsetForCollapsedOffset(
  segments: readonly AtomicSegment[],
  collapsedOffset: number,
): number {
  if (segments.length === 0) {
    return 0;
  }

  for (const segment of segments) {
    if (collapsedOffset <= segment.collapsedStart) {
      return segment.expandedStart;
    }
    if (collapsedOffset >= segment.collapsedEnd) {
      continue;
    }
    if (segment.text === ATOMIC_PLACEHOLDER) {
      return collapsedOffset <= segment.collapsedStart
        ? segment.expandedStart
        : segment.expandedEnd;
    }
    return segment.expandedStart + (collapsedOffset - segment.collapsedStart);
  }

  return segments[segments.length - 1]?.expandedEnd ?? 0;
}

function normalizeCount(buffer: string, fallback = 1): number {
  if (!buffer) return fallback;
  const parsed = Number.parseInt(buffer, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 999);
}

function resetTransientState(state: ComposerVimState): ComposerVimState {
  return {
    ...state,
    countBuffer: "",
    pendingOperator: null,
    pendingGCount: null,
    awaitingReplace: null,
  };
}

function result(
  state: ComposerVimState,
  text: string,
  cursor: number,
  selection: ComposerVimCommandResult["selection"] = null,
): ComposerVimCommandResult {
  return {
    handled: true,
    state,
    text,
    cursor: clampCollapsedComposerCursor(text, cursor),
    selection,
  };
}

function unhandled(
  state: ComposerVimState,
  text: string,
  cursor: number,
): ComposerVimCommandResult {
  return {
    handled: false,
    state,
    text,
    cursor,
    selection: null,
  };
}

function isDigitKey(key: string): boolean {
  return /^[0-9]$/.test(key);
}

function isModifierKey(key: string): boolean {
  return key === "Alt" || key === "Control" || key === "Meta" || key === "Shift";
}

function isWhitespace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && !/\s/.test(char);
}

function lineStartAt(text: string, cursor: number): number {
  return text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
}

function lineEndAt(text: string, cursor: number): number {
  const nextNewline = text.indexOf("\n", cursor);
  return nextNewline === -1 ? text.length : nextNewline;
}

function lineLastCharAt(text: string, cursor: number): number {
  const start = lineStartAt(text, cursor);
  const end = lineEndAt(text, cursor);
  return Math.max(start, end - 1);
}

function lineEndWithBreakAt(text: string, cursor: number): number {
  const end = lineEndAt(text, cursor);
  return end < text.length ? end + 1 : end;
}

function firstNonBlankAt(text: string, cursor: number): number {
  const start = lineStartAt(text, cursor);
  const end = lineEndAt(text, cursor);
  let index = start;
  while (index < end && (text[index] === " " || text[index] === "\t")) {
    index += 1;
  }
  return index;
}

function moveVertical(text: string, cursor: number, delta: number): number {
  const currentStart = lineStartAt(text, cursor);
  const currentColumn = Math.max(0, cursor - currentStart);
  let targetStart = currentStart;

  if (delta > 0) {
    for (let step = 0; step < delta; step += 1) {
      const next = lineEndWithBreakAt(text, targetStart);
      if (next >= text.length) break;
      targetStart = next;
    }
  } else {
    for (let step = 0; step < Math.abs(delta); step += 1) {
      if (targetStart <= 0) break;
      targetStart = lineStartAt(text, targetStart - 1);
    }
  }

  const targetEnd = lineEndAt(text, targetStart);
  return Math.min(targetStart + currentColumn, Math.max(targetStart, targetEnd - 1));
}

function moveWordForward(text: string, cursor: number): number {
  let index = Math.min(cursor, text.length);
  if (index < text.length && isWordChar(text[index])) {
    while (index < text.length && isWordChar(text[index])) index += 1;
  }
  while (index < text.length && isWhitespace(text[index])) index += 1;
  return index;
}

function moveWordBackward(text: string, cursor: number): number {
  let index = Math.max(0, cursor - 1);
  while (index > 0 && isWhitespace(text[index])) index -= 1;
  while (index > 0 && isWordChar(text[index - 1])) index -= 1;
  return index;
}

function moveWordEnd(text: string, cursor: number): number {
  let index = Math.min(cursor, Math.max(0, text.length - 1));
  if (isWhitespace(text[index])) {
    while (index < text.length && isWhitespace(text[index])) index += 1;
  } else if (index + 1 < text.length && isWordChar(text[index + 1])) {
    index += 1;
  }
  while (index + 1 < text.length && isWordChar(text[index + 1])) index += 1;
  return Math.min(Math.max(0, text.length - 1), index);
}

function moveByMotion(text: string, cursor: number, key: MotionKey, count: number): number {
  let nextCursor = cursor;
  const boundedCount = Math.max(1, count);

  for (let index = 0; index < boundedCount; index += 1) {
    if (key === "h" || key === "ArrowLeft") nextCursor = Math.max(0, nextCursor - 1);
    else if (key === "l" || key === "ArrowRight")
      nextCursor = Math.min(Math.max(0, text.length - 1), nextCursor + 1);
    else if (key === "j" || key === "ArrowDown") nextCursor = moveVertical(text, nextCursor, 1);
    else if (key === "k" || key === "ArrowUp") nextCursor = moveVertical(text, nextCursor, -1);
    else if (key === "0") nextCursor = lineStartAt(text, nextCursor);
    else if (key === "^") nextCursor = firstNonBlankAt(text, nextCursor);
    else if (key === "$") nextCursor = lineLastCharAt(text, nextCursor);
    else if (key === "w" || key === "W") nextCursor = moveWordForward(text, nextCursor);
    else if (key === "b" || key === "B") nextCursor = moveWordBackward(text, nextCursor);
    else if (key === "e" || key === "E") nextCursor = moveWordEnd(text, nextCursor);
    else if (key === "G") nextCursor = lineStartAt(text, text.length);
    else if (key === "g") nextCursor = 0;
  }

  return nextCursor;
}

function lineRange(text: string, cursor: number, count: number): { start: number; end: number } {
  const start = lineStartAt(text, cursor);
  let end = start;
  for (let index = 0; index < Math.max(1, count); index += 1) {
    end = lineEndWithBreakAt(text, end);
    if (end >= text.length) break;
  }
  return { start, end };
}

function visualRange(
  text: string,
  anchor: number,
  cursor: number,
  linewise: boolean,
): { start: number; end: number } {
  if (linewise) {
    const start = lineStartAt(text, Math.min(anchor, cursor));
    const end = lineEndWithBreakAt(text, Math.max(anchor, cursor));
    return { start, end };
  }
  return {
    start: Math.min(anchor, cursor),
    end: Math.min(text.length, Math.max(anchor, cursor) + 1),
  };
}

function replaceCollapsedRange(options: {
  text: string;
  start: number;
  end: number;
  replacement: string;
}): { text: string; cursor: number; removed: string } {
  const segments = buildAtomicSegments(options.text);
  const start = Math.max(0, Math.min(options.start, options.end));
  const end = Math.max(start, options.end);
  const expandedStart = expandedOffsetForCollapsedOffset(segments, start);
  const expandedEnd = expandedOffsetForCollapsedOffset(segments, end);
  return {
    text: `${options.text.slice(0, expandedStart)}${options.replacement}${options.text.slice(
      expandedEnd,
    )}`,
    cursor: start + collapsedLength(options.replacement),
    removed: options.text.slice(expandedStart, expandedEnd),
  };
}

function selectionForMode(
  mode: ComposerVimMode,
  text: string,
  anchor: number | null,
  cursor: number,
): ComposerVimCommandResult["selection"] {
  if (mode !== "visual" && mode !== "visual-line") return null;
  const selectionAnchor = anchor ?? cursor;
  const range = visualRange(text, selectionAnchor, cursor, mode === "visual-line");
  return { anchor: range.start, focus: range.end };
}

function enterMode(
  state: ComposerVimState,
  mode: ComposerVimMode,
  cursor: number,
): { state: ComposerVimState; cursor: number } {
  return {
    state: {
      ...resetTransientState(state),
      mode,
      visualAnchor: mode === "visual" || mode === "visual-line" ? cursor : null,
    },
    cursor,
  };
}

function applyLinewisePaste(options: {
  text: string;
  cursor: number;
  register: ComposerVimRegister;
  count: number;
  before: boolean;
}): { text: string; cursor: number } {
  const insertAt = options.before
    ? lineStartAt(options.text, options.cursor)
    : lineEndWithBreakAt(options.text, options.cursor);
  const insertion = options.register.text.endsWith("\n")
    ? options.register.text
    : `${options.register.text}\n`;
  const repeatedInsertion = insertion.repeat(Math.max(1, options.count));
  const replaced = replaceCollapsedRange({
    text: options.text,
    start: insertAt,
    end: insertAt,
    replacement: repeatedInsertion,
  });
  return {
    text: replaced.text,
    cursor: insertAt,
  };
}

function applyCharwisePaste(options: {
  text: string;
  cursor: number;
  register: ComposerVimRegister;
  count: number;
  before: boolean;
}): { text: string; cursor: number } {
  const insertAt = options.before
    ? options.cursor
    : Math.min(collapsedLength(options.text), options.cursor + 1);
  const insertion = options.register.text.repeat(Math.max(1, options.count));
  const replaced = replaceCollapsedRange({
    text: options.text,
    start: insertAt,
    end: insertAt,
    replacement: insertion,
  });
  return {
    text: replaced.text,
    cursor: Math.max(insertAt, replaced.cursor - 1),
  };
}

function applyOperator(options: {
  state: ComposerVimState;
  text: string;
  range: { start: number; end: number };
  operator: ComposerVimOperator;
  linewise: boolean;
}): ComposerVimCommandResult {
  const { state, text, range, operator, linewise } = options;
  const start = Math.max(0, Math.min(range.start, range.end));
  const end = Math.max(start, range.end);
  const removed = replaceCollapsedRange({ text, start, end, replacement: "" });

  if (operator === "yank") {
    const segments = buildAtomicSegments(text);
    const expandedStart = expandedOffsetForCollapsedOffset(segments, start);
    const expandedEnd = expandedOffsetForCollapsedOffset(segments, end);
    const nextState = resetTransientState({
      ...state,
      mode: "normal",
      visualAnchor: null,
      register: {
        text: text.slice(expandedStart, expandedEnd),
        linewise,
      },
    });
    return result(nextState, text, start);
  }

  const nextMode: ComposerVimMode = operator === "change" ? "insert" : "normal";
  const nextCursor = Math.max(0, Math.min(start, collapsedLength(removed.text) - 1));
  const nextState = resetTransientState({
    ...state,
    mode: nextMode,
    visualAnchor: null,
    register: {
      text: removed.removed,
      linewise,
    },
  });
  return result(nextState, removed.text, nextCursor);
}

function motionRange(text: string, cursor: number, key: MotionKey, count: number) {
  const destination = moveByMotion(text, cursor, key, count);
  if (key === "$" || key === "e" || key === "E") {
    return {
      start: Math.min(cursor, destination),
      end: Math.min(text.length, Math.max(cursor, destination) + 1),
      destination,
    };
  }
  return {
    start: Math.min(cursor, destination),
    end: Math.max(cursor, destination),
    destination,
  };
}

function isMotionKey(key: string): key is MotionKey {
  return (
    key === "h" ||
    key === "j" ||
    key === "k" ||
    key === "l" ||
    key === "ArrowLeft" ||
    key === "ArrowDown" ||
    key === "ArrowUp" ||
    key === "ArrowRight" ||
    key === "0" ||
    key === "^" ||
    key === "$" ||
    key === "w" ||
    key === "W" ||
    key === "b" ||
    key === "B" ||
    key === "e" ||
    key === "E" ||
    key === "g" ||
    key === "G"
  );
}

function handleInsertMode(input: ComposerVimInput, state: ComposerVimState) {
  if (input.key === "Escape" || (input.ctrlKey && input.key === "[")) {
    const cursor = Math.max(0, clampCollapsedComposerCursor(input.text, input.cursor) - 1);
    const entered = enterMode(state, "normal", cursor);
    return result(entered.state, input.text, entered.cursor);
  }
  return unhandled(state, input.text, input.cursor);
}

function handleVisualMode(input: ComposerVimInput, state: ComposerVimState) {
  const text = collapsedTextForSegments(buildAtomicSegments(input.text));
  const cursor = clampCollapsedComposerCursor(input.text, input.cursor);

  if (input.key === "Escape" || (input.ctrlKey && input.key === "[")) {
    const entered = enterMode(state, "normal", cursor);
    return result(entered.state, input.text, cursor);
  }

  if (input.key === "y" || input.key === "d" || input.key === "c") {
    const operator = input.key === "y" ? "yank" : input.key === "d" ? "delete" : "change";
    const range = visualRange(
      text,
      state.visualAnchor ?? cursor,
      cursor,
      state.mode === "visual-line",
    );
    return applyOperator({
      state,
      text: input.text,
      range,
      operator,
      linewise: state.mode === "visual-line",
    });
  }

  if (isMotionKey(input.key)) {
    const nextCursor = moveByMotion(text, cursor, input.key, normalizeCount(state.countBuffer));
    const nextState = {
      ...state,
      countBuffer: "",
    };
    return result(
      nextState,
      input.text,
      nextCursor,
      selectionForMode(nextState.mode, text, nextState.visualAnchor, nextCursor),
    );
  }

  if (isDigitKey(input.key) && (input.key !== "0" || state.countBuffer.length > 0)) {
    return result(
      { ...state, countBuffer: `${state.countBuffer}${input.key}`, pendingGCount: null },
      input.text,
      cursor,
    );
  }

  return result(
    { ...state, countBuffer: "" },
    input.text,
    cursor,
    selectionForMode(state.mode, text, state.visualAnchor, cursor),
  );
}

export function applyComposerVimKey(
  input: ComposerVimInput,
  previousState: ComposerVimState,
): ComposerVimCommandResult {
  const state = cloneState(previousState);
  const collapsedText = collapsedTextForSegments(buildAtomicSegments(input.text));
  const cursor = clampCollapsedComposerCursor(input.text, input.cursor);

  if (isModifierKey(input.key)) {
    return unhandled(state, input.text, cursor);
  }

  if (state.mode === "insert") {
    return handleInsertMode(input, state);
  }

  if (state.mode === "visual" || state.mode === "visual-line") {
    return handleVisualMode(input, state);
  }

  if (state.awaitingReplace) {
    if (input.key.length !== 1 || input.ctrlKey) {
      return result({ ...state, awaitingReplace: null }, input.text, cursor);
    }
    const replaced = replaceCollapsedRange({
      text: input.text,
      start: cursor,
      end: Math.min(collapsedText.length, cursor + state.awaitingReplace.count),
      replacement: input.key.repeat(state.awaitingReplace.count),
    });
    return result(resetTransientState(state), replaced.text, cursor);
  }

  if (input.key === "Escape" || (input.ctrlKey && input.key === "[")) {
    return result(
      resetTransientState({ ...state, mode: "normal", visualAnchor: null }),
      input.text,
      cursor,
    );
  }

  if (input.key === "u" && !input.ctrlKey) {
    return {
      ...result(resetTransientState(state), input.text, cursor),
      undo: true,
    };
  }

  if (input.ctrlKey && input.key.toLowerCase() === "r") {
    return {
      ...result(resetTransientState(state), input.text, cursor),
      redo: true,
    };
  }

  if (isDigitKey(input.key) && (input.key !== "0" || state.countBuffer.length > 0)) {
    return result(
      { ...state, countBuffer: `${state.countBuffer}${input.key}`, pendingGCount: null },
      input.text,
      cursor,
    );
  }

  const count = normalizeCount(state.countBuffer);

  if (state.pendingGCount !== null) {
    if (input.key === "g") {
      return result(resetTransientState(state), input.text, 0);
    }
    return result(resetTransientState(state), input.text, cursor);
  }

  if (state.pendingOperator) {
    const operatorCount = state.pendingOperator.count * count;
    const nextState = { ...state, countBuffer: "" };
    if (
      (state.pendingOperator.operator === "delete" && input.key === "d") ||
      (state.pendingOperator.operator === "change" && input.key === "c") ||
      (state.pendingOperator.operator === "yank" && input.key === "y")
    ) {
      return applyOperator({
        state: nextState,
        text: input.text,
        range: lineRange(collapsedText, cursor, operatorCount),
        operator: state.pendingOperator.operator,
        linewise: true,
      });
    }
    if (isMotionKey(input.key)) {
      const range = motionRange(collapsedText, cursor, input.key, operatorCount);
      if (state.pendingOperator.operator === "yank" && (input.key === "w" || input.key === "W")) {
        while (range.end > range.start && /\s/.test(collapsedText[range.end - 1] ?? "")) {
          range.end -= 1;
        }
      }
      return applyOperator({
        state: nextState,
        text: input.text,
        range,
        operator: state.pendingOperator.operator,
        linewise: false,
      });
    }
    return result(resetTransientState(state), input.text, cursor);
  }

  if (isMotionKey(input.key)) {
    if (input.key === "g") {
      return result(
        {
          ...state,
          countBuffer: "",
          pendingOperator: null,
          pendingGCount: count,
        },
        input.text,
        cursor,
      );
    }
    const nextCursor = moveByMotion(collapsedText, cursor, input.key, count);
    return result({ ...state, countBuffer: "" }, input.text, nextCursor);
  }

  if (input.key === "i") {
    const entered = enterMode(state, "insert", cursor);
    return result(entered.state, input.text, entered.cursor);
  }
  if (input.key === "a") {
    const entered = enterMode(state, "insert", Math.min(collapsedText.length, cursor + 1));
    return result(entered.state, input.text, entered.cursor);
  }
  if (input.key === "I") {
    const entered = enterMode(state, "insert", firstNonBlankAt(collapsedText, cursor));
    return result(entered.state, input.text, entered.cursor);
  }
  if (input.key === "A") {
    const entered = enterMode(state, "insert", lineEndAt(collapsedText, cursor));
    return result(entered.state, input.text, entered.cursor);
  }
  if (input.key === "o" || input.key === "O") {
    const currentLineEnd = lineEndAt(collapsedText, cursor);
    const insertAt =
      input.key === "o"
        ? lineEndWithBreakAt(collapsedText, cursor)
        : lineStartAt(collapsedText, cursor);
    const replacement = input.key === "o" ? "\n" : "\n";
    const replaced = replaceCollapsedRange({
      text: input.text,
      start: insertAt,
      end: insertAt,
      replacement,
    });
    const nextCursor =
      input.key === "o" && currentLineEnd === collapsedText.length ? insertAt + 1 : insertAt;
    const entered = enterMode(state, "insert", nextCursor);
    return result(entered.state, replaced.text, nextCursor);
  }
  if (input.key === "v" || input.key === "V") {
    const entered = enterMode(state, input.key === "v" ? "visual" : "visual-line", cursor);
    return result(
      entered.state,
      input.text,
      cursor,
      selectionForMode(entered.state.mode, collapsedText, entered.state.visualAnchor, cursor),
    );
  }

  if (input.key === "x") {
    return applyOperator({
      state,
      text: input.text,
      range: { start: cursor, end: Math.min(collapsedText.length, cursor + count) },
      operator: "delete",
      linewise: false,
    });
  }
  if (input.key === "X") {
    return applyOperator({
      state,
      text: input.text,
      range: { start: Math.max(0, cursor - count), end: cursor },
      operator: "delete",
      linewise: false,
    });
  }
  if (input.key === "D" || input.key === "C") {
    return applyOperator({
      state,
      text: input.text,
      range: { start: cursor, end: lineEndAt(collapsedText, cursor) },
      operator: input.key === "D" ? "delete" : "change",
      linewise: false,
    });
  }
  if (input.key === "Y") {
    return applyOperator({
      state,
      text: input.text,
      range: lineRange(collapsedText, cursor, count),
      operator: "yank",
      linewise: true,
    });
  }
  if (input.key === "d" || input.key === "c" || input.key === "y") {
    const operator = input.key === "d" ? "delete" : input.key === "c" ? "change" : "yank";
    return result(
      {
        ...state,
        countBuffer: "",
        pendingOperator: { operator, count },
      },
      input.text,
      cursor,
    );
  }
  if (input.key === "r") {
    return result(
      {
        ...state,
        countBuffer: "",
        awaitingReplace: { count },
      },
      input.text,
      cursor,
    );
  }
  if (input.key === "p" || input.key === "P") {
    if (!state.register.text) {
      return result({ ...state, countBuffer: "" }, input.text, cursor);
    }
    const pasted = state.register.linewise
      ? applyLinewisePaste({
          text: input.text,
          cursor,
          register: state.register,
          count,
          before: input.key === "P",
        })
      : applyCharwisePaste({
          text: input.text,
          cursor,
          register: state.register,
          count,
          before: input.key === "P",
        });
    return result({ ...state, countBuffer: "" }, pasted.text, pasted.cursor);
  }

  return result({ ...state, countBuffer: "" }, input.text, cursor);
}
