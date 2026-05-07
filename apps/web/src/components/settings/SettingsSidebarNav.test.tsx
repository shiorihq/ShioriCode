import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    preload: _preload,
    replace: _replace,
    to,
    ...props
  }: {
    children: ReactNode;
    preload?: string;
    replace?: boolean;
    to: string;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

vi.mock("../../lib/settingsNavigation", () => ({
  readSettingsReturnPath: () => "/",
  resolveSettingsBackNavigation: () => ({ to: "/" }),
}));

let computerUseEnabled = false;

vi.mock("../../convex/HostedShioriProvider", () => ({
  useHostedShioriState: () => ({ computerUseEnabled }),
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
  beforeEach(() => {
    computerUseEnabled = false;
  });

  it("inherits the shared sidebar hover color for back and section items", () => {
    const html = renderSettingsSidebar("/settings/appearance");

    expect(html).toContain('data-slot="sidebar-menu-button"');
    expect(html).toContain("hover:text-sidebar-hover-foreground");
    expect(html).not.toContain("text-muted-foreground");
  });

  it("hides Computer Use when the hosted feature flag is off", () => {
    const html = renderSettingsSidebar();

    expect(html).not.toContain("Computer Use");
  });

  it("shows Computer Use when the hosted feature flag is on", () => {
    computerUseEnabled = true;

    const html = renderSettingsSidebar("/settings/computer-use");

    expect(html).toContain("Computer Use");
    expect(html).toContain('data-active="true"');
  });
});
