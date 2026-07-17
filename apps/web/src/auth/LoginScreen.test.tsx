import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LoginScreen } from "./LoginScreen";

describe("LoginScreen", () => {
  it("shows GitHub-only authentication for ShioriCode Link", () => {
    const html = renderToStaticMarkup(
      <LoginScreen authMode="shioricode-link" onSuccess={vi.fn()} />,
    );

    expect(html).toContain("Continue with GitHub");
    expect(html).not.toContain("Username");
    expect(html).not.toContain("Password");
  });
});
