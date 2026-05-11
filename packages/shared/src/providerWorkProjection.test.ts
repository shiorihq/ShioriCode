import { describe, expect, it } from "vitest";

import {
  EventId,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "contracts";
import { projectProviderRuntimeEventsToTurnWorkSnapshot } from "./providerWorkProjection";

const threadId = ThreadId.makeUnsafe("thread-1");
const turnId = TurnId.makeUnsafe("turn-1");

function event(
  id: string,
  event: Omit<ProviderRuntimeEvent, "eventId" | "provider" | "threadId" | "turnId" | "createdAt">,
): ProviderRuntimeEvent {
  return {
    eventId: EventId.makeUnsafe(id),
    provider: "codex",
    threadId,
    turnId,
    createdAt: `2026-04-23T12:00:0${id.at(-1) ?? "0"}.000Z`,
    ...event,
  } as ProviderRuntimeEvent;
}

describe("projectProviderRuntimeEventsToTurnWorkSnapshot", () => {
  it("folds command lifecycle and output deltas into one work item", () => {
    const itemId = RuntimeItemId.makeUnsafe("cmd-1");
    const snapshot = projectProviderRuntimeEventsToTurnWorkSnapshot([
      event("evt-1", {
        type: "item.started",
        itemId,
        payload: {
          itemType: "command_execution",
          status: "inProgress",
          title: "Run command",
          data: {
            toolName: "exec_command",
            input: { command: "bun typecheck" },
          },
        },
      }),
      event("evt-2", {
        type: "content.delta",
        itemId,
        payload: {
          streamKind: "command_output",
          delta: "ok\n",
        },
      }),
      event("evt-3", {
        type: "item.completed",
        itemId,
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Run command",
          data: {
            toolName: "exec_command",
            input: { command: "bun typecheck" },
            result: { exitCode: 0 },
          },
        },
      }),
    ]);

    expect(snapshot?.items).toHaveLength(1);
    expect(snapshot?.items[0]).toMatchObject({
      id: "cmd-1",
      kind: "command",
      status: "completed",
      title: "Run command",
      detail: "Run command: bun typecheck",
      input: { command: "bun typecheck" },
      output: { exitCode: 0 },
    });
    expect(snapshot?.items[0]?.streams).toEqual([
      {
        id: "cmd-1:command_output:0:0",
        itemId: "cmd-1",
        kind: "command_output",
        text: "ok\n",
      },
    ]);
  });

  it("links subagent task progress back to its parent tool item", () => {
    const snapshot = projectProviderRuntimeEventsToTurnWorkSnapshot([
      event("evt-1", {
        type: "item.started",
        itemId: RuntimeItemId.makeUnsafe("tool:spawn-1"),
        payload: {
          itemType: "collab_agent_tool_call",
          status: "inProgress",
          title: "Subagent task",
          data: {
            toolName: "spawn_agent",
            input: { message: "review auth" },
          },
        },
      }),
      event("evt-2", {
        type: "task.started",
        payload: {
          taskId: RuntimeTaskId.makeUnsafe("agent-1"),
          description: "review auth",
          taskType: "subagent",
        },
        raw: {
          source: "shiori.hosted",
          method: "shiori/subagent/task_started",
          payload: { task_id: "agent-1", tool_use_id: "spawn-1" },
        },
      }),
      event("evt-3", {
        type: "task.completed",
        payload: {
          taskId: RuntimeTaskId.makeUnsafe("agent-1"),
          status: "completed",
          summary: "No issues found",
        },
        raw: {
          source: "shiori.hosted",
          method: "shiori/subagent/task_completed",
          payload: { task_id: "agent-1", tool_use_id: "spawn-1" },
        },
      }),
    ]);

    expect(snapshot?.items.map((item) => item.id)).toEqual(["tool:spawn-1", "task:agent-1"]);
    expect(snapshot?.items[1]).toMatchObject({
      id: "task:agent-1",
      parentId: "tool:spawn-1",
      kind: "subagent",
      status: "completed",
      detail: "No issues found",
    });
  });

  it("omits runtime warnings from turn work snapshots", () => {
    const snapshot = projectProviderRuntimeEventsToTurnWorkSnapshot([
      event("evt-1", {
        type: "runtime.warning",
        payload: {
          message: "Provider got slow",
        },
      }),
    ]);

    expect(snapshot?.items).toEqual([]);
    expect(snapshot?.sourceEventIds).toEqual([]);
  });
});
