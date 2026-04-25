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

export const ComputerUsePermissionsSnapshot = Schema.Struct({
  platform: Schema.String,
  supported: Schema.Boolean,
  helperAvailable: Schema.Boolean,
  helperPath: Schema.NullOr(Schema.String),
  permissions: Schema.Array(ComputerUsePermissionSnapshot),
  checkedAt: TrimmedNonEmptyString,
  message: Schema.NullOr(Schema.String),
});
export type ComputerUsePermissionsSnapshot = typeof ComputerUsePermissionsSnapshot.Type;

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

export const ComputerUseScreenshotInput = ComputerUseSessionInput;
export type ComputerUseScreenshotInput = typeof ComputerUseScreenshotInput.Type;

export const ComputerUseScreenshotResult = Schema.Struct({
  sessionId: ComputerUseSessionId,
  imageDataUrl: TrimmedNonEmptyString,
  width: Schema.Number,
  height: Schema.Number,
  capturedAt: TrimmedNonEmptyString,
});
export type ComputerUseScreenshotResult = typeof ComputerUseScreenshotResult.Type;

export const ComputerUseClickInput = Schema.Struct({
  ...ComputerUseSessionInput.fields,
  x: Schema.Number,
  y: Schema.Number,
  button: Schema.optional(Schema.Literals(["left", "right"])),
  clickCount: Schema.optional(Schema.Number),
});
export type ComputerUseClickInput = typeof ComputerUseClickInput.Type;

export const ComputerUseMoveInput = Schema.Struct({
  ...ComputerUseSessionInput.fields,
  x: Schema.Number,
  y: Schema.Number,
});
export type ComputerUseMoveInput = typeof ComputerUseMoveInput.Type;

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
  deltaX: Schema.optional(Schema.Number),
  deltaY: Schema.optional(Schema.Number),
});
export type ComputerUseScrollInput = typeof ComputerUseScrollInput.Type;

export const ComputerUseActionResult = Schema.Struct({
  sessionId: ComputerUseSessionId,
  ok: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
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
