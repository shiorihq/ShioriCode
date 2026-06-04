import path from "node:path";

import { describe, expect, it } from "vitest";

import { isAsarPath, resolveComputerUseHelperPathFor } from "./computerUseHelperResolver";

describe("computerUseHelperResolver", () => {
  it("returns null outside macOS", () => {
    expect(
      resolveComputerUseHelperPathFor({
        platform: "linux",
        rootDir: "/repo",
        exists: () => true,
      }),
    ).toBeNull();
  });

  it("prefers an explicit helper path on macOS", () => {
    expect(
      resolveComputerUseHelperPathFor({
        platform: "darwin",
        rootDir: "/repo",
        configured: " /custom/ShioriComputerUseHelper ",
        exists: (filePath) => filePath === "/custom/ShioriComputerUseHelper",
      }),
    ).toBe("/custom/ShioriComputerUseHelper");
  });

  it("resolves the packaged helper from Contents/Resources/native/macos", () => {
    const packagedHelper = path.join(
      "/Applications/ShioriCode.app/Contents/Resources",
      "native",
      "macos",
      "ShioriComputerUseHelper",
    );

    expect(
      resolveComputerUseHelperPathFor({
        platform: "darwin",
        rootDir: "/Applications/ShioriCode.app/Contents/Resources/app.asar",
        resourcesPath: "/Applications/ShioriCode.app/Contents/Resources",
        exists: (filePath) => filePath === packagedHelper,
      }),
    ).toBe(packagedHelper);
  });

  it("does not resolve helper binaries inside an asar archive", () => {
    const asarHelper = path.join(
      "/Applications/ShioriCode.app/Contents/Resources/app.asar",
      "apps",
      "desktop",
      "resources",
      "native",
      "macos",
      "ShioriComputerUseHelper",
    );
    const packagedHelper = path.join(
      "/Applications/ShioriCode.app/Contents/Resources",
      "resources",
      "native",
      "macos",
      "ShioriComputerUseHelper",
    );

    expect(isAsarPath(asarHelper)).toBe(true);
    expect(
      resolveComputerUseHelperPathFor({
        platform: "darwin",
        rootDir: "/Applications/ShioriCode.app/Contents/Resources/app.asar",
        resourcesPath: "/Applications/ShioriCode.app/Contents/Resources",
        exists: (filePath) => filePath === asarHelper || filePath === packagedHelper,
      }),
    ).toBe(packagedHelper);
  });
});
