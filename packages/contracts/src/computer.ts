import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas";

export const ComputerUsePermissionKind = Schema.Literals(["accessibility", "screen-recording"]);
export type ComputerUsePermissionKind = typeof ComputerUsePermissionKind.Type;

export const ComputerUsePermissionState = Schema.Literals([
  "granted",
  "denied",
  "unknown",
  "unsupported",
]);
export type ComputerUsePermissionState = typeof ComputerUsePermissionState.Type;

export const ComputerUsePermissionSnapshot = Schema.Struct({
  kind: ComputerUsePermissionKind,
  state: ComputerUsePermissionState,
  label: TrimmedNonEmptyString,
  detail: Schema.String,
});
export type ComputerUsePermissionSnapshot = typeof ComputerUsePermissionSnapshot.Type;

export const ComputerUsePermissionSubject = Schema.Struct({
  kind: Schema.Literals(["helper", "app", "unknown"]),
  displayName: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
});
export type ComputerUsePermissionSubject = typeof ComputerUsePermissionSubject.Type;

export const ComputerUsePermissionsSnapshot = Schema.Struct({
  platform: Schema.String,
  supported: Schema.Boolean,
  helperAvailable: Schema.Boolean,
  helperPath: Schema.NullOr(Schema.String),
  permissionSubject: Schema.optional(ComputerUsePermissionSubject),
  permissions: Schema.Array(ComputerUsePermissionSnapshot),
  checkedAt: TrimmedNonEmptyString,
  message: Schema.NullOr(Schema.String),
});
export type ComputerUsePermissionsSnapshot = typeof ComputerUsePermissionsSnapshot.Type;

export const ComputerUsePermissionActionInput = Schema.Struct({
  kind: ComputerUsePermissionKind,
  hostAppBundlePath: Schema.optional(Schema.String),
  hostAppDisplayName: Schema.optional(Schema.String),
  durationSeconds: Schema.optional(Schema.Number),
});
export type ComputerUsePermissionActionInput = typeof ComputerUsePermissionActionInput.Type;

export const ComputerUsePermissionActionResult = Schema.Struct({
  ok: Schema.Boolean,
  kind: ComputerUsePermissionKind,
  permissionSubject: Schema.optional(ComputerUsePermissionSubject),
  message: Schema.NullOr(Schema.String),
});
export type ComputerUsePermissionActionResult = typeof ComputerUsePermissionActionResult.Type;

export const ComputerUseSessionId = TrimmedNonEmptyString;
export type ComputerUseSessionId = typeof ComputerUseSessionId.Type;

export const ComputerUseSessionSnapshot = Schema.Struct({
  id: ComputerUseSessionId,
  kind: Schema.Literal("macos-desktop"),
  createdAt: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
});
export type ComputerUseSessionSnapshot = typeof ComputerUseSessionSnapshot.Type;

export const ComputerUseCreateSessionInput = Schema.Struct({});
export type ComputerUseCreateSessionInput = typeof ComputerUseCreateSessionInput.Type;

export const ComputerUseCloseSessionInput = Schema.Struct({
  sessionId: ComputerUseSessionId,
});
export type ComputerUseCloseSessionInput = typeof ComputerUseCloseSessionInput.Type;

export const ComputerUseSessionInput = Schema.Struct({
  sessionId: Schema.optional(ComputerUseSessionId),
});
export type ComputerUseSessionInput = typeof ComputerUseSessionInput.Type;

export const ComputerUsePoint = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});
export type ComputerUsePoint = typeof ComputerUsePoint.Type;

export const ComputerUseBounds = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type ComputerUseBounds = typeof ComputerUseBounds.Type;

export const ComputerUseDisplaySnapshot = Schema.Struct({
  id: Schema.Number,
  bounds: ComputerUseBounds,
  screenshotBounds: Schema.optional(ComputerUseBounds),
  pixelsWide: Schema.Number,
  pixelsHigh: Schema.Number,
  scaleX: Schema.Number,
  scaleY: Schema.Number,
  isMain: Schema.Boolean,
});
export type ComputerUseDisplaySnapshot = typeof ComputerUseDisplaySnapshot.Type;

export const ComputerUseScreenshotInput = ComputerUseSessionInput;
export type ComputerUseScreenshotInput = typeof ComputerUseScreenshotInput.Type;

