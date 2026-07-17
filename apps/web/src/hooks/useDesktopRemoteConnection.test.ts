import { describe, expect, it } from "vitest";

import { desktopRemoteLabel } from "./useDesktopRemoteConnection";

describe("desktopRemoteLabel", () => {
  it("shows a compact hostname for valid remote URLs", () => {
    expect(desktopRemoteLabel("https://sc-example.link.shiori.codes/path")).toBe(
      "sc-example.link.shiori.codes",
    );
  });

  it("preserves a value that is not a URL", () => {
    expect(desktopRemoteLabel("development server")).toBe("development server");
  });
});
