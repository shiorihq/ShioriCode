import "../../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

describe("sidebar background glass", () => {
  afterEach(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-app-background");
    document.body.innerHTML = "";
  });

  it("uses a restrained tint and foreground-derived edge with a background image", async () => {
    document.documentElement.setAttribute("data-app-background", "");
    const screen = await render(
      <div data-app-sidebar-shell data-slot="sidebar-container">
        <div data-slot="sidebar-inner">
          <div className="bg-background">Sidebar content</div>
        </div>
        <div data-app-chat-shell-with-sidebar />
      </div>,
    );

    try {
      const rootStyle = getComputedStyle(document.documentElement);
      const content = document.querySelector<HTMLElement>(".bg-background");
      const mainShell = document.querySelector<HTMLElement>("[data-app-chat-shell-with-sidebar]");
      expect(content).not.toBeNull();
      expect(mainShell).not.toBeNull();
      // The sidebar shell now reads the shared chrome veil (one number for the
      // sidebar and every header bar) instead of its own hand-tuned tint.
      expect(rootStyle.getPropertyValue("--app-sidebar-shell-background")).toContain("53%");
      expect(rootStyle.getPropertyValue("--app-chrome-veil")).toContain("53%");
      expect(rootStyle.getPropertyValue("--app-sidebar-shell-edge-highlight")).toContain("14%");
      expect(getComputedStyle(content!).backgroundColor).not.toBe("rgba(255, 255, 255, 0.76)");
      expect(getComputedStyle(mainShell!, "::before").boxShadow).not.toContain(
        "rgba(255, 255, 255, 0.25)",
      );
    } finally {
      await screen.unmount();
    }
  });
});
