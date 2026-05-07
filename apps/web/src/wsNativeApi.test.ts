import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  type DesktopBridge,
  EventId,
  ProjectId,
  type OrchestrationEvent,
  type ServerConfig,
  type ServerProvider,
  type TerminalEvent,
  ThreadId,
} from "contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContextMenuItem } from "contracts";

const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();

function registerListener<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const terminalEventListeners = new Set<(event: TerminalEvent) => void>();
const orchestrationEventListeners = new Set<(event: OrchestrationEvent) => void>();

const rpcClientMock = {
  dispose: vi.fn(),
  terminal: {
    open: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    restart: vi.fn(),
    close: vi.fn(),
    onEvent: vi.fn((listener: (event: TerminalEvent) => void) =>
      registerListener(terminalEventListeners, listener),
    ),
  },
  projects: {
    searchEntries: vi.fn(),
    writeFile: vi.fn(),
  },
  shell: {
    openInEditor: vi.fn(),
  },
  git: {
    status: vi.fn(),
    listBranches: vi.fn(),
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    createBranch: vi.fn(),
    checkout: vi.fn(),
    init: vi.fn(),
    resolvePullRequest: vi.fn(),
    preparePullRequestThread: vi.fn(),
  },
  server: {
    getConfig: vi.fn(),
    refreshProviders: vi.fn(),
    upsertKeybinding: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    listMcpServers: vi.fn(),
    authenticateMcpServer: vi.fn(),
    removeMcpServer: vi.fn(),
    listSkills: vi.fn(),
    removeSkill: vi.fn(),
    setShioriAuthToken: vi.fn(),
    getProviderUsage: vi.fn(),
    getHostedBillingSnapshot: vi.fn(),
    createHostedBillingCheckout: vi.fn(),
    createHostedBillingPortal: vi.fn(),
    hostedOAuthStart: vi.fn(),
    subscribeConfig: vi.fn(),
    subscribeLifecycle: vi.fn(),
  },
  onboarding: {
    getState: vi.fn(),
    completeStep: vi.fn(),
    reset: vi.fn(),
  },
  telemetry: {
    capture: vi.fn(),
    log: vi.fn(),
  },
  computer: {
    getPermissions: vi.fn(),
    requestPermission: vi.fn(),
    showPermissionGuide: vi.fn(),
    createSession: vi.fn(),
    closeSession: vi.fn(),
    screenshot: vi.fn(),
    click: vi.fn(),
    move: vi.fn(),
    type: vi.fn(),
    key: vi.fn(),
    scroll: vi.fn(),
  },
  orchestration: {
    getSnapshot: vi.fn(),
    dispatchCommand: vi.fn(),
    getTurnDiff: vi.fn(),
    getFullThreadDiff: vi.fn(),
    getSubagentDetail: vi.fn(),
    replayEvents: vi.fn(),
    onDomainEvent: vi.fn((listener: (event: OrchestrationEvent) => void) =>
      registerListener(orchestrationEventListeners, listener),
    ),
  },
};

vi.mock("./wsRpcClient", () => {
  return {
    getWsRpcClient: () => rpcClientMock,
    __resetWsRpcClientForTests: vi.fn(),
  };
});

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
}));

function emitEvent<T>(listeners: Set<(event: T) => void>, event: T) {
  for (const listener of listeners) {
    listener(event);
  }
}

function getWindowForTest(): Window & typeof globalThis & { desktopBridge?: unknown } {
  const testGlobal = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis & { desktopBridge?: unknown };
  };
  if (!testGlobal.window) {
    testGlobal.window = {} as Window & typeof globalThis & { desktopBridge?: unknown };
  }
  return testGlobal.window;
}

function makeDesktopBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    getWsUrl: () => null,
    pickFolder: async () => null,
    confirm: async () => true,
    setTheme: async () => undefined,
    setVibrancy: async () => undefined,
    showContextMenu: async () => null,
    openExternal: async () => true,
    onMenuAction: () => () => undefined,
    getUpdateState: async () => {
      throw new Error("getUpdateState not implemented in test");
    },
    checkForUpdate: async () => {
      throw new Error("checkForUpdate not implemented in test");
    },
    downloadUpdate: async () => {
      throw new Error("downloadUpdate not implemented in test");
    },
    installUpdate: async () => {
      throw new Error("installUpdate not implemented in test");
    },
    getCompanionCliState: async () => ({
      status: "not-installed",
      version: null,
      binaryPath: null,
      lastError: null,
      installCommand: null,
    }),
    installCompanionCli: async () => ({
      accepted: false,
      completed: false,
      state: {
        status: "not-installed",
        version: null,
        binaryPath: null,
        lastError: null,
        installCommand: null,
      },
    }),
    onUpdateState: () => () => undefined,
    ...overrides,
  };
}

