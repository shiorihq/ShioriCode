import { MessageId } from "contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

describe("MessagesTimeline", () => {
  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-2"),
              role: "user",
              text: [
                "yoo what's @terminal-1:1-5 mean",
                "",
                "<terminal_context>",
                "- Terminal 1 lines 1-5:",
                "  1 | julius@mac effect-http-ws-cli % bun i",
                "  2 | bun install v1.3.9 (cf6cdbbb)",
                "</terminal_context>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
  });

  it("renders context compaction entries in the normal work log", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Context compacted");
  });

  it("renders status updates as muted plain text instead of tool-style rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-status-update",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-status-update",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Status update",
              detail: "The first pass should keep the turn open.",
              tone: "info",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("The first pass should keep the turn open.");
    expect(markup).not.toContain("Status update");
    expect(markup).not.toContain("aria-expanded");
  });

  it("keeps full work-log output in the DOM while visually clamping it behind a show-more affordance", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const output = Array.from({ length: 16 }, (_, index) => `tool output line ${index + 1}`).join(
      "\n",
    );
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-command-output",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-command-output",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "exec_command completed",
              detail: "bun run lint",
              command: "bun run lint",
              tone: "tool",
              toolTitle: "exec_command",
              itemType: "command_execution",
              output,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{ "entry-command-output": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Show more");
    expect(markup).toContain(
      "mask-image:linear-gradient(to bottom, black calc(100% - 3rem), transparent 100%)",
    );
    expect(markup).toContain("tool output line 16");
  });

  it("renders command details in monospace within work log rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-command-style",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-command-style",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "exec_command completed",
              detail: "bun run lint",
              command: "bun run lint",
              tone: "tool",
              toolTitle: "exec_command",
              itemType: "command_execution",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Ran");
    expect(markup).toContain("font-mono");
    expect(markup).toContain("bun run lint");
  });

  it("renders codex command execution payloads as structured metadata instead of raw JSON", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-command-execution-payload",
            kind: "work",
            createdAt: "2026-04-05T11:33:01.000Z",
            entry: {
              id: "work-command-execution-payload",
              createdAt: "2026-04-05T11:33:01.000Z",
              label: "exec_command completed",
              detail: "nl -ba apps/server/src/ws.ts | sed -n '388,406p'",
              command: "nl -ba apps/server/src/ws.ts | sed -n '388,406p'",
              tone: "tool",
              toolTitle: "exec_command",
              itemType: "command_execution",
              output: {
                item: {
                  type: "commandExecution",
                  id: "call_QdDkospw0L10iY12ezfMEdDH",
                  command: "/bin/zsh -lc \"nl -ba apps/server/src/ws.ts | sed -n '388,406p'\"",
                  cwd: "/Users/choki/Developer/t3code",
                  processId: "99228",
                  source: "unifiedExecStartup",
                  status: "completed",
                  commandActions: [{ label: "Open in terminal" }, { label: "Copy command" }],
                },
              },
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-04-05T11:33:10.000Z"
        expandedWorkGroups={{ "entry-command-execution-payload": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Directory");
    expect(markup).toContain("/Users/choki/Developer/t3code");
    expect(markup).toContain("PID");
    expect(markup).toContain("99228");
    expect(markup).toContain("Source");
    expect(markup).toContain("unifiedExecStartup");
    expect(markup).toContain("Open in terminal");
    expect(markup).toContain("Copy command");
    expect(markup).not.toContain("&quot;commandActions&quot;");
    expect(markup).not.toContain("&quot;processId&quot;");
  });

  it("renders read details in monospace within work log rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-read-style",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-read-style",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read file",
              detail: "README.md",
              tone: "tool",
              toolTitle: "read_file",
              itemType: "dynamic_tool_call",
              requestKind: "file-read",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Read");
    expect(markup).toContain("font-mono");
    expect(markup).toContain("README.md");
  });

  it("renders read_file output as file contents instead of raw JSON", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-read-file-output",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-read-file-output",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read file",
              detail: "README.md",
              tone: "tool",
              toolTitle: "read_file",
              itemType: "dynamic_tool_call",
              requestKind: "file-read",
              output: {
                path: "README.md",
                content: "hello from read file",
              },
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{ "entry-read-file-output": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("hello from read file");
    expect(markup).not.toContain("&quot;content&quot;");
  });

  it("renders list_directory entries as list actions instead of reads", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-list-directory",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-list-directory",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "List directory",
              detail: "src",
              tone: "tool",
              toolTitle: "List directory",
              itemType: "dynamic_tool_call",
              requestKind: "file-read",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("List");
    expect(markup).toContain("src");
    expect(markup).not.toContain("Read src");
  });

  it("summarizes grouped exploratory work entries as explored and keeps semantic list markup", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-list-directory",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "List directory",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "List directory",
              detail: ".",
            },
          },
          {
            id: "entry-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-read-file",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "index.html",
            },
          },
          {
            id: "entry-3",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "work-find",
              createdAt: "2026-03-17T19:12:30.000Z",
              label: "find completed",
              tone: "tool",
              itemType: "command_execution",
              command: 'find . -name "*.md"',
              detail: 'find . -name "*.md"',
            },
          },
          {
            id: "entry-4",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "work-read-entrypoints",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Read ENTRYPOINTS.md",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "ENTRYPOINTS.md",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{ "entry-1": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Explored 2 files, 1 search, 1 list");
    expect(markup).toContain("Searched for");
    expect(markup).toContain("*.md");
    expect(markup).toContain("<ul");
    expect(markup).toContain("<li");
  });

  it("uses exploring when any entry in an exploration group is still running", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-running-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-running-read",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read package.json started",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "package.json",
              running: true,
            },
          },
          {
            id: "entry-running-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-running-list",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "List directory",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "List directory",
              detail: "src",
              running: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Exploring 1 file, 1 list");
    expect(markup).not.toContain("Explored");
  });

  it("keeps the trailing active exploration group on exploring until the stream moves on", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:27.000Z"
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-tail-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-tail-read",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read package.json",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "package.json",
            },
          },
          {
            id: "entry-tail-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-tail-list",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "List directory",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "List directory",
              detail: "src",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Exploring 1 file, 1 list");
    expect(markup).not.toContain("Explored");
  });

  it("uses edited for completed edit groups and editing while any edit entry is still running", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");

    const completedMarkup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-edit-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-edit-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Edited a.ts",
              tone: "tool",
              itemType: "file_change",
              detail: "a.ts",
            },
          },
          {
            id: "entry-edit-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-edit-2",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Edited b.ts",
              tone: "tool",
              itemType: "file_change",
              detail: "b.ts",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    const runningMarkup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-edit-running-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-edit-running-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Edited a.ts",
              tone: "tool",
              itemType: "file_change",
              detail: "a.ts",
            },
          },
          {
            id: "entry-edit-running-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-edit-running-2",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Edited b.ts started",
              tone: "tool",
              itemType: "file_change",
              detail: "b.ts",
              running: true,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(completedMarkup).toContain("Edited");
    expect(completedMarkup).not.toContain("Editing");
    expect(runningMarkup).toContain("Editing");
  });

  it("uses running while any command entry in a command group is still running", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-command-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-command-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "exec_command completed",
              tone: "tool",
              itemType: "command_execution",
              command: "bun run lint",
              detail: "bun run lint",
            },
          },
          {
            id: "entry-command-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-command-2",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "exec_command started",
              tone: "tool",
              itemType: "command_execution",
              command: "bun run typecheck",
              detail: "bun run typecheck",
              running: true,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Running");
    expect(markup).toContain("Ran");
  });

  it("renders reasoning blocks with Thinking while streaming and Thought after completion", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const reasoningMarkdown = "**Inspecting project details**";

    const streamingMarkup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "reasoning-streaming",
            kind: "reasoning",
            createdAt: "2026-03-17T19:12:28.000Z",
            reasoning: {
              id: "reasoning-streaming",
              createdAt: "2026-03-17T19:12:28.000Z",
              text: reasoningMarkdown,
              streaming: true,
              turnId: null,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    const completedMarkup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "reasoning-completed",
            kind: "reasoning",
            createdAt: "2026-03-17T19:12:28.000Z",
            reasoning: {
              id: "reasoning-completed",
              createdAt: "2026-03-17T19:12:28.000Z",
              text: reasoningMarkdown,
              streaming: false,
              turnId: null,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(streamingMarkup).toContain("Thinking");
    expect(streamingMarkup).toContain("<strong>Inspecting project details</strong>");
    expect(completedMarkup).toContain("Thought");
    expect(completedMarkup).toContain("<strong>Inspecting project details</strong>");
    expect(completedMarkup).not.toContain("bg-muted/20");
  });

  it("keeps reasoning rows as the same disclosure even when no visible details are available", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "reasoning-empty",
            kind: "reasoning",
            createdAt: "2026-03-17T19:12:28.000Z",
            reasoning: {
              id: "reasoning-empty",
              createdAt: "2026-03-17T19:12:28.000Z",
              text: "",
              streaming: false,
              turnId: null,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Thought");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('disabled=""');
  });
});
