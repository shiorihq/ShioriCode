import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AppRouteShell, type AppRouteLayoutLoader } from "./AppRouteShell";

describe("AppRouteShell", () => {
  it("renders a layout that resolved before the shell mounted without invoking it as state", () => {
    const Layout = ({ children }: { children: React.ReactNode }) => (
      <main data-testid="resolved-layout">{children}</main>
    );
    const layoutLoader: AppRouteLayoutLoader = {
      getResolved: () => Layout,
      load: vi.fn(async () => Layout),
    };

    const html = renderToStaticMarkup(
      <AppRouteShell layoutLoader={layoutLoader}>
        <div>Ready</div>
      </AppRouteShell>,
    );

    expect(html).toContain('data-testid="resolved-layout"');
    expect(html).toContain("Ready");
  });
});
