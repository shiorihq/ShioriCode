import { Schema } from "effect";
import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

export const DesktopBrowserCaptureInput = Schema.Struct({
  threadId: ThreadId,
  webContentsId: NonNegativeInt,
});
export type DesktopBrowserCaptureInput = typeof DesktopBrowserCaptureInput.Type;

export const DesktopBrowserCaptureResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type DesktopBrowserCaptureResult = typeof DesktopBrowserCaptureResult.Type;

export const BrowserPanelNavigateRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  url: TrimmedNonEmptyString,
});
export type BrowserPanelNavigateRequest = typeof BrowserPanelNavigateRequest.Type;

const BrowserPanelCommandBase = {
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
};

export const BrowserPanelNavigateCommand = Schema.Struct({
  ...BrowserPanelCommandBase,
  type: Schema.Literal("navigate"),
  url: TrimmedNonEmptyString,
});

export const BrowserPanelEvaluateCommand = Schema.Struct({
  ...BrowserPanelCommandBase,
  type: Schema.Literal("evaluate"),
  script: TrimmedNonEmptyString,
  awaitPromise: Schema.optional(Schema.Boolean),
});

export const BrowserPanelSnapshotCommand = Schema.Struct({
  ...BrowserPanelCommandBase,
  type: Schema.Literal("snapshot"),
  includeText: Schema.optional(Schema.Boolean),
  includeLinks: Schema.optional(Schema.Boolean),
  includeForms: Schema.optional(Schema.Boolean),
});

export const BrowserPanelActionCommand = Schema.Struct({
  ...BrowserPanelCommandBase,
  type: Schema.Literal("action"),
  action: Schema.Literals(["back", "forward", "reload", "stop"]),
});

export const BrowserPanelSelectorCommand = Schema.Struct({
  ...BrowserPanelCommandBase,
  type: Schema.Literals(["click-selector", "type-selector"]),
  selector: TrimmedNonEmptyString,
  text: Schema.optional(Schema.String),
});

export const BrowserPanelCommand = Schema.Union([
  BrowserPanelNavigateCommand,
  BrowserPanelEvaluateCommand,
  BrowserPanelSnapshotCommand,
  BrowserPanelActionCommand,
  BrowserPanelSelectorCommand,
]);
export type BrowserPanelCommand = typeof BrowserPanelCommand.Type;

export const BrowserPanelCommandResult = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  ok: Schema.Boolean,
  value: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});
export type BrowserPanelCommandResult = typeof BrowserPanelCommandResult.Type;
