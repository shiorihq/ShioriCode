import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";

export const TelemetryProperties = Schema.Record(Schema.String, Schema.Unknown);
export type TelemetryProperties = typeof TelemetryProperties.Type;

export const TelemetryLogLevel = Schema.Literals(["info", "warn", "error"]);
export type TelemetryLogLevel = typeof TelemetryLogLevel.Type;

export const TelemetryCaptureInput = Schema.Struct({
  event: TrimmedNonEmptyString,
  properties: Schema.optional(TelemetryProperties),
});
export type TelemetryCaptureInput = typeof TelemetryCaptureInput.Type;

export const TelemetryLogInput = Schema.Struct({
  level: TelemetryLogLevel,
  message: TrimmedNonEmptyString,
  context: Schema.optional(TelemetryProperties),
});
export type TelemetryLogInput = typeof TelemetryLogInput.Type;
