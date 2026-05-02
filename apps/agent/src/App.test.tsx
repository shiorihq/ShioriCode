import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
  type ServerConfig,
} from "contracts";
import {
  buildSidebarThreadsById,
  buildThreadIndexById,
  buildThreadIdsByProjectId,
} from "shared/orchestrationClientProjection";
import type { Project, Thread } from "shared/orchestrationClientTypes";

import { App } from "./App";
import type { AgentController, AgentControllerState } from "./controller";

class MockController implements AgentController {
  private readonly listeners = new Set<() => void>();
  state: AgentControllerState;

  initialize = vi.fn(async () => undefined);
  dispose = vi.fn(async () => undefined);
  createThread = vi.fn(async () => undefined);
  archiveSelectedThread = vi.fn(async () => undefined);
  sendMessage = vi.fn(async () => undefined);
  interruptSelectedThread = vi.fn(async () => undefined);
  updateThreadModelSelection = vi.fn(async () => undefined);
  setThreadRuntimeMode = vi.fn(async () => undefined);
  setThreadInteractionMode = vi.fn(async () => undefined);
  respondToApproval = vi.fn(async () => undefined);
  respondToUserInput = vi.fn(async () => undefined);
  refreshProviders = vi.fn(async () => undefined);
  updateServerSettings = vi.fn(async () => undefined);
  setShioriAuthToken = vi.fn(async () => undefined);
  runProviderLogin = vi.fn(async () => undefined);

  constructor(state: AgentControllerState) {
    this.state = state;
  }

  getState = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  selectThread = (threadId: ThreadId) => {
    this.state = {
      ...this.state,
      selectedThreadId: threadId,
    };
    this.emit();
  };

