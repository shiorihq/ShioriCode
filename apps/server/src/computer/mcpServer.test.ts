import { afterEach, describe, expect, it } from "vitest";

import { helperCommandForTool, toolResultContent, toolSchemas } from "./mcpServer.ts";

const ORIGINAL_REQUIRE_APPROVAL = process.env.SHIORICODE_COMPUTER_USE_REQUIRE_APPROVAL;

afterEach(() => {
  process.env.SHIORICODE_COMPUTER_USE_REQUIRE_APPROVAL = ORIGINAL_REQUIRE_APPROVAL;
});

describe("computerUseMcpServer", () => {
  it("exposes a permissions tool that does not require desktop-action approval metadata", () => {
    process.env.SHIORICODE_COMPUTER_USE_REQUIRE_APPROVAL = "1";

    const tools = toolSchemas();
    const permissions = tools.find((tool) => tool.name === "computer_permissions");
    const screenshot = tools.find((tool) => tool.name === "computer_screenshot");
    const click = tools.find((tool) => tool.name === "computer_click");
    const move = tools.find((tool) => tool.name === "computer_move");

    expect(permissions?.inputSchema["x-shioricode-needs-approval"]).toBeUndefined();
    expect(screenshot?.inputSchema["x-shioricode-needs-approval"]).toBe(true);
    expect(screenshot?.inputSchema["x-shioricode-request-kind"]).toBe("computer-use");
    expect(click?.inputSchema["x-shioricode-request-kind"]).toBe("computer-use");
    expect(move?.description).toContain("screenshot pixel coordinates");
    expect(click?.inputSchema).toMatchObject({
      properties: {
        coordinateSpace: { type: "string", enum: ["screenshot", "screen"] },
        screenshotWidth: { type: "number" },
        screenshotHeight: { type: "number" },
      },
    });
    expect(helperCommandForTool("computer_permissions")).toBe("permissions");
  });

  it("tells the agent to use screenshot pixel coordinates for screenshots", () => {
    expect(
      toolResultContent({
        imageDataUrl: "data:image/png;base64,abc",
        width: 1440,
        height: 900,
      }),
    ).toEqual({
      content: [
        {
          type: "text",
          text: "Captured desktop screenshot (1440x900). Use screenshot pixel coordinates with computer_click and computer_move.",
        },
        {
          type: "image",
          mimeType: "image/png",
          data: "abc",
        },
      ],
    });
  });

  it("returns structured permission snapshots as readable MCP text", () => {
    expect(
      toolResultContent({
        platform: "darwin",
        supported: true,
        permissions: [{ kind: "accessibility", state: "granted" }],
      }),
    ).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              platform: "darwin",
              supported: true,
              permissions: [{ kind: "accessibility", state: "granted" }],
            },
            null,
            2,
          ),
        },
      ],
    });
  });
});
