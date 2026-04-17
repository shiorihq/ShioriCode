import { EventId, TurnId, type OrchestrationThreadActivity } from "contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BackgroundSubagentsPanel } from "./BackgroundSubagentsPanel";

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

describe("BackgroundSubagentsPanel", () => {
  it("renders Codex background subagents above the composer", () => {
    const markup = renderToStaticMarkup(
      <BackgroundSubagentsPanel
        provider="codex"
        activities={[
          makeActivity({
            id: "codex-root",
            createdAt: "2026-04-09T08:00:00.000Z",
            kind: "tool.completed",
            summary: "Subagent task",
            tone: "tool",
            turnId: "turn-1",
            payload: {
              itemId: "spawn-item-1",
              itemType: "collab_agent_tool_call",
              data: {
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
          }),
        ]}
      />,
    );

    expect(markup).toContain("1 background agent");
    expect(markup).toContain("@ to tag agents");
    expect(markup).toContain("Harvey");
    expect(markup).toContain("explorer");
    expect(markup).toContain("is awaiting instruction");
  });

  it("renders Claude background subagents too", () => {
    const markup = renderToStaticMarkup(
      <BackgroundSubagentsPanel
        provider="claudeAgent"
        activities={[
          makeActivity({
            id: "claude-root",
            createdAt: "2026-04-09T08:00:00.000Z",
            kind: "tool.completed",
            summary: "Subagent task",
            tone: "tool",
            turnId: "turn-1",
            payload: {
              itemId: "agent-tool-claude",
              itemType: "collab_agent_tool_call",
              data: {
                toolName: "Task",
                input: {
                  description: "Review the database layer",
                  prompt: "Audit the SQL changes",
                  subagent_type: "code-reviewer",
                  run_in_background: true,
                },
              },
            },
          }),
          makeActivity({
            id: "claude-task-progress",
            createdAt: "2026-04-09T08:00:01.000Z",
            kind: "task.progress",
            summary: "Status update",
            tone: "info",
            turnId: "turn-1",
            payload: {
              taskId: "task-subagent-1",
              parentItemId: "agent-tool-claude",
              detail: "Code reviewer checked the migration edge cases.",
            },
          }),
        ]}
      />,
    );

    expect(markup).toContain("1 background agent");
    expect(markup).toContain("code-reviewer");
    expect(markup).toContain("Review the database layer");
  });

  it("renders Shiori background subagents too", () => {
    const markup = renderToStaticMarkup(
      <BackgroundSubagentsPanel
        provider="shiori"
        activities={[
          makeActivity({
            id: "shiori-root",
            createdAt: "2026-04-09T08:00:00.000Z",
            kind: "tool.completed",
            summary: "Subagent task",
            tone: "tool",
            turnId: "turn-1",
            payload: {
              itemId: "agent-tool-shiori",
              itemType: "collab_agent_tool_call",
              data: {
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
          }),
        ]}
      />,
    );

    expect(markup).toContain("1 background agent");
    expect(markup).toContain("Harvey");
    expect(markup).toContain("explorer");
  });
});
