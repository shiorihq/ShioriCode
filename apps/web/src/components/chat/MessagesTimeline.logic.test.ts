import { describe, expect, it } from "vitest";

import { MessageId } from "contracts";

import {
  buildWorkGroupSummary,
  deriveMessagesTimelineRows,
  formatWorkEntry,
  getDisplayedWorkEntries,
  isWorkRowInProgress,
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

  it("renders Codex webSearch open_page items with action-specific copy", () => {
    const entry = {
      id: "codex-web-open-page",
      createdAt: "2026-04-11T21:14:01.000Z",
      label: "Web search",
      tone: "tool" as const,
      itemType: "web_search" as const,
      detail: "Web Search: https://developers.openai.com/codex/sdk/",
      output: {
        toolName: "webSearch",
        input: {
          action: {
            type: "open_page",
            value: "https://developers.openai.com/codex/sdk/",
          },
          action_type: "open_page",
          action_value: "https://developers.openai.com/codex/sdk/",
        },
      },
    };

    expect(formatWorkEntry(entry)).toMatchObject({
      kind: "search",
      action: "Opened page",
      detail: "https://developers.openai.com/codex/sdk/",
      monospace: false,
    });
  });

  it("renders fallback web search items with searched-web copy when the adapter only provides a query", () => {
    const entry = {
      id: "shiori-web-search-query",
      createdAt: "2026-04-13T09:40:00.000Z",
      label: "Web search",
      tone: "tool" as const,
      itemType: "web_search" as const,
      detail: "best way to get rid of chicken pox treatment",
      output: {
        toolName: "web_search",
        input: {
          query: "best way to get rid of chicken pox treatment",
        },
      },
    };

    expect(formatWorkEntry(entry)).toMatchObject({
      kind: "search",
      action: "Searched web for",
      detail: "best way to get rid of chicken pox treatment",
      monospace: false,
    });
  });

  it("pluralizes multiple search entries as searches", () => {
    const entries = [
      {
        id: "search-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        label: "rg completed",
        tone: "tool" as const,
        itemType: "command_execution" as const,
        command: "rg AGENTS.md",
        detail: "rg AGENTS.md",
      },
      {
        id: "search-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        label: "rg completed",
        tone: "tool" as const,
        itemType: "command_execution" as const,
        command: "rg workgroup",
        detail: "rg workgroup",
      },
    ];

    expect(buildWorkGroupSummary(entries, false)).toBe("Explored 2 searches");
  });

  it("counts unique edited files in edit work group summaries", () => {
    const entries = [
      {
        id: "edit-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        label: "Edited package.json",
        tone: "tool" as const,
        itemType: "file_change" as const,
        detail: "package.json",
      },
      {
        id: "edit-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        label: "Edited src/index.ts",
        tone: "tool" as const,
        itemType: "file_change" as const,
        detail: "src/index.ts",
      },
      {
        id: "edit-3",
        createdAt: "2026-02-23T00:00:03.000Z",
        label: "Edited package.json again",
        tone: "tool" as const,
        itemType: "file_change" as const,
        detail: "package.json",
      },
    ];

    expect(buildWorkGroupSummary(entries, false)).toBe("Edited 2 files");
    expect(
      buildWorkGroupSummary([...entries, { ...entries[2]!, id: "edit-4", running: true }], false),
    ).toBe("Editing 2 files");
  });

  it("distinguishes created, edited, and deleted files in file-change work group summaries", () => {
    const entries = [
      {
        id: "create-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        label: "Tool call",
        tone: "tool" as const,
        itemType: "dynamic_tool_call" as const,
        detail: 'Create file: {"path":"notes/todo.md"}',
      },
      {
        id: "write-1",
        createdAt: "2026-02-23T00:00:02.000Z",
        label: "Tool call Write",
        tone: "tool" as const,
        itemType: "dynamic_tool_call" as const,
        output: {
          toolName: "write_file",
          input: {
            path: "src/index.ts",
            content: "console.log('hi');",
          },
        },
      },
      {
        id: "delete-1",
        createdAt: "2026-02-23T00:00:03.000Z",
        label: "Tool call",
        tone: "tool" as const,
        itemType: "dynamic_tool_call" as const,
        detail: 'Delete file: {"path":"src/old.ts"}',
      },
    ];

    expect(buildWorkGroupSummary(entries, false)).toBe(
      "Created 1 file, edited 1 file, deleted 1 file",
    );
  });

  it("groups contiguous create, write, and delete tool calls into a single edit work row", () => {
    const timelineEntries: TimelineEntry[] = [
      {
        id: "entry-create-1",
        kind: "work",
        createdAt: "2026-02-23T00:00:01.000Z",
        entry: {
          id: "create-1",
          createdAt: "2026-02-23T00:00:01.000Z",
          label: "Tool call",
          tone: "tool",
          itemType: "dynamic_tool_call",
          detail: 'Create file: {"path":"notes/todo.md"}',
        },
      },
      {
        id: "entry-write-1",
        kind: "work",
        createdAt: "2026-02-23T00:00:02.000Z",
        entry: {
          id: "write-1",
          createdAt: "2026-02-23T00:00:02.000Z",
          label: "Tool call Write",
          tone: "tool",
          itemType: "dynamic_tool_call",
          output: {
            toolName: "write_file",
            input: {
              path: "src/index.ts",
              content: "console.log('hi');",
            },
          },
        },
      },
      {
        id: "entry-delete-1",
        kind: "work",
        createdAt: "2026-02-23T00:00:03.000Z",
        entry: {
          id: "delete-1",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Tool call",
          tone: "tool",
          itemType: "dynamic_tool_call",
          detail: 'Delete file: {"path":"src/old.ts"}',
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
      "create-1",
      "write-1",
      "delete-1",
    ]);
    expect(buildWorkGroupSummary(workRows[0]!.groupedEntries, false)).toBe(
      "Created 1 file, edited 1 file, deleted 1 file",
    );
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

  it("formats Claude subagent tasks without dumping raw JSON input", () => {
    const subagentEntry = {
      id: "claude-subagent",
      createdAt: "2026-02-23T00:00:01.000Z",
      label: "Subagent task started",
      tone: "tool" as const,
      itemType: "collab_agent_tool_call" as const,
      detail:
        'Agent: {"description":"Review the database layer","prompt":"Audit the SQL changes","subagent_type":"code-reviewer"}',
    };

    expect(formatWorkEntry(subagentEntry)).toMatchObject({
      kind: "other",
      action: "",
      detail: "Review the database layer (code-reviewer)",
      monospace: false,
    });
  });

  it("formats Codex wait/close subagent tool calls with the correct action", () => {
    expect(
      formatWorkEntry({
        id: "codex-wait-agent",
        createdAt: "2026-02-23T00:00:01.000Z",
        label: "Subagent task",
        tone: "tool",
        itemType: "collab_agent_tool_call",
        output: {
          toolName: "wait",
          input: {
            targets: ["agent-1"],
          },
        },
      }),
    ).toMatchObject({
      kind: "other",
      action: "Waited for agent",
      detail: "agent-1",
    });

    expect(
      formatWorkEntry({
        id: "codex-close-agent",
        createdAt: "2026-02-23T00:00:01.000Z",
        label: "Subagent task",
        tone: "tool",
        itemType: "collab_agent_tool_call",
        output: {
          toolName: "closeAgent",
          input: {
            targets: ["agent-2"],
          },
        },
      }),
    ).toMatchObject({
      kind: "other",
      action: "Closed agent",
      detail: "agent-2",
    });
  });

  it("formats Skill tool calls with the launched skill name", () => {
    const skillEntry = {
      id: "claude-skill",
      createdAt: "2026-02-23T00:00:01.000Z",
      label: "Tool call Skill",
      tone: "tool" as const,
      itemType: "dynamic_tool_call" as const,
      detail: 'Skill: {"skill":"dogfood"}',
    };

    expect(formatWorkEntry(skillEntry)).toMatchObject({
      kind: "other",
      action: "Launched skill",
      detail: "dogfood",
      monospace: false,
    });
  });

  it("formats Claude Write tool calls as write actions with the target path", () => {
    const writeEntry = {
      id: "claude-write",
      createdAt: "2026-02-23T00:00:01.000Z",
      label: "Tool call Write",
      tone: "tool" as const,
      itemType: "dynamic_tool_call" as const,
      output: {
        toolName: "Write",
        input: {
          file_path: "/tmp/report.md",
          content: "# Report",
        },
      },
    };

    expect(formatWorkEntry(writeEntry)).toMatchObject({
      kind: "edit",
      action: "Wrote",
      detail: "/tmp/report.md",
      monospace: true,
    });

    expect(
      formatWorkEntry({
        ...writeEntry,
        id: "claude-file-write",
        output: {
          toolName: "FileWrite",
          input: {
            file_path: "/tmp/alias-report.md",
            content: "# Alias Report",
          },
        },
      }),
    ).toMatchObject({
      kind: "edit",
      action: "Wrote",
      detail: "/tmp/alias-report.md",
      monospace: true,
    });
  });

  it("formats create and delete file tool calls with file-change specific actions", () => {
    expect(
      formatWorkEntry({
        id: "create-file",
        createdAt: "2026-02-23T00:00:01.000Z",
        label: "Tool call",
        tone: "tool",
        itemType: "dynamic_tool_call",
        detail: 'Create file: {"path":"notes/todo.md"}',
      }),
    ).toMatchObject({
      kind: "edit",
      action: "Created",
      detail: "notes/todo.md",
      monospace: true,
    });

    expect(
      formatWorkEntry({
        id: "delete-file",
        createdAt: "2026-02-23T00:00:01.000Z",
        label: "Tool call",
        tone: "tool",
        itemType: "dynamic_tool_call",
        detail: 'Delete file: {"path":"src/old.ts"}',
      }),
    ).toMatchObject({
      kind: "edit",
      action: "Deleted",
      detail: "src/old.ts",
      monospace: true,
    });
  });

  it("omits useless empty-object details for Claude read/write/bash tool calls", () => {
    expect(
      formatWorkEntry({
        id: "claude-empty-read",
        createdAt: "2026-02-23T00:00:01.000Z",
        label: "Tool call",
        tone: "tool",
        itemType: "dynamic_tool_call",
        detail: "Read: {}",
      }),
    ).toMatchObject({
      kind: "read",
      action: "Read",
      detail: null,
    });

    expect(
      formatWorkEntry({
        id: "claude-empty-write",
        createdAt: "2026-02-23T00:00:01.000Z",
        label: "Tool call",
        tone: "tool",
        itemType: "file_change",
        detail: "Write: {}",
      }),
    ).toMatchObject({
      kind: "edit",
      action: "Wrote",
      detail: null,
    });

    expect(
      formatWorkEntry({
        id: "claude-empty-bash",
        createdAt: "2026-02-23T00:00:01.000Z",
        label: "Tool call",
        tone: "tool",
        itemType: "command_execution",
        detail: "Bash: {}",
      }),
    ).toMatchObject({
      kind: "command",
      action: "Ran",
      detail: null,
    });
  });

  it("keeps runtime diagnostics out of compact work row summaries", () => {
    expect(
      formatWorkEntry({
        id: "runtime-warning",
        createdAt: "2026-02-23T00:00:01.000Z",
        label: "Runtime warning",
        detail:
          '2026-04-10T10:02:09.111601Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Auth(TokenRefreshFailed("Server returned error response: invalid_grant: Invalid refresh token"))',
        tone: "info",
      }),
    ).toMatchObject({
      action: "Runtime warning",
      detail: null,
    });
  });

  it("drops redundant generic tool detail when it matches the tool name", () => {
    expect(
      formatWorkEntry({
        id: "context7-resolve-library-id",
        createdAt: "2026-04-11T20:00:01.000Z",
        label: "Tool call",
        tone: "tool",
        itemType: "dynamic_tool_call",
        toolTitle: "Resolve Library Id",
        detail: "Resolve Library Id",
      }),
    ).toMatchObject({
      kind: "other",
      action: "Resolve Library Id",
      detail: null,
    });
  });

  it("nests child work entries beneath their delegated subagent parent", () => {
    const timelineEntries: TimelineEntry[] = [
      {
        id: "subagent-parent",
        kind: "work",
        createdAt: "2026-02-23T00:00:01.000Z",
        entry: {
          id: "subagent-parent",
          createdAt: "2026-02-23T00:00:01.000Z",
          label: "Subagent task",
          tone: "tool",
          itemId: "agent-tool-1",
          itemType: "collab_agent_tool_call",
          detail:
            'Agent: {"description":"Find UI bugs in chat components","subagent_type":"explore"}',
        },
      },
      {
        id: "subagent-child-1",
        kind: "work",
        createdAt: "2026-02-23T00:00:02.000Z",
        entry: {
          id: "subagent-child-1",
          createdAt: "2026-02-23T00:00:02.000Z",
          label: "List directory",
          tone: "tool",
          parentItemId: "agent-tool-1",
          itemType: "command_execution",
          toolTitle: "List directory",
          detail: "src/components",
        },
      },
      {
        id: "top-level-sibling",
        kind: "work",
        createdAt: "2026-02-23T00:00:03.000Z",
        entry: {
          id: "top-level-sibling",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Status update",
          tone: "info",
          detail: "Main agent still coordinating work.",
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
    expect(workRows[0]?.groupedEntries.map((entry) => entry.id)).toEqual(["subagent-parent"]);
    expect(workRows[0]?.childRows).toHaveLength(1);
    expect(workRows[0]?.childRows[0]?.groupedEntries.map((entry) => entry.id)).toEqual([
      "subagent-child-1",
    ]);
    expect(workRows[1]?.groupedEntries.map((entry) => entry.id)).toEqual(["top-level-sibling"]);
  });

  it("nests child work entries beneath generic parent tool calls like Skill", () => {
    const timelineEntries: TimelineEntry[] = [
      {
        id: "skill-parent",
        kind: "work",
        createdAt: "2026-02-23T00:00:01.000Z",
        entry: {
          id: "skill-parent",
          createdAt: "2026-02-23T00:00:01.000Z",
          label: "Tool call Skill",
          tone: "tool",
          itemId: "skill-tool-1",
          itemType: "dynamic_tool_call",
          detail: 'Skill: {"skill":"dogfood"}',
        },
      },
      {
        id: "skill-child",
        kind: "work",
        createdAt: "2026-02-23T00:00:02.000Z",
        entry: {
          id: "skill-child",
          createdAt: "2026-02-23T00:00:02.000Z",
          label: "Read issue taxonomy",
          tone: "tool",
          parentItemId: "skill-tool-1",
          itemType: "command_execution",
          toolTitle: "Read file",
          detail: "/Users/choki/.claude/skills/dogfood/references/issue-taxonomy.md",
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
    expect(workRows[0]?.groupedEntries.map((entry) => entry.id)).toEqual(["skill-parent"]);
    expect(workRows[0]?.childRows).toHaveLength(1);
    expect(workRows[0]?.childRows[0]?.groupedEntries.map((entry) => entry.id)).toEqual([
      "skill-child",
    ]);
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

  it("keeps distinct workgroup kinds in separate rows", () => {
    const timelineEntries: TimelineEntry[] = [
      {
        id: "work-edit",
        kind: "work",
        createdAt: "2026-02-23T00:00:01.000Z",
        entry: {
          id: "work-edit",
          createdAt: "2026-02-23T00:00:01.000Z",
          label: "Edited app.ts",
          tone: "tool",
          itemType: "file_change",
          detail: "app.ts",
        },
      },
      {
        id: "work-read",
        kind: "work",
        createdAt: "2026-02-23T00:00:02.000Z",
        entry: {
          id: "work-read",
          createdAt: "2026-02-23T00:00:02.000Z",
          label: "Read file",
          tone: "tool",
          itemType: "dynamic_tool_call",
          requestKind: "file-read",
          detail: "README.md",
        },
      },
      {
        id: "work-command",
        kind: "work",
        createdAt: "2026-02-23T00:00:03.000Z",
        entry: {
          id: "work-command",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Execute command completed",
          tone: "tool",
          itemType: "command_execution",
          requestKind: "command",
          detail: "bun run lint",
          command: "bun run lint",
        },
      },
      {
        id: "work-web-search",
        kind: "work",
        createdAt: "2026-02-23T00:00:04.000Z",
        entry: {
          id: "work-web-search",
          createdAt: "2026-02-23T00:00:04.000Z",
          label: "Web search",
          tone: "tool",
          itemType: "web_search",
          detail: "Codex app workgroups",
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
    expect(workRows).toHaveLength(4);
    expect(workRows[0]?.groupedEntries.map((entry) => entry.id)).toEqual(["work-edit"]);
    expect(workRows[1]?.groupedEntries.map((entry) => entry.id)).toEqual(["work-read"]);
    expect(workRows[2]?.groupedEntries.map((entry) => entry.id)).toEqual(["work-command"]);
    expect(workRows[3]?.groupedEntries.map((entry) => entry.id)).toEqual(["work-web-search"]);
    expect(buildWorkGroupSummary(workRows[0]!.groupedEntries, false)).toBe("Edited 1 file");
    expect(buildWorkGroupSummary(workRows[1]!.groupedEntries, false)).toBe("Explored 1 file");
    expect(buildWorkGroupSummary(workRows[2]!.groupedEntries, false)).toBe("Ran 1 command");
    expect(buildWorkGroupSummary(workRows[3]!.groupedEntries, false)).toBe("Searched web 1 time");
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
    expect(isWorkRowInProgress(workRows[0]!)).toBe(true);
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

  it("integrates reasoning entries into a single extreme workgroup without changing the header group", () => {
    const timelineEntries: TimelineEntry[] = [
      {
        id: "reasoning-1",
        kind: "reasoning",
        createdAt: "2026-02-23T00:00:01.000Z",
        reasoning: {
          id: "reasoning-1",
          createdAt: "2026-02-23T00:00:01.000Z",
          text: "Inspecting the worktree",
          streaming: true,
          turnId: null,
        },
      },
      {
        id: "work-1",
        kind: "work",
        createdAt: "2026-02-23T00:00:02.000Z",
        entry: {
          id: "work-1",
          createdAt: "2026-02-23T00:00:02.000Z",
          label: "Read file",
          tone: "tool",
          itemType: "command_execution",
          toolTitle: "Read file",
          detail: "AGENTS.md",
        },
      },
      {
        id: "reasoning-2",
        kind: "reasoning",
        createdAt: "2026-02-23T00:00:03.000Z",
        reasoning: {
          id: "reasoning-2",
          createdAt: "2026-02-23T00:00:03.000Z",
          text: "Checking for workgroup rendering hooks",
          streaming: false,
          turnId: null,
        },
      },
      {
        id: "work-2",
        kind: "work",
        createdAt: "2026-02-23T00:00:04.000Z",
        entry: {
          id: "work-2",
          createdAt: "2026-02-23T00:00:04.000Z",
          label: "Run rg",
          tone: "tool",
          itemType: "command_execution",
          command: "rg workgroup",
          detail: "rg workgroup",
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
    const reasoningRows = rows.filter((row) => row.kind === "reasoning");
    expect(workRows).toHaveLength(1);
    expect(reasoningRows).toHaveLength(0);
    expect(workRows[0]?.groupedEntries.map((entry) => entry.id)).toEqual(["work-1", "work-2"]);
    expect(workRows[0]?.inlineEntries?.map((entry) => entry.kind)).toEqual([
      "reasoning",
      "work",
      "reasoning",
      "work",
    ]);
    expect(buildWorkGroupSummary(workRows[0]!.groupedEntries, false)).toBe(
      "Explored 1 file, 1 search",
    );
  });

  it("distributes reasoning entries into adjacent extreme workgroups instead of separate top-level rows", () => {
    const timelineEntries: TimelineEntry[] = [
      {
        id: "reasoning-before-edit",
        kind: "reasoning",
        createdAt: "2026-02-23T00:00:01.000Z",
        reasoning: {
          id: "reasoning-before-edit",
          createdAt: "2026-02-23T00:00:01.000Z",
          text: "Inspecting header semantics",
          streaming: false,
          turnId: null,
        },
      },
      {
        id: "work-edit",
        kind: "work",
        createdAt: "2026-02-23T00:00:02.000Z",
        entry: {
          id: "work-edit",
          createdAt: "2026-02-23T00:00:02.000Z",
          label: "Edited file",
          tone: "tool",
          itemType: "file_change",
          detail: "ChatHeader.test.tsx",
        },
      },
      {
        id: "reasoning-before-command",
        kind: "reasoning",
        createdAt: "2026-02-23T00:00:03.000Z",
        reasoning: {
          id: "reasoning-before-command",
          createdAt: "2026-02-23T00:00:03.000Z",
          text: "Preparing verification run",
          streaming: true,
          turnId: null,
        },
      },
      {
        id: "work-command",
        kind: "work",
        createdAt: "2026-02-23T00:00:04.000Z",
        entry: {
          id: "work-command",
          createdAt: "2026-02-23T00:00:04.000Z",
          label: "Run typecheck",
          tone: "tool",
          itemType: "command_execution",
          command: "bun typecheck",
          detail: "bun typecheck",
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
    const reasoningRows = rows.filter((row) => row.kind === "reasoning");
    expect(workRows).toHaveLength(2);
    expect(reasoningRows).toHaveLength(0);
    expect(workRows[0]?.groupedEntries.map((entry) => entry.id)).toEqual(["work-edit"]);
    expect(workRows[1]?.groupedEntries.map((entry) => entry.id)).toEqual(["work-command"]);
    expect(workRows[0]?.inlineEntries?.map((entry) => entry.kind)).toEqual(["reasoning", "work"]);
    expect(workRows[1]?.inlineEntries?.map((entry) => entry.kind)).toEqual(["reasoning", "work"]);
    expect(buildWorkGroupSummary(workRows[0]!.groupedEntries, false)).toBe("Edited 1 file");
    expect(buildWorkGroupSummary(workRows[1]!.groupedEntries, false)).toBe("Ran 1 command");
  });

  it("does not group consecutive status updates into one work disclosure", () => {
    const timelineEntries: TimelineEntry[] = [
      {
        id: "status-1",
        kind: "work",
        createdAt: "2026-02-23T00:00:01.000Z",
        entry: {
          id: "status-1",
          createdAt: "2026-02-23T00:00:01.000Z",
          label: "Status update",
          tone: "info",
          detail: "Running List React component files in apps/web/src",
        },
      },
      {
        id: "status-2",
        kind: "work",
        createdAt: "2026-02-23T00:00:02.000Z",
        entry: {
          id: "status-2",
          createdAt: "2026-02-23T00:00:02.000Z",
          label: "Status update",
          tone: "info",
          detail: "Finding **/*.tsx",
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
    expect(workRows[1]?.groupedEntries).toHaveLength(1);
  });
});
