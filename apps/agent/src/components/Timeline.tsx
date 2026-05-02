import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import type { deriveTimelineEntries } from "shared/orchestrationSession";

import { palette } from "../theme";

export type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];

function indent(text: string, spaces = 2): string {
  const pad = " ".repeat(spaces);
  return text
    .split(/\r?\n/)
    .map((line) => `${pad}${line}`)
    .join("\n");
}

function clampLines(text: string, max: number): string {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length <= max) {
    return lines.join("\n");
  }
  return `${lines.slice(0, max).join("\n")}\n…`;
}

function firstLine(text: string, maxChars: number): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  if (line.length <= maxChars) {
    return line;
  }
  return `${line.slice(0, maxChars - 1)}…`;
}

function countLines(text: string): number {
  return text.split(/\r?\n/).length;
}

export function isExpandableEntry(entry: TimelineEntry): boolean {
  return entry.kind !== "message";
}

function formatRelativeTime(fromIso: string, now: number): string {
  const then = new Date(fromIso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Math.max(0, now - then);
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function useNowTicker(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Predicts how many rows an entry will render into. Must match the JSX below. */
export function estimateEntryRows(
  entry: TimelineEntry,
  expanded: boolean,
  columns: number,
  transcriptMode = false,
): number {
  const contentWidth = Math.max(20, columns - 4);
  const MARGIN = 1; // marginBottom={1} on every block
  if (entry.kind === "message") {
    const text = getMessageText(entry, transcriptMode);
    // Message renders as: header row + indented body rows.
    const headerRow = 1;
    const wrapped = estimateWrappedRows(text, contentWidth - 2);
    return headerRow + wrapped + MARGIN;
  }
  if (entry.kind === "reasoning") {
    const showBody = transcriptMode || expanded;
    if (!showBody) return 1 + MARGIN;
    return (
      1 +
      estimateWrappedRows(getReasoningBody(entry.reasoning.text, transcriptMode), contentWidth) +
      MARGIN
    );
  }
  if (entry.kind === "proposed-plan") {
    const showBody = transcriptMode || expanded;
    if (!showBody) return 1 + MARGIN;
    const body = getPlanBody(entry.proposedPlan.planMarkdown, transcriptMode);
    return 1 + estimateWrappedRows(indent(body), contentWidth) + MARGIN;
  }
  // tool
  const showBody = transcriptMode || expanded;
  if (!showBody) return 1 + MARGIN;
  let rows = 1; // header line
  if (entry.entry.command) {
    rows += estimateWrappedRows(
      indent(getToolBody(entry.entry.command, transcriptMode, 3)),
      contentWidth,
    );
  }
  if (entry.entry.detail) {
    rows += estimateWrappedRows(
      indent(getToolBody(entry.entry.detail, transcriptMode, 4)),
      contentWidth,
    );
  }
  return rows + MARGIN;
}

function estimateWrappedRows(text: string, width: number): number {
  if (width <= 0) return countLines(text);
  const lines = text.split(/\r?\n/);
  let total = 0;
  for (const line of lines) {
    total += Math.max(1, Math.ceil((line.length || 1) / width));
  }
  return total;
}

function MessageHeader({
  label,
  color,
  createdAt,
  now,
}: {
  readonly label: string;
  readonly color: string;
  readonly createdAt: string;
  readonly now: number;
}) {
  const relative = formatRelativeTime(createdAt, now);
  return (
    <Box>
      <Text color={color} bold>
        {label}
      </Text>
      {relative ? <Text dimColor>{"  " + relative}</Text> : null}
    </Box>
  );
}

function UserMessage({
  text,
  createdAt,
  now,
}: {
  readonly text: string;
  readonly createdAt: string;
  readonly now: number;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <MessageHeader label="you" color={palette.neutralBright} createdAt={createdAt} now={now} />
      <Box>
        <Text color={palette.neutralBright} dimColor>
          {"  "}
        </Text>
        <Text>{text || "(empty)"}</Text>
      </Box>
    </Box>
  );
}

function AssistantMessage({
  text,
  streaming,
  createdAt,
  now,
}: {
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly now: number;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={streaming ? palette.accentBright : palette.accent} bold>
          ● shiori
        </Text>
        <Text dimColor>{"  " + formatRelativeTime(createdAt, now)}</Text>
        {streaming ? <Text color={palette.accentBright}> · streaming</Text> : null}
      </Box>
      <Box>
        <Text color={palette.accent} dimColor>
          {"  "}
        </Text>
        <Text>{text || (streaming ? "…" : "(empty)")}</Text>
      </Box>
    </Box>
  );
}

function getReasoningBody(text: string, transcriptMode: boolean): string {
  return transcriptMode ? text : clampLines(text, 6);
}

function getPlanBody(markdown: string, transcriptMode: boolean): string {
  return transcriptMode ? markdown : clampLines(markdown, 10);
}

function getToolBody(text: string, transcriptMode: boolean, maxLines: number): string {
  return transcriptMode ? text : clampLines(text, maxLines);
}

function getMessageText(
  entry: Extract<TimelineEntry, { kind: "message" }>,
  transcriptMode: boolean,
): string {
  const fallback =
    entry.message.text ||
    (entry.message.role === "assistant" && entry.message.streaming ? "…" : "(empty)");
  if (transcriptMode) {
    return fallback;
  }

  switch (entry.message.role) {
    case "user":
      return clampLines(fallback, 12);
    case "assistant":
      return clampLines(fallback, 40);
    default:
      return clampLines(fallback, 8);
  }
}

function ReasoningBlock({
  text,
  expanded,
  focused,
  columns,
  transcriptMode,
}: {
  readonly text: string;
  readonly expanded: boolean;
  readonly focused: boolean;
  readonly columns: number;
  readonly transcriptMode: boolean;
}) {
  const showBody = transcriptMode || expanded;
  const chevron = expanded ? "▾" : "▸";
  const summary = firstLine(text, Math.max(10, columns - 10));
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={focused ? "yellowBright" : "yellow"} bold={focused}>
          {transcriptMode ? "◇ thinking" : `${chevron} ◇ thinking`}
        </Text>
        {!showBody ? <Text dimColor> · {summary}</Text> : null}
      </Box>
      {showBody ? (
        <Text dimColor italic>
          {indent(getReasoningBody(text, transcriptMode))}
        </Text>
      ) : null}
    </Box>
  );
}

function ProposedPlanBlock({
  markdown,
  expanded,
  focused,
  transcriptMode,
}: {
  readonly markdown: string;
  readonly expanded: boolean;
  readonly focused: boolean;
  readonly transcriptMode: boolean;
}) {
  const chevron = expanded ? "▾" : "▸";
  const showBody = transcriptMode || expanded;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={focused ? palette.accentBright : palette.accent} bold={focused}>
        {transcriptMode ? "◆ proposed plan" : `${chevron} ◆ proposed plan`}
      </Text>
      {showBody ? <Text>{indent(getPlanBody(markdown, transcriptMode))}</Text> : null}
    </Box>
  );
}

function toneColor(tone: "thinking" | "tool" | "info" | "error"): string {
  switch (tone) {
    case "error":
      return palette.danger;
    case "tool":
      return palette.accent;
    case "thinking":
      return palette.warning;
    case "info":
    default:
      return palette.neutral;
  }
}

type ToolVerb = "read" | "write" | "edit" | "run" | "search" | "fetch" | "patch" | "other";

function detectToolVerb(label: string): ToolVerb {
  const normalized = label.trim().toLowerCase();
  if (/^(read|view|cat|open)\b/.test(normalized)) return "read";
  if (/^(write|create|touch)\b/.test(normalized)) return "write";
  if (/^(edit|update|modify|replace)\b/.test(normalized)) return "edit";
  if (/^(run|exec|shell|bash|sh|command|call)\b/.test(normalized)) return "run";
  if (/^(search|grep|find|list|ls|glob)\b/.test(normalized)) return "search";
  if (/^(fetch|http|get|post|curl|download)\b/.test(normalized)) return "fetch";
  if (/^(patch|apply)\b/.test(normalized)) return "patch";
  return "other";
}

function verbIcon(verb: ToolVerb): string {
  switch (verb) {
    case "read":
      return "▤";
    case "write":
      return "✎";
    case "edit":
      return "✎";
    case "run":
      return "❯";
    case "search":
      return "⌕";
    case "fetch":
      return "↓";
    case "patch":
      return "⇄";
    case "other":
    default:
      return "•";
  }
}

function ToolCallEntry({
  label,
  detail,
  command,
  tone,
  running,
  expanded,
  focused,
  columns,
  transcriptMode,
}: {
  readonly label: string;
  readonly detail?: string;
  readonly command?: string;
  readonly tone: "thinking" | "tool" | "info" | "error";
  readonly running?: boolean;
  readonly expanded: boolean;
  readonly focused: boolean;
  readonly columns: number;
  readonly transcriptMode: boolean;
}) {
  const showBody = transcriptMode || expanded;
  const color = toneColor(tone);
  const verb = detectToolVerb(label);
  const statusIcon = running ? "◐" : tone === "error" ? "✗" : verbIcon(verb);
  const chevron = expanded ? "▾" : "▸";
  const summary = command ?? detail ?? "";
  const previewWidth = Math.max(10, columns - label.length - 10);
  const preview = summary ? firstLine(summary, previewWidth) : "";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={focused ? palette.accentBright : color} bold={focused}>
          {transcriptMode ? `${statusIcon} ${label}` : `${chevron} ${statusIcon} ${label}`}
        </Text>
        {!showBody && preview ? <Text dimColor> · {preview}</Text> : null}
      </Box>
      {showBody && command ? (
        <Text dimColor>{indent(getToolBody(command, transcriptMode, 3))}</Text>
      ) : null}
      {showBody && detail ? (
        <Text dimColor>{indent(getToolBody(detail, transcriptMode, 4))}</Text>
      ) : null}
    </Box>
  );
}

