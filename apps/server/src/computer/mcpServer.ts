import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import { runProcess } from "../processRunner";
import {
  computerUseHelperCandidatesFor,
  processResourcesPath,
  resolveAppRootFromModule,
} from "./helperResolver";
import { enrichComputerPermissionGuideInput } from "./permissionInput";
import {
  enrichScreenshotCoordinateInput,
  screenshotSizeFromResult,
  screenshotSizeSessionId,
  type ScreenshotSize,
} from "./screenshotCoordinates";

interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const SESSION_ID_PROPERTY = {
  sessionId: {
    type: "string",
    description:
      "Computer Use session id from computer_create_session. Omit to use the default desktop session.",
  },
} as const;

function withSessionProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    ...SESSION_ID_PROPERTY,
    ...properties,
  };
}

const TOOL_SCHEMAS: ReadonlyArray<ToolSchema> = [
  {
    name: "computer_create_session",
    description:
      "Computer Use: create a scoped macOS desktop session for screenshot-coordinate state. Use this before multi-step desktop workflows.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "computer_close_session",
    description:
      "Computer Use: close a scoped macOS desktop session and clear its remembered screenshot-coordinate state.",
    inputSchema: {
      type: "object",
      properties: SESSION_ID_PROPERTY,
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "computer_permissions",
    description:
      "Computer Use: inspect macOS support, helper availability, Accessibility, and Screen Recording permission state before using desktop tools.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "computer_request_permission",
    description:
      "Computer Use: ask macOS for a Computer Use permission directly. Use this only when computer_permissions reports a missing Accessibility or Screen Recording permission.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["accessibility", "screen-recording"] },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "computer_open_permission_guide",
    description:
      "Computer Use: open the ShioriCode permiso permission guide for Accessibility or Screen Recording when direct permission request is insufficient.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["accessibility", "screen-recording"] },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "computer_screenshot",
    description:
      "Computer Use: capture the current macOS desktop as a screenshot. Use this when the user asks for Computer Use or asks to inspect visible desktop/app state.",
    inputSchema: {
      type: "object",
      properties: SESSION_ID_PROPERTY,
      additionalProperties: false,
    },
  },
  {
    name: "computer_list_apps",
    description:
      "Computer Use: list running visible macOS apps and, when Accessibility is granted, their window titles and bounds. Use this before screenshot/click workflows when app context matters.",
    inputSchema: {
      type: "object",
      properties: SESSION_ID_PROPERTY,
      additionalProperties: false,
    },
  },
  {
    name: "computer_focus_app",
    description:
      "Computer Use: bring a running visible macOS app to the foreground before screenshot, typing, or clicking. Prefer bundleIdentifier or processIdentifier from computer_list_apps.",
    inputSchema: {
      type: "object",
      properties: withSessionProperties({
        bundleIdentifier: {
          type: "string",
          description: "Exact bundle identifier from computer_list_apps, such as com.apple.finder.",
        },
        processIdentifier: {
          type: "integer",
          description: "Exact process identifier from computer_list_apps.",
        },
        name: {
          type: "string",
          description: "Exact app display name from computer_list_apps. Use only when unambiguous.",
        },
      }),
      anyOf: [
        { required: ["bundleIdentifier"] },
        { required: ["processIdentifier"] },
        { required: ["name"] },
      ],
      additionalProperties: false,
    },
  },
  {
    name: "computer_focus_window",
    description:
      "Computer Use: bring a specific window in a running visible macOS app to the foreground before screenshot, typing, or clicking. Prefer bundleIdentifier plus windowIndex from computer_list_apps.",
    inputSchema: {
      type: "object",
      properties: withSessionProperties({
        bundleIdentifier: {
          type: "string",
          description: "Exact bundle identifier from computer_list_apps, such as com.apple.Safari.",
        },
        processIdentifier: {
          type: "integer",
          description: "Exact process identifier from computer_list_apps.",
        },
        name: {
          type: "string",
          description: "Exact app display name from computer_list_apps. Use only when unambiguous.",
        },
        windowIndex: {
          type: "integer",
          description:
            "Zero-based window index from the app's windows array in computer_list_apps. Defaults to 0.",
        },
        windowTitle: {
          type: "string",
          description:
            "Exact window title from computer_list_apps. Use only when the title is unambiguous.",
        },
      }),
      anyOf: [
        { required: ["bundleIdentifier"] },
        { required: ["processIdentifier"] },
        { required: ["name"] },
      ],
      additionalProperties: false,
    },
  },
  {
    name: "computer_click",
    description:
      "Computer Use: click a coordinate from the latest desktop screenshot. x/y default to screenshot pixel coordinates; set coordinateSpace to 'screen' only for raw macOS coordinates.",
    inputSchema: {
      type: "object",
      properties: withSessionProperties({
        x: { type: "number" },
        y: { type: "number" },
        coordinateSpace: { type: "string", enum: ["screenshot", "screen"] },
        screenshotWidth: {
          type: "number",
          description:
            "Width of the screenshot used to choose x/y. Defaults to the current display capture size.",
        },
        screenshotHeight: {
          type: "number",
          description:
            "Height of the screenshot used to choose x/y. Defaults to the current display capture size.",
        },
        button: { type: "string", enum: ["left", "right"] },
        clickCount: { type: "number" },
      }),
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "computer_double_click",
    description:
      "Computer Use: double-click a coordinate from the latest desktop screenshot. x/y default to screenshot pixel coordinates; set coordinateSpace to 'screen' only for raw macOS coordinates.",
    inputSchema: {
      type: "object",
      properties: withSessionProperties({
        x: { type: "number" },
        y: { type: "number" },
        coordinateSpace: { type: "string", enum: ["screenshot", "screen"] },
        screenshotWidth: {
          type: "number",
          description:
            "Width of the screenshot used to choose x/y. Defaults to the current display capture size.",
        },
        screenshotHeight: {
          type: "number",
          description:
            "Height of the screenshot used to choose x/y. Defaults to the current display capture size.",
        },
      }),
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "computer_right_click",
    description:
      "Computer Use: right-click a coordinate from the latest desktop screenshot. x/y default to screenshot pixel coordinates; set coordinateSpace to 'screen' only for raw macOS coordinates.",
    inputSchema: {
      type: "object",
      properties: withSessionProperties({
        x: { type: "number" },
        y: { type: "number" },
        coordinateSpace: { type: "string", enum: ["screenshot", "screen"] },
        screenshotWidth: {
          type: "number",
          description:
            "Width of the screenshot used to choose x/y. Defaults to the current display capture size.",
        },
        screenshotHeight: {
          type: "number",
          description:
            "Height of the screenshot used to choose x/y. Defaults to the current display capture size.",
        },
      }),
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "computer_move",
    description:
      "Computer Use: move the macOS pointer to a coordinate from the latest desktop screenshot. x/y default to screenshot pixel coordinates; set coordinateSpace to 'screen' only for raw macOS coordinates.",
    inputSchema: {
      type: "object",
      properties: withSessionProperties({
        x: { type: "number" },
        y: { type: "number" },
        coordinateSpace: { type: "string", enum: ["screenshot", "screen"] },
        screenshotWidth: {
          type: "number",
          description:
            "Width of the screenshot used to choose x/y. Defaults to the current display capture size.",
        },
        screenshotHeight: {
          type: "number",
          description:
            "Height of the screenshot used to choose x/y. Defaults to the current display capture size.",
        },
      }),
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "computer_drag",
    description:
      "Computer Use: drag from one coordinate to another on the macOS desktop. Coordinates default to screenshot pixels from the latest desktop screenshot; set coordinateSpace to 'screen' only for raw macOS coordinates.",
    inputSchema: {
      type: "object",
      properties: withSessionProperties({
        fromX: { type: "number" },
        fromY: { type: "number" },
        toX: { type: "number" },
        toY: { type: "number" },
        coordinateSpace: { type: "string", enum: ["screenshot", "screen"] },
        screenshotWidth: {
          type: "number",
          description:
            "Width of the screenshot used to choose coordinates. Defaults to the latest captured screenshot size.",
        },
        screenshotHeight: {
          type: "number",
          description:
            "Height of the screenshot used to choose coordinates. Defaults to the latest captured screenshot size.",
        },
        durationMs: {
          type: "number",
          description: "Approximate drag duration in milliseconds, clamped by the native helper.",
        },
      }),
      required: ["fromX", "fromY", "toX", "toY"],
      additionalProperties: false,
    },
  },
  {
    name: "computer_type",
    description: "Computer Use: type text into the currently focused macOS control.",
    inputSchema: {
      type: "object",
      properties: withSessionProperties({
        text: { type: "string" },
      }),
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "computer_key",
    description:
      "Computer Use: press a macOS key with optional command/control/option/shift modifiers.",
    inputSchema: {
      type: "object",
      properties: withSessionProperties({
        key: { type: "string" },
        modifiers: {
          type: "array",
          items: { type: "string", enum: ["command", "control", "option", "shift"] },
        },
      }),
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "computer_scroll",
    description:
      "Computer Use: scroll the macOS desktop by line deltas. When x/y are provided, move to that coordinate from the latest desktop screenshot before scrolling; set coordinateSpace to 'screen' only for raw macOS coordinates.",
    inputSchema: {
      type: "object",
      properties: withSessionProperties({
        x: { type: "number" },
        y: { type: "number" },
        coordinateSpace: { type: "string", enum: ["screenshot", "screen"] },
        screenshotWidth: {
          type: "number",
          description:
            "Width of the screenshot used to choose x/y. Defaults to the latest captured screenshot size.",
        },
        screenshotHeight: {
          type: "number",
          description:
            "Height of the screenshot used to choose x/y. Defaults to the latest captured screenshot size.",
        },
        deltaX: { type: "number" },
        deltaY: { type: "number" },
      }),
      additionalProperties: false,
    },
  },
  {
    name: "computer_wait",
    description:
      "Computer Use: wait for macOS desktop UI changes, animations, app launches, or page loads before taking the next screenshot.",
    inputSchema: {
      type: "object",
      properties: withSessionProperties({
        durationMs: {
          type: "number",
          description: "Wait duration in milliseconds, clamped by the native helper.",
        },
      }),
      additionalProperties: false,
    },
  },
] as const;

export function toolSchemas() {
  if (readBooleanEnv("SHIORICODE_COMPUTER_USE_REQUIRE_APPROVAL") !== true) {
    return TOOL_SCHEMAS;
  }
  const schemas: ToolSchema[] = [];
  for (const tool of TOOL_SCHEMAS) {
    if (
      tool.name === "computer_permissions" ||
      tool.name === "computer_create_session" ||
      tool.name === "computer_close_session" ||
      tool.name === "computer_request_permission" ||
      tool.name === "computer_open_permission_guide"
    ) {
      schemas.push(tool);
      continue;
    }
    schemas.push({
      name: tool.name,
      description: tool.description,
      inputSchema: Object.assign({}, tool.inputSchema, {
        "x-shioricode-request-kind": "computer-use",
        "x-shioricode-needs-approval": true,
      }),
    });
  }
  return schemas;
}

const HELPER_TIMEOUT_MS = 30_000;
const HELPER_STDOUT_LIMIT_BYTES = 32 * 1024 * 1024;

const appRoot = resolveAppRootFromModule(import.meta.url);

const latestScreenshotSizes = new Map<string, ScreenshotSize>();

const mcpSessions = new Map<
  string,
  {
    readonly id: string;
    readonly kind: "macos-desktop";
    readonly createdAt: string;
    readonly updatedAt: string;
  }
>();

function nowIso(): string {
  return new Date().toISOString();
}

function resolveHelperPath(): string {
  for (const candidate of computerUseHelperCandidatesFor({
    appRoot,
    configured: process.env.SHIORICODE_COMPUTER_USE_HELPER_BINARY ?? null,
    packagePath: process.env.SHIORICODE_COMPUTER_USE_HELPER_PACKAGE_PATH ?? null,
    resourcesPath: processResourcesPath(),
  })) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("The macOS Computer Use helper is unavailable.");
}

export function helperCommandForTool(toolName: string): string {
  switch (toolName) {
    case "computer_permissions":
      return "permissions";
    case "computer_request_permission":
      return "request-permission";
    case "computer_open_permission_guide":
      return "permission-guide";
    case "computer_screenshot":
      return "screenshot";
    case "computer_list_apps":
      return "list-apps";
    case "computer_focus_app":
      return "focus-app";
    case "computer_focus_window":
      return "focus-window";
    case "computer_click":
      return "click";
    case "computer_double_click":
      return "click";
    case "computer_right_click":
      return "click";
    case "computer_move":
      return "move";
    case "computer_drag":
      return "drag";
    case "computer_type":
      return "type";
    case "computer_key":
      return "key";
    case "computer_scroll":
      return "scroll";
    case "computer_wait":
      return "wait";
    default:
      throw new Error(`Unknown Computer Use tool '${toolName}'.`);
  }
}

function readBooleanEnv(name: string): boolean | null {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return null;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return null;
}

function approvedAppBundleIdsFromEnv(): ReadonlySet<string> | null {
  const raw = process.env.SHIORICODE_COMPUTER_USE_APPROVED_APP_BUNDLE_IDS?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Set(
        parsed.flatMap((entry) => {
          if (typeof entry !== "string") return [];
          const trimmed = entry.trim();
          return trimmed.length > 0 ? [trimmed] : [];
        }),
      );
    }
  } catch {
    // Fall back to comma-separated input below.
  }
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

const APPROVED_APP_SCOPED_TOOL_NAMES = new Set([
  "computer_screenshot",
  "computer_focus_app",
  "computer_focus_window",
  "computer_click",
  "computer_double_click",
  "computer_right_click",
  "computer_move",
  "computer_drag",
  "computer_type",
  "computer_key",
  "computer_scroll",
  "computer_wait",
]);

export function assertComputerToolAllowed(toolName: string, args: Record<string, unknown>): void {
  const approvedBundleIds = approvedAppBundleIdsFromEnv();
  if (approvedBundleIds === null || !APPROVED_APP_SCOPED_TOOL_NAMES.has(toolName)) {
    return;
  }
  if (approvedBundleIds.size === 0) {
    throw new Error(
      "No apps are approved for provider-facing Computer Use. Approve at least one app in Settings > Computer Use before using desktop screenshots or actions.",
    );
  }
  if (toolName !== "computer_focus_app" && toolName !== "computer_focus_window") {
    return;
  }

  const bundleIdentifier =
    typeof args.bundleIdentifier === "string" ? args.bundleIdentifier.trim() : "";
  if (!bundleIdentifier) {
    throw new Error(
      `${toolName} requires an approved bundleIdentifier. Call computer_list_apps and use an approved app bundle identifier.`,
    );
  }
  if (!approvedBundleIds.has(bundleIdentifier)) {
    throw new Error(
      `App '${bundleIdentifier}' is not approved for Computer Use. Approve it in Settings > Computer Use before focusing it.`,
    );
  }
}

function assertRuntimeAllowsComputerUse(): void {
  if (readBooleanEnv("SHIORICODE_COMPUTER_USE_ENABLED") === false) {
    throw new Error("Computer Use is disabled in ShioriCode settings.");
  }
}

export function enrichComputerPermissionInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName !== "computer_open_permission_guide") {
    return input;
  }
  return enrichComputerPermissionGuideInput(input);
}

function helperErrorMessage(result: {
  stdout: string;
  stderr: string;
  code: number | null;
}): string {
  const text = result.stdout.trim();
  const errorText = result.stderr.trim();
  try {
    const parsed = JSON.parse(text || errorText) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim();
    }
  } catch {
    // Use raw output below.
  }
  return errorText || text || `Computer Use helper failed with code ${result.code ?? "null"}.`;
}

async function runHelper(command: string, input: unknown): Promise<unknown> {
  assertRuntimeAllowsComputerUse();
  const result = await runProcess(resolveHelperPath(), [command], {
    stdin: JSON.stringify(input ?? {}),
    timeoutMs: HELPER_TIMEOUT_MS,
    allowNonZeroExit: true,
    maxBufferBytes: HELPER_STDOUT_LIMIT_BYTES,
    outputMode: "truncate",
  });
  if (result.code !== 0 || result.timedOut) {
    throw new Error(helperErrorMessage(result));
  }
  const text = result.stdout.trim();
  return text ? JSON.parse(text) : {};
}

export function filterAppStateForApprovedApps(
  result: unknown,
  approvedBundleIds = approvedAppBundleIdsFromEnv(),
): unknown {
  if (approvedBundleIds === null || !isRecord(result)) {
    return result;
  }
  if (!Array.isArray(result.apps)) {
    return result;
  }
  return {
    ...result,
    filteredByApprovedApps: true,
    apps: result.apps.filter((app) => {
      if (!isRecord(app)) return false;
      const bundleIdentifier = stringValue(app.bundleIdentifier);
      return bundleIdentifier ? approvedBundleIds.has(bundleIdentifier) : false;
    }),
  };
}

function imageContentFromDataUrl(imageDataUrl: string): { data: string; mimeType: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(imageDataUrl);
  return {
    mimeType: match?.[1] ?? "image/png",
    data: match?.[2] ?? imageDataUrl,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pointText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const x = numberValue(value.x);
  const y = numberValue(value.y);
  if (x === null || y === null) return null;
  return `${Math.round(x)},${Math.round(y)}`;
}

function boundsText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const x = numberValue(value.x);
  const y = numberValue(value.y);
  const width = numberValue(value.width);
  const height = numberValue(value.height);
  if (x === null || y === null || width === null || height === null) return null;
  return `${Math.round(width)}x${Math.round(height)} at ${Math.round(x)},${Math.round(y)}`;
}

export function clearLatestScreenshotSizesForTests(): void {
  latestScreenshotSizes.clear();
  mcpSessions.clear();
}

export function rememberLatestScreenshotSize(result: unknown): void {
  const remembered = screenshotSizeFromResult(result);
  if (remembered) latestScreenshotSizes.set(remembered.sessionId, remembered.size);
}

export function createComputerUseMcpSession(): Record<string, unknown> {
  const timestamp = nowIso();
  const id = `computer-${randomUUID()}`;
  const session = {
    id,
    kind: "macos-desktop" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  mcpSessions.set(id, session);
  return session;
}

export function closeComputerUseMcpSession(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const sessionId = stringValue(input.sessionId);
  if (!sessionId) {
    throw new Error("computer_close_session requires a sessionId.");
  }
  if (!mcpSessions.has(sessionId)) {
    throw new Error(`Computer Use session '${sessionId}' does not exist.`);
  }
  mcpSessions.delete(sessionId);
  latestScreenshotSizes.delete(sessionId);
  return {
    sessionId,
    ok: true,
    message: "Computer Use session closed.",
  };
}

export function enrichComputerActionInputWithLatestScreenshotSize(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (
    toolName !== "computer_click" &&
    toolName !== "computer_double_click" &&
    toolName !== "computer_right_click" &&
    toolName !== "computer_move" &&
    toolName !== "computer_drag" &&
    toolName !== "computer_scroll"
  ) {
    return input;
  }
  return enrichScreenshotCoordinateInput(
    input,
    latestScreenshotSizes.get(screenshotSizeSessionId(input)),
  );
}

export function helperInputForComputerTool(
  toolName: string,
  input: Record<string, unknown>,
  approvedBundleIds: ReadonlySet<string> | null = approvedAppBundleIdsFromEnv(),
): Record<string, unknown> {
  const approvedAppBundleIdentifiers = approvedBundleIds
    ? Array.from(approvedBundleIds)
    : undefined;
  const baseInput = approvedAppBundleIdentifiers
    ? { ...input, approvedAppBundleIdentifiers }
    : input;
  if (toolName === "computer_double_click") {
    return { ...baseInput, clickCount: 2 };
  }
  if (toolName === "computer_right_click") {
    return { ...baseInput, button: "right" };
  }
  return baseInput;
}

function appWindowLine(window: unknown): string | null {
  if (!isRecord(window)) return null;
  const index = numberValue(window.index);
  const title = stringValue(window.title);
  const bounds = boundsText(window.bounds);
  if (!title && !bounds) return null;
  const prefix = index === null ? "-" : `- [${Math.trunc(index)}]`;
  return `    ${prefix} ${title ?? "Untitled window"}${bounds ? ` (${bounds})` : ""}`;
}

function appSummaryLine(app: unknown, index: number): string | null {
  if (!isRecord(app)) return null;
  const name = stringValue(app.name);
  if (!name) return null;
  const pid = numberValue(app.processIdentifier);
  const bundleIdentifier = stringValue(app.bundleIdentifier);
  const states = [
    app.isActive === true ? "active" : null,
    app.isHidden === true ? "hidden" : null,
    bundleIdentifier,
    pid !== null ? `pid ${Math.trunc(pid)}` : null,
  ].filter((part): part is string => Boolean(part));
  const header = `${index + 1}. ${name}${states.length > 0 ? ` (${states.join(", ")})` : ""}`;
  const windows = Array.isArray(app.windows)
    ? app.windows.flatMap((window) => {
        const line = appWindowLine(window);
        return line ? [line] : [];
      })
    : [];
  const visibleWindows = windows.slice(0, 4);
  const hiddenWindowCount = windows.length - visibleWindows.length;
  return [
    header,
    ...visibleWindows,
    ...(hiddenWindowCount > 0 ? [`    - ${hiddenWindowCount} more windows hidden`] : []),
  ].join("\n");
}

function appStateText(result: Record<string, unknown>): string | null {
  if (!Array.isArray(result.apps)) return null;
  const apps = result.apps
    .flatMap((app, index) => {
      const line = appSummaryLine(app, index);
      return line ? [line] : [];
    })
    .slice(0, 16);
  const hiddenAppCount = result.apps.length - apps.length;
  const checkedAt = stringValue(result.checkedAt);
  const accessibilityTrusted =
    typeof result.accessibilityTrusted === "boolean" ? result.accessibilityTrusted : null;
  return [
    `Visible macOS apps${checkedAt ? ` at ${checkedAt}` : ""}:`,
    result.filteredByApprovedApps === true
      ? "Only apps approved in Computer Use settings are shown."
      : null,
    accessibilityTrusted === false
      ? "Accessibility is not granted, so window titles and bounds may be unavailable."
      : null,
    apps.length > 0 ? apps.join("\n") : "No visible apps were reported.",
    hiddenAppCount > 0 ? `${hiddenAppCount} more apps hidden.` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function focusedAppText(result: Record<string, unknown>): string | null {
  if (!isRecord(result.focusedApp)) {
    return null;
  }
  const summary = appSummaryLine(result.focusedApp, 0);
  if (!summary) {
    return null;
  }
  const message = stringValue(result.message);
  const cursor = pointText(result.cursorScreenPosition);
  return [
    message ?? "Focused macOS app.",
    cursor ? `Cursor screen position: ${cursor} in macOS points.` : null,
    "Focused app:",
    summary,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function focusedWindowText(result: Record<string, unknown>): string | null {
  if (!isRecord(result.focusedWindow)) {
    return null;
  }
  const windowLine = appWindowLine(result.focusedWindow);
  if (!windowLine) {
    return null;
  }
  const message = stringValue(result.message);
  const cursor = pointText(result.cursorScreenPosition);
  const appSummary = isRecord(result.focusedApp) ? appSummaryLine(result.focusedApp, 0) : null;
  return [
    message ?? "Focused macOS window.",
    cursor ? `Cursor screen position: ${cursor} in macOS points.` : null,
    appSummary ? "Focused app:" : null,
    appSummary,
    "Focused window:",
    windowLine,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function activeAppText(result: Record<string, unknown>): string | null {
  if (!isRecord(result.activeApp)) {
    return null;
  }
  const summary = appSummaryLine(result.activeApp, 0);
  if (!summary) {
    return null;
  }
  const message = stringValue(result.message);
  const cursor = pointText(result.cursorScreenPosition);
  return [
    message ?? "Computer Use action completed.",
    cursor ? `Cursor screen position: ${cursor} in macOS points.` : null,
    "Active app after action:",
    summary,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function permissionSubjectText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const displayName = stringValue(value.displayName);
  const path = stringValue(value.path);
  const kind = stringValue(value.kind);
  if (!displayName && !path) return null;
  return [
    `Permission subject: ${displayName ?? kind ?? "Computer Use helper"}.`,
    path ? `Permission subject path: ${path}.` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function permissionSnapshotText(result: Record<string, unknown>): string | null {
  if (!Array.isArray(result.permissions)) {
    return null;
  }
  const checkedAt = stringValue(result.checkedAt);
  const subject = permissionSubjectText(result.permissionSubject);
  const permissionLines = result.permissions.flatMap((permission) => {
    if (!isRecord(permission)) return [];
    const label = stringValue(permission.label) ?? stringValue(permission.kind);
    const state = stringValue(permission.state);
    const detail = stringValue(permission.detail);
    if (!label || !state) return [];
    return [`- ${label}: ${state}${detail ? ` - ${detail}` : ""}`];
  });
  return [
    `Computer Use permissions${checkedAt ? ` at ${checkedAt}` : ""}:`,
    subject,
    permissionLines.length > 0 ? permissionLines.join("\n") : "No permission states reported.",
    stringValue(result.message),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function permissionActionText(result: Record<string, unknown>): string | null {
  if (typeof result.ok !== "boolean") {
    return null;
  }
  const kind = stringValue(result.kind);
  if (kind !== "accessibility" && kind !== "screen-recording") {
    return null;
  }
  const permissionName = kind === "screen-recording" ? "Screen Recording" : "Accessibility";
  const message = stringValue(result.message);
  return [
    `${permissionName} permission ${result.ok ? "request opened" : "request failed"}.`,
    permissionSubjectText(result.permissionSubject),
    message,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function sessionSnapshotText(result: Record<string, unknown>): string | null {
  const id = stringValue(result.id);
  const kind = stringValue(result.kind);
  if (!id || kind !== "macos-desktop") {
    return null;
  }
  const createdAt = stringValue(result.createdAt);
  return [
    `Computer Use session created: ${id}.`,
    createdAt ? `Created at: ${createdAt}.` : null,
    "Pass this sessionId to screenshots and desktop actions to keep screenshot-coordinate state scoped to this workflow.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function displayContextLine(display: unknown, index: number): string | null {
  if (!isRecord(display)) return null;
  const screenshotBounds = boundsText(display.screenshotBounds);
  const screenBounds = boundsText(display.bounds);
  if (!screenshotBounds && !screenBounds) return null;
  const scaleX = numberValue(display.scaleX);
  const scaleY = numberValue(display.scaleY);
  const scale =
    scaleX !== null && scaleY !== null
      ? `, scale ${Number(scaleX.toFixed(2))}x${Number(scaleY.toFixed(2))}`
      : "";
  return (
    [
      `Display ${index + 1}:`,
      screenshotBounds ? `screenshot ${screenshotBounds}` : null,
      screenBounds ? `screen ${screenBounds}` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" ") + `${scale}.`
  );
}

function screenshotContextText(record: Record<string, unknown>): string {
  const width = record.width ?? "?";
  const height = record.height ?? "?";
  const cursor = pointText(record.cursorPosition);
  const screenBounds = boundsText(record.screenBounds);
  const displays = Array.isArray(record.displays) ? record.displays : [];
  const displayCount = displays.length;
  const displayLines = displays.slice(0, 4).flatMap((display, index) => {
    const line = displayContextLine(display, index);
    return line ? [line] : [];
  });
  return [
    `Captured desktop screenshot (${width}x${height}). Use screenshot pixel coordinates with computer_click, computer_double_click, computer_right_click, computer_move, computer_drag, and targeted computer_scroll.`,
    "The image may include the full visible desktop; approved-app settings limit allowed targets, not screenshot redaction.",
    cursor ? `Cursor position: ${cursor} in screenshot pixels.` : null,
    screenBounds ? `Virtual screen bounds: ${screenBounds} in macOS points.` : null,
    displayCount > 0 ? `Displays: ${displayCount}.` : null,
    ...displayLines,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function toolResultContent(result: unknown) {
  if (result && typeof result === "object" && "imageDataUrl" in result) {
    const record = result as { imageDataUrl?: unknown; width?: unknown; height?: unknown };
    const imageDataUrl = typeof record.imageDataUrl === "string" ? record.imageDataUrl : "";
    return {
      content: [
        {
          type: "text",
          text: screenshotContextText(record as Record<string, unknown>),
        },
        {
          type: "image",
          ...imageContentFromDataUrl(imageDataUrl),
        },
      ],
    };
  }
  if (isRecord(result) && "apps" in result) {
    return {
      content: [
        {
          type: "text",
          text: appStateText(result) ?? JSON.stringify(result, null, 2),
        },
      ],
    };
  }
  if (
    isRecord(result) &&
    ("focusedWindow" in result || "focusedApp" in result || "activeApp" in result)
  ) {
    return {
      content: [
        {
          type: "text",
          text:
            focusedWindowText(result) ??
            focusedAppText(result) ??
            activeAppText(result) ??
            JSON.stringify(result, null, 2),
        },
      ],
    };
  }
  if (isRecord(result) && "permissions" in result) {
    return {
      content: [
        {
          type: "text",
          text: permissionSnapshotText(result) ?? JSON.stringify(result, null, 2),
        },
      ],
    };
  }
  if (isRecord(result) && "ok" in result && "kind" in result) {
    return {
      content: [
        {
          type: "text",
          text: permissionActionText(result) ?? JSON.stringify(result, null, 2),
        },
      ],
    };
  }
  if (isRecord(result) && "id" in result && result.kind === "macos-desktop") {
    return {
      content: [
        {
          type: "text",
          text: sessionSnapshotText(result) ?? JSON.stringify(result, null, 2),
        },
      ],
    };
  }
  return {
    content: [
      {
        type: "text",
        text:
          result && typeof result === "object" && "message" in result
            ? String((result as { message?: unknown }).message ?? "Computer Use action completed.")
            : JSON.stringify(result ?? {}, null, 2),
      },
    ],
  };
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function success(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function failure(id: unknown, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

async function handleRequest(message: Record<string, unknown>): Promise<void> {
  const id = message.id;
  const method = message.method;
  try {
    switch (method) {
      case "initialize":
        success(id, {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "shioricode-computer-use", version: "0.1.0" },
        });
        return;
      case "tools/list":
        success(id, { tools: toolSchemas() });
        return;
      case "tools/call": {
        const params =
          message.params && typeof message.params === "object"
            ? (message.params as Record<string, unknown>)
            : {};
        const name = typeof params.name === "string" ? params.name : "";
        const args =
          params.arguments && typeof params.arguments === "object"
            ? (params.arguments as Record<string, unknown>)
            : {};
        if (name === "computer_create_session") {
          success(id, toolResultContent(createComputerUseMcpSession()));
          return;
        }
        if (name === "computer_close_session") {
          success(id, toolResultContent(closeComputerUseMcpSession(args)));
          return;
        }
        assertComputerToolAllowed(name, args);
        const helperInput = helperInputForComputerTool(
          name,
          enrichComputerPermissionInput(
            name,
            enrichComputerActionInputWithLatestScreenshotSize(name, args),
          ),
        );
        const result = filterAppStateForApprovedApps(
          await runHelper(helperCommandForTool(name), helperInput),
          name === "computer_list_apps" ? approvedAppBundleIdsFromEnv() : null,
        );
        if (name === "computer_screenshot") {
          rememberLatestScreenshotSize(result);
        }
        success(id, toolResultContent(result));
        return;
      }
      default:
        if (id !== undefined) {
          failure(id, new Error(`Unsupported MCP method '${String(method)}'.`));
        }
    }
  } catch (error) {
    failure(id, error);
  }
}

export async function runComputerUseMcpServer(): Promise<void> {
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      if ("id" in message) {
        void handleRequest(message);
      }
    } catch (error) {
      console.error(error);
    }
  }
}
