import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  computerUseHelperCandidatesFor,
  computerUsePermissionSubjectForHelperPath,
} from "./computerUseHelper";

describe("computerUseHelperCandidatesFor", () => {
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

  it("allows callers to prefer release builds before debug builds", () => {
    const candidates = computerUseHelperCandidatesFor({
      appRoot: "/repo",
      packagePath: "/helper-package",
      buildConfigurationOrder: ["release", "debug"],
    });

    expect(candidates.slice(0, 2)).toEqual([
      path.join("/helper-package", ".build", "release", "ShioriComputerUseHelper"),
      path.join("/helper-package", ".build", "debug", "ShioriComputerUseHelper"),
    ]);
  });

  it("describes the macOS permission subject for helper paths and missing helpers", () => {
    expect(
      computerUsePermissionSubjectForHelperPath(
        " /Applications/ShioriCode.app/Contents/Resources/native/macos/ShioriComputerUseHelper ",
      ),
    ).toEqual({
      kind: "helper",
      displayName: "ShioriComputerUseHelper",
      path: "/Applications/ShioriCode.app/Contents/Resources/native/macos/ShioriComputerUseHelper",
    });

    expect(computerUsePermissionSubjectForHelperPath(null)).toEqual({
      kind: "helper",
      displayName: "ShioriCode Computer Use helper",
      path: null,
    });
  });
});
