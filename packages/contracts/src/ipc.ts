import type {
  GitCheckoutInput,
  GitCreateBranchInput,
  GitListOpenPullRequestsInput,
  GitListOpenPullRequestsResult,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestConversationInput,
  GitPullRequestConversationResult,
  GitPullRequestDiffInput,
  GitPullRequestDiffResult,
  GitPullRequestRefInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitStatusInput,
  GitStatusResult,
  GitSummarizePullRequestInput,
  GitSummarizePullRequestResult,
} from "./git";
import type {
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";
import type {
  HostedBillingCheckoutInput,
  HostedBillingCheckoutResult,
  HostedBillingPortalFlow,
  HostedBillingPortalResult,
  HostedBillingSnapshot,
  ServerConfig,
  ServerProviderUsageSnapshot,
  ServerProviderUpdatedPayload,
  ServerUpsertKeybindingResult,
} from "./server";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import type { ServerUpsertKeybindingInput } from "./server";
import type {
  ClientOrchestrationCommand,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetSubagentDetailInput,
  OrchestrationSubagentDetail,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "./orchestration";
import type { OnboardingCompleteStepInput, OnboardingState } from "./onboarding";
import { EditorId } from "./editor";
import {
  EffectiveMcpServerAuthInput,
  EffectiveMcpServersResult,
  EffectiveMcpServerRemoveInput,
  EffectiveSkillRemoveInput,
  EffectiveSkillsResult,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings";
import type { TelemetryCaptureInput, TelemetryLogInput } from "./telemetry";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
}

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopTheme = "light" | "dark" | "system";

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export interface DesktopUpdateCheckResult {
  checked: boolean;
  state: DesktopUpdateState;
}

export interface DesktopWindowControlsInset {
  left: number;
}

export type DesktopCompanionCliStatus = "not-installed" | "installing" | "installed" | "error";

export interface DesktopCompanionCliState {
  status: DesktopCompanionCliStatus;
  version: string | null;
  binaryPath: string | null;
  lastError: string | null;
  installCommand: string | null;
}

export interface DesktopCompanionCliInstallResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopCompanionCliState;
}

export interface DesktopBridge {
  getWsUrl: () => string | null;
  getWindowControlsInset?: () => Promise<DesktopWindowControlsInset | null>;
  listSystemFonts?: () => Promise<string[]>;
  pickFolder: () => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  setVibrancy: (enabled: boolean) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  getCompanionCliState: () => Promise<DesktopCompanionCliState>;
  installCompanionCli: () => Promise<DesktopCompanionCliInstallResult>;
}

export interface NativeApi {
  dialogs: {
    pickFolder: () => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  terminal: {
    open: (input: typeof TerminalOpenInput.Encoded) => Promise<TerminalSessionSnapshot>;
    write: (input: typeof TerminalWriteInput.Encoded) => Promise<void>;
    resize: (input: typeof TerminalResizeInput.Encoded) => Promise<void>;
    clear: (input: typeof TerminalClearInput.Encoded) => Promise<void>;
    restart: (input: typeof TerminalRestartInput.Encoded) => Promise<TerminalSessionSnapshot>;
    close: (input: typeof TerminalCloseInput.Encoded) => Promise<void>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
  };
  projects: {
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  git: {
    // Existing branch/worktree API
    listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
    createBranch: (input: GitCreateBranchInput) => Promise<void>;
    checkout: (input: GitCheckoutInput) => Promise<void>;
    init: (input: GitInitInput) => Promise<void>;
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
    listOpenPullRequests: (
      input: GitListOpenPullRequestsInput,
    ) => Promise<GitListOpenPullRequestsResult>;
    getPullRequestDiff: (input: GitPullRequestDiffInput) => Promise<GitPullRequestDiffResult>;
    summarizePullRequest: (
      input: GitSummarizePullRequestInput,
    ) => Promise<GitSummarizePullRequestResult>;
    getPullRequestConversation: (
      input: GitPullRequestConversationInput,
    ) => Promise<GitPullRequestConversationResult>;
    status: (input: GitStatusInput) => Promise<GitStatusResult>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    refreshProviders: () => Promise<ServerProviderUpdatedPayload>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
    getSettings: () => Promise<ServerSettings>;
    updateSettings: (patch: ServerSettingsPatch) => Promise<ServerSettings>;
    listMcpServers: () => Promise<EffectiveMcpServersResult>;
    authenticateMcpServer: (input: EffectiveMcpServerAuthInput) => Promise<void>;
    removeMcpServer: (input: EffectiveMcpServerRemoveInput) => Promise<void>;
    listSkills: () => Promise<EffectiveSkillsResult>;
    removeSkill: (input: EffectiveSkillRemoveInput) => Promise<void>;
    setShioriAuthToken: (token: string | null) => Promise<void>;
    getProviderUsage: (provider: "codex" | "claudeAgent") => Promise<ServerProviderUsageSnapshot>;
    getHostedBillingSnapshot: () => Promise<HostedBillingSnapshot>;
    createHostedBillingCheckout: (
      input: HostedBillingCheckoutInput,
    ) => Promise<HostedBillingCheckoutResult>;
    createHostedBillingPortal: (
      flow: HostedBillingPortalFlow,
    ) => Promise<HostedBillingPortalResult>;
  };
  orchestration: {
    getSnapshot: () => Promise<OrchestrationReadModel>;
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    getSubagentDetail: (
      input: OrchestrationGetSubagentDetailInput,
    ) => Promise<OrchestrationSubagentDetail>;
    replayEvents: (fromSequenceExclusive: number) => Promise<OrchestrationEvent[]>;
    onDomainEvent: (callback: (event: OrchestrationEvent) => void) => () => void;
  };
  onboarding: {
    getState: () => Promise<OnboardingState>;
    completeStep: (input: OnboardingCompleteStepInput) => Promise<OnboardingState>;
    reset: () => Promise<OnboardingState>;
  };
  telemetry: {
    capture: (input: TelemetryCaptureInput) => Promise<void>;
    log: (input: TelemetryLogInput) => Promise<void>;
  };
}
