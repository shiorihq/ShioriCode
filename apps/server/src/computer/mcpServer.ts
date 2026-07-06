import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import { runProcess } from "../processRunner";
import {
  computerUseHelperCandidatesFor,
  processResourcesPath,
  resolveAppRootFromModule,
} from "./helperResolver";
import { HelperServeClient, HelperServeUnsupportedError } from "./helperServeClient";
import { enrichComputerPermissionGuideInput } from "./permissionInput";
import { createPowerAssertion } from "./powerAssertion";
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

interface JsonSchemaProperty {
  readonly type?: string | ReadonlyArray<string>;
  readonly enum?: ReadonlyArray<unknown>;
  readonly [key: string]: unknown;
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

export const LEGACY_COMPUTER_TOOL_SCHEMAS: ReadonlyArray<ToolSchema> = [
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

const APP_PROPERTY = {
  app: {
    type: "string",
    description: "App name, full app path, or unambiguous bundle identifier.",
  },
} as const;

const ELEMENT_INDEX_PROPERTY = {
  element_index: {
    type: "string",
    description: "Accessibility element identifier from the latest get_app_state result.",
  },
} as const;

const SHIORI_COMPUTER_USE_TOOL_SCHEMAS: ReadonlyArray<ToolSchema> = [
  {
    name: "list_apps",
    description:
      "List apps on this computer. Returns currently running visible apps and their window metadata when Accessibility is available.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_app_state",
    description:
      "Start a Shiori Computer Use app session if needed, then get the state of the app's key window and return a screenshot plus available app/window context. This must be called once per assistant turn before interacting with the app.",
    inputSchema: {
      type: "object",
      properties: APP_PROPERTY,
      required: ["app"],
      additionalProperties: false,
    },
  },
  {
    name: "click",
    description: "Click an element by index or pixel coordinates from the latest screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        ...APP_PROPERTY,
        ...ELEMENT_INDEX_PROPERTY,
        x: { type: "number", description: "X coordinate in screenshot pixel coordinates." },
        y: { type: "number", description: "Y coordinate in screenshot pixel coordinates." },
        mouse_button: {
          type: "string",
          enum: ["left", "right", "middle"],
          description: "Mouse button to click. Defaults to left.",
        },
        click_count: { type: "integer", description: "Number of clicks. Defaults to 1." },
      },
      required: ["app"],
      additionalProperties: false,
    },
  },
  {
    name: "perform_secondary_action",
    description: "Invoke a secondary accessibility action exposed by an element.",
    inputSchema: {
      type: "object",
      properties: {
        ...APP_PROPERTY,
        ...ELEMENT_INDEX_PROPERTY,
        action: { type: "string", description: "Secondary accessibility action name." },
      },
      required: ["app", "element_index", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "set_value",
    description: "Set the value of a settable accessibility element.",
    inputSchema: {
      type: "object",
      properties: {
        ...APP_PROPERTY,
        ...ELEMENT_INDEX_PROPERTY,
        value: { type: "string", description: "Value to assign." },
      },
      required: ["app", "element_index", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description: "Scroll an element in a direction by a number of pages.",
    inputSchema: {
      type: "object",
      properties: {
        ...APP_PROPERTY,
        ...ELEMENT_INDEX_PROPERTY,
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        pages: { type: "number", description: "Number of pages to scroll. Defaults to 1." },
      },
      required: ["app", "element_index", "direction"],
      additionalProperties: false,
    },
  },
  {
    name: "press_key",
    description:
      "Press a key or key-combination on the keyboard. Supports xdotool-style key syntax such as Return, Tab, super+c, and Up.",
    inputSchema: {
      type: "object",
      properties: {
        ...APP_PROPERTY,
        key: { type: "string", description: "Key or key combination to press." },
      },
      required: ["app", "key"],
      additionalProperties: false,
    },
  },
  {
    name: "type_text",
    description: "Type literal text using keyboard input.",
    inputSchema: {
      type: "object",
      properties: {
        ...APP_PROPERTY,
        text: { type: "string", description: "Literal text to type." },
      },
      required: ["app", "text"],
      additionalProperties: false,
    },
  },
] as const;

const SHIORI_COMPUTER_USE_TOOL_NAMES = new Set(
  SHIORI_COMPUTER_USE_TOOL_SCHEMAS.map((tool) => tool.name),
);

function nullableToolProperty(property: unknown): unknown {
  if (!property || typeof property !== "object" || Array.isArray(property)) {
    return property;
  }
  const schema = property as JsonSchemaProperty;
  const rawTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const types = rawTypes.includes("null") ? rawTypes : [...rawTypes, "null"];
  return {
    ...schema,
    ...(types.length > 0 ? { type: types } : {}),
    ...(schema.enum && !schema.enum.includes(null) ? { enum: [...schema.enum, null] } : {}),
  };
}

function strictProviderToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { anyOf: _anyOf, oneOf: _oneOf, allOf: _allOf, ...baseSchema } = schema;
  const properties =
    schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  const originallyRequired = new Set(Array.isArray(schema.required) ? schema.required : []);
  const strictProperties = Object.fromEntries(
    Object.entries(properties).map(([name, property]) => [
      name,
      originallyRequired.has(name) ? property : nullableToolProperty(property),
    ]),
  );

  return {
    ...baseSchema,
    properties: strictProperties,
    required: Object.keys(strictProperties),
    additionalProperties: false,
  };
}

export function toolSchemas() {
  return SHIORI_COMPUTER_USE_TOOL_SCHEMAS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: strictProviderToolSchema(tool.inputSchema),
  }));
}

