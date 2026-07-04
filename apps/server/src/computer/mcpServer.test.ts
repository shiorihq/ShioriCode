import { afterEach, describe, expect, it } from "vitest";

import {
  clearLatestScreenshotSizesForTests,
  closeComputerUseMcpSession,
  createComputerUseMcpSession,
  enrichComputerActionInputWithLatestScreenshotSize,
  enrichComputerPermissionInput,
  helperInputForComputerTool,
  helperCommandForTool,
  rememberLatestScreenshotSize,
  toolResultContent,
  toolSchemas,
} from "./mcpServer.ts";

const ORIGINAL_HOST_APP_BUNDLE_PATH = process.env.SHIORICODE_COMPUTER_USE_HOST_APP_BUNDLE_PATH;
const ORIGINAL_HOST_APP_DISPLAY_NAME = process.env.SHIORICODE_COMPUTER_USE_HOST_APP_DISPLAY_NAME;

afterEach(() => {
  clearLatestScreenshotSizesForTests();
  if (ORIGINAL_HOST_APP_BUNDLE_PATH === undefined) {
    delete process.env.SHIORICODE_COMPUTER_USE_HOST_APP_BUNDLE_PATH;
  } else {
    process.env.SHIORICODE_COMPUTER_USE_HOST_APP_BUNDLE_PATH = ORIGINAL_HOST_APP_BUNDLE_PATH;
  }
  if (ORIGINAL_HOST_APP_DISPLAY_NAME === undefined) {
    delete process.env.SHIORICODE_COMPUTER_USE_HOST_APP_DISPLAY_NAME;
  } else {
    process.env.SHIORICODE_COMPUTER_USE_HOST_APP_DISPLAY_NAME = ORIGINAL_HOST_APP_DISPLAY_NAME;
  }
});

