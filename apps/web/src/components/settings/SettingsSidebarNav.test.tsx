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

let mobileAppEnabled = false;

vi.mock("../../featureFlags", () => ({
  useMobileAppFeatureEnabled: () => mobileAppEnabled,
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
    mobileAppEnabled = false;
  });

  it("inherits the shared sidebar hover color for back and section items", () => {
    const html = renderSettingsSidebar("/settings/appearance");
    const menuButtonClassNames = [...html.matchAll(/<button\b[^>]*>/g)]
      .map((match) => match[0])
      .filter((button) => button.includes('data-slot="sidebar-menu-button"'))
      .map((button) => button.match(/class="([^"]*)"/)?.[1] ?? "")
      .join(" ");

    expect(html).toContain('data-slot="sidebar-menu-button"');
    expect(html).toContain("hover:text-sidebar-hover-foreground");
    expect(menuButtonClassNames).not.toContain("text-muted-foreground");
  });

  it("always shows local Computer Use settings", () => {
    const html = renderSettingsSidebar("/settings/computer-use");

    expect(html).toContain("Computer Use");
    expect(html).toContain('data-active="true"');
  });

  it("hides Mobile App when the hosted feature flag is off", () => {
    const html = renderSettingsSidebar();

    expect(html).not.toContain("Mobile App");
  });

  it("shows Mobile App when the hosted feature flag is on", () => {
    mobileAppEnabled = true;

    const html = renderSettingsSidebar("/settings/mobile");

    expect(html).toContain("Mobile App");
    expect(html).toContain('data-active="true"');
  });
});
