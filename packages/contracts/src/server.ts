import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";
import { EditorId } from "./editor";
import { ModelCapabilities } from "./model";
import { ProviderKind } from "./orchestration";
import { ServerSettings } from "./settings";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

const ServerConfigIssues = Schema.Array(ServerConfigIssue);

export const ServerProviderState = Schema.Literals(["ready", "warning", "error", "disabled"]);
export type ServerProviderState = typeof ServerProviderState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderAuth = Schema.Struct({
  status: ServerProviderAuthStatus,
  type: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderAuth = typeof ServerProviderAuth.Type;

export const ServerProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  isCustom: Schema.Boolean,
  multiModal: Schema.optional(Schema.Boolean),
  capabilities: Schema.NullOr(ModelCapabilities),
});
export type ServerProviderModel = typeof ServerProviderModel.Type;

export const ServerProvider = Schema.Struct({
  provider: ProviderKind,
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  status: ServerProviderState,
  auth: ServerProviderAuth,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(ServerProviderModel),
});
export type ServerProvider = typeof ServerProvider.Type;

export const ServerProviders = Schema.Array(ServerProvider);
export type ServerProviders = typeof ServerProviders.Type;

export const ServerConfig = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  serverInstancePath: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviders,
  availableEditors: Schema.Array(EditorId),
  settings: ServerSettings,
});
export type ServerConfig = typeof ServerConfig.Type;

export const ServerUpsertKeybindingInput = KeybindingRule;
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviders,
  settings: Schema.optional(ServerSettings),
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;

export const ServerConfigKeybindingsUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
});
export type ServerConfigKeybindingsUpdatedPayload =
  typeof ServerConfigKeybindingsUpdatedPayload.Type;

export const ServerConfigProviderStatusesPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerConfigProviderStatusesPayload = typeof ServerConfigProviderStatusesPayload.Type;

export const ServerConfigSettingsUpdatedPayload = Schema.Struct({
  settings: ServerSettings,
});
export type ServerConfigSettingsUpdatedPayload = typeof ServerConfigSettingsUpdatedPayload.Type;

export const ServerConfigStreamSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("snapshot"),
  config: ServerConfig,
});
export type ServerConfigStreamSnapshotEvent = typeof ServerConfigStreamSnapshotEvent.Type;

export const ServerConfigStreamKeybindingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("keybindingsUpdated"),
  payload: ServerConfigKeybindingsUpdatedPayload,
});
export type ServerConfigStreamKeybindingsUpdatedEvent =
  typeof ServerConfigStreamKeybindingsUpdatedEvent.Type;

export const ServerConfigStreamProviderStatusesEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("providerStatuses"),
  payload: ServerConfigProviderStatusesPayload,
});
export type ServerConfigStreamProviderStatusesEvent =
  typeof ServerConfigStreamProviderStatusesEvent.Type;

export const ServerConfigStreamSettingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("settingsUpdated"),
  payload: ServerConfigSettingsUpdatedPayload,
});
export type ServerConfigStreamSettingsUpdatedEvent =
  typeof ServerConfigStreamSettingsUpdatedEvent.Type;

export const ServerConfigStreamEvent = Schema.Union([
  ServerConfigStreamSnapshotEvent,
  ServerConfigStreamKeybindingsUpdatedEvent,
  ServerConfigStreamProviderStatusesEvent,
  ServerConfigStreamSettingsUpdatedEvent,
]);
export type ServerConfigStreamEvent = typeof ServerConfigStreamEvent.Type;

export const ServerLifecycleReadyPayload = Schema.Struct({
  at: IsoDateTime,
});
export type ServerLifecycleReadyPayload = typeof ServerLifecycleReadyPayload.Type;

export const ServerLifecycleWelcomePayload = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
});
export type ServerLifecycleWelcomePayload = typeof ServerLifecycleWelcomePayload.Type;

export const ServerLifecycleStreamWelcomeEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("welcome"),
  payload: ServerLifecycleWelcomePayload,
});
export type ServerLifecycleStreamWelcomeEvent = typeof ServerLifecycleStreamWelcomeEvent.Type;

export const ServerLifecycleStreamReadyEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("ready"),
  payload: ServerLifecycleReadyPayload,
});
export type ServerLifecycleStreamReadyEvent = typeof ServerLifecycleStreamReadyEvent.Type;

export const ServerLifecycleStreamEvent = Schema.Union([
  ServerLifecycleStreamWelcomeEvent,
  ServerLifecycleStreamReadyEvent,
]);
export type ServerLifecycleStreamEvent = typeof ServerLifecycleStreamEvent.Type;

export const ServerProviderUpdatedPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerProviderUpdatedPayload = typeof ServerProviderUpdatedPayload.Type;

export const ServerUsageProviderKind = Schema.Literals(["codex", "claudeAgent"]);
export type ServerUsageProviderKind = typeof ServerUsageProviderKind.Type;

export const ServerUsageWindow = Schema.Struct({
  usedPercent: Schema.NullOr(Schema.Number),
  resetsAt: Schema.NullOr(IsoDateTime),
  windowDurationMinutes: Schema.optional(Schema.NullOr(NonNegativeInt)),
});
export type ServerUsageWindow = typeof ServerUsageWindow.Type;

