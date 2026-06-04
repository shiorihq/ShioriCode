import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  ComputerUseActionResult,
  ComputerUseAppStateResult,
  ComputerUseDoubleClickInput,
  ComputerUseDragInput,
  ComputerUseFocusAppInput,
  ComputerUseFocusWindowInput,
  ComputerUsePermissionActionResult,
  ComputerUsePermissionsSnapshot,
  ComputerUseRightClickInput,
  ComputerUseScreenshotResult,
  ComputerUseScrollInput,
  ComputerUseWaitInput,
} from "./computer";

const decodeFocusAppInput = Schema.decodeUnknownSync(ComputerUseFocusAppInput);
const decodeFocusWindowInput = Schema.decodeUnknownSync(ComputerUseFocusWindowInput);
const decodeDragInput = Schema.decodeUnknownSync(ComputerUseDragInput);
const decodeDoubleClickInput = Schema.decodeUnknownSync(ComputerUseDoubleClickInput);
const decodeRightClickInput = Schema.decodeUnknownSync(ComputerUseRightClickInput);
const decodeScrollInput = Schema.decodeUnknownSync(ComputerUseScrollInput);
const decodeWaitInput = Schema.decodeUnknownSync(ComputerUseWaitInput);
const decodeScreenshotResult = Schema.decodeUnknownSync(ComputerUseScreenshotResult);
const decodeActionResult = Schema.decodeUnknownSync(ComputerUseActionResult);
const decodeAppStateResult = Schema.decodeUnknownSync(ComputerUseAppStateResult);
const decodePermissionsSnapshot = Schema.decodeUnknownSync(ComputerUsePermissionsSnapshot);
const decodePermissionActionResult = Schema.decodeUnknownSync(ComputerUsePermissionActionResult);

