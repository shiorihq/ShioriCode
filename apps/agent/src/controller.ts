import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderKind,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type ServerConfig,
  type ServerProvider,
  type ServerSettingsPatch,
} from "contracts";
import {
  buildSidebarThreadsById,
  projectReadModelToClientSnapshot,
  type ClientProjectionSnapshot,
} from "shared/orchestrationClientProjection";
import type { Thread } from "shared/orchestrationClientTypes";
import {
  createThreadForProject,
  ensureProjectForCwd,
  resolveCliBaseDir,
  resolveStartupThreadSelection,
  sendThreadMessage,
  connectOrStartBackend,
  type CliContext,
} from "shared/shioriCodeClient";
import {
  normalizeClaudeModelOptionsWithCapabilities,
  normalizeCodexModelOptionsWithCapabilities,
  normalizeCursorModelOptionsWithCapabilities,
  normalizeKimiCodeModelOptionsWithCapabilities,
  normalizeShioriModelOptionsWithCapabilities,
} from "shared/model";
import type { WsRpcClient } from "shared/wsRpc";

export interface AgentLaunchOptions {
  readonly baseDir?: string;
  readonly cwd?: string;
  readonly projectId?: string;
  readonly threadId?: string;
  readonly newThread?: boolean;
}

export interface AgentControllerState {
  readonly phase: "loading" | "ready" | "error";
  readonly baseDir: string;
  readonly cwd: string;
  readonly serverConfig: ServerConfig | null;
  readonly projection: ClientProjectionSnapshot;
  readonly selectedThreadId: ThreadId | null;
  readonly error: string | null;
  readonly notice: string | null;
}