export const ServerCodexUsageSnapshot = Schema.Struct({
  provider: Schema.Literal("codex"),
  source: Schema.Literal("app-server"),
  available: Schema.Boolean,
  unavailableReason: Schema.NullOr(TrimmedNonEmptyString),
  primary: Schema.NullOr(ServerUsageWindow),
  secondary: Schema.NullOr(ServerUsageWindow),
});
export type ServerCodexUsageSnapshot = typeof ServerCodexUsageSnapshot.Type;

export const ServerClaudeUsageSnapshot = Schema.Struct({
  provider: Schema.Literal("claudeAgent"),
  source: Schema.Literal("oauth-api"),
  available: Schema.Boolean,
  unavailableReason: Schema.NullOr(TrimmedNonEmptyString),
  fiveHour: Schema.NullOr(ServerUsageWindow),
  sevenDay: Schema.NullOr(ServerUsageWindow),
});
export type ServerClaudeUsageSnapshot = typeof ServerClaudeUsageSnapshot.Type;

export const ServerProviderUsageSnapshot = Schema.Union([
  ServerCodexUsageSnapshot,
  ServerClaudeUsageSnapshot,
]);
export type ServerProviderUsageSnapshot = typeof ServerProviderUsageSnapshot.Type;

export const HostedBillingPlanId = Schema.Literals(["plus", "pro", "max"]);
export type HostedBillingPlanId = typeof HostedBillingPlanId.Type;

export const HostedBillingPortalFlow = Schema.Literals(["manage", "cancel"]);
export type HostedBillingPortalFlow = typeof HostedBillingPortalFlow.Type;

export const HostedBillingPlan = Schema.Struct({
  id: HostedBillingPlanId,
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  monthlyPrice: NonNegativeInt,
  annualPrice: Schema.NullOr(NonNegativeInt),
  sortOrder: NonNegativeInt,
  highlighted: Schema.Boolean,
  buttonText: Schema.NullOr(TrimmedNonEmptyString),
  features: Schema.Array(TrimmedNonEmptyString),
});
export type HostedBillingPlan = typeof HostedBillingPlan.Type;

export const HostedBillingSnapshot = Schema.Struct({
  plans: Schema.Array(HostedBillingPlan),
});
export type HostedBillingSnapshot = typeof HostedBillingSnapshot.Type;

export const HostedBillingCheckoutInput = Schema.Struct({
  planId: HostedBillingPlanId,
  isAnnual: Schema.Boolean,
});
export type HostedBillingCheckoutInput = typeof HostedBillingCheckoutInput.Type;

export const HostedBillingCheckoutResult = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
});
export type HostedBillingCheckoutResult = typeof HostedBillingCheckoutResult.Type;

export const HostedBillingPortalInput = Schema.Struct({
  flow: HostedBillingPortalFlow,
});
export type HostedBillingPortalInput = typeof HostedBillingPortalInput.Type;

export const HostedBillingPortalResult = Schema.Struct({
  url: TrimmedNonEmptyString,
});
export type HostedBillingPortalResult = typeof HostedBillingPortalResult.Type;

export const HostedPasswordAuthFlow = Schema.Literals([
  "signIn",
  "signUp",
  "email-verification",
  "reset",
  "reset-verification",
]);
export type HostedPasswordAuthFlow = typeof HostedPasswordAuthFlow.Type;

export const HostedPasswordAuthInput = Schema.Struct({
  flow: HostedPasswordAuthFlow,
  email: Schema.optional(TrimmedNonEmptyString),
  password: Schema.optional(TrimmedNonEmptyString),
  code: Schema.optional(TrimmedNonEmptyString),
  newPassword: Schema.optional(TrimmedNonEmptyString),
});
export type HostedPasswordAuthInput = typeof HostedPasswordAuthInput.Type;

export const HostedPasswordAuthResult = Schema.Struct({
  signingIn: Schema.Boolean,
  token: Schema.NullOr(TrimmedNonEmptyString),
  refreshToken: Schema.NullOr(TrimmedNonEmptyString),
});
export type HostedPasswordAuthResult = typeof HostedPasswordAuthResult.Type;

export const HostedBillingErrorCode = Schema.Literals([
  "configuration",
  "authentication",
  "authorization",
  "unavailable",
  "requestFailed",
]);
export type HostedBillingErrorCode = typeof HostedBillingErrorCode.Type;

export class HostedBillingError extends Schema.TaggedErrorClass<HostedBillingError>()(
  "HostedBillingError",
  {
    code: HostedBillingErrorCode,
    message: TrimmedNonEmptyString,
    status: Schema.optional(NonNegativeInt),
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const HostedAuthErrorCode = Schema.Literals([
  "configuration",
  "authentication",
  "unavailable",
  "requestFailed",
]);
export type HostedAuthErrorCode = typeof HostedAuthErrorCode.Type;

export class HostedAuthError extends Schema.TaggedErrorClass<HostedAuthError>()("HostedAuthError", {
  code: HostedAuthErrorCode,
  message: TrimmedNonEmptyString,
  status: Schema.optional(NonNegativeInt),
  cause: Schema.optional(Schema.Defect),
}) {}