const HELPER_TIMEOUT_MS = 30_000;
const HELPER_STDOUT_LIMIT_BYTES = 32 * 1024 * 1024;

const appRoot = resolveAppRootFromModule(import.meta.url);

const latestScreenshotSizes = new Map<string, ScreenshotSize>();
const latestBcuAppStates = new Map<
  string,
  {
    readonly app: string;
    readonly window: string;
    readonly stateToken: string;
  }
>();

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
    case "list_apps":
      return "bcu-list-apps";
    case "get_app_state":
      return "bcu-get-window-state";
    case "click":
      return "bcu-click";
    case "perform_secondary_action":
      return "bcu-perform-secondary-action";
    case "set_value":
      return "bcu-set-value";
    case "select_text":
      throw new Error(
        "Shiori Computer Use does not expose a native select_text helper command yet.",
      );
    case "drag":
      throw new Error(
        "Shiori Computer Use does not expose a native point-to-point drag helper command yet.",
      );
    case "scroll":
      return "bcu-scroll";
    case "press_key":
      return "bcu-press-key";
    case "type_text":
      return "bcu-type-text";
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

function assertComputerToolInput(toolName: string, args: Record<string, unknown>): void {
  if (toolName === "get_app_state") {
    const app = typeof args.app === "string" ? args.app.trim() : "";
    if (!app) {
      throw new Error("get_app_state requires app.");
    }
    return;
  }
  if (toolName === "click") {
    const hasElementIndex = typeof args.element_index === "string" && args.element_index.trim();
    const hasCoordinates =
      typeof args.x === "number" &&
      Number.isFinite(args.x) &&
      typeof args.y === "number" &&
      Number.isFinite(args.y);
    if (!hasElementIndex && !hasCoordinates) {
      throw new Error("click requires element_index or x/y screenshot coordinates.");
    }
    return;
  }
  if (toolName !== "computer_focus_app" && toolName !== "computer_focus_window") {
    return;
  }
  const bundleIdentifier =
    typeof args.bundleIdentifier === "string" ? args.bundleIdentifier.trim() : "";
  const processIdentifier =
    typeof args.processIdentifier === "number" && Number.isFinite(args.processIdentifier)
      ? args.processIdentifier
      : null;
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!bundleIdentifier && processIdentifier === null && !name) {
    throw new Error(
      `${toolName} requires bundleIdentifier, processIdentifier, or name from computer_list_apps.`,
    );
  }
}

function stripNullishToolInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== null && value !== undefined),
  );
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

const powerAssertion = createPowerAssertion({ reason: "ShioriCode Computer Use session" });

const helperServeClient = new HelperServeClient({
  resolveHelperPath,
  requestTimeoutMs: HELPER_TIMEOUT_MS,
});

/**
 * Commands the persistent serve-mode helper can execute. UI-presenting
 * commands (permission guide) and legacy global-desktop commands keep the
 * one-shot process model.
 */
function serveEligibleCommand(command: string): boolean {
  return command.startsWith("bcu-") || command === "permissions";
}