export function TimelineEntryView({
  entry,
  expanded,
  focused,
  columns,
  transcriptMode,
  now,
}: {
  readonly entry: TimelineEntry;
  readonly expanded: boolean;
  readonly focused: boolean;
  readonly columns: number;
  readonly transcriptMode: boolean;
  readonly now: number;
}) {
  if (entry.kind === "message") {
    const text = getMessageText(entry, transcriptMode);
    if (entry.message.role === "user") {
      return <UserMessage text={text} createdAt={entry.createdAt} now={now} />;
    }
    if (entry.message.role === "assistant") {
      return (
        <AssistantMessage
          text={text}
          streaming={entry.message.streaming}
          createdAt={entry.createdAt}
          now={now}
        />
      );
    }
    return (
      <Box marginBottom={1}>
        <Text color={palette.warning}>system </Text>
        <Text>{text}</Text>
      </Box>
    );
  }

  if (entry.kind === "reasoning") {
    return (
      <ReasoningBlock
        text={entry.reasoning.text}
        expanded={expanded}
        focused={focused}
        columns={columns}
        transcriptMode={transcriptMode}
      />
    );
  }

  if (entry.kind === "proposed-plan") {
    return (
      <ProposedPlanBlock
        markdown={entry.proposedPlan.planMarkdown}
        expanded={expanded}
        focused={focused}
        transcriptMode={transcriptMode}
      />
    );
  }

  return (
    <ToolCallEntry
      label={entry.entry.toolTitle ?? entry.entry.label}
      tone={entry.entry.tone}
      expanded={expanded}
      focused={focused}
      columns={columns}
      transcriptMode={transcriptMode}
      {...(entry.entry.detail ? { detail: entry.entry.detail } : {})}
      {...(entry.entry.command ? { command: entry.entry.command } : {})}
      {...(entry.entry.running ? { running: entry.entry.running } : {})}
    />
  );
}

export function Timeline({
  entries,
  height,
  columns,
  expandedIds,
  focusedId,
  placeholder,
  transcriptMode = false,
}: {
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly height: number;
  readonly columns: number;
  readonly expandedIds: ReadonlySet<string>;
  readonly focusedId: string | null;
  readonly placeholder?: string;
  readonly transcriptMode?: boolean;
}) {
  const now = useNowTicker();
  if (entries.length === 0) {
    return (
      <Box flexDirection="column" height={height} paddingX={1}>
        <Text dimColor>{placeholder ?? "Send a message to start."}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {entries.map((entry) => (
        <TimelineEntryView
          key={entry.id}
          entry={entry}
          expanded={transcriptMode || expandedIds.has(entry.id)}
          focused={focusedId === entry.id}
          columns={columns}
          transcriptMode={transcriptMode}
          now={now}
        />
      ))}
    </Box>
  );
}
