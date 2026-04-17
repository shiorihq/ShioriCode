import {
  CheckpointRef,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "contracts";
import { describe, expect, it } from "vitest";
import { buildSidebarThreadSummary } from "shared/orchestrationClientProjection";

import {
  applyOrchestrationEvent,
  applyOrchestrationEvents,
  syncServerReadModel,
  type AppState,
} from "./store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    resumeState: "resumed",
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    parentThreadId: null,
    branchSourceTurnId: null,
    branch: null,
    worktreePath: null,
    tag: null,
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  const threadIdsByProjectId: AppState["threadIdsByProjectId"] = {
    [thread.projectId]: [thread.id],
  };
  return {
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        name: "Project",
        cwd: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        scripts: [],
      },
    ],
    threads: [thread],
    threadIndexById: { [thread.id]: 0 },
    sidebarThreadsById: {},
    threadIdsByProjectId,
    pendingThreadDispatchById: {},
    bootstrapComplete: true,
  };
}

function makeThreadIndexById(threads: ReadonlyArray<Thread>): AppState["threadIndexById"] {
  return Object.fromEntries(threads.map((thread, index) => [thread.id, index]));
}

function makeEvent<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
  overrides: Partial<Extract<OrchestrationEvent, { type: T }>> = {},
): Extract<OrchestrationEvent, { type: T }> {
  const sequence = overrides.sequence ?? 1;
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId:
      "threadId" in payload
        ? payload.threadId
        : "projectId" in payload
          ? payload.projectId
          : ProjectId.makeUnsafe("project-1"),
    occurredAt: "2026-02-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
    ...overrides,
  } as Extract<OrchestrationEvent, { type: T }>;
}

function makeReadModelThread(overrides: Partial<OrchestrationReadModel["threads"][number]>) {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    parentThreadId: null,
    branchSourceTurnId: null,
    branch: null,
    worktreePath: null,
    resumeState: "resumed",
    latestTurn: null,
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
    tag: null,
    ...overrides,
  } satisfies OrchestrationReadModel["threads"][number];
}

function makeReadModel(thread: OrchestrationReadModel["threads"][number]): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        deletedAt: null,
        scripts: [],
      },
    ],
    threads: [thread],
  };
}

function makeThreadActivity(input: {
  id: string;
  kind: Thread["activities"][number]["kind"];
  summary: string;
  createdAt: string;
  turnId?: TurnId | null;
  tone?: Thread["activities"][number]["tone"];
  payload?: Thread["activities"][number]["payload"];
  sequence?: number;
}): Thread["activities"][number] {
  return {
    id: EventId.makeUnsafe(input.id),
    kind: input.kind,
    summary: input.summary,
    createdAt: input.createdAt,
    turnId: input.turnId ?? null,
    tone: input.tone ?? "info",
    payload: input.payload ?? {},
    ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
  };
}

function makeReadModelProject(
  overrides: Partial<OrchestrationReadModel["projects"][number]>,
): OrchestrationReadModel["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    scripts: [],
    ...overrides,
  };
}

describe("store read model sync", () => {
  it("marks bootstrap complete after snapshot sync", () => {
    const initialState: AppState = {
      ...makeState(makeThread()),
      bootstrapComplete: false,
    };

    const next = syncServerReadModel(initialState, makeReadModel(makeReadModelThread({})));

    expect(next.bootstrapComplete).toBe(true);
  });

  it("preserves claude model slugs without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("claude-opus-4-6");
  });

  it("resolves claude aliases when session provider is claudeAgent", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "sonnet",
        },
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("claude-sonnet-4-6");
  });

  it("preserves project and thread updatedAt timestamps from the read model", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        updatedAt: "2026-02-27T00:05:00.000Z",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects[0]?.updatedAt).toBe("2026-02-27T00:00:00.000Z");
    expect(next.threads[0]?.updatedAt).toBe("2026-02-27T00:05:00.000Z");
  });

  it("maps archivedAt from the read model", () => {
    const initialState = makeState(makeThread());
    const archivedAt = "2026-02-28T00:00:00.000Z";
    const next = syncServerReadModel(
      initialState,
      makeReadModel(
        makeReadModelThread({
          archivedAt,
        }),
      ),
    );

    expect(next.threads[0]?.archivedAt).toBe(archivedAt);
  });

  it("replaces projects using snapshot order during recovery", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState: AppState = {
      projects: [
        {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
        {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
      ],
      threads: [],
      threadIndexById: {},
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      pendingThreadDispatchById: {},
      bootstrapComplete: true,
    };
    const readModel: OrchestrationReadModel = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
        makeReadModelProject({
          id: project2,
          title: "Project 2",
          workspaceRoot: "/tmp/project-2",
        }),
        makeReadModelProject({
          id: project3,
          title: "Project 3",
          workspaceRoot: "/tmp/project-3",
        }),
      ],
      threads: [],
    };

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects.map((project) => project.id)).toEqual([project1, project2, project3]);
  });
});

