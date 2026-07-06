import { describe, expect, it } from "vitest";

import { resolveDropZone } from "./dnd";

describe("resolveDropZone", () => {
  const rect = { left: 0, top: 0, width: 400, height: 200 };

  it("targets the pane itself in the middle", () => {
    expect(resolveDropZone(rect, 200, 100)).toBe("center");
    expect(resolveDropZone(rect, 110, 60)).toBe("center");
  });

  it("targets the nearest edge in the outer quarters", () => {
    expect(resolveDropZone(rect, 20, 100)).toBe("left");
    expect(resolveDropZone(rect, 380, 100)).toBe("right");
    expect(resolveDropZone(rect, 200, 10)).toBe("top");
    expect(resolveDropZone(rect, 200, 190)).toBe("bottom");
  });

  it("picks the closest edge near corners", () => {
    expect(resolveDropZone(rect, 30, 90)).toBe("left");
    expect(resolveDropZone(rect, 90, 10)).toBe("top");
  });

  it("clamps positions outside the rect", () => {
    expect(resolveDropZone(rect, -50, 100)).toBe("left");
    expect(resolveDropZone(rect, 200, 500)).toBe("bottom");
  });

  it("degrades to center for empty rects", () => {
    expect(resolveDropZone({ left: 0, top: 0, width: 0, height: 0 }, 10, 10)).toBe("center");
  });
});
