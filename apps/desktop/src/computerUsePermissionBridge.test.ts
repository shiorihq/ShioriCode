import { describe, expect, it } from "vitest";

import {
  computerUseHelperError,
  computerUsePermissionFailureResult,
  computerUsePermissionSubjectForHelperPath,
  normalizeComputerUsePermissionActionInput,
  parseComputerUseHelperOutput,
} from "./computerUsePermissionBridge";

describe("computerUsePermissionBridge", () => {
  it("normalizes permission action input for direct request and permiso guide calls", () => {
    expect(
      normalizeComputerUsePermissionActionInput({
        kind: "screen-recording",
        hostAppBundlePath: " /Applications/ShioriCode.app ",
        hostAppDisplayName: " ShioriCode ",
        durationSeconds: 12,
      }),
    ).toEqual({
      kind: "screen-recording",
      hostAppBundlePath: "/Applications/ShioriCode.app",
      hostAppDisplayName: "ShioriCode",
      durationSeconds: 12,
    });

    expect(normalizeComputerUsePermissionActionInput("screen-recording")).toEqual({
      kind: "screen-recording",
    });
    expect(normalizeComputerUsePermissionActionInput("accessibility")).toEqual({
      kind: "accessibility",
    });
  });

  it("rejects unsupported permission kinds instead of falling back to accessibility", () => {
    expect(() => normalizeComputerUsePermissionActionInput("unknown")).toThrow(
      "Unsupported Computer Use permission kind 'unknown'. Expected 'accessibility' or 'screen-recording'.",
    );
    expect(() => normalizeComputerUsePermissionActionInput({ kind: "camera" })).toThrow(
      "Unsupported Computer Use permission kind 'camera'. Expected 'accessibility' or 'screen-recording'.",
    );
    expect(() => normalizeComputerUsePermissionActionInput({})).toThrow(
      "Unsupported Computer Use permission kind. Expected 'accessibility' or 'screen-recording'.",
    );
  });

  it("parses helper JSON even when native frameworks emit extra stdout lines", () => {
    expect(
      parseComputerUseHelperOutput<{ ok: boolean; kind: string }>(
        ["objc[123]: Class Foo is implemented in both", '{"ok":true,"kind":"accessibility"}'].join(
          "\n",
        ),
      ),
    ).toEqual({
      ok: true,
      kind: "accessibility",
    });
  });

  it("identifies the helper as the macOS permission subject on desktop failures", () => {
    expect(
      computerUsePermissionSubjectForHelperPath(
        "/Applications/ShioriCode.app/Contents/Resources/native/macos/ShioriComputerUseHelper",
      ),
    ).toEqual({
      kind: "helper",
      displayName: "ShioriComputerUseHelper",
      path: "/Applications/ShioriCode.app/Contents/Resources/native/macos/ShioriComputerUseHelper",
    });

    expect(
      computerUsePermissionFailureResult({
        kind: "accessibility",
        helperPath: "/tmp/ShioriComputerUseHelper",
        message: "The macOS Computer Use helper is unavailable.",
      }),
    ).toEqual({
      ok: false,
      kind: "accessibility",
      permissionSubject: {
        kind: "helper",
        displayName: "ShioriComputerUseHelper",
        path: "/tmp/ShioriComputerUseHelper",
      },
      message: "The macOS Computer Use helper is unavailable.",
    });
  });

  it("uses structured helper errors from noisy stdout or stderr", () => {
    expect(
      computerUseHelperError({
        stdout: 'native warning\n{"code":"permissionDenied","error":"Needs Screen Recording."}',
        stderr: "",
        code: 1,
        timedOut: false,
      }).message,
    ).toBe("Needs Screen Recording.");

    expect(
      computerUseHelperError({
        stdout: "",
        stderr: 'native warning\n{"code":"actionFailed","error":"Guide failed."}',
        code: 1,
        timedOut: false,
      }).message,
    ).toBe("Guide failed.");
  });

  it("reports timeouts before generic helper failures", () => {
    expect(
      computerUseHelperError({
        stdout: "",
        stderr: "",
        code: null,
        timedOut: true,
      }).message,
    ).toBe("Computer Use helper timed out.");
  });
});
