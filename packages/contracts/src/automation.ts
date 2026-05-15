import { Schema } from "effect";

import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration";

export const AutomationId = TrimmedNonEmptyString.pipe(Schema.brand("AutomationId"));
export type AutomationId = typeof AutomationId.Type;

export const AutomationKind = Schema.Literals(["automation", "heartbeat"]);
export type AutomationKind = typeof AutomationKind.Type;

export const AutomationStatus = Schema.Literals(["active", "paused"]);
export type AutomationStatus = typeof AutomationStatus.Type;

export const AutomationLastRunStatus = Schema.Literals(["idle", "queued", "failed"]);
export type AutomationLastRunStatus = typeof AutomationLastRunStatus.Type;

export const AutomationScheduleRrule = TrimmedNonEmptyString;
export type AutomationScheduleRrule = typeof AutomationScheduleRrule.Type;

export const Automation = Schema.Struct({
  id: AutomationId,
  kind: AutomationKind,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  projectId: Schema.NullOr(ProjectId),
  projectlessCwd: Schema.NullOr(TrimmedNonEmptyString),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  scheduleRrule: AutomationScheduleRrule,
  status: AutomationStatus,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastRunThreadId: Schema.NullOr(ThreadId),
  lastRunStatus: AutomationLastRunStatus,
  lastRunError: Schema.NullOr(TrimmedString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type Automation = typeof Automation.Type;

export const AutomationListResult = Schema.Struct({
  automations: Schema.Array(Automation),
});
export type AutomationListResult = typeof AutomationListResult.Type;

export const AutomationCreateInput = Schema.Struct({
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  projectId: Schema.NullOr(ProjectId),
  projectlessCwd: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: Schema.optional(ProviderInteractionMode).pipe(
    Schema.withDecodingDefault(() => "default" as const),
  ),
  scheduleRrule: AutomationScheduleRrule,
  status: Schema.optional(AutomationStatus).pipe(Schema.withDecodingDefault(() => "active")),
});
export type AutomationCreateInput = typeof AutomationCreateInput.Type;

export const AutomationUpdateInput = Schema.Struct({
  automationId: AutomationId,
  title: Schema.optional(TrimmedNonEmptyString),
  prompt: Schema.optional(TrimmedNonEmptyString),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  projectlessCwd: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  scheduleRrule: Schema.optional(AutomationScheduleRrule),
  status: Schema.optional(AutomationStatus),
});
export type AutomationUpdateInput = typeof AutomationUpdateInput.Type;

export const AutomationIdInput = Schema.Struct({
  automationId: AutomationId,
});
export type AutomationIdInput = typeof AutomationIdInput.Type;

export const AutomationIntervalPreset = Schema.Struct({
  label: TrimmedNonEmptyString,
  minutes: PositiveInt,
  rrule: AutomationScheduleRrule,
});
export type AutomationIntervalPreset = typeof AutomationIntervalPreset.Type;

export class AutomationError extends Schema.TaggedErrorClass<AutomationError>()("AutomationError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}