describe("computer contracts", () => {
  it("requires a stable selector for focus-app inputs", () => {
    expect(decodeFocusAppInput({ bundleIdentifier: "com.apple.finder" })).toEqual({
      bundleIdentifier: "com.apple.finder",
    });
    expect(decodeFocusAppInput({ processIdentifier: 1234 })).toEqual({
      processIdentifier: 1234,
    });
    expect(decodeFocusAppInput({ name: "Finder" })).toEqual({ name: "Finder" });
  });

  it("rejects empty or ambiguous focus-app inputs", () => {
    expect(() => decodeFocusAppInput({})).toThrow();
    expect(() => decodeFocusAppInput({ bundleIdentifier: "   " })).toThrow();
    expect(() => decodeFocusAppInput({ name: "" })).toThrow();
    expect(() => decodeFocusAppInput({ processIdentifier: 12.5 })).toThrow();
  });

  it("allows focus-window inputs with app and window selectors", () => {
    expect(
      decodeFocusWindowInput({
        bundleIdentifier: "com.apple.Safari",
        windowIndex: 1,
      }),
    ).toEqual({
      bundleIdentifier: "com.apple.Safari",
      windowIndex: 1,
    });
    expect(
      decodeFocusWindowInput({
        processIdentifier: 1234,
        windowTitle: "Example Page",
      }),
    ).toEqual({
      processIdentifier: 1234,
      windowTitle: "Example Page",
    });
  });

  it("allows drag inputs with screenshot coordinate metadata", () => {
    expect(
      decodeDragInput({
        fromX: 10,
        fromY: 20,
        toX: 300,
        toY: 400,
        coordinateSpace: "screenshot",
        screenshotWidth: 1440,
        screenshotHeight: 900,
        durationMs: 650,
      }),
    ).toEqual({
      fromX: 10,
      fromY: 20,
      toX: 300,
      toY: 400,
      coordinateSpace: "screenshot",
      screenshotWidth: 1440,
      screenshotHeight: 900,
      durationMs: 650,
    });
  });

  it("allows double-click inputs with screenshot coordinate metadata", () => {
    expect(
      decodeDoubleClickInput({
        x: 10,
        y: 20,
        coordinateSpace: "screenshot",
        screenshotWidth: 1440,
        screenshotHeight: 900,
      }),
    ).toEqual({
      x: 10,
      y: 20,
      coordinateSpace: "screenshot",
      screenshotWidth: 1440,
      screenshotHeight: 900,
    });
  });

  it("allows right-click inputs with screenshot coordinate metadata", () => {
    expect(
      decodeRightClickInput({
        x: 40,
        y: 80,
        coordinateSpace: "screenshot",
        screenshotWidth: 1440,
        screenshotHeight: 900,
      }),
    ).toEqual({
      x: 40,
      y: 80,
      coordinateSpace: "screenshot",
      screenshotWidth: 1440,
      screenshotHeight: 900,
    });
  });

  it("allows scroll inputs with optional screenshot coordinate metadata", () => {
    expect(
      decodeScrollInput({
        x: 100,
        y: 200,
        coordinateSpace: "screenshot",
        screenshotWidth: 1440,
        screenshotHeight: 900,
        deltaY: -6,
      }),
    ).toEqual({
      x: 100,
      y: 200,
      coordinateSpace: "screenshot",
      screenshotWidth: 1440,
      screenshotHeight: 900,
      deltaY: -6,
    });

    expect(decodeScrollInput({ deltaY: 4 })).toEqual({ deltaY: 4 });
  });

  it("allows wait inputs with optional duration", () => {
    expect(decodeWaitInput({ durationMs: 1_500 })).toEqual({ durationMs: 1_500 });
    expect(decodeWaitInput({})).toEqual({});
  });

  it("allows permission snapshots and actions to identify the macOS permission subject", () => {
    const permissionSubject = {
      kind: "helper",
      displayName: "ShioriComputerUseHelper",
      path: "/Applications/ShioriCode.app/Contents/Resources/native/macos/ShioriComputerUseHelper",
    } as const;

    expect(
      decodePermissionsSnapshot({
        platform: "darwin",
        supported: true,
        helperAvailable: true,
        helperPath: permissionSubject.path,
        permissionSubject,
        permissions: [
          {
            kind: "accessibility",
            state: "granted",
            label: "Accessibility",
            detail: "The helper can post keyboard and pointer events.",
          },
        ],
        checkedAt: "2026-06-04T14:00:00.000Z",
        message: null,
      }),
    ).toMatchObject({
      permissionSubject,
    });

    expect(
      decodePermissionActionResult({
        ok: false,
        kind: "screen-recording",
        permissionSubject,
        message: "Screen Recording still needs to be enabled in System Settings.",
      }),
    ).toEqual({
      ok: false,
      kind: "screen-recording",
      permissionSubject,
      message: "Screen Recording still needs to be enabled in System Settings.",
    });
  });

  it("allows screenshots to include display and cursor coordinate metadata", () => {
    expect(
      decodeScreenshotResult({
        sessionId: "computer-1",
        imageDataUrl: "data:image/png;base64,abc",
        width: 2880,
        height: 1800,
        coordinateSpace: "screenshot",
        screenBounds: { x: 0, y: 0, width: 1440, height: 900 },
        cursorPosition: { x: 100, y: 200 },
        displays: [
          {
            id: 1,
            bounds: { x: 0, y: 0, width: 1440, height: 900 },
            screenshotBounds: { x: 0, y: 0, width: 2880, height: 1800 },
            pixelsWide: 2880,
            pixelsHigh: 1800,
            scaleX: 2,
            scaleY: 2,
            isMain: true,
          },
        ],
        capturedAt: "2026-06-04T14:00:00.000Z",
      }),
    ).toEqual({
      sessionId: "computer-1",
      imageDataUrl: "data:image/png;base64,abc",
      width: 2880,
      height: 1800,
      coordinateSpace: "screenshot",
      screenBounds: { x: 0, y: 0, width: 1440, height: 900 },
      cursorPosition: { x: 100, y: 200 },
      displays: [
        {
          id: 1,
          bounds: { x: 0, y: 0, width: 1440, height: 900 },
          screenshotBounds: { x: 0, y: 0, width: 2880, height: 1800 },
          pixelsWide: 2880,
          pixelsHigh: 1800,
          scaleX: 2,
          scaleY: 2,
          isMain: true,
        },
      ],
      capturedAt: "2026-06-04T14:00:00.000Z",
    });
  });

  it("allows app listings to declare approved-app filtering", () => {
    expect(
      decodeAppStateResult({
        sessionId: "computer-1",
        checkedAt: "2026-06-04T14:00:00.000Z",
        accessibilityTrusted: true,
        filteredByApprovedApps: true,
        apps: [
          {
            processIdentifier: 42,
            name: "Safari",
            bundleIdentifier: "com.apple.Safari",
            bundlePath: "/Applications/Safari.app",
            activationPolicy: "regular",
            isActive: true,
            isHidden: false,
            windows: [],
          },
        ],
      }),
    ).toEqual({
      sessionId: "computer-1",
      checkedAt: "2026-06-04T14:00:00.000Z",
      accessibilityTrusted: true,
      filteredByApprovedApps: true,
      apps: [
        {
          processIdentifier: 42,
          name: "Safari",
          bundleIdentifier: "com.apple.Safari",
          bundlePath: "/Applications/Safari.app",
          activationPolicy: "regular",
          isActive: true,
          isHidden: false,
          windows: [],
        },
      ],
    });
  });

  it("allows focus actions to include focused app context", () => {
    expect(
      decodeActionResult({
        sessionId: "computer-1",
        ok: true,
        message: "Focused Safari.",
        cursorScreenPosition: { x: 120, y: 240 },
        focusedApp: {
          processIdentifier: 42,
          name: "Safari",
          bundleIdentifier: "com.apple.Safari",
          bundlePath: "/Applications/Safari.app",
          activationPolicy: "regular",
          isActive: true,
          isHidden: false,
          windows: [{ index: 0, title: "Example Page", bounds: null }],
        },
        focusedWindow: { index: 0, title: "Example Page", bounds: null },
      }),
    ).toEqual({
      sessionId: "computer-1",
      ok: true,
      message: "Focused Safari.",
      cursorScreenPosition: { x: 120, y: 240 },
      focusedApp: {
        processIdentifier: 42,
        name: "Safari",
        bundleIdentifier: "com.apple.Safari",
        bundlePath: "/Applications/Safari.app",
        activationPolicy: "regular",
        isActive: true,
        isHidden: false,
        windows: [{ index: 0, title: "Example Page", bounds: null }],
      },
      focusedWindow: { index: 0, title: "Example Page", bounds: null },
    });
  });

  it("allows desktop actions to include active app context", () => {
    expect(
      decodeActionResult({
        sessionId: "computer-1",
        ok: true,
        message: "Clicked.",
        activeApp: {
          processIdentifier: 42,
          name: "Safari",
          bundleIdentifier: "com.apple.Safari",
          bundlePath: "/Applications/Safari.app",
          activationPolicy: "regular",
          isActive: true,
          isHidden: false,
          windows: [{ title: "Example Page", bounds: null }],
        },
      }),
    ).toEqual({
      sessionId: "computer-1",
      ok: true,
      message: "Clicked.",
      activeApp: {
        processIdentifier: 42,
        name: "Safari",
        bundleIdentifier: "com.apple.Safari",
        bundlePath: "/Applications/Safari.app",
        activationPolicy: "regular",
        isActive: true,
        isHidden: false,
        windows: [{ title: "Example Page", bounds: null }],
      },
    });
  });
});
