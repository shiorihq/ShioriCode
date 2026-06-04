import path from "node:path";

import { describe, expect, it } from "vitest";

import { computerUseHelperCandidatesFor } from "./helperResolver";

describe("computer use helper resolver", () => {
  it("includes development, staged, and packaged macOS helper candidates", () => {
    const candidates = computerUseHelperCandidatesFor({
      appRoot: "/repo",
      configured: " /custom/ShioriComputerUseHelper ",
      packagePath: "/helper-package",
      resourcesPath: "/Applications/ShioriCode.app/Contents/Resources",
    });

    expect(candidates).toEqual([
      "/custom/ShioriComputerUseHelper",
      path.join("/helper-package", ".build", "debug", "ShioriComputerUseHelper"),
      path.join("/helper-package", ".build", "release", "ShioriComputerUseHelper"),
      path.join("/repo", "apps/desktop/resources/native/macos", "ShioriComputerUseHelper"),
      path.join("/repo", "apps/desktop/prod-resources/native/macos", "ShioriComputerUseHelper"),
      path.join(
        "/Applications/ShioriCode.app/Contents/Resources",
        "native",
        "macos",
        "ShioriComputerUseHelper",
      ),
      path.join(
        "/Applications/ShioriCode.app/Contents/Resources",
        "resources",
        "native",
        "macos",
        "ShioriComputerUseHelper",
      ),
    ]);
  });

  it("defaults the Swift package path from the app root", () => {
    const candidates = computerUseHelperCandidatesFor({
      appRoot: "/repo",
    });

    expect(candidates.slice(0, 2)).toEqual([
      path.join(
        "/repo",
        "apps/desktop/native/ShioriComputerUse",
        ".build",
        "debug",
        "ShioriComputerUseHelper",
      ),
      path.join(
        "/repo",
        "apps/desktop/native/ShioriComputerUse",
        ".build",
        "release",
        "ShioriComputerUseHelper",
      ),
    ]);
  });
});
