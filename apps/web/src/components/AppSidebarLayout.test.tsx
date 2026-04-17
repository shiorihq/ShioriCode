import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AppSidebarLayout } from "./AppSidebarLayout";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
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
  useUiStateStore: (selector: (state: { requestProjectAdd: () => void }) => unknown) =>
    selector({ requestProjectAdd: () => undefined }),
}));

vi.mock("~/hooks/useSettings", () => ({
  useSettings: () => ({
    sidebarTranslucent: false,
  }),
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
  it("keeps the curved content shell from intercepting sidebar resize drags", () => {
    const html = renderToStaticMarkup(
      <AppSidebarLayout>
        <div>Content</div>
      </AppSidebarLayout>,
    );

    expect(html).toContain("bg-transparent pointer-events-none");
    expect(html).toContain(
      "pointer-events-auto overflow-hidden rounded-tl-[var(--app-sidebar-shell-radius)]",
    );
  });
});
