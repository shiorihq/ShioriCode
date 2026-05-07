import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { BrowserPanelCommand, BrowserPanelCommandResult } from "./browser";
import {
  ComputerUseActionResult,
  ComputerUseClickInput,
  ComputerUseCloseSessionInput,
  ComputerUseCreateSessionInput,
  ComputerUseError,
  ComputerUseKeyInput,
  ComputerUseMoveInput,
  ComputerUsePermissionActionInput,
  ComputerUsePermissionActionResult,
  ComputerUsePermissionsSnapshot,
  ComputerUseScreenshotInput,
  ComputerUseScreenshotResult,
  ComputerUseScrollInput,
  ComputerUseSessionSnapshot,
  ComputerUseTypeInput,
} from "./computer";
import { OpenError, OpenInEditorInput } from "./editor";
import {
  GitCheckoutInput,
  GitCommandError,
  GitCreateBranchInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitListOpenPullRequestsInput,
  GitListOpenPullRequestsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestConversationInput,
  GitPullRequestConversationResult,
  GitPullRequestDiffInput,
  GitPullRequestDiffResult,
  GitPullRequestRefInput,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitStatusInput,
  GitStatusResult,
  GitSummarizePullRequestInput,
  GitSummarizePullRequestResult,
} from "./git";
import { KeybindingsConfigError } from "./keybindings";
import { OnboardingCompleteStepInput, OnboardingError, OnboardingState } from "./onboarding";
import {
  ClientOrchestrationCommand,
  OrchestrationEvent,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSubagentDetailError,
  OrchestrationGetSnapshotError,
  OrchestrationGetSnapshotInput,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsError,
  OrchestrationReplayEventsInput,
  OrchestrationRpcSchemas,
} from "./orchestration";
import {
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";
import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import {
  ServerConfigStreamEvent,
  ServerConfig,
  HostedBillingCheckoutInput,
  HostedBillingCheckoutResult,
  HostedBillingError,
  HostedAuthError,
  HostedBillingPortalInput,
  HostedBillingPortalResult,
  HostedOAuthStartInput,
  HostedOAuthStartResult,
  HostedPasswordAuthInput,
  HostedPasswordAuthResult,
  HostedBillingSnapshot,
  ServerLifecycleStreamEvent,
  ServerProviderUsageSnapshot,
  ServerProviderUpdatedPayload,
  ServerUsageProviderKind,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server";
import {
  EffectiveMcpServerAuthInput,
  EffectiveMcpServersResult,
  EffectiveMcpServerRemoveInput,
  EffectiveSkillRemoveInput,
  EffectiveSkillsResult,
  ServerSettings,
  ServerSettingsError,
  ServerSettingsPatch,
} from "./settings";
import { TelemetryCaptureInput, TelemetryLogInput } from "./telemetry";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Git methods
  gitStatus: "git.status",
  gitListBranches: "git.listBranches",
  gitCreateWorktree: "git.createWorktree",
  gitRemoveWorktree: "git.removeWorktree",
  gitCreateBranch: "git.createBranch",
  gitCheckout: "git.checkout",
  gitInit: "git.init",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",
  gitListOpenPullRequests: "git.listOpenPullRequests",
  gitGetPullRequestDiff: "git.getPullRequestDiff",
  gitSummarizePullRequest: "git.summarizePullRequest",
  gitGetPullRequestConversation: "git.getPullRequestConversation",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverListMcpServers: "server.listMcpServers",
  serverAuthenticateMcpServer: "server.authenticateMcpServer",
  serverRemoveMcpServer: "server.removeMcpServer",
  serverListSkills: "server.listSkills",
  serverRemoveSkill: "server.removeSkill",
  serverSetShioriAuthToken: "server.setShioriAuthToken",
  serverGetProviderUsage: "server.getProviderUsage",
  serverGetHostedBillingSnapshot: "server.getHostedBillingSnapshot",
  serverCreateHostedBillingCheckout: "server.createHostedBillingCheckout",
  serverCreateHostedBillingPortal: "server.createHostedBillingPortal",
  serverHostedOAuthStart: "server.hostedOAuthStart",
  serverHostedPasswordAuth: "server.hostedPasswordAuth",

  // Onboarding
  onboardingGetState: "onboarding.getState",
  onboardingCompleteStep: "onboarding.completeStep",
  onboardingReset: "onboarding.reset",

  // Telemetry
  telemetryCapture: "telemetry.capture",
  telemetryLog: "telemetry.log",

  // Streaming subscriptions
  subscribeOrchestrationDomainEvents: "subscribeOrchestrationDomainEvents",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeBrowserPanelCommands: "subscribeBrowserPanelCommands",

  // Browser panel
  browserPanelCompleteCommand: "browserPanel.completeCommand",

  // Computer Use
  computerGetPermissions: "computer.getPermissions",
  computerRequestPermission: "computer.requestPermission",
  computerShowPermissionGuide: "computer.showPermissionGuide",
  computerCreateSession: "computer.createSession",
  computerCloseSession: "computer.closeSession",
  computerScreenshot: "computer.screenshot",
  computerClick: "computer.click",
  computerMove: "computer.move",
  computerType: "computer.type",
  computerKey: "computer.key",
  computerScroll: "computer.scroll",
} as const;

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: KeybindingsConfigError,
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({}),
  success: ServerProviderUpdatedPayload,
});

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: ServerSettingsError,
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: ServerSettingsError,
});