  setState(nextState: Partial<AgentControllerState>) {
    this.state = {
      ...this.state,
      ...nextState,
    };
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

async function flushUi() {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-04-17T10:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload: overrides.payload ?? {},
    turnId: overrides.turnId ? TurnId.makeUnsafe(overrides.turnId) : null,
  };
}

function makeProject(): Project {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    name: "Project One",
    cwd: "/tmp/project-one",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.4",
    },
    scripts: [],
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    projectlessCwd: null,
    title: "Thread One",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: {
      provider: "codex",
      status: "ready",
      createdAt: "2026-04-17T10:00:00.000Z",
      updatedAt: "2026-04-17T10:00:00.000Z",
      orchestrationStatus: "ready",
    },
    resumeState: "resumed",
    messages: [
      {
        id: MessageId.makeUnsafe("message-1"),
        role: "assistant",
        text: "Hello from Shiori Agent",
        createdAt: "2026-04-17T10:00:00.000Z",
        completedAt: "2026-04-17T10:00:01.000Z",
        streaming: false,
      },
    ],
    proposedPlans: [],
    error: null,
    createdAt: "2026-04-17T10:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    updatedAt: "2026-04-17T10:00:00.000Z",
    latestTurn: null,
    parentThreadId: null,
    branchSourceTurnId: null,
    branch: null,
    worktreePath: null,
    tag: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

function makeServerConfig(provider: Thread["modelSelection"]["provider"] = "codex"): ServerConfig {
  const modelsByProvider = {
    codex: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
    claudeAgent: [
      { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", isCustom: false, capabilities: null },
    ],
    shiori: [{ slug: "openai/gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
  } as const;

  return {
    cwd: "/tmp/project-one",
    serverInstancePath: "/tmp/server-instance.json",
    keybindingsConfigPath: "/tmp/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "shiori",
        enabled: true,
        installed: true,
        version: null,
        status: provider === "shiori" ? "ready" : "warning",
        auth: { status: "unknown", label: "Signed in to Shiori" },
        checkedAt: "2026-04-17T10:00:00.000Z",
        models: modelsByProvider.shiori,
      },
      {
        provider: "codex",
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: provider === "codex" ? "ready" : "warning",
        auth: { status: "authenticated", label: "Codex Ready" },
        checkedAt: "2026-04-17T10:00:00.000Z",
        models: modelsByProvider.codex,
      },
      {
        provider: "claudeAgent",
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: provider === "claudeAgent" ? "ready" : "warning",
        auth: { status: "authenticated", label: "Claude Ready" },
        checkedAt: "2026-04-17T10:00:00.000Z",
        models: modelsByProvider.claudeAgent,
      },
    ],
    availableEditors: [],
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

function makeState(
  thread: Thread,
  serverConfig = makeServerConfig(thread.modelSelection.provider),
): AgentControllerState {
  const threads = [thread];
  const projects = [makeProject()];
  return {
    phase: "ready",
    baseDir: "/tmp/.shiori",
    cwd: "/tmp/project-one",
    serverConfig,
    projection: {
      projects,
      threads,
      threadIndexById: buildThreadIndexById(threads),
      sidebarThreadsById: buildSidebarThreadsById(threads),
      threadIdsByProjectId: buildThreadIdsByProjectId(threads),
    },
    selectedThreadId: thread.id,
    error: null,
    notice: null,
  };
}

describe("App", () => {
  it("renders the welcome banner and timeline", () => {
    const controller = new MockController(makeState(makeThread()));
    const app = render(<App controller={controller} dimensions={{ columns: 120, rows: 40 }} />);

    expect(app.lastFrame()).toContain("shiori");
    expect(app.lastFrame()).toContain("Hello from Shiori Agent");
  });

  it("renders the full timeline instead of hiding earlier entries behind a counter", () => {
    const messages: Thread["messages"] = Array.from({ length: 18 }, (_, index) => ({
      id: MessageId.makeUnsafe(`message-${index + 1}`),
      role: index % 2 === 0 ? "user" : "assistant",
      text: `Timeline item ${index + 1}`,
      createdAt: `2026-04-17T10:${String(index).padStart(2, "0")}:00.000Z`,
      completedAt: `2026-04-17T10:${String(index).padStart(2, "0")}:01.000Z`,
      streaming: false,
    }));
    const controller = new MockController(makeState(makeThread({ messages })));
    const app = render(<App controller={controller} dimensions={{ columns: 100, rows: 14 }} />);
    const frame = app.lastFrame();

    expect(frame).toContain("Timeline item 1");
    expect(frame).toContain("Timeline item 18");
    expect(frame).toContain("│");
    expect(frame).not.toContain("earlier");
  });

  it("opens the thread switcher on ctrl+p", async () => {
    const controller = new MockController(makeState(makeThread()));
    const app = render(<App controller={controller} dimensions={{ columns: 80, rows: 30 }} />);

    app.stdin.write("\u0010");
    await flushUi();

    expect(app.lastFrame()).toContain("threads");
    expect(app.lastFrame()).toContain("Thread One");
  });

  it("submits composer input", async () => {
    const controller = new MockController(makeState(makeThread()));
    const app = render(<App controller={controller} dimensions={{ columns: 120, rows: 40 }} />);

    app.stdin.write("hello");
    await flushUi();
    app.stdin.write("\r");
    await flushUi();

    expect(controller.sendMessage).toHaveBeenCalledWith("hello");
  });

  it("executes the /new slash command", async () => {
    const controller = new MockController(makeState(makeThread()));
    const app = render(<App controller={controller} dimensions={{ columns: 120, rows: 40 }} />);

    app.stdin.write("/new");
    await flushUi();
    app.stdin.write("\r");
    await flushUi();

    expect(controller.createThread).toHaveBeenCalled();
    expect(controller.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps slash menu navigation out of composer history", async () => {
    const controller = new MockController(makeState(makeThread()));
    const app = render(<App controller={controller} dimensions={{ columns: 120, rows: 40 }} />);

    app.stdin.write("previous message");
    await flushUi();
    app.stdin.write("\r");
    await flushUi();
    app.stdin.write("/");
    await flushUi();
    app.stdin.write("\u001b[A");
    await flushUi();

    expect(app.lastFrame()).toContain("commands");
    expect(app.lastFrame()).not.toContain("previous message");
  });

  it("closes the slash menu with escape", async () => {
    const controller = new MockController(makeState(makeThread()));
    const app = render(<App controller={controller} dimensions={{ columns: 120, rows: 40 }} />);

    app.stdin.write("/");
    await flushUi();

    expect(app.lastFrame()).toContain("commands");

    app.stdin.write("\u001b");
    await flushUi();

    expect(app.lastFrame()).not.toContain("enter run");
  });

  it("opens help with the advertised question mark shortcut", async () => {
    const controller = new MockController(makeState(makeThread()));
    const app = render(<App controller={controller} dimensions={{ columns: 120, rows: 40 }} />);

    app.stdin.write("?");
    await flushUi();

    expect(app.lastFrame()).toContain("help");
    expect(app.lastFrame()).toContain("ctrl+s settings");
    expect(app.lastFrame()).not.toContain("› ?");
  });

  it("supports vim mode editing via /vim", async () => {
    const controller = new MockController(makeState(makeThread()));
    const app = render(<App controller={controller} dimensions={{ columns: 120, rows: 40 }} />);

    app.stdin.write("/vim");
    await flushUi();
    app.stdin.write("\r");
    await flushUi();

    expect(app.lastFrame()).toContain("-- INSERT --");

    app.stdin.write("hello");
    await flushUi();
    app.stdin.write("\u001b");
    await flushUi();

    expect(app.lastFrame()).not.toContain("-- INSERT --");

    app.stdin.write("0");
    await flushUi();
    app.stdin.write("i");
    await flushUi();
    app.stdin.write("Say ");
    await flushUi();
    app.stdin.write("\r");
    await flushUi();

    expect(controller.sendMessage).toHaveBeenCalledWith("Say hello");
  });

  it("rerenders on streaming updates", async () => {
    const controller = new MockController(makeState(makeThread()));
    const app = render(<App controller={controller} dimensions={{ columns: 120, rows: 40 }} />);

    controller.setState({
      projection: {
        ...controller.state.projection,
        threads: [
          makeThread({
            messages: [
              {
                id: MessageId.makeUnsafe("message-1"),
                role: "assistant",
                text: "Streaming update arrived",
                createdAt: "2026-04-17T10:00:00.000Z",
                streaming: true,
              },
            ],
          }),
        ],
        threadIndexById: { [ThreadId.makeUnsafe("thread-1")]: 0 },
        sidebarThreadsById: buildSidebarThreadsById([
          makeThread({
            messages: [
              {
                id: MessageId.makeUnsafe("message-1"),
                role: "assistant",
                text: "Streaming update arrived",
                createdAt: "2026-04-17T10:00:00.000Z",
                streaming: true,
              },
            ],
          }),
        ]),
        threadIdsByProjectId: {
          [ProjectId.makeUnsafe("project-1")]: [ThreadId.makeUnsafe("thread-1")],
        },
      },
    });
    await flushUi();

    expect(app.lastFrame()).toContain("Streaming update arrived");
  });

  it("toggles a detailed transcript mode with ctrl+o", async () => {
    const controller = new MockController(
      makeState(
        makeThread({
          activities: [
            makeActivity({
              id: "reasoning-started",
              createdAt: "2026-04-17T10:00:01.000Z",
              kind: "reasoning.started",
              summary: "Thinking",
              tone: "info",
              turnId: "turn-1",
              payload: { itemId: "reasoning-item-1" },
            }),
            makeActivity({
              id: "reasoning-delta",
              createdAt: "2026-04-17T10:00:02.000Z",
              kind: "reasoning.delta",
              summary: "Thinking",
              tone: "info",
              turnId: "turn-1",
              payload: {
                itemId: "reasoning-item-1",
                delta: "First line of reasoning\nSecond line of reasoning",
              },
            }),
            makeActivity({
              id: "reasoning-completed",
              createdAt: "2026-04-17T10:00:03.000Z",
              kind: "reasoning.completed",
              summary: "Thought",
              tone: "info",
              turnId: "turn-1",
              payload: { itemId: "reasoning-item-1" },
            }),
          ],
        }),
      ),
    );
    const app = render(<App controller={controller} dimensions={{ columns: 120, rows: 40 }} />);

    expect(app.lastFrame()).not.toContain("Second line of reasoning");

    app.stdin.write("\u000f");
    await flushUi();

    expect(app.lastFrame()).toContain("Showing detailed transcript");
    expect(app.lastFrame()).toContain("Second line of reasoning");

    app.stdin.write("q");
    await flushUi();

    expect(app.lastFrame()).not.toContain("Showing detailed transcript");
    expect(app.lastFrame()).not.toContain("Second line of reasoning");
  });

  it("submits approval responses without leaking the answer into the composer", async () => {
    const controller = new MockController(
      makeState(
        makeThread({
          session: {
            provider: "codex",
            status: "running",
            createdAt: "2026-04-17T10:00:00.000Z",
            updatedAt: "2026-04-17T10:00:00.000Z",
            orchestrationStatus: "running",
          },
          activities: [
            {
              id: "activity-1",
              kind: "approval.requested",
              tone: "approval",
              summary: "Need approval",
              payload: {
                requestId: "request-1",
                requestKind: "command",
                detail: "Run a command",
              },
              createdAt: "2026-04-17T10:00:00.000Z",
              turnId: null,
            } as Thread["activities"][number],
          ],
        }),
      ),
    );
    const app = render(<App controller={controller} dimensions={{ columns: 120, rows: 40 }} />);

    app.stdin.write("1");
    await flushUi();

    controller.setState({
      projection: {
        ...controller.state.projection,
        threads: [makeThread()],
        threadIndexById: { [ThreadId.makeUnsafe("thread-1")]: 0 },
        sidebarThreadsById: buildSidebarThreadsById([makeThread()]),
        threadIdsByProjectId: {
          [ProjectId.makeUnsafe("project-1")]: [ThreadId.makeUnsafe("thread-1")],
        },
      },
    });
    await flushUi();
    app.stdin.write("\r");
    await flushUi();

    expect(controller.respondToApproval).toHaveBeenCalledWith("request-1", "accept");
    expect(controller.sendMessage).not.toHaveBeenCalled();
  });

  it("submits structured user input responses without leaking the answer into the composer", async () => {
    const controller = new MockController(
      makeState(
        makeThread({
          session: {
            provider: "codex",
            status: "running",
            createdAt: "2026-04-17T10:00:00.000Z",
            updatedAt: "2026-04-17T10:00:00.000Z",
            orchestrationStatus: "running",
          },
          activities: [
            {
              id: "activity-1",
              kind: "user-input.requested",
              tone: "info",
              summary: "Need user input",
              payload: {
                requestId: "user-input-1",
                questions: [
                  {
                    id: "question-1",
                    header: "Scope",
                    question: "Choose scope",
                    options: [
                      { label: "Small", description: "Do a small change" },
                      { label: "Large", description: "Do a larger change" },
                    ],
                  },
                ],
              },
              createdAt: "2026-04-17T10:00:00.000Z",
              turnId: null,
            } as Thread["activities"][number],
          ],
        }),
      ),
    );
    const app = render(<App controller={controller} dimensions={{ columns: 120, rows: 40 }} />);

    app.stdin.write("2");
    await flushUi();

    controller.setState({
      projection: {
        ...controller.state.projection,
        threads: [makeThread()],
        threadIndexById: { [ThreadId.makeUnsafe("thread-1")]: 0 },
        sidebarThreadsById: buildSidebarThreadsById([makeThread()]),
        threadIdsByProjectId: {
          [ProjectId.makeUnsafe("project-1")]: [ThreadId.makeUnsafe("thread-1")],
        },
      },
    });
    await flushUi();
    app.stdin.write("\r");
    await flushUi();

    expect(controller.respondToUserInput).toHaveBeenCalledWith("user-input-1", {
      "question-1": "Large",
    });
    expect(controller.sendMessage).not.toHaveBeenCalled();
  });

  it("edits Shiori provider settings via the /model overlay", async () => {
    const controller = new MockController(
      makeState(
        makeThread({
          modelSelection: {
            provider: "shiori",
            model: "openai/gpt-5.4",
          },
        }),
        makeServerConfig("shiori"),
      ),
    );
    const app = render(<App controller={controller} dimensions={{ columns: 120, rows: 40 }} />);

    app.stdin.write("/model");
    await flushUi();
    app.stdin.write("\r");
    await flushUi();
    app.stdin.write("e");
    await flushUi();
    app.stdin.write("https://shiori.example");
    await flushUi();
    app.stdin.write("\r");
    await flushUi();

    expect(controller.updateServerSettings).toHaveBeenCalledWith({
      providers: {
        shiori: {
          apiBaseUrl: "https://shiori.example",
        },
      },
    });
  });
});
