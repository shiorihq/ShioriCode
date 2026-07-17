import { describe, expect, it } from "vitest";

import { DOT_MATRIX_LOADER_COUNT } from "./dot-matrix-loader";

describe("Dot Matrix loader catalog", () => {
  it("keeps every gallery loader in the random chat pool", () => {
    expect(DOT_MATRIX_LOADER_COUNT).toBe(90);
  });
});