describe("computerUseMcpServer", () => {
  it("exposes the Shiori Computer Use provider tool surface", () => {
    const tools = toolSchemas();
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_apps",
      "get_app_state",
      "click",
      "perform_secondary_action",
      "set_value",
      "select_text",
      "scroll",
      "drag",
      "press_key",
      "type_text",
    ]);

    const listApps = tools.find((tool) => tool.name === "list_apps");
    const getAppState = tools.find((tool) => tool.name === "get_app_state");
    const click = tools.find((tool) => tool.name === "click");
    const secondaryAction = tools.find((tool) => tool.name === "perform_secondary_action");
    const setValue = tools.find((tool) => tool.name === "set_value");
    const selectText = tools.find((tool) => tool.name === "select_text");
    const scroll = tools.find((tool) => tool.name === "scroll");
    const drag = tools.find((tool) => tool.name === "drag");
    const pressKey = tools.find((tool) => tool.name === "press_key");
    const typeText = tools.find((tool) => tool.name === "type_text");

    expect(listApps?.inputSchema).toMatchObject({
      properties: {},
      required: [],
      additionalProperties: false,
    });
    expect(getAppState?.description).toContain("called once per assistant turn");
    expect(getAppState?.inputSchema).toMatchObject({
      properties: {
        app: { type: "string" },
      },
      required: ["app"],
      additionalProperties: false,
    });
    expect(click?.inputSchema).toMatchObject({
      properties: {
        app: { type: "string" },
        element_index: { type: ["string", "null"] },
        x: { type: ["number", "null"] },
        y: { type: ["number", "null"] },
        mouse_button: { type: ["string", "null"], enum: ["left", "right", "middle", null] },
        click_count: { type: ["integer", "null"] },
      },
      required: ["app", "element_index", "x", "y", "mouse_button", "click_count"],
      additionalProperties: false,
    });
    expect(secondaryAction?.inputSchema).toMatchObject({
      required: ["app", "element_index", "action"],
    });
    expect(setValue?.inputSchema).toMatchObject({
      required: ["app", "element_index", "value"],
    });
    expect(selectText?.inputSchema).toMatchObject({
      required: ["app", "element_index", "text", "prefix", "suffix", "selection"],
    });
    expect(scroll?.inputSchema).toMatchObject({
      properties: {
        app: { type: "string" },
        element_index: { type: "string" },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        pages: { type: ["number", "null"] },
      },
      required: ["app", "element_index", "direction", "pages"],
    });
    expect(drag?.inputSchema).toMatchObject({
      required: ["app", "from_x", "from_y", "to_x", "to_y"],
    });
    expect(pressKey?.inputSchema).toMatchObject({
      required: ["app", "key"],
    });
    expect(typeText?.inputSchema).toMatchObject({
      required: ["app", "text"],
    });
    expect(helperCommandForTool("list_apps")).toBe("bcu-list-apps");
    expect(helperCommandForTool("get_app_state")).toBe("bcu-get-window-state");
    expect(helperCommandForTool("click")).toBe("bcu-click");
    expect(helperCommandForTool("perform_secondary_action")).toBe("bcu-perform-secondary-action");
    expect(helperCommandForTool("set_value")).toBe("bcu-set-value");
    expect(helperCommandForTool("scroll")).toBe("bcu-scroll");
    expect(helperCommandForTool("press_key")).toBe("bcu-press-key");
    expect(helperCommandForTool("type_text")).toBe("bcu-type-text");
    expect(() => helperCommandForTool("select_text")).toThrow(
      "Shiori Computer Use does not expose a native select_text helper command yet.",
    );
    expect(() => helperCommandForTool("drag")).toThrow(
      "Shiori Computer Use does not expose a native point-to-point drag helper command yet.",
    );
    expect(helperCommandForTool("computer_permissions")).toBe("permissions");
    expect(helperCommandForTool("computer_request_permission")).toBe("request-permission");
    expect(helperCommandForTool("computer_open_permission_guide")).toBe("permission-guide");
    expect(helperCommandForTool("computer_list_apps")).toBe("list-apps");
    expect(helperCommandForTool("computer_focus_app")).toBe("focus-app");
    expect(helperCommandForTool("computer_focus_window")).toBe("focus-window");
    expect(helperCommandForTool("computer_double_click")).toBe("click");
    expect(helperCommandForTool("computer_right_click")).toBe("click");
    expect(helperCommandForTool("computer_drag")).toBe("drag");
    expect(helperCommandForTool("computer_wait")).toBe("wait");
  });

  it("creates readable scoped Computer Use MCP sessions", () => {
    const result = createComputerUseMcpSession();

    expect(result).toMatchObject({
      kind: "macos-desktop",
    });
    expect(typeof result.id).toBe("string");
    expect(String(result.id)).toMatch(/^computer-/);

    expect(toolResultContent(result)).toEqual({
      content: [
        {
          type: "text",
          text: expect.stringContaining(
            "Pass this sessionId to screenshots and desktop actions to keep screenshot-coordinate state scoped to this workflow.",
          ),
        },
      ],
    });
  });

  it("closes scoped Computer Use MCP sessions and clears screenshot-coordinate state", () => {
    const session = createComputerUseMcpSession();
    const sessionId = String(session.id);

    rememberLatestScreenshotSize({
      sessionId,
      width: 2880,
      height: 1800,
    });

    expect(
      enrichComputerActionInputWithLatestScreenshotSize("computer_click", {
        sessionId,
        x: 100,
        y: 50,
      }),
    ).toEqual({
      sessionId,
      x: 100,
      y: 50,
      screenshotWidth: 2880,
      screenshotHeight: 1800,
    });

    expect(closeComputerUseMcpSession({ sessionId })).toEqual({
      sessionId,
      ok: true,
      message: "Computer Use session closed.",
    });

    const actionInput = {
      sessionId,
      x: 100,
      y: 50,
    };
    expect(enrichComputerActionInputWithLatestScreenshotSize("computer_click", actionInput)).toBe(
      actionInput,
    );
  });

  it("rejects stale Computer Use MCP session close requests", () => {
    expect(() => closeComputerUseMcpSession({ sessionId: "computer-missing" })).toThrow(
      "Computer Use session 'computer-missing' does not exist.",
    );
  });

  it("adds desktop host app identity to permiso permission guide inputs", () => {
    process.env.SHIORICODE_COMPUTER_USE_HOST_APP_BUNDLE_PATH = "/Applications/ShioriCode.app";
    process.env.SHIORICODE_COMPUTER_USE_HOST_APP_DISPLAY_NAME = "ShioriCode";

    expect(
      enrichComputerPermissionInput("computer_open_permission_guide", {
        kind: "accessibility",
      }),
    ).toEqual({
      kind: "accessibility",
      hostAppBundlePath: "/Applications/ShioriCode.app",
      hostAppDisplayName: "ShioriCode",
    });
    expect(
      enrichComputerPermissionInput("computer_open_permission_guide", {
        kind: "screen-recording",
        hostAppBundlePath: "/Applications/Custom.app",
        hostAppDisplayName: "Custom",
      }),
    ).toEqual({
      kind: "screen-recording",
      hostAppBundlePath: "/Applications/Custom.app",
      hostAppDisplayName: "Custom",
    });
    expect(
      enrichComputerPermissionInput("computer_request_permission", {
        kind: "accessibility",
      }),
    ).toEqual({
      kind: "accessibility",
    });
  });

  it("tells the agent to use screenshot pixel coordinates for screenshots", () => {
    expect(
      toolResultContent({
        imageDataUrl: "data:image/png;base64,abc",
        width: 1440,
        height: 900,
        cursorPosition: { x: 120, y: 240 },
        screenBounds: { x: 0, y: 0, width: 720, height: 450 },
        displays: [
          {
            id: 1,
            bounds: { x: 0, y: 0, width: 720, height: 450 },
            screenshotBounds: { x: 0, y: 0, width: 1440, height: 900 },
            pixelsWide: 1440,
            pixelsHigh: 900,
            scaleX: 2,
            scaleY: 2,
            isMain: true,
          },
        ],
      }),
    ).toEqual({
      content: [
        {
          type: "text",
          text: [
            "Captured desktop screenshot (1440x900). Use screenshot pixel coordinates with computer_click, computer_double_click, computer_right_click, computer_move, computer_drag, and targeted computer_scroll.",
            "Cursor position: 120,240 in screenshot pixels.",
            "Virtual screen bounds: 720x450 at 0,0 in macOS points.",
            "Displays: 1.",
            "Display 1: screenshot 1440x900 at 0,0 screen 720x450 at 0,0, scale 2x2.",
          ].join("\n"),
        },
        {
          type: "image",
          mimeType: "image/png",
          data: "abc",
        },
      ],
    });
  });

  it("returns BackgroundComputerUse app state as rendered tree text plus screenshot content", () => {
    expect(
      toolResultContent({
        stateToken: "state-123",
        window: {
          windowID: "window-1",
          title: "Example Page",
          bundleID: "app.example",
          pid: 42,
          frameAppKit: { x: 10, y: 20, width: 800, height: 600 },
        },
        screenshot: {
          status: "ok",
          image: {
            imageBase64: "abc",
            mimeType: "image/png",
            pixelWidth: 1600,
            pixelHeight: 1200,
          },
        },
        tree: {
          nodeCount: 2,
          truncated: false,
          renderedText: '[1] button "Play"\n[2] text "Now playing"',
        },
        focusedElement: {
          index: 1,
          displayRole: "button",
          title: "Play",
        },
        notes: ["Background read preserved frontmost app."],
      }),
    ).toEqual({
      content: [
        {
          type: "text",
          text: [
            "Shiori Computer Use app state.",
            "Window: Example Page | app.example | pid 42 | window window-1 | 800x600 at 10,20.",
            "State token: state-123.",
            "Screenshot: 1600x1200 window pixels.",
            "Accessibility tree: 2 nodes.",
            "Focused element: index 1 | button | Play.",
            "Use element_index values from the rendered tree for click, scroll, set_value, type_text, and perform_secondary_action. Call get_app_state again after meaningful UI changes.",
            "Notes:\n- Background read preserved frontmost app.",
            "Rendered accessibility tree:",
            '[1] button "Play"\n[2] text "Now playing"',
          ].join("\n"),
        },
        {
          type: "image",
          data: "abc",
          mimeType: "image/png",
        },
      ],
    });
  });

  it("reuses the latest default screenshot size for screenshot-coordinate actions", () => {
    rememberLatestScreenshotSize({
      sessionId: "computer-default",
      width: 2880,
      height: 1800,
    });

    expect(
      enrichComputerActionInputWithLatestScreenshotSize("computer_click", { x: 100, y: 50 }),
    ).toEqual({
      x: 100,
      y: 50,
      screenshotWidth: 2880,
      screenshotHeight: 1800,
    });
  });

  it("reuses the latest screenshot size for double-click actions", () => {
    rememberLatestScreenshotSize({
      sessionId: "computer-default",
      width: 2880,
      height: 1800,
    });

    expect(
      enrichComputerActionInputWithLatestScreenshotSize("computer_double_click", {
        x: 100,
        y: 50,
      }),
    ).toEqual({
      x: 100,
      y: 50,
      screenshotWidth: 2880,
      screenshotHeight: 1800,
    });
  });

  it("executes double-click through the click helper with a fixed click count", () => {
    expect(helperInputForComputerTool("computer_double_click", { x: 100, y: 50 })).toEqual({
      x: 100,
      y: 50,
      clickCount: 2,
    });
    expect(helperInputForComputerTool("computer_click", { x: 100, y: 50 })).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("executes right-click through the click helper with a fixed right button", () => {
    expect(helperInputForComputerTool("computer_right_click", { x: 100, y: 50 })).toEqual({
      x: 100,
      y: 50,
      button: "right",
    });
  });

  it("strips provider-schema null placeholders before helper actions", () => {
    expect(
      helperInputForComputerTool("computer_focus_app", {
        sessionId: null,
        bundleIdentifier: "com.apple.finder",
        processIdentifier: null,
        name: null,
      }),
    ).toEqual({
      bundleIdentifier: "com.apple.finder",
    });
  });

  it("keeps latest screenshot sizes isolated by session", () => {
    rememberLatestScreenshotSize({
      sessionId: "session-a",
      width: 1200,
      height: 800,
    });
    rememberLatestScreenshotSize({
      sessionId: "session-b",
      width: 2400,
      height: 1600,
    });

    expect(
      enrichComputerActionInputWithLatestScreenshotSize("computer_move", {
        sessionId: "session-b",
        x: 10,
        y: 20,
      }),
    ).toEqual({
      sessionId: "session-b",
      x: 10,
      y: 20,
      screenshotWidth: 2400,
      screenshotHeight: 1600,
    });
  });

  it("reuses the latest screenshot size for drag actions", () => {
    rememberLatestScreenshotSize({
      sessionId: "computer-default",
      width: 1440,
      height: 900,
    });

    expect(
      enrichComputerActionInputWithLatestScreenshotSize("computer_drag", {
        fromX: 10,
        fromY: 20,
        toX: 300,
        toY: 400,
      }),
    ).toEqual({
      fromX: 10,
      fromY: 20,
      toX: 300,
      toY: 400,
      screenshotWidth: 1440,
      screenshotHeight: 900,
    });
  });

  it("reuses the latest screenshot size for targeted scroll actions", () => {
    rememberLatestScreenshotSize({
      sessionId: "computer-default",
      width: 1440,
      height: 900,
    });

    expect(
      enrichComputerActionInputWithLatestScreenshotSize("computer_scroll", {
        x: 80,
        y: 160,
        deltaY: -8,
      }),
    ).toEqual({
      x: 80,
      y: 160,
      deltaY: -8,
      screenshotWidth: 1440,
      screenshotHeight: 900,
    });
  });

  it("does not alter delta-only scroll actions", () => {
    rememberLatestScreenshotSize({
      sessionId: "computer-default",
      width: 1440,
      height: 900,
    });

    const input = { deltaY: -8 };

    expect(enrichComputerActionInputWithLatestScreenshotSize("computer_scroll", input)).toBe(input);
  });

  it("does not alter explicit screen-coordinate drag actions", () => {
    rememberLatestScreenshotSize({
      sessionId: "computer-default",
      width: 1440,
      height: 900,
    });

    const input = {
      fromX: 10,
      fromY: 20,
      toX: 300,
      toY: 400,
      coordinateSpace: "screen",
    };

    expect(enrichComputerActionInputWithLatestScreenshotSize("computer_drag", input)).toBe(input);
  });

  it("does not alter explicit screen-coordinate actions", () => {
    rememberLatestScreenshotSize({
      sessionId: "computer-default",
      width: 2880,
      height: 1800,
    });

    const input = { x: 100, y: 50, coordinateSpace: "screen" };

    expect(enrichComputerActionInputWithLatestScreenshotSize("computer_click", input)).toBe(input);
  });

  it("returns structured permission snapshots as readable MCP text", () => {
    expect(
      toolResultContent({
        platform: "darwin",
        supported: true,
        checkedAt: "2026-06-04T14:00:00.000Z",
        permissionSubject: {
          kind: "helper",
          displayName: "ShioriComputerUseHelper",
          path: "/Applications/ShioriCode.app/Contents/Resources/native/macos/ShioriComputerUseHelper",
        },
        permissions: [
          {
            kind: "accessibility",
            label: "Accessibility",
            state: "granted",
            detail: "The helper can post keyboard and pointer events.",
          },
        ],
      }),
    ).toEqual({
      content: [
        {
          type: "text",
          text: [
            "Computer Use permissions at 2026-06-04T14:00:00.000Z:",
            "Permission subject: ShioriComputerUseHelper.",
            "Permission subject path: /Applications/ShioriCode.app/Contents/Resources/native/macos/ShioriComputerUseHelper.",
            "- Accessibility: granted - The helper can post keyboard and pointer events.",
          ].join("\n"),
        },
      ],
    });
  });

  it("summarizes permission action results as readable MCP text", () => {
    expect(
      toolResultContent({
        ok: true,
        kind: "screen-recording",
        permissionSubject: {
          kind: "helper",
          displayName: "ShioriComputerUseHelper",
          path: "/tmp/ShioriComputerUseHelper",
        },
        message: "Opened System Settings.",
      }),
    ).toEqual({
      content: [
        {
          type: "text",
          text: [
            "Screen Recording permission request opened.",
            "Permission subject: ShioriComputerUseHelper.",
            "Permission subject path: /tmp/ShioriComputerUseHelper.",
            "Opened System Settings.",
          ].join("\n"),
        },
      ],
    });
  });

  it("summarizes app and window state as readable MCP text", () => {
    expect(
      toolResultContent({
        sessionId: "computer-1",
        checkedAt: "2026-06-04T14:00:00Z",
        accessibilityTrusted: true,
        apps: [
          {
            processIdentifier: 42,
            name: "Safari",
            bundleIdentifier: "com.apple.Safari",
            isActive: true,
            isHidden: false,
            windows: [
              {
                title: "Example Page",
                bounds: { x: 10, y: 20, width: 800, height: 600 },
              },
            ],
          },
        ],
      }),
    ).toEqual({
      content: [
        {
          type: "text",
          text: [
            "Visible macOS apps at 2026-06-04T14:00:00Z:",
            "1. Safari (active, com.apple.Safari, pid 42)",
            "    - Example Page (800x600 at 10,20)",
          ].join("\n"),
        },
      ],
    });
  });

  it("summarizes focused app context after focus actions", () => {
    expect(
      toolResultContent({
        sessionId: "computer-1",
        ok: true,
        message: "Focused Safari.",
        cursorScreenPosition: { x: 120, y: 240 },
        focusedApp: {
          processIdentifier: 42,
          name: "Safari",
          bundleIdentifier: "com.apple.Safari",
          isActive: true,
          isHidden: false,
          windows: [
            {
              title: "Example Page",
              bounds: { x: 10, y: 20, width: 800, height: 600 },
            },
          ],
        },
      }),
    ).toEqual({
      content: [
        {
          type: "text",
          text: [
            "Focused Safari.",
            "Cursor screen position: 120,240 in macOS points.",
            "Focused app:",
            "1. Safari (active, com.apple.Safari, pid 42)",
            "    - Example Page (800x600 at 10,20)",
          ].join("\n"),
        },
      ],
    });
  });

  it("summarizes focused window context after window focus actions", () => {
    expect(
      toolResultContent({
        sessionId: "computer-1",
        ok: true,
        message: "Focused window 'Example Page' in Safari.",
        cursorScreenPosition: { x: 120, y: 240 },
        focusedApp: {
          processIdentifier: 42,
          name: "Safari",
          bundleIdentifier: "com.apple.Safari",
          isActive: true,
          isHidden: false,
          windows: [
            {
              index: 0,
              title: "Example Page",
              bounds: { x: 10, y: 20, width: 800, height: 600 },
            },
          ],
        },
        focusedWindow: {
          index: 0,
          title: "Example Page",
          bounds: { x: 10, y: 20, width: 800, height: 600 },
        },
      }),
    ).toEqual({
      content: [
        {
          type: "text",
          text: [
            "Focused window 'Example Page' in Safari.",
            "Cursor screen position: 120,240 in macOS points.",
            "Focused app:",
            "1. Safari (active, com.apple.Safari, pid 42)",
            "    - [0] Example Page (800x600 at 10,20)",
            "Focused window:",
            "    - [0] Example Page (800x600 at 10,20)",
          ].join("\n"),
        },
      ],
    });
  });

  it("summarizes active app context after desktop actions", () => {
    expect(
      toolResultContent({
        sessionId: "computer-1",
        ok: true,
        message: "Clicked at 120, 240.",
        cursorScreenPosition: { x: 120, y: 240 },
        activeApp: {
          processIdentifier: 77,
          name: "Notes",
          bundleIdentifier: "com.apple.Notes",
          isActive: true,
          isHidden: false,
          windows: [
            {
              title: "Computer Use Notes",
              bounds: { x: 40, y: 80, width: 700, height: 500 },
            },
          ],
        },
      }),
    ).toEqual({
      content: [
        {
          type: "text",
          text: [
            "Clicked at 120, 240.",
            "Cursor screen position: 120,240 in macOS points.",
            "Active app after action:",
            "1. Notes (active, com.apple.Notes, pid 77)",
            "    - Computer Use Notes (700x500 at 40,80)",
          ].join("\n"),
        },
      ],
    });
  });
});