async function runHelper(command: string, input: unknown): Promise<unknown> {
  assertRuntimeAllowsComputerUse();
  // Keep the display and system awake for the duration of the burst so a
  // multi-step desktop task is not interrupted by idle sleep (which also blacks
  // out screenshots). Released automatically after an idle period.
  powerAssertion.keepAwake();

  // Prefer the persistent serve-mode helper: it keeps the Accessibility
  // runtime warm across actions and preserves state-token continuity. Fall
  // back to one-shot spawning when the installed helper predates serve mode.
  if (serveEligibleCommand(command)) {
    try {
      return await helperServeClient.request(command, input);
    } catch (error) {
      if (!(error instanceof HelperServeUnsupportedError)) {
        throw error;
      }
    }
  }

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

function bcuKeySyntax(input: Record<string, unknown>): string {
  const rawKey = typeof input.key === "string" ? input.key.trim() : "";
  if (!rawKey) {
    throw new Error("press_key requires key.");
  }
  return rawKey
    .split("+")
    .map((part) => {
      const trimmed = part.trim();
      switch (trimmed.toLowerCase()) {
        case "super":
        case "cmd":
          return "command";
        case "ctrl":
          return "control";
        case "alt":
          return "option";
        default:
          return trimmed;
      }
    })
    .filter((part) => part.length > 0)
    .join("+");
}

function bcuAppKey(app: unknown): string {
  const value = typeof app === "string" ? app.trim() : "";
  if (!value) {
    throw new Error("Computer Use app must be a non-empty string.");
  }
  return value.toLocaleLowerCase();
}

function rememberBcuAppState(app: unknown, result: unknown): void {
  if (!isRecord(result)) return;
  const window = isRecord(result.window) ? stringValue(result.window.windowID) : null;
  const stateToken = stringValue(result.stateToken);
  if (!window || !stateToken) return;
  latestBcuAppStates.set(bcuAppKey(app), {
    app: typeof app === "string" ? app.trim() : "",
    window,
    stateToken,
  });
}

/**
 * Advance the remembered state token after an action so the next action in the
 * same turn does not reuse a token the UI has already invalidated. bcu actions
 * return a `postStateToken` describing the window state produced by the action;
 * carrying it forward is what lets get_app_state -> click -> click sequences
 * work without an intervening get_app_state.
 */
function updateBcuAppStateAfterAction(app: unknown, result: unknown): void {
  if (!isRecord(result)) return;
  const postStateToken = stringValue(result.postStateToken) ?? stringValue(result.stateToken);
  if (!postStateToken) return;
  const key = bcuAppKey(app);
  const existing = latestBcuAppStates.get(key);
  const window =
    (isRecord(result.window) ? stringValue(result.window.windowID) : null) ??
    existing?.window ??
    null;
  if (!window) return;
  latestBcuAppStates.set(key, {
    app: existing?.app ?? (typeof app === "string" ? app.trim() : ""),
    window,
    stateToken: postStateToken,
  });
}

/**
 * Return remembered window state for an app, transparently fetching it when it
 * is missing. Previously a missing entry hard-failed with "Call get_app_state
 * for this app once in the current assistant turn...", which was the single
 * most common Computer Use failure: the model would act on an app whose state
 * had never been captured in this process (fresh MCP process, or a
 * coordinate-only click) and get a dead end instead of an action. Auto-fetching
 * the window state keeps the window handle and state token fresh and lets the
 * action proceed.
 */
async function ensureBcuAppState(app: unknown): Promise<{
  readonly app: string;
  readonly window: string;
  readonly stateToken: string;
}> {
  const existing = latestBcuAppStates.get(bcuAppKey(app));
  if (existing) return existing;
  await runShioriComputerUseTool("get_app_state", { app });
  const refreshed = latestBcuAppStates.get(bcuAppKey(app));
  if (!refreshed) {
    throw new Error(
      `Could not resolve a target window for '${typeof app === "string" ? app : ""}'. Call get_app_state for this app first.`,
    );
  }
  return refreshed;
}

/**
 * A failure whose text indicates the supplied state token no longer matches the
 * live window state. On these we refresh state once and retry, rather than
 * surfacing a stale-token error the model can't act on.
 */
function isStaleStateFailure(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("state token") ||
    message.includes("statetoken") ||
    message.includes("stale") ||
    message.includes("out of date") ||
    message.includes("no longer") ||
    message.includes("changed since")
  );
}

function bcuTargetInput(input: Record<string, unknown>): Record<string, unknown> {
  const raw = typeof input.element_index === "string" ? input.element_index.trim() : "";
  if (!raw) {
    throw new Error("This Shiori Computer Use action requires element_index from get_app_state.");
  }
  const index = Number.parseInt(raw, 10);
  if (/^\d+$/.test(raw) && Number.isSafeInteger(index)) {
    return { target: { kind: "display_index", value: index } };
  }
  return { target: { kind: "node_id", value: raw } };
}