export const ComputerUseScreenshotResult = Schema.Struct({
  sessionId: ComputerUseSessionId,
  imageDataUrl: TrimmedNonEmptyString,
  width: Schema.Number,
  height: Schema.Number,
  coordinateSpace: Schema.optional(Schema.Literal("screenshot")),
  screenBounds: Schema.optional(ComputerUseBounds),
  displays: Schema.optional(Schema.Array(ComputerUseDisplaySnapshot)),
  cursorPosition: Schema.optional(Schema.NullOr(ComputerUsePoint)),
  capturedAt: TrimmedNonEmptyString,
});
export type ComputerUseScreenshotResult = typeof ComputerUseScreenshotResult.Type;

export const ComputerUseListAppsInput = ComputerUseSessionInput;
export type ComputerUseListAppsInput = typeof ComputerUseListAppsInput.Type;

const ComputerUseFocusAppSelectorFields = {
  ...ComputerUseSessionInput.fields,
  bundleIdentifier: Schema.optional(TrimmedNonEmptyString),
  processIdentifier: Schema.optional(Schema.Int),
  name: Schema.optional(TrimmedNonEmptyString),
} as const;

export const ComputerUseFocusAppInput = Schema.Union([
  Schema.Struct({
    ...ComputerUseFocusAppSelectorFields,
    bundleIdentifier: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...ComputerUseFocusAppSelectorFields,
    processIdentifier: Schema.Int,
  }),
  Schema.Struct({
    ...ComputerUseFocusAppSelectorFields,
    name: TrimmedNonEmptyString,
  }),
]);
export type ComputerUseFocusAppInput = typeof ComputerUseFocusAppInput.Type;

export const ComputerUseWindowBounds = ComputerUseBounds;
export type ComputerUseWindowBounds = typeof ComputerUseWindowBounds.Type;

export const ComputerUseAppWindowSnapshot = Schema.Struct({
  index: Schema.optional(Schema.Number),
  title: Schema.NullOr(Schema.String),
  bounds: Schema.NullOr(ComputerUseWindowBounds),
});
export type ComputerUseAppWindowSnapshot = typeof ComputerUseAppWindowSnapshot.Type;

const ComputerUseFocusWindowSelectorFields = {
  ...ComputerUseFocusAppSelectorFields,
  windowIndex: Schema.optional(Schema.Int),
  windowTitle: Schema.optional(TrimmedNonEmptyString),
} as const;

export const ComputerUseFocusWindowInput = Schema.Union([
  Schema.Struct({
    ...ComputerUseFocusWindowSelectorFields,
    bundleIdentifier: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...ComputerUseFocusWindowSelectorFields,
    processIdentifier: Schema.Int,
  }),
  Schema.Struct({
    ...ComputerUseFocusWindowSelectorFields,
    name: TrimmedNonEmptyString,
  }),
]);
export type ComputerUseFocusWindowInput = typeof ComputerUseFocusWindowInput.Type;

export const ComputerUseAppSnapshot = Schema.Struct({
  processIdentifier: Schema.Number,
  name: TrimmedNonEmptyString,
  bundleIdentifier: Schema.NullOr(Schema.String),
  bundlePath: Schema.NullOr(Schema.String),
  activationPolicy: Schema.String,
  isActive: Schema.Boolean,
  isHidden: Schema.Boolean,
  windows: Schema.Array(ComputerUseAppWindowSnapshot),
});
export type ComputerUseAppSnapshot = typeof ComputerUseAppSnapshot.Type;

export const ComputerUseAppStateResult = Schema.Struct({
  sessionId: ComputerUseSessionId,
  checkedAt: TrimmedNonEmptyString,
  accessibilityTrusted: Schema.Boolean,
  filteredByApprovedApps: Schema.optional(Schema.Boolean),
  apps: Schema.Array(ComputerUseAppSnapshot),
});
export type ComputerUseAppStateResult = typeof ComputerUseAppStateResult.Type;

export const ComputerUseCoordinateSpace = Schema.Literals(["screenshot", "screen"]);
export type ComputerUseCoordinateSpace = typeof ComputerUseCoordinateSpace.Type;

export const ComputerUseClickInput = Schema.Struct({
  ...ComputerUseSessionInput.fields,
  x: Schema.Number,
  y: Schema.Number,
  coordinateSpace: Schema.optional(ComputerUseCoordinateSpace),
  screenshotWidth: Schema.optional(Schema.Number),
  screenshotHeight: Schema.optional(Schema.Number),
  button: Schema.optional(Schema.Literals(["left", "right"])),
  clickCount: Schema.optional(Schema.Number),
});
export type ComputerUseClickInput = typeof ComputerUseClickInput.Type;

