import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  OrchestrationEvent,
  OrchestrationReadModel,
  ProviderRuntimeEvent,
  ProviderSession,
  ThreadGoalStatus,
} from "contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  KanbanItemAssigneeId,
  KanbanItemId,
  MessageId,
  ProjectId,
  ProviderItemId,
  type ServerSettings,
  ThreadId,
  TurnId,
} from "contracts";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurnRepositoryShape,
} from "../../persistence/Services/ProjectionTurns.ts";
import {
  ProviderService,
  type ProviderSessionReconciliation,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { deriveWorkLogEntries } from "shared/orchestrationSession";
import { ProviderRuntimeIngestionUnprovided } from "./ProviderRuntimeIngestion.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

function makeTestServerSettingsLayer(overrides: Partial<ServerSettings> = {}) {
  return ServerSettingsService.layerTest(overrides);
}

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderRuntimeEvent["provider"];
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

type LegacyTurnCompletedEvent = LegacyProviderRuntimeEvent & {
  readonly type: "turn.completed";
  readonly payload?: undefined;
  readonly status: "completed" | "failed" | "interrupted" | "cancelled";
  readonly errorMessage?: string | undefined;
};

function isLegacyTurnCompletedEvent(
  event: LegacyProviderRuntimeEvent,
): event is LegacyTurnCompletedEvent {
  return (
    event.type === "turn.completed" &&
    event.payload === undefined &&
    typeof event.status === "string"
  );
}

function createProviderServiceHarness() {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const runtimeSessions: ProviderSession[] = [];
  let reconciliations: ReadonlyArray<ProviderSessionReconciliation> = [];

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    steerTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([...runtimeSessions]),
    reconcileSessions: () => Effect.succeed(reconciliations),
    getCapabilities: () =>
      Effect.succeed({
        sessionModelSwitch: "in-session",
        recovery: { supportsResumeCursor: false, supportsAdoptActiveSession: false },
        observability: { emitsStructuredSessionExit: false, emitsRuntimeDiagnostics: false },
      }),
    readUsage: () => unsupported(),
    rollbackConversation: () => unsupported(),
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };

  const setSession = (session: ProviderSession): void => {
    const existingIndex = runtimeSessions.findIndex((entry) => entry.threadId === session.threadId);
    if (existingIndex >= 0) {
      runtimeSessions[existingIndex] = session;
      return;
    }
    runtimeSessions.push(session);
  };
  const setReconciliations = (next: ReadonlyArray<ProviderSessionReconciliation>): void => {
    reconciliations = next;
  };

  const normalizeLegacyEvent = (event: LegacyProviderRuntimeEvent): ProviderRuntimeEvent => {
    if (isLegacyTurnCompletedEvent(event)) {
      const normalized: Extract<ProviderRuntimeEvent, { type: "turn.completed" }> = {
        ...(event as Omit<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>, "payload">),
        payload: {
          state: event.status,
          ...(typeof event.errorMessage === "string" ? { errorMessage: event.errorMessage } : {}),
        },
      };
      return normalized;
    }

    return event as ProviderRuntimeEvent;
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, normalizeLegacyEvent(event)));
  };

  return {
    service,
    emit,
    setSession,
    setReconciliations,
  };
}

async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: ProviderRuntimeTestThread) => boolean,
  timeoutMs = 2000,
  threadId: ThreadId = asThreadId("thread-1"),
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<ProviderRuntimeTestThread> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for thread state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