async function runShioriComputerUseTool(
  toolName: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (toolName === "list_apps") {
    return runHelper("bcu-list-apps", {});
  }

  if (toolName === "get_app_state") {
    const result = await runHelper("bcu-get-window-state", {
      app: input.app,
      imageMode: "base64",
      maxNodes: 6500,
    });
    rememberBcuAppState(input.app, result);
    return result;
  }

  if (toolName === "drag") {
    throw new Error(
      "Shiori Computer Use is backed by BackgroundComputerUse, which does not expose arbitrary point-to-point UI drag yet. Use click, scroll, type_text, press_key, set_value, or perform_secondary_action.",
    );
  }
  if (toolName === "select_text") {
    throw new Error(
      "Shiori Computer Use is backed by BackgroundComputerUse, which does not expose Codex-style select_text yet. Use set_value or type_text for editable controls.",
    );
  }

  const buildPayload = (state: {
    readonly app: string;
    readonly window: string;
    readonly stateToken: string;
  }): { command: string; payload: Record<string, unknown> } => {
    const base = {
      app: state.app,
      window: state.window,
      stateToken: state.stateToken,
      imageMode: "base64",
      maxNodes: 6500,
    };
    switch (toolName) {
      case "click": {
        const hasCoordinates =
          typeof input.x === "number" &&
          Number.isFinite(input.x) &&
          typeof input.y === "number" &&
          Number.isFinite(input.y);
        return {
          command: "bcu-click",
          payload: {
            ...base,
            ...(hasCoordinates ? { x: input.x, y: input.y } : bcuTargetInput(input)),
            ...(input.mouse_button ? { mouse_button: input.mouse_button } : {}),
            ...(input.click_count ? { click_count: input.click_count } : {}),
          },
        };
      }
      case "perform_secondary_action":
        return {
          command: "bcu-perform-secondary-action",
          payload: { ...base, ...bcuTargetInput(input), action: input.action },
        };
      case "set_value":
        return {
          command: "bcu-set-value",
          payload: { ...base, ...bcuTargetInput(input), value: input.value },
        };
      case "scroll":
        return {
          command: "bcu-scroll",
          payload: {
            ...base,
            ...bcuTargetInput(input),
            direction: input.direction,
            ...(input.pages ? { pages: input.pages } : {}),
          },
        };
      case "press_key":
        return { command: "bcu-press-key", payload: { ...base, key: bcuKeySyntax(input) } };
      case "type_text":
        return {
          command: "bcu-type-text",
          payload: {
            ...base,
            ...(typeof input.element_index === "string" && input.element_index.trim()
              ? bcuTargetInput(input)
              : {}),
            text: input.text,
          },
        };
      default:
        return { command: helperCommandForTool(toolName), payload: input };
    }
  };

  const state = await ensureBcuAppState(input.app);
  const { command, payload } = buildPayload(state);
  try {
    const result = await runHelper(command, payload);
    updateBcuAppStateAfterAction(input.app, result);
    return result;
  } catch (error) {
    if (!isStaleStateFailure(error)) throw error;
    // The state token went stale between get_app_state and this action. Refresh
    // the window state once and retry with the fresh token rather than handing
    // the model a stale-token error it cannot recover from on its own.
    latestBcuAppStates.delete(bcuAppKey(input.app));
    const refreshed = await ensureBcuAppState(input.app);
    const retry = buildPayload(refreshed);
    const result = await runHelper(retry.command, retry.payload);
    updateBcuAppStateAfterAction(input.app, result);
    return result;
  }
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
  latestBcuAppStates.clear();
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
): Record<string, unknown> {
  const baseInput = stripNullishToolInput(input);
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
    cursor ? `Cursor position: ${cursor} in screenshot pixels.` : null,
    screenBounds ? `Virtual screen bounds: ${screenBounds} in macOS points.` : null,
    displayCount > 0 ? `Displays: ${displayCount}.` : null,
    ...displayLines,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function bcuRunningAppLine(app: unknown, index: number): string | null {
  if (!isRecord(app)) return null;
  const name = stringValue(app.name);
  if (!name) return null;
  const bundleID = stringValue(app.bundleID);
  const pid = numberValue(app.pid);
  const states = [
    app.isFrontmost === true ? "frontmost" : null,
    app.isActive === true ? "active" : null,
    app.isHidden === true ? "hidden" : null,
    bundleID,
    pid !== null ? `pid ${Math.trunc(pid)}` : null,
    numberValue(app.onscreenWindowCount) !== null
      ? `${Math.trunc(numberValue(app.onscreenWindowCount) ?? 0)} windows`
      : null,
  ].filter((part): part is string => Boolean(part));
  return `${index + 1}. ${name}${states.length > 0 ? ` (${states.join(", ")})` : ""}`;
}

function bcuAppListText(result: Record<string, unknown>): string | null {
  if (!Array.isArray(result.runningApps)) return null;
  const appLines = result.runningApps
    .flatMap((app, index) => {
      const line = bcuRunningAppLine(app, index);
      return line ? [line] : [];
    })
    .slice(0, 40);
  const hiddenAppCount = result.runningApps.length - appLines.length;
  const frontmost = isRecord(result.frontmostApp)
    ? bcuRunningAppLine(result.frontmostApp, 0)
    : null;
  const notes = Array.isArray(result.notes)
    ? result.notes.flatMap((note) => (typeof note === "string" && note.trim() ? [note.trim()] : []))
    : [];
  return [
    "Running apps available to Shiori Computer Use:",
    frontmost ? `Frontmost: ${frontmost.replace(/^1\. /, "")}` : null,
    appLines.length > 0 ? appLines.join("\n") : "No running apps were reported.",
    hiddenAppCount > 0 ? `${hiddenAppCount} more apps hidden.` : null,
    notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join("\n")}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

/**
 * Human-readable line describing the macOS login-session state attached to bcu
 * results. Only unusual states produce a line: the model needs to know when
 * the screen is locked (screenshots may not match the physical display; the
 * user cannot see actions) or when no interactive session is available.
 */
function bcuSessionStateLine(result: Record<string, unknown>): string | null {
  const state = isRecord(result.sessionState) ? result.sessionState : null;
  if (!state) return null;
  if (state.sessionAvailable === false) {
    return "macOS session: no interactive login session is available; desktop actions may fail.";
  }
  if (state.screenLocked === true) {
    return "macOS session: the screen is LOCKED. App-scoped accessibility actions and window screenshots keep working against the app directly, but the physical display shows the lock screen and the user cannot see these actions.";
  }
  if (state.onConsole === false) {
    return "macOS session: this login session is not on the console (another user is active); desktop actions may fail or be invisible.";
  }
  return null;
}

function bcuWindowHeadline(window: unknown): string | null {
  if (!isRecord(window)) return null;
  const title = stringValue(window.title);
  const bundleID = stringValue(window.bundleID);
  const windowID = stringValue(window.windowID);
  const pid = numberValue(window.pid);
  const frame = boundsText(window.frameAppKit);
  const parts = [
    title ?? "Untitled window",
    bundleID,
    pid !== null ? `pid ${Math.trunc(pid)}` : null,
    windowID ? `window ${windowID}` : null,
    frame,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" | ");
}

function bcuScreenshotImage(
  result: Record<string, unknown>,
): { data: string; mimeType: string } | null {
  const screenshot = isRecord(result.screenshot) ? result.screenshot : null;
  const image = screenshot && isRecord(screenshot.image) ? screenshot.image : null;
  const data = image ? stringValue(image.imageBase64) : null;
  if (!data) return null;
  return {
    data,
    mimeType: (image ? stringValue(image.mimeType) : null) ?? "image/png",
  };
}

function bcuWindowStateText(result: Record<string, unknown>): string | null {
  const stateToken = stringValue(result.stateToken);
  const tree = isRecord(result.tree) ? result.tree : null;
  const renderedText = tree ? stringValue(tree.renderedText) : null;
  if (!stateToken || !tree || renderedText === null) return null;

  const window = bcuWindowHeadline(result.window);
  const nodeCount = numberValue(tree.nodeCount);
  const screenshot = isRecord(result.screenshot) ? result.screenshot : null;
  const screenshotImage = screenshot && isRecord(screenshot.image) ? screenshot.image : null;
  const pixelWidth = screenshotImage ? numberValue(screenshotImage.pixelWidth) : null;
  const pixelHeight = screenshotImage ? numberValue(screenshotImage.pixelHeight) : null;
  const focused = isRecord(result.focusedElement) ? result.focusedElement : null;
  const focusedIndex = focused ? numberValue(focused.index) : null;
  const focusedRole = focused ? stringValue(focused.displayRole) : null;
  const focusedTitle = focused ? stringValue(focused.title) : null;
  const notes = Array.isArray(result.notes)
    ? result.notes.flatMap((note) => (typeof note === "string" && note.trim() ? [note.trim()] : []))
    : [];

  return [
    "Shiori Computer Use app state.",
    bcuSessionStateLine(result),
    window ? `Window: ${window}.` : null,
    `State token: ${stateToken}.`,
    pixelWidth !== null && pixelHeight !== null
      ? `Screenshot: ${Math.trunc(pixelWidth)}x${Math.trunc(pixelHeight)} window pixels.`
      : null,
    nodeCount !== null
      ? `Accessibility tree: ${Math.trunc(nodeCount)} nodes${tree.truncated === true ? " (truncated)" : ""}.`
      : null,
    focusedIndex !== null || focusedRole || focusedTitle
      ? `Focused element: ${[
          focusedIndex !== null ? `index ${Math.trunc(focusedIndex)}` : null,
          focusedRole,
          focusedTitle,
        ]
          .filter((part): part is string => Boolean(part))
          .join(" | ")}.`
      : null,
    "Use element_index values from the rendered tree for click, scroll, set_value, type_text, and perform_secondary_action. Call get_app_state again after meaningful UI changes.",
    notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join("\n")}` : null,
    "Rendered accessibility tree:",
    renderedText,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function bcuActionResultText(result: Record<string, unknown>): string | null {
  if (typeof result.ok !== "boolean" || !("classification" in result)) return null;
  const summary = stringValue(result.summary);
  const classification = stringValue(result.classification);
  const failureDomain = stringValue(result.failureDomain);
  const preStateToken = stringValue(result.preStateToken);
  const postStateToken = stringValue(result.postStateToken);
  const window = bcuWindowHeadline(result.window);
  const warnings = Array.isArray(result.warnings)
    ? result.warnings.flatMap((warning) =>
        typeof warning === "string" && warning.trim() ? [warning.trim()] : [],
      )
    : [];
  const notes = Array.isArray(result.notes)
    ? result.notes.flatMap((note) => (typeof note === "string" && note.trim() ? [note.trim()] : []))
    : [];
  return [
    `Computer Use action ${result.ok ? "completed" : "did not complete"}.`,
    bcuSessionStateLine(result),
    summary,
    classification ? `Classification: ${classification}.` : null,
    failureDomain ? `Failure domain: ${failureDomain}.` : null,
    window ? `Window: ${window}.` : null,
    preStateToken ? `Pre-state token: ${preStateToken}.` : null,
    postStateToken ? `Post-state token: ${postStateToken}.` : null,
    warnings.length > 0
      ? `Warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`
      : null,
    notes.length > 0 ? `Notes:\n${notes.map((note) => `- ${note}`).join("\n")}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function toolResultContent(result: unknown) {
  if (isRecord(result) && "stateToken" in result && "tree" in result && "screenshot" in result) {
    return {
      content: [
        {
          type: "text",
          text: bcuWindowStateText(result) ?? JSON.stringify(result, null, 2),
        },
        ...(bcuScreenshotImage(result) ? [{ type: "image", ...bcuScreenshotImage(result) }] : []),
      ],
    };
  }
  if (isRecord(result) && "runningApps" in result) {
    return {
      content: [
        {
          type: "text",
          text: bcuAppListText(result) ?? JSON.stringify(result, null, 2),
        },
      ],
    };
  }
  if (isRecord(result) && "ok" in result && "classification" in result) {
    return {
      content: [
        {
          type: "text",
          text: bcuActionResultText(result) ?? JSON.stringify(result, null, 2),
        },
      ],
    };
  }
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
          serverInfo: { name: "Shiori Computer Use", version: "0.1.0" },
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
        assertComputerToolInput(name, args);
        if (SHIORI_COMPUTER_USE_TOOL_NAMES.has(name)) {
          success(id, toolResultContent(await runShioriComputerUseTool(name, args)));
          return;
        }
        const helperInput = helperInputForComputerTool(
          name,
          enrichComputerPermissionInput(
            name,
            enrichComputerActionInputWithLatestScreenshotSize(name, args),
          ),
        );
        const result = await runHelper(helperCommandForTool(name), helperInput);
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
  const releasePower = () => {
    powerAssertion.release();
    helperServeClient.dispose();
  };
  process.once("exit", releasePower);
  process.once("SIGTERM", () => {
    releasePower();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    releasePower();
    process.exit(0);
  });

  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  try {
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
  } finally {
    releasePower();
  }
}
