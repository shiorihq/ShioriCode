import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { mockState, mockThreadActions } = vi.hoisted(() => ({
  mockState: {
    projects: [{ id: "project-1", name: "Workspace", cwd: "/tmp/workspace" }],
    threads: [
      {
        id: "thread-1",
        projectId: "project-1",
        title: "Archived thread",
        archivedAt: "2026-04-04T15:17:11.000Z",
        createdAt: "2026-04-04T12:17:11.000Z",
      },
      {
        id: "thread-2",
        projectId: "project-1",
        title: "Still active",
        archivedAt: null,
        createdAt: "2026-04-04T11:17:11.000Z",
      },
    ],
  },
  mockThreadActions: {
    unarchiveThread: vi.fn(),
    confirmAndDeleteThread: vi.fn(),
  },
}));

vi.mock("../../store", () => ({
  useStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
}));

vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => mockThreadActions,
}));

vi.mock("../../timestampFormat", () => ({
  formatRelativeTime: () => ({ value: "1h", suffix: "ago" }),
  formatRelativeTimeLabel: (value: string) => value,
}));

vi.mock("../ProjectFavicon", () => ({
  ProjectFavicon: ({ cwd }: { cwd: string }) => <span data-project-favicon={cwd} />,
}));

import { ArchivedThreadsPanel } from "./SettingsPanels";

describe("ArchivedThreadsPanel", () => {
  it("renders an explicit delete button for archived threads", () => {
    const html = renderToStaticMarkup(<ArchivedThreadsPanel />);

    expect(html).toContain("Workspace");
    expect(html).toContain("Archived thread");
    expect(html).toContain('aria-label="Delete all archived threads for Workspace"');
    expect(html).toContain(">Delete All</button>");
    expect(html).toContain('aria-label="Unarchive all threads for Workspace"');
    expect(html).toContain(">Unarchive All</button>");
    expect(html).toContain('aria-label="Delete archived thread Archived thread"');
    expect(html).toContain(">Delete</span>");
    expect(html).toContain(">Unarchive</span>");
    expect(html).not.toContain("Still active");
  });
});
