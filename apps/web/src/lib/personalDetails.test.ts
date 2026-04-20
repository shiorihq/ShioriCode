import { describe, expect, it } from "vitest";

import { getPersonalDetailsBlurClass, shouldBlurEmailMention } from "./personalDetails";

describe("personal details helpers", () => {
  it("returns the blur classes when the preference is enabled", () => {
    expect(getPersonalDetailsBlurClass(true)).toBe("blur-sm select-none");
    expect(getPersonalDetailsBlurClass(false)).toBe("");
  });

  it("detects email mentions only when blurring is enabled", () => {
    expect(
      shouldBlurEmailMention({
        blurPersonalData: true,
        email: "ada@example.com",
        text: "Authenticated as ada@example.com",
      }),
    ).toBe(true);

    expect(
      shouldBlurEmailMention({
        blurPersonalData: false,
        email: "ada@example.com",
        text: "Authenticated as ada@example.com",
      }),
    ).toBe(false);
  });
});
