import { describe, expect, it } from "vitest";

import { getCodeFontFamilyCssValue, getUiFontFamilyCssValue } from "./fonts";

describe("font helpers", () => {
  it("falls back to the system UI stack for private macOS font identifiers", () => {
    expect(getUiFontFamilyCssValue(".SFNS-Regular")).toBe(
      'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    );
  });

  it("falls back to the system monospace stack for private macOS font identifiers", () => {
    expect(getCodeFontFamilyCssValue(".AppleSDGothicNeoI-Regular")).toBe(
      'ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    );
  });
});
