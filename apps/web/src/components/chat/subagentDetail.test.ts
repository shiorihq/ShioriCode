import { describe, expect, it } from "vitest";

import type { WorkLogEntry } from "../../session-logic";
import {
  collectSubagentDescendantEntries,
  extractCodexProviderThreadIdsFromWorkEntry,
  findSubagentRootEntry,
} from "./subagentDetail";

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
});
