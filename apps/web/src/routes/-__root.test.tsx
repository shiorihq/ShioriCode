import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AuthGateScreenContent } from "./__root";

describe("AuthGateScreenContent", () => {
  it("renders all supported sign-in methods on the lock screen", () => {
    const html = renderToStaticMarkup(<AuthGateScreenContent />);

    expect(html).toContain("Shiori");
    expect(html).toContain("Code");
    expect(html).toContain("Sign in required");
    expect(html).toContain("GitHub");
    expect(html).toContain("Google");
    expect(html).toContain("Apple");
    expect(html).toContain("Sign in with password");
    expect(html).toContain("Create account");
    expect(html).toContain("unlock the app");
  });
});
