import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SidebarUserFooterView } from "./SidebarUserFooter";

describe("SidebarUserFooterView", () => {
  it("blurs the avatar, display name, and plan when personal details are hidden", () => {
    const html = renderToStaticMarkup(
      <SidebarUserFooterView
        isAuthenticated
        viewer={{
          _id: "viewer-1",
          name: "Ada Lovelace",
          email: "ada@example.com",
          image: "https://example.com/avatar.png",
        }}
        subscriptionPlanLabel="Pro plan"
        blurPersonalData
        onSettingsClick={vi.fn()}
      />,
    );

    expect(html.match(/blur-sm select-none/g)).toHaveLength(3);
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Pro plan");
  });

  it("leaves footer details unblurred when the setting is off", () => {
    const html = renderToStaticMarkup(
      <SidebarUserFooterView
        isAuthenticated
        viewer={{
          _id: "viewer-1",
          name: "Ada Lovelace",
          email: "ada@example.com",
          image: "https://example.com/avatar.png",
        }}
        subscriptionPlanLabel="Pro plan"
        blurPersonalData={false}
        onSettingsClick={vi.fn()}
      />,
    );

    expect(html).not.toContain("blur-sm select-none");
  });
});
