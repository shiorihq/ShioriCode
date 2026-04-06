import { describe, expect, it } from "vitest";
import { deepMerge, type DeepPartial } from "./Struct";

describe("deepMerge", () => {
  it("merges nested objects", () => {
    const current = { a: { b: 1, c: 2 }, d: 3 };
    const patch = { a: { b: 10 } };
    expect(deepMerge(current, patch)).toEqual({ a: { b: 10, c: 2 }, d: 3 });
  });

  it("replaces arrays instead of merging by index", () => {
    const current = { items: [{ name: "a" }, { name: "b" }, { name: "c" }] };
    const patch = { items: [{ name: "x" }] };
    expect(deepMerge(current, patch)).toEqual({ items: [{ name: "x" }] });
  });

  it("replaces empty array with populated array", () => {
    const current = { servers: [] as string[] };
    const patch = { servers: ["one", "two"] };
    expect(deepMerge(current, patch)).toEqual({ servers: ["one", "two"] });
  });

  it("replaces populated array with empty array", () => {
    const current = { servers: ["one", "two"] };
    const patch = { servers: [] as string[] };
    expect(deepMerge(current, patch)).toEqual({ servers: [] });
  });

  it("skips undefined patch values", () => {
    const current = { a: 1, b: 2 };
    const patch = { a: undefined } as unknown as DeepPartial<typeof current>;
    expect(deepMerge(current, patch)).toEqual({ a: 1, b: 2 });
  });

  it("replaces primitive values", () => {
    const current = { a: 1 };
    const patch = { a: 2 };
    expect(deepMerge(current, patch)).toEqual({ a: 2 });
  });
});
