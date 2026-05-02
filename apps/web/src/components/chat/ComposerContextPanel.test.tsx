import { renderToStaticMarkup } from "react-dom/server";
import { ThreadId } from "contracts";
import { describe, expect, it, vi } from "vitest";

import { type QueuedTurnDraft } from "../../queuedTurnsStore";
import { ComposerContextPanel } from "./ComposerContextPanel";

describe("ComposerContextPanel", () => {
  it("renders the shared queue, task, and agent sections", () => {
    const queuedTurn = {
      id: "queued-1",
      threadId: ThreadId.makeUnsafe("thread-1"),
      messageId: "message-1",
      text: "Follow up on the queue rendering",
      attachments: [],
      modelSelection: { provider: "codex", model: "gpt-5.1" },
      runtimeMode: "full-access",
      interactionMode: "default",
      titleSeed: "Follow up on the queue rendering",
      createdAt: "2026-04-23T12:01:00.000Z",
      composerSnapshot: {
        prompt: "Follow up on the queue rendering",
        persistedAttachments: [],
        terminalContexts: [],
      },
      status: "queued",
      errorMessage: null,
    } as QueuedTurnDraft;

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
        queuedTurns={[queuedTurn]}
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
    expect(markup).toContain("Queued");
    expect(markup).toContain("Follow up on the queue rendering");
    expect(markup).toContain("Background agents");
    expect(markup).toContain("Harvey");
    expect(markup).toContain("Inspect the composer stack");
  });
});