export const ComputerUseDoubleClickInput = Schema.Struct({
  ...ComputerUseSessionInput.fields,
  x: Schema.Number,
  y: Schema.Number,
  coordinateSpace: Schema.optional(ComputerUseCoordinateSpace),
  screenshotWidth: Schema.optional(Schema.Number),
  screenshotHeight: Schema.optional(Schema.Number),
});
export type ComputerUseDoubleClickInput = typeof ComputerUseDoubleClickInput.Type;

export const ComputerUseRightClickInput = Schema.Struct({
  ...ComputerUseSessionInput.fields,
  x: Schema.Number,
  y: Schema.Number,
  coordinateSpace: Schema.optional(ComputerUseCoordinateSpace),
  screenshotWidth: Schema.optional(Schema.Number),
  screenshotHeight: Schema.optional(Schema.Number),
});
export type ComputerUseRightClickInput = typeof ComputerUseRightClickInput.Type;

export const ComputerUseMoveInput = Schema.Struct({
  ...ComputerUseSessionInput.fields,
  x: Schema.Number,
  y: Schema.Number,
  coordinateSpace: Schema.optional(ComputerUseCoordinateSpace),
  screenshotWidth: Schema.optional(Schema.Number),
  screenshotHeight: Schema.optional(Schema.Number),
});
export type ComputerUseMoveInput = typeof ComputerUseMoveInput.Type;

export const ComputerUseDragInput = Schema.Struct({
  ...ComputerUseSessionInput.fields,
  fromX: Schema.Number,
  fromY: Schema.Number,
  toX: Schema.Number,
  toY: Schema.Number,
  coordinateSpace: Schema.optional(ComputerUseCoordinateSpace),
  screenshotWidth: Schema.optional(Schema.Number),
  screenshotHeight: Schema.optional(Schema.Number),
  durationMs: Schema.optional(Schema.Number),
});
export type ComputerUseDragInput = typeof ComputerUseDragInput.Type;

export const ComputerUseTypeInput = Schema.Struct({
  ...ComputerUseSessionInput.fields,
  text: Schema.String,
});
export type ComputerUseTypeInput = typeof ComputerUseTypeInput.Type;

export const ComputerUseKeyModifier = Schema.Literals(["command", "control", "option", "shift"]);
export type ComputerUseKeyModifier = typeof ComputerUseKeyModifier.Type;

export const ComputerUseKeyInput = Schema.Struct({
  ...ComputerUseSessionInput.fields,
  key: TrimmedNonEmptyString,
  modifiers: Schema.optional(Schema.Array(ComputerUseKeyModifier)),
});
export type ComputerUseKeyInput = typeof ComputerUseKeyInput.Type;

export const ComputerUseScrollInput = Schema.Struct({
  ...ComputerUseSessionInput.fields,
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
  coordinateSpace: Schema.optional(ComputerUseCoordinateSpace),
  screenshotWidth: Schema.optional(Schema.Number),
  screenshotHeight: Schema.optional(Schema.Number),
  deltaX: Schema.optional(Schema.Number),
  deltaY: Schema.optional(Schema.Number),
});
export type ComputerUseScrollInput = typeof ComputerUseScrollInput.Type;

export const ComputerUseWaitInput = Schema.Struct({
  ...ComputerUseSessionInput.fields,
  durationMs: Schema.optional(Schema.Number),
});
export type ComputerUseWaitInput = typeof ComputerUseWaitInput.Type;

export const ComputerUseActionResult = Schema.Struct({
  sessionId: ComputerUseSessionId,
  ok: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
  cursorScreenPosition: Schema.optional(ComputerUsePoint),
  activeApp: Schema.optional(ComputerUseAppSnapshot),
  focusedApp: Schema.optional(ComputerUseAppSnapshot),
  focusedWindow: Schema.optional(ComputerUseAppWindowSnapshot),
});
export type ComputerUseActionResult = typeof ComputerUseActionResult.Type;

export class ComputerUseError extends Schema.TaggedErrorClass<ComputerUseError>()(
  "ComputerUseError",
  {
    code: Schema.Literals([
      "unsupported",
      "disabled",
      "helperUnavailable",
      "permissionDenied",
      "sessionNotFound",
      "actionFailed",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}
