import { MessageId, TurnId } from "contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getGroupedWorkEntryExpansionKey } from "./MessagesTimeline.logic";

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

function makeMcpBrowserToolEntry(id: string, url: string) {
  return {
    id,
    createdAt: "2026-04-30T21:02:09.000Z",
    label: "MCP tool call",
    tone: "tool" as const,
    itemType: "dynamic_tool_call" as const,
    detail: `MCP tool call: {"url":"${url}"}`,
    output: {
      toolName: "mcp__shioricode-browser-panel__browser_navigate",
      input: { url },
    },
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
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
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
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
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
              detail: "The first pass should keep the `typecheck` step plain text.",
              tone: "info",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("The first pass should keep the `typecheck` step plain text.");
    expect(markup).not.toContain("Status update");
    expect(markup).not.toContain("aria-expanded");
    expect(markup).not.toContain("<code>");
  });

  it("renders a copy button for expanded runtime warnings", async () => {
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
            id: "entry-runtime-warning",
            kind: "work",
            createdAt: "2026-04-10T10:02:09.111Z",
            entry: {
              id: "work-runtime-warning",
              createdAt: "2026-04-10T10:02:09.111Z",
              label: "Runtime warning",
              detail:
                '2026-04-10T10:02:09.111601Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Auth(TokenRefreshFailed("Server returned error response: invalid_grant: Invalid refresh token"))',
              tone: "info",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-runtime-warning": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Copy runtime warning");
    expect(markup).toContain("Invalid refresh token");
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
        expandedWorkGroups={{ "work-command-output": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Show more");
    expect(markup).toContain('class="relative"');
    expect(markup).toContain("<pre");
    expect(markup).not.toContain('<div class="mt-0.5 pl-4"><pre');
    expect(markup).toContain(
      "mask-image:linear-gradient(to bottom, black calc(100% - 3rem), transparent 100%)",
    );
    expect(markup).toContain("tool output line 16");
  });

  it("renders non-command tool output without an extra leading indent", async () => {
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
            id: "entry-tool-output",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-tool-output",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Tool call completed",
              detail: "read_file",
              tone: "tool",
              toolTitle: "read_file",
              itemType: "dynamic_tool_call",
              output: "first line\nsecond line",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-tool-output": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('<div class="mt-0.5"><div class="relative"><pre');
    expect(markup).not.toContain('<div class="mt-0.5 pl-4">');
    expect(markup).toContain("first line");
    expect(markup).toContain("second line");
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
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
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

  it("keeps completed single tool rows collapsed by default", async () => {
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
            id: "entry-command-compact",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-command-compact",
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
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Ran");
    expect(markup).toContain("bun run lint");
    expect(markup).toContain('aria-expanded="false"');
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
                result: {
                  stdout: "Typecheck passed\n",
                  stderr: "Warning: generated files skipped\n",
                },
                item: {
                  type: "commandExecution",
                  id: "call_QdDkospw0L10iY12ezfMEdDH",
                  command: "/bin/zsh -lc \"nl -ba apps/server/src/ws.ts | sed -n '388,406p'\"",
                  cwd: "/Users/choki/Developer/t3code",
                  processId: "99228",
                  source: "unifiedExecStartup",
                  status: "completed",
                  commandActions: [
                    { label: "Open in terminal" },
                    { label: "unknown" },
                    { label: "Copy command" },
                  ],
                },
              },
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-command-execution-payload": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
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
    expect(markup).toContain("Typecheck passed");
    expect(markup).toContain("Warning: generated files skipped");
    expect(markup).toContain('<div class="mt-0.5"><pre');
    expect(markup).not.toContain('<div class="mt-0.5 pl-4"><pre');
    expect(markup).not.toContain(">unknown</span>");
    expect(markup).not.toContain("&quot;commandActions&quot;");
    expect(markup).not.toContain("&quot;processId&quot;");
  });

  it("renders Skill tool calls as a structured workflow card instead of raw JSON", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const skillPath = "/Users/choki/.agents/skills/dogfood/SKILL.md";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-skill-tool",
            kind: "work",
            createdAt: "2026-04-06T15:28:01.000Z",
            entry: {
              id: "work-skill-tool",
              createdAt: "2026-04-06T15:28:01.000Z",
              label: "Tool call Skill",
              detail: 'Skill: {"skill":"dogfood"}',
              tone: "tool",
              itemType: "dynamic_tool_call",
              output: {
                toolName: "Skill",
                input: {
                  skill: "dogfood",
                },
                result: {
                  tool_use_id: "tool_abc123",
                  skill: "dogfood",
                  path: skillPath,
                  content: "# Dogfood\n\nUse evidence first.",
                },
              },
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-skill-tool": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Used Skill");
    expect(markup).toContain("dogfood");
    expect(markup).toContain(`href="${skillPath}"`);
    // Skill entries are non-expandable minimal entries
    expect(markup).not.toContain("tool_abc123");
    expect(markup).not.toContain("<h1>Dogfood</h1>");
    expect(markup).not.toContain("Use evidence first.");
    expect(markup).not.toContain("Skill workflow");
    expect(markup).not.toContain("&quot;skill&quot;");
  });

  it("renders delegated agent tool calls as a structured workflow card instead of raw JSON", async () => {
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
            id: "entry-agent-tool",
            kind: "work",
            createdAt: "2026-04-06T15:28:01.000Z",
            entry: {
              id: "work-agent-tool",
              createdAt: "2026-04-06T15:28:01.000Z",
              label: "Subagent task",
              detail:
                'Agent: {"description":"Find UI bugs in layouts/pages","prompt":"Explore the app","subagent_type":"explore","run_in_background":true}',
              tone: "tool",
              itemType: "collab_agent_tool_call",
              output: {
                toolName: "Agent",
                input: {
                  description: "Find UI bugs in layouts/pages",
                  prompt: "Explore the app",
                  subagent_type: "explore",
                  run_in_background: true,
                },
              },
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-agent-tool": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Delegated agent");
    expect(markup).toContain("Find UI bugs in layouts/pages");
    expect(markup).toContain("Explore the app");
    expect(markup).toContain("Background");
    expect(markup).not.toContain("&quot;subagent_type&quot;");
  });

  it("renders Kimi StrReplaceFile tool calls as inline edit diffs", async () => {
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
            id: "entry-generic-json-tool",
            kind: "work",
            createdAt: "2026-04-21T00:20:02.000Z",
            entry: {
              id: "work-generic-json-tool",
              createdAt: "2026-04-21T00:20:02.000Z",
              label: "Tool call StrReplaceFile",
              tone: "tool",
              itemType: "dynamic_tool_call",
              output: {
                toolName: "StrReplaceFile",
                input: {
                  path: "scripts/build-desktop-artifact.ts",
                  edit: {
                    old: "const MAC_ICON_PAD_SIZE = 1480;",
                    new: "const MAC_ICON_PAD_SIZE = 1320;",
                  },
                },
                result: {
                  isError: false,
                  output: "",
                  message:
                    "File successfully edited. Applied 1 edit(s) with 1 total replacement(s).",
                  display: [
                    {
                      type: "diff",
                      path: "scripts/build-desktop-artifact.ts",
                      old_text:
                        "const MAC_ICON_PAD_SIZE = 1480;\nconst MAC_ICON_OUTPUT_SIZE = 1024;",
                      new_text:
                        "const MAC_ICON_PAD_SIZE = 1320;\nconst MAC_ICON_OUTPUT_SIZE = 1024;",
                    },
                  ],
                },
              },
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-generic-json-tool": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('data-inline-diff="true"');
    expect(markup).toContain("build-desktop-artifact.ts");
    expect(markup).toContain("const MAC_ICON_PAD_SIZE = 1480;");
    expect(markup).toContain("const MAC_ICON_PAD_SIZE = 1320;");
    expect(markup).toContain("const MAC_ICON_OUTPUT_SIZE = 1024;");
    expect(markup).not.toContain("Copy JSON output");
  });

  it("renders Codex webSearch items as a non-expandable minimal entry", async () => {
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
            id: "entry-web-search-tool",
            kind: "work",
            createdAt: "2026-04-11T23:14:01.000Z",
            entry: {
              id: "work-web-search-tool",
              createdAt: "2026-04-11T23:14:01.000Z",
              label: "Web search",
              tone: "tool",
              itemType: "web_search",
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
                item: {
                  type: "webSearch",
                  id: "ws_123",
                  query: "",
                  action: {
                    type: "open_page",
                    value: "https://developers.openai.com/codex/sdk/",
                  },
                },
              },
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-web-search-tool": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Opened page");
    expect(markup).toContain("https://developers.openai.com/codex/sdk/");
    expect(markup).not.toContain("aria-expanded");
    expect(markup).not.toContain("&quot;action_type&quot;");
  });

  it("renders spawn_agent tool calls as delegated agent workflow cards", async () => {
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
            id: "entry-spawn-agent-tool",
            kind: "work",
            createdAt: "2026-04-06T15:29:01.000Z",
            entry: {
              id: "work-spawn-agent-tool",
              createdAt: "2026-04-06T15:29:01.000Z",
              label: "Subagent task",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              output: {
                toolName: "spawn_agent",
                input: {
                  description: "Audit the billing reducer",
                  prompt: "Look for race conditions in state updates",
                  agent_type: "code-reviewer",
                  run_in_background: true,
                },
              },
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-spawn-agent-tool": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Delegated agent");
    expect(markup).toContain("Audit the billing reducer");
    expect(markup).toContain("Look for race conditions in state updates");
    expect(markup).toContain("code-reviewer");
  });

  it("renders Claude Write tool calls with a diff preview and error message", async () => {
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
            id: "entry-write-tool",
            kind: "work",
            createdAt: "2026-04-06T16:02:01.000Z",
            entry: {
              id: "work-write-tool",
              createdAt: "2026-04-06T16:02:01.000Z",
              label: "Tool call Write",
              tone: "tool",
              itemType: "dynamic_tool_call",
              output: {
                toolName: "Write",
                input: {
                  file_path: "/Users/choki/Developer/shiori/dogfood-output/report.md",
                  content: "# Dogfood Report: Shiori\n\n## Summary\n",
                },
                result: {
                  type: "tool_result",
                  content:
                    "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>",
                  is_error: true,
                  tool_use_id: "toolu_0119tkSUYTv6EoNcpy9vzYco",
                },
              },
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-write-tool": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Wrote");
    expect(markup).toContain("/Users/choki/Developer/shiori/dogfood-output/report.md");
    expect(markup).toContain("Dogfood Report: Shiori");
    expect(markup).toContain("File has not been read yet. Read it first before writing to it.");
    expect(markup).toContain("font-mono");
    expect(markup).not.toContain("&quot;toolName&quot;");
  });

  it("renders write_file lifecycle output as an inline diff instead of bytes-only fallback text", async () => {
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
            id: "entry-write-file-tool",
            kind: "work",
            createdAt: "2026-04-06T16:12:01.000Z",
            entry: {
              id: "work-write-file-tool",
              createdAt: "2026-04-06T16:12:01.000Z",
              label: "Write file",
              tone: "tool",
              itemType: "file_change",
              detail: "apps/web/src/index.css",
              output: {
                toolName: "write_file",
                input: {
                  path: "apps/web/src/index.css",
                  content: "body {\n  color: red;\n}",
                },
                path: "apps/web/src/index.css",
                bytesWritten: 22,
              },
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-write-file-tool": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Wrote");
    expect(markup).toContain("index.css");
    expect(markup).toContain("color: red;");
    expect(markup).toContain('class="mt-1"><div data-inline-diff="true"');
    expect(markup).not.toContain("Wrote 22 bytes to apps/web/src/index.css");
  });

  it("renders single MCP tool calls with a toolbox icon", async () => {
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
            id: "entry-mcp-browser",
            kind: "work",
            createdAt: "2026-04-30T21:02:09.000Z",
            entry: {
              id: "work-mcp-browser",
              createdAt: "2026-04-30T21:02:09.000Z",
              label: "MCP tool call",
              tone: "tool",
              itemType: "dynamic_tool_call",
              detail: 'MCP tool call: {"url":"https://youtube.com"}',
              output: {
                toolName: "mcp__shioricode-browser-panel__browser_navigate",
                input: {
                  url: "https://youtube.com",
                },
              },
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Used MCP");
    expect(markup).toContain("browser navigate");
    expect(markup).not.toContain("MCP tool call: {&quot;url&quot;");
    expect(markup).toContain("lucide-toolbox");
  });

  it("does not repeat the MCP toolbox icon on MCP calls inside workgroups", async () => {
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
            id: "entry-mcp-browser-1",
            kind: "work",
            createdAt: "2026-04-30T21:02:09.000Z",
            entry: makeMcpBrowserToolEntry("work-mcp-browser-1", "https://youtube.com"),
          },
          {
            id: "entry-mcp-browser-2",
            kind: "work",
            createdAt: "2026-04-30T21:02:10.000Z",
            entry: makeMcpBrowserToolEntry("work-mcp-browser-2", "https://openai.com"),
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-mcp-browser-1": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup.match(/lucide-toolbox/g)?.length).toBe(1);
    expect(markup).toContain("Used MCP");
    expect(markup).toContain("browser navigate");
  });

  it("renders read details as basename file links within work log rows", async () => {
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
              detail: "/Users/choki/Developer/shiori/src/components/studio/StudioDetail.tsx",
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
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Read");
    expect(markup).toContain("app-file-href-link");
    expect(markup).toContain("app-file-href-icon");
    expect(markup).toContain("file_type_reactts.svg");
    expect(markup).toContain("StudioDetail.tsx");
    expect(markup).toContain(
      'href="/Users/choki/Developer/shiori/src/components/studio/StudioDetail.tsx"',
    );
    expect(markup).not.toContain("> /Users/choki/Developer/shiori/src/components/studio");
    expect(markup).not.toContain("font-mono");
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
        expandedWorkGroups={{ "work-read-file-output": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
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
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
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
        expandedWorkGroups={{ "work-list-directory": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
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
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
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
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
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

  it("keeps in-progress exploration groups expanded by default", async () => {
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
            id: "entry-capped-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-capped-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-1.ts",
            },
          },
          {
            id: "entry-capped-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-capped-2",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-2.ts",
            },
          },
          {
            id: "entry-capped-3",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "work-capped-3",
              createdAt: "2026-03-17T19:12:30.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-3.ts",
            },
          },
          {
            id: "entry-capped-4",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "work-capped-4",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-4.ts",
            },
          },
          {
            id: "entry-capped-5",
            kind: "work",
            createdAt: "2026-03-17T19:12:32.000Z",
            entry: {
              id: "work-capped-5",
              createdAt: "2026-03-17T19:12:32.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-5.ts",
            },
          },
          {
            id: "entry-capped-6",
            kind: "work",
            createdAt: "2026-03-17T19:12:33.000Z",
            entry: {
              id: "work-capped-6",
              createdAt: "2026-03-17T19:12:33.000Z",
              label: "Read file started",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-6.ts",
              running: true,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Exploring 6 files");
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("file-6.ts");
    expect(markup).not.toContain("Show 1 more");
  });

  it("keeps a sticky single-entry tail as a normal work entry while the turn is still active", async () => {
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
            id: "entry-sticky-read",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-sticky-read",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "package.json",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Read");
    expect(markup).toContain("package.json");
    expect(markup).not.toContain("Exploring 1 file");
    expect(markup).not.toContain("work-group-items-work-sticky-read");
  });

  it("keeps expanded in-progress groups in a capped scroll viewport instead of hiding later entries", async () => {
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
            id: "entry-capped-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-capped-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-1.ts",
            },
          },
          {
            id: "entry-capped-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-capped-2",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-2.ts",
            },
          },
          {
            id: "entry-capped-3",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "work-capped-3",
              createdAt: "2026-03-17T19:12:30.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-3.ts",
            },
          },
          {
            id: "entry-capped-4",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "work-capped-4",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-4.ts",
            },
          },
          {
            id: "entry-capped-5",
            kind: "work",
            createdAt: "2026-03-17T19:12:32.000Z",
            entry: {
              id: "work-capped-5",
              createdAt: "2026-03-17T19:12:32.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-5.ts",
            },
          },
          {
            id: "entry-capped-6",
            kind: "work",
            createdAt: "2026-03-17T19:12:33.000Z",
            entry: {
              id: "work-capped-6",
              createdAt: "2026-03-17T19:12:33.000Z",
              label: "Read file started",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-6.ts",
              running: true,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-capped-1": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Exploring 6 files");
    expect(markup).toContain("<ul");
    expect(markup).toContain("file-1.ts");
    expect(markup).toContain("file-5.ts");
    expect(markup).toContain("file-6.ts");
    expect(markup).toContain("max-h-48");
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("mask-image:linear-gradient(to bottom");
    expect(markup).toContain("[scrollbar-width:none]");
    expect(markup).toContain("[&amp;::-webkit-scrollbar]:hidden");
    expect(markup).not.toContain("Show 1 more");
  });

  it("renders only the recent slice of massive expanded work groups", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const timelineEntries = Array.from({ length: 100 }, (_, index) => {
      const commandNumber = String(index + 1).padStart(3, "0");
      return {
        id: `entry-massive-${commandNumber}`,
        kind: "work" as const,
        createdAt: `2026-03-17T19:12:${String(index % 60).padStart(2, "0")}.000Z`,
        entry: {
          id: `work-massive-${commandNumber}`,
          createdAt: `2026-03-17T19:12:${String(index % 60).padStart(2, "0")}.000Z`,
          label: "exec_command started",
          tone: "tool" as const,
          itemType: "command_execution" as const,
          command: `command-${commandNumber}`,
          detail: `command-${commandNumber}`,
          running: true,
        },
      };
    });

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={timelineEntries}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-massive-001": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Running 100 commands");
    expect(markup).toContain("20 older entries hidden");
    expect(markup).toContain(">Show</button>");
    expect(markup).not.toContain("command-001");
    expect(markup).toContain("command-021");
    expect(markup).toContain("command-100");
  });

  it("caps completed groups with internal scrolling instead of a show-more affordance", async () => {
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
            id: "entry-complete-capped-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-complete-capped-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-1.ts",
            },
          },
          {
            id: "entry-complete-capped-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-complete-capped-2",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-2.ts",
            },
          },
          {
            id: "entry-complete-capped-3",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "work-complete-capped-3",
              createdAt: "2026-03-17T19:12:30.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-3.ts",
            },
          },
          {
            id: "entry-complete-capped-4",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "work-complete-capped-4",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-4.ts",
            },
          },
          {
            id: "entry-complete-capped-5",
            kind: "work",
            createdAt: "2026-03-17T19:12:32.000Z",
            entry: {
              id: "work-complete-capped-5",
              createdAt: "2026-03-17T19:12:32.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-5.ts",
            },
          },
          {
            id: "entry-complete-capped-6",
            kind: "work",
            createdAt: "2026-03-17T19:12:33.000Z",
            entry: {
              id: "work-complete-capped-6",
              createdAt: "2026-03-17T19:12:33.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-6.ts",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-complete-capped-1": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Explored 6 files");
    expect(markup).toContain("file-6.ts");
    expect(markup).toContain("max-h-48");
    expect(markup).toContain("overflow-y-auto");
    expect(markup).not.toContain("Show 1 more");
  });

  it("caps expanded nested subagent activity lists inside the chat timeline", async () => {
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
            id: "subagent-parent-entry",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "subagent-parent-entry",
              itemId: "subagent-root-item",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Subagent task",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              detail:
                'Agent: {"description":"Find message action row implementation","subagent_type":"explore"}',
            },
          },
          ...Array.from({ length: 8 }, (_, index) => ({
            id: `subagent-child-entry-${index + 1}`,
            kind: "work" as const,
            createdAt: `2026-03-17T19:12:${String(29 + index).padStart(2, "0")}.000Z`,
            entry: {
              id: `subagent-child-entry-${index + 1}`,
              createdAt: `2026-03-17T19:12:${String(29 + index).padStart(2, "0")}.000Z`,
              label: "Read file",
              tone: "tool" as const,
              itemType: "command_execution" as const,
              toolTitle: "Read file",
              detail: `apps/web/src/components/chat/file-${index + 1}.tsx`,
              parentItemId: "subagent-root-item",
            },
          })),
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-item:subagent-root-item": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Find message action row implementation (explore)");
    expect(markup).toContain("apps/web/src/components/chat/file-1.tsx");
    expect(markup).toContain("apps/web/src/components/chat/file-8.tsx");
    expect(markup).toContain("max-h-48");
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("mask-image:linear-gradient(to bottom");
    expect(markup).toContain("[scrollbar-width:none]");
    expect(markup).toContain("[&amp;::-webkit-scrollbar]:hidden");
  });

  it("keeps completed exploration groups collapsed by default", async () => {
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
            id: "entry-complete-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-complete-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-a.ts",
            },
          },
          {
            id: "entry-complete-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-complete-2",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "file-b.ts",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Explored 2 files");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Show 1 more");
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
        expandedWorkGroups={{ "work-edit-1": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
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
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(completedMarkup).toContain("Edited 2 files");
    expect(completedMarkup).not.toContain("Editing");
    expect(completedMarkup).toContain("a.ts");
    expect(runningMarkup).toContain("Editing 2 files");
    expect(runningMarkup).toContain("b.ts");
  });

  it("supports expanding entries inside an expanded workgroup", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const innerEntryExpansionKey = getGroupedWorkEntryExpansionKey("work-edit-group-1");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-edit-group-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-edit-group-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Edited a.ts",
              tone: "tool",
              itemType: "file_change",
              detail: "a.ts",
              output: {
                item: {
                  changes: [
                    {
                      path: "a.ts",
                      diff: "@@ -1 +1 @@\n-oldValue\n+newValue",
                    },
                  ],
                },
              },
            },
          },
          {
            id: "entry-edit-group-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-edit-group-2",
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
        expandedWorkGroups={{
          "work-edit-group-1": true,
          [innerEntryExpansionKey]: true,
        }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Edited 2 files");
    expect(markup).toContain('aria-controls="work-entry-details-work-edit-group-1"');
    expect(markup).toContain("newValue");
    expect(markup).toContain("oldValue");
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
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Running 2 commands");
  });

  it("keeps grouped running and completed work entries flush without left padding", async () => {
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
            id: "entry-list-alignment",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-list-alignment",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "list directory",
              tone: "tool",
              itemType: "command_execution",
              detail: "apps/web/src",
            },
          },
          {
            id: "entry-run-alignment",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-run-alignment",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "exec_command started",
              tone: "tool",
              itemType: "command_execution",
              command: "bun run lint",
              detail: "bun run lint",
              running: true,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-list-alignment": true, "work-run-alignment": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup.match(/class="list-none py-0\.5"/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(markup).not.toContain('class="list-none py-0.5 pl-4"');
  });

  it("keeps a single running work row collapsible after the user toggles its visibility", async () => {
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
            id: "entry-running-toggle",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-running-toggle",
              createdAt: "2026-03-17T19:12:28.000Z",
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
        expandedWorkGroups={{ "work-running-toggle": false }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('aria-controls="work-group-items-work-running-toggle"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Running 1 command");
  });

  it("keeps a single running work row collapsible when visibility is keyed by item id", async () => {
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
            id: "entry-running-toggle-stable",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-running-toggle-stable",
              itemId: "tool-call-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "exec_command started",
              tone: "tool",
              itemType: "command_execution",
              command: "bun run lint",
              detail: "bun run lint",
              running: true,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-item:tool-call-1": false }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Running 1 command");
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
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
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
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(streamingMarkup).toContain("Thinking");
    expect(streamingMarkup).not.toContain("<strong>Inspecting project details</strong>");
    expect(streamingMarkup).not.toContain("max-h-48");
    expect(streamingMarkup).not.toContain("overflow-y-auto");
    expect(completedMarkup).toContain("Thought");
    expect(completedMarkup).not.toContain("max-h-48");
    expect(completedMarkup).not.toContain("overflow-y-auto");
    expect(completedMarkup).not.toContain("bg-muted/20");
  });

  it("renders reasoning blocks inside an expanded extreme workgroup without adding them to the header summary", async () => {
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
            id: "reasoning-inline-1",
            kind: "reasoning",
            createdAt: "2026-03-17T19:12:28.000Z",
            reasoning: {
              id: "reasoning-inline-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              text: "**Inspecting project details**",
              streaming: true,
              turnId: null,
            },
          },
          {
            id: "work-inline-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-inline-1",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Read file",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "AGENTS.md",
            },
          },
          {
            id: "reasoning-inline-2",
            kind: "reasoning",
            createdAt: "2026-03-17T19:12:30.000Z",
            reasoning: {
              id: "reasoning-inline-2",
              createdAt: "2026-03-17T19:12:30.000Z",
              text: "Comparing tool runs",
              streaming: false,
              turnId: null,
            },
          },
          {
            id: "work-inline-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "work-inline-2",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Run rg",
              tone: "tool",
              itemType: "command_execution",
              command: "rg workgroup",
              detail: "rg workgroup",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{ "work-inline-1": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Explored 1 file, 1 search");
    expect(markup).toContain("Thinking");
    expect(markup).not.toContain("<strong>Inspecting project details</strong>");
  });

  it("does not leave reasoning as separate top-level rows when adjacent extreme workgroups exist", async () => {
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
            id: "reasoning-inline-edit",
            kind: "reasoning",
            createdAt: "2026-03-17T19:12:28.000Z",
            reasoning: {
              id: "reasoning-inline-edit",
              createdAt: "2026-03-17T19:12:28.000Z",
              text: "Checking the header label",
              streaming: false,
              turnId: null,
            },
          },
          {
            id: "work-inline-edit",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-inline-edit",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Edited file",
              tone: "tool",
              itemType: "file_change",
              detail: "ChatHeader.test.tsx",
            },
          },
          {
            id: "reasoning-inline-command",
            kind: "reasoning",
            createdAt: "2026-03-17T19:12:30.000Z",
            reasoning: {
              id: "reasoning-inline-command",
              createdAt: "2026-03-17T19:12:30.000Z",
              text: "Running the verification suite",
              streaming: true,
              turnId: null,
            },
          },
          {
            id: "work-inline-command",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "work-inline-command",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "Run typecheck",
              tone: "tool",
              itemType: "command_execution",
              command: "bun typecheck",
              detail: "bun typecheck",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{
          "work-inline-edit": true,
          "work-inline-command": true,
        }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Edited 1 file, ran 1 command");
    expect(markup).toContain("Thinking");
    expect(markup).not.toContain('data-timeline-row-kind="reasoning"');
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
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
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
    expect(markup).not.toContain("max-h-48");
  });

  it("hides assistant footer actions for an in-progress active turn until the whole response finishes", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:27.000Z"
        activeTurnId={TurnId.makeUnsafe("turn-active")}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "user-active",
            kind: "message",
            createdAt: "2026-03-17T19:12:27.000Z",
            message: {
              id: MessageId.makeUnsafe("user-active"),
              role: "user",
              text: "",
              turnId: null,
              createdAt: "2026-03-17T19:12:27.000Z",
              streaming: false,
            },
          },
          {
            id: "assistant-active",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-active"),
              role: "assistant",
              text: "Dev server is running. Let me keep exploring.",
              turnId: TurnId.makeUnsafe("turn-active"),
              createdAt: "2026-03-17T19:12:28.000Z",
              completedAt: "2026-03-17T19:12:55.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain("Copy message");
  });

  it("keeps the bottom working indicator as elapsed time instead of the current workgroup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T19:13:32.000Z"));
    try {
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
              id: "entry-working-read",
              kind: "work",
              createdAt: "2026-03-17T19:12:28.000Z",
              entry: {
                id: "work-working-read",
                createdAt: "2026-03-17T19:12:28.000Z",
                label: "Read file started",
                tone: "tool",
                itemType: "command_execution",
                toolTitle: "Read file",
                detail: "package.json",
                running: true,
              },
            },
          ]}
          completionDividerBeforeEntryId={null}
          completionSummary={null}
          turnDiffSummaryByAssistantMessageId={new Map()}
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          onRetryAssistantMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="locale"
          workspaceRoot={undefined}
        />,
      );

      expect(markup).toContain("Working for 1 minute 5 seconds");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides the bottom working indicator while the first assistant response has not arrived yet", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        showWorkingIndicator={false}
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:27.000Z"
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-working-read",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-working-read",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read file started",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Read file",
              detail: "package.json",
              running: true,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Reading");
    expect(markup).toContain("package.json");
    expect(markup).not.toContain("Working for");
  });

  it("keeps top-level assistant and activity rows on a shared leading edge", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress={false}
        activeTurnStartedAt="2026-03-17T19:12:27.000Z"
        scrollContainer={null}
        timelineEntries={[
          {
            id: "assistant-alignment",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-alignment"),
              role: "assistant",
              text: "Assistant body copy should share the same leading edge.",
              turnId: TurnId.makeUnsafe("turn-alignment"),
              createdAt: "2026-03-17T19:12:28.000Z",
              completedAt: "2026-03-17T19:12:55.000Z",
              streaming: false,
            },
          },
          {
            id: "status-update-alignment",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-status-update-alignment",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Status update",
              detail: "Activity copy should line up with assistant prose.",
              tone: "info",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary="All rows should align"
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onRetryAssistantMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain("min-w-0 px-1 py-0.5");
    expect(markup).not.toContain('class="py-0.5 pl-1"');
    expect(markup).not.toContain("mb-1.5 pl-1 text-foreground/60");
  });
});
