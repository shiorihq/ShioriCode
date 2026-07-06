import { Schema } from "effect";

import {
  ApprovalRequestId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { ModelCapabilities } from "./model";
import {
  ModelSelection,
  OrchestrationMessageRole,
  OrchestrationSessionStatus,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderKind,
  RuntimeMode,
  UploadChatAttachment,
} from "./orchestration";
import { ProjectEntry } from "./project";

export const MobilePairingCandidate = Schema.Struct({
  apiBaseUrl: Schema.String,
  label: Schema.String,
});
export type MobilePairingCandidate = typeof MobilePairingCandidate.Type;

export const MobilePairingPayload = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("shioricode.mobilePair"),
  pairingId: Schema.String,
  pairingSecret: Schema.String,
  expiresAt: IsoDateTime,
  apiBaseUrls: Schema.Array(Schema.String),
  candidates: Schema.Array(MobilePairingCandidate),
});
export type MobilePairingPayload = typeof MobilePairingPayload.Type;

export const MobilePairingSession = Schema.Struct({
  pairingId: Schema.String,
  expiresAt: IsoDateTime,
  qrPayload: Schema.String,
  candidates: Schema.Array(MobilePairingCandidate),
});
export type MobilePairingSession = typeof MobilePairingSession.Type;

export const MobilePairingSessionStatus = Schema.Struct({
  pairingId: Schema.String,
  expiresAt: IsoDateTime,
  paired: Schema.Boolean,
  pairedDeviceName: Schema.NullOr(Schema.String),
  pairedAt: Schema.NullOr(IsoDateTime),
});
export type MobilePairingSessionStatus = typeof MobilePairingSessionStatus.Type;

export const MobilePairRequest = Schema.Struct({
  pairingId: Schema.String,
  pairingSecret: Schema.String,
  deviceName: Schema.String,
});
export type MobilePairRequest = typeof MobilePairRequest.Type;

export const MobilePairResult = Schema.Struct({
  deviceId: Schema.String,
  token: Schema.String,
  deviceName: Schema.String,
  pairedAt: IsoDateTime,
  apiBaseUrls: Schema.Array(Schema.String),
});
export type MobilePairResult = typeof MobilePairResult.Type;

export const MobileConnectionInfo = Schema.Struct({
  version: Schema.Literal(1),
  deviceId: Schema.String,
  deviceName: Schema.String,
  pairedAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  apiBaseUrls: Schema.Array(Schema.String),
  candidates: Schema.Array(MobilePairingCandidate),
});
export type MobileConnectionInfo = typeof MobileConnectionInfo.Type;

export const MobileProject = Schema.Struct({
  id: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
});
export type MobileProject = typeof MobileProject.Type;

export const MobileMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type MobileMessage = typeof MobileMessage.Type;

export const MobilePendingApproval = Schema.Struct({
  requestId: ApprovalRequestId,
  requestKind: Schema.Literals(["command", "file-read", "file-change", "computer-use"]),
  detail: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});
export type MobilePendingApproval = typeof MobilePendingApproval.Type;

export const MobileUserInputOption = Schema.Struct({
  label: Schema.String,
  description: Schema.String,
});
export type MobileUserInputOption = typeof MobileUserInputOption.Type;

export const MobileUserInputQuestion = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(MobileUserInputOption),
});
export type MobileUserInputQuestion = typeof MobileUserInputQuestion.Type;

export const MobilePendingUserInput = Schema.Struct({
  requestId: ApprovalRequestId,
  questions: Schema.Array(MobileUserInputQuestion),
  createdAt: IsoDateTime,
});
export type MobilePendingUserInput = typeof MobilePendingUserInput.Type;

export const MobileThreadSummary = Schema.Struct({
  id: ThreadId,
  projectId: Schema.NullOr(ProjectId),
  title: Schema.String,
  status: Schema.NullOr(OrchestrationSessionStatus),
  activeTurnId: Schema.NullOr(Schema.String),
  latestMessagePreview: Schema.NullOr(Schema.String),
  hasPendingApproval: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  archivedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type MobileThreadSummary = typeof MobileThreadSummary.Type;

export const MobileFileChange = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: Schema.String,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type MobileFileChange = typeof MobileFileChange.Type;

export const MobileThreadDetail = Schema.Struct({
  id: ThreadId,
  projectId: Schema.NullOr(ProjectId),
  title: Schema.String,
  status: Schema.NullOr(OrchestrationSessionStatus),
  activeTurnId: Schema.NullOr(Schema.String),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  messages: Schema.Array(MobileMessage),
  pendingApprovals: Schema.Array(MobilePendingApproval),
  pendingUserInputs: Schema.Array(MobilePendingUserInput),
  fileChanges: Schema.Array(MobileFileChange),
  updatedAt: IsoDateTime,
});
export type MobileThreadDetail = typeof MobileThreadDetail.Type;

export const MobileProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: Schema.optional(TrimmedNonEmptyString),
  isCustom: Schema.Boolean,
  multiModal: Schema.optional(Schema.Boolean),
  capabilities: Schema.NullOr(ModelCapabilities),
});
export type MobileProviderModel = typeof MobileProviderModel.Type;