export const WsServerListMcpServersRpc = Rpc.make(WS_METHODS.serverListMcpServers, {
  payload: Schema.Struct({}),
  success: EffectiveMcpServersResult,
  error: ServerSettingsError,
});

export const WsServerAuthenticateMcpServerRpc = Rpc.make(WS_METHODS.serverAuthenticateMcpServer, {
  payload: EffectiveMcpServerAuthInput,
  success: Schema.Struct({}),
  error: ServerSettingsError,
});

export const WsServerRemoveMcpServerRpc = Rpc.make(WS_METHODS.serverRemoveMcpServer, {
  payload: EffectiveMcpServerRemoveInput,
  success: Schema.Struct({}),
  error: ServerSettingsError,
});

export const WsServerListSkillsRpc = Rpc.make(WS_METHODS.serverListSkills, {
  payload: Schema.Struct({}),
  success: EffectiveSkillsResult,
  error: ServerSettingsError,
});

export const WsServerRemoveSkillRpc = Rpc.make(WS_METHODS.serverRemoveSkill, {
  payload: EffectiveSkillRemoveInput,
  success: Schema.Struct({}),
  error: ServerSettingsError,
});

export const WsServerSetShioriAuthTokenRpc = Rpc.make(WS_METHODS.serverSetShioriAuthToken, {
  payload: Schema.Struct({ token: Schema.NullOr(Schema.String) }),
  success: Schema.Struct({}),
});

export const WsServerGetProviderUsageRpc = Rpc.make(WS_METHODS.serverGetProviderUsage, {
  payload: Schema.Struct({ provider: ServerUsageProviderKind }),
  success: ServerProviderUsageSnapshot,
});

export const WsServerGetHostedBillingSnapshotRpc = Rpc.make(
  WS_METHODS.serverGetHostedBillingSnapshot,
  {
    payload: Schema.Struct({}),
    success: HostedBillingSnapshot,
    error: HostedBillingError,
  },
);

export const WsServerCreateHostedBillingCheckoutRpc = Rpc.make(
  WS_METHODS.serverCreateHostedBillingCheckout,
  {
    payload: HostedBillingCheckoutInput,
    success: HostedBillingCheckoutResult,
    error: HostedBillingError,
  },
);

export const WsServerCreateHostedBillingPortalRpc = Rpc.make(
  WS_METHODS.serverCreateHostedBillingPortal,
  {
    payload: HostedBillingPortalInput,
    success: HostedBillingPortalResult,
    error: HostedBillingError,
  },
);

export const WsServerHostedOAuthStartRpc = Rpc.make(WS_METHODS.serverHostedOAuthStart, {
  payload: HostedOAuthStartInput,
  success: HostedOAuthStartResult,
  error: HostedAuthError,
});

export const WsServerHostedPasswordAuthRpc = Rpc.make(WS_METHODS.serverHostedPasswordAuth, {
  payload: HostedPasswordAuthInput,
  success: HostedPasswordAuthResult,
  error: HostedAuthError,
});

export const WsOnboardingGetStateRpc = Rpc.make(WS_METHODS.onboardingGetState, {
  payload: Schema.Struct({}),
  success: OnboardingState,
  error: OnboardingError,
});

export const WsOnboardingCompleteStepRpc = Rpc.make(WS_METHODS.onboardingCompleteStep, {
  payload: OnboardingCompleteStepInput,
  success: OnboardingState,
  error: OnboardingError,
});

export const WsOnboardingResetRpc = Rpc.make(WS_METHODS.onboardingReset, {
  payload: Schema.Struct({}),
  success: OnboardingState,
  error: OnboardingError,
});

