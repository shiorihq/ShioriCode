import { ThreadId } from "contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SidebarBackgroundSubagentRowsView } from "./SidebarBackgroundSubagentRows";

describe("SidebarBackgroundSubagentRowsView", () => {
  it("renders indented Codex background subagents beneath a thread row", () => {
    const markup = renderToStaticMarkup(
      <SidebarBackgroundSubagentRowsView
        threadId={ThreadId.makeUnsafe("thread-1")}
        rows={[
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
            status: "waiting",
            childEntries: [],
          },
          {
            id: "spawn-2",
            rootItemId: "spawn-item-2",
            provider: "codex",
            displayName: "Euclid",
            mentionName: "Euclid",
            hasContents: true,
            agentRole: "explorer",
            instruction: "Trace provider events",
            providerThreadIds: ["agent-2"],
            taskIds: [],
            status: "active",
            childEntries: [],
          },
        ]}
      />,
    );

    expect(markup).toContain("Harvey");
    expect(markup).toContain("Euclid");
    expect(markup).toContain("is awaiting instruction");
    expect(markup).toContain("is working");
    expect(markup).toContain("pl-9");
    expect(markup).not.toContain("<button");
  });
});
