import { describe, expect, it } from "vitest";

import { MessageId } from "contracts";

import {
  buildWorkGroupSummary,
  deriveMessagesTimelineRows,
  formatWorkEntry,
  getDisplayedWorkEntries,
} from "./MessagesTimeline.logic";
import type { TimelineEntry } from "../../session-logic";

describe("deriveMessagesTimelineRows", () => {
  it("groups contiguous exploratory reads and search commands into a single work row", () => {
    const timelineEntries: TimelineEntry[] = [
      {
        id: "work-read-package",
        kind: "work",
        createdAt: "2026-02-23T00:00:01.000Z",
        entry: {
          id: "work-read-package",
          createdAt: "2026-02-23T00:00:01.000Z",
          label: "Read package.json",
          tone: "tool",
          itemType: "command_execution",
          toolTitle: "Read file",
          detail: "package.json",
        },
      },
      {
        id: "work-read-src",
        kind: "work",
        createdAt: "2026-02-23T00:00:02.000Z",
        entry: {
          id: "work-read-src",
          createdAt: "2026-02-23T00:00:02.000Z",
          label: "Read src",
          tone: "tool",
          itemType: "command_execution",
          toolTitle: "List directory",
          detail: "src",
        },
      },
      {
        id: "work-find",
        kind: "work",
        createdAt: "2026-02-23T00:00:03.000Z",
        entry: {
          id: "work-find",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Run find",
          tone: "tool",
          itemType: "command_execution",
          command: 'find . -name "*.md"',
          detail: 'find . -name "*.md"',
        },
      },
      {
        id: "work-read-entrypoints",
        kind: "work",
        createdAt: "2026-02-23T00:00:04.000Z",
        entry: {
          id: "work-read-entrypoints",
          createdAt: "2026-02-23T00:00:04.000Z",
          label: "Read ENTRYPOINTS.md",
          tone: "tool",
          itemType: "command_execution",
          toolTitle: "Read file",
          detail: "ENTRYPOINTS.md",
        },
      },
    ];

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
    });

    const workRows = rows.filter((row) => row.kind === "work");
    expect(workRows).toHaveLength(1);
    expect(workRows[0]?.groupedEntries.map((entry) => entry.id)).toEqual([
      "work-read-package",
      "work-read-src",
      "work-find",
      "work-read-entrypoints",
    ]);
  });

  it("dedupes repeated file reads when summarizing exploration work groups", () => {
    const entries = [
      {
        id: "read-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        label: "Read package.json",
        tone: "tool" as const,
        itemType: "command_execution" as const,
        toolTitle: "Read file",
        detail: "package.json",
      },
      {
        id: "search-1",
        createdAt: "2026-02-23T00:00:02.000Z",
        label: "rg completed",
        tone: "tool" as const,
        itemType: "command_execution" as const,
        command: 'rg -n "thread.session-set|thread" ProjectionPipeline.test.ts',
        detail: 'rg -n "thread.session-set|thread" ProjectionPipeline.test.ts',
      },
      {
        id: "read-2",
        createdAt: "2026-02-23T00:00:03.000Z",
        label: "Read package.json",
        tone: "tool" as const,
        itemType: "command_execution" as const,
        toolTitle: "Read file",
        detail: "package.json",
      },
    ];

    expect(getDisplayedWorkEntries(entries).map((entry) => entry.id)).toEqual([
      "search-1",
      "read-2",
    ]);
    expect(buildWorkGroupSummary(entries, false)).toBe("Explored 1 file, 1 search");
  });

  it("classifies Claude-style generic tool calls by toolName metadata", () => {
    const claudeSearchEntry = {
      id: "claude-search",
      createdAt: "2026-02-23T00:00:01.000Z",
      label: "Tool call",
      tone: "tool" as const,
      itemType: "dynamic_tool_call" as const,
      detail: 'Grep: {"pattern":"foo","path":"src"}',
      output: {
        toolName: "Grep",
        input: {
          pattern: "foo",
          path: "src",
        },
      },
    };

    expect(formatWorkEntry(claudeSearchEntry)).toMatchObject({
      kind: "search",
      action: "Searched for",
      detail: "foo in src",
      monospace: false,
    });
    expect(buildWorkGroupSummary([claudeSearchEntry], false)).toBe("Explored 1 search");
  });

  it("classifies generic provider tool calls from serialized detail prefixes", () => {
    const codexReadEntry = {
      id: "codex-read",
      createdAt: "2026-02-23T00:00:01.000Z",
      label: "Tool call",
      tone: "tool" as const,
      itemType: "dynamic_tool_call" as const,
      detail: 'Read: {"file_path":"src/index.ts"}',
    };

    expect(formatWorkEntry(codexReadEntry)).toMatchObject({
      kind: "read",
      action: "Read",
      detail: "src/index.ts",
      monospace: true,
    });
    expect(buildWorkGroupSummary([codexReadEntry], false)).toBe("Explored 1 file");
  });

  it("groups similar running work entries in real time", () => {
    const timelineEntries: TimelineEntry[] = [
      {
        id: "work-read-1",
        kind: "work",
        createdAt: "2026-02-23T00:00:01.000Z",
        entry: {
          id: "work-read-1",
          createdAt: "2026-02-23T00:00:01.000Z",
          label: "Read file started",
          tone: "tool",
          itemType: "dynamic_tool_call",
          requestKind: "file-read",
          running: true,
          detail: "README.md",
        },
      },
      {
        id: "work-read-2",
        kind: "work",
        createdAt: "2026-02-23T00:00:02.000Z",
        entry: {
          id: "work-read-2",
          createdAt: "2026-02-23T00:00:02.000Z",
          label: "List directory",
          tone: "tool",
          itemType: "dynamic_tool_call",
          requestKind: "file-read",
          running: true,
          detail: "src",
        },
      },
      {
        id: "message-1",
        kind: "message",
        createdAt: "2026-02-23T00:00:03.000Z",
        message: {
          id: MessageId.makeUnsafe("assistant-1"),
          role: "assistant",
          text: "Done",
          createdAt: "2026-02-23T00:00:03.000Z",
          streaming: false,
        },
      },
    ];

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
    });

    const workRows = rows.filter((row) => row.kind === "work");
    expect(workRows).toHaveLength(1);
    expect(workRows[0]?.groupedEntries).toHaveLength(2);
    expect(workRows[0]?.groupedEntries.map((entry) => entry.id)).toEqual([
      "work-read-1",
      "work-read-2",
    ]);
  });

  it("keeps dissimilar running work entries separate", () => {
    const timelineEntries: TimelineEntry[] = [
      {
        id: "work-running",
        kind: "work",
        createdAt: "2026-02-23T00:00:01.000Z",
        entry: {
          id: "work-running",
          createdAt: "2026-02-23T00:00:01.000Z",
          label: "Execute command started",
          tone: "tool",
          itemType: "command_execution",
          requestKind: "command",
          running: true,
          detail: "bun run lint",
        },
      },
      {
        id: "work-completed",
        kind: "work",
        createdAt: "2026-02-23T00:00:02.000Z",
        entry: {
          id: "work-completed",
          createdAt: "2026-02-23T00:00:02.000Z",
          label: "Read file",
          tone: "tool",
          itemType: "dynamic_tool_call",
          requestKind: "file-read",
          running: false,
          detail: "README.md",
        },
      },
    ];

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
    });

    const workRows = rows.filter((row) => row.kind === "work");
    expect(workRows).toHaveLength(2);
    expect(workRows[0]?.groupedEntries).toHaveLength(1);
    expect(workRows[0]?.groupedEntries[0]?.id).toBe("work-running");
    expect(workRows[1]?.groupedEntries).toHaveLength(1);
    expect(workRows[1]?.groupedEntries[0]?.id).toBe("work-completed");
  });

  it("marks the trailing work group as sticky in progress while the turn is still active", () => {
    const timelineEntries: TimelineEntry[] = [
      {
        id: "work-read-1",
        kind: "work",
        createdAt: "2026-02-23T00:00:01.000Z",
        entry: {
          id: "work-read-1",
          createdAt: "2026-02-23T00:00:01.000Z",
          label: "Read file",
          tone: "tool",
          itemType: "dynamic_tool_call",
          requestKind: "file-read",
          detail: "README.md",
        },
      },
      {
        id: "work-read-2",
        kind: "work",
        createdAt: "2026-02-23T00:00:02.000Z",
        entry: {
          id: "work-read-2",
          createdAt: "2026-02-23T00:00:02.000Z",
          label: "List directory",
          tone: "tool",
          itemType: "dynamic_tool_call",
          requestKind: "file-read",
          detail: "src",
        },
      },
    ];

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      completionDividerBeforeEntryId: null,
      isWorking: true,
      activeTurnStartedAt: "2026-02-23T00:00:03.000Z",
    });

    const workRows = rows.filter((row) => row.kind === "work");
    expect(workRows).toHaveLength(1);
    expect(workRows[0]?.stickyInProgress).toBe(true);
  });

  it("keeps reasoning entries as dedicated rows", () => {
    const timelineEntries: TimelineEntry[] = [
      {
        id: "reasoning-1",
        kind: "reasoning",
        createdAt: "2026-02-23T00:00:01.000Z",
        reasoning: {
          id: "reasoning-1",
          createdAt: "2026-02-23T00:00:01.000Z",
          text: "Tracing the stream",
          streaming: false,
          turnId: null,
        },
      },
    ];

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
    });

    expect(rows).toEqual([
      {
        kind: "reasoning",
        id: "reasoning-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        reasoning: {
          id: "reasoning-1",
          createdAt: "2026-02-23T00:00:01.000Z",
          text: "Tracing the stream",
          streaming: false,
          turnId: null,
        },
      },
    ]);
  });
});