export const WsTelemetryCaptureRpc = Rpc.make(WS_METHODS.telemetryCapture, {
  payload: TelemetryCaptureInput,
  success: Schema.Struct({}),
});

export const WsTelemetryLogRpc = Rpc.make(WS_METHODS.telemetryLog, {
  payload: TelemetryLogInput,
  success: Schema.Struct({}),
});

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: ProjectSearchEntriesError,
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: ProjectWriteFileError,
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: OpenInEditorInput,
  error: OpenError,
});

export const WsGitStatusRpc = Rpc.make(WS_METHODS.gitStatus, {
  payload: GitStatusInput,
  success: GitStatusResult,
  error: GitManagerServiceError,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: GitManagerServiceError,
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: GitManagerServiceError,
});

export const WsGitListBranchesRpc = Rpc.make(WS_METHODS.gitListBranches, {
  payload: GitListBranchesInput,
  success: GitListBranchesResult,
  error: GitCommandError,
});

export const WsGitCreateWorktreeRpc = Rpc.make(WS_METHODS.gitCreateWorktree, {
  payload: GitCreateWorktreeInput,
  success: GitCreateWorktreeResult,
  error: GitCommandError,
});

export const WsGitRemoveWorktreeRpc = Rpc.make(WS_METHODS.gitRemoveWorktree, {
  payload: GitRemoveWorktreeInput,
  error: GitCommandError,
});

export const WsGitCreateBranchRpc = Rpc.make(WS_METHODS.gitCreateBranch, {
  payload: GitCreateBranchInput,
  error: GitCommandError,
});

export const WsGitCheckoutRpc = Rpc.make(WS_METHODS.gitCheckout, {
  payload: GitCheckoutInput,
  error: GitCommandError,
});

export const WsGitInitRpc = Rpc.make(WS_METHODS.gitInit, {
  payload: GitInitInput,
  error: GitCommandError,
});

export const WsGitListOpenPullRequestsRpc = Rpc.make(WS_METHODS.gitListOpenPullRequests, {
  payload: GitListOpenPullRequestsInput,
  success: GitListOpenPullRequestsResult,
  error: GitManagerServiceError,
});

export const WsGitGetPullRequestDiffRpc = Rpc.make(WS_METHODS.gitGetPullRequestDiff, {
  payload: GitPullRequestDiffInput,
  success: GitPullRequestDiffResult,
  error: GitManagerServiceError,
});

export const WsGitSummarizePullRequestRpc = Rpc.make(WS_METHODS.gitSummarizePullRequest, {
  payload: GitSummarizePullRequestInput,
  success: GitSummarizePullRequestResult,
  error: GitManagerServiceError,
});

export const WsGitGetPullRequestConversationRpc = Rpc.make(
  WS_METHODS.gitGetPullRequestConversation,
  {
    payload: GitPullRequestConversationInput,
    success: GitPullRequestConversationResult,
    error: GitManagerServiceError,
  },
);

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: TerminalError,
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: TerminalError,
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: TerminalError,
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: TerminalError,
});

export const WsOrchestrationGetSnapshotRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getSnapshot, {
  payload: OrchestrationGetSnapshotInput,
  success: OrchestrationRpcSchemas.getSnapshot.output,
  error: OrchestrationGetSnapshotError,
});

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: OrchestrationDispatchCommandError,
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: OrchestrationGetTurnDiffError,
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: OrchestrationGetFullThreadDiffError,
  },
);

export const WsOrchestrationGetSubagentDetailRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getSubagentDetail,
  {
    payload: OrchestrationRpcSchemas.getSubagentDetail.input,
    success: OrchestrationRpcSchemas.getSubagentDetail.output,
    error: OrchestrationGetSubagentDetailError,
  },
);

export const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationReplayEventsInput,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: OrchestrationReplayEventsError,
});

export const WsSubscribeOrchestrationDomainEventsRpc = Rpc.make(
  WS_METHODS.subscribeOrchestrationDomainEvents,
  {
    payload: Schema.Struct({}),
    success: OrchestrationEvent,
    stream: true,
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  stream: true,
});

export const WsSubscribeBrowserPanelCommandsRpc = Rpc.make(
  WS_METHODS.subscribeBrowserPanelCommands,
  {
    payload: Schema.Struct({}),
    success: BrowserPanelCommand,
    stream: true,
  },
);

export const WsBrowserPanelCompleteCommandRpc = Rpc.make(WS_METHODS.browserPanelCompleteCommand, {
  payload: BrowserPanelCommandResult,
  success: Schema.Struct({}),
});

