import { describe, expect, it } from "vitest";

import {
  enrichScreenshotCoordinateInput,
  screenshotSizeFromResult,
  screenshotSizeSessionId,
} from "./screenshotCoordinates";

describe("screenshotCoordinates", () => {
  it("extracts a positive screenshot size and session id from helper results", () => {
    expect(
      screenshotSizeFromResult({
        sessionId: "computer-session",
        width: 1440,
        height: 900,
      }),
    ).toEqual({
      sessionId: "computer-session",
      size: { width: 1440, height: 900 },
    });
  });

  it("uses the fallback session id when helper results omit one", () => {
    expect(screenshotSizeFromResult({ width: 2880, height: 1800 }, "native-session")).toEqual({
      sessionId: "native-session",
      size: { width: 2880, height: 1800 },
    });
  });

  it("ignores invalid screenshot sizes", () => {
    expect(screenshotSizeFromResult({ sessionId: "computer-session", width: 0, height: 900 })).toBe(
      null,
    );
    expect(screenshotSizeFromResult({ sessionId: "computer-session", width: 1440 })).toBe(null);
  });

  it("fills missing screenshot dimensions from the latest size", () => {
    expect(
      enrichScreenshotCoordinateInput(
        {
          x: 10,
          y: 20,
          screenshotWidth: 1200,
        },
        { width: 1440, height: 900 },
      ),
    ).toEqual({
      x: 10,
      y: 20,
      screenshotWidth: 1200,
      screenshotHeight: 900,
    });
  });

  it("leaves screen-coordinate inputs unchanged", () => {
    const input = { x: 10, y: 20, coordinateSpace: "screen" };

    expect(enrichScreenshotCoordinateInput(input, { width: 1440, height: 900 })).toBe(input);
  });

  it("leaves inputs without coordinates unchanged", () => {
    const input = { deltaY: -8 };

    expect(enrichScreenshotCoordinateInput(input, { width: 1440, height: 900 })).toBe(input);
  });

  it("defaults missing session ids for MCP-sized caches", () => {
    expect(screenshotSizeSessionId({ x: 10, y: 20 })).toBe("computer-default");
  });
});
