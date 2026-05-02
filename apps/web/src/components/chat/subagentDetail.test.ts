import { describe, expect, it } from "vitest";
import { EventId, TurnId, type OrchestrationThreadActivity } from "contracts";

import type { WorkLogEntry } from "../../session-logic";
import {
  collectSubagentDescendantEntries,
  deriveBackgroundSubagentRows,
  deriveCodexBackgroundSubagentRows,
  extractCodexProviderThreadIdsFromWorkEntry,
  findSubagentRootEntry,
} from "./subagentDetail";

function makeActivity(
  input: Omit<OrchestrationThreadActivity, "id" | "turnId"> & {
    id: string;
    turnId: string | null;
  },
): OrchestrationThreadActivity {
  return {
    ...input,
    id: EventId.makeUnsafe(input.id),
    turnId: input.turnId ? TurnId.makeUnsafe(input.turnId) : null,
  };
}

describe("subagentDetail", () => {
  it("finds the subagent root entry by item id", () => {
    const entries: WorkLogEntry[] = [
      {
        id: "root",
        createdAt: "2026-04-08T10:00:00.000Z",
        label: "Subagent task",
        tone: "tool",
        itemId: "agent-root",
        itemType: "collab_agent_tool_call",
      },
      {
        id: "other",
        createdAt: "2026-04-08T10:00:01.000Z",
        label: "Read file",
        tone: "tool",
        itemId: "read-1",
        itemType: "command_execution",
      },
    ];

    expect(findSubagentRootEntry(entries, "agent-root")?.id).toBe("root");
    expect(findSubagentRootEntry(entries, "missing")).toBeNull();
  });

  it("collects nested descendant entries under a delegated subagent root", () => {
    const entries: WorkLogEntry[] = [
      {
        id: "root",
        createdAt: "2026-04-08T10:00:00.000Z",
        label: "Subagent task",
        tone: "tool",
        itemId: "agent-root",
        itemType: "collab_agent_tool_call",
      },
      {
        id: "child",
        createdAt: "2026-04-08T10:00:01.000Z",
        label: "Read file",
        tone: "tool",
        itemId: "read-1",
        parentItemId: "agent-root",
        itemType: "command_execution",
      },
      {
        id: "grandchild",
        createdAt: "2026-04-08T10:00:02.000Z",
        label: "Search",
        tone: "tool",
        itemId: "grep-1",
        parentItemId: "read-1",
        itemType: "command_execution",
      },
      {
        id: "unrelated",
        createdAt: "2026-04-08T10:00:03.000Z",
        label: "Other",
        tone: "tool",
        itemId: "other-1",
        itemType: "command_execution",
      },
    ];

    expect(
      collectSubagentDescendantEntries(entries, "agent-root").map((entry) => entry.id),
    ).toEqual(["child", "grandchild"]);
  });

  it("extracts Codex child provider thread ids from raw tool payloads", () => {
    const entry: WorkLogEntry = {
      id: "root",
      createdAt: "2026-04-08T10:00:00.000Z",
      label: "Subagent task",
      tone: "tool",
      itemId: "agent-root",
      itemType: "collab_agent_tool_call",
      output: {
        item: {
          receiverThreadIds: ["thr_child_1", "thr_child_2"],
        },
      },
    };

    expect(extractCodexProviderThreadIdsFromWorkEntry(entry)).toEqual([
      "thr_child_1",
      "thr_child_2",
    ]);
  });

  it("derives visible Codex background subagent rows and filters closed agents", () => {
    const rows = deriveCodexBackgroundSubagentRows([
      {
        id: "spawn-1",
        createdAt: "2026-04-08T10:00:00.000Z",
        label: "Subagent task",
        tone: "tool",
        itemId: "spawn-item-1",
        itemType: "collab_agent_tool_call",
        output: {
          toolName: "spawn_agent",
          input: {
            name: "Harvey",
            description: "Inspect the app shell",
            agent_type: "explorer",
            run_in_background: true,
          },
          item: {
            receiverThreadIds: ["agent-1"],
          },
        },
      },
      {
        id: "child-running-1",
        createdAt: "2026-04-08T10:00:01.000Z",
        label: "Read file started",
        tone: "tool",
        itemId: "child-item-1",
        parentItemId: "spawn-item-1",
        itemType: "command_execution",
        running: true,
      },
      {
        id: "spawn-2",
        createdAt: "2026-04-08T10:00:02.000Z",
        label: "Subagent task",
        tone: "tool",
        itemId: "spawn-item-2",
        itemType: "collab_agent_tool_call",
        output: {
          toolName: "spawn_agent",
          input: {
            name: "Euclid",
            description: "Trace provider events",
            agent_type: "explorer",
            run_in_background: true,
          },
          item: {
            receiverThreadIds: ["agent-2"],
          },
        },
      },
      {
        id: "close-2",
        createdAt: "2026-04-08T10:00:03.000Z",
        label: "Close subagent",
        tone: "tool",
        itemType: "collab_agent_tool_call",
        output: {
          toolName: "closeAgent",
          input: {
            targets: ["agent-2"],
          },
        },
      },
    ]);

    expect(rows).toEqual([
      {
        id: "spawn-1",
        rootItemId: "spawn-item-1",
        provider: "codex",
        displayName: "Harvey",
        mentionName: "Harvey",
        hasContents: true,
        agentRole: "explorer",
        instruction: "Inspect the app shell",
        providerThreadIds: ["agent-1"],
        taskIds: [],
        status: "active",
        childEntries: [
          {
            id: "child-running-1",
            createdAt: "2026-04-08T10:00:01.000Z",
            label: "Read file started",
            tone: "tool",
            itemId: "child-item-1",
            parentItemId: "spawn-item-1",
            itemType: "command_execution",
            running: true,
          },
        ],
      },
    ]);
  });

  it("uses stable human-friendly names when Codex does not provide an explicit one", () => {
    const rows = deriveCodexBackgroundSubagentRows([
      {
        id: "spawn-uuid",
        createdAt: "2026-04-08T10:00:00.000Z",
        label: "Subagent task",
        tone: "tool",
        itemId: "spawn-item-uuid",
        itemType: "collab_agent_tool_call",
        output: {
          toolName: "spawn_agent",
          input: {
            description: "Inspect the API surface",
            agent_type: "explorer",
            run_in_background: true,
          },
          item: {
            receiverThreadIds: ["019d71ab-d923-7550-83a8-3eea41f562c1"],
          },
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.displayName).not.toBe("019d71ab-d923-7550-83a8-3eea41f562c1");
    expect(rows[0]?.displayName).toMatch(/^[A-Z][a-z]+(?: [0-9]+)?$/);
  });

  it("derives Claude background subagent rows from task activities", () => {
    const workEntries: WorkLogEntry[] = [
      {
        id: "claude-root",
        createdAt: "2026-04-08T10:00:00.000Z",
        label: "Subagent task",
        tone: "tool",
        itemId: "agent-tool-claude",
        itemType: "collab_agent_tool_call",
        output: {
          toolName: "Task",
          input: {
            description: "Review the database layer",
            prompt: "Audit the SQL changes",
            subagent_type: "code-reviewer",
            run_in_background: true,
          },
        },
      },
      {
        id: "claude-progress",
        createdAt: "2026-04-08T10:00:01.000Z",
        label: "Status update",
        tone: "info",
        parentItemId: "agent-tool-claude",
        detail: "Code reviewer checked the migration edge cases.",
        running: true,
      },
    ];
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-started-claude",
        createdAt: "2026-04-08T10:00:00.000Z",
        tone: "info",
        kind: "task.started",
        summary: "code-reviewer task started",
        payload: {
          taskId: "task-subagent-1",
          parentItemId: "agent-tool-claude",
          taskType: "code-reviewer",
          detail: "Review the database layer",
        },
        turnId: "turn-1",
      }),
      makeActivity({
        id: "task-progress-claude",
        createdAt: "2026-04-08T10:00:01.000Z",
        tone: "info",
        kind: "task.progress",
        summary: "Status update",
        payload: {
          taskId: "task-subagent-1",
          parentItemId: "agent-tool-claude",
          detail: "Code reviewer checked the migration edge cases.",
        },
        turnId: "turn-1",
      }),
    ];

    const rows = deriveBackgroundSubagentRows({
      provider: "claudeAgent",
      workEntries,
      activities,
    });

    expect(rows).toEqual([
      {
        id: "claude-root",
        rootItemId: "agent-tool-claude",
        provider: "claudeAgent",
        displayName: expect.stringMatching(/^[A-Z][a-z]+(?: [0-9]+)?$/),
        mentionName: expect.stringMatching(/^[A-Za-z0-9._-]+$/),
        hasContents: true,
        agentRole: "code-reviewer",
        instruction: "Review the database layer",
        providerThreadIds: [],
        taskIds: ["task-subagent-1"],
        status: "active",
        childEntries: [
          {
            id: "claude-progress",
            createdAt: "2026-04-08T10:00:01.000Z",
            label: "Status update",
            tone: "info",
            parentItemId: "agent-tool-claude",
            detail: "Code reviewer checked the migration edge cases.",
            running: true,
          },
        ],
      },
    ]);
  });

  it("derives Shiori background subagent rows from stable task names", () => {
    const workEntries: WorkLogEntry[] = [
      {
        id: "shiori-root",
        createdAt: "2026-04-08T10:00:00.000Z",
        label: "Subagent task",
        tone: "tool",
        itemId: "agent-tool-shiori",
        itemType: "collab_agent_tool_call",
        output: {
          toolName: "spawn_agent",
          input: {
            message: "Inspect the billing reducer",
            agent_type: "explorer",
          },
          result: {
            id: "task-123",
            task_name: "Harvey",
            status: "pending_init",
          },
        },
      },
    ];
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-completed-shiori",
        createdAt: "2026-04-08T10:00:02.000Z",
        tone: "info",
        kind: "task.completed",
        summary: "Task completed",
        payload: {
          taskId: "task-123",
          parentItemId: "agent-tool-shiori",
          status: "completed",
          detail: "Delegated task completed.",
        },
        turnId: "turn-1",
      }),
    ];

    const rows = deriveBackgroundSubagentRows({
      provider: "shiori",
      workEntries,
      activities,
    });

    expect(rows).toEqual([
      {
        id: "shiori-root",
        rootItemId: "agent-tool-shiori",
        provider: "shiori",
        displayName: "Harvey",
        mentionName: "Harvey",
        hasContents: true,
        agentRole: "explorer",
        instruction: "Inspect the billing reducer",
        providerThreadIds: [],
        taskIds: ["task-123"],
        status: "waiting",
        childEntries: [],
      },
    ]);
  });

  it("derives Kimi background subagent rows from running Task tool calls", () => {
    const rows = deriveBackgroundSubagentRows({
      provider: "kimiCode",
      workEntries: [
        {
          id: "kimi-root",
          createdAt: "2026-05-02T10:00:00.000Z",
          label: "Subagent task",
          tone: "tool",
          itemId: "kimi-task-tool-1",
          itemType: "collab_agent_tool_call",
          running: true,
          output: {
            toolName: "Task",
            input: {
              description: "Inspect sidebar drag/drop styling",
              prompt: "Find the sidebar component and patch the hover/drop state.",
              subagent_type: "explorer",
            },
          },
        },
        {
          id: "kimi-child",
          createdAt: "2026-05-02T10:00:01.000Z",
          label: "Read file",
          tone: "tool",
          itemId: "kimi-read-1",
          parentItemId: "kimi-task-tool-1",
          itemType: "dynamic_tool_call",
          running: true,
        },
      ],
    });

    expect(rows).toEqual([
      {
        id: "kimi-root",
        rootItemId: "kimi-task-tool-1",
        provider: "kimiCode",
        displayName: expect.stringMatching(/^[A-Z][a-z]+(?: [0-9]+)?$/),
        mentionName: expect.stringMatching(/^[A-Za-z0-9._-]+$/),
        hasContents: true,
        agentRole: "explorer",
        instruction: "Inspect sidebar drag/drop styling",
        providerThreadIds: [],
        taskIds: [],
        status: "active",
        childEntries: [
          {
            id: "kimi-child",
            createdAt: "2026-05-02T10:00:01.000Z",
            label: "Read file",
            tone: "tool",
            itemId: "kimi-read-1",
            parentItemId: "kimi-task-tool-1",
            itemType: "dynamic_tool_call",
            running: true,
          },
        ],
      },
    ]);
  });
});
