import "../../index.css";

import type { ProjectId } from "contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { useStore } from "~/store";

import { PrKanbanBoard } from "./PrKanbanBoard";

describe("PrKanbanBoard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useStore.setState({
      projects: [],
      kanbanItems: [],
      threads: [],
      threadIndexById: {},
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      pendingThreadDispatchById: {},
      bootstrapComplete: false,
    });
  });

  it("shows a loading state before the first orchestration snapshot arrives", async () => {
    useStore.setState({
      projects: [
        {
          id: "project-1" as ProjectId,
          name: "Alpha",
          cwd: "/tmp/alpha",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-04-30T00:00:00.000Z",
          updatedAt: "2026-04-30T00:00:00.000Z",
        },
      ],
      kanbanItems: [],
      bootstrapComplete: false,
    });

    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<PrKanbanBoard projectId={null} pullRequest={null} />, {
      container: host,
    });

    try {
      await expect.element(page.getByText("Loading goals...")).toBeInTheDocument();
      await expect.element(page.getByText("No goals yet")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