export const MobileProviderState = Schema.Literals(["ready", "warning", "error", "disabled"]);
export type MobileProviderState = typeof MobileProviderState.Type;

export const MobileProvider = Schema.Struct({
  provider: ProviderKind,
  displayName: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  status: MobileProviderState,
  models: Schema.Array(MobileProviderModel),
});
export type MobileProvider = typeof MobileProvider.Type;

export const MobileSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  snapshotSequence: NonNegativeInt,
  updatedAt: IsoDateTime,
  projects: Schema.Array(MobileProject),
  threads: Schema.Array(MobileThreadSummary),
  threadDetails: Schema.Array(MobileThreadDetail),
  providers: Schema.Array(MobileProvider),
  defaultModelSelection: Schema.NullOr(ModelSelection),
});
export type MobileSnapshot = typeof MobileSnapshot.Type;

const MobileCommandBase = {
  requestId: Schema.String,
} as const;

export const MobileCreateThreadCommand = Schema.Struct({
  ...MobileCommandBase,
  type: Schema.Literal("thread.create"),
  projectId: ProjectId,
  title: Schema.optional(Schema.String),
  initialMessage: Schema.optional(Schema.String),
  modelSelection: Schema.optional(ModelSelection),
  attachments: Schema.optional(Schema.Array(UploadChatAttachment)),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type MobileCreateThreadCommand = typeof MobileCreateThreadCommand.Type;

export const MobileSendTurnCommand = Schema.Struct({
  ...MobileCommandBase,
  type: Schema.Literal("thread.turn.start"),
  threadId: ThreadId,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(UploadChatAttachment)),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type MobileSendTurnCommand = typeof MobileSendTurnCommand.Type;

export const MobileSteerTurnCommand = Schema.Struct({
  ...MobileCommandBase,
  type: Schema.Literal("thread.turn.steer"),
  threadId: ThreadId,
  text: Schema.String,
});
export type MobileSteerTurnCommand = typeof MobileSteerTurnCommand.Type;

export const MobileSetRuntimeModeCommand = Schema.Struct({
  ...MobileCommandBase,
  type: Schema.Literal("thread.runtime-mode.set"),
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
});
export type MobileSetRuntimeModeCommand = typeof MobileSetRuntimeModeCommand.Type;

export const MobileSetInteractionModeCommand = Schema.Struct({
  ...MobileCommandBase,
  type: Schema.Literal("thread.interaction-mode.set"),
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
});
export type MobileSetInteractionModeCommand = typeof MobileSetInteractionModeCommand.Type;

export const MobileUpdateThreadModelCommand = Schema.Struct({
  ...MobileCommandBase,
  type: Schema.Literal("thread.meta.update"),
  threadId: ThreadId,
  modelSelection: ModelSelection,
});
export type MobileUpdateThreadModelCommand = typeof MobileUpdateThreadModelCommand.Type;

export const MobileInterruptTurnCommand = Schema.Struct({
  ...MobileCommandBase,
  type: Schema.Literal("thread.turn.interrupt"),
  threadId: ThreadId,
});
export type MobileInterruptTurnCommand = typeof MobileInterruptTurnCommand.Type;

export const MobileApprovalRespondCommand = Schema.Struct({
  ...MobileCommandBase,
  type: Schema.Literal("thread.approval.respond"),
  threadId: ThreadId,
  requestIdToRespondTo: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type MobileApprovalRespondCommand = typeof MobileApprovalRespondCommand.Type;

export const MobileUserInputRespondCommand = Schema.Struct({
  ...MobileCommandBase,
  type: Schema.Literal("thread.user-input.respond"),
  threadId: ThreadId,
  requestIdToRespondTo: ApprovalRequestId,
  answers: Schema.Record(Schema.String, Schema.Unknown),
});
export type MobileUserInputRespondCommand = typeof MobileUserInputRespondCommand.Type;

export const MobileArchiveThreadCommand = Schema.Struct({
  ...MobileCommandBase,
  type: Schema.Literal("thread.archive"),
  threadId: ThreadId,
});
export type MobileArchiveThreadCommand = typeof MobileArchiveThreadCommand.Type;

export const MobileUnarchiveThreadCommand = Schema.Struct({
  ...MobileCommandBase,
  type: Schema.Literal("thread.unarchive"),
  threadId: ThreadId,
});
export type MobileUnarchiveThreadCommand = typeof MobileUnarchiveThreadCommand.Type;

export const MobileCommand = Schema.Union([
  MobileCreateThreadCommand,
  MobileSendTurnCommand,
  MobileSteerTurnCommand,
  MobileUpdateThreadModelCommand,
  MobileInterruptTurnCommand,
  MobileApprovalRespondCommand,
  MobileUserInputRespondCommand,
  MobileSetRuntimeModeCommand,
  MobileSetInteractionModeCommand,
  MobileArchiveThreadCommand,
  MobileUnarchiveThreadCommand,
]);
export type MobileCommand = typeof MobileCommand.Type;

export const MobileWorkspaceEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type MobileWorkspaceEntriesResult = typeof MobileWorkspaceEntriesResult.Type;

export const MobileCommandResult = Schema.Struct({
  sequence: NonNegativeInt,
  threadId: Schema.optional(ThreadId),
});
export type MobileCommandResult = typeof MobileCommandResult.Type;
