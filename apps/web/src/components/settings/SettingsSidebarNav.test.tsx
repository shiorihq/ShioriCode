import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../../lib/settingsNavigation", () => ({
  readSettingsReturnPath: () => "/",
  resolveSettingsBackNavigation: () => ({ to: "/" }),
}));

import { SidebarProvider } from "../ui/sidebar";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

function renderSettingsSidebar(pathname = "/settings/general") {
  return renderToStaticMarkup(
    <SidebarProvider>
      <SettingsSidebarNav pathname={pathname} />
    </SidebarProvider>,
  );
}

describe("SettingsSidebarNav", () => {
  it("inherits the shared sidebar text color for back and section items", () => {
    const html = renderSettingsSidebar("/settings/appearance");

    expect(html).toContain('data-slot="sidebar-menu-button"');
    expect(html).toContain("text-sidebar-accent-foreground");
    expect(html).not.toContain("text-muted-foreground");
  });
});
