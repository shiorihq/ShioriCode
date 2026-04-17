import { describe, expect, it } from "vitest";

import { normalizeProjectTitle, truncate } from "./String";

describe("truncate", () => {
  it("trims surrounding whitespace", () => {
    expect(truncate("   hello world   ")).toBe("hello world");
  });

  it("returns shorter strings unchanged", () => {
    expect(truncate("alpha", 10)).toBe("alpha");
  });

  it("truncates long strings and appends an ellipsis", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcde...");
  });
});

describe("normalizeProjectTitle", () => {
  it("trims project titles without changing casing", () => {
    expect(normalizeProjectTitle("  My-Project  ")).toBe("My-Project");
  });

  it("keeps already normalized names unchanged", () => {
    expect(normalizeProjectTitle("demo")).toBe("demo");
  });

  it("falls back to project when the title is blank", () => {
    expect(normalizeProjectTitle("   ")).toBe("project");
  });
});
