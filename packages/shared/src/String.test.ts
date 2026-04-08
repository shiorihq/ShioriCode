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
  it("trims and lowercases project titles", () => {
    expect(normalizeProjectTitle("  My-Project  ")).toBe("my-project");
  });

  it("keeps already lowercase names unchanged", () => {
    expect(normalizeProjectTitle("demo")).toBe("demo");
  });

  it("falls back to project when the title is blank", () => {
    expect(normalizeProjectTitle("   ")).toBe("project");
  });
});