describe("incremental orchestration updates", () => {
  it("does not mark bootstrap complete for incremental events", () => {
    const state: AppState = {
      ...makeState(makeThread()),
      bootstrapComplete: false,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.meta-updated", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "Updated title",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.bootstrapComplete).toBe(false);
  });

  it("preserves state identity for no-op project and thread deletes", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const nextAfterProjectDelete = applyOrchestrationEvent(
      state,
      makeEvent("project.deleted", {
        projectId: ProjectId.makeUnsafe("project-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );
    const nextAfterThreadDelete = applyOrchestrationEvent(
      state,
      makeEvent("thread.deleted", {
        threadId: ThreadId.makeUnsafe("thread-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(nextAfterProjectDelete).toBe(state);
    expect(nextAfterThreadDelete).toBe(state);
  });

  it("reuses an existing project row when project.created arrives with a new id for the same cwd", () => {
    const originalProjectId = ProjectId.makeUnsafe("project-1");
    const recreatedProjectId = ProjectId.makeUnsafe("project-2");
    const state: AppState = {
      projects: [
        {
          id: originalProjectId,
          name: "Project",
          cwd: "/tmp/project",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
      ],
      threads: [],
      threadIndexById: {},
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      pendingThreadDispatchById: {},
      bootstrapComplete: true,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.created", {
        projectId: recreatedProjectId,
        title: "Project Recreated",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        scripts: [],
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.projects).toHaveLength(1);
    expect(next.projects[0]?.id).toBe(recreatedProjectId);
    expect(next.projects[0]?.cwd).toBe("/tmp/project");
    expect(next.projects[0]?.name).toBe("Project Recreated");
  });

  it("rebinds existing threads when project.created replaces a project row for the same cwd", () => {
    const originalProjectId = ProjectId.makeUnsafe("project-1");
    const recreatedProjectId = ProjectId.makeUnsafe("project-2");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const thread = makeThread({
      id: threadId,
      projectId: originalProjectId,
    });
    const state: AppState = {
      projects: [
        {
          id: originalProjectId,
          name: "Project",
          cwd: "/tmp/project",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
      ],
      threads: [thread],
      threadIndexById: makeThreadIndexById([thread]),
      sidebarThreadsById: {
        [threadId]: buildSidebarThreadSummary(thread),
      },
      threadIdsByProjectId: {
        [originalProjectId]: [threadId],
      },
      pendingThreadDispatchById: {},
      bootstrapComplete: true,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.created", {
        projectId: recreatedProjectId,
        title: "Project Recreated",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        scripts: [],
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.projects).toHaveLength(1);
    expect(next.projects[0]?.id).toBe(recreatedProjectId);
    expect(next.threads[0]?.projectId).toBe(recreatedProjectId);
    expect(next.sidebarThreadsById[threadId]?.projectId).toBe(recreatedProjectId);
    expect(next.threadIdsByProjectId[originalProjectId]).toBeUndefined();
    expect(next.threadIdsByProjectId[recreatedProjectId]).toEqual([threadId]);
  });

  it("puts new projects at the front of the in-memory project list", () => {
    const state: AppState = {
      projects: [
        {
          id: ProjectId.makeUnsafe("project-existing"),
          name: "Existing",
          cwd: "/tmp/existing",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
      ],
      threads: [],
      threadIndexById: {},
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      pendingThreadDispatchById: {},
      bootstrapComplete: true,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.created", {
        projectId: ProjectId.makeUnsafe("project-new"),
        title: "New",
        workspaceRoot: "/tmp/new",
        defaultModelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        scripts: [],
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.projects.map((project) => project.id)).toEqual([
      ProjectId.makeUnsafe("project-new"),
      ProjectId.makeUnsafe("project-existing"),
    ]);
  });

  it("removes stale project index entries when thread.created recreates a thread under a new project", () => {
    const originalProjectId = ProjectId.makeUnsafe("project-1");
    const recreatedProjectId = ProjectId.makeUnsafe("project-2");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const thread = makeThread({
      id: threadId,
      projectId: originalProjectId,
    });
    const state: AppState = {
      projects: [
        {
          id: originalProjectId,
          name: "Project 1",
          cwd: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
        {
          id: recreatedProjectId,
          name: "Project 2",
          cwd: "/tmp/project-2",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
      ],
      threads: [thread],
      threadIndexById: makeThreadIndexById([thread]),
      sidebarThreadsById: {},
      threadIdsByProjectId: {
        [originalProjectId]: [threadId],
      },
      pendingThreadDispatchById: {},
      bootstrapComplete: true,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId,
        projectId: recreatedProjectId,
        title: "Recovered thread",
        modelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        parentThreadId: null,
        branchSourceTurnId: null,
        branch: null,
        worktreePath: null,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threads).toHaveLength(1);
    expect(next.threads[0]?.projectId).toBe(recreatedProjectId);
    expect(next.threadIdsByProjectId[originalProjectId]).toBeUndefined();
    expect(next.threadIdsByProjectId[recreatedProjectId]).toEqual([threadId]);
  });

  it("preserves thread history when thread.created is replayed for an existing thread", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");
    const thread = makeThread({
      id: threadId,
      title: "Existing thread",
      session: {
        provider: "codex",
        status: "running",
        orchestrationStatus: "running",
        activeTurnId: turnId,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:04.000Z",
      },
      messages: [
        {
          id: MessageId.makeUnsafe("message-user"),
          role: "user",
          text: "hello",
          turnId,
          createdAt: "2026-02-27T00:00:01.000Z",
          completedAt: "2026-02-27T00:00:01.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("message-assistant"),
          role: "assistant",
          text: "world",
          turnId,
          createdAt: "2026-02-27T00:00:02.000Z",
          completedAt: "2026-02-27T00:00:03.000Z",
          streaming: false,
        },
      ],
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: MessageId.makeUnsafe("message-assistant"),
      },
      proposedPlans: [
        {
          id: "plan-1" as Thread["proposedPlans"][number]["id"],
          turnId,
          planMarkdown: "1. Do the thing",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-27T00:00:02.000Z",
          updatedAt: "2026-02-27T00:00:02.000Z",
        },
      ],
      turnDiffSummaries: [
        {
          turnId,
          completedAt: "2026-02-27T00:00:03.000Z",
          status: "ready",
          assistantMessageId: MessageId.makeUnsafe("message-assistant"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
          files: [],
        },
      ],
      activities: [
        {
          id: EventId.makeUnsafe("activity-1"),
          kind: "tool.completed",
          summary: "Edited file",
          tone: "tool",
          payload: { title: "Edited file" },
          turnId,
          createdAt: "2026-02-27T00:00:02.500Z",
        },
      ],
      updatedAt: "2026-02-27T00:00:04.000Z",
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId,
        projectId: thread.projectId,
        title: "Recovered thread",
        modelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        parentThreadId: null,
        branchSourceTurnId: null,
        branch: "feature/recovered",
        worktreePath: null,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
      }),
    );

    expect(next.threads[0]?.title).toBe("Recovered thread");
    expect(next.threads[0]?.branch).toBe("feature/recovered");
    expect(next.threads[0]?.messages).toEqual(thread.messages);
    expect(next.threads[0]?.activities).toEqual(thread.activities);
    expect(next.threads[0]?.proposedPlans).toEqual(thread.proposedPlans);
    expect(next.threads[0]?.turnDiffSummaries).toEqual(thread.turnDiffSummaries);
    expect(next.threads[0]?.latestTurn).toEqual(thread.latestTurn);
    expect(next.threads[0]?.session).toEqual(thread.session);
    expect(next.threads[0]?.updatedAt).toBe("2026-02-27T00:00:04.000Z");
  });

  it("updates only the affected thread for message events", () => {
    const thread1 = makeThread({
      id: ThreadId.makeUnsafe("thread-1"),
      messages: [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:00.000Z",
          streaming: false,
        },
      ],
    });
    const thread2 = makeThread({ id: ThreadId.makeUnsafe("thread-2") });
    const state: AppState = {
      ...makeState(thread1),
      threads: [thread1, thread2],
      threadIndexById: makeThreadIndexById([thread1, thread2]),
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: thread1.id,
        messageId: MessageId.makeUnsafe("message-1"),
        role: "assistant",
        text: " world",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threads[0]?.messages[0]?.text).toBe("hello world");
    expect(next.threads[0]?.latestTurn?.state).toBe("running");
    expect(next.threads[1]).toBe(thread2);
  });

  it("preserves sidebar approval badges for assistant streaming chunks", () => {
    const thread = makeThread({
      id: ThreadId.makeUnsafe("thread-1"),
      session: {
        provider: "codex",
        status: "running",
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
      },
      messages: [
        {
          id: MessageId.makeUnsafe("user-1"),
          role: "user",
          text: "hello",
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:00.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant-1"),
          role: "assistant",
          text: "partial",
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-27T00:00:01.000Z",
          streaming: true,
        },
      ],
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
      },
      activities: [
        {
          id: EventId.makeUnsafe("activity-approval"),
          tone: "info",
          kind: "approval.requested",
          summary: "Approval requested",
          payload: {
            requestId: "approval-1",
            requestKind: "command",
          },
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-27T00:00:01.500Z",
        },
        {
          id: EventId.makeUnsafe("activity-input"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "input-1",
            questions: [
              {
                id: "question-1",
                header: "Question",
                question: "Proceed?",
                options: [{ label: "Yes", description: "Continue" }],
              },
            ],
          },
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-27T00:00:01.750Z",
        },
      ],
    });
    const state: AppState = {
      ...makeState(thread),
      sidebarThreadsById: {
        [thread.id]: {
          id: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          interactionMode: thread.interactionMode,
          session: thread.session,
          resumeState: thread.resumeState,
          createdAt: thread.createdAt,
          archivedAt: thread.archivedAt,
          updatedAt: thread.updatedAt,
          latestTurn: thread.latestTurn,
          parentThreadId: thread.parentThreadId,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          tag: thread.tag,
          latestUserMessageAt: "2026-02-27T00:00:00.000Z",
          hasPendingApprovals: true,
          hasPendingUserInput: true,
          hasActionableProposedPlan: false,
        },
      },
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: thread.id,
        messageId: MessageId.makeUnsafe("assistant-1"),
        role: "assistant",
        text: " response",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    );

    expect(next.sidebarThreadsById[thread.id]?.latestUserMessageAt).toBe(
      "2026-02-27T00:00:00.000Z",
    );
    expect(next.sidebarThreadsById[thread.id]?.hasPendingApprovals).toBe(true);
    expect(next.sidebarThreadsById[thread.id]?.hasPendingUserInput).toBe(true);
    expect(next.sidebarThreadsById[thread.id]?.latestTurn?.state).toBe("running");
    expect(next.sidebarThreadsById[thread.id]?.updatedAt).toBe("2026-02-27T00:00:00.000Z");
  });

  it("advances sidebar latestUserMessageAt when a user message arrives", () => {
    const thread = makeThread({
      id: ThreadId.makeUnsafe("thread-1"),
      messages: [
        {
          id: MessageId.makeUnsafe("user-1"),
          role: "user",
          text: "hello",
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:00.000Z",
          streaming: false,
        },
      ],
    });
    const state: AppState = {
      ...makeState(thread),
      sidebarThreadsById: {
        [thread.id]: {
          id: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          interactionMode: thread.interactionMode,
          session: thread.session,
          resumeState: thread.resumeState,
          createdAt: thread.createdAt,
          archivedAt: thread.archivedAt,
          updatedAt: thread.updatedAt,
          latestTurn: thread.latestTurn,
          parentThreadId: thread.parentThreadId,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          tag: thread.tag,
          latestUserMessageAt: "2026-02-27T00:00:00.000Z",
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
      },
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: thread.id,
        messageId: MessageId.makeUnsafe("user-2"),
        role: "user",
        text: "follow up",
        turnId: TurnId.makeUnsafe("turn-2"),
        streaming: false,
        createdAt: "2026-02-27T00:00:05.000Z",
        updatedAt: "2026-02-27T00:00:05.000Z",
      }),
    );

    expect(next.sidebarThreadsById[thread.id]?.latestUserMessageAt).toBe(
      "2026-02-27T00:00:05.000Z",
    );
    expect(next.sidebarThreadsById[thread.id]?.hasPendingApprovals).toBe(false);
    expect(next.sidebarThreadsById[thread.id]?.hasPendingUserInput).toBe(false);
  });

  it("applies replay batches in sequence and updates session state", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvents(state, [
      makeEvent(
        "thread.session-set",
        {
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.makeUnsafe("turn-1"),
            lastError: null,
            updatedAt: "2026-02-27T00:00:02.000Z",
          },
        },
        { sequence: 2 },
      ),
      makeEvent(
        "thread.message-sent",
        {
          threadId: thread.id,
          messageId: MessageId.makeUnsafe("assistant-1"),
          role: "assistant",
          text: "done",
          turnId: TurnId.makeUnsafe("turn-1"),
          streaming: false,
          createdAt: "2026-02-27T00:00:03.000Z",
          updatedAt: "2026-02-27T00:00:03.000Z",
        },
        { sequence: 3 },
      ),
    ]);

    expect(next.threads[0]?.session?.status).toBe("running");
    expect(next.threads[0]?.latestTurn?.state).toBe("completed");
    expect(next.threads[0]?.messages).toHaveLength(1);
  });

  it("clears the running session shimmer state when the active turn is interrupted", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const thread = makeThread({
      session: {
        provider: "shiori",
        status: "running",
        orchestrationStatus: "running",
        activeTurnId: turnId,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
      },
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });

    const next = applyOrchestrationEvent(
      makeState(thread),
      makeEvent("thread.turn-interrupt-requested", {
        threadId: thread.id,
        turnId,
        createdAt: "2026-02-27T00:00:05.000Z",
      }),
    );

    expect(next.threads[0]?.session?.status).toBe("ready");
    expect(next.threads[0]?.session?.orchestrationStatus).toBe("interrupted");
    expect(next.threads[0]?.session?.activeTurnId).toBeUndefined();
    expect(next.threads[0]?.latestTurn?.state).toBe("interrupted");
  });

  it("does not regress latestTurn when an older turn diff completes late", () => {
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-2"),
          state: "running",
          requestedAt: "2026-02-27T00:00:02.000Z",
          startedAt: "2026-02-27T00:00:03.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
        completedAt: "2026-02-27T00:00:04.000Z",
      }),
    );

    expect(next.threads[0]?.turnDiffSummaries).toHaveLength(1);
    expect(next.threads[0]?.latestTurn).toEqual(state.threads[0]?.latestTurn);
  });

  it("rebinds live turn diffs to the authoritative assistant message when it arrives later", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:02.000Z",
          assistantMessageId: MessageId.makeUnsafe("assistant:turn-1"),
        },
        turnDiffSummaries: [
          {
            turnId,
            completedAt: "2026-02-27T00:00:02.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
            assistantMessageId: MessageId.makeUnsafe("assistant:turn-1"),
            files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("assistant-real"),
        role: "assistant",
        text: "final answer",
        turnId,
        streaming: false,
        createdAt: "2026-02-27T00:00:03.000Z",
        updatedAt: "2026-02-27T00:00:03.000Z",
      }),
    );

    expect(next.threads[0]?.turnDiffSummaries[0]?.assistantMessageId).toBe(
      MessageId.makeUnsafe("assistant-real"),
    );
    expect(next.threads[0]?.latestTurn?.assistantMessageId).toBe(
      MessageId.makeUnsafe("assistant-real"),
    );
  });

  it("compacts snapshot reasoning deltas so they do not crowd out tool history", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const activities: Thread["activities"] = [
      makeThreadActivity({
        id: "tool-earlier",
        kind: "tool.completed",
        summary: "Read file",
        tone: "tool",
        createdAt: "2026-02-27T00:00:01.000Z",
        turnId,
        payload: {
          itemType: "command_execution",
          title: "Read file",
          detail: "src/a.ts",
        },
      }),
      makeThreadActivity({
        id: "reasoning-start",
        kind: "reasoning.started",
        summary: "Thinking",
        createdAt: "2026-02-27T00:00:02.000Z",
        turnId,
        payload: { itemId: "reasoning-item-1" },
      }),
      ...Array.from({ length: 700 }, (_, index) =>
        makeThreadActivity({
          id: `reasoning-delta-${index}`,
          kind: "reasoning.delta",
          summary: "Thinking",
          createdAt: `2026-02-27T00:00:${String(3 + (index % 50)).padStart(2, "0")}.000Z`,
          turnId,
          payload: {
            itemId: "reasoning-item-1",
            delta: `chunk-${index} `,
          },
        }),
      ),
      makeThreadActivity({
        id: "reasoning-complete",
        kind: "reasoning.completed",
        summary: "Thought",
        createdAt: "2026-02-27T00:01:00.000Z",
        turnId,
        payload: { itemId: "reasoning-item-1" },
      }),
    ];

    const next = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(
        makeReadModelThread({
          activities,
        }),
      ),
    );

    expect(next.threads[0]?.activities.some((activity) => activity.id === "tool-earlier")).toBe(
      true,
    );
    expect(
      next.threads[0]?.activities.filter((activity) => activity.kind === "reasoning.delta"),
    ).toHaveLength(1);
  });

  it("preserves reasoning delta whitespace when compacting adjacent chunks", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const next = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(
        makeReadModelThread({
          activities: [
            makeThreadActivity({
              id: "reasoning-start",
              kind: "reasoning.started",
              summary: "Thinking",
              createdAt: "2026-02-27T00:00:01.000Z",
              turnId,
              payload: { itemId: "reasoning-item-1" },
            }),
            makeThreadActivity({
              id: "reasoning-delta-1",
              kind: "reasoning.delta",
              summary: "Thinking",
              createdAt: "2026-02-27T00:00:02.000Z",
              turnId,
              payload: { itemId: "reasoning-item-1", delta: "The new" },
            }),
            makeThreadActivity({
              id: "reasoning-delta-2",
              kind: "reasoning.delta",
              summary: "Thinking",
              createdAt: "2026-02-27T00:00:03.000Z",
              turnId,
              payload: { itemId: "reasoning-item-1", delta: " " },
            }),
            makeThreadActivity({
              id: "reasoning-delta-3",
              kind: "reasoning.delta",
              summary: "Thinking",
              createdAt: "2026-02-27T00:00:04.000Z",
              turnId,
              payload: { itemId: "reasoning-item-1", delta: "internal modules are in place." },
            }),
          ],
        }),
      ),
    );

    const reasoningDelta = next.threads[0]?.activities.find(
      (activity) => activity.kind === "reasoning.delta",
    );
    const payload =
      reasoningDelta?.payload && typeof reasoningDelta.payload === "object"
        ? (reasoningDelta.payload as Record<string, unknown>)
        : null;

    expect(reasoningDelta).toBeDefined();
    expect(payload?.delta).toBe("The new internal modules are in place.");
  });

  it("compacts appended reasoning deltas before enforcing the activity cap", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const initialThread = makeThread({
      activities: [
        makeThreadActivity({
          id: "tool-earlier",
          kind: "tool.completed",
          summary: "Read file",
          tone: "tool",
          createdAt: "2026-02-27T00:00:01.000Z",
          turnId,
          payload: {
            itemType: "command_execution",
            title: "Read file",
            detail: "src/a.ts",
          },
        }),
        makeThreadActivity({
          id: "reasoning-start",
          kind: "reasoning.started",
          summary: "Thinking",
          createdAt: "2026-02-27T00:00:02.000Z",
          turnId,
          payload: { itemId: "reasoning-item-1" },
        }),
      ],
    });

    const next = applyOrchestrationEvents(
      makeState(initialThread),
      Array.from({ length: 700 }, (_, index) =>
        makeEvent(
          "thread.activity-appended",
          {
            threadId: initialThread.id,
            activity: makeThreadActivity({
              id: `reasoning-delta-${index}`,
              kind: "reasoning.delta",
              summary: "Thinking",
              createdAt: `2026-02-27T00:00:${String(3 + (index % 50)).padStart(2, "0")}.000Z`,
              turnId,
              payload: {
                itemId: "reasoning-item-1",
                delta: `chunk-${index} `,
              },
            }),
          },
          { sequence: index + 1 },
        ),
      ),
    );

    expect(next.threads[0]?.activities.some((activity) => activity.id === "tool-earlier")).toBe(
      true,
    );
    expect(
      next.threads[0]?.activities.filter((activity) => activity.kind === "reasoning.delta"),
    ).toHaveLength(1);
  });

  it("reverts messages, plans, activities, and checkpoints by retained turns", () => {
    const state = makeState(
      makeThread({
        messages: [
          {
            id: MessageId.makeUnsafe("user-1"),
            role: "user",
            text: "first",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
            completedAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "first reply",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:01.000Z",
            completedAt: "2026-02-27T00:00:01.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("user-2"),
            role: "user",
            text: "second",
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
            completedAt: "2026-02-27T00:00:02.000Z",
            streaming: false,
          },
        ],
        proposedPlans: [
          {
            id: "plan-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "plan 1",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: "plan-2",
            turnId: TurnId.makeUnsafe("turn-2"),
            planMarkdown: "plan 2",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:00:02.000Z",
            updatedAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        activities: [
          {
            id: EventId.makeUnsafe("activity-1"),
            tone: "info",
            kind: "step",
            summary: "one",
            payload: {},
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: EventId.makeUnsafe("activity-2"),
            tone: "info",
            kind: "step",
            summary: "two",
            payload: {},
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        turnDiffSummaries: [
          {
            turnId: TurnId.makeUnsafe("turn-1"),
            completedAt: "2026-02-27T00:00:01.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe("ref-1"),
            files: [],
          },
          {
            turnId: TurnId.makeUnsafe("turn-2"),
            completedAt: "2026-02-27T00:00:03.000Z",
            status: "ready",
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.makeUnsafe("ref-2"),
            files: [],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.reverted", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
      }),
    );

    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
    expect(next.threads[0]?.proposedPlans.map((plan) => plan.id)).toEqual(["plan-1"]);
    expect(next.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.makeUnsafe("activity-1"),
    ]);
    expect(next.threads[0]?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual([
      TurnId.makeUnsafe("turn-1"),
    ]);
  });

  it("clears pending source proposed plans after revert before a new session-set event", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-2"),
        state: "completed",
        requestedAt: "2026-02-27T00:00:02.000Z",
        startedAt: "2026-02-27T00:00:02.000Z",
        completedAt: "2026-02-27T00:00:03.000Z",
        assistantMessageId: MessageId.makeUnsafe("assistant-2"),
        sourceProposedPlan: {
          threadId: ThreadId.makeUnsafe("thread-source"),
          planId: "plan-2" as never,
        },
      },
      pendingSourceProposedPlan: {
        threadId: ThreadId.makeUnsafe("thread-source"),
        planId: "plan-2" as never,
      },
      turnDiffSummaries: [
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          completedAt: "2026-02-27T00:00:01.000Z",
          status: "ready",
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe("ref-1"),
          files: [],
        },
        {
          turnId: TurnId.makeUnsafe("turn-2"),
          completedAt: "2026-02-27T00:00:03.000Z",
          status: "ready",
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.makeUnsafe("ref-2"),
          files: [],
        },
      ],
    });
    const reverted = applyOrchestrationEvent(
      makeState(thread),
      makeEvent("thread.reverted", {
        threadId: thread.id,
        turnCount: 1,
      }),
    );

    expect(reverted.threads[0]?.pendingSourceProposedPlan).toBeUndefined();

    const next = applyOrchestrationEvent(
      reverted,
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("turn-3"),
          lastError: null,
          updatedAt: "2026-02-27T00:00:04.000Z",
        },
      }),
    );

    expect(next.threads[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-3"),
      state: "running",
    });
    expect(next.threads[0]?.latestTurn?.sourceProposedPlan).toBeUndefined();
  });
});
