import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AppStartupShell } from "./AppStartupShell";

describe("AppStartupShell", () => {
  it("shows the application frame while workspace data is loading", () => {
    const html = renderToStaticMarkup(<AppStartupShell />);

    expect(html).toContain('data-testid="app-startup-shell"');
    expect(html).toContain("Shiori Code");
    expect(html).toContain("Projects");
    expect(html).toContain("Loading your workspace");
    expect(html).not.toContain("Warming up the Agents");
  });
});
