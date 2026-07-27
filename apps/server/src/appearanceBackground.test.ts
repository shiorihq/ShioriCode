import { describe, expect, it } from "vitest";

import { detectAppearanceBackgroundFormat } from "./appearanceBackground";

describe("detectAppearanceBackgroundFormat", () => {
  it.each([
    ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ["image/jpeg", [0xff, 0xd8, 0xff, 0xe0]],
    ["image/webp", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]],
  ])("detects %s from file bytes", (mimeType, bytes) => {
    expect(detectAppearanceBackgroundFormat(new Uint8Array(bytes))).toMatchObject({ mimeType });
  });

  it("rejects content that only claims to be an image", () => {
    expect(detectAppearanceBackgroundFormat(new TextEncoder().encode("not an image"))).toBeNull();
  });
});
