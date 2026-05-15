import {
  AutomationId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ThreadId,
  TurnId,
  type Automation,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "contracts";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { AutomationRepository } from "../Services/AutomationRepository.ts";
import { AutomationService } from "../Services/AutomationService.ts";
import { AutomationServiceLive } from "./AutomationService.ts";

const automationId = AutomationId.makeUnsafe("automation-1");

const automation: Automation = {
  id: automationId,
  kind: "automation",
  title: "Project automation",
  prompt: "Continue any pending work.",
  projectId: null,
  projectlessCwd: "/tmp/project",
  modelSelection: {
    provider: "gemini",
    model: "auto",
  },
  runtimeMode: "approval-required",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  scheduleRrule: "FREQ=HOURLY;INTERVAL=1",
  status: "active",
  nextRunAt: "2026-05-14T09:00:00.000Z",
  lastRunAt: null,
  lastRunThreadId: null,
  lastRunStatus: "idle",
  lastRunError: null,
  createdAt: "2026-05-14T08:00:00.000Z",
  updatedAt: "2026-05-14T08:00:00.000Z",
  deletedAt: null,
};

const readModel: OrchestrationReadModel = {
  snapshotSequence: 1,
  projects: [],
  kanbanItems: [],
  threads: [],
  updatedAt: "2026-05-14T08:00:00.000Z",
};

describe("AutomationService", () => {
  it("automatically queues due automations when the scheduler starts", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const persisted: Automation[] = [];
    let dueQueries = 0;
    let resolvePersisted: (() => void) | undefined;
    const persistedOnce = new Promise<void>((resolve) => {
      resolvePersisted = resolve;
    });

    const layer = AutomationServiceLive.pipe(
      Layer.provide(
        Layer.succeed(AutomationRepository, {
          list: () => Effect.succeed([persisted.at(-1) ?? automation]),
          listDue: () =>
            Effect.sync(() => {
              dueQueries += 1;
              return dueQueries === 1 ? [automation] : [];
            }),
          getById: () => Effect.succeed(Option.some(automation)),
          upsert: (nextAutomation) =>
            Effect.sync(() => {
              persisted.push(nextAutomation);
              resolvePersisted?.();
            }),
          softDelete: () => Effect.void,
        }),
      ),
      Layer.provide(
        Layer.succeed(OrchestrationEngineService, {
          getReadModel: () => Effect.succeed(readModel),
          readEvents: () => Stream.empty,
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length };
            }),
          streamDomainEvents: Stream.empty,
        }),
      ),
    );
    const runtime = ManagedRuntime.make(layer);

    try {
      await Promise.race([
        runtime.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const service = yield* AutomationService;
              yield* service.start;
              yield* Effect.promise(() => persistedOnce);
            }),
          ),
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for scheduler tick.")), 1_000),
        ),
      ]);
    } finally {
      await runtime.dispose();
    }

    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
    ]);
    expect(dispatched[0]).toMatchObject({
      type: "thread.create",
      tag: "automation",
    });
    expect(persisted[0]).toMatchObject({
      id: automationId,
      lastRunStatus: "queued",
      lastRunError: null,
    });
    expect(persisted[0]?.lastRunThreadId).toSatisfy(
      (value) => typeof value === "string" && value.startsWith("automation-thread:"),
    );
  });

  it("creates a new thread and queues the prompt through provider-neutral orchestration commands", async () => {
    const dispatched: OrchestrationCommand[] = [];
    const persisted: Automation[] = [];

    const layer = AutomationServiceLive.pipe(
      Layer.provide(
        Layer.succeed(AutomationRepository, {
          list: () => Effect.succeed([automation]),
          listDue: () => Effect.succeed([]),
          getById: () => Effect.succeed(Option.some(automation)),
          upsert: (nextAutomation) =>
            Effect.sync(() => {
              persisted.push(nextAutomation);
            }),
          softDelete: () => Effect.void,
        }),
      ),
      Layer.provide(
        Layer.succeed(OrchestrationEngineService, {
          getReadModel: () => Effect.succeed(readModel),
          readEvents: () => Stream.empty,
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1 };
            }),
          streamDomainEvents: Stream.empty,
        }),
      ),
    );
    const runtime = ManagedRuntime.make(layer);

    try {
      const service = await runtime.runPromise(Effect.service(AutomationService));
      await runtime.runPromise(service.runNow({ automationId }));
    } finally {
      await runtime.dispose();
    }

    expect(dispatched).toHaveLength(2);
    const createCommand = dispatched[0];
    expect(createCommand).toMatchObject({
      type: "thread.create",
      projectId: null,
      projectlessCwd: "/tmp/project",
      title: "Project automation",
      modelSelection: {
        provider: "gemini",
        model: "auto",
      },
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    });
    if (createCommand?.type !== "thread.create") {
      throw new Error("Expected first automation command to create a thread.");
    }

    const turnCommand = dispatched[1];
    expect(turnCommand).toMatchObject({
      type: "thread.turn.start",
      threadId: createCommand.threadId,
      modelSelection: {
        provider: "gemini",
        model: "auto",
      },
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      titleSeed: "Project automation",
      message: {
        role: "user",
        text: "Continue any pending work.",
        attachments: [],
      },
    });
    expect(persisted[0]).toMatchObject({
      id: automationId,
      lastRunThreadId: createCommand.threadId,
      lastRunStatus: "queued",
      lastRunError: null,
    });
  });

  it("does not queue a new run while the previous automation turn is still active", async () => {
    const activeThreadId = ThreadId.makeUnsafe("automation-thread:automation-1:active");
    const activeTurnId = TurnId.makeUnsafe("turn-active");
    const activeAutomation: Automation = {
      ...automation,
      lastRunAt: "2026-05-14T09:00:00.000Z",
      lastRunThreadId: activeThreadId,
      lastRunStatus: "queued",
    };
    const activeReadModel: OrchestrationReadModel = {
      ...readModel,
      threads: [
        {
          id: activeThreadId,
          projectId: null,
          projectlessCwd: "/tmp/project",
          title: "Project automation",
          modelSelection: automation.modelSelection,
          runtimeMode: automation.runtimeMode,
          interactionMode: automation.interactionMode,
          parentThreadId: null,
          branchSourceTurnId: null,
          branch: null,
          worktreePath: null,
          tag: "automation",
          resumeState: "resumed",
          latestTurn: {
            turnId: activeTurnId,
            state: "running",
            requestedAt: "2026-05-14T09:00:00.000Z",
            startedAt: "2026-05-14T09:00:01.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
          createdAt: "2026-05-14T09:00:00.000Z",
          updatedAt: "2026-05-14T09:00:01.000Z",
          pinnedAt: null,
          archivedAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: {
            threadId: activeThreadId,
            status: "running",
            providerName: "gemini",
            runtimeMode: automation.runtimeMode,
            activeTurnId,
            lastError: null,
            updatedAt: "2026-05-14T09:00:01.000Z",
          },
        },
      ],
    };
    const dispatched: OrchestrationCommand[] = [];
    const persisted: Automation[] = [];

    const layer = AutomationServiceLive.pipe(
      Layer.provide(
        Layer.succeed(AutomationRepository, {
          list: () => Effect.succeed([activeAutomation]),
          listDue: () => Effect.succeed([activeAutomation]),
          getById: () => Effect.succeed(Option.some(activeAutomation)),
          upsert: (nextAutomation) =>
            Effect.sync(() => {
              persisted.push(nextAutomation);
            }),
          softDelete: () => Effect.void,
        }),
      ),
      Layer.provide(
        Layer.succeed(OrchestrationEngineService, {
          getReadModel: () => Effect.succeed(activeReadModel),
          readEvents: () => Stream.empty,
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length };
            }),
          streamDomainEvents: Stream.empty,
        }),
      ),
    );
    const runtime = ManagedRuntime.make(layer);

    try {
      const service = await runtime.runPromise(Effect.service(AutomationService));
      await runtime.runPromise(service.runNow({ automationId }));
    } finally {
      await runtime.dispose();
    }

    expect(dispatched).toEqual([]);
    expect(persisted).toEqual([]);
  });
});
