import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuSubButton,
  SidebarProvider,
  SidebarRail,
} from "./sidebar";

function renderSidebarButton(className?: string) {
  return renderToStaticMarkup(
    <SidebarProvider>
      <SidebarMenuButton className={className}>Projects</SidebarMenuButton>
    </SidebarProvider>,
  );
}

describe("sidebar interactive cursors", () => {
  it("fades desktop offcanvas contents as the sidebar opens and closes", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider open={false}>
        <Sidebar collapsible="offcanvas">
          <SidebarHeader>Header</SidebarHeader>
          <SidebarContent>Content</SidebarContent>
          <SidebarFooter>Footer</SidebarFooter>
          <SidebarRail />
        </Sidebar>
      </SidebarProvider>,
    );

    expect(html).toContain('data-collapsible="offcanvas"');
    expect(html).toContain("group-data-[collapsible=offcanvas]:opacity-0");
    expect(html).toContain("opacity-100");
    expect(html).toContain("transition-opacity");
    expect(html).toContain("duration-150");
  });

  it("uses a pointer cursor for menu buttons by default", () => {
    const html = renderSidebarButton();

    expect(html).toContain('data-slot="sidebar-menu-button"');
    expect(html).toContain("cursor-pointer");
    expect(html).toContain("hover:bg-sidebar-hover");
  });

  it("lets project drag handles override the default pointer cursor", () => {
    const html = renderSidebarButton("cursor-grab");

    expect(html).toContain("cursor-grab");
    expect(html).not.toContain("cursor-pointer");
  });

  it("uses a pointer cursor for menu actions", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuAction aria-label="Create thread">
        <span>+</span>
      </SidebarMenuAction>,
    );

    expect(html).toContain('data-slot="sidebar-menu-action"');
    expect(html).toContain("cursor-pointer");
    expect(html).toContain("hover:bg-sidebar-hover");
  });

  it("uses a pointer cursor for submenu buttons", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuSubButton render={<button type="button" />}>Show more</SidebarMenuSubButton>,
    );

    expect(html).toContain('data-slot="sidebar-menu-sub-button"');
    expect(html).toContain("cursor-pointer");
    expect(html).toContain("hover:bg-sidebar-hover");
  });

  it("keeps the resize rail above overlapping content shells", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarRail />
      </SidebarProvider>,
    );

    expect(html).toContain('data-slot="sidebar-rail"');
    expect(html).toContain("z-30");
  });
});