export const WsComputerGetPermissionsRpc = Rpc.make(WS_METHODS.computerGetPermissions, {
  payload: Schema.Struct({}),
  success: ComputerUsePermissionsSnapshot,
  error: ComputerUseError,
});

export const WsComputerRequestPermissionRpc = Rpc.make(WS_METHODS.computerRequestPermission, {
  payload: ComputerUsePermissionActionInput,
  success: ComputerUsePermissionActionResult,
  error: ComputerUseError,
});

export const WsComputerShowPermissionGuideRpc = Rpc.make(WS_METHODS.computerShowPermissionGuide, {
  payload: ComputerUsePermissionActionInput,
  success: ComputerUsePermissionActionResult,
  error: ComputerUseError,
});

export const WsComputerCreateSessionRpc = Rpc.make(WS_METHODS.computerCreateSession, {
  payload: ComputerUseCreateSessionInput,
  success: ComputerUseSessionSnapshot,
  error: ComputerUseError,
});

export const WsComputerCloseSessionRpc = Rpc.make(WS_METHODS.computerCloseSession, {
  payload: ComputerUseCloseSessionInput,
  success: Schema.Struct({}),
  error: ComputerUseError,
});

export const WsComputerScreenshotRpc = Rpc.make(WS_METHODS.computerScreenshot, {
  payload: ComputerUseScreenshotInput,
  success: ComputerUseScreenshotResult,
  error: ComputerUseError,
});

export const WsComputerClickRpc = Rpc.make(WS_METHODS.computerClick, {
  payload: ComputerUseClickInput,
  success: ComputerUseActionResult,
  error: ComputerUseError,
});

export const WsComputerMoveRpc = Rpc.make(WS_METHODS.computerMove, {
  payload: ComputerUseMoveInput,
  success: ComputerUseActionResult,
  error: ComputerUseError,
});

export const WsComputerTypeRpc = Rpc.make(WS_METHODS.computerType, {
  payload: ComputerUseTypeInput,
  success: ComputerUseActionResult,
  error: ComputerUseError,
});

export const WsComputerKeyRpc = Rpc.make(WS_METHODS.computerKey, {
  payload: ComputerUseKeyInput,
  success: ComputerUseActionResult,
  error: ComputerUseError,
});

export const WsComputerScrollRpc = Rpc.make(WS_METHODS.computerScroll, {
  payload: ComputerUseScrollInput,
  success: ComputerUseActionResult,
  error: ComputerUseError,
});

export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpsertKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerListMcpServersRpc,
  WsServerAuthenticateMcpServerRpc,
  WsServerRemoveMcpServerRpc,
  WsServerListSkillsRpc,
  WsServerRemoveSkillRpc,
  WsServerSetShioriAuthTokenRpc,
  WsServerGetProviderUsageRpc,
  WsServerGetHostedBillingSnapshotRpc,
  WsServerCreateHostedBillingCheckoutRpc,
  WsServerCreateHostedBillingPortalRpc,
  WsServerHostedOAuthStartRpc,
  WsServerHostedPasswordAuthRpc,
  WsOnboardingGetStateRpc,
  WsOnboardingCompleteStepRpc,
  WsOnboardingResetRpc,
  WsTelemetryCaptureRpc,
  WsTelemetryLogRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsShellOpenInEditorRpc,
  WsGitStatusRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsGitListBranchesRpc,
  WsGitCreateWorktreeRpc,
  WsGitRemoveWorktreeRpc,
  WsGitCreateBranchRpc,
  WsGitCheckoutRpc,
  WsGitInitRpc,
  WsGitListOpenPullRequestsRpc,
  WsGitGetPullRequestDiffRpc,
  WsGitSummarizePullRequestRpc,
  WsGitGetPullRequestConversationRpc,
  WsTerminalOpenRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeOrchestrationDomainEventsRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeBrowserPanelCommandsRpc,
  WsBrowserPanelCompleteCommandRpc,
  WsComputerGetPermissionsRpc,
  WsComputerRequestPermissionRpc,
  WsComputerShowPermissionGuideRpc,
  WsComputerCreateSessionRpc,
  WsComputerCloseSessionRpc,
  WsComputerScreenshotRpc,
  WsComputerClickRpc,
  WsComputerMoveRpc,
  WsComputerTypeRpc,
  WsComputerKeyRpc,
  WsComputerScrollRpc,
  WsOrchestrationGetSnapshotRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationGetSubagentDetailRpc,
  WsOrchestrationReplayEventsRpc,
);
