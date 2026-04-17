import { describe, expect, it } from "vitest";
import { ThreadId } from "contracts";
import type { ClientProjectionSnapshot } from "shared/orchestrationClientProjection";

import { resolveSelectedThreadId } from "./controller";

function makeProjection(threadIds: string[]): ClientProjectionSnapshot {
  return {
    projects: [],
    threads: [],
    threadIndexById: Object.fromEntries(threadIds.map((threadId, index) => [threadId, index])),
    sidebarThreadsById: {},
    threadIdsByProjectId: {},
  };
}

describe("resolveSelectedThreadId", () => {
  it("keeps the current selection when the thread still exists", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");

    expect(resolveSelectedThreadId(makeProjection([threadId]), threadId)).toBe(threadId);
  });

  it("stays unselected when there is no explicit thread selection", () => {
    expect(resolveSelectedThreadId(makeProjection(["thread-1"]), null)).toBeNull();
  });

  it("clears selection instead of falling back to a latest thread", () => {
    const missingThreadId = ThreadId.makeUnsafe("thread-missing");

    expect(resolveSelectedThreadId(makeProjection(["thread-1"]), missingThreadId)).toBeNull();
  });
});
