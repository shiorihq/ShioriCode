import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComposerContextPanel } from "./ComposerContextPanel";

describe("ComposerContextPanel", () => {
  it("renders the shared task and agent sections", () => {
    const markup = renderToStaticMarkup(
      <ComposerContextPanel
        taskList={{
          createdAt: "2026-04-23T12:00:00.000Z",
          turnId: null,
          source: "plan",
          items: [
            {
              id: "task-1",
              title: "Replace separate composer panels",
              status: "completed",
              source: "plan",
            },
            {
              id: "task-2",
              title: "Wire in the shared composer chrome",
              detail: "ChatView is being updated.",
              status: "inProgress",
              source: "plan",
            },
          ],
        }}
        taskListOpen
        queuedTurns={[]}
        queuedOpen
        backgroundSubagents={[
          {
            id: "agent-1",
            rootItemId: "root-1",
            provider: "codex",
            displayName: "Harvey",
            mentionName: "Harvey",
            hasContents: true,
            agentRole: "explorer",
            instruction: "Inspect the composer stack",
            providerThreadIds: ["provider-thread-1"],
            taskIds: [],
            status: "active",
            childEntries: [],
          },
        ]}
        backgroundSubagentsOpen
        onTaskListOpenChange={vi.fn()}
        onQueuedOpenChange={vi.fn()}
        onDeleteQueuedTurn={vi.fn()}
        onEditQueuedTurn={vi.fn()}
        onBackgroundSubagentsOpenChange={vi.fn()}
      />,
    );

    expect(markup).toContain("Tasks");
    expect(markup).toContain("1/2");
    expect(markup).toContain("Background agents");
    expect(markup).toContain("Harvey");
    expect(markup).toContain("Inspect the composer stack");
  });
});