export interface AgentController {
  readonly getState: () => AgentControllerState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly initialize: () => Promise<void>;
  readonly dispose: () => Promise<void>;
  readonly selectThread: (threadId: ThreadId) => void;
  readonly createThread: () => Promise<void>;
  readonly archiveSelectedThread: () => Promise<void>;
  readonly sendMessage: (text: string) => Promise<void>;
  readonly interruptSelectedThread: () => Promise<void>;
  readonly updateThreadModelSelection: (selection: ModelSelection) => Promise<void>;
  readonly setThreadRuntimeMode: (runtimeMode: RuntimeMode) => Promise<void>;
  readonly setThreadInteractionMode: (interactionMode: ProviderInteractionMode) => Promise<void>;
  readonly respondToApproval: (
    requestId: string,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  readonly respondToUserInput: (
    requestId: string,
    answers: ProviderUserInputAnswers,
  ) => Promise<void>;
  readonly refreshProviders: () => Promise<void>;
  readonly updateServerSettings: (patch: ServerSettingsPatch) => Promise<void>;
  readonly setShioriAuthToken: (token: string | null) => Promise<void>;
  readonly runProviderLogin: (provider: "codex" | "claudeAgent") => Promise<void>;
}

const emptyProjection: ClientProjectionSnapshot = {
  projects: [],
  threads: [],
  threadIndexById: {},
  sidebarThreadsById: {},
  threadIdsByProjectId: {},
};

function asErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function getProviderSnapshot(
  serverConfig: ServerConfig | null,
  provider: ProviderKind,
): ServerProvider | null {
  return serverConfig?.providers.find((entry) => entry.provider === provider) ?? null;
}

function getProviderModels(serverConfig: ServerConfig | null, provider: ProviderKind) {
  return getProviderSnapshot(serverConfig, provider)?.models ?? [];
}

function normalizeSelectionWithCapabilities(
  selection: ModelSelection,
  serverConfig: ServerConfig | null,
): ModelSelection {
  const caps =
    getProviderModels(serverConfig, selection.provider).find(
      (model) => model.slug === selection.model,
    )?.capabilities ?? null;
  if (!caps) {
    return selection;
  }

  switch (selection.provider) {
    case "codex": {
      const options = selection.options
        ? normalizeCodexModelOptionsWithCapabilities(caps, selection.options)
        : undefined;
      return {
        provider: selection.provider,
        model: selection.model,
        ...(options ? { options } : {}),
      };
    }
    case "claudeAgent": {
      const options = selection.options
        ? normalizeClaudeModelOptionsWithCapabilities(caps, selection.options)
        : undefined;
      return {
        provider: selection.provider,
        model: selection.model,
        ...(options ? { options } : {}),
      };
    }
    case "shiori": {
      const options = selection.options
        ? normalizeShioriModelOptionsWithCapabilities(caps, selection.options)
        : undefined;
      return {
        provider: selection.provider,
        model: selection.model,
        ...(options ? { options } : {}),
      };
    }
    case "kimiCode": {
      const options = selection.options
        ? normalizeKimiCodeModelOptionsWithCapabilities(caps, selection.options)
        : undefined;
      return {
        provider: selection.provider,
        model: selection.model,
        ...(options ? { options } : {}),
      };
    }
    case "gemini":
      return selection;
    case "cursor": {
      const options = selection.options
        ? normalizeCursorModelOptionsWithCapabilities(caps, selection.options)
        : undefined;
      return {
        provider: selection.provider,
        model: selection.model,
        ...(options ? { options } : {}),
      };
    }
  }
}

function defaultModelSelectionForProvider(
  serverConfig: ServerConfig | null,
  provider: ProviderKind,
): ModelSelection {
  const models = getProviderModels(serverConfig, provider);
  const model = models[0]?.slug ?? DEFAULT_MODEL_BY_PROVIDER[provider];
  return normalizeSelectionWithCapabilities({ provider, model }, serverConfig);
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

export function resolveSelectedThreadId(
  projection: ClientProjectionSnapshot,
  selectedThreadId: ThreadId | null,
): ThreadId | null {
  if (selectedThreadId && projection.threadIndexById[selectedThreadId] !== undefined) {
    return selectedThreadId;
  }
  return null;
}

class RealAgentController implements AgentController {
  private readonly listeners = new Set<() => void>();
  private readonly baseDir: string;
  private readonly cwd: string;
  private readonly launchOptions: AgentLaunchOptions;
  private state: AgentControllerState;
  private rpc: WsRpcClient | null = null;
  private rawContext: CliContext | null = null;
  private preferredProjectId: ProjectId | null = null;
  private cleanupFns: Array<() => void> = [];
  private snapshotRefreshInFlight: Promise<void> | null = null;
  private snapshotRefreshQueued = false;
  private configRefreshInFlight: Promise<void> | null = null;
  private configRefreshQueued = false;

  constructor(options: AgentLaunchOptions) {
    this.baseDir = resolveCliBaseDir(options.baseDir);
    this.cwd = options.cwd ?? process.cwd();
    this.launchOptions = options;
    this.state = {
      phase: "loading",
      baseDir: this.baseDir,
      cwd: this.cwd,
      serverConfig: null,
      projection: emptyProjection,
      selectedThreadId: null,
      error: null,
      notice: null,
    };
  }

  getState = () => {
    return this.state;
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private setState(nextState: Partial<AgentControllerState>) {
    this.state = {
      ...this.state,
      ...nextState,
    };
    this.emit();
  }

  private setError(error: string | null) {
    this.setState({
      error,
      phase: error ? "error" : this.state.phase === "loading" ? "loading" : "ready",
    });
  }

  private setNotice(notice: string | null) {
    this.setState({ notice });
  }

  private getSelectedThread(): Thread | null {
    const selectedThreadId = this.state.selectedThreadId;
    if (!selectedThreadId) {
      return null;
    }
    const index = this.state.projection.threadIndexById[selectedThreadId];
    return index === undefined ? null : (this.state.projection.threads[index] ?? null);
  }

  async initialize() {
    try {
      this.rpc = await connectOrStartBackend(this.baseDir);
      const [serverConfig, snapshot] = await Promise.all([
        this.rpc.server.getConfig(),
        this.rpc.orchestration.getSnapshot(),
      ]);

      this.rawContext = {
        baseDir: this.baseDir,
        rpc: this.rpc,
        snapshot,
      };

      let startupThreadId: ThreadId | null = null;
      if (this.launchOptions.threadId || this.launchOptions.newThread) {
        const startupSelection = await resolveStartupThreadSelection({
          rpc: this.rpc,
          snapshot,
          cwd: this.cwd,
          ...(this.launchOptions.projectId ? { projectId: this.launchOptions.projectId } : {}),
          ...(this.launchOptions.threadId ? { threadId: this.launchOptions.threadId } : {}),
          ...(this.launchOptions.newThread ? { newThread: true } : {}),
        });
        this.preferredProjectId = startupSelection.projectId;
        startupThreadId = startupSelection.threadId;
      } else {
        this.preferredProjectId = this.launchOptions.projectId
          ? ProjectId.makeUnsafe(this.launchOptions.projectId)
          : await ensureProjectForCwd(this.rpc, snapshot, this.cwd);
      }

      await Promise.all([this.refreshConfig(serverConfig), this.refreshSnapshot(startupThreadId)]);

      this.cleanupFns.push(
        this.rpc.server.subscribeConfig((event) => {
          if (
            event.type === "snapshot" ||
            event.type === "providerStatuses" ||
            event.type === "settingsUpdated"
          ) {
            void this.queueConfigRefresh();
          }
        }),
      );
      this.cleanupFns.push(
        this.rpc.orchestration.onDomainEvent(() => {
          void this.queueSnapshotRefresh();
        }),
      );
    } catch (error) {
      this.setState({
        phase: "error",
        error: asErrorMessage(error),
      });
    }
  }

  async dispose() {
    for (const cleanup of this.cleanupFns) {
      cleanup();
    }
    this.cleanupFns = [];
    if (this.rpc) {
      await this.rpc.dispose();
      this.rpc = null;
    }
    this.rawContext = null;
  }

  private async refreshConfig(serverConfig?: ServerConfig) {
    if (!this.rpc) {
      return;
    }
    const nextConfig = serverConfig ?? (await this.rpc.server.getConfig());
    this.setState({
      serverConfig: nextConfig,
      phase: this.state.phase === "loading" ? "ready" : this.state.phase,
    });
  }

  private resolveFallbackThreadId(projection: ClientProjectionSnapshot): ThreadId | null {
    return resolveSelectedThreadId(projection, this.state.selectedThreadId);
  }

  private async refreshSnapshot(selectedThreadId?: ThreadId | null) {
    if (!this.rpc) {
      return;
    }
    const snapshot = await this.rpc.orchestration.getSnapshot();
    const projection = projectReadModelToClientSnapshot(snapshot);
    this.rawContext = {
      baseDir: this.baseDir,
      rpc: this.rpc,
      snapshot,
    };
    const nextSelectedThreadId =
      selectedThreadId === undefined
        ? this.resolveFallbackThreadId(projection)
        : resolveSelectedThreadId(projection, selectedThreadId);
    const nextSelectedThread =
      nextSelectedThreadId === null
        ? null
        : (projection.threads[projection.threadIndexById[nextSelectedThreadId] ?? -1] ?? null);
    if (nextSelectedThread) {
      this.preferredProjectId = nextSelectedThread.projectId;
    }

    this.setState({
      phase: this.state.phase === "loading" ? "ready" : this.state.phase,
      projection: {
        ...projection,
        sidebarThreadsById: buildSidebarThreadsById(projection.threads),
      },
      selectedThreadId: nextSelectedThreadId,
    });
  }

  private async queueSnapshotRefresh() {
    if (this.snapshotRefreshInFlight) {
      this.snapshotRefreshQueued = true;
      return this.snapshotRefreshInFlight;
    }
    this.snapshotRefreshQueued = false;
    this.snapshotRefreshInFlight = (async () => {
      do {
        this.snapshotRefreshQueued = false;
        await this.refreshSnapshot();
      } while (this.snapshotRefreshQueued);
      this.snapshotRefreshInFlight = null;
    })();
    return this.snapshotRefreshInFlight;
  }

  private async queueConfigRefresh() {
    if (this.configRefreshInFlight) {
      this.configRefreshQueued = true;
      return this.configRefreshInFlight;
    }
    this.configRefreshQueued = false;
    this.configRefreshInFlight = (async () => {
      do {
        this.configRefreshQueued = false;
        await this.refreshConfig();
      } while (this.configRefreshQueued);
      this.configRefreshInFlight = null;
    })();
    return this.configRefreshInFlight;
  }

  private async runMutation(run: () => Promise<void>, options?: { notice?: string }) {
    try {
      await run();
      await Promise.all([this.queueSnapshotRefresh(), this.queueConfigRefresh()]);
      this.setState({
        phase: "ready",
        error: null,
        ...(options?.notice ? { notice: options.notice } : {}),
      });
    } catch (error) {
      this.setState({
        phase: "ready",
        error: asErrorMessage(error),
      });
      throw error;
    }
  }

  private requireContext() {
    if (!this.rawContext || !this.rpc) {
      throw new Error("Agent controller has not finished initializing.");
    }
    return {
      rpc: this.rpc,
      snapshot: this.rawContext.snapshot,
    };
  }

  selectThread = (threadId: ThreadId) => {
    const thread =
      this.state.projection.threads[this.state.projection.threadIndexById[threadId] ?? -1];
    if (!thread) {
      return;
    }
    this.preferredProjectId = thread.projectId;
    this.setState({ selectedThreadId: threadId });
  };

  async createThread() {
    await this.runMutation(
      async () => {
        const { rpc, snapshot } = this.requireContext();
        const projectId =
          this.preferredProjectId ??
          (this.launchOptions.projectId
            ? ProjectId.makeUnsafe(this.launchOptions.projectId)
            : await ensureProjectForCwd(rpc, snapshot, this.cwd));
        const threadId = await createThreadForProject({
          rpc,
          snapshot,
          projectId,
        });
        this.preferredProjectId = projectId;
        await this.refreshSnapshot(threadId);
      },
      { notice: "Created new thread." },
    );
  }

  async archiveSelectedThread() {
    const selectedThread = this.getSelectedThread();
    if (!selectedThread) {
      return;
    }
    await this.runMutation(
      async () => {
        const { rpc } = this.requireContext();
        await rpc.orchestration.dispatchCommand({
          type: "thread.archive",
          commandId: CommandId.makeUnsafe(randomUUID()),
          threadId: selectedThread.id,
        });
      },
      { notice: `Archived ${selectedThread.title}.` },
    );
  }

  async sendMessage(text: string) {
    const selectedThread = this.getSelectedThread();
    if (!selectedThread || text.trim().length === 0) {
      return;
    }
    await this.runMutation(
      async () => {
        const { rpc, snapshot } = this.requireContext();
        await sendThreadMessage({
          rpc,
          snapshot,
          threadId: selectedThread.id,
          message: text,
        });
      },
      { notice: "Sent message." },
    );
  }

  async interruptSelectedThread() {
    const selectedThread = this.getSelectedThread();
    if (!selectedThread) {
      return;
    }
    await this.runMutation(
      async () => {
        const { rpc } = this.requireContext();
        await rpc.orchestration.dispatchCommand({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe(randomUUID()),
          threadId: selectedThread.id,
          ...(selectedThread.session?.activeTurnId
            ? { turnId: selectedThread.session.activeTurnId }
            : {}),
          createdAt: new Date().toISOString(),
        });
      },
      { notice: "Interrupt requested." },
    );
  }

  async updateThreadModelSelection(selection: ModelSelection) {
    const selectedThread = this.getSelectedThread();
    if (!selectedThread) {
      return;
    }
    const normalizedSelection = normalizeSelectionWithCapabilities(
      selection,
      this.state.serverConfig,
    );
    await this.runMutation(async () => {
      const { rpc } = this.requireContext();
      await rpc.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe(randomUUID()),
        threadId: selectedThread.id,
        modelSelection: normalizedSelection,
      });
    });
  }

  async setThreadRuntimeMode(runtimeMode: RuntimeMode) {
    const selectedThread = this.getSelectedThread();
    if (!selectedThread) {
      return;
    }
    await this.runMutation(async () => {
      const { rpc } = this.requireContext();
      await rpc.orchestration.dispatchCommand({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe(randomUUID()),
        threadId: selectedThread.id,
        runtimeMode,
        createdAt: new Date().toISOString(),
      });
    });
  }

  async setThreadInteractionMode(interactionMode: ProviderInteractionMode) {
    const selectedThread = this.getSelectedThread();
    if (!selectedThread) {
      return;
    }
    await this.runMutation(async () => {
      const { rpc } = this.requireContext();
      await rpc.orchestration.dispatchCommand({
        type: "thread.interaction-mode.set",
        commandId: CommandId.makeUnsafe(randomUUID()),
        threadId: selectedThread.id,
        interactionMode,
        createdAt: new Date().toISOString(),
      });
    });
  }

  async respondToApproval(requestId: string, decision: ProviderApprovalDecision) {
    const selectedThread = this.getSelectedThread();
    if (!selectedThread) {
      return;
    }
    await this.runMutation(async () => {
      const { rpc } = this.requireContext();
      await rpc.orchestration.dispatchCommand({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe(randomUUID()),
        threadId: selectedThread.id,
        requestId: ApprovalRequestId.makeUnsafe(requestId),
        decision,
        createdAt: new Date().toISOString(),
      });
    });
  }

  async respondToUserInput(requestId: string, answers: ProviderUserInputAnswers) {
    const selectedThread = this.getSelectedThread();
    if (!selectedThread) {
      return;
    }
    await this.runMutation(async () => {
      const { rpc } = this.requireContext();
      await rpc.orchestration.dispatchCommand({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe(randomUUID()),
        threadId: selectedThread.id,
        requestId: ApprovalRequestId.makeUnsafe(requestId),
        answers,
        createdAt: new Date().toISOString(),
      });
    });
  }

  async refreshProviders() {
    const rpc = this.rpc;
    if (!rpc) {
      return;
    }
    await this.runMutation(
      async () => {
        await rpc.server.refreshProviders();
      },
      { notice: "Refreshed provider status." },
    );
  }

  async updateServerSettings(patch: ServerSettingsPatch) {
    const rpc = this.rpc;
    if (!rpc) {
      return;
    }
    await this.runMutation(async () => {
      await rpc.server.updateSettings(patch);
    });
  }

  async setShioriAuthToken(token: string | null) {
    const rpc = this.rpc;
    if (!rpc) {
      return;
    }
    await this.runMutation(async () => {
      await rpc.server.setShioriAuthToken(token);
    });
  }

  async runProviderLogin(provider: "codex" | "claudeAgent") {
    if (provider === "codex") {
      await runCommand("codex", ["login"]);
    } else {
      await runCommand("claude", ["auth", "login"]);
    }
    await this.refreshProviders();
  }
}

export function createAgentController(options: AgentLaunchOptions): AgentController {
  return new RealAgentController(options);
}

export function getThreadProviderSelection(
  controllerState: AgentControllerState,
): ModelSelection | null {
  const selectedThreadId = controllerState.selectedThreadId;
  if (!selectedThreadId) {
    return null;
  }
  const thread =
    controllerState.projection.threads[
      controllerState.projection.threadIndexById[selectedThreadId] ?? -1
    ];
  return thread?.modelSelection ?? null;
}

export function cycleProvider(
  currentProvider: ProviderKind,
  serverConfig: ServerConfig | null,
  delta: number,
): ProviderKind {
  const providers = serverConfig?.providers.map((provider) => provider.provider) ?? [
    "shiori",
    "kimiCode",
    "gemini",
    "cursor",
    "codex",
    "claudeAgent",
  ];
  const currentIndex = Math.max(0, providers.indexOf(currentProvider));
  return providers[(currentIndex + delta + providers.length) % providers.length] ?? currentProvider;
}

export function cycleModel(
  selection: ModelSelection,
  serverConfig: ServerConfig | null,
  delta: number,
): ModelSelection {
  const models = getProviderModels(serverConfig, selection.provider);
  if (models.length === 0) {
    return defaultModelSelectionForProvider(serverConfig, selection.provider);
  }
  const currentIndex = Math.max(
    0,
    models.findIndex((model) => model.slug === selection.model),
  );
  const nextModel = models[(currentIndex + delta + models.length) % models.length] ?? models[0];
  if (!nextModel) {
    return selection;
  }
  return normalizeSelectionWithCapabilities(
    {
      ...selection,
      model: nextModel.slug,
    },
    serverConfig,
  );
}

export function withProvider(
  selection: ModelSelection,
  provider: ProviderKind,
  serverConfig: ServerConfig | null,
): ModelSelection {
  if (selection.provider === provider) {
    return selection;
  }
  return defaultModelSelectionForProvider(serverConfig, provider);
}