async function waitForKanbanItem(
  engine: OrchestrationEngineShape,
  itemId: KanbanItemId,
  predicate: (item: ProviderRuntimeTestKanbanItem) => boolean,
  timeoutMs = 2000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<ProviderRuntimeTestKanbanItem> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const item = (readModel.kanbanItems ?? []).find((entry) => entry.id === itemId);
    if (item && predicate(item)) {
      return item;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for kanban item state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

type ProviderRuntimeTestReadModel = OrchestrationReadModel;
type ProviderRuntimeTestThread = ProviderRuntimeTestReadModel["threads"][number];
type ProviderRuntimeTestKanbanItem = NonNullable<
  ProviderRuntimeTestReadModel["kanbanItems"]
>[number];
type ProviderRuntimeTestMessage = ProviderRuntimeTestThread["messages"][number];
type ProviderRuntimeTestProposedPlan = ProviderRuntimeTestThread["proposedPlans"][number];
type ProviderRuntimeTestActivity = ProviderRuntimeTestThread["activities"][number];
type ProviderRuntimeTestCheckpoint = ProviderRuntimeTestThread["checkpoints"][number];

describe("ProviderRuntimeIngestion", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderRuntimeIngestionService,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const additionalRuntimeDisposers: Array<() => Promise<void>> = [];
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    for (const dispose of additionalRuntimeDisposers.splice(0).reverse()) {
      await dispose();
    }
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createHarness(options?: { serverSettings?: Partial<ServerSettings> }) {
    const workspaceRoot = makeTempDir("t3-provider-project-");
    fs.mkdirSync(path.join(workspaceRoot, ".git"));
    const provider = createProviderServiceHarness();
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionTurnRepositoryLayer = ProjectionTurnRepositoryLive;
    const ingestionLayer = ProviderRuntimeIngestionUnprovided.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provide(projectionTurnRepositoryLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(makeTestServerSettingsLayer(options?.serverSettings)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
    );
    let projectionTurnRepository: ProjectionTurnRepositoryShape | undefined;
    const captureProjectionTurnRepositoryLayer = Layer.effectDiscard(
      Effect.service(ProjectionTurnRepository).pipe(
        Effect.tap((repository) =>
          Effect.sync(() => {
            projectionTurnRepository = repository;
          }),
        ),
      ),
    ).pipe(Layer.provide(projectionTurnRepositoryLayer));
    const layer = Layer.merge(ingestionLayer, captureProjectionTurnRepositoryLayer).pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    if (projectionTurnRepository === undefined) {
      throw new Error("Projection turn repository capture layer did not initialize");
    }
    const sharedProjectionTurnRepository = projectionTurnRepository;
    let ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(ingestion.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(ingestion.drain);
    const restartIngestion = async () => {
      if (scope) {
        await Effect.runPromise(Scope.close(scope, Exit.void));
      }

      const restartedLayer = ProviderRuntimeIngestionUnprovided.pipe(
        Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
        Layer.provideMerge(Layer.succeed(ProjectionTurnRepository, sharedProjectionTurnRepository)),
        Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
        Layer.provideMerge(makeTestServerSettingsLayer(options?.serverSettings)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(NodeServices.layer),
      );
      const restartedRuntime = ManagedRuntime.make(restartedLayer);
      additionalRuntimeDisposers.push(() => restartedRuntime.dispose());
      ingestion = await restartedRuntime.runPromise(
        Effect.service(ProviderRuntimeIngestionService),
      );
      scope = await Effect.runPromise(Scope.make("sequential"));
      await Effect.runPromise(ingestion.start().pipe(Scope.provide(scope)));
      await new Promise((resolve) => setTimeout(resolve, 10));
    };

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-provider-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-seed"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    provider.setSession({
      provider: "codex",
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt,
      updatedAt: createdAt,
    });

    return {
      engine,
      emit: provider.emit,
      setProviderSession: provider.setSession,
      setProviderReconciliations: provider.setReconciliations,
      drain,
      restartIngestion,
    };
  }

  async function prepareAutomationKanbanWork(
    harness: Awaited<ReturnType<typeof createHarness>>,
    itemId: KanbanItemId,
    now: string,
  ) {
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe(`cmd-automation-tag-${itemId}`),
        threadId: asThreadId("thread-1"),
        tag: "automation",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "kanbanItem.create",
        commandId: CommandId.makeUnsafe(`cmd-kanban-create-${itemId}`),
        itemId,
        projectId: asProjectId("project-1"),
        pullRequest: null,
        title: "Finish this logical operation",
        description: "",
        status: "in_progress",
        sortKey: "001",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "kanbanItem.assign",
        commandId: CommandId.makeUnsafe(`cmd-kanban-assign-${itemId}`),
        itemId,
        assignee: {
          id: KanbanItemAssigneeId.makeUnsafe(`assignee-${itemId}`),
          provider: "codex",
          model: "gpt-5.4",
          role: "owner",
          status: "assigned",
          threadId: asThreadId("thread-1"),
          assignedAt: now,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
  }

  async function setHarnessGoal(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      commandId: string;
      objective?: string;
      status?: ThreadGoalStatus;
      tokenBudget?: number | null;
      tokensUsed?: number;
      timeUsedSeconds?: number;
      createdAt: string;
      updatedAt?: string;
    },
  ) {
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.snapshot.set",
        commandId: CommandId.makeUnsafe(input.commandId),
        threadId: asThreadId("thread-1"),
        goal: {
          threadId: asThreadId("thread-1"),
          lifecycleId: `goal:${input.commandId}`,
          objective: input.objective ?? "Exercise the ShioriCode goal harness",
          status: input.status ?? "active",
          tokenBudget: input.tokenBudget ?? null,
          tokensUsed: input.tokensUsed ?? 0,
          timeUsedSeconds: input.timeUsedSeconds ?? 0,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt ?? input.createdAt,
        },
        createdAt: input.updatedAt ?? input.createdAt,
      }),
    );
  }

  async function startHarnessGoalTurn(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      provider: ProviderRuntimeEvent["provider"];
      turnId: TurnId;
      startedAt: string;
    },
  ) {
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe(`cmd-session-${input.provider}-${input.turnId}`),
        threadId: asThreadId("thread-1"),
        session: {
          threadId: asThreadId("thread-1"),
          status: "ready",
          providerName: input.provider,
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          updatedAt: input.startedAt,
          lastError: null,
        },
        createdAt: input.startedAt,
      }),
    );
    harness.emit({
      type: "turn.started",
      eventId: asEventId(`evt-start-${input.provider}-${input.turnId}`),
      provider: input.provider,
      threadId: asThreadId("thread-1"),
      createdAt: input.startedAt,
      turnId: input.turnId,
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.activeTurnId === input.turnId &&
        thread.latestTurn?.turnId === input.turnId &&
        thread.latestTurn.state === "running",
    );
  }

  async function requestHarnessTurn(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      readonly commandId: string;
      readonly interactionMode: "default" | "plan";
      readonly createdAt: string;
    },
  ) {
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(input.commandId),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: MessageId.makeUnsafe(`message:${input.commandId}`),
          role: "user",
          text: "Continue the requested work",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: input.interactionMode,
        createdAt: input.createdAt,
      }),
    );
    await harness.drain();
  }

  it("maps turn started/completed events into thread session updates", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-1"),
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === "turn-1",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "failed",
        errorMessage: "turn failed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "turn failed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("turn failed");

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-terminal-replay"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      turnId: asTurnId("turn-1"),
    });
    await harness.drain();
    const afterReplay = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
    expect(afterReplay?.session).toMatchObject({
      status: "error",
      activeTurnId: null,
      lastError: "turn failed",
    });
  });

  it("requests provider session stop after an automation turn completes", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-automation-thread-tag"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        tag: "automation",
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-automation-turn-started"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-automation"),
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-automation-turn-completed"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-automation"),
      payload: {
        state: "completed",
      },
    });

    await harness.drain();

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(
      events.some(
        (event) =>
          event.type === "thread.session-stop-requested" &&
          event.payload.threadId === ThreadId.makeUnsafe("thread-1"),
      ),
    ).toBe(true);
  });

  it("moves assigned Kanban items to Done when the provider turn completes successfully", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const itemId = KanbanItemId.makeUnsafe("kanban-item-1");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "kanbanItem.create",
        commandId: CommandId.makeUnsafe("cmd-kanban-create"),
        itemId,
        projectId: asProjectId("project-1"),
        pullRequest: null,
        title: "Finish this thread",
        description: "",
        status: "in_progress",
        sortKey: "001",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "kanbanItem.assign",
        commandId: CommandId.makeUnsafe("cmd-kanban-assign"),
        itemId,
        assignee: {
          id: KanbanItemAssigneeId.makeUnsafe("kanban-assignee-1"),
          provider: "codex",
          model: "gpt-5.4",
          role: "owner",
          status: "assigned",
          threadId: asThreadId("thread-1"),
          assignedAt: now,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-kanban"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-kanban"),
      payload: {
        state: "completed",
      },
    });

    const item = await waitForKanbanItem(
      harness.engine,
      itemId,
      (entry) => entry.status === "done",
    );
    expect(item.completedAt).toBe(now);
  });

  it.each(["kimiCode", "gemini", "glm", "cursor", "codex", "claudeAgent"] as const)(
    "defers Kanban completion and automation stop for an active harness goal on %s",
    async (provider) => {
      const harness = await createHarness();
      const itemId = KanbanItemId.makeUnsafe(`kanban-item-deferred-goal-${provider}`);
      const goalCreatedAt = "2026-07-02T00:00:00.000Z";
      const turnCompletedAt = "2026-07-02T00:01:00.000Z";
      await prepareAutomationKanbanWork(harness, itemId, goalCreatedAt);

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe(`cmd-goal-provider-${provider}`),
          threadId: asThreadId("thread-1"),
          session: {
            threadId: asThreadId("thread-1"),
            status: "ready",
            providerName: provider,
            runtimeMode: "approval-required",
            activeTurnId: null,
            goalLifecycleKey: null,
            updatedAt: goalCreatedAt,
            lastError: null,
          },
          createdAt: goalCreatedAt,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.goal.snapshot.set",
          commandId: CommandId.makeUnsafe(`cmd-deferred-goal-${provider}`),
          threadId: asThreadId("thread-1"),
          goal: {
            threadId: asThreadId("thread-1"),
            lifecycleId: `goal:cmd-deferred-goal-${provider}`,
            objective: "Finish across multiple physical turns",
            status: "active",
            tokenBudget: 50_000,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: goalCreatedAt,
            updatedAt: goalCreatedAt,
          },
          createdAt: goalCreatedAt,
        }),
      );

      harness.emit({
        type: "turn.completed",
        eventId: asEventId(`evt-deferred-goal-${provider}`),
        provider,
        threadId: asThreadId("thread-1"),
        createdAt: turnCompletedAt,
        turnId: asTurnId(`turn-deferred-goal-${provider}`),
        payload: {
          state: "completed",
        },
      });
      await harness.drain();

      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      expect((readModel.kanbanItems ?? []).find((item) => item.id === itemId)?.status).toBe(
        "in_progress",
      );
      const events = await Effect.runPromise(
        Stream.runCollect(harness.engine.readEvents(0)).pipe(
          Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
        ),
      );
      expect(events.filter((event) => event.type === "thread.session-stop-requested")).toHaveLength(
        0,
      );
    },
  );

  it.each(["kimiCode", "gemini", "glm", "cursor", "codex", "claudeAgent"] as const)(
    "persists one harness continuation after a successful %s goal turn",
    async (provider) => {
      const harness = await createHarness();
      const turnId = asTurnId(`turn-goal-continuation-${provider}`);
      const startedAt = "2026-07-02T03:00:00.000Z";
      const completedAt = "2026-07-02T03:00:05.000Z";
      const commandId = `cmd-goal-continuation-${provider}`;
      await setHarnessGoal(harness, { commandId, createdAt: startedAt });
      await startHarnessGoalTurn(harness, { provider, turnId, startedAt });

      harness.emit({
        type: "turn.completed",
        eventId: asEventId(`evt-goal-continuation-${provider}`),
        provider,
        threadId: asThreadId("thread-1"),
        turnId,
        createdAt: completedAt,
        payload: { state: "completed" },
      });
      await harness.drain();

      const events = await Effect.runPromise(
        Stream.runCollect(harness.engine.readEvents(0)).pipe(
          Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
        ),
      );
      expect(
        events.filter(
          (event) =>
            event.type === "thread.goal-continuation-requested" &&
            event.payload.sourceTurnId === turnId,
        ),
      ).toHaveLength(1);
      const thread = await waitForThread(
        harness.engine,
        (entry) => entry.session?.status === "ready" && entry.session.activeTurnId === null,
      );
      expect(thread.goal?.status).toBe("active");
    },
  );

  it.each([
    { eventType: "turn.completed" as const, expectedStatus: "blocked" as const },
    { eventType: "turn.aborted" as const, expectedStatus: "paused" as const },
  ])("stops automatic goal work after $eventType", async ({ eventType, expectedStatus }) => {
    const harness = await createHarness();
    const turnId = asTurnId(`turn-goal-stop-${eventType}`);
    const startedAt = "2026-07-02T04:00:00.000Z";
    await setHarnessGoal(harness, {
      commandId: `cmd-goal-stop-${eventType}`,
      createdAt: startedAt,
    });
    await startHarnessGoalTurn(harness, {
      provider: "codex",
      turnId,
      startedAt,
    });

    harness.emit(
      eventType === "turn.completed"
        ? {
            type: "turn.completed",
            eventId: asEventId(`evt-goal-stop-${eventType}`),
            provider: "codex",
            threadId: asThreadId("thread-1"),
            turnId,
            createdAt: "2026-07-02T04:00:05.000Z",
            payload: { state: "failed", errorMessage: "terminal failure" },
          }
        : {
            type: "turn.aborted",
            eventId: asEventId(`evt-goal-stop-${eventType}`),
            provider: "codex",
            threadId: asThreadId("thread-1"),
            turnId,
            createdAt: "2026-07-02T04:00:05.000Z",
            payload: { reason: "interrupted" },
          },
    );
    await harness.drain();

    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.goal?.status === expectedStatus,
    );
    expect(thread.goal?.status).toBe(expectedStatus);
    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(
      events.filter((event) => event.type === "thread.goal-continuation-requested"),
    ).toHaveLength(0);
  });

  it.each(["interrupted", "cancelled"] as const)(
    "pauses automatic goal work after a %s terminal turn",
    async (state) => {
      const harness = await createHarness();
      const turnId = asTurnId(`turn-goal-${state}`);
      const startedAt = "2026-07-02T04:10:00.000Z";
      await setHarnessGoal(harness, { commandId: `cmd-goal-${state}`, createdAt: startedAt });
      await startHarnessGoalTurn(harness, { provider: "cursor", turnId, startedAt });

      harness.emit({
        type: "turn.completed",
        eventId: asEventId(`evt-goal-${state}`),
        provider: "cursor",
        threadId: asThreadId("thread-1"),
        turnId,
        createdAt: "2026-07-02T04:10:05.000Z",
        payload: { state },
      });
      await harness.drain();

      const thread = await waitForThread(
        harness.engine,
        (entry) => entry.goal?.status === "paused",
      );
      expect(thread.goal?.status).toBe("paused");
    },
  );

  it("maps provider usage exhaustion to usageLimited", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-goal-usage-limited");
    const startedAt = "2026-07-02T04:20:00.000Z";
    await setHarnessGoal(harness, { commandId: "cmd-goal-usage-limited", createdAt: startedAt });
    await startHarnessGoalTurn(harness, { provider: "claudeAgent", turnId, startedAt });

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-goal-usage-limited"),
      provider: "claudeAgent",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-07-02T04:20:05.000Z",
      payload: { state: "failed", errorMessage: "Usage limit reached for this account" },
    });
    await harness.drain();

    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.goal?.status === "usageLimited",
    );
    expect(thread.goal?.status).toBe("usageLimited");
  });

  it.each(["turn.completed", "turn.aborted"] as const)(
    "does not mutate a dormant active goal after a failed plan-mode %s event",
    async (eventType) => {
      const harness = await createHarness();
      const turnId = asTurnId(`turn-plan-goal-${eventType}`);
      const startedAt = "2026-07-02T04:30:00.000Z";
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.makeUnsafe(`cmd-plan-goal-${eventType}`),
          threadId: asThreadId("thread-1"),
          interactionMode: "plan",
          createdAt: startedAt,
        }),
      );
      await setHarnessGoal(harness, {
        commandId: `cmd-dormant-plan-goal-${eventType}`,
        createdAt: startedAt,
      });
      await startHarnessGoalTurn(harness, { provider: "codex", turnId, startedAt });
      const before = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
        (thread) => thread.id === asThreadId("thread-1"),
      )?.goal;

      harness.emit(
        eventType === "turn.completed"
          ? {
              type: "turn.completed",
              eventId: asEventId(`evt-plan-goal-${eventType}`),
              provider: "codex",
              threadId: asThreadId("thread-1"),
              turnId,
              createdAt: "2026-07-02T04:30:05.000Z",
              payload: { state: "failed", errorMessage: "plan failed" },
            }
          : {
              type: "turn.aborted",
              eventId: asEventId(`evt-plan-goal-${eventType}`),
              provider: "codex",
              threadId: asThreadId("thread-1"),
              turnId,
              createdAt: "2026-07-02T04:30:05.000Z",
              payload: { reason: "plan aborted" },
            },
      );
      await harness.drain();

      const after = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
        (thread) => thread.id === asThreadId("thread-1"),
      )?.goal;
      expect(after).toEqual(before);
      expect(after?.status).toBe("active");
    },
  );

  it.each([
    { eventType: "turn.completed" as const, expectedStatus: "blocked" as const },
    { eventType: "turn.aborted" as const, expectedStatus: "paused" as const },
  ])(
    "keeps a default-bound goal turn accounted after switching to plan for $eventType",
    async ({ eventType, expectedStatus }) => {
      const harness = await createHarness();
      const turnId = asTurnId(`turn-default-to-plan-${eventType}`);
      await setHarnessGoal(harness, {
        commandId: `cmd-default-to-plan-${eventType}`,
        createdAt: "2026-07-20T00:00:00.000Z",
      });
      await startHarnessGoalTurn(harness, {
        provider: "codex",
        turnId,
        startedAt: "2026-07-20T00:00:05.000Z",
      });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.makeUnsafe(`cmd-default-to-plan-mode-${eventType}`),
          threadId: asThreadId("thread-1"),
          interactionMode: "plan",
          createdAt: "2026-07-20T00:00:06.000Z",
        }),
      );

      harness.emit({
        type: "thread.token-usage.updated",
        eventId: asEventId(`evt-default-to-plan-usage-${eventType}`),
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId,
        createdAt: "2026-07-20T00:00:07.000Z",
        payload: {
          usage: { usedTokens: 125, processedTokensDelta: 125 },
        },
      });
      harness.emit(
        eventType === "turn.completed"
          ? {
              type: "turn.completed",
              eventId: asEventId(`evt-default-to-plan-terminal-${eventType}`),
              provider: "codex",
              threadId: asThreadId("thread-1"),
              turnId,
              createdAt: "2026-07-20T00:00:15.000Z",
              payload: { state: "failed", errorMessage: "bound turn failed" },
            }
          : {
              type: "turn.aborted",
              eventId: asEventId(`evt-default-to-plan-terminal-${eventType}`),
              provider: "codex",
              threadId: asThreadId("thread-1"),
              turnId,
              createdAt: "2026-07-20T00:00:15.000Z",
              payload: { reason: "bound turn aborted" },
            },
      );
      await harness.drain();

      const thread = await waitForThread(
        harness.engine,
        (entry) =>
          entry.goal?.status === expectedStatus &&
          entry.goal.tokensUsed === 125 &&
          entry.goal.timeUsedSeconds === 10,
      );
      expect(thread.interactionMode).toBe("plan");
      expect(thread.goal).toMatchObject({
        status: expectedStatus,
        tokensUsed: 125,
        timeUsedSeconds: 10,
      });
    },
  );

  it.each(["turn.completed", "turn.aborted"] as const)(
    "keeps an unbound plan turn outside the goal after switching to default for %s",
    async (eventType) => {
      const harness = await createHarness();
      const turnId = asTurnId(`turn-plan-to-default-${eventType}`);
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.makeUnsafe(`cmd-plan-to-default-plan-${eventType}`),
          threadId: asThreadId("thread-1"),
          interactionMode: "plan",
          createdAt: "2026-07-20T01:00:00.000Z",
        }),
      );
      await setHarnessGoal(harness, {
        commandId: `cmd-plan-to-default-goal-${eventType}`,
        createdAt: "2026-07-20T01:00:01.000Z",
      });
      await startHarnessGoalTurn(harness, {
        provider: "cursor",
        turnId,
        startedAt: "2026-07-20T01:00:05.000Z",
      });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.makeUnsafe(`cmd-plan-to-default-default-${eventType}`),
          threadId: asThreadId("thread-1"),
          interactionMode: "default",
          createdAt: "2026-07-20T01:00:06.000Z",
        }),
      );
      const goalBeforeTerminal = (
        await Effect.runPromise(harness.engine.getReadModel())
      ).threads.find((thread) => thread.id === asThreadId("thread-1"))?.goal;

      harness.emit({
        type: "thread.token-usage.updated",
        eventId: asEventId(`evt-plan-to-default-usage-${eventType}`),
        provider: "cursor",
        threadId: asThreadId("thread-1"),
        turnId,
        createdAt: "2026-07-20T01:00:07.000Z",
        payload: {
          usage: { usedTokens: 500, processedTokensDelta: 500 },
        },
      });
      harness.emit(
        eventType === "turn.completed"
          ? {
              type: "turn.completed",
              eventId: asEventId(`evt-plan-to-default-terminal-${eventType}`),
              provider: "cursor",
              threadId: asThreadId("thread-1"),
              turnId,
              createdAt: "2026-07-20T01:00:15.000Z",
              payload: { state: "failed", errorMessage: "unbound plan turn failed" },
            }
          : {
              type: "turn.aborted",
              eventId: asEventId(`evt-plan-to-default-terminal-${eventType}`),
              provider: "cursor",
              threadId: asThreadId("thread-1"),
              turnId,
              createdAt: "2026-07-20T01:00:15.000Z",
              payload: { reason: "unbound plan turn aborted" },
            },
      );
      await harness.drain();

      const goalAfterTerminal = (
        await Effect.runPromise(harness.engine.getReadModel())
      ).threads.find((thread) => thread.id === asThreadId("thread-1"))?.goal;
      expect(goalAfterTerminal).toEqual(goalBeforeTerminal);
      expect(goalAfterTerminal).toMatchObject({
        status: "active",
        tokensUsed: 0,
        timeUsedSeconds: 0,
      });
    },
  );

  it.each([
    { reason: "provider crashed", expectedStatus: "blocked" as const },
    { reason: "Rate limit exceeded", expectedStatus: "usageLimited" as const },
  ])(
    "moves an active goal to $expectedStatus after a session error",
    async ({ reason, expectedStatus }) => {
      const harness = await createHarness();
      await setHarnessGoal(harness, {
        commandId: `cmd-session-error-goal-${expectedStatus}`,
        createdAt: "2026-07-02T04:40:00.000Z",
      });
      const eventAt = new Date(Date.now() + 1_000).toISOString();

      harness.emit({
        type: "session.state.changed",
        eventId: asEventId(`evt-session-error-goal-${expectedStatus}`),
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: eventAt,
        payload: { state: "error", reason },
      });
      await harness.drain();

      const thread = await waitForThread(
        harness.engine,
        (entry) => entry.goal?.status === expectedStatus,
      );
      expect(thread.goal?.status).toBe(expectedStatus);
    },
  );

  it("blocks an active goal when its provider session exits", async () => {
    const harness = await createHarness();
    await setHarnessGoal(harness, {
      commandId: "cmd-session-exited-goal",
      createdAt: "2026-07-02T04:50:00.000Z",
    });
    const eventAt = new Date(Date.now() + 1_000).toISOString();

    harness.emit({
      type: "session.exited",
      eventId: asEventId("evt-session-exited-goal"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: eventAt,
      payload: {
        reason: "provider process exited",
        recoverable: true,
        exitKind: "error",
      },
    });
    await harness.drain();

    const thread = await waitForThread(harness.engine, (entry) => entry.goal?.status === "blocked");
    expect(thread.goal?.status).toBe("blocked");
  });

  it("keeps the goal active and requests continuation after a graceful session exit", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-goal-graceful-exit");
    await setHarnessGoal(harness, {
      commandId: "cmd-goal-graceful-exit",
      createdAt: "2026-07-20T02:00:00.000Z",
    });
    await startHarnessGoalTurn(harness, {
      provider: "codex",
      turnId,
      startedAt: "2026-07-20T02:00:05.000Z",
    });

    harness.emit({
      type: "session.exited",
      eventId: asEventId("evt-goal-graceful-exit"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: "2026-07-20T02:00:10.000Z",
      payload: {
        reason: "provider finished cleanly",
        recoverable: false,
        exitKind: "graceful",
      },
    });
    await harness.drain();

    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.session?.status === "stopped" && entry.session.activeTurnId === null,
    );
    expect(thread.goal?.status).toBe("active");
    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(
      events.filter(
        (event) =>
          event.type === "thread.goal-continuation-requested" &&
          event.payload.sourceTurnId === turnId,
      ),
    ).toHaveLength(1);
  });

  it.each([
    { message: "runtime exploded", expectedStatus: "blocked" as const },
    { message: "Usage limit reached for this account", expectedStatus: "usageLimited" as const },
  ])(
    "moves an active goal to $expectedStatus after a runtime error",
    async ({ message, expectedStatus }) => {
      const harness = await createHarness();
      await setHarnessGoal(harness, {
        commandId: `cmd-runtime-error-goal-${expectedStatus}`,
        createdAt: "2026-07-02T05:00:00.000Z",
      });

      harness.emit({
        type: "runtime.error",
        eventId: asEventId(`evt-runtime-error-goal-${expectedStatus}`),
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: "2026-07-02T05:00:05.000Z",
        payload: { message },
      });
      await harness.drain();

      const thread = await waitForThread(
        harness.engine,
        (entry) => entry.goal?.status === expectedStatus,
      );
      expect(thread.goal?.status).toBe(expectedStatus);
    },
  );

  it("preserves the active turn when a runtime error omits turnId", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-runtime-error-without-turn-id");
    await setHarnessGoal(harness, {
      commandId: "cmd-runtime-error-without-turn-id",
      createdAt: "2026-07-20T03:00:00.000Z",
    });
    await startHarnessGoalTurn(harness, {
      provider: "claudeAgent",
      turnId,
      startedAt: "2026-07-20T03:00:05.000Z",
    });

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-without-turn-id"),
      provider: "claudeAgent",
      threadId: asThreadId("thread-1"),
      createdAt: "2026-07-20T03:00:10.000Z",
      payload: { message: "runtime failed without turn metadata" },
    });
    await harness.drain();

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session.activeTurnId === turnId &&
        entry.goal?.status === "blocked",
    );
    expect(thread.session).toMatchObject({
      status: "error",
      activeTurnId: turnId,
      goalLifecycleKey: "goal:cmd-runtime-error-without-turn-id",
      lastError: "runtime failed without turn metadata",
    });
  });

  it("ignores a stale lifecycle exit from the wrong provider", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-stale-provider-exit");
    await setHarnessGoal(harness, {
      commandId: "cmd-stale-provider-exit",
      createdAt: "2026-07-20T04:00:00.000Z",
    });
    await startHarnessGoalTurn(harness, {
      provider: "claudeAgent",
      turnId,
      startedAt: "2026-07-20T04:00:05.000Z",
    });
    const before = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
      (thread) => thread.id === asThreadId("thread-1"),
    );

    harness.emit({
      type: "session.exited",
      eventId: asEventId("evt-stale-provider-exit"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: "2026-07-20T04:00:10.000Z",
      payload: {
        reason: "old provider exited late",
        recoverable: true,
        exitKind: "error",
      },
    });
    await harness.drain();

    const after = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
      (thread) => thread.id === asThreadId("thread-1"),
    );
    expect(after?.session).toEqual(before?.session);
    expect(after?.goal).toEqual(before?.goal);
    expect(after?.session).toMatchObject({
      providerName: "claudeAgent",
      status: "running",
      activeTurnId: turnId,
      goalLifecycleKey: "goal:cmd-stale-provider-exit",
    });
    expect(after?.goal?.status).toBe("active");
  });

  it("applies provider session.state.changed transitions directly", async () => {
    const harness = await createHarness();
    const waitingAt = new Date().toISOString();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-waiting"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: waitingAt,
      payload: {
        state: "waiting",
        reason: "awaiting approval",
      },
    });

    let thread = await waitForThread(
      harness.engine,
      (entry) => entry.session?.status === "running" && entry.session?.activeTurnId === null,
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.lastError).toBeNull();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-error"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "error",
        reason: "provider crashed",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-stopped"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "stopped",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "stopped" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("stopped");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-ready"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "ready",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === null,
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.lastError).toBeNull();
  });

  it("does not clear active turn when session/thread started arrives mid-turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-midturn-lifecycle",
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-delayed-session-ready-after-goal-prebind"),
      provider: "codex",
      createdAt: "2026-07-21T04:00:02.500Z",
      threadId: asThreadId("thread-1"),
      payload: {
        state: "ready",
        reason: "startup readiness arrived after prebinding",
      },
    });
    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-midturn-lifecycle");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("accepts claude turn lifecycle when seeded thread id is a synthetic placeholder", async () => {
    const harness = await createHarness();
    const seededAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-seed-claude-placeholder"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          updatedAt: seededAt,
          lastError: null,
        },
        createdAt: seededAt,
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-claude-placeholder"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-claude-placeholder",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-claude-placeholder"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores auxiliary turn completions from a different provider thread", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-primary"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-primary",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-aux"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aux"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-primary");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-primary"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores non-active turn completion when runtime omits thread id", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-guarded"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-guarded-main",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-other"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-other"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-guarded-main");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-main"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("recovers a running session when Codex reports the thread has gone idle", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-idle-recovery"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-idle-recovery"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-idle-recovery",
    );

    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-thread-idle-idle-recovery"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      payload: {
        state: "idle",
      },
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("accounts and continues an active goal when idle is the provider's terminal signal", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-idle-goal-terminal");
    await setHarnessGoal(harness, {
      commandId: "cmd-idle-goal-terminal",
      createdAt: "2026-07-17T04:00:00.000Z",
    });
    await startHarnessGoalTurn(harness, {
      provider: "codex",
      turnId,
      startedAt: "2026-07-17T04:00:05.000Z",
    });

    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-idle-goal-terminal"),
      provider: "codex",
      createdAt: "2026-07-17T04:00:20.000Z",
      threadId: asThreadId("thread-1"),
      payload: { state: "idle" },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.goal?.timeUsedSeconds === 15,
    );
    expect(thread.goal?.status).toBe("active");

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(
      events.filter(
        (event) =>
          event.type === "thread.goal-continuation-requested" &&
          event.payload.sourceTurnId === turnId,
      ),
    ).toHaveLength(1);
  });

  it("ignores a stale idle signal instead of clearing a newer running turn", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-stale-idle");
    await startHarnessGoalTurn(harness, {
      provider: "codex",
      turnId,
      startedAt: "2026-07-17T04:10:05.000Z",
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-newer-running-before-stale-idle"),
        threadId: asThreadId("thread-1"),
        session: {
          threadId: asThreadId("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: "2026-07-17T04:10:20.000Z",
        },
        createdAt: "2026-07-17T04:10:20.000Z",
      }),
    );

    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-stale-idle"),
      provider: "codex",
      createdAt: "2026-07-17T04:10:10.000Z",
      threadId: asThreadId("thread-1"),
      payload: { state: "idle" },
    });
    await harness.drain();

    const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
    expect(thread?.session).toMatchObject({
      status: "running",
      activeTurnId: turnId,
      updatedAt: "2026-07-17T04:10:20.000Z",
    });
  });

  it("truncates oversized tool payload snapshots before storing thread activities", async () => {
    const harness = await createHarness();
    const oversizedContent = "A".repeat(21_500);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-tool-completed-oversized-read"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-oversized-read"),
      itemId: asItemId("item-oversized-read"),
      payload: {
        itemType: "dynamic_tool_call",
        title: "Read file",
        detail: "Read file: AGENTS.md",
        data: {
          toolName: "read_file",
          input: {
            path: "AGENTS.md",
          },
          result: {
            content: oversizedContent,
          },
          item: {
            result: {
              content: oversizedContent,
            },
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-tool-completed-oversized-read",
      ),
    );

    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-tool-completed-oversized-read",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const data =
      payload?.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : null;
    const result =
      data?.result && typeof data.result === "object"
        ? (data.result as Record<string, unknown>)
        : null;
    const item =
      data?.item && typeof data.item === "object" ? (data.item as Record<string, unknown>) : null;
    const itemResult =
      item?.result && typeof item.result === "object"
        ? (item.result as Record<string, unknown>)
        : null;

    const resultContent = typeof result?.content === "string" ? result.content : null;
    const itemResultContent = typeof itemResult?.content === "string" ? itemResult.content : null;

    expect(resultContent).not.toBeNull();
    expect(resultContent?.length).toBeLessThan(20_100);
    expect(resultContent).toContain("[truncated 1500 chars]");
    expect(itemResultContent).not.toBeNull();
    expect(itemResultContent?.length).toBeLessThan(20_100);
    expect(itemResultContent).toContain("[truncated 1500 chars]");
  });

  it("maps canonical content delta/item completed into finalized assistant messages", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-2"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: " world",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-1" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-1",
    );
    expect(message?.text).toBe("hello world");
    expect(message?.streaming).toBe(false);
  });

  it("adds markdown block spacing when assistant content indexes change", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-block-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-blocks"),
      itemId: asItemId("item-blocks"),
      payload: {
        streamKind: "assistant_text",
        delta: "Intro line.",
        contentIndex: 0,
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-block-2"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-blocks"),
      itemId: asItemId("item-blocks"),
      payload: {
        streamKind: "assistant_text",
        delta: "## Heading",
        contentIndex: 1,
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-blocks"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-blocks"),
      itemId: asItemId("item-blocks"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-blocks" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-blocks",
    );
    expect(message?.text).toBe("Intro line.\n\n## Heading");
    expect(message?.streaming).toBe(false);
  });

  it("uses assistant item completion detail when no assistant deltas were streamed", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-assistant-item-completed-no-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-delta"),
      itemId: asItemId("item-no-delta"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "assistant-only final text",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-no-delta" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-no-delta",
    );
    expect(message?.text).toBe("assistant-only final text");
    expect(message?.streaming).toBe(false);
  });

  it("projects completed plan items into first-class proposed plans", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-item-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-final"),
      payload: {
        planMarkdown: "## Ship plan\n\n- wire projection\n- render follow-up",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-final",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-plan-final",
    );
    expect(proposedPlan?.planMarkdown).toBe(
      "## Ship plan\n\n- wire projection\n- render follow-up",
    );
  });

  it("marks the source proposed plan implemented only after the target turn starts", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const targetTurnId = asTurnId("turn-plan-implement");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-source"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-source"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-target"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-target"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    harness.setProviderSession({
      provider: "codex",
      status: "ready",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: targetTurnId,
    });

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed"),
      provider: "codex",
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan-target"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    const sourceThreadBeforeStart = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id && proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadBeforeStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-plan-target-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: targetThreadId,
      turnId: targetTurnId,
    });

    const sourceThreadAfterStart = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id &&
            proposedPlan.implementedAt !== null &&
            proposedPlan.implementationThreadId === targetThreadId,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadAfterStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementationThreadId: "thread-implement",
    });
  });

  it("does not mark the source proposed plan implemented for a rejected turn.started event", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-1");
    const sourceTurnId = asTurnId("turn-plan-source");
    const activeTurnId = asTurnId("turn-already-running");
    const staleTurnId = asTurnId("turn-stale-start");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-source-guarded"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-source-guarded"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    harness.setProviderSession({
      provider: "codex",
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-already-running"),
      provider: "codex",
      createdAt,
      threadId: targetThreadId,
      turnId: activeTurnId,
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === activeTurnId,
      2_000,
      targetThreadId,
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-guarded"),
      provider: "codex",
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan-target-guarded"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-guarded"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-stale-plan-implementation"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: targetThreadId,
      turnId: staleTurnId,
    });

    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const sourceThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterRejectedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    const targetThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === targetThreadId,
    );
    expect(targetThreadAfterRejectedStart?.session?.status).toBe("running");
    expect(targetThreadAfterRejectedStart?.session?.activeTurnId).toBe(activeTurnId);
  });

  it("does not mark the source proposed plan implemented for an unrelated turn.started when no thread active turn is tracked", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const expectedTurnId = asTurnId("turn-plan-implement");
    const replayedTurnId = asTurnId("turn-replayed");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-source-unrelated"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-source-unrelated"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-target-unrelated"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-target-unrelated"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-unrelated"),
      provider: "codex",
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan-target-unrelated"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-unrelated"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    harness.setProviderSession({
      provider: "codex",
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: expectedTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-unrelated-plan-implementation"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: targetThreadId,
      turnId: replayedTurnId,
    });

    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const sourceThreadAfterUnrelatedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterUnrelatedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });
    const targetThreadAfterUnrelatedStart = readModel.threads.find(
      (entry) => entry.id === targetThreadId,
    );
    expect(targetThreadAfterUnrelatedStart?.session).toMatchObject({
      status: "ready",
      activeTurnId: null,
    });
  });

  it("finalizes buffered proposed-plan deltas into a first-class proposed plan on turn completion", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-plan-buffer"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-plan-buffer",
    );

    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "## Buffered plan\n\n- first",
      },
    });
    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-2"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "\n- second",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-plan-buffer"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        state: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-buffer",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-1:turn:turn-plan-buffer",
    );
    expect(proposedPlan?.planMarkdown).toBe("## Buffered plan\n\n- first\n- second");
  });

  it("buffers assistant deltas when assistant streaming is disabled", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: false } });
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-buffered",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        streamKind: "assistant_text",
        delta: "buffer me",
      },
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(
      midThread?.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-buffered",
      ),
    ).toBe(false);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered",
    );
    expect(message?.text).toBe("buffer me");
    expect(message?.streaming).toBe(false);
  });

  it("streams assistant deltas when thread.turn.start requests streaming mode", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-streaming-mode"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-streaming-mode"),
          role: "user",
          text: "stream please",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-mode",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello live",
      },
    });

    const liveThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" &&
          message.streaming &&
          message.text === "hello live",
      ),
    );
    const liveMessage = liveThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(liveMessage?.streaming).toBe(true);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "hello live",
      },
    });

    const finalThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" && !message.streaming,
      ),
    );
    const finalMessage = finalThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(finalMessage?.text).toBe("hello live");
    expect(finalMessage?.streaming).toBe(false);
  });

  it("keeps markdown block spacing while assistant streaming is enabled", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-streaming-blocks"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-streaming-blocks"),
          role: "user",
          text: "show blocks",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-blocks"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-blocks"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-blocks",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-blocks-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-blocks"),
      itemId: asItemId("item-streaming-blocks"),
      payload: {
        streamKind: "assistant_text",
        delta: "Intro line.",
        contentIndex: 0,
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-blocks-2"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-blocks"),
      itemId: asItemId("item-streaming-blocks"),
      payload: {
        streamKind: "assistant_text",
        delta: "## Heading",
        contentIndex: 1,
      },
    });

    const liveThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-blocks" &&
          message.streaming &&
          message.text === "Intro line.\n\n## Heading",
      ),
    );
    const liveMessage = liveThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-blocks",
    );
    expect(liveMessage?.streaming).toBe(true);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-blocks"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-blocks"),
      itemId: asItemId("item-streaming-blocks"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const finalThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-blocks" && !message.streaming,
      ),
    );
    const finalMessage = finalThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-blocks",
    );
    expect(finalMessage?.text).toBe("Intro line.\n\n## Heading");
    expect(finalMessage?.streaming).toBe(false);
  });

  it("spills oversized buffered deltas and still finalizes full assistant text", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const oversizedText = "x".repeat(40_000);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffer-spill",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        streamKind: "assistant_text",
        delta: oversizedText,
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffer-spill" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffer-spill",
    );
    expect(message?.text.length).toBe(oversizedText.length);
    expect(message?.text).toBe(oversizedText);
    expect(message?.streaming).toBe(false);
  });

  it("closes assistant state when a turn is aborted", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-aborted-buffer"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aborted-buffer"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-aborted-buffer",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-aborted-buffer"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aborted-buffer"),
      itemId: asItemId("item-aborted-buffer"),
      payload: {
        streamKind: "assistant_text",
        delta: "partial text that should not be retained",
      },
    });
    harness.emit({
      type: "turn.aborted",
      eventId: asEventId("evt-turn-aborted-buffer"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aborted-buffer"),
      payload: {
        reason: "interrupted",
      },
    });
    await harness.drain();

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.session?.activeTurnId === null &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-aborted-buffer" && !message.streaming,
        ),
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-after-aborted-buffer"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aborted-buffer"),
      payload: {
        state: "completed",
      },
    });
    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === "thread-1");
    const message = thread?.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-aborted-buffer",
    );
    expect(message?.text).toBe("partial text that should not be retained");
    expect(message?.streaming).toBe(false);
  });

  it("does not duplicate assistant completion when item.completed is followed by turn.completed", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-complete-dedup",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        streamKind: "assistant_text",
        delta: "done",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      payload: {
        state: "completed",
      },
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.session?.activeTurnId === null &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-complete-dedup" && !message.streaming,
        ),
    );

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const completionEvents = events.filter((event) => {
      if (event.type !== "thread.message-sent") {
        return false;
      }
      return (
        event.payload.messageId === "assistant:item-complete-dedup" &&
        event.payload.streaming === false
      );
    });
    expect(completionEvents).toHaveLength(1);
  });

  it("maps Codex commentary assistant items into status activities instead of chat messages", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-commentary"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-commentary"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-commentary",
    );

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-commentary-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-commentary"),
      itemId: asItemId("commentary-item"),
      raw: {
        source: "codex.app-server.notification",
        method: "item/started",
        payload: {
          item: {
            id: "commentary-item",
            type: "agentMessage",
            phase: "commentary",
          },
        },
      },
      payload: {
        itemType: "assistant_message",
        status: "inProgress",
        data: {
          item: {
            id: "commentary-item",
            phase: "commentary",
          },
        },
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-commentary-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-commentary"),
      itemId: asItemId("commentary-item"),
      payload: {
        streamKind: "assistant_text",
        delta: "Checking auth",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-commentary-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-commentary"),
      itemId: asItemId("commentary-item"),
      raw: {
        source: "codex.app-server.notification",
        method: "item/completed",
        payload: {
          item: {
            id: "commentary-item",
            type: "agentMessage",
            phase: "commentary",
            text: "Checking auth",
          },
        },
      },
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "Checking auth",
        data: {
          item: {
            id: "commentary-item",
            phase: "commentary",
            text: "Checking auth",
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "assistant.commentary" &&
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          (activity.payload as Record<string, unknown>).detail === "Checking auth",
      ),
    );

    expect(
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:commentary-item",
      ),
    ).toBe(false);
  });

  it("maps canonical request events into approval activities with requestKind", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.makeUnsafe("req-open"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
        args: {
          reason: "Need temporary network access",
          availableDecisions: ["accept", "decline"],
          networkApprovalContext: {
            host: "example.com",
          },
          proposedNetworkPolicyAmendments: [
            {
              host: "example.com",
              action: "allow",
            },
          ],
        },
      },
    });

    harness.emit({
      type: "request.resolved",
      eventId: asEventId("evt-request-resolved"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.makeUnsafe("req-open"),
      payload: {
        requestType: "command_execution_approval",
        decision: "accept",
      },
    });

    await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.resolved",
        ),
    );

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread).toBeDefined();

    const requested = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-opened",
    );
    const requestedPayload =
      requested?.payload && typeof requested.payload === "object"
        ? (requested.payload as Record<string, unknown>)
        : undefined;
    expect(requestedPayload?.requestKind).toBe("command");
    expect(requestedPayload?.requestType).toBe("command_execution_approval");
    expect(requestedPayload?.data).toEqual({
      reason: "Need temporary network access",
      availableDecisions: ["accept", "decline"],
      networkApprovalContext: {
        host: "example.com",
      },
      proposedNetworkPolicyAmendments: [
        {
          host: "example.com",
          action: "allow",
        },
      ],
    });

    const resolved = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolvedPayload?.requestKind).toBe("command");
    expect(resolvedPayload?.requestType).toBe("command_execution_approval");
  });

  it("maps Computer Use request events into approval activities with requestKind", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-computer-request-opened"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.makeUnsafe("req-computer-open"),
      payload: {
        requestType: "computer_use_approval",
        detail: "computer_click",
      },
    });

    await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-computer-request-opened",
      ),
    );

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    const requested = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-computer-request-opened",
    );
    const requestedPayload =
      requested?.payload && typeof requested.payload === "object"
        ? (requested.payload as Record<string, unknown>)
        : undefined;

    expect(requested?.summary).toBe("Computer Use approval requested");
    expect(requestedPayload?.requestKind).toBe("computer-use");
    expect(requestedPayload?.requestType).toBe("computer_use_approval");
  });

  it("maps runtime.error into errored session state", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-3"),
      payload: {
        message: "runtime exploded",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-3" &&
        entry.session?.lastError === "runtime exploded",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime exploded");
  });

  it("records runtime.error activities from the typed payload message", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-activity"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-runtime-error-activity"),
      payload: {
        message: "runtime activity exploded",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.id === "evt-runtime-error-activity"),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-runtime-error-activity",
    );
    const activityPayload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.kind).toBe("runtime.error");
    expect(activityPayload?.message).toBe("runtime activity exploded");
  });

  it("keeps the session running and hides runtime.warning activity during an active turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-warning-turn-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {},
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-warning-runtime"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {
        message: "Reconnecting... 2/5",
        detail: {
          willRetry: true,
        },
      },
    });

    await harness.drain();
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === "thread-1");
    expect(thread?.session?.status).toBe("running");
    expect(thread?.session?.activeTurnId).toBe("turn-warning");
    expect(thread?.session?.lastError).toBeNull();
    expect(thread?.activities.some((activity) => activity.id === "evt-warning-runtime")).toBe(
      false,
    );
  });

  it("records model verification events as visible thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "model.verification",
      eventId: asEventId("evt-model-verification"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-model-verification"),
      payload: {
        verifications: ["trustedAccessForCyber"],
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-model-verification",
      ),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-model-verification",
    );
    const activityPayload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.kind).toBe("model.verification");
    expect(activity?.summary).toBe("Model verification required");
    expect(activity?.tone).toBe("info");
    expect(activity?.turnId).toBe("turn-model-verification");
    expect(activityPayload?.verifications).toEqual(["trustedAccessForCyber"]);
  });

  it("records auto-approval review events as visible approval activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "approval.review.started",
      eventId: asEventId("evt-approval-review-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-approval-review"),
      itemId: "cmd_1",
      payload: {
        targetItemId: "cmd_1",
        reviewId: "review_1",
        status: "inProgress",
        riskLevel: "low",
        userAuthorization: "unknown",
        rationale: "Checking command risk.",
        review: {
          status: "inProgress",
          riskLevel: "low",
        },
        action: {
          type: "command",
          source: "shell",
          command: "bun run lint",
        },
      },
    });

    harness.emit({
      type: "approval.review.completed",
      eventId: asEventId("evt-approval-review-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-approval-review"),
      itemId: "cmd_1",
      payload: {
        targetItemId: "cmd_1",
        reviewId: "review_1",
        status: "approved",
        riskLevel: "medium",
        userAuthorization: "high",
        rationale: "Command is bounded to validation.",
        review: {
          status: "approved",
          riskLevel: "medium",
        },
        action: {
          type: "command",
          source: "shell",
          command: "bun run lint",
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-approval-review-completed",
      ),
    );
    const started = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-approval-review-started",
    );
    const completed = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-approval-review-completed",
    );
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(started?.kind).toBe("approval.review.started");
    expect(started?.summary).toBe("Auto-approval review started");
    expect(started?.tone).toBe("approval");
    expect(completed?.kind).toBe("approval.review.completed");
    expect(completed?.summary).toBe("Auto-approval approved");
    expect(completed?.tone).toBe("approval");
    expect(completed?.turnId).toBe("turn-approval-review");
    expect(completedPayload?.targetItemId).toBe("cmd_1");
    expect(completedPayload?.reviewId).toBe("review_1");
    expect(completedPayload?.status).toBe("approved");
    expect(completedPayload?.riskLevel).toBe("medium");
    expect(completedPayload?.userAuthorization).toBe("high");
    expect(completedPayload?.rationale).toBe("Command is bounded to validation.");
  });

  it("suppresses MCP refresh-token runtime warnings from thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-warning-turn-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {},
    });

    await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "running" && entry.session?.activeTurnId === "turn-warning",
    );

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-warning-runtime-mcp-refresh"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {
        message:
          '2026-04-11T18:23:36.330237Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Auth(TokenRefreshFailed("Server returned error response: invalid_grant: Invalid refresh token"))',
      },
    });

    await harness.drain();
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === "thread-1");
    expect(
      thread?.activities.some((activity) => activity.id === "evt-warning-runtime-mcp-refresh"),
    ).toBe(false);
    expect(thread?.session?.status).toBe("running");
    expect(thread?.session?.activeTurnId).toBe("turn-warning");
  });

  it("maps session/thread lifecycle and item.started into session/activity projections", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      message: "session started",
    });
    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-tool-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-9"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Read file",
        detail: "/tmp/file.ts",
        data: {
          toolName: "read_file",
          input: {
            path: "/tmp/file.ts",
          },
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
        ),
    );

    expect(thread.session?.status).toBe("ready");
    const toolStarted = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
    );
    const payload =
      toolStarted?.payload && typeof toolStarted.payload === "object"
        ? (toolStarted.payload as Record<string, unknown>)
        : null;
    const data =
      payload?.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : null;

    expect(toolStarted).toBeDefined();
    expect(data).toMatchObject({
      toolName: "read_file",
      input: {
        path: "/tmp/file.ts",
      },
    });
  });

  it("preserves a prebound goal across delayed provider start notifications", async () => {
    const harness = await createHarness();
    const lifecycleId = "goal:cmd-delayed-provider-start-binding";
    const preboundAt = "2026-07-21T04:00:00.000Z";
    await setHarnessGoal(harness, {
      commandId: "cmd-delayed-provider-start-binding",
      createdAt: preboundAt,
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-prebind-before-delayed-provider-start"),
        threadId: asThreadId("thread-1"),
        session: {
          threadId: asThreadId("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: lifecycleId,
          updatedAt: preboundAt,
          lastError: null,
        },
        createdAt: preboundAt,
      }),
    );

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-delayed-session-started-after-goal-prebind"),
      provider: "codex",
      createdAt: "2026-07-21T04:00:01.000Z",
      threadId: asThreadId("thread-1"),
      message: "session started",
    });
    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-delayed-thread-started-after-goal-prebind"),
      provider: "codex",
      createdAt: "2026-07-21T04:00:02.000Z",
      threadId: asThreadId("thread-1"),
    });
    await harness.drain();

    const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
    expect(thread?.session).toMatchObject({
      status: "ready",
      activeTurnId: null,
      goalLifecycleKey: lifecycleId,
    });

    const turnId = asTurnId("turn-delayed-provider-start-after-goal-rebind");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-rebind-before-delayed-provider-start"),
        threadId: asThreadId("thread-1"),
        session: {
          threadId: asThreadId("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          goalLifecycleKey: lifecycleId,
          updatedAt: "2026-07-21T04:00:03.000Z",
          lastError: null,
        },
        createdAt: "2026-07-21T04:00:03.000Z",
      }),
    );
    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-delayed-session-started-after-active-goal-rebind"),
      provider: "codex",
      createdAt: "2026-07-21T04:00:04.000Z",
      threadId: asThreadId("thread-1"),
      message: "session started late",
    });
    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-delayed-session-ready-after-active-goal-rebind"),
      provider: "codex",
      createdAt: "2026-07-21T04:00:05.000Z",
      threadId: asThreadId("thread-1"),
      payload: {
        state: "ready",
        reason: "startup readiness arrived late",
      },
    });
    await harness.drain();

    const rebound = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
    expect(rebound?.session).toMatchObject({
      status: "running",
      activeTurnId: turnId,
      goalLifecycleKey: lifecycleId,
    });
  });

  it("consumes P1 runtime events into thread metadata, diff checkpoints, and activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed by provider",
        metadata: { source: "provider" },
      },
    });

    harness.emit({
      type: "turn.plan.updated",
      eventId: asEventId("evt-turn-plan-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        explanation: "Working through the plan",
        plan: [
          { step: "Inspect files", status: "completed" },
          { step: "Apply patch", status: "in_progress" },
        ],
      },
    });

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-item-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-tool"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run tests",
        detail: "bun test",
        data: { pid: 123 },
      },
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-runtime-warning"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        message: "Provider got slow",
        detail: { latencyMs: 1500 },
      },
    });

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-turn-diff-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-assistant"),
      payload: {
        unifiedDiff: "diff --git a/file.txt b/file.txt\n+hello\n",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.title === "Renamed by provider" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "turn.plan.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.updated",
        ) &&
        entry.checkpoints.some(
          (checkpoint: ProviderRuntimeTestCheckpoint) => checkpoint.turnId === "turn-p1",
        ),
    );

    expect(thread.title).toBe("Renamed by provider");

    const planActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-turn-plan-updated",
    );
    const planPayload =
      planActivity?.payload && typeof planActivity.payload === "object"
        ? (planActivity.payload as Record<string, unknown>)
        : undefined;
    expect(planActivity?.kind).toBe("turn.plan.updated");
    expect(Array.isArray(planPayload?.plan)).toBe(true);

    const toolUpdate = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-item-updated",
    );
    const toolUpdatePayload =
      toolUpdate?.payload && typeof toolUpdate.payload === "object"
        ? (toolUpdate.payload as Record<string, unknown>)
        : undefined;
    expect(toolUpdate?.kind).toBe("tool.updated");
    expect(toolUpdatePayload?.itemId).toBe("item-p1-tool");
    expect(toolUpdatePayload?.title).toBe("Run tests");
    expect(toolUpdatePayload?.itemType).toBe("command_execution");
    expect(toolUpdatePayload?.status).toBe("in_progress");

    expect(
      thread.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-runtime-warning",
      ),
    ).toBe(false);

    const checkpoint = thread.checkpoints.find(
      (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-p1",
    );
    expect(checkpoint?.status).toBe("missing");
    expect(checkpoint?.assistantMessageId).toBe("assistant:item-p1-assistant");
    expect(checkpoint?.checkpointRef).toBe("provider-diff:evt-turn-diff-updated");
    expect(checkpoint?.files).toEqual([
      {
        path: "file.txt",
        kind: "modified",
        additions: 0,
        deletions: 0,
      },
    ]);
  });

  it.each(["kimiCode", "gemini", "glm", "cursor", "codex", "claudeAgent"] as const)(
    "accounts processed token deltas for %s through the harness goal",
    async (provider) => {
      const harness = await createHarness();
      const goalCreatedAt = "2026-07-04T00:00:00.000Z";
      const turnId = asTurnId(`turn-goal-accounting-${provider}`);
      await setHarnessGoal(harness, {
        commandId: `cmd-goal-accounting-${provider}`,
        createdAt: goalCreatedAt,
      });
      await startHarnessGoalTurn(harness, {
        provider,
        turnId,
        startedAt: "2026-07-04T00:00:05.000Z",
      });

      harness.emit({
        type: "thread.token-usage.updated",
        eventId: asEventId(`evt-goal-accounting-${provider}`),
        provider,
        threadId: asThreadId("thread-1"),
        turnId,
        createdAt: "2026-07-04T00:00:10.000Z",
        payload: {
          usage: {
            usedTokens: 321,
            processedTokensDelta: 321,
          },
        },
      });

      const thread = await waitForThread(harness.engine, (entry) => entry.goal?.tokensUsed === 321);
      expect(thread.goal).toMatchObject({
        status: "active",
        tokensUsed: 321,
        timeUsedSeconds: 0,
      });
    },
  );

  it("accounts elapsed wall time when the active provider turn terminates", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-goal-time-accounting");
    await setHarnessGoal(harness, {
      commandId: "cmd-goal-time-accounting",
      createdAt: "2026-07-04T01:00:00.000Z",
    });
    await startHarnessGoalTurn(harness, {
      provider: "gemini",
      turnId,
      startedAt: "2026-07-04T01:00:05.000Z",
    });

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-goal-time-accounting"),
      provider: "gemini",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-07-04T01:01:20.000Z",
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.goal?.timeUsedSeconds === 75,
    );
    expect(thread.goal).toMatchObject({
      status: "active",
      tokensUsed: 0,
      timeUsedSeconds: 75,
    });

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-goal-time-accounting-semantic-replay"),
      provider: "gemini",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-07-04T01:01:20.000Z",
      payload: { state: "completed" },
    });
    await harness.drain();
    const afterReplay = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
    expect(afterReplay?.goal?.timeUsedSeconds).toBe(75);
  });

  it("reconstructs the goal binding after ingestion restarts mid-turn", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-goal-ingestion-restart");
    await setHarnessGoal(harness, {
      commandId: "cmd-goal-ingestion-restart",
      createdAt: "2026-07-20T05:00:00.000Z",
    });
    await startHarnessGoalTurn(harness, {
      provider: "kimiCode",
      turnId,
      startedAt: "2026-07-20T05:00:05.000Z",
    });
    harness.setProviderSession({
      provider: "kimiCode",
      status: "running",
      runtimeMode: "approval-required",
      threadId: asThreadId("thread-1"),
      activeTurnId: turnId,
      createdAt: "2026-07-20T05:00:05.000Z",
      updatedAt: "2026-07-20T05:00:05.000Z",
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.makeUnsafe("cmd-goal-ingestion-restart-plan-mode"),
        threadId: asThreadId("thread-1"),
        interactionMode: "plan",
        createdAt: "2026-07-20T05:00:06.000Z",
      }),
    );

    await harness.restartIngestion();
    await harness.restartIngestion();
    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-goal-ingestion-restart-usage"),
      provider: "kimiCode",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-07-20T05:00:07.000Z",
      payload: {
        usage: { usedTokens: 222, processedTokensDelta: 222 },
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-goal-ingestion-restart-completed"),
      provider: "kimiCode",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-07-20T05:00:15.000Z",
      payload: { state: "completed" },
    });
    await harness.drain();

    const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
      (entry) => entry.id === asThreadId("thread-1"),
    );
    expect(thread?.session?.activeTurnId).toBeNull();
    expect(thread?.goal).toMatchObject({
      status: "active",
      tokensUsed: 222,
      timeUsedSeconds: 10,
    });
    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(
      events.filter(
        (event) =>
          event.type === "thread.goal-continuation-requested" &&
          event.payload.sourceTurnId === turnId,
      ),
    ).toHaveLength(0);
  });

  it("reconstructs two accepted pre-running goal turns in FIFO order after restart", async () => {
    const harness = await createHarness();
    const firstTurnId = asTurnId("turn-goal-queue-first");
    const secondTurnId = asTurnId("turn-goal-queue-second");
    const firstLifecycleId = "goal:cmd-goal-queue-first";
    const secondLifecycleId = "goal:cmd-goal-queue-second";

    await setHarnessGoal(harness, {
      commandId: "cmd-goal-queue-first",
      objective: "First accepted objective",
      createdAt: "2026-07-20T05:10:00.000Z",
    });
    await requestHarnessTurn(harness, {
      commandId: "cmd-turn-queue-first",
      interactionMode: "default",
      createdAt: "2026-07-20T05:10:01.000Z",
    });
    await setHarnessGoal(harness, {
      commandId: "cmd-goal-queue-second",
      objective: "Second accepted objective",
      createdAt: "2026-07-20T05:10:02.000Z",
    });
    await requestHarnessTurn(harness, {
      commandId: "cmd-turn-queue-second",
      interactionMode: "default",
      createdAt: "2026-07-20T05:10:03.000Z",
    });

    await harness.restartIngestion();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-goal-queue-first-started"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      turnId: firstTurnId,
      createdAt: "2026-07-20T05:10:04.000Z",
    });
    let thread = await waitForThread(
      harness.engine,
      (entry) => entry.session?.activeTurnId === firstTurnId,
    );
    expect(thread.session?.goalLifecycleKey).toBe(firstLifecycleId);

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-goal-queue-first-completed"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      turnId: firstTurnId,
      createdAt: "2026-07-20T05:10:05.000Z",
      payload: { state: "completed" },
    });
    await waitForThread(
      harness.engine,
      (entry) => entry.session?.activeTurnId === null && entry.latestTurn?.turnId === firstTurnId,
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-goal-queue-second-started"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      turnId: secondTurnId,
      createdAt: "2026-07-20T05:10:06.000Z",
    });
    thread = await waitForThread(
      harness.engine,
      (entry) => entry.session?.activeTurnId === secondTurnId,
    );
    expect(thread.session?.goalLifecycleKey).toBe(secondLifecycleId);
  });

  it("recovers an accepted goal continuation across the provider-ack crash gap", async () => {
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("turn-recovered-goal-continuation");
    const lifecycleId = "goal:cmd-recovered-goal-continuation";
    await setHarnessGoal(harness, {
      commandId: "cmd-recovered-goal-continuation",
      objective: "Survive provider acceptance before session projection",
      createdAt: "2026-07-20T05:20:00.000Z",
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.continue",
        commandId: CommandId.makeUnsafe("cmd-recovered-goal-continuation-send"),
        threadId,
        expectedGoalLifecycleKey: lifecycleId,
        sourceTurnId: asTurnId("turn-before-recovered-continuation"),
        createdAt: "2026-07-20T05:20:01.000Z",
      }),
    );

    const providerSession: ProviderSession = {
      provider: "codex",
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      activeTurnId: turnId,
      createdAt: "2026-07-20T05:20:01.000Z",
      updatedAt: "2026-07-20T05:20:02.000Z",
    };
    harness.setProviderSession(providerSession);
    harness.setProviderReconciliations([
      {
        threadId,
        provider: "codex",
        session: providerSession,
        resumeState: "resumed",
        runtimeMode: "approval-required",
        lastError: null,
      },
    ]);

    await harness.restartIngestion();
    let thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "running" &&
        entry.session?.activeTurnId === turnId &&
        entry.session?.goalLifecycleKey === lifecycleId,
    );
    expect(thread.latestTurn).toMatchObject({
      turnId,
      state: "running",
    });

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-recovered-goal-continuation-usage"),
      provider: "codex",
      threadId,
      turnId,
      createdAt: "2026-07-20T05:20:03.000Z",
      payload: { usage: { usedTokens: 77, processedTokensDelta: 77 } },
    });
    thread = await waitForThread(harness.engine, (entry) => entry.goal?.tokensUsed === 77);
    expect(thread.goal?.lifecycleId).toBe(lifecycleId);
  });

  it("keeps request-time goal ownership when mode changes before turn.started", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-goal-request-mode-race");
    const lifecycleId = "goal:cmd-goal-request-mode-race";
    await setHarnessGoal(harness, {
      commandId: "cmd-goal-request-mode-race",
      createdAt: "2026-07-21T00:00:00.000Z",
    });
    await requestHarnessTurn(harness, {
      commandId: "cmd-turn-request-mode-race",
      interactionMode: "default",
      createdAt: "2026-07-21T00:00:01.000Z",
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.makeUnsafe("cmd-plan-before-provider-start"),
        threadId: asThreadId("thread-1"),
        interactionMode: "plan",
        createdAt: "2026-07-21T00:00:02.000Z",
      }),
    );
    await startHarnessGoalTurn(harness, {
      provider: "gemini",
      turnId,
      startedAt: "2026-07-21T00:00:03.000Z",
    });

    let thread = await waitForThread(
      harness.engine,
      (entry) => entry.session?.goalLifecycleKey === lifecycleId,
    );
    expect(thread.interactionMode).toBe("plan");

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-goal-request-mode-race-usage"),
      provider: "gemini",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-07-21T00:00:04.000Z",
      payload: { usage: { usedTokens: 111, processedTokensDelta: 111 } },
    });
    thread = await waitForThread(harness.engine, (entry) => entry.goal?.tokensUsed === 111);
    expect(thread.goal?.lifecycleId).toBe(lifecycleId);
  });

  it("does not bind a plan request when default mode is restored before turn.started", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-plan-request-mode-race");
    await setHarnessGoal(harness, {
      commandId: "cmd-plan-request-mode-race-goal",
      createdAt: "2026-07-21T01:00:00.000Z",
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.makeUnsafe("cmd-plan-before-request"),
        threadId: asThreadId("thread-1"),
        interactionMode: "plan",
        createdAt: "2026-07-21T01:00:01.000Z",
      }),
    );
    await requestHarnessTurn(harness, {
      commandId: "cmd-plan-turn-request",
      interactionMode: "plan",
      createdAt: "2026-07-21T01:00:02.000Z",
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.makeUnsafe("cmd-default-before-provider-start"),
        threadId: asThreadId("thread-1"),
        interactionMode: "default",
        createdAt: "2026-07-21T01:00:03.000Z",
      }),
    );
    await startHarnessGoalTurn(harness, {
      provider: "cursor",
      turnId,
      startedAt: "2026-07-21T01:00:04.000Z",
    });

    const running = await waitForThread(
      harness.engine,
      (entry) => entry.session?.activeTurnId === turnId,
    );
    expect(running.session?.goalLifecycleKey).toBeNull();
    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-plan-request-mode-race-usage"),
      provider: "cursor",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-07-21T01:00:05.000Z",
      payload: { usage: { usedTokens: 222, processedTokensDelta: 222 } },
    });
    await harness.drain();
    const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
    expect(thread?.goal?.tokensUsed).toBe(0);
  });

  it("does not let an old failed turn block its replacement lifecycle", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-replaced-before-provider-start");
    await setHarnessGoal(harness, {
      commandId: "cmd-old-goal-before-provider-start",
      objective: "Old objective",
      createdAt: "2026-07-21T02:00:00.000Z",
    });
    await requestHarnessTurn(harness, {
      commandId: "cmd-old-goal-turn-request",
      interactionMode: "default",
      createdAt: "2026-07-21T02:00:01.000Z",
    });
    await setHarnessGoal(harness, {
      commandId: "cmd-new-goal-before-provider-start",
      objective: "Replacement objective",
      createdAt: "2026-07-21T02:00:02.000Z",
    });
    await startHarnessGoalTurn(harness, {
      provider: "glm",
      turnId,
      startedAt: "2026-07-21T02:00:03.000Z",
    });
    expect(
      (await Effect.runPromise(harness.engine.getReadModel())).threads[0]?.session
        ?.goalLifecycleKey,
    ).toBe("goal:cmd-old-goal-before-provider-start");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-old-goal-turn-failed"),
      provider: "glm",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-07-21T02:00:04.000Z",
      payload: { state: "failed", errorMessage: "old lifecycle failed" },
    });
    await harness.drain();

    const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
    expect(thread?.goal).toMatchObject({
      lifecycleId: "goal:cmd-new-goal-before-provider-start",
      status: "active",
      objective: "Replacement objective",
    });
    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(
      events.some(
        (event) =>
          event.type === "thread.goal-continuation-requested" &&
          event.payload.expectedGoalLifecycleKey === "goal:cmd-new-goal-before-provider-start",
      ),
    ).toBe(true);
  });

  it.each(["session-state", "runtime-error"] as const)(
    "continues a replacement after an old turn emits %s without a later exit",
    async (kind) => {
      const harness = await createHarness();
      const turnId = asTurnId(`turn-replacement-${kind}`);
      await setHarnessGoal(harness, {
        commandId: `cmd-replacement-${kind}-a`,
        objective: "Lifecycle A",
        createdAt: "2026-07-21T02:10:00.000Z",
      });
      await startHarnessGoalTurn(harness, {
        provider: "codex",
        turnId,
        startedAt: "2026-07-21T02:10:01.000Z",
      });
      await setHarnessGoal(harness, {
        commandId: `cmd-replacement-${kind}-b`,
        objective: "Lifecycle B",
        createdAt: "2026-07-21T02:10:02.000Z",
      });

      if (kind === "session-state") {
        harness.emit({
          type: "session.state.changed",
          eventId: asEventId("evt-replacement-session-state-error"),
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt: "2026-07-21T02:10:03.000Z",
          payload: { state: "error", reason: "old turn failed" },
        });
      } else {
        harness.emit({
          type: "runtime.error",
          eventId: asEventId("evt-replacement-runtime-error"),
          provider: "codex",
          threadId: asThreadId("thread-1"),
          turnId,
          createdAt: "2026-07-21T02:10:03.000Z",
          payload: { message: "old turn failed", class: "provider_error" },
        });
      }
      await harness.drain();

      const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
      expect(thread?.goal).toMatchObject({
        lifecycleId: `goal:cmd-replacement-${kind}-b`,
        status: "active",
      });
      expect(thread?.session?.activeTurnId).toBeNull();
      const events = await Effect.runPromise(
        Stream.runCollect(harness.engine.readEvents(0)).pipe(
          Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
        ),
      );
      expect(
        events.some(
          (event) =>
            event.type === "thread.goal-continuation-requested" &&
            event.payload.expectedGoalLifecycleKey === `goal:cmd-replacement-${kind}-b`,
        ),
      ).toBe(true);
    },
  );

  it("accounts late usage after the bound turn completes and ingestion restarts", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-late-goal-usage");
    await setHarnessGoal(harness, {
      commandId: "cmd-late-goal-usage",
      createdAt: "2026-07-21T03:00:00.000Z",
    });
    await startHarnessGoalTurn(harness, {
      provider: "claudeAgent",
      turnId,
      startedAt: "2026-07-21T03:00:01.000Z",
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-late-goal-usage-completed"),
      provider: "claudeAgent",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-07-21T03:00:10.000Z",
      payload: { state: "completed" },
    });
    await waitForThread(harness.engine, (entry) => entry.session?.activeTurnId === null);
    harness.setProviderSession({
      provider: "claudeAgent",
      status: "ready",
      runtimeMode: "approval-required",
      threadId: asThreadId("thread-1"),
      createdAt: "2026-07-21T03:00:01.000Z",
      updatedAt: "2026-07-21T03:00:10.000Z",
    });
    await harness.restartIngestion();
    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-late-goal-usage-final"),
      provider: "claudeAgent",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-07-21T03:00:11.000Z",
      payload: { usage: { usedTokens: 333, processedTokensDelta: 333 } },
    });
    await harness.drain();
    const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads[0]!;
    expect(thread.goal?.tokensUsed).toBe(333);
    expect(thread.goal?.timeUsedSeconds).toBe(9);
  });

  it("moves an active harness goal to budgetLimited when token usage reaches its budget", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-goal-budget-limit");
    await setHarnessGoal(harness, {
      commandId: "cmd-goal-budget-limit",
      tokenBudget: 1_000,
      tokensUsed: 900,
      createdAt: "2026-07-04T02:00:00.000Z",
    });
    await startHarnessGoalTurn(harness, {
      provider: "claudeAgent",
      turnId,
      startedAt: "2026-07-04T02:00:05.000Z",
    });

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-goal-budget-limit"),
      provider: "claudeAgent",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-07-04T02:00:10.000Z",
      payload: {
        usage: {
          usedTokens: 150,
          processedTokensDelta: 150,
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.goal?.status === "budgetLimited",
    );
    expect(thread.goal).toMatchObject({
      status: "budgetLimited",
      tokenBudget: 1_000,
      tokensUsed: 1_050,
    });
  });

  it("records a provider usage event only once when the same event is delivered twice", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-goal-usage-idempotent");
    await setHarnessGoal(harness, {
      commandId: "cmd-goal-usage-idempotent",
      createdAt: "2026-07-04T03:00:00.000Z",
    });
    await startHarnessGoalTurn(harness, {
      provider: "cursor",
      turnId,
      startedAt: "2026-07-04T03:00:05.000Z",
    });

    const usageEvent = {
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-goal-usage-idempotent"),
      provider: "cursor",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-07-04T03:00:10.000Z",
      payload: {
        usage: {
          usedTokens: 250,
          processedTokensDelta: 250,
        },
      },
    } as const;
    harness.emit(usageEvent);
    harness.emit(usageEvent);
    await harness.drain();

    const thread = await waitForThread(harness.engine, (entry) => entry.goal?.tokensUsed === 250);
    expect(thread.goal?.tokensUsed).toBe(250);
    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(
      events.filter(
        (event) =>
          event.type === "thread.goal-updated" &&
          event.commandId ===
            "server:harness-goal-usage:thread-1:goal:cmd-goal-usage-idempotent:turn-goal-usage-idempotent:tokens:evt-goal-usage-idempotent",
      ),
    ).toHaveLength(1);
  });

  it("counts distinct provider usage events even when their token deltas are equal", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-goal-usage-equal-deltas");
    await setHarnessGoal(harness, {
      commandId: "cmd-goal-usage-equal-deltas",
      createdAt: "2026-07-04T03:10:00.000Z",
    });
    await startHarnessGoalTurn(harness, {
      provider: "gemini",
      turnId,
      startedAt: "2026-07-04T03:10:05.000Z",
    });

    const makeUsageEvent = (eventId: string, createdAt: string) =>
      ({
        type: "thread.token-usage.updated",
        eventId: asEventId(eventId),
        provider: "gemini",
        threadId: asThreadId("thread-1"),
        turnId,
        createdAt,
        payload: {
          usage: {
            usedTokens: 250,
            processedTokensDelta: 250,
          },
        },
      }) as const;

    harness.emit(makeUsageEvent("evt-goal-usage-equal-delta-1", "2026-07-04T03:10:10.000Z"));
    harness.emit(makeUsageEvent("evt-goal-usage-equal-delta-2", "2026-07-04T03:10:11.000Z"));
    await harness.drain();

    const thread = await waitForThread(harness.engine, (entry) => entry.goal?.tokensUsed === 500);
    expect(thread.goal?.tokensUsed).toBe(500);
  });

  it("does not charge delayed usage from an older goal lifecycle to its replacement", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-goal-replaced");
    await setHarnessGoal(harness, {
      commandId: "cmd-goal-before-replacement",
      objective: "Original lifecycle",
      createdAt: "2026-07-04T04:00:00.000Z",
    });
    await startHarnessGoalTurn(harness, {
      provider: "glm",
      turnId,
      startedAt: "2026-07-04T04:00:05.000Z",
    });
    await setHarnessGoal(harness, {
      commandId: "cmd-goal-replacement",
      objective: "Replacement lifecycle",
      createdAt: "2026-07-04T04:00:20.000Z",
    });

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-goal-delayed-before-replacement"),
      provider: "glm",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-07-04T04:00:10.000Z",
      payload: {
        usage: {
          usedTokens: 400,
          processedTokensDelta: 400,
        },
      },
    });
    await harness.drain();

    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.goal?.objective === "Replacement lifecycle",
    );
    expect(thread.goal).toMatchObject({
      lifecycleId: "goal:cmd-goal-replacement",
      objective: "Replacement lifecycle",
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: "2026-07-04T04:00:20.000Z",
    });
  });

  it("replaces the cached turn binding after a successful mid-turn goal rebind", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-goal-mid-turn-rebind");
    await setHarnessGoal(harness, {
      commandId: "cmd-goal-before-mid-turn-rebind",
      objective: "Original lifecycle",
      createdAt: "2026-07-04T04:10:00.000Z",
    });
    await startHarnessGoalTurn(harness, {
      provider: "codex",
      turnId,
      startedAt: "2026-07-04T04:10:05.000Z",
    });
    await setHarnessGoal(harness, {
      commandId: "cmd-goal-after-mid-turn-rebind",
      objective: "Rebound lifecycle",
      createdAt: "2026-07-04T04:10:10.000Z",
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-mid-turn-rebind"),
        threadId: asThreadId("thread-1"),
        session: {
          threadId: asThreadId("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          goalLifecycleKey: "goal:cmd-goal-after-mid-turn-rebind",
          lastError: null,
          updatedAt: "2026-07-04T04:10:11.000Z",
        },
        createdAt: "2026-07-04T04:10:11.000Z",
      }),
    );

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-goal-mid-turn-rebind-usage"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-07-04T04:10:12.000Z",
      payload: { usage: { usedTokens: 125, processedTokensDelta: 125 } },
    });
    await waitForThread(
      harness.engine,
      (entry) =>
        entry.goal?.lifecycleId === "goal:cmd-goal-after-mid-turn-rebind" &&
        entry.goal.tokensUsed === 125,
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-goal-mid-turn-rebind-failed"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-07-04T04:10:15.000Z",
      payload: { state: "failed", errorMessage: "rebound lifecycle failed" },
    });
    const thread = await waitForThread(harness.engine, (entry) => entry.goal?.status === "blocked");
    expect(thread.goal).toMatchObject({
      lifecycleId: "goal:cmd-goal-after-mid-turn-rebind",
      tokensUsed: 125,
      status: "blocked",
    });
  });

  it("accounts for a goal even when the client clock is ahead of provider events", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-goal-future-client-clock");
    await setHarnessGoal(harness, {
      commandId: "cmd-goal-future-client-clock",
      createdAt: "2036-07-04T04:00:20.000Z",
    });
    await startHarnessGoalTurn(harness, {
      provider: "codex",
      turnId,
      startedAt: "2026-07-04T04:00:05.000Z",
    });

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-goal-future-client-clock"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-07-04T04:00:10.000Z",
      payload: { usage: { usedTokens: 250, processedTokensDelta: 250 } },
    });
    await harness.drain();

    const thread = await waitForThread(harness.engine, (entry) => entry.goal?.tokensUsed === 250);
    expect(thread.goal?.tokensUsed).toBe(250);
  });

  it.each([
    {
      interactionMode: "plan" as const,
      status: "active" as const,
      label: "plan mode",
    },
    {
      interactionMode: "default" as const,
      status: "paused" as const,
      label: "paused goal",
    },
    {
      interactionMode: "default" as const,
      status: "complete" as const,
      label: "complete goal",
    },
  ])("does not account provider usage for $label", async ({ interactionMode, status }) => {
    const harness = await createHarness();
    const turnId = asTurnId(`turn-goal-excluded-${interactionMode}-${status}`);
    if (interactionMode === "plan") {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.makeUnsafe("cmd-goal-accounting-plan-mode"),
          threadId: asThreadId("thread-1"),
          interactionMode,
          createdAt: "2026-07-04T05:00:00.000Z",
        }),
      );
    }
    await setHarnessGoal(harness, {
      commandId: `cmd-goal-accounting-excluded-${interactionMode}-${status}`,
      status,
      createdAt: "2026-07-04T05:00:01.000Z",
    });
    await startHarnessGoalTurn(harness, {
      provider: "kimiCode",
      turnId,
      startedAt: "2026-07-04T05:00:05.000Z",
    });

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId(`evt-goal-accounting-excluded-${interactionMode}-${status}`),
      provider: "kimiCode",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-07-04T05:00:10.000Z",
      payload: {
        usage: {
          usedTokens: 500,
          processedTokensDelta: 500,
        },
      },
    });
    await harness.drain();

    const thread = await waitForThread(harness.engine, (entry) => entry.goal?.status === status);
    expect(thread.goal?.tokensUsed).toBe(0);
  });

  it("preserves final turn accounting after update_goal completes the active lifecycle", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-goal-completed-during-turn");
    const commandId = "cmd-goal-completed-during-turn";
    await setHarnessGoal(harness, {
      commandId,
      createdAt: "2026-07-04T06:00:00.000Z",
    });
    await startHarnessGoalTurn(harness, {
      provider: "claudeAgent",
      turnId,
      startedAt: "2026-07-04T06:00:01.000Z",
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.status.report",
        commandId: CommandId.makeUnsafe("cmd-goal-tool-complete"),
        threadId: asThreadId("thread-1"),
        expectedGoalLifecycleKey: `goal:${commandId}`,
        status: "complete",
        turnId,
        createdAt: "2026-07-04T06:00:05.000Z",
      }),
    );

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-goal-final-usage-after-complete"),
      provider: "claudeAgent",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-07-04T06:00:06.000Z",
      payload: {
        usage: { usedTokens: 700, processedTokensDelta: 700 },
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-goal-terminal-after-complete"),
      provider: "claudeAgent",
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-07-04T06:00:11.000Z",
      payload: { state: "completed" },
    });
    await harness.drain();

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.goal?.status === "complete" &&
        entry.goal.tokensUsed === 700 &&
        entry.goal.timeUsedSeconds === 10,
    );
    expect(thread.goal).toMatchObject({
      status: "complete",
      tokensUsed: 700,
      timeUsedSeconds: 10,
    });
  });

  it("projects context window updates into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 1075,
          totalProcessedTokens: 10_200,
          maxTokens: 128_000,
          inputTokens: 1000,
          cachedInputTokens: 500,
          outputTokens: 50,
          reasoningOutputTokens: 25,
          lastUsedTokens: 1075,
          lastInputTokens: 1000,
          lastCachedInputTokens: 500,
          lastOutputTokens: 50,
          lastReasoningOutputTokens: 25,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity).toBeDefined();
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 1075,
      totalProcessedTokens: 10_200,
      maxTokens: 128_000,
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 50,
      reasoningOutputTokens: 25,
      lastUsedTokens: 1075,
      compactsAutomatically: true,
    });
  });

  it("projects Codex camelCase token usage payloads into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-camel"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 126,
          totalProcessedTokens: 11_839,
          maxTokens: 258_400,
          inputTokens: 120,
          cachedInputTokens: 0,
          outputTokens: 6,
          reasoningOutputTokens: 0,
          lastUsedTokens: 126,
          lastInputTokens: 120,
          lastCachedInputTokens: 0,
          lastOutputTokens: 6,
          lastReasoningOutputTokens: 0,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 126,
      totalProcessedTokens: 11_839,
      maxTokens: 258_400,
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 6,
      reasoningOutputTokens: 0,
      lastUsedTokens: 126,
      lastInputTokens: 120,
      lastOutputTokens: 6,
      compactsAutomatically: true,
    });
  });

  it("projects Claude usage snapshots with context window into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    // Switch session to claudeAgent so ingestion accepts claudeAgent events.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-claude-usage"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          updatedAt: now,
          lastError: null,
        },
        createdAt: now,
      }),
    );

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-claude-window"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 31_251,
          lastUsedTokens: 31_251,
          maxTokens: 200_000,
          toolUses: 25,
          durationMs: 43_567,
        },
      },
      raw: {
        source: "claude.sdk.message",
        method: "claude/result/success",
        payload: {},
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 31_251,
      lastUsedTokens: 31_251,
      maxTokens: 200_000,
      toolUses: 25,
      durationMs: 43_567,
    });
  });

  it("projects compacted thread state into context compaction activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-thread-compacted"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "compacted",
        detail: { source: "provider" },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-compaction",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.kind === "context-compaction",
    );
    expect(activity?.summary).toBe("Context compacted");
    expect(activity?.tone).toBe("info");
  });

  it("projects Codex task lifecycle chunks into thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-task-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        taskType: "plan",
      },
    });

    const longCodexProgress =
      "Code reviewer is validating the desktop rollout chunks, checking provider ingestion boundaries, and making sure the entire assistant status update survives projection without being shortened.";

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-task-progress"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        description: "Comparing the desktop rollout chunks to the app-server stream.",
        summary: longCodexProgress,
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-task-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        status: "completed",
        summary: "<proposed_plan>\n# Plan title\n</proposed_plan>",
      },
    });
    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-task-proposed-plan-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        planMarkdown: "# Plan title",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "task.completed",
        ) &&
        entry.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-1:turn:turn-task-1",
        ),
    );

    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-started",
    );
    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-progress",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-completed",
    );

    const progressPayload =
      progress?.payload && typeof progress.payload === "object"
        ? (progress.payload as Record<string, unknown>)
        : undefined;
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(started?.kind).toBe("task.started");
    expect(started?.summary).toBe("Plan task started");
    expect(progress?.kind).toBe("task.progress");
    expect(progressPayload?.detail).toBe(longCodexProgress);
    expect(progressPayload?.summary).toBe(longCodexProgress);
    expect(progressPayload?.detail).not.toContain("...");
    expect(completed?.kind).toBe("task.completed");
    expect(completedPayload?.detail).toBe("<proposed_plan>\n# Plan title\n</proposed_plan>");
    expect(
      thread.proposedPlans.find(
        (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-task-1",
      )?.planMarkdown,
    ).toBe("# Plan title");
  });

  it("keeps Claude task progress as status updates instead of reasoning entries", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    // Switch session to claudeAgent so ingestion accepts claudeAgent events.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-claude-task"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          updatedAt: now,
          lastError: null,
        },
        createdAt: now,
      }),
    );

    const longClaudeStatus =
      "Code reviewer checked the migration edge cases, compared persisted thread activities, and verified that Claude's full assistant status update remains visible instead of being clipped mid-sentence.";

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-claude-task-progress"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-task-1"),
      payload: {
        taskId: "task-subagent-1",
        description: "Running background teammate",
        summary: longClaudeStatus,
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-claude-task-progress",
      ),
    );

    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-claude-task-progress",
    );
    const progressPayload =
      progress?.payload && typeof progress.payload === "object"
        ? (progress.payload as Record<string, unknown>)
        : undefined;

    expect(progress?.kind).toBe("task.progress");
    expect(progress?.summary).toBe("Status update");
    expect(progressPayload?.displayAs).toBe("status");
    expect(progressPayload?.detail).toBe(longClaudeStatus);
    expect(progressPayload?.summary).toBe(longClaudeStatus);
    expect(progressPayload?.detail).not.toContain("...");
  });

  it("projects Claude subagent parent ids onto child task updates", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    // Switch session to claudeAgent so ingestion accepts claudeAgent events.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-claude-subagent"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          updatedAt: now,
          lastError: null,
        },
        createdAt: now,
      }),
    );

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-claude-subagent-child-progress"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-task-2"),
      payload: {
        taskId: "task-subagent-2",
        description: "Finding components",
        summary: "Finding src/components/chat-ui/**/*",
      },
      raw: {
        source: "claude.sdk.message",
        method: "claude/system/task_progress",
        payload: {
          type: "system",
          subtype: "task_progress",
          task_id: "task-subagent-2",
          tool_use_id: "agent-tool-2",
          description: "Finding components",
          summary: "Finding src/components/chat-ui/**/*",
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-claude-subagent-child-progress",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) =>
        candidate.id === "evt-claude-subagent-child-progress",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(payload?.parentItemId).toBe("agent-tool-2");
    expect(payload?.itemType).toBe("collab_agent_tool_call");
    expect(payload?.itemId).toBe("task:task-subagent-2");
    expect(activity?.summary).toBe("Subagent task update");
  });

  it("projects a Claude subagent task lifecycle as one collapsible subagent work entry", async () => {
    const harness = await createHarness();
    const startedAtMs = Date.now();
    const now = new Date(startedAtMs).toISOString();
    const at = (offsetMs: number) => new Date(startedAtMs + offsetMs).toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-claude-subagent-lifecycle"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          updatedAt: now,
          lastError: null,
        },
        createdAt: now,
      }),
    );

    const rawTaskPayload = (subtype: string, extra: Record<string, unknown>) => ({
      source: "claude.sdk.message",
      method: `claude/system/${subtype}`,
      payload: {
        type: "system",
        subtype,
        task_id: "task-subagent-3",
        tool_use_id: "agent-tool-3",
        ...extra,
      },
    });

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-claude-lifecycle-started"),
      provider: "claudeAgent",
      createdAt: at(1),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-task-3"),
      payload: {
        taskId: "task-subagent-3",
        description: "Search repo for SkipLink usages",
      },
      raw: rawTaskPayload("task_started", { description: "Search repo for SkipLink usages" }),
    });

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-claude-lifecycle-progress"),
      provider: "claudeAgent",
      createdAt: at(2),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-task-3"),
      payload: {
        taskId: "task-subagent-3",
        description: "Search repo for SkipLink usages",
        summary: "Grepping src/components",
      },
      raw: rawTaskPayload("task_progress", { summary: "Grepping src/components" }),
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-claude-lifecycle-completed"),
      provider: "claudeAgent",
      createdAt: at(3),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-task-3"),
      payload: {
        taskId: "task-subagent-3",
        status: "completed",
        summary: "Found 3 SkipLink usages",
      },
      raw: rawTaskPayload("task_notification", { status: "completed" }),
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-claude-lifecycle-completed",
      ),
    );

    const lifecycleActivities = thread.activities.filter(
      (activity: ProviderRuntimeTestActivity) =>
        activity.id.startsWith("evt-claude-lifecycle-") &&
        (activity.kind === "task.started" ||
          activity.kind === "task.progress" ||
          activity.kind === "task.completed"),
    );
    expect(lifecycleActivities).toHaveLength(3);
    for (const activity of lifecycleActivities) {
      const payload = activity.payload as Record<string, unknown>;
      expect(payload.itemType).toBe("collab_agent_tool_call");
      expect(payload.itemId).toBe("task:task-subagent-3");
      expect(payload.parentItemId).toBe("agent-tool-3");
      expect(activity.summary.startsWith("Subagent task")).toBe(true);
    }

    const workEntries = deriveWorkLogEntries(
      lifecycleActivities,
      TurnId.makeUnsafe("turn-claude-task-3"),
    );
    expect(workEntries).toHaveLength(1);
    const [collapsed] = workEntries;
    expect(collapsed?.itemType).toBe("collab_agent_tool_call");
    expect(collapsed?.itemId).toBe("task:task-subagent-3");
    expect(collapsed?.parentItemId).toBe("agent-tool-3");
    expect(collapsed?.detail).toBe("Found 3 SkipLink usages");
    expect(collapsed?.running).toBe(false);
  });

  it("projects Codex child parent ids from raw payloads onto tool activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-codex-child-tool-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-codex-child-1"),
      itemId: asItemId("child-tool-1"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
        title: "Read",
        detail: "Read: src/index.ts",
      },
      raw: {
        source: "codex.app-server.notification",
        method: "item/started",
        payload: {
          parentItemId: "agent-tool-codex-1",
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-codex-child-tool-started",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-codex-child-tool-started",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(payload?.parentItemId).toBe("agent-tool-codex-1");
  });

  it("projects Kimi subagent child parent ids from raw payloads onto tool activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-kimi-subagent"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "kimiCode",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          updatedAt: now,
          lastError: null,
        },
        createdAt: now,
      }),
    );
    harness.setProviderSession({
      provider: "kimiCode",
      status: "running",
      runtimeMode: "approval-required",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt: now,
      updatedAt: now,
    });

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-kimi-subagent-child-tool-started"),
      provider: "kimiCode",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-kimi-subagent-1"),
      itemId: asItemId("kimi-child-tool-1"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
        title: "Read file",
        detail: "Read file: src/index.ts",
      },
      raw: {
        source: "kimi.agent.sdk",
        messageType: "SubagentEvent",
        payload: {
          parent_tool_call_id: "kimi-task-tool-1",
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-kimi-subagent-child-tool-started",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) =>
        candidate.id === "evt-kimi-subagent-child-tool-started",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(payload?.parentItemId).toBe("kimi-task-tool-1");
  });

  it("projects reasoning lifecycle and deltas into thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-reasoning-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning"),
      itemId: asItemId("reasoning-item-1"),
      payload: {
        itemType: "reasoning",
        status: "inProgress",
        title: "Reasoning",
      },
    });

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-reasoning-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning"),
      itemId: asItemId("reasoning-item-1"),
      payload: {
        streamKind: "reasoning_text",
        delta: "Tracing the event stream.",
        summaryIndex: 1,
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-reasoning-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning"),
      itemId: asItemId("reasoning-item-1"),
      payload: {
        itemType: "reasoning",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "reasoning.completed",
      ),
    );

    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-reasoning-started",
    );
    const delta = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-reasoning-delta",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-reasoning-completed",
    );

    const deltaPayload =
      delta?.payload && typeof delta.payload === "object"
        ? (delta.payload as Record<string, unknown>)
        : undefined;

    expect(started?.kind).toBe("reasoning.started");
    expect(started?.summary).toBe("Thinking");
    expect(delta?.kind).toBe("reasoning.delta");
    expect(deltaPayload?.delta).toBe("Tracing the event stream.");
    expect(deltaPayload?.summaryIndex).toBe(1);
    expect(completed?.kind).toBe("reasoning.completed");
    expect(completed?.summary).toBe("Thought");
  });

  it("projects reasoning item updates with detail as reasoning deltas", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-reasoning-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-reasoning-update"),
      itemId: asItemId("reasoning-item-2"),
      payload: {
        itemType: "reasoning",
        detail: "Comparing adapters before applying edits.",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-reasoning-updated",
      ),
    );

    const updated = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-reasoning-updated",
    );
    const payload =
      updated?.payload && typeof updated.payload === "object"
        ? (updated.payload as Record<string, unknown>)
        : undefined;

    expect(updated?.kind).toBe("reasoning.delta");
    expect(updated?.summary).toBe("Thinking");
    expect(payload?.delta).toBe("Comparing adapters before applying edits.");
  });

  it("projects structured user input request and resolution as thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-user-input-requested"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    });

    harness.emit({
      type: "user-input.resolved",
      eventId: asEventId("evt-user-input-resolved"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.resolved",
        ),
    );

    const requested = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-requested",
    );
    expect(requested?.kind).toBe("user-input.requested");

    const resolved = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolved?.kind).toBe("user-input.resolved");
    expect(resolvedPayload?.answers).toEqual({
      sandbox_mode: "workspace-write",
    });
  });

  it("continues processing runtime events after a single event handler failure", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-invalid-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-invalid"),
      itemId: asItemId("item-invalid"),
      payload: {
        streamKind: "assistant_text",
        delta: undefined,
      },
    } as unknown as ProviderRuntimeEvent);

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-after-failure"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-after-failure"),
      payload: {
        message: "runtime still processed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-after-failure" &&
        entry.session?.lastError === "runtime still processed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime still processed");
  });
});
