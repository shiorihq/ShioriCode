import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AppSidebarLayout } from "./AppSidebarLayout";

vi.mock("@tanstack/react-router", () => ({
  useLocation: <T,>(options: { select: (location: { pathname: string }) => T }) =>
    options.select({ pathname: "/" }),
  useNavigate: () => vi.fn(),
  useParams: <T,>(options: { select: (params: { threadId?: string }) => T }) => options.select({}),
}));

vi.mock("~/rpc/serverState", () => ({
  useServerKeybindings: () => [],
}));

vi.mock("~/hooks/useDesktopWindowControlsInset", () => ({
  useDesktopWindowControlsInset: () => 0,
}));

vi.mock("~/terminalStateStore", () => ({
  useTerminalStateStore: (
    selector: (state: { terminalStateByThreadId: Record<string, never> }) => unknown,
  ) => selector({ terminalStateByThreadId: {} }),
}));

vi.mock("~/uiStateStore", () => ({
  useUiStateStore: (
    selector: (state: { projectOrder: string[]; requestProjectAdd: () => void }) => unknown,
  ) => selector({ projectOrder: [], requestProjectAdd: () => undefined }),
}));

vi.mock("~/hooks/useSettings", () => ({
  useSettings: (
    selector?: (settings: { sidebarTranslucent: boolean; kanban: { enabled: boolean } }) => unknown,
  ) => {
    const settings = {
      sidebarTranslucent: false,
      kanban: { enabled: false },
    };
    return selector ? selector(settings) : settings;
  },
}));

vi.mock("./Sidebar", () => ({
  default: () => <div data-slot="thread-sidebar">Sidebar</div>,
}));

vi.mock("./CommandKModal", () => ({
  CommandKModal: () => null,
  useCommandK: () => ({
    open: false,
    setOpen: () => undefined,
  }),
}));

describe("AppSidebarLayout", () => {
  it("renders the curved content shell when the sidebar is open", () => {
    const html = renderToStaticMarkup(
      <AppSidebarLayout>
        <div>Content</div>
      </AppSidebarLayout>,
    );

    expect(html).toContain("-ml-px overflow-hidden rounded-l-[var(--app-sidebar-shell-radius)]");
    expect(html).toContain('data-app-chat-shell-with-sidebar="true"');
    expect(html).not.toContain('data-app-sidebar-content-shell="true"');
  });
});
