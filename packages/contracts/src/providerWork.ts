import { Schema } from "effect";
import {
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProviderItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import { ProviderKind } from "./orchestration";

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);

export const TurnWorkItemKind = Schema.Literals([
  "assistant",
  "reasoning",
  "plan",
  "command",
  "file_change",
  "tool",
  "mcp_tool",
  "subagent",
  "web_search",
  "image",
  "approval",
  "status",
  "error",
]);
export type TurnWorkItemKind = typeof TurnWorkItemKind.Type;

export const TurnWorkItemStatus = Schema.Literals([
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "declined",
  "cancelled",
  "interrupted",
]);
export type TurnWorkItemStatus = typeof TurnWorkItemStatus.Type;

export const TurnWorkContentStreamKind = Schema.Literals([
  "assistant_text",
  "reasoning_text",
  "reasoning_summary_text",
  "plan_text",
  "command_output",
  "file_change_output",
  "unknown",
]);
export type TurnWorkContentStreamKind = typeof TurnWorkContentStreamKind.Type;

export const TurnWorkItemRefs = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  providerRequestId: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(RuntimeRequestId),
  taskId: Schema.optional(RuntimeTaskId),
  toolCallId: Schema.optional(TrimmedNonEmptyString),
  childThreadIds: Schema.optional(Schema.Array(ThreadId)),
});
export type TurnWorkItemRefs = typeof TurnWorkItemRefs.Type;

export const TurnWorkContentStream = Schema.Struct({
  id: TrimmedNonEmptyString,
  itemId: TrimmedNonEmptyString,
  kind: TurnWorkContentStreamKind,
  text: Schema.String,
  contentIndex: Schema.optional(Schema.Int),
  summaryIndex: Schema.optional(Schema.Int),
});
export type TurnWorkContentStream = typeof TurnWorkContentStream.Type;

export const TurnWorkItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  provider: ProviderKind,
  threadId: ThreadId,
  turnId: TurnId,
  order: NonNegativeInt,
  kind: TurnWorkItemKind,
  status: TurnWorkItemStatus,
  title: TrimmedNonEmptyString,
  parentId: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.optional(IsoDateTime),
  refs: Schema.optional(TurnWorkItemRefs),
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  error: Schema.optional(TrimmedNonEmptyString),
  data: Schema.optional(Schema.Unknown),
  source: Schema.optional(UnknownRecordSchema),
  streams: Schema.Array(TurnWorkContentStream),
});
export type TurnWorkItem = typeof TurnWorkItem.Type;

export const TurnWorkSnapshot = Schema.Struct({
  provider: ProviderKind,
  threadId: ThreadId,
  turnId: TurnId,
  updatedAt: IsoDateTime,
  items: Schema.Array(TurnWorkItem),
  sourceEventIds: Schema.Array(EventId),
});
export type TurnWorkSnapshot = typeof TurnWorkSnapshot.Type;