const defaultProviders: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
  },
];

const baseServerConfig: ServerConfig = {
  cwd: "/tmp/workspace",
  serverInstancePath: "/tmp/workspace/server-instance.json",
  keybindingsConfigPath: "/tmp/workspace/.config/keybindings.json",
  keybindings: [],
  issues: [],
  providers: defaultProviders,
  availableEditors: ["cursor"],
  settings: DEFAULT_SERVER_SETTINGS,
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  showContextMenuFallbackMock.mockReset();
  terminalEventListeners.clear();
  orchestrationEventListeners.clear();
  Reflect.deleteProperty(getWindowForTest(), "desktopBridge");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("wsNativeApi", () => {
  it("forwards server config fetches directly to the RPC client", async () => {
    rpcClientMock.server.getConfig.mockResolvedValue(baseServerConfig);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.server.getConfig()).resolves.toEqual(baseServerConfig);
    expect(rpcClientMock.server.getConfig).toHaveBeenCalledWith();
    expect(rpcClientMock.server.subscribeConfig).not.toHaveBeenCalled();
    expect(rpcClientMock.server.subscribeLifecycle).not.toHaveBeenCalled();
  });

  it("forwards terminal and orchestration stream events", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const onTerminalEvent = vi.fn();
    const onDomainEvent = vi.fn();

    api.terminal.onEvent(onTerminalEvent);
    api.orchestration.onDomainEvent(onDomainEvent);

    const terminalEvent = {
      threadId: "thread-1",
      terminalId: "terminal-1",
      createdAt: "2026-02-24T00:00:00.000Z",
      type: "output",
      data: "hello",
    } as const;
    emitEvent(terminalEventListeners, terminalEvent);

    const orchestrationEvent = {
      sequence: 1,
      eventId: EventId.makeUnsafe("event-1"),
      aggregateKind: "project",
      aggregateId: ProjectId.makeUnsafe("project-1"),
      occurredAt: "2026-02-24T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/workspace",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        scripts: [],
        createdAt: "2026-02-24T00:00:00.000Z",
        updatedAt: "2026-02-24T00:00:00.000Z",
      },
    } satisfies Extract<OrchestrationEvent, { type: "project.created" }>;
    emitEvent(orchestrationEventListeners, orchestrationEvent);

    expect(onTerminalEvent).toHaveBeenCalledWith(terminalEvent);
    expect(onDomainEvent).toHaveBeenCalledWith(orchestrationEvent);
  });

  it("sends orchestration dispatch commands as the direct RPC payload", async () => {
    rpcClientMock.orchestration.dispatchCommand.mockResolvedValue({ sequence: 1 });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const command = {
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-1"),
      projectId: ProjectId.makeUnsafe("project-1"),
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      createdAt: "2026-02-24T00:00:00.000Z",
    } as const;
    await api.orchestration.dispatchCommand(command);

    expect(rpcClientMock.orchestration.dispatchCommand).toHaveBeenCalledWith(command);
  });

  it("forwards workspace file writes to the project RPC", async () => {
    rpcClientMock.projects.writeFile.mockResolvedValue({ relativePath: "plan.md" });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.projects.writeFile({
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });

    expect(rpcClientMock.projects.writeFile).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });
  });

  it("forwards Computer Use calls to the RPC client", async () => {
    const permissionsSnapshot = {
      platform: "darwin",
      supported: true,
      helperAvailable: true,
      helperPath: "/tmp/ShioriComputerUseHelper",
      checkedAt: "2026-02-24T00:00:00.000Z",
      message: null,
      permissions: [
        {
          kind: "accessibility",
          label: "Accessibility",
          state: "granted",
          detail: "",
        },
      ],
    };
    rpcClientMock.computer.getPermissions.mockResolvedValue(permissionsSnapshot);
    rpcClientMock.computer.screenshot.mockResolvedValue({
      sessionId: "computer-session-1",
      imageDataUrl: "data:image/png;base64,abc",
      width: 1280,
      height: 720,
      capturedAt: "2026-02-24T00:00:01.000Z",
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.computer?.getPermissions()).resolves.toEqual(permissionsSnapshot);
    await expect(
      api.computer?.screenshot({
        sessionId: "computer-session-1",
      }),
    ).resolves.toEqual({
      sessionId: "computer-session-1",
      imageDataUrl: "data:image/png;base64,abc",
      width: 1280,
      height: 720,
      capturedAt: "2026-02-24T00:00:01.000Z",
    });
    expect(rpcClientMock.computer.getPermissions).toHaveBeenCalledWith();
    expect(rpcClientMock.computer.screenshot).toHaveBeenCalledWith({
      sessionId: "computer-session-1",
    });
  });

  it("forwards full-thread diff requests to the orchestration RPC", async () => {
    rpcClientMock.orchestration.getFullThreadDiff.mockResolvedValue({ diff: "patch" });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await api.orchestration.getFullThreadDiff({
      threadId: ThreadId.makeUnsafe("thread-1"),
      toTurnCount: 1,
    });

    expect(rpcClientMock.orchestration.getFullThreadDiff).toHaveBeenCalledWith({
      threadId: "thread-1",
      toTurnCount: 1,
    });
  });

  it("forwards provider refreshes directly to the RPC client", async () => {
    const nextProviders: ReadonlyArray<ServerProvider> = [
      {
        ...defaultProviders[0]!,
        checkedAt: "2026-01-03T00:00:00.000Z",
      },
    ];
    rpcClientMock.server.refreshProviders.mockResolvedValue({ providers: nextProviders });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.server.refreshProviders()).resolves.toEqual({ providers: nextProviders });
    expect(rpcClientMock.server.refreshProviders).toHaveBeenCalledWith();
  });

  it("forwards server settings updates directly to the RPC client", async () => {
    const nextSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      enableAssistantStreaming: true,
    };
    rpcClientMock.server.updateSettings.mockResolvedValue(nextSettings);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.server.updateSettings({ enableAssistantStreaming: true })).resolves.toEqual(
      nextSettings,
    );
    expect(rpcClientMock.server.updateSettings).toHaveBeenCalledWith({
      enableAssistantStreaming: true,
    });
  });

  it("forwards provider usage lookups directly to the RPC client", async () => {
    rpcClientMock.server.getProviderUsage.mockResolvedValue({
      provider: "codex",
      source: "app-server",
      available: true,
      unavailableReason: null,
      primary: {
        usedPercent: 13,
        resetsAt: "2026-04-04T05:00:00.000Z",
        windowDurationMinutes: 300,
      },
      secondary: {
        usedPercent: 64,
        resetsAt: "2026-04-10T05:00:00.000Z",
        windowDurationMinutes: 10080,
      },
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.server.getProviderUsage("codex")).resolves.toEqual({
      provider: "codex",
      source: "app-server",
      available: true,
      unavailableReason: null,
      primary: {
        usedPercent: 13,
        resetsAt: "2026-04-04T05:00:00.000Z",
        windowDurationMinutes: 300,
      },
      secondary: {
        usedPercent: 64,
        resetsAt: "2026-04-10T05:00:00.000Z",
        windowDurationMinutes: 10080,
      },
    });
    expect(rpcClientMock.server.getProviderUsage).toHaveBeenCalledWith({ provider: "codex" });
  });

  it("forwards hosted billing actions directly to the RPC client", async () => {
    rpcClientMock.server.getHostedBillingSnapshot.mockResolvedValue({
      plans: [
        {
          id: "plus",
          name: "Plus",
          description: "Starter paid plan",
          monthlyPrice: 10,
          annualPrice: 96,
          sortOrder: 0,
          highlighted: true,
          buttonText: "Get Plus",
          features: ["Feature A"],
        },
      ],
    });
    rpcClientMock.server.createHostedBillingCheckout.mockResolvedValue({
      sessionId: "cs_test_1",
      url: "https://checkout.stripe.test/session",
    });
    rpcClientMock.server.createHostedBillingPortal.mockResolvedValue({
      url: "https://billing.stripe.test/session",
    });
    rpcClientMock.server.hostedOAuthStart.mockResolvedValue({
      redirect: "https://accounts.example.test/oauth/start",
      verifier: "desktop-verifier",
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await expect(api.server.getHostedBillingSnapshot()).resolves.toEqual({
      plans: [
        {
          id: "plus",
          name: "Plus",
          description: "Starter paid plan",
          monthlyPrice: 10,
          annualPrice: 96,
          sortOrder: 0,
          highlighted: true,
          buttonText: "Get Plus",
          features: ["Feature A"],
        },
      ],
    });
    await expect(
      api.server.createHostedBillingCheckout({ planId: "pro", isAnnual: true }),
    ).resolves.toEqual({
      sessionId: "cs_test_1",
      url: "https://checkout.stripe.test/session",
    });
    await expect(api.server.createHostedBillingPortal("manage")).resolves.toEqual({
      url: "https://billing.stripe.test/session",
    });
    await expect(
      api.server.hostedOAuthStart({
        provider: "github",
        redirectTo: "shioricode://app/index.html#/settings/account",
      }),
    ).resolves.toEqual({
      redirect: "https://accounts.example.test/oauth/start",
      verifier: "desktop-verifier",
    });

    expect(rpcClientMock.server.getHostedBillingSnapshot).toHaveBeenCalledWith();
    expect(rpcClientMock.server.createHostedBillingCheckout).toHaveBeenCalledWith({
      planId: "pro",
      isAnnual: true,
    });
    expect(rpcClientMock.server.createHostedBillingPortal).toHaveBeenCalledWith({
      flow: "manage",
    });
    expect(rpcClientMock.server.hostedOAuthStart).toHaveBeenCalledWith({
      provider: "github",
      redirectTo: "shioricode://app/index.html#/settings/account",
    });
  });

  it("forwards onboarding actions directly to the RPC client", async () => {
    const onboardingState = {
      version: 1 as const,
      dismissed: false,
      completed: false,
      currentStepId: "connect-provider" as const,
      completedCount: 1,
      totalSteps: 3,
      steps: [
        {
          id: "sign-in" as const,
          order: 0,
          title: "Step 1: Sign in",
          description: "Authenticate with your Shiori account.",
          completed: true,
        },
        {
          id: "connect-provider" as const,
          order: 1,
          title: "Step 2: Connect a provider",
          description: "Placeholder: connect at least one coding provider.",
          completed: false,
        },
        {
          id: "start-first-thread" as const,
          order: 2,
          title: "Step 3: Start your first thread",
          description: "Placeholder: create and open the first thread.",
          completed: false,
        },
      ],
    };
    rpcClientMock.onboarding.getState.mockResolvedValue(onboardingState);
    rpcClientMock.onboarding.completeStep.mockResolvedValue(onboardingState);
    rpcClientMock.onboarding.reset.mockResolvedValue({
      ...onboardingState,
      currentStepId: "sign-in",
      completedCount: 0,
      steps: onboardingState.steps.map((step, index) => ({
        ...step,
        order: index,
        completed: false,
      })),
    });
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    await expect(api.onboarding.getState()).resolves.toEqual(onboardingState);
    await expect(api.onboarding.completeStep({ stepId: "connect-provider" })).resolves.toEqual(
      onboardingState,
    );
    await api.onboarding.reset();

    expect(rpcClientMock.onboarding.getState).toHaveBeenCalledWith();
    expect(rpcClientMock.onboarding.completeStep).toHaveBeenCalledWith({
      stepId: "connect-provider",
    });
    expect(rpcClientMock.onboarding.reset).toHaveBeenCalledWith();
  });

  it("forwards telemetry actions directly to the RPC client", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();

    await api.telemetry.capture({
      event: "web.route.viewed",
      properties: {
        path: "/settings/general",
      },
    });
    await api.telemetry.log({
      level: "error",
      message: "web.unhandled_error",
      context: {
        path: "/",
      },
    });

    expect(rpcClientMock.telemetry.capture).toHaveBeenCalledWith({
      event: "web.route.viewed",
      properties: {
        path: "/settings/general",
      },
    });
    expect(rpcClientMock.telemetry.log).toHaveBeenCalledWith({
      level: "error",
      message: "web.unhandled_error",
      context: {
        path: "/",
      },
    });
  });

  it("forwards context menu metadata to the desktop bridge", async () => {
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    getWindowForTest().desktopBridge = makeDesktopBridge({ showContextMenu });

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const items = [{ id: "delete", label: "Delete" }] as const;

    await expect(api.contextMenu.show(items)).resolves.toBe("delete");
    expect(showContextMenu).toHaveBeenCalledWith(items, undefined);
  });

  it("falls back to the browser context menu helper when the desktop bridge is missing", async () => {
    showContextMenuFallbackMock.mockResolvedValue("rename");
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const items = [{ id: "rename", label: "Rename" }] as const;

    await expect(api.contextMenu.show(items, { x: 4, y: 5 })).resolves.toBe("rename");
    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(items, { x: 4, y: 5 });
  });
});
