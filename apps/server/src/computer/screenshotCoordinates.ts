export interface ScreenshotSize {
  readonly width: number;
  readonly height: number;
}

export interface RememberedScreenshotSize {
  readonly sessionId: string;
  readonly size: ScreenshotSize;
}

const DEFAULT_COMPUTER_SESSION_ID = "computer-default";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasCoordinateFields(input: Record<string, unknown>): boolean {
  return (
    input.x !== undefined ||
    input.y !== undefined ||
    input.fromX !== undefined ||
    input.fromY !== undefined ||
    input.toX !== undefined ||
    input.toY !== undefined
  );
}

export function screenshotSizeSessionId(
  input: Record<string, unknown>,
  fallback = DEFAULT_COMPUTER_SESSION_ID,
): string {
  return stringValue(input.sessionId) ?? fallback;
}

export function screenshotSizeFromResult(
  result: unknown,
  fallbackSessionId = DEFAULT_COMPUTER_SESSION_ID,
): RememberedScreenshotSize | null {
  if (!isRecord(result)) {
    return null;
  }
  const width = numberValue(result.width);
  const height = numberValue(result.height);
  if (width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }
  return {
    sessionId: screenshotSizeSessionId(result, fallbackSessionId),
    size: { width, height },
  };
}

export function enrichScreenshotCoordinateInput(
  input: Record<string, unknown>,
  latestSize: ScreenshotSize | undefined,
): Record<string, unknown> {
  if (!hasCoordinateFields(input)) {
    return input;
  }
  const coordinateSpace = stringValue(input.coordinateSpace) ?? "screenshot";
  if (coordinateSpace !== "screenshot") {
    return input;
  }
  if (numberValue(input.screenshotWidth) !== null && numberValue(input.screenshotHeight) !== null) {
    return input;
  }
  if (!latestSize) {
    return input;
  }

  return {
    ...input,
    ...(numberValue(input.screenshotWidth) === null ? { screenshotWidth: latestSize.width } : {}),
    ...(numberValue(input.screenshotHeight) === null
      ? { screenshotHeight: latestSize.height }
      : {}),
  };
}
