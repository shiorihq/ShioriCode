import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ModelSelection,
  OrchestrationEvent,
  ProviderRuntimeEvent,
  ProviderSession,
  ServerProvider,
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
  ThreadId,
  TurnId,
} from "contracts";
import { Deferred, Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "contracts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderCommandReactorLive } from "./ProviderCommandReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSettingsService } from "../../serverSettings.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asApprovalRequestId = (value: string): ApprovalRequestId =>
  ApprovalRequestId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };

  return poll();
}

describe("ProviderCommandReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderCommandReactor,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly sessionModelSwitch?: "unsupported" | "in-session" | "restart-session";
    readonly providerStatuses?: ReadonlyArray<ServerProvider>;
    readonly startAfterThreadSeed?: boolean;
    readonly beforeReactorStart?: (engine: OrchestrationEngineShape) => Promise<void>;
    readonly sendTurnIds?: ReadonlyArray<string>;
  }) {
    const harnessOptions = input;
    const now = new Date().toISOString();
    const baseDir =
      harnessOptions?.baseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "shioricode-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const modelSelection = harnessOptions?.threadModelSelection ?? {
      provider: "codex",
      model: "gpt-5-codex",
    };
    const startSession = vi.fn((_: unknown, startInput: unknown) => {
      const sessionIndex = nextSessionIndex++;
      const resumeCursor =
        typeof startInput === "object" && startInput !== null && "resumeCursor" in startInput
          ? startInput.resumeCursor
          : undefined;
      const requestedModel =
        typeof startInput === "object" &&
        startInput !== null &&
        "modelSelection" in startInput &&
        typeof startInput.modelSelection === "object" &&
        startInput.modelSelection !== null &&
        "model" in startInput.modelSelection &&
        typeof startInput.modelSelection.model === "string"
          ? startInput.modelSelection.model
          : undefined;
      const threadId =
        typeof startInput === "object" &&
        startInput !== null &&
        "threadId" in startInput &&
        typeof startInput.threadId === "string"
          ? ThreadId.makeUnsafe(startInput.threadId)
          : ThreadId.makeUnsafe(`thread-${sessionIndex}`);
      const session: ProviderSession = {
        provider: modelSelection.provider,
        status: "ready" as const,
        runtimeMode:
          typeof startInput === "object" &&
          startInput !== null &&
          "runtimeMode" in startInput &&
          (startInput.runtimeMode === "approval-required" ||
            startInput.runtimeMode === "full-access")
            ? startInput.runtimeMode
            : "full-access",
        ...((requestedModel ?? modelSelection.model)
          ? { model: requestedModel ?? modelSelection.model }
          : {}),
        threadId,
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      runtimeSessions.push(session);
      return Effect.succeed(session);
    });
    let nextTurnIndex = 0;
    const sendTurn = vi.fn<ProviderServiceShape["sendTurn"]>((_) => {
      const turnId = harnessOptions?.sendTurnIds?.[nextTurnIndex] ?? "turn-1";
      nextTurnIndex += 1;
      return Effect.succeed({
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId(turnId),
      });
    });
    const steerTurn = vi.fn((_: unknown) => Effect.void);
    const interruptTurn = vi.fn((_: unknown) => Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const stopSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const checkedAt = now;
    const readyProvider = (
      provider: ServerProvider["provider"],
      overrides?: Partial<ServerProvider>,
    ): ServerProvider => ({
      provider,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt,
      models: [],
      ...overrides,
    });
    const providerStatuses = harnessOptions?.providerStatuses ?? [
      readyProvider("codex"),
      readyProvider("claudeAgent"),
    ];
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      steerTurn: steerTurn as ProviderServiceShape["steerTurn"],
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      listSessions: () => Effect.succeed(runtimeSessions),
      reconcileSessions: () => Effect.succeed([]),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: harnessOptions?.sessionModelSwitch ?? "in-session",
          recovery: { supportsResumeCursor: false, supportsAdoptActiveSession: false },
          observability: { emitsStructuredSessionExit: false, emitsRuntimeDiagnostics: false },
        }),
      readUsage: () => unsupported(),
      rollbackConversation: () => unsupported(),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    };
    const providerRegistry = {
      getProviders: Effect.succeed(providerStatuses),
      refresh: vi.fn((_provider?: ServerProvider["provider"]) => Effect.succeed(providerStatuses)),
      streamChanges: Stream.empty,
    } satisfies typeof ProviderRegistry.Service;

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const reactorLayer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(Layer.succeed(ProviderRegistry, providerRegistry)),
      Layer.provideMerge(Layer.succeed(GitCore, { renameBranch } as unknown as GitCoreShape)),
      Layer.provideMerge(
        Layer.mock(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    const layer = Layer.merge(reactorLayer, ProjectionTurnRepositoryLive).pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    const projectionTurnRepository = await runtime.runPromise(
      Effect.service(ProjectionTurnRepository),
    );
    const drain = () => Effect.runPromise(reactor.drain);
    const reconcile = () => {
      if (!scope) {
        throw new Error("Provider command reactor scope is not active.");
      }
      return Effect.runPromise(reactor.reconcile.pipe(Scope.provide(scope)));
    };
    const seedThread = async () => {
      await Effect.runPromise(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-create"),
          projectId: asProjectId("project-1"),
          title: "Provider Project",
          workspaceRoot: "/tmp/provider-project",
          defaultModelSelection: modelSelection,
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-create"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        }),
      );
    };

    if (harnessOptions?.startAfterThreadSeed) {
      await seedThread();
      await harnessOptions.beforeReactorStart?.(engine);
    }
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await Effect.runPromise(reactor.reconcile.pipe(Scope.provide(scope)));
    if (!harnessOptions?.startAfterThreadSeed) {
      await seedThread();
    }

    return {
      engine,
      startSession,
      sendTurn,
      steerTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      refreshProviders: providerRegistry.refresh,
      renameBranch,
      generateBranchName,
      generateThreadTitle,
      projectionTurnRepository,
      stateDir,
      drain,
      reconcile,
    };
  }

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.makeUnsafe("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("does not resurrect a turn that completed before sendTurn returned", async () => {
    const harness = await createHarness();
    const accepted = await Effect.runPromise(Deferred.make<void, never>());
    const turnId = asTurnId("turn-fast-terminal-before-accept");
    harness.sendTurn.mockImplementationOnce(() =>
      Deferred.await(accepted).pipe(
        Effect.as({
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId,
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-fast-terminal-before-accept"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-fast-terminal-before-accept"),
          role: "user",
          text: "Finish immediately",
          attachments: [],
        },
        interactionMode: "default",
        runtimeMode: "approval-required",
        createdAt: "2026-07-17T05:00:00.000Z",
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-fast-terminal-running"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: "2026-07-17T05:00:01.000Z",
        },
        createdAt: "2026-07-17T05:00:01.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-fast-terminal-ready"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: "2026-07-17T05:00:02.000Z",
        },
        createdAt: "2026-07-17T05:00:02.000Z",
      }),
    );

    await Effect.runPromise(Deferred.succeed(accepted, undefined).pipe(Effect.orDie));
    await harness.drain();

    const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
    expect(thread?.session).toMatchObject({
      status: "ready",
      activeTurnId: null,
      updatedAt: "2026-07-17T05:00:02.000Z",
    });
  });

  const goalProviderCases = [
    ["codex", "gpt-5-codex"],
    ["claudeAgent", "claude-opus-5"],
    ["kimiCode", "kimi-k2"],
    ["gemini", "gemini-2.5-pro"],
    ["glm", "glm-4.5"],
    ["cursor", "cursor-default"],
  ] as const satisfies ReadonlyArray<readonly [ModelSelection["provider"], string]>;

  it("publishes the goal binding before the provider can invoke its first tool", async () => {
    const harness = await createHarness();
    const lifecycleId = "goal:cmd-goal-tool-happens-before";
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.gen(function* () {
        const thread = (yield* harness.engine.getReadModel()).threads[0];
        expect(thread?.session).toMatchObject({
          status: "ready",
          activeTurnId: null,
          goalLifecycleKey: lifecycleId,
        });
        return {
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: asTurnId("turn-goal-tool-happens-before"),
        };
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-goal-tool-happens-before"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-goal-tool-happens-before"),
          role: "user",
          text: "Use the goal tool immediately",
          attachments: [],
        },
        goalIntent: {
          objective: "Prove goal-tool authorization ordering",
          status: "active",
          tokenBudget: null,
          expectedGoalLifecycleKey: null,
        },
        interactionMode: "default",
        runtimeMode: "approval-required",
        createdAt: "2026-07-17T05:10:00.000Z",
      }),
    );
    await harness.drain();

    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });

  async function setActiveGoalSnapshot(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      readonly commandId: string;
      readonly lifecycleId: string;
      readonly objective: string;
      readonly createdAt: string;
    },
  ) {
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.snapshot.set",
        commandId: CommandId.makeUnsafe(input.commandId),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goal: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          lifecycleId: input.lifecycleId,
          objective: input.objective,
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
      }),
    );
  }

  it.each(goalProviderCases)(
    "keeps /goal entirely in the Shiori harness for %s",
    async (provider, model) => {
      const harness = await createHarness({
        threadModelSelection: { provider, model },
      });
      let providerTurnIndex = 0;
      harness.sendTurn.mockImplementation(() => {
        providerTurnIndex += 1;
        return Effect.succeed({
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: asTurnId(`turn-harness-${provider}-${providerTurnIndex}`),
        });
      });
      const now = new Date().toISOString();
      const commandId = CommandId.makeUnsafe(`cmd-harness-goal-${provider}`);
      let terminalSequence = 0;
      const finishPhysicalTurn = async (label: string) => {
        await waitFor(async () => {
          const current = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
          return current?.session?.status === "running";
        });
        const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
        if (thread?.session?.status !== "running") {
          throw new Error("Expected a running physical turn before terminal projection.");
        }
        terminalSequence += 1;
        const parsedUpdatedAt = Date.parse(thread.session.updatedAt);
        const completedAt = new Date(
          (Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : Date.now()) + terminalSequence,
        ).toISOString();
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe(
              `cmd-harness-goal-terminal-${provider}-${label}-${terminalSequence}`,
            ),
            threadId: ThreadId.makeUnsafe("thread-1"),
            session: {
              ...thread.session,
              status: "interrupted",
              activeTurnId: null,
              goalLifecycleKey: null,
              updatedAt: completedAt,
            },
            createdAt: completedAt,
          }),
        );
        await harness.drain();
      };

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId,
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId(`user-message-harness-goal-${provider}`),
            role: "user",
            text: "Review <this> & continue",
            attachments: [
              {
                type: "image",
                id: `attachment-${provider}`,
                name: "reference.png",
                mimeType: "image/png",
                sizeBytes: 128,
              },
            ],
          },
          goalIntent: {
            objective: "Ship <all> & stay reliable",
            status: "active",
            tokenBudget: 10_000,
            expectedGoalLifecycleKey: null,
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );

      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      const firstTurn = harness.sendTurn.mock.calls[0]?.[0];
      expect(firstTurn).toMatchObject({
        threadId: ThreadId.makeUnsafe("thread-1"),
        attachments: [{ id: `attachment-${provider}` }],
      });
      expect(firstTurn).not.toHaveProperty("goal");
      expect(firstTurn).not.toHaveProperty("goalIntent");
      expect(firstTurn).toHaveProperty(
        "input",
        expect.stringContaining(
          "<untrusted_objective>\nShip &lt;all&gt; &amp; stay reliable\n</untrusted_objective>",
        ),
      );
      expect(firstTurn).toHaveProperty(
        "input",
        expect.stringContaining("User request:\nReview <this> & continue"),
      );

      const events = await Effect.runPromise(
        Stream.runCollect(harness.engine.readEvents(0)).pipe(
          Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
        ),
      );
      const commandEvents = events.filter((event) => event.commandId === commandId);
      expect(commandEvents.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.goal-updated",
        "thread.turn-start-requested",
      ]);
      expect(commandEvents[2]?.payload).not.toHaveProperty("goalIntent");

      await finishPhysicalTurn("initial");

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-harness-goal-later-${provider}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId(`user-message-harness-goal-later-${provider}`),
            role: "user",
            text: "Continue the work",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(harness.sendTurn.mock.calls[1]?.[0]).toHaveProperty(
        "input",
        expect.stringContaining("User request:\nContinue the work"),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe(`cmd-harness-goal-running-${provider}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          session: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            status: "running",
            providerName: provider,
            runtimeMode: "approval-required",
            activeTurnId: asTurnId(`turn-harness-goal-${provider}`),
            goalLifecycleKey: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.steer",
          commandId: CommandId.makeUnsafe(`cmd-harness-goal-steer-${provider}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId(`user-message-harness-goal-steer-${provider}`),
            role: "user",
            text: "Focus on reliability",
          },
          createdAt: now,
        }),
      );
      await waitFor(() => harness.steerTurn.mock.calls.length === 1);
      expect(harness.steerTurn.mock.calls[0]?.[0]).toHaveProperty(
        "input",
        expect.stringContaining("User request:\nFocus on reliability"),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.goal.set",
          commandId: CommandId.makeUnsafe(`cmd-harness-goal-paused-${provider}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          expectedGoalLifecycleKey: `goal:cmd-harness-goal-${provider}`,
          status: "paused",
          createdAt: now,
        }),
      );
      await finishPhysicalTurn("before-paused");
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-harness-goal-after-pause-${provider}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId(`user-message-harness-goal-after-pause-${provider}`),
            role: "user",
            text: "Paused request",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 3);
      expect(harness.sendTurn.mock.calls[2]?.[0]).toHaveProperty("input", "Paused request");

      await finishPhysicalTurn("paused");

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.goal.set",
          commandId: CommandId.makeUnsafe(`cmd-harness-goal-complete-${provider}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          expectedGoalLifecycleKey: `goal:cmd-harness-goal-${provider}`,
          status: "complete",
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-harness-goal-after-complete-${provider}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId(`user-message-harness-goal-after-complete-${provider}`),
            role: "user",
            text: "Completed request",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 4);
      expect(harness.sendTurn.mock.calls[3]?.[0]).toHaveProperty("input", "Completed request");

      await finishPhysicalTurn("completed");

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.goal.set",
          commandId: CommandId.makeUnsafe(`cmd-harness-goal-reactivated-${provider}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          expectedGoalLifecycleKey: `goal:cmd-harness-goal-${provider}`,
          status: "active",
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.makeUnsafe(`cmd-harness-goal-plan-${provider}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          interactionMode: "plan",
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-harness-goal-plan-turn-${provider}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId(`user-message-harness-goal-plan-${provider}`),
            role: "user",
            text: "Plan request",
            attachments: [],
          },
          interactionMode: "plan",
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 5);
      expect(harness.sendTurn.mock.calls[4]?.[0]).toMatchObject({
        input: "Plan request",
        interactionMode: "plan",
      });
    },
  );

  it.each(goalProviderCases)(
    "runs automatic goal continuations through the ordinary %s turn boundary",
    async (provider, model) => {
      const harness = await createHarness({
        threadModelSelection: { provider, model },
      });
      const now = new Date().toISOString();
      const lifecycleId = `goal:automatic-continuation-${provider}`;

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.goal.snapshot.set",
          commandId: CommandId.makeUnsafe(`cmd-automatic-goal-${provider}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          goal: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            lifecycleId,
            objective: `Finish the ${provider} goal`,
            status: "active",
            tokenBudget: null,
            tokensUsed: 42,
            timeUsedSeconds: 7,
            createdAt: now,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.goal.continue",
          commandId: CommandId.makeUnsafe(`cmd-automatic-goal-continue-${provider}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          expectedGoalLifecycleKey: lifecycleId,
          sourceTurnId: asTurnId(`turn-before-automatic-${provider}`),
          createdAt: new Date(Date.parse(now) + 1_000).toISOString(),
        }),
      );

      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      const providerTurn = harness.sendTurn.mock.calls[0]?.[0];
      expect(providerTurn).not.toHaveProperty("goal");
      expect(providerTurn).not.toHaveProperty("goalIntent");
      expect(providerTurn).toMatchObject({
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId(`goal-continuation:cmd-automatic-goal-continue-${provider}`),
      });
      expect(providerTurn).toHaveProperty(
        "input",
        expect.stringContaining(`Finish the ${provider} goal`),
      );
      expect(providerTurn).toHaveProperty(
        "input",
        expect.stringContaining(`goal_id ${JSON.stringify(lifecycleId)}`),
      );

      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      expect(readModel.threads[0]?.messages).toHaveLength(0);
    },
  );

  it("reconciles an active idle goal when the reactor starts after replay", async () => {
    const harness = await createHarness({
      startAfterThreadSeed: true,
      beforeReactorStart: async (engine) => {
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.goal.snapshot.set",
            commandId: CommandId.makeUnsafe("cmd-startup-active-goal"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            goal: {
              threadId: ThreadId.makeUnsafe("thread-1"),
              lifecycleId: "goal:startup-active",
              objective: "Resume after server startup",
              status: "active",
              tokenBudget: null,
              tokensUsed: 12,
              timeUsedSeconds: 3,
              createdAt: "2026-07-21T07:00:00.000Z",
              updatedAt: "2026-07-21T07:00:00.000Z",
            },
            createdAt: "2026-07-21T07:00:00.000Z",
          }),
        );
      },
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toHaveProperty(
      "input",
      expect.stringContaining("Resume after server startup"),
    );
  });

  it("recovers the exact durable goal continuation after a pre-send crash", async () => {
    const lifecycleId = "goal:startup-pending-continuation";
    const harness = await createHarness({
      startAfterThreadSeed: true,
      beforeReactorStart: async (engine) => {
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.goal.snapshot.set",
            commandId: CommandId.makeUnsafe("cmd-startup-pending-continuation-goal"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            goal: {
              threadId: ThreadId.makeUnsafe("thread-1"),
              lifecycleId,
              objective: "Resume this exact durable continuation",
              status: "active",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: "2026-07-21T07:02:00.000Z",
              updatedAt: "2026-07-21T07:02:00.000Z",
            },
            createdAt: "2026-07-21T07:02:00.000Z",
          }),
        );
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.goal.continue",
            commandId: CommandId.makeUnsafe("cmd-startup-pending-continuation"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            expectedGoalLifecycleKey: lifecycleId,
            sourceTurnId: asTurnId("turn-before-startup-crash"),
            createdAt: "2026-07-21T07:02:01.000Z",
          }),
        );
      },
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toHaveProperty(
      "input",
      expect.stringContaining("Resume this exact durable continuation"),
    );
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("drops a stale pending continuation and resumes its replacement goal in one startup pass", async () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const harness = await createHarness({
      startAfterThreadSeed: true,
      beforeReactorStart: async (engine) => {
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.goal.snapshot.set",
            commandId: CommandId.makeUnsafe("cmd-startup-stale-continuation-goal-a"),
            threadId,
            goal: {
              threadId,
              lifecycleId: "goal:startup-stale-continuation-a",
              objective: "Superseded startup objective",
              status: "active",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: "2026-07-21T07:03:00.000Z",
              updatedAt: "2026-07-21T07:03:00.000Z",
            },
            createdAt: "2026-07-21T07:03:00.000Z",
          }),
        );
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.goal.continue",
            commandId: CommandId.makeUnsafe("cmd-startup-stale-continuation-a"),
            threadId,
            expectedGoalLifecycleKey: "goal:startup-stale-continuation-a",
            sourceTurnId: asTurnId("turn-before-startup-stale-continuation"),
            createdAt: "2026-07-21T07:03:01.000Z",
          }),
        );
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.goal.snapshot.set",
            commandId: CommandId.makeUnsafe("cmd-startup-stale-continuation-goal-b"),
            threadId,
            goal: {
              threadId,
              lifecycleId: "goal:startup-replacement-b",
              objective: "Resume the replacement during this startup",
              status: "active",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: "2026-07-21T07:03:02.000Z",
              updatedAt: "2026-07-21T07:03:02.000Z",
            },
            createdAt: "2026-07-21T07:03:02.000Z",
          }),
        );
      },
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();
    expect(harness.sendTurn.mock.calls[0]?.[0]).toHaveProperty(
      "input",
      expect.stringContaining("Resume the replacement during this startup"),
    );
    expect(
      await Effect.runPromise(
        harness.projectionTurnRepository.listPendingTurnStartsByThreadId({ threadId }),
      ),
    ).toEqual([]);
  });

  it("recovers a durable pending user turn before synthesizing a goal continuation", async () => {
    const harness = await createHarness({
      startAfterThreadSeed: true,
      beforeReactorStart: async (engine) => {
        await Effect.runPromise(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("cmd-startup-pending-goal-turn"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            message: {
              messageId: asMessageId("message-startup-pending-goal-turn"),
              role: "user",
              text: "Recover this exact user request",
              attachments: [],
            },
            goalIntent: {
              objective: "Finish after restart",
              status: "active",
              tokenBudget: null,
              expectedGoalLifecycleKey: null,
            },
            interactionMode: "default",
            runtimeMode: "approval-required",
            createdAt: "2026-07-21T07:05:00.000Z",
          }),
        );
      },
    });

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toHaveProperty(
      "input",
      expect.stringContaining("User request:\nRecover this exact user request"),
    );
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("recovers every durable pre-running turn in FIFO order after restart", async () => {
    const harness = await createHarness({
      startAfterThreadSeed: true,
      sendTurnIds: ["turn-startup-queue-first", "turn-startup-queue-second"],
      beforeReactorStart: async (engine) => {
        for (const [suffix, createdAt] of [
          ["first", "2026-07-21T07:06:00.000Z"],
          ["second", "2026-07-21T07:06:01.000Z"],
        ] as const) {
          await Effect.runPromise(
            engine.dispatch({
              type: "thread.turn.start",
              commandId: CommandId.makeUnsafe(`cmd-startup-queue-${suffix}`),
              threadId: ThreadId.makeUnsafe("thread-1"),
              message: {
                messageId: asMessageId(`message-startup-queue-${suffix}`),
                role: "user",
                text: `Recover ${suffix}`,
                attachments: [],
              },
              interactionMode: "default",
              runtimeMode: "approval-required",
              createdAt,
            }),
          );
        }
      },
    });

    await harness.drain();
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toHaveProperty(
      "messageId",
      asMessageId("message-startup-queue-first"),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-startup-queue-first-ready"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: "2026-07-21T07:06:02.000Z",
        },
        createdAt: "2026-07-21T07:06:02.000Z",
      }),
    );
    await harness.drain();

    expect(harness.sendTurn).toHaveBeenCalledTimes(2);
    expect(harness.sendTurn.mock.calls[1]?.[0]).toHaveProperty(
      "messageId",
      asMessageId("message-startup-queue-second"),
    );
  });

  it.each(["plan", "running", "archived"] as const)(
    "does not reconcile an active %s goal into a duplicate startup turn",
    async (state) => {
      const harness = await createHarness({
        startAfterThreadSeed: true,
        beforeReactorStart: async (engine) => {
          await Effect.runPromise(
            engine.dispatch({
              type: "thread.goal.snapshot.set",
              commandId: CommandId.makeUnsafe(`cmd-startup-${state}-goal`),
              threadId: ThreadId.makeUnsafe("thread-1"),
              goal: {
                threadId: ThreadId.makeUnsafe("thread-1"),
                lifecycleId: `goal:startup-${state}`,
                objective: `Do not duplicate ${state} goal`,
                status: "active",
                tokenBudget: null,
                tokensUsed: 0,
                timeUsedSeconds: 0,
                createdAt: "2026-07-21T07:10:00.000Z",
                updatedAt: "2026-07-21T07:10:00.000Z",
              },
              createdAt: "2026-07-21T07:10:00.000Z",
            }),
          );
          if (state === "plan") {
            await Effect.runPromise(
              engine.dispatch({
                type: "thread.interaction-mode.set",
                commandId: CommandId.makeUnsafe("cmd-startup-plan-mode"),
                threadId: ThreadId.makeUnsafe("thread-1"),
                interactionMode: "plan",
                createdAt: "2026-07-21T07:10:01.000Z",
              }),
            );
          } else if (state === "running") {
            await Effect.runPromise(
              engine.dispatch({
                type: "thread.session.set",
                commandId: CommandId.makeUnsafe("cmd-startup-running-session"),
                threadId: ThreadId.makeUnsafe("thread-1"),
                session: {
                  threadId: ThreadId.makeUnsafe("thread-1"),
                  status: "running",
                  providerName: "codex",
                  runtimeMode: "approval-required",
                  activeTurnId: asTurnId("turn-startup-running"),
                  goalLifecycleKey: "goal:startup-running",
                  lastError: null,
                  updatedAt: "2026-07-21T07:10:01.000Z",
                },
                createdAt: "2026-07-21T07:10:01.000Z",
              }),
            );
          } else {
            await Effect.runPromise(
              engine.dispatch({
                type: "thread.archive",
                commandId: CommandId.makeUnsafe("cmd-startup-archived-thread"),
                threadId: ThreadId.makeUnsafe("thread-1"),
              }),
            );
          }
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 30));
      await harness.drain();
      expect(harness.sendTurn).not.toHaveBeenCalled();
    },
  );

  it("deduplicates distinct continuation facts for the same completed turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const sourceTurnId = asTurnId("turn-duplicate-continuation-source");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.snapshot.set",
        commandId: CommandId.makeUnsafe("cmd-duplicate-continuation-goal"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goal: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          lifecycleId: "goal:cmd-duplicate-continuation-goal",
          objective: "Continue exactly once",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: now,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Promise.all(
      ["a", "b"].map((suffix) =>
        Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.goal.continue",
            commandId: CommandId.makeUnsafe(`cmd-duplicate-continuation-${suffix}`),
            threadId: ThreadId.makeUnsafe("thread-1"),
            expectedGoalLifecycleKey: "goal:cmd-duplicate-continuation-goal",
            sourceTurnId,
            createdAt: now,
          }),
        ),
      ),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(
      await Effect.runPromise(
        harness.projectionTurnRepository.listPendingTurnStartsByThreadId({
          threadId: ThreadId.makeUnsafe("thread-1"),
        }),
      ),
    ).toEqual([]);
  });

  it("deduplicates a delayed continuation fact after the prior turn returns ready", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const lifecycleId = "goal:delayed-duplicate-continuation";
    const sourceTurnId = asTurnId("turn-delayed-duplicate-source");
    const now = "2026-07-17T01:00:00.000Z";
    await setActiveGoalSnapshot(harness, {
      commandId: "cmd-delayed-duplicate-goal",
      lifecycleId,
      objective: "Continue once despite a delayed duplicate fact",
      createdAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.continue",
        commandId: CommandId.makeUnsafe("cmd-delayed-duplicate-first"),
        threadId,
        expectedGoalLifecycleKey: lifecycleId,
        sourceTurnId,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-delayed-duplicate-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-delayed-duplicate-continuation"),
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: "2026-07-17T01:00:01.000Z",
        },
        createdAt: "2026-07-17T01:00:01.000Z",
      }),
    );
    await harness.drain();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-delayed-duplicate-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: "2026-07-17T01:00:02.000Z",
        },
        createdAt: "2026-07-17T01:00:02.000Z",
      }),
    );
    await harness.drain();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.continue",
        commandId: CommandId.makeUnsafe("cmd-delayed-duplicate-second"),
        threadId,
        expectedGoalLifecycleKey: lifecycleId,
        sourceTurnId,
        createdAt: "2026-07-17T01:00:03.000Z",
      }),
    );
    await harness.drain();

    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(
      await Effect.runPromise(
        harness.projectionTurnRepository.listPendingTurnStartsByThreadId({ threadId }),
      ),
    ).toEqual([]);
  });

  it("binds lifecycle A immediately and does not start lifecycle B while A runs", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const lifecycleA = "goal:accepted-continuation-a";
    const accepted = await Effect.runPromise(Deferred.make<void, never>());
    harness.sendTurn.mockImplementationOnce(() =>
      Deferred.await(accepted).pipe(
        Effect.as({
          threadId,
          turnId: asTurnId("turn-accepted-continuation-a"),
        }),
      ),
    );
    await setActiveGoalSnapshot(harness, {
      commandId: "cmd-accepted-continuation-a-goal",
      lifecycleId: lifecycleA,
      objective: "Lifecycle A objective",
      createdAt: "2026-07-17T02:00:00.000Z",
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.continue",
        commandId: CommandId.makeUnsafe("cmd-accepted-continuation-a"),
        threadId,
        expectedGoalLifecycleKey: lifecycleA,
        sourceTurnId: asTurnId("turn-before-accepted-continuation-a"),
        createdAt: "2026-07-17T02:00:01.000Z",
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await Effect.runPromise(Deferred.succeed(accepted, undefined).pipe(Effect.orDie));
    await harness.drain();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.makeUnsafe("cmd-accepted-continuation-b-edit"),
        threadId,
        expectedGoalLifecycleKey: lifecycleA,
        objective: "Lifecycle B objective",
        createdAt: "2026-07-17T02:00:02.000Z",
      }),
    );
    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    expect(readModel.threads[0]?.goal).toMatchObject({
      lifecycleId: "goal:cmd-accepted-continuation-b-edit",
      objective: "Lifecycle B objective",
      status: "active",
    });
    expect(readModel.threads[0]?.session).toMatchObject({
      status: "running",
      activeTurnId: asTurnId("turn-accepted-continuation-a"),
      goalLifecycleKey: "goal:cmd-accepted-continuation-b-edit",
    });
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("retries replacement lifecycle B once after lifecycle A's deferred initial send fails", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const initialSend = await Effect.runPromise(Deferred.make<void, ProviderAdapterRequestError>());
    harness.sendTurn.mockImplementationOnce(() =>
      Deferred.await(initialSend).pipe(
        Effect.as({
          threadId,
          turnId: asTurnId("turn-deferred-initial-a"),
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-deferred-initial-a"),
        threadId,
        message: {
          messageId: asMessageId("message-deferred-initial-a"),
          role: "user",
          text: "Start lifecycle A",
          attachments: [],
        },
        goalIntent: {
          objective: "Lifecycle A objective",
          status: "active",
          tokenBudget: null,
          expectedGoalLifecycleKey: null,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-07-17T03:00:00.000Z",
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.makeUnsafe("cmd-deferred-replacement-b"),
        threadId,
        expectedGoalLifecycleKey: "goal:cmd-deferred-initial-a",
        objective: "Lifecycle B objective",
        createdAt: "2026-07-17T03:00:01.000Z",
      }),
    );
    await Effect.runPromise(
      Deferred.fail(
        initialSend,
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "turn/start",
          detail: "deferred lifecycle A failure",
        }),
      ).pipe(Effect.orDie),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    expect(readModel.threads[0]?.goal).toMatchObject({
      lifecycleId: "goal:cmd-deferred-replacement-b",
      objective: "Lifecycle B objective",
      status: "active",
    });
    expect(harness.sendTurn).toHaveBeenCalledTimes(2);
    expect(harness.sendTurn.mock.calls[1]?.[0]).toHaveProperty(
      "input",
      expect.stringContaining("Lifecycle B objective"),
    );
  });

  it("releases a source-less continuation latch after the provider turn starts", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const lifecycleId = "goal:source-less-continuation";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.snapshot.set",
        commandId: CommandId.makeUnsafe("cmd-source-less-goal"),
        threadId,
        goal: {
          threadId,
          lifecycleId,
          objective: "Resume after leaving plan mode",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: now,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.continue",
        commandId: CommandId.makeUnsafe("cmd-source-less-continue-initial"),
        threadId,
        expectedGoalLifecycleKey: lifecycleId,
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-source-less-session-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-source-less"),
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.drain();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-source-less-session-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.makeUnsafe("cmd-source-less-plan"),
        threadId,
        interactionMode: "plan",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.makeUnsafe("cmd-source-less-default"),
        threadId,
        interactionMode: "default",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
  });

  it("starts an idle user goal and steers a running goal edit", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.makeUnsafe("cmd-user-goal-start"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        expectedGoalLifecycleKey: null,
        objective: "Start without another user message",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toHaveProperty(
      "input",
      expect.stringContaining("Start without another user message"),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-user-goal-running-session"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-user-goal-running"),
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.makeUnsafe("cmd-user-goal-edit"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        expectedGoalLifecycleKey: "goal:cmd-user-goal-start",
        objective: "Use the revised objective",
        createdAt: new Date(Date.parse(now) + 1_000).toISOString(),
      }),
    );

    await waitFor(() => harness.steerTurn.mock.calls.length === 1);
    expect(harness.steerTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-user-goal-running"),
      input: expect.stringContaining("Use the revised objective"),
    });
  });

  it("applies a running non-Codex goal edit on the next ordinary turn", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
    });
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.makeUnsafe("cmd-claude-goal-start"),
        threadId,
        expectedGoalLifecycleKey: null,
        objective: "Use the original objective",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-claude-goal-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-claude-goal-running"),
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await harness.drain();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.makeUnsafe("cmd-claude-goal-edit"),
        threadId,
        expectedGoalLifecycleKey: "goal:cmd-claude-goal-start",
        objective: "Use the revised Claude objective",
        createdAt: new Date(Date.parse(now) + 1_000).toISOString(),
      }),
    );
    await harness.drain();
    expect(harness.steerTurn).not.toHaveBeenCalled();

    const editedReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const editedGoal = editedReadModel.threads[0]?.goal;
    expect(editedGoal?.objective).toBe("Use the revised Claude objective");
    expect(editedGoal?.lifecycleId).toBeDefined();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-claude-goal-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.continue",
        commandId: CommandId.makeUnsafe("cmd-claude-goal-next-turn"),
        threadId,
        expectedGoalLifecycleKey: editedGoal!.lifecycleId ?? editedGoal!.createdAt,
        sourceTurnId: asTurnId("turn-claude-goal-running"),
        createdAt: new Date(Date.parse(now) + 2_000).toISOString(),
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.sendTurn.mock.calls[1]?.[0]).toHaveProperty(
      "input",
      expect.stringContaining("Use the revised Claude objective"),
    );
  });

  it("blocks an atomic goal when its initial provider send fails", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "turn/start",
          detail: "provider rejected the goal turn",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-goal-initial-send-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-goal-initial-send-failure"),
          role: "user",
          text: "Run this as a goal",
          attachments: [],
        },
        goalIntent: {
          objective: "Run this as a goal",
          status: "active",
          tokenBudget: null,
          expectedGoalLifecycleKey: null,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return readModel.threads[0]?.goal?.status === "blocked";
    });
    await harness.drain();
    expect(
      await Effect.runPromise(
        harness.projectionTurnRepository.listPendingTurnStartsByThreadId({
          threadId: ThreadId.makeUnsafe("thread-1"),
        }),
      ),
    ).toEqual([]);
    await harness.reconcile();
    await harness.drain();
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    expect(readModel.threads[0]?.goal?.status).toBe("blocked");
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("reacts to thread.session.ensure by prewarming the provider session without sending a turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.ensure",
        commandId: CommandId.makeUnsafe("cmd-session-ensure-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.makeUnsafe("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.status).toBe("ready");
    expect(thread?.resumeState).toBe("resumed");
  });

  it("projects a factual harness pause before interrupting its running turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    let projectedStatusAtInterrupt: string | null = null;
    harness.interruptTurn.mockImplementation(() =>
      harness.engine.getReadModel().pipe(
        Effect.tap((readModel) =>
          Effect.sync(() => {
            projectedStatusAtInterrupt = readModel.threads[0]?.goal?.status ?? null;
          }),
        ),
        Effect.asVoid,
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.ensure",
        commandId: CommandId.makeUnsafe("cmd-session-ensure-for-goal-pause"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-running-session-for-goal-pause"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("provider-turn-goal-pause"),
          goalLifecycleKey: now,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.snapshot.set",
        commandId: CommandId.makeUnsafe("cmd-active-goal-snapshot"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        goal: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          objective: "Keep working until paused",
          status: "active",
          tokenBudget: null,
          tokensUsed: 10,
          timeUsedSeconds: 3,
          createdAt: now,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.makeUnsafe("cmd-pause-harness-goal"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        expectedGoalLifecycleKey: now,
        status: "paused",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(projectedStatusAtInterrupt).toBe("paused");
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    expect(readModel.threads[0]?.goal?.status).toBe("paused");
  });

  it("prebinds a running Codex goal steer and restores the prior binding on failure", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-codex-goal-rebind");
    const lifecycleA = "goal:codex-rebind-a";
    await setActiveGoalSnapshot(harness, {
      commandId: "cmd-codex-rebind-a",
      lifecycleId: lifecycleA,
      objective: "Lifecycle A",
      createdAt: "2026-07-21T04:00:00.000Z",
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-codex-rebind-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          goalLifecycleKey: lifecycleA,
          lastError: null,
          updatedAt: "2026-07-21T04:00:01.000Z",
        },
        createdAt: "2026-07-21T04:00:01.000Z",
      }),
    );
    harness.steerTurn.mockImplementationOnce(() =>
      Effect.gen(function* () {
        const current = (yield* harness.engine.getReadModel()).threads[0];
        expect(current?.session?.goalLifecycleKey).toBe("goal:cmd-codex-rebind-b");
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.makeUnsafe("cmd-codex-rebind-b"),
        threadId,
        expectedGoalLifecycleKey: lifecycleA,
        objective: "Lifecycle B",
        createdAt: "2026-07-21T04:00:02.000Z",
      }),
    );
    await waitFor(async () => {
      const model = await Effect.runPromise(harness.engine.getReadModel());
      return model.threads[0]?.session?.goalLifecycleKey === "goal:cmd-codex-rebind-b";
    });
    expect(harness.steerTurn).toHaveBeenCalledTimes(1);

    harness.steerTurn.mockImplementationOnce(() =>
      Effect.gen(function* () {
        const current = (yield* harness.engine.getReadModel()).threads[0];
        expect(current?.session?.goalLifecycleKey).toBe("goal:cmd-codex-rebind-c");
        return yield* Effect.die(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "turn/steer",
            detail: "steer failed",
          }),
        );
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.makeUnsafe("cmd-codex-rebind-c"),
        threadId,
        expectedGoalLifecycleKey: "goal:cmd-codex-rebind-b",
        objective: "Lifecycle C",
        createdAt: "2026-07-21T04:00:03.000Z",
      }),
    );
    await harness.drain();
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    expect(readModel.threads[0]?.goal?.lifecycleId).toBe("goal:cmd-codex-rebind-c");
    expect(readModel.threads[0]?.session?.goalLifecycleKey).toBe("goal:cmd-codex-rebind-b");
  });

  it("binds an unbound running turn after an ordinary goal-aware steer", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const lifecycleId = "goal:ordinary-steer-bind";
    await setActiveGoalSnapshot(harness, {
      commandId: "cmd-ordinary-steer-bind-goal",
      lifecycleId,
      objective: "Bind on successful steer",
      createdAt: "2026-07-21T05:00:00.000Z",
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-ordinary-steer-bind-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "gemini",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-ordinary-steer-bind"),
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: "2026-07-21T05:00:01.000Z",
        },
        createdAt: "2026-07-21T05:00:01.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.makeUnsafe("cmd-ordinary-steer-bind"),
        threadId,
        message: {
          messageId: asMessageId("message-ordinary-steer-bind"),
          role: "user",
          text: "Continue with the active goal",
        },
        createdAt: "2026-07-21T05:00:02.000Z",
      }),
    );
    await waitFor(async () => {
      const model = await Effect.runPromise(harness.engine.getReadModel());
      return model.threads[0]?.session?.goalLifecycleKey === lifecycleId;
    });
    expect(harness.steerTurn.mock.calls[0]?.[0]).toHaveProperty(
      "input",
      expect.stringContaining("Bind on successful steer"),
    );
  });

  it("interrupts budget-limited turns only when they own that goal", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const lifecycleId = "goal:budget-owner";
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.snapshot.set",
        commandId: CommandId.makeUnsafe("cmd-budget-owner-goal"),
        threadId,
        goal: {
          threadId,
          lifecycleId,
          objective: "Stop at the budget",
          status: "active",
          tokenBudget: 100,
          tokensUsed: 90,
          timeUsedSeconds: 0,
          createdAt: "2026-07-21T06:00:00.000Z",
          updatedAt: "2026-07-21T06:00:00.000Z",
        },
        createdAt: "2026-07-21T06:00:00.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-budget-unbound-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-budget-unbound"),
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: "2026-07-21T06:00:01.000Z",
        },
        createdAt: "2026-07-21T06:00:01.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.usage.record",
        commandId: CommandId.makeUnsafe("cmd-budget-unbound-usage"),
        threadId,
        expectedGoalLifecycleKey: lifecycleId,
        tokensDelta: 10,
        timeDeltaSeconds: 0,
        createdAt: "2026-07-21T06:00:02.000Z",
      }),
    );
    await harness.drain();
    expect(harness.interruptTurn).not.toHaveBeenCalled();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.makeUnsafe("cmd-budget-owner-reopen"),
        threadId,
        expectedGoalLifecycleKey: lifecycleId,
        status: "active",
        tokenBudget: 200,
        createdAt: "2026-07-21T06:00:03.000Z",
      }),
    );
    const ownerLifecycleId = "goal:cmd-budget-owner-reopen";
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-budget-owner-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-budget-owner"),
          goalLifecycleKey: ownerLifecycleId,
          lastError: null,
          updatedAt: "2026-07-21T06:00:04.000Z",
        },
        createdAt: "2026-07-21T06:00:04.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.usage.record",
        commandId: CommandId.makeUnsafe("cmd-budget-owner-usage"),
        threadId,
        expectedGoalLifecycleKey: ownerLifecycleId,
        tokensDelta: 100,
        timeDeltaSeconds: 0,
        createdAt: "2026-07-21T06:00:05.000Z",
      }),
    );
    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
  });

  it.each(goalProviderCases)(
    "finalizes idle harness-goal Kanban and automation work for %s",
    async (provider, model) => {
      const harness = await createHarness({
        threadModelSelection: { provider, model },
      });
      const now = new Date().toISOString();
      const completedAt = new Date(Date.parse(now) + 1_000).toISOString();
      const itemId = KanbanItemId.makeUnsafe(`kanban-harness-goal-${provider}`);

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.ensure",
          commandId: CommandId.makeUnsafe(`cmd-harness-complete-session-${provider}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          createdAt: now,
        }),
      );
      await waitFor(() => harness.startSession.mock.calls.length === 1);
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe(`cmd-harness-complete-automation-${provider}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          tag: "automation",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "kanbanItem.create",
          commandId: CommandId.makeUnsafe(`cmd-harness-complete-kanban-${provider}`),
          itemId,
          projectId: asProjectId("project-1"),
          pullRequest: null,
          title: "Finish the harness goal",
          description: "",
          status: "in_progress",
          sortKey: "001",
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "kanbanItem.assign",
          commandId: CommandId.makeUnsafe(`cmd-harness-complete-assign-${provider}`),
          itemId,
          assignee: {
            id: KanbanItemAssigneeId.makeUnsafe(`assignee-harness-goal-${provider}`),
            provider,
            model,
            role: "owner",
            status: "assigned",
            threadId: ThreadId.makeUnsafe("thread-1"),
            assignedAt: now,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.goal.set",
          commandId: CommandId.makeUnsafe(`cmd-harness-complete-active-${provider}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          expectedGoalLifecycleKey: null,
          objective: "Finish the provider-neutral lifecycle",
          status: "active",
          tokenBudget: null,
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.goal.set",
          commandId: CommandId.makeUnsafe(`cmd-harness-complete-fact-${provider}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          expectedGoalLifecycleKey: `goal:cmd-harness-complete-active-${provider}`,
          status: "complete",
          createdAt: completedAt,
        }),
      );

      await waitFor(async () => {
        const readModel = await Effect.runPromise(harness.engine.getReadModel());
        return (readModel.kanbanItems ?? []).find((item) => item.id === itemId)?.status === "done";
      });
      await waitFor(() => harness.stopSession.mock.calls.length === 1);
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      expect(readModel.threads[0]?.goal?.status).toBe("complete");
      expect((readModel.kanbanItems ?? []).find((item) => item.id === itemId)?.status).toBe("done");
      expect(harness.stopSession).toHaveBeenCalledWith({
        threadId: ThreadId.makeUnsafe("thread-1"),
      });
    },
  );

  it("does not restart a prewarmed Claude session on the first turn when the model selection is unchanged", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-5",
        options: {
          effort: "medium",
        },
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.ensure",
        commandId: CommandId.makeUnsafe("cmd-session-ensure-claude-prewarm"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls.length).toBe(0);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-after-prewarm"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-after-prewarm"),
          role: "user",
          text: "continue with the same Claude model",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-5",
          options: {
            effort: "medium",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-5",
        options: {
          effort: "medium",
        },
      },
    });
  });

  it("starts a fresh Codex session when switching an existing thread into spark", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-codex-before-spark"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-codex-before-spark"),
          role: "user",
          text: "baseline codex turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-codex-switch-spark"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-codex-switch-spark"),
          role: "user",
          text: "switch this thread into spark",
          attachments: [],
        },
        modelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex-spark",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex-spark",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex-spark",
      },
    });
  });

  it("recreates a missing provider runtime session before sending the next turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.ensure",
        commandId: CommandId.makeUnsafe("cmd-session-ensure-missing-runtime"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls.length).toBe(0);

    await Effect.runPromise(
      harness.stopSession({
        threadId: ThreadId.makeUnsafe("thread-1"),
      } as never),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-after-missing-runtime"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-after-missing-runtime"),
          role: "user",
          text: "continue after restart",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      runtimeMode: "approval-required",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      input: "continue after restart",
    });
  });

  it("does not let background session warmup block turn start for another thread", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const releaseThread1Start = await Effect.runPromise(Deferred.make<void, never>());

    harness.startSession.mockImplementation((_: unknown, input: unknown) => {
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.makeUnsafe(input.threadId)
          : ThreadId.makeUnsafe("thread-fallback");
      const session: ProviderSession = {
        provider: "codex",
        status: "ready",
        runtimeMode: "approval-required",
        model: "gpt-5-codex",
        threadId,
        resumeCursor: { opaque: `resume-${threadId}` },
        createdAt: now,
        updatedAt: now,
      };

      if (threadId === ThreadId.makeUnsafe("thread-1")) {
        return Deferred.await(releaseThread1Start).pipe(Effect.as(session));
      }

      return Effect.succeed(session);
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.ensure",
        commandId: CommandId.makeUnsafe("cmd-session-ensure-slow-thread-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-2"),
        threadId: ThreadId.makeUnsafe("thread-2"),
        projectId: asProjectId("project-1"),
        title: "Thread 2",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-thread-2"),
        threadId: ThreadId.makeUnsafe("thread-2"),
        message: {
          messageId: asMessageId("user-message-thread-2"),
          role: "user",
          text: "hello from thread 2",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(
      () =>
        harness.startSession.mock.calls.some((call) => {
          const input = call[1];
          return (
            typeof input === "object" &&
            input !== null &&
            "threadId" in input &&
            input.threadId === "thread-2"
          );
        }),
      2000,
    );
    await waitFor(
      () =>
        harness.sendTurn.mock.calls.some((call) => {
          const input = call[0];
          return (
            typeof input === "object" &&
            input !== null &&
            "threadId" in input &&
            input.threadId === "thread-2"
          );
        }),
      2000,
    );

    await Effect.runPromise(Deferred.succeed(releaseThread1Start, undefined).pipe(Effect.orDie));
  });

  it("blocks turn start when the selected provider is not ready", async () => {
    const warningCheckedAt = new Date().toISOString();
    const harness = await createHarness({
      threadModelSelection: {
        provider: "kimiCode",
        model: "kimi2.7-code",
      },
      providerStatuses: [
        {
          provider: "kimiCode",
          enabled: true,
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "authenticated" },
          checkedAt: warningCheckedAt,
          message: "Kimi Code is not available.",
          models: [],
        },
        {
          provider: "codex",
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: warningCheckedAt,
          models: [],
        },
        {
          provider: "claudeAgent",
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: warningCheckedAt,
          models: [],
        },
      ],
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-provider-warning"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-warning"),
          role: "user",
          text: "start a kimi turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session).toBeNull();
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      summary: "Provider turn start failed",
      payload: {
        detail: "Kimi Code is not available.",
      },
    });
  });

  it("does not synchronously refresh pending provider checks before starting a turn", async () => {
    const checkedAt = new Date().toISOString();
    const harness = await createHarness({
      providerStatuses: [
        {
          provider: "kimiCode",
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt,
          models: [],
        },
        {
          provider: "codex",
          enabled: true,
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          checkedAt,
          message: "Checking Codex CLI availability...",
          models: [],
        },
        {
          provider: "claudeAgent",
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt,
          models: [],
        },
      ],
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-provider-pending"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-pending"),
          role: "user",
          text: "hello codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.refreshProviders).not.toHaveBeenCalled();
  });

  it("generates a thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const seededTitle = "Please investigate reconnect failures after restar...";
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-seed"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: "Please investigate reconnect failures after restarting the session.",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
    });

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"))?.title ===
        "Generated title"
      );
    });
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.title).toBe("Generated title");
  });

  it("does not overwrite an existing custom thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const seededTitle = "Please investigate reconnect failures after restar...";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-custom"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "Keep this custom title",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title-preserve"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-preserve"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.title).toBe("Keep this custom title");
  });

  it("matches the client-seeded title even when the outgoing prompt is reformatted", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const seededTitle = "Fix reconnect spinner on resume";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({
        title: "Reconnect spinner resume bug",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-formatted-seed"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title-formatted"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-formatted"),
          role: "user",
          text: "[effort:high]\\n\\nFix reconnect spinner on resume",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"))?.title ===
        "Reconnect spinner resume bug"
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.title).toBe("Reconnect spinner resume bug");
  });

  it("generates a worktree branch name for the first turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-branch"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        branch: "shioricode/1234abcd",
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    harness.generateBranchName.mockImplementation((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "modelSelection" in input &&
          typeof input.modelSelection === "object" &&
          input.modelSelection !== null &&
          "model" in input.modelSelection &&
          typeof input.modelSelection.model === "string"
            ? `feature/${input.modelSelection.model}`
            : "feature/generated",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-branch-model"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-branch-model"),
          role: "user",
          text: "Add a safer reconnect backoff.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    expect(harness.generateBranchName.mock.calls[0]?.[0]).toMatchObject({
      message: "Add a safer reconnect backoff.",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
    });
  });

  it("skips first-turn title generation when a title seed is provided", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "kimiCode",
        model: "kimi2.7-code",
      },
    });
    const now = new Date().toISOString();
    const seededTitle = "Summarize the provider setup.";
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Seeded title" }));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-seed-kimi"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title-kimi"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-kimi"),
          role: "user",
          text: "Summarize the provider setup.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.generateBranchName).not.toHaveBeenCalled();
  });

  it("forwards codex model options through session start and turn send", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-fast"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast"),
          role: "user",
          text: "hello fast mode",
          attachments: [],
        },
        modelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "high",
            fastMode: true,
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
    });
  });

  it("forwards claude effort options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-sonnet-5" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-effort"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort"),
          role: "user",
          text: "hello with effort",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-5",
          options: {
            effort: "max",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-5",
        options: {
          effort: "max",
        },
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-5",
        options: {
          effort: "max",
        },
      },
    });
  });

  it("forwards claude fast mode options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-fast-mode"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-fast-mode"),
          role: "user",
          text: "hello with fast mode",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            fastMode: true,
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          fastMode: true,
        },
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          fastMode: true,
        },
      },
    });
  });

  it("forwards plan interaction mode to the provider turn request", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.makeUnsafe("cmd-interaction-mode-set-plan"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-plan"),
          role: "user",
          text: "plan this change",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      interactionMode: "plan",
    });
  });

  it("rejects a first turn when requested provider conflicts with the thread model", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "codex", model: "gpt-5-codex" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-provider-first"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-first"),
          role: "user",
          text: "hello claude",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session).toBeNull();
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      summary: "Provider turn start failed",
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("preserves the active session model when in-session model switching is unsupported", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unsupported-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unsupported-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
    });
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unchanged-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unchanged-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("restarts claude sessions when claude effort changes", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-sonnet-5" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-effort-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-5",
          options: {
            effort: "medium",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-effort-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-5",
          options: {
            effort: "max",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-5",
        options: {
          effort: "max",
        },
      },
    });
  });

  it("restarts the provider session when runtime mode is updated on the thread", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-initial-full-access"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      resumeCursor: { opaque: "resume-1" },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("does not inject derived model options when restarting claude on runtime mode changes", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-runtime-mode-claude"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-claude-no-options"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("rejects provider changes after a thread is already bound to a session provider", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-provider-switch-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-provider-switch-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.sendTurn.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerName).toBe("codex");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail(new Error("simulated restart failure")) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
    });
  });

  it("reacts to thread.turn.steer by forwarding live steering input to the provider", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-steer"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.makeUnsafe("cmd-turn-steer"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-steer"),
          role: "user",
          text: "focus on the typecheck failure first",
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.steerTurn.mock.calls.length === 1);
    expect(harness.steerTurn.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      messageId: asMessageId("user-message-steer"),
      input: "focus on the typecheck failure first",
      turnId: asTurnId("turn-1"),
    });
  });

  it("reacts to thread.approval.respond by forwarding provider approval response", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-approval"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      decision: "accept",
    });
  });

  it("reacts to thread.user-input.respond by forwarding structured user input answers", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-user-input"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("cmd-user-input-respond"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
      answers: {
        sandbox_mode: "workspace-write",
      },
    });
  });

  it("surfaces stale provider approval request failures without faking approval resolution", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "session/request_permission",
          detail: "Unknown pending permission request: approval-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-approval-error"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-approval-requested"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-approval-requested"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "acceptForSession",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.approval.respond.failed",
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.approval.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "approval-request-1",
      detail: expect.stringContaining("Stale pending approval request: approval-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "approval.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("surfaces stale provider user-input failures without faking user-input resolution", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.respondToUserInput.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "claudeAgent",
          method: "item/tool/respondToUserInput",
          detail: "Unknown pending user-input request: user-input-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-user-input-error"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-user-input-requested"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-user-input-requested"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "user-input-request-1",
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
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("cmd-user-input-respond-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.user-input.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "user-input-request-1",
      detail: expect.stringContaining("Stale pending user-input request: user-input-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "user-input.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          goalLifecycleKey: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-session-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.activeTurnId).toBeNull();
  });

  it("does not let a delayed session-stop side effect pause a replacement goal", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const sendGate = await Effect.runPromise(Deferred.make<void, never>());
    harness.sendTurn.mockImplementationOnce(() =>
      Deferred.await(sendGate).pipe(
        Effect.as({
          threadId,
          turnId: asTurnId("turn-delayed-session-stop"),
        }),
      ),
    );
    await setActiveGoalSnapshot(harness, {
      commandId: "cmd-goal-before-delayed-stop",
      lifecycleId: "goal:before-delayed-stop",
      objective: "Original goal",
      createdAt: "2026-07-17T06:00:00.000Z",
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-before-delayed-stop"),
        threadId,
        message: {
          messageId: asMessageId("message-before-delayed-stop"),
          role: "user",
          text: "Hold the provider boundary",
          attachments: [],
        },
        interactionMode: "default",
        runtimeMode: "approval-required",
        createdAt: "2026-07-17T06:00:01.000Z",
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-delayed-session-stop"),
        threadId,
        createdAt: "2026-07-17T06:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.makeUnsafe("cmd-replacement-after-stop-request"),
        threadId,
        expectedGoalLifecycleKey: "goal:before-delayed-stop",
        objective: "Replacement goal must stay active",
        status: "active",
        createdAt: "2026-07-17T06:00:03.000Z",
      }),
    );

    await Effect.runPromise(Deferred.succeed(sendGate, undefined).pipe(Effect.orDie));
    await waitFor(() => harness.stopSession.mock.calls.length === 1);

    const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
    expect(thread?.goal).toMatchObject({
      lifecycleId: "goal:cmd-replacement-after-stop-request",
      objective: "Replacement goal must stay active",
      status: "active",
    });
  });
});
