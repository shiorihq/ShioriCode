import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, it, vi } from "@effect/vitest";

import { Effect, Fiber, Layer, Option, Stream } from "effect";

import {
  CodexAppServerManager,
  type CodexAppServerStartSessionInput,
  type CodexAppServerSendTurnInput,
} from "../../codexAppServerManager.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { CodexUsageSnapshot } from "../Services/ProviderUsage.ts";
import { resolvePreferredCodexBinaryPath, supportsCodexReasoningSummary } from "../codexBinaryPath";
import { makeCodexAdapterLive } from "./CodexAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.makeUnsafe(value);

class FakeCodexManager extends CodexAppServerManager {
  public startSessionImpl = vi.fn(
    async (input: CodexAppServerStartSessionInput): Promise<ProviderSession> => {
      const now = new Date().toISOString();
      return {
        provider: "codex",
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        cwd: input.cwd,
        createdAt: now,
        updatedAt: now,
      };
    },
  );

  public sendTurnImpl = vi.fn(
    async (_input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> => ({
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
    }),
  );

  public interruptTurnImpl = vi.fn(
    async (_threadId: ThreadId, _turnId?: TurnId): Promise<void> => undefined,
  );

  public readThreadImpl = vi.fn(async (_threadId: ThreadId) => ({
    threadId: asThreadId("thread-1"),
    turns: [],
  }));

  public rollbackThreadImpl = vi.fn(async (_threadId: ThreadId, _numTurns: number) => ({
    threadId: asThreadId("thread-1"),
    turns: [],
  }));

  public respondToRequestImpl = vi.fn(
    async (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ): Promise<void> => undefined,
  );

  public respondToUserInputImpl = vi.fn(
    async (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ): Promise<void> => undefined,
  );

  public readUsageImpl = vi.fn(
    async (_threadId: ThreadId): Promise<CodexUsageSnapshot> => ({
      provider: "codex",
      source: "app-server",
      fetchedAt: "2026-04-04T00:00:00.000Z",
      rateLimits: null,
      rateLimitsByLimitId: {},
    }),
  );

  public stopAllImpl = vi.fn(() => undefined);
  public listSessionsImpl = vi.fn((): ProviderSession[] => []);

  override startSession(input: CodexAppServerStartSessionInput): Promise<ProviderSession> {
    return this.startSessionImpl(input);
  }

  override sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    return this.sendTurnImpl(input);
  }

  override interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    return this.interruptTurnImpl(threadId, turnId);
  }

  override readThread(threadId: ThreadId) {
    return this.readThreadImpl(threadId);
  }

  override rollbackThread(threadId: ThreadId, numTurns: number) {
    return this.rollbackThreadImpl(threadId, numTurns);
  }

  override respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    return this.respondToRequestImpl(threadId, requestId, decision);
  }

  override respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    return this.respondToUserInputImpl(threadId, requestId, answers);
  }

  override stopSession(_threadId: ThreadId): void {}

  override listSessions(): ProviderSession[] {
    return this.listSessionsImpl();
  }

  override hasSession(_threadId: ThreadId): boolean {
    return false;
  }

  override readUsage(threadId: ThreadId): Promise<CodexUsageSnapshot> {
    return this.readUsageImpl(threadId);
  }

  override stopAll(): void {
    this.stopAllImpl();
  }
}

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  remove: () => Effect.void,
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

const validationManager = new FakeCodexManager();
const emptyManagedMcpServers = async () => ({
  servers: [],
  warnings: [],
});
const validationLayer = it.layer(
  makeCodexAdapterLive({
    manager: validationManager,
    loadManagedMcpServers: emptyManagedMcpServers,
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

validationLayer("CodexAdapterLive validation", (it) => {
  it.effect("returns validation error for non-codex provider on startSession", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .startSession({
          provider: "claudeAgent",
          threadId: asThreadId("thread-1"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.deepStrictEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: "codex",
          operation: "startSession",
          issue: "Expected provider 'codex' but received 'claudeAgent'.",
        }),
      );
      assert.equal(validationManager.startSessionImpl.mock.calls.length, 0);
    }),
  );
  it.effect("maps codex model options before starting a session", () =>
    Effect.gen(function* () {
      validationManager.startSessionImpl.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: "codex",
        threadId: asThreadId("thread-1"),
        modelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            fastMode: true,
          },
        },
        runtimeMode: "full-access",
      });

      const binaryPath = resolvePreferredCodexBinaryPath("codex");
      assert.deepStrictEqual(validationManager.startSessionImpl.mock.calls[0]?.[0], {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        binaryPath,
        supportsReasoningSummary: supportsCodexReasoningSummary(binaryPath),
        model: "gpt-5.3-codex",
        serviceTier: "fast",
        runtimeMode: "full-access",
      });
    }),
  );
});

const usageManager = new FakeCodexManager();
const probeUsageImpl = vi.fn(
  async (): Promise<CodexUsageSnapshot> => ({
    provider: "codex",
    source: "app-server",
    fetchedAt: "2026-04-04T01:00:00.000Z",
    rateLimits: {
      limitId: "codex",
      limitName: null,
      primary: {
        usedPercent: 12,
        windowDurationMinutes: 300,
        resetsAt: "2026-04-04T05:00:00.000Z",
      },
      secondary: null,
      credits: null,
      planType: "pro",
    },
    rateLimitsByLimitId: {},
  }),
);
const fetchOAuthUsageImpl = vi.fn(async (): Promise<CodexUsageSnapshot | null> => null);
const resetUsageMocks = () => {
  usageManager.listSessionsImpl.mockReset();
  usageManager.listSessionsImpl.mockReturnValue([]);
  usageManager.readUsageImpl.mockReset();
  usageManager.readUsageImpl.mockImplementation(
    async (_threadId: ThreadId): Promise<CodexUsageSnapshot> => ({
      provider: "codex",
      source: "app-server",
      fetchedAt: "2026-04-04T00:00:00.000Z",
      rateLimits: null,
      rateLimitsByLimitId: {},
    }),
  );
  probeUsageImpl.mockReset();
  probeUsageImpl.mockResolvedValue({
    provider: "codex",
    source: "app-server",
    fetchedAt: "2026-04-04T01:00:00.000Z",
    rateLimits: {
      limitId: "codex",
      limitName: null,
      primary: {
        usedPercent: 12,
        windowDurationMinutes: 300,
        resetsAt: "2026-04-04T05:00:00.000Z",
      },
      secondary: null,
      credits: null,
      planType: "pro",
    },
    rateLimitsByLimitId: {},
  });
  fetchOAuthUsageImpl.mockReset();
  fetchOAuthUsageImpl.mockResolvedValue(null);
};
const usageLayer = it.layer(
  makeCodexAdapterLive({
    manager: usageManager,
    probeUsage: probeUsageImpl,
    fetchOAuthUsage: fetchOAuthUsageImpl,
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

usageLayer("CodexAdapterLive usage", (it) => {
  it.effect("reads usage from an active manager session before probing or OAuth fallback", () =>
    Effect.gen(function* () {
      resetUsageMocks();
      usageManager.listSessionsImpl.mockReturnValueOnce([
        {
          provider: "codex",
          status: "ready",
          runtimeMode: "full-access",
          threadId: asThreadId("thread-active"),
          cwd: process.cwd(),
          createdAt: "2026-04-04T00:00:00.000Z",
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      ]);
      usageManager.readUsageImpl.mockResolvedValueOnce({
        provider: "codex",
        source: "app-server",
        fetchedAt: "2026-04-04T02:00:00.000Z",
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: {
            usedPercent: 7,
            windowDurationMinutes: 300,
            resetsAt: "2026-04-04T05:00:00.000Z",
          },
          secondary: null,
          credits: null,
          planType: "pro",
        },
        rateLimitsByLimitId: {},
      });
      fetchOAuthUsageImpl.mockResolvedValueOnce({
        provider: "codex",
        source: "app-server",
        fetchedAt: "2026-04-04T02:00:00.000Z",
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: {
            usedPercent: 18,
            windowDurationMinutes: 300,
            resetsAt: "2026-04-04T05:00:00.000Z",
          },
          secondary: {
            usedPercent: 65,
            windowDurationMinutes: 10080,
            resetsAt: "2026-04-10T05:00:00.000Z",
          },
          credits: null,
          planType: null,
        },
        rateLimitsByLimitId: {},
      });

      const adapter = yield* CodexAdapter;
      const usage = yield* adapter.readUsage();

      assert.equal(usage.rateLimits?.primary?.usedPercent, 7);
      assert.equal(probeUsageImpl.mock.calls.length, 0);
      assert.equal(fetchOAuthUsageImpl.mock.calls.length, 0);
    }),
  );

  it.effect("uses a standalone app-server probe before direct OAuth fallback", () =>
    Effect.gen(function* () {
      resetUsageMocks();
      usageManager.listSessionsImpl.mockReturnValueOnce([
        {
          provider: "codex",
          status: "closed",
          runtimeMode: "full-access",
          threadId: asThreadId("thread-closed"),
          cwd: process.cwd(),
          createdAt: "2026-04-04T00:00:00.000Z",
          updatedAt: "2026-04-04T00:00:00.000Z",
        },
      ]);
      usageManager.readUsageImpl.mockRejectedValueOnce(new Error("session closed"));
      fetchOAuthUsageImpl.mockResolvedValueOnce({
        provider: "codex",
        source: "app-server",
        fetchedAt: "2026-04-04T02:00:00.000Z",
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: {
            usedPercent: 99,
            windowDurationMinutes: 300,
            resetsAt: "2026-04-04T05:00:00.000Z",
          },
          secondary: null,
          credits: null,
          planType: null,
        },
        rateLimitsByLimitId: {},
      });

      const adapter = yield* CodexAdapter;
      const usage = yield* adapter.readUsage();

      assert.equal(usage.rateLimits?.primary?.usedPercent, 12);
      assert.equal(usageManager.readUsageImpl.mock.calls[0]?.[0], asThreadId("thread-closed"));
      assert.equal(probeUsageImpl.mock.calls.length > 0, true);
      assert.equal(fetchOAuthUsageImpl.mock.calls.length, 0);
    }),
  );

  it.effect("falls back to direct OAuth usage when the standalone app-server probe fails", () =>
    Effect.gen(function* () {
      resetUsageMocks();
      usageManager.listSessionsImpl.mockReturnValueOnce([]);
      probeUsageImpl.mockRejectedValueOnce(new Error("app-server unavailable"));
      fetchOAuthUsageImpl.mockResolvedValueOnce({
        provider: "codex",
        source: "app-server",
        fetchedAt: "2026-04-04T02:00:00.000Z",
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: {
            usedPercent: 18,
            windowDurationMinutes: 300,
            resetsAt: "2026-04-04T05:00:00.000Z",
          },
          secondary: null,
          credits: null,
          planType: null,
        },
        rateLimitsByLimitId: {},
      });
      const adapter = yield* CodexAdapter;

      const usage = yield* adapter.readUsage();

      assert.equal(usage.rateLimits?.primary?.usedPercent, 18);
      assert.equal(probeUsageImpl.mock.calls.length > 0, true);
      assert.equal(fetchOAuthUsageImpl.mock.calls.length > 0, true);
    }),
  );

  it.effect("returns an expired-login diagnostic when app-server and OAuth usage fail", () =>
    Effect.gen(function* () {
      resetUsageMocks();
      usageManager.listSessionsImpl.mockReturnValueOnce([]);
      probeUsageImpl.mockRejectedValueOnce(new Error("app-server unavailable"));
      fetchOAuthUsageImpl.mockResolvedValueOnce(null);
      const adapter = yield* CodexAdapter;

      const result = yield* adapter.readUsage().pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.equal(result.failure._tag, "ProviderAdapterRequestError");
      if (result.failure._tag !== "ProviderAdapterRequestError") {
        return;
      }
      assert.match(result.failure.detail, /Codex login may be expired/i);
      assert.match(result.failure.detail, /app-server unavailable/);
    }),
  );
});

const sessionErrorManager = new FakeCodexManager();
sessionErrorManager.sendTurnImpl.mockImplementation(async () => {
  throw new Error("Unknown session: sess-missing");
});
const sessionErrorLayer = it.layer(
  makeCodexAdapterLive({ manager: sessionErrorManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

sessionErrorLayer("CodexAdapterLive session errors", (it) => {
  it.effect("maps unknown-session sendTurn errors to ProviderAdapterSessionNotFoundError", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }

      assert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      if (result.failure._tag !== "ProviderAdapterSessionNotFoundError") {
        return;
      }
      assert.equal(result.failure.provider, "codex");
      assert.equal(result.failure.threadId, "sess-missing");
      assert.equal(result.failure.cause instanceof Error, true);
    }),
  );

  it.effect("maps codex model options before sending a turn", () =>
    Effect.gen(function* () {
      sessionErrorManager.sendTurnImpl.mockClear();
      const adapter = yield* CodexAdapter;

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              reasoningEffort: "high",
              fastMode: true,
            },
          },
          attachments: [],
        }),
      );

      assert.deepStrictEqual(sessionErrorManager.sendTurnImpl.mock.calls[0]?.[0], {
        threadId: asThreadId("sess-missing"),
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "fast",
      });
    }),
  );
});

const lifecycleManager = new FakeCodexManager();
const lifecycleLayer = it.layer(
  makeCodexAdapterLive({ manager: lifecycleManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

lifecycleLayer("CodexAdapterLive lifecycle", (it) => {
  it.effect("maps Codex thread settings updates to thread metadata events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-thread-settings-updated"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "thread/settings/updated",
        threadId: asThreadId("thread-1"),
        payload: {
          threadId: "thread-1",
          threadSettings: {
            model: "gpt-5.3-codex",
            reasoningEffort: "high",
            serviceTier: "fast",
            sandboxPolicy: {
              mode: "workspace-write",
            },
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "thread.metadata.updated");
      if (firstEvent.value.type !== "thread.metadata.updated") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload.metadata, {
        raw: {
          threadId: "thread-1",
          threadSettings: {
            model: "gpt-5.3-codex",
            reasoningEffort: "high",
            serviceTier: "fast",
            sandboxPolicy: {
              mode: "workspace-write",
            },
          },
        },
        threadSettings: {
          model: "gpt-5.3-codex",
          reasoningEffort: "high",
          serviceTier: "fast",
          sandboxPolicy: {
            mode: "workspace-write",
          },
        },
      });
    }),
  );

  it.effect("maps Codex thread status payloads from documented status objects", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.forkChild,
      );

      lifecycleManager.emit("event", {
        id: asEventId("evt-thread-status-active"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "thread/status/changed",
        threadId: asThreadId("thread-1"),
        payload: {
          threadId: "thread-1",
          status: {
            type: "active",
            activeFlags: [],
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-thread-status-not-loaded"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "thread/status/changed",
        threadId: asThreadId("thread-1"),
        payload: {
          threadId: "thread-1",
          status: {
            type: "notLoaded",
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-thread-status-system-error"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "thread/status/changed",
        threadId: asThreadId("thread-1"),
        payload: {
          threadId: "thread-1",
          status: {
            type: "systemError",
          },
        },
      } satisfies ProviderEvent);

      const events = yield* Fiber.join(eventsFiber);

      assert.deepEqual(
        events.map((event) => (event.type === "thread.state.changed" ? event.payload.state : null)),
        ["active", "closed", "error"],
      );
    }),
  );

  it.effect("maps Codex thread started notifications with initial status", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.forkChild,
      );

      lifecycleManager.emit("event", {
        id: asEventId("evt-thread-started"),
        kind: "notification",
        provider: "codex",
        createdAt: "2026-06-04T09:00:00.000Z",
        method: "thread/started",
        threadId: asThreadId("thread-1"),
        payload: {
          thread: {
            id: "provider-thread-1",
            status: {
              type: "idle",
            },
          },
        },
      } satisfies ProviderEvent);

      const events = yield* Fiber.join(eventsFiber);
      const [started, stateChanged] = events;

      assert.equal(started?.type, "thread.started");
      if (started?.type === "thread.started") {
        assert.equal(started.payload.providerThreadId, "provider-thread-1");
      }

      assert.equal(stateChanged?.type, "thread.state.changed");
      if (stateChanged?.type === "thread.state.changed") {
        assert.equal(stateChanged.payload.state, "idle");
        assert.deepEqual(stateChanged.payload.detail, {
          thread: {
            id: "provider-thread-1",
            status: {
              type: "idle",
            },
          },
        });
      }
    }),
  );

  it.effect("preserves Codex turn completion error details", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-turn-completed-failed"),
        kind: "notification",
        provider: "codex",
        createdAt: "2026-06-04T09:00:00.000Z",
        method: "turn/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: {
          turn: {
            id: "turn-1",
            status: "failed",
            error: {
              message: "Responses stream disconnected.",
              codexErrorInfo: {
                type: "ResponseStreamDisconnected",
                httpStatusCode: 502,
              },
              additionalDetails: {
                retryable: true,
              },
            },
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.completed");
      if (firstEvent.value.type !== "turn.completed") {
        return;
      }
      assert.equal(firstEvent.value.payload.state, "failed");
      assert.equal(firstEvent.value.payload.errorMessage, "Responses stream disconnected.");
      assert.deepEqual(firstEvent.value.payload.error, {
        message: "Responses stream disconnected.",
        codexErrorInfo: {
          type: "ResponseStreamDisconnected",
          httpStatusCode: 502,
        },
        additionalDetails: {
          retryable: true,
        },
      });
    }),
  );

  it.effect("maps Codex skills and app list invalidation notifications", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.forkChild,
      );

      lifecycleManager.emit("event", {
        id: asEventId("evt-skills-changed"),
        kind: "notification",
        provider: "codex",
        createdAt: "2026-06-04T09:00:00.000Z",
        method: "skills/changed",
        threadId: asThreadId("thread-1"),
        payload: {},
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-app-list-updated"),
        kind: "notification",
        provider: "codex",
        createdAt: "2026-06-04T09:01:00.000Z",
        method: "app/list/updated",
        threadId: asThreadId("thread-1"),
        payload: {
          data: [
            {
              id: "demo-app",
              name: "Demo App",
              description: "Example connector for documentation.",
            },
          ],
        },
      } satisfies ProviderEvent);

      const events = yield* Fiber.join(eventsFiber);
      const [skillsChanged, appsUpdated] = events;

      assert.equal(skillsChanged?.type, "skills.changed");
      if (skillsChanged?.type === "skills.changed") {
        assert.deepEqual(skillsChanged.payload.detail, {});
      }

      assert.equal(appsUpdated?.type, "apps.list.updated");
      if (appsUpdated?.type === "apps.list.updated") {
        assert.deepEqual(appsUpdated.payload.apps, [
          {
            id: "demo-app",
            name: "Demo App",
            description: "Example connector for documentation.",
          },
        ]);
        assert.deepEqual(appsUpdated.payload.detail, {
          data: [
            {
              id: "demo-app",
              name: "Demo App",
              description: "Example connector for documentation.",
            },
          ],
        });
      }
    }),
  );

  it.effect("maps Codex remote-control and external-agent import notifications", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.forkChild,
      );

      lifecycleManager.emit("event", {
        id: asEventId("evt-remote-control-status"),
        kind: "notification",
        provider: "codex",
        createdAt: "2026-06-04T09:02:00.000Z",
        method: "remoteControl/status/changed",
        threadId: asThreadId("thread-1"),
        payload: {
          status: "connected",
          serverName: "Choki MacBook",
          environmentId: "env_123",
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-external-agent-import-completed"),
        kind: "notification",
        provider: "codex",
        createdAt: "2026-06-04T09:03:00.000Z",
        method: "externalAgentConfig/import/completed",
        threadId: asThreadId("thread-1"),
        payload: {
          imported: [
            {
              cwd: "/Users/me/project",
              kind: "plugin",
              count: 2,
            },
          ],
        },
      } satisfies ProviderEvent);

      const events = yield* Fiber.join(eventsFiber);
      const [remoteStatus, importCompleted] = events;

      assert.equal(remoteStatus?.type, "remote-control.status.changed");
      if (remoteStatus?.type === "remote-control.status.changed") {
        assert.deepEqual(remoteStatus.payload, {
          status: "connected",
          serverName: "Choki MacBook",
          environmentId: "env_123",
          detail: {
            status: "connected",
            serverName: "Choki MacBook",
            environmentId: "env_123",
          },
        });
      }

      assert.equal(importCompleted?.type, "external-agent-config.import.completed");
      if (importCompleted?.type === "external-agent-config.import.completed") {
        assert.deepEqual(importCompleted.payload.detail, {
          imported: [
            {
              cwd: "/Users/me/project",
              kind: "plugin",
              count: 2,
            },
          ],
        });
      }
    }),
  );

  it.effect("preserves Codex raw response item notifications", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.forkChild,
      );

      lifecycleManager.emit("event", {
        id: asEventId("evt-raw-response-item-added"),
        kind: "notification",
        provider: "codex",
        createdAt: "2026-06-04T09:04:00.000Z",
        method: "rawResponseItem/added",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("raw_item_1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "raw_item_1",
            type: "reasoning",
            summary: [],
          },
        },
      } satisfies ProviderEvent);

      const [firstEvent] = yield* Fiber.join(eventsFiber);

      assert.equal(firstEvent?.type, "raw-response.item");
      if (firstEvent?.type !== "raw-response.item") {
        return;
      }
      assert.equal(firstEvent.payload.method, "rawResponseItem/added");
      assert.deepEqual(firstEvent.payload.item, {
        id: "raw_item_1",
        type: "reasoning",
        summary: [],
      });
      assert.deepEqual(firstEvent.payload.detail, {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "raw_item_1",
          type: "reasoning",
          summary: [],
        },
      });
    }),
  );

  it.effect("maps Codex thread goal notifications to runtime goal events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.forkChild,
      );

      lifecycleManager.emit("event", {
        id: asEventId("evt-thread-goal-updated"),
        kind: "notification",
        provider: "codex",
        createdAt: "2026-06-04T09:00:00.000Z",
        method: "thread/goal/updated",
        threadId: asThreadId("thread-1"),
        payload: {
          threadId: "thread-1",
          goal: {
            threadId: "thread-1",
            objective: "Improve Codex compatibility",
            status: "active",
            tokenBudget: 200000,
            tokensUsed: 12000,
            timeUsedSeconds: 90,
            createdAt: 1776272400,
            updatedAt: 1776272460,
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-thread-goal-cleared"),
        kind: "notification",
        provider: "codex",
        createdAt: "2026-06-04T09:02:00.000Z",
        method: "thread/goal/cleared",
        threadId: asThreadId("thread-1"),
        payload: {
          threadId: "thread-1",
        },
      } satisfies ProviderEvent);

      const events = yield* Fiber.join(eventsFiber);

      assert.equal(events.length, 2);
      const [updated, cleared] = events;

      assert.equal(updated?.type, "thread.goal.updated");
      if (updated?.type === "thread.goal.updated") {
        assert.deepEqual(updated.payload.goal, {
          threadId: "thread-1",
          objective: "Improve Codex compatibility",
          status: "active",
          tokenBudget: 200000,
          tokensUsed: 12000,
          timeUsedSeconds: 90,
          createdAt: "2026-04-15T17:00:00.000Z",
          updatedAt: "2026-04-15T17:01:00.000Z",
        });
      }

      assert.equal(cleared?.type, "thread.goal.cleared");
      if (cleared?.type === "thread.goal.cleared") {
        assert.deepEqual(cleared.payload, {
          clearedAt: "2026-06-04T09:02:00.000Z",
        });
      }
    }),
  );

  it.effect("maps completed agent message items to canonical item.completed events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-msg-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: {
          item: {
            type: "agentMessage",
            id: "msg_1",
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.itemId, "msg_1");
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.deepEqual(firstEvent.value.providerRefs, {
        providerTurnId: "turn-1",
        providerItemId: "msg_1",
      });
      assert.equal(firstEvent.value.payload.itemType, "assistant_message");
    }),
  );

  it.effect("maps Codex review-mode items with documented camelCase item types", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.forkChild,
      );

      lifecycleManager.emit("event", {
        id: asEventId("evt-review-entered"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-review"),
        itemId: asItemId("review_1"),
        payload: {
          item: {
            type: "enteredReviewMode",
            id: "review_1",
            review: "current changes",
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-review-exited"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-review"),
        itemId: asItemId("review_1"),
        payload: {
          item: {
            type: "exitedReviewMode",
            id: "review_1",
            review: "Looks solid overall.",
          },
        },
      } satisfies ProviderEvent);

      const events = yield* Fiber.join(eventsFiber);

      assert.equal(events.length, 2);
      const [entered, exited] = events;
      assert.equal(entered?.type, "item.started");
      if (entered?.type === "item.started") {
        assert.equal(entered.payload.itemType, "review_entered");
        assert.equal(entered.payload.title, "Review started");
        assert.equal(entered.payload.detail, "current changes");
      }

      assert.equal(exited?.type, "item.completed");
      if (exited?.type === "item.completed") {
        assert.equal(exited.payload.itemType, "review_exited");
        assert.equal(exited.payload.title, "Review completed");
        assert.equal(exited.payload.detail, "Looks solid overall.");
      }
    }),
  );

  it.effect("maps Codex auto-approval review notifications to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.forkChild,
      );

      lifecycleManager.emit("event", {
        id: asEventId("evt-auto-approval-started"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/autoApprovalReview/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-review"),
        payload: {
          targetItemId: "cmd_1",
          reviewId: "review_1",
          review: {
            status: "inProgress",
            riskLevel: "low",
            userAuthorization: "unknown",
            rationale: "Checking sandbox escalation.",
          },
          action: {
            type: "command",
            source: "shell",
            command: "bun run typecheck",
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-auto-approval-completed"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/autoApprovalReview/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-review"),
        payload: {
          targetItemId: "cmd_1",
          review_id: "review_1",
          review: {
            status: "approved",
            riskLevel: "medium",
            userAuthorization: "high",
            rationale: "Command is bounded to project validation.",
          },
          action: {
            type: "command",
            source: "shell",
            command: "bun run typecheck",
          },
        },
      } satisfies ProviderEvent);

      const events = yield* Fiber.join(eventsFiber);

      assert.equal(events.length, 2);
      const [started, completed] = events;
      assert.equal(started?.type, "approval.review.started");
      if (started?.type === "approval.review.started") {
        assert.equal(started.itemId, "cmd_1");
        assert.equal(started.payload.targetItemId, "cmd_1");
        assert.equal(started.payload.reviewId, "review_1");
        assert.equal(started.payload.status, "inProgress");
        assert.equal(started.payload.riskLevel, "low");
        assert.equal(started.payload.userAuthorization, "unknown");
        assert.equal(started.payload.rationale, "Checking sandbox escalation.");
        assert.deepStrictEqual(started.payload.action, {
          type: "command",
          source: "shell",
          command: "bun run typecheck",
        });
      }

      assert.equal(completed?.type, "approval.review.completed");
      if (completed?.type === "approval.review.completed") {
        assert.equal(completed.itemId, "cmd_1");
        assert.equal(completed.payload.targetItemId, "cmd_1");
        assert.equal(completed.payload.reviewId, "review_1");
        assert.equal(completed.payload.status, "approved");
        assert.equal(completed.payload.riskLevel, "medium");
        assert.equal(completed.payload.userAuthorization, "high");
        assert.equal(completed.payload.rationale, "Command is bounded to project validation.");
      }
    }),
  );

  it.effect("maps Codex tool items into structured runtime tool metadata", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-tool-started"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("tool_1"),
        payload: {
          item: {
            type: "dynamicToolCall",
            id: "tool_1",
            name: "Read",
            input: {
              file_path: "/tmp/app.ts",
            },
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }

      assert.equal(firstEvent.value.type, "item.started");
      if (firstEvent.value.type !== "item.started") {
        return;
      }

      assert.equal(firstEvent.value.payload.itemType, "dynamic_tool_call");
      assert.equal(firstEvent.value.payload.title, "Read");
      assert.equal(firstEvent.value.payload.detail, "Read: /tmp/app.ts");
      assert.deepEqual(firstEvent.value.payload.data, {
        toolName: "Read",
        input: {
          file_path: "/tmp/app.ts",
        },
        item: {
          type: "dynamicToolCall",
          id: "tool_1",
          name: "Read",
          input: {
            file_path: "/tmp/app.ts",
          },
        },
      });
    }),
  );

  it.effect("maps Codex webSearch items into structured runtime tool metadata", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-web-search-started"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("ws_1"),
        payload: {
          item: {
            type: "webSearch",
            id: "ws_1",
            query: "Codex app server web search",
            action: {
              type: "search",
              value: "Codex app server web search",
            },
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }

      assert.equal(firstEvent.value.type, "item.started");
      if (firstEvent.value.type !== "item.started") {
        return;
      }

      assert.equal(firstEvent.value.payload.itemType, "web_search");
      assert.equal(firstEvent.value.payload.title, "Web Search");
      assert.equal(firstEvent.value.payload.detail, "Web Search: Codex app server web search");
      assert.deepEqual(firstEvent.value.payload.data, {
        toolName: "webSearch",
        input: {
          query: "Codex app server web search",
          action: {
            type: "search",
            value: "Codex app server web search",
          },
          action_type: "search",
          action_value: "Codex app server web search",
        },
        item: {
          type: "webSearch",
          id: "ws_1",
          query: "Codex app server web search",
          action: {
            type: "search",
            value: "Codex app server web search",
          },
        },
      });
    }),
  );

  it.effect("maps Codex file change patch snapshots to item updates", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-file-change-patch-updated"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/fileChange/patchUpdated",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("patch_1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "patch_1",
          changes: [
            {
              path: "apps/server/src/provider/Layers/CodexAdapter.ts",
              kind: "update",
              diff: "@@ -1 +1 @@\n-old\n+new\n",
            },
            {
              path: "packages/contracts/src/providerRuntime.ts",
              kind: "update",
              diff: "@@ -1 +1 @@\n-old\n+new\n",
            },
          ],
          status: "inProgress",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }

      assert.equal(firstEvent.value.type, "item.updated");
      if (firstEvent.value.type !== "item.updated") {
        return;
      }

      assert.equal(firstEvent.value.itemId, "patch_1");
      assert.equal(firstEvent.value.payload.itemType, "file_change");
      assert.equal(firstEvent.value.payload.status, "inProgress");
      assert.equal(firstEvent.value.payload.title, "File change");
      assert.equal(firstEvent.value.payload.detail, "2 file changes");
      assert.deepEqual(firstEvent.value.payload.data, {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "patch_1",
        changes: [
          {
            path: "apps/server/src/provider/Layers/CodexAdapter.ts",
            kind: "update",
            diff: "@@ -1 +1 @@\n-old\n+new\n",
          },
          {
            path: "packages/contracts/src/providerRuntime.ts",
            kind: "update",
            diff: "@@ -1 +1 @@\n-old\n+new\n",
          },
        ],
        status: "inProgress",
      });
    }),
  );

  it.effect("preserves Codex command execution results in normalized tool data", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-command-result"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("cmd_1"),
        payload: {
          item: {
            type: "commandExecution",
            id: "cmd_1",
            command: "/bin/zsh -lc 'bun typecheck'",
            cwd: "/Users/choki/Developer/shiori-code",
            status: "completed",
            result: {
              stdout: "Typecheck passed\n",
              stderr: "Warning: generated files skipped\n",
            },
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }

      assert.equal(firstEvent.value.payload.itemType, "command_execution");
      assert.deepEqual(firstEvent.value.payload.data, {
        toolName: "exec_command",
        input: { command: "/bin/zsh -lc 'bun typecheck'" },
        result: {
          stdout: "Typecheck passed\n",
          stderr: "Warning: generated files skipped\n",
        },
        item: {
          type: "commandExecution",
          id: "cmd_1",
          command: "/bin/zsh -lc 'bun typecheck'",
          cwd: "/Users/choki/Developer/shiori-code",
          status: "completed",
          result: {
            stdout: "Typecheck passed\n",
            stderr: "Warning: generated files skipped\n",
          },
        },
      });
    }),
  );

  it.effect("maps Codex terminal interactions to command execution updates", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const payload = {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd_1",
        processId: "proc_1",
        stdin: "q\n",
      };

      lifecycleManager.emit("event", {
        id: asEventId("evt-command-terminal-interaction"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/commandExecution/terminalInteraction",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        payload,
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.updated");
      if (firstEvent.value.type !== "item.updated") {
        return;
      }
      assert.equal(firstEvent.value.itemId, "cmd_1");
      assert.deepEqual(firstEvent.value.providerRefs, {
        providerTurnId: "turn-1",
        providerItemId: "cmd_1",
      });
      assert.deepEqual(firstEvent.value.payload, {
        itemType: "command_execution",
        status: "inProgress",
        title: "Ran command",
        detail: "Sent terminal input to process proc_1",
        data: payload,
      });
    }),
  );

  it.effect("classifies Codex write tool items as file changes", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-tool-write-started"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("tool_write_1"),
        payload: {
          item: {
            type: "dynamicToolCall",
            id: "tool_write_1",
            name: "Write",
            input: {
              file_path: "/tmp/app.ts",
              content: "console.log('hello');",
            },
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }

      assert.equal(firstEvent.value.type, "item.started");
      if (firstEvent.value.type !== "item.started") {
        return;
      }

      assert.equal(firstEvent.value.payload.itemType, "file_change");
      assert.equal(firstEvent.value.payload.title, "Write file");
      assert.equal(firstEvent.value.payload.detail, "Write file: /tmp/app.ts");
    }),
  );

  it.effect("preserves Codex collab tool variants like wait and closeAgent", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-collab-wait"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("call_wait_1"),
        payload: {
          item: {
            type: "collabAgentToolCall",
            id: "call_wait_1",
            tool: "wait",
            receiverThreadIds: ["agent-1"],
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }

      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }

      assert.equal(firstEvent.value.payload.itemType, "collab_agent_tool_call");
      assert.equal(firstEvent.value.payload.title, "Wait for subagent");
      assert.equal(firstEvent.value.payload.detail, "Wait for subagent: agent-1");
      assert.deepEqual(firstEvent.value.payload.data, {
        toolName: "wait",
        input: {
          targets: ["agent-1"],
          receiverThreadIds: ["agent-1"],
        },
        item: {
          type: "collabAgentToolCall",
          id: "call_wait_1",
          tool: "wait",
          receiverThreadIds: ["agent-1"],
        },
      });
    }),
  );

  it.effect("maps completed plan items to canonical proposed-plan completion events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-plan-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: {
          item: {
            type: "Plan",
            id: "plan_1",
            text: "## Final plan\n\n- one\n- two",
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.completed");
      if (firstEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.itemId, "plan_1");
      assert.deepEqual(firstEvent.value.providerRefs, {
        providerTurnId: "turn-1",
        providerItemId: "plan_1",
      });
      assert.equal(firstEvent.value.payload.planMarkdown, "## Final plan\n\n- one\n- two");
    }),
  );

  it.effect("maps plan deltas to canonical proposed-plan delta events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-plan-delta"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/plan/delta",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "plan_1",
          delta: "## Final plan",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.delta");
      if (firstEvent.value.type !== "turn.proposed.delta") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.itemId, "plan_1");
      assert.deepEqual(firstEvent.value.providerRefs, {
        providerTurnId: "turn-1",
        providerItemId: "plan_1",
      });
      assert.equal(firstEvent.value.payload.delta, "## Final plan");
    }),
  );

  it.effect("maps Codex update_plan notifications to canonical task-list updates", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-update-plan"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "turn/plan/updated",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          explanation: "Tracking the remaining work.",
          plan: [
            { step: "Inspect current projection", status: "completed" },
            { step: "Map Codex todos into tasks", status: "inProgress" },
            { step: "Run verification", status: "pending" },
          ],
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.tasks.updated");
      if (firstEvent.value.type !== "turn.tasks.updated") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.source, "update_plan");
      assert.deepEqual(firstEvent.value.payload.items, [
        {
          id: "turn-1:update-plan:0",
          title: "Inspect current projection",
          status: "completed",
          source: "update_plan",
        },
        {
          id: "turn-1:update-plan:1",
          title: "Map Codex todos into tasks",
          status: "inProgress",
          source: "update_plan",
        },
        {
          id: "turn-1:update-plan:2",
          title: "Run verification",
          status: "pending",
          source: "update_plan",
        },
      ]);
    }),
  );

  it.effect("maps session/closed lifecycle events to canonical session.exited runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-session-closed"),
        kind: "session",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "session/closed",
        message: "Session stopped",
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "session.exited");
      if (firstEvent.value.type !== "session.exited") {
        return;
      }
      assert.equal(firstEvent.value.threadId, "thread-1");
      assert.equal(firstEvent.value.payload.reason, "Session stopped");
    }),
  );

  it.effect("maps retryable Codex error notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-retryable-error"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "error",
        turnId: asTurnId("turn-1"),
        payload: {
          error: {
            message: "Reconnecting... 2/5",
          },
          willRetry: true,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.message, "Reconnecting... 2/5");
    }),
  );

  it.effect("maps process stderr notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-process-stderr"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message: "The filename or extension is too long. (os error 206)",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(
        firstEvent.value.payload.message,
        "The filename or extension is too long. (os error 206)",
      );
    }),
  );

  it.effect("maps Codex MCP tool progress messages to canonical progress summaries", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-mcp-progress"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "item/mcpToolCall/progress",
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "mcp-call-1",
          message: "Reading project metadata",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "tool.progress");
      if (firstEvent.value.type !== "tool.progress") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.itemId, "mcp-call-1");
      assert.deepEqual(firstEvent.value.providerRefs, {
        providerTurnId: "turn-1",
        providerItemId: "mcp-call-1",
      });
      assert.equal(firstEvent.value.payload.summary, "Reading project metadata");
    }),
  );

  it.effect("maps Codex warning notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-warning"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "warning",
        payload: {
          threadId: "thread-1",
          message: "MCP server skipped optional capability.",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.ok(Option.isSome(firstEvent));
      if (Option.isNone(firstEvent)) {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.payload.message, "MCP server skipped optional capability.");
      assert.deepEqual(firstEvent.value.payload.detail, {
        threadId: "thread-1",
        message: "MCP server skipped optional capability.",
      });
    }),
  );

  it.effect("maps Codex guardian warning notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-guardian-warning"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "guardianWarning",
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "thread-1",
          message: "Guardian blocked auto-approval for this command.",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.ok(Option.isSome(firstEvent));
      if (Option.isNone(firstEvent)) {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(
        firstEvent.value.payload.message,
        "Guardian blocked auto-approval for this command.",
      );
      assert.deepEqual(firstEvent.value.payload.detail, {
        threadId: "thread-1",
        message: "Guardian blocked auto-approval for this command.",
      });
    }),
  );

  it.effect("maps successful Codex login completion notifications to auth.status", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-account-login-success"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "account/login/completed",
        payload: {
          loginId: "login-1",
          success: true,
          error: null,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.ok(Option.isSome(firstEvent));
      if (Option.isNone(firstEvent)) {
        return;
      }
      assert.equal(firstEvent.value.type, "auth.status");
      if (firstEvent.value.type !== "auth.status") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload, {
        isAuthenticating: false,
        output: ["Codex login completed."],
      });
    }),
  );

  it.effect("maps failed Codex login completion notifications to auth.status errors", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-account-login-failure"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "account/login/completed",
        payload: {
          loginId: "login-1",
          success: false,
          error: "OAuth callback timed out",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.ok(Option.isSome(firstEvent));
      if (Option.isNone(firstEvent)) {
        return;
      }
      assert.equal(firstEvent.value.type, "auth.status");
      if (firstEvent.value.type !== "auth.status") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload, {
        isAuthenticating: false,
        output: ["Codex login failed."],
        error: "OAuth callback timed out",
      });
    }),
  );

  it.effect("maps Codex MCP startup status notifications to runtime MCP status events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-mcp-status"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "mcpServer/startupStatus/updated",
        payload: {
          name: "playwright",
          status: "failed",
          error: "missing browser executable",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.ok(Option.isSome(firstEvent));
      if (Option.isNone(firstEvent)) {
        return;
      }
      assert.equal(firstEvent.value.type, "mcp.status.updated");
      if (firstEvent.value.type !== "mcp.status.updated") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload.status, {
        name: "playwright",
        status: "failed",
        error: "missing browser executable",
      });
    }),
  );

  it.effect("maps Codex fuzzy file search notifications to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.forkChild,
      );

      lifecycleManager.emit("event", {
        id: asEventId("evt-fuzzy-file-search-updated"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "fuzzyFileSearch/sessionUpdated",
        payload: {
          sessionId: "search-1",
          query: "adapter",
          files: [
            {
              path: "apps/server/src/provider/Layers/CodexAdapter.ts",
              score: 0.94,
            },
          ],
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-fuzzy-file-search-completed"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "fuzzyFileSearch/sessionCompleted",
        payload: {
          sessionId: "search-1",
          query: "adapter",
        },
      } satisfies ProviderEvent);

      const events = yield* Fiber.join(eventsFiber);

      assert.equal(events.length, 2);
      const [updated, completed] = events;
      assert.equal(updated?.type, "fuzzy-file-search.session.updated");
      if (updated?.type === "fuzzy-file-search.session.updated") {
        assert.deepEqual(updated.payload, {
          sessionId: "search-1",
          query: "adapter",
          files: [
            {
              path: "apps/server/src/provider/Layers/CodexAdapter.ts",
              score: 0.94,
            },
          ],
        });
      }

      assert.equal(completed?.type, "fuzzy-file-search.session.completed");
      if (completed?.type === "fuzzy-file-search.session.completed") {
        assert.deepEqual(completed.payload, {
          sessionId: "search-1",
          query: "adapter",
        });
      }
    }),
  );

  it.effect("maps Codex filesystem watch changes to runtime file change events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-fs-changed"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "fs/changed",
        payload: {
          watchId: "watch-1",
          changedPaths: [
            "/Users/me/project/.git/HEAD",
            "/Users/me/project/.git/HEAD",
            " ",
            "/Users/me/project/package.json",
          ],
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.ok(Option.isSome(firstEvent));
      if (Option.isNone(firstEvent)) {
        return;
      }
      assert.equal(firstEvent.value.type, "files.changed");
      if (firstEvent.value.type !== "files.changed") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload, {
        watchId: "watch-1",
        changedPaths: ["/Users/me/project/.git/HEAD", "/Users/me/project/package.json"],
      });
    }),
  );

  it.effect("maps Codex hook start notifications to canonical hook events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-hook-started"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "hook/started",
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          run: {
            id: "hook-run-1",
            eventName: "preToolUse",
            handlerType: "command",
            sourcePath: "/Users/choki/.codex/hooks/pre-tool-use.sh",
            status: "running",
            entries: [],
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.ok(Option.isSome(firstEvent));
      if (Option.isNone(firstEvent)) {
        return;
      }
      assert.equal(firstEvent.value.type, "hook.started");
      if (firstEvent.value.type !== "hook.started") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.deepEqual(firstEvent.value.payload, {
        hookId: "hook-run-1",
        hookName: "pre-tool-use.sh",
        hookEvent: "preToolUse",
      });
    }),
  );

  it.effect("maps Codex hook completion notifications to canonical hook events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-hook-completed"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "hook/completed",
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          run: {
            id: "hook-run-1",
            eventName: "preToolUse",
            handlerType: "command",
            sourcePath: "/Users/choki/.codex/hooks/pre-tool-use.sh",
            status: "failed",
            statusMessage: "Hook failed before tool execution",
            entries: [
              { kind: "warning", text: "Check project policy" },
              { kind: "error", text: "Blocked unsafe command" },
            ],
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.ok(Option.isSome(firstEvent));
      if (Option.isNone(firstEvent)) {
        return;
      }
      assert.equal(firstEvent.value.type, "hook.completed");
      if (firstEvent.value.type !== "hook.completed") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.deepEqual(firstEvent.value.payload, {
        hookId: "hook-run-1",
        outcome: "error",
        output: "Check project policy\nBlocked unsafe command",
        stderr: "Blocked unsafe command",
        stdout: "Hook failed before tool execution",
      });
    }),
  );

  it.effect("maps fatal websocket stderr notifications to runtime.error", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-process-stderr-websocket"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message:
          "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.error");
      if (firstEvent.value.type !== "runtime.error") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.class, "provider_error");
      assert.equal(
        firstEvent.value.payload.message,
        "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      );
    }),
  );

  it.effect("preserves request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-request-resolved"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "serverRequest/resolved",
        payload: {
          requestId: "req-1",
          request: {
            method: "item/commandExecution/requestApproval",
          },
          decision: "accept",
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.requestId, "req-1");
      assert.deepEqual(firstEvent.value.providerRefs, {
        providerRequestId: "req-1",
      });
      assert.equal(firstEvent.value.payload.requestType, "command_execution_approval");
    }),
  );

  it.effect("preserves file-read request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-file-read-request-resolved"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "serverRequest/resolved",
        requestId: ApprovalRequestId.makeUnsafe("req-file-read-1"),
        payload: {
          request: {
            method: "item/fileRead/requestApproval",
          },
          decision: "accept",
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "file_read_approval");
    }),
  );

  it.effect("preserves computer-use request type when mapping approval decisions", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-computer-use-request-decision"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "item/requestApproval/decision",
        requestKind: "computer-use",
        payload: {
          requestId: "req-computer-use-1",
          requestKind: "computer-use",
          decision: "accept",
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.requestId, "req-computer-use-1");
      assert.deepEqual(firstEvent.value.providerRefs, {
        providerRequestId: "req-computer-use-1",
      });
      assert.equal(firstEvent.value.payload.requestType, "computer_use_approval");
    }),
  );

  it.effect(
    "normalizes structured approval decisions while preserving the raw resolution payload",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

        const decision = {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: ['allow: ["git", "status"]'],
          },
        };
        const event: ProviderEvent = {
          id: asEventId("evt-structured-request-decision"),
          kind: "notification",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt: new Date().toISOString(),
          method: "item/requestApproval/decision",
          requestId: ApprovalRequestId.makeUnsafe("req-structured-1"),
          requestKind: "command",
          payload: {
            requestId: "req-structured-1",
            requestKind: "command",
            decision,
          },
        };

        lifecycleManager.emit("event", event);
        const firstEvent = yield* Fiber.join(firstEventFiber);

        assert.equal(firstEvent._tag, "Some");
        if (firstEvent._tag !== "Some") {
          return;
        }
        assert.equal(firstEvent.value.type, "request.resolved");
        if (firstEvent.value.type !== "request.resolved") {
          return;
        }
        assert.equal(firstEvent.value.payload.requestType, "command_execution_approval");
        assert.equal(firstEvent.value.payload.decision, "accept");
        assert.deepEqual(firstEvent.value.payload.resolution, {
          requestId: "req-structured-1",
          requestKind: "command",
          decision,
        });
      }),
  );

  it.effect("preserves explicit empty multi-select user-input answers", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-user-input-empty"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "item/tool/requestUserInput/answered",
        payload: {
          answers: {
            scope: [],
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "user-input.resolved");
      if (firstEvent.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload.answers, {
        scope: [],
      });
    }),
  );

  it.effect("maps windowsSandbox/setupCompleted to session state and warning on failure", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      const event: ProviderEvent = {
        id: asEventId("evt-windows-sandbox-failed"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "windowsSandbox/setupCompleted",
        message: "Sandbox setup failed",
        payload: {
          success: false,
          detail: "unsupported environment",
        },
      };

      lifecycleManager.emit("event", event);
      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events.length, 2);

      const firstEvent = events[0];
      const secondEvent = events[1];

      assert.equal(firstEvent?.type, "session.state.changed");
      if (firstEvent?.type === "session.state.changed") {
        assert.equal(firstEvent.payload.state, "error");
        assert.equal(firstEvent.payload.reason, "Sandbox setup failed");
      }

      assert.equal(secondEvent?.type, "runtime.warning");
      if (secondEvent?.type === "runtime.warning") {
        assert.equal(secondEvent.payload.message, "Sandbox setup failed");
      }
    }),
  );

  it.effect(
    "maps requestUserInput requests and answered notifications to canonical user-input events",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
          Effect.forkChild,
        );

        lifecycleManager.emit("event", {
          id: asEventId("evt-user-input-requested"),
          kind: "request",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt: new Date().toISOString(),
          method: "item/tool/requestUserInput",
          payload: {
            requestId: "req-user-input-1",
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
        } satisfies ProviderEvent);
        lifecycleManager.emit("event", {
          id: asEventId("evt-user-input-resolved"),
          kind: "notification",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt: new Date().toISOString(),
          method: "item/tool/requestUserInput/answered",
          payload: {
            requestId: "req-user-input-1",
            answers: {
              sandbox_mode: {
                answers: ["workspace-write"],
              },
            },
          },
        } satisfies ProviderEvent);

        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.equal(events[0]?.type, "user-input.requested");
        if (events[0]?.type === "user-input.requested") {
          assert.equal(events[0].requestId, "req-user-input-1");
          assert.equal(events[0].payload.questions[0]?.id, "sandbox_mode");
        }

        assert.equal(events[1]?.type, "user-input.resolved");
        if (events[1]?.type === "user-input.resolved") {
          assert.equal(events[1].requestId, "req-user-input-1");
          assert.deepEqual(events[1].payload.answers, {
            sandbox_mode: "workspace-write",
          });
        }
      }),
  );

  it.effect("maps tool/requestUserInput method aliases to canonical user-input events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      lifecycleManager.emit("event", {
        id: asEventId("evt-user-input-requested-alias"),
        kind: "request",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "tool/requestUserInput",
        requestId: ApprovalRequestId.makeUnsafe("req-user-input-alias-1"),
        payload: {
          questions: [
            {
              id: "runtime_mode",
              header: "Runtime mode",
              question: "Which mode should be used?",
              options: [
                {
                  label: "default",
                  description: "Restore the base permission mode",
                },
              ],
            },
          ],
        },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        id: asEventId("evt-user-input-resolved-alias"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "tool/requestUserInput/answered",
        requestId: ApprovalRequestId.makeUnsafe("req-user-input-alias-1"),
        payload: {
          answers: {
            runtime_mode: {
              answers: ["default"],
            },
          },
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events[0]?.type, "user-input.requested");
      if (events[0]?.type === "user-input.requested") {
        assert.equal(events[0].requestId, "req-user-input-alias-1");
        assert.equal(events[0].payload.questions[0]?.id, "runtime_mode");
      }

      assert.equal(events[1]?.type, "user-input.resolved");
      if (events[1]?.type === "user-input.resolved") {
        assert.equal(events[1].requestId, "req-user-input-alias-1");
        assert.deepEqual(events[1].payload.answers, {
          runtime_mode: "default",
        });
      }
    }),
  );

  it.effect("normalizes compact Codex user-input question payloads", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-user-input-requested-compact"),
        kind: "request",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "tool/requestUserInput",
        requestId: ApprovalRequestId.makeUnsafe("req-user-input-compact-1"),
        payload: {
          questions: [
            {
              name: "runtime_mode",
              title: "Runtime mode",
              prompt: "Which mode should be used?",
              multi_select: true,
              options: ["default", { value: "full-access" }],
            },
          ],
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "user-input.requested");
      if (firstEvent.value.type !== "user-input.requested") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload.questions, [
        {
          id: "runtime_mode",
          header: "Runtime mode",
          question: "Which mode should be used?",
          options: [
            { label: "default", description: "default" },
            { label: "full-access", description: "full-access" },
          ],
          multiSelect: true,
        },
      ]);
    }),
  );

  it.effect("maps mcp elicitation requests to canonical user-input events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-mcp-elicitation-requested"),
        kind: "request",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "mcpServer/elicitation/request",
        requestId: ApprovalRequestId.makeUnsafe("req-mcp-elicitation-1"),
        payload: {
          questions: [
            {
              id: "project",
              header: "Project",
              question: "Project to inspect",
              options: [
                {
                  label: "server",
                  description: "Use the server package",
                },
              ],
            },
          ],
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "user-input.requested");
      if (firstEvent.value.type !== "user-input.requested") {
        return;
      }
      assert.equal(firstEvent.value.requestId, "req-mcp-elicitation-1");
      assert.equal(firstEvent.value.payload.questions[0]?.id, "project");
    }),
  );

  it.effect("maps attestation requests to a canonical request type", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-attestation-requested"),
        kind: "request",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "attestation/generate",
        requestId: ApprovalRequestId.makeUnsafe("req-attestation-1"),
        payload: {},
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.opened");
      if (firstEvent.value.type !== "request.opened") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "attestation_generate");
    }),
  );

  it.effect("infers opened request types from nested Codex request payloads", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-nested-request-opened"),
        kind: "request",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "serverRequest/opened",
        payload: {
          request: {
            id: "req-nested-open-1",
            method: "item/fileChange/requestApproval",
            path: "apps/server/src/provider/Layers/CodexAdapter.ts",
          },
          reason: "Codex wants to edit a file",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.opened");
      if (firstEvent.value.type !== "request.opened") {
        return;
      }
      assert.equal(firstEvent.value.requestId, "req-nested-open-1");
      assert.deepEqual(firstEvent.value.providerRefs, {
        providerRequestId: "req-nested-open-1",
      });
      assert.equal(firstEvent.value.payload.requestType, "file_change_approval");
      assert.equal(firstEvent.value.payload.detail, "Codex wants to edit a file");
    }),
  );

  it.effect("infers approval decision request types from nested Codex request payloads", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-nested-request-decision"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "item/requestApproval/decision",
        payload: {
          request: {
            id: "req-nested-decision-1",
            kind: "computer-use",
          },
          decision: "accept",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.requestId, "req-nested-decision-1");
      assert.deepEqual(firstEvent.value.providerRefs, {
        providerRequestId: "req-nested-decision-1",
      });
      assert.equal(firstEvent.value.payload.requestType, "computer_use_approval");
      assert.equal(firstEvent.value.payload.decision, "accept");
    }),
  );

  it.effect("maps Codex task and reasoning event chunks into canonical runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
        Effect.forkChild,
      );

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-task-started"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/task_started",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "task_started",
            turn_id: "turn-structured-1",
            collaboration_mode_kind: "plan",
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-agent-reasoning"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/agent_reasoning",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "agent_reasoning",
            text: "Need to compare both transport layers before finalizing the plan.",
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-reasoning-delta"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/reasoning_content_delta",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "reasoning_content_delta",
            turn_id: "turn-structured-1",
            item_id: "rs_reasoning_1",
            delta: "**Compare** transport boundaries",
            summary_index: 0,
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-task-complete"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/task_complete",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "task_complete",
            turn_id: "turn-structured-1",
            last_agent_message: "<proposed_plan>\n# Ship it\n</proposed_plan>",
          },
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events[0]?.type, "task.started");
      if (events[0]?.type === "task.started") {
        assert.equal(events[0].turnId, "turn-structured-1");
        assert.equal(events[0].payload.taskId, "turn-structured-1");
        assert.equal(events[0].payload.taskType, "plan");
      }

      assert.equal(events[1]?.type, "task.progress");
      if (events[1]?.type === "task.progress") {
        assert.equal(events[1].payload.taskId, "turn-structured-1");
        assert.equal(
          events[1].payload.description,
          "Need to compare both transport layers before finalizing the plan.",
        );
      }

      assert.equal(events[2]?.type, "content.delta");
      if (events[2]?.type === "content.delta") {
        assert.equal(events[2].turnId, "turn-structured-1");
        assert.equal(events[2].itemId, "rs_reasoning_1");
        assert.equal(events[2].payload.streamKind, "reasoning_summary_text");
        assert.equal(events[2].payload.summaryIndex, 0);
      }

      assert.equal(events[3]?.type, "task.completed");
      if (events[3]?.type === "task.completed") {
        assert.equal(events[3].turnId, "turn-structured-1");
        assert.equal(events[3].payload.taskId, "turn-structured-1");
        assert.equal(events[3].payload.summary, "<proposed_plan>\n# Ship it\n</proposed_plan>");
      }

      assert.equal(events[4]?.type, "turn.proposed.completed");
      if (events[4]?.type === "turn.proposed.completed") {
        assert.equal(events[4].turnId, "turn-structured-1");
        assert.equal(events[4].payload.planMarkdown, "# Ship it");
      }
    }),
  );

  it.effect("maps failed Codex task completion without coercing it to success", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-task-failed"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("parent-turn"),
        createdAt: new Date().toISOString(),
        method: "codex/event/task_complete",
        payload: {
          id: "envelope-id",
          msg: {
            type: "task_complete",
            turn_id: "child-turn",
            last_agent_message: "<proposed_plan>\n# Unsafe partial plan\n</proposed_plan>",
            error: { message: "Subagent exceeded its retry budget" },
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "task.completed") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "parent-turn");
      assert.equal(firstEvent.value.providerRefs?.providerTurnId, "child-turn");
      assert.equal(firstEvent.value.payload.taskId, "child-turn");
      assert.equal(firstEvent.value.payload.status, "failed");
      assert.equal(firstEvent.value.payload.summary, "Subagent exceeded its retry budget");
    }),
  );

  it.effect("correlates Codex task chunks by nested turn id when envelope ids differ", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
        Effect.forkChild,
      );
      const createdAt = new Date().toISOString();

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-task-id-start"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("parent-turn"),
        createdAt,
        method: "codex/event/task_started",
        payload: { id: "start-envelope", msg: { turn_id: "child-turn" } },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-task-id-progress"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("parent-turn"),
        createdAt,
        method: "codex/event/agent_reasoning",
        payload: {
          id: "progress-envelope",
          msg: { turn_id: "child-turn", text: "Inspecting protocol events" },
        },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-task-id-complete"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("parent-turn"),
        createdAt,
        method: "codex/event/task_complete",
        payload: { id: "complete-envelope", msg: { turn_id: "child-turn" } },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        events.map((event) =>
          event.type === "task.started" ||
          event.type === "task.progress" ||
          event.type === "task.completed"
            ? event.payload.taskId
            : null,
        ),
        ["child-turn", "child-turn", "child-turn"],
      );
      assert.deepEqual(
        events.map((event) => event.turnId),
        ["parent-turn", "parent-turn", "parent-turn"],
      );
    }),
  );

  it.effect("maps reasoning summary-part notifications with inline text into deltas", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-summary-part"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-summary-1"),
        createdAt: new Date().toISOString(),
        method: "item/reasoning/summaryPartAdded",
        payload: {
          itemId: "reasoning-item-1",
          summaryPart: {
            text: "Compare protocol adapters before patching.",
            index: 1,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }

      assert.equal(firstEvent.value.type, "content.delta");
      if (firstEvent.value.type !== "content.delta") {
        return;
      }

      assert.equal(firstEvent.value.payload.streamKind, "reasoning_summary_text");
      assert.equal(firstEvent.value.payload.delta, "Compare protocol adapters before patching.");
      assert.equal(firstEvent.value.payload.summaryIndex, 1);
      assert.equal(String(firstEvent.value.turnId), "turn-summary-1");
      assert.equal(String(firstEvent.value.itemId), "reasoning-item-1");
      assert.deepEqual(firstEvent.value.providerRefs, {
        providerTurnId: "turn-summary-1",
        providerItemId: "reasoning-item-1",
      });
    }),
  );

  it.effect("maps Codex item delta payload item ids to runtime content refs", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-agent-message-delta"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: new Date().toISOString(),
        method: "item/agentMessage/delta",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "msg_1",
          delta: "Hello",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "content.delta");
      if (firstEvent.value.type !== "content.delta") {
        return;
      }
      assert.equal(firstEvent.value.itemId, "msg_1");
      assert.deepEqual(firstEvent.value.providerRefs, {
        providerTurnId: "turn-1",
        providerItemId: "msg_1",
      });
      assert.deepEqual(firstEvent.value.payload, {
        streamKind: "assistant_text",
        delta: "Hello",
      });
    }),
  );

  it.effect("maps Codex command exec output deltas from base64 into command output", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-command-exec-output"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-command-1"),
        createdAt: new Date().toISOString(),
        method: "command/exec/outputDelta",
        payload: {
          processId: "exec-process-1",
          stream: "stdout",
          deltaBase64: Buffer.from("build ok\n").toString("base64"),
          capReached: false,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.ok(Option.isSome(firstEvent));
      if (Option.isNone(firstEvent)) {
        return;
      }
      assert.equal(firstEvent.value.type, "content.delta");
      if (firstEvent.value.type !== "content.delta") {
        return;
      }
      assert.equal(firstEvent.value.payload.streamKind, "command_output");
      assert.equal(firstEvent.value.payload.outputStream, "stdout");
      assert.equal(firstEvent.value.payload.capReached, false);
      assert.equal(firstEvent.value.payload.delta, "build ok\n");
      assert.equal(String(firstEvent.value.itemId), "exec-process-1");
      assert.equal(String(firstEvent.value.providerRefs?.providerItemId), "exec-process-1");
    }),
  );

  it.effect("maps Codex process output deltas from base64 into command output", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-process-output"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-command-1"),
        createdAt: new Date().toISOString(),
        method: "process/outputDelta",
        payload: {
          processHandle: "spawned-process-1",
          stream: "stderr",
          deltaBase64: Buffer.from("warning: slow test\n").toString("base64"),
          capReached: true,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.ok(Option.isSome(firstEvent));
      if (Option.isNone(firstEvent)) {
        return;
      }
      assert.equal(firstEvent.value.type, "content.delta");
      if (firstEvent.value.type !== "content.delta") {
        return;
      }
      assert.equal(firstEvent.value.payload.streamKind, "command_output");
      assert.equal(firstEvent.value.payload.outputStream, "stderr");
      assert.equal(firstEvent.value.payload.capReached, true);
      assert.equal(firstEvent.value.payload.delta, "warning: slow test\n");
      assert.equal(String(firstEvent.value.itemId), "spawned-process-1");
      assert.equal(String(firstEvent.value.providerRefs?.providerItemId), "spawned-process-1");
    }),
  );

  it.effect("maps Codex process exit notifications to command item completion", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-process-exited"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-command-1"),
        createdAt: new Date().toISOString(),
        method: "process/exited",
        payload: {
          processHandle: "spawned-process-1",
          exitCode: 2,
          stdout: "partial stdout",
          stdoutCapReached: true,
          stderr: "command failed",
          stderrCapReached: false,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.ok(Option.isSome(firstEvent));
      if (Option.isNone(firstEvent)) {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(String(firstEvent.value.itemId), "spawned-process-1");
      assert.equal(String(firstEvent.value.providerRefs?.providerItemId), "spawned-process-1");
      assert.deepEqual(firstEvent.value.payload, {
        itemType: "command_execution",
        status: "failed",
        title: "Ran command",
        detail: "Process exited with code 2",
        data: {
          processHandle: "spawned-process-1",
          exitCode: 2,
          stdout: "partial stdout",
          stderr: "command failed",
          stdoutCapReached: true,
          stderrCapReached: false,
        },
      });
    }),
  );

  it.effect("maps Codex realtime start notifications with protocol versions", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-realtime-started"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "thread/realtime/started",
        payload: {
          threadId: "thread-1",
          realtimeSessionId: "rt-session-1",
          version: "v2",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "thread.realtime.started");
      if (firstEvent.value.type !== "thread.realtime.started") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload, {
        realtimeSessionId: "rt-session-1",
        version: "v2",
      });
    }),
  );

  it.effect("maps Codex realtime SDP notifications to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-realtime-sdp"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "thread/realtime/sdp",
        payload: {
          threadId: "thread-1",
          sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }

      assert.equal(firstEvent.value.type, "thread.realtime.sdp");
      if (firstEvent.value.type !== "thread.realtime.sdp") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload, {
        sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-",
      });
    }),
  );

  it.effect("maps Codex realtime audio notifications to audio chunks", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-realtime-audio"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "thread/realtime/outputAudio/delta",
        payload: {
          threadId: "thread-1",
          audio: {
            data: "AAECAw==",
            sampleRate: 24_000,
            numChannels: 1,
            samplesPerChannel: 480,
            itemId: "item-audio-1",
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }

      assert.equal(firstEvent.value.type, "thread.realtime.audio.delta");
      if (firstEvent.value.type !== "thread.realtime.audio.delta") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload.audio, {
        data: "AAECAw==",
        sampleRate: 24_000,
        numChannels: 1,
        samplesPerChannel: 480,
        itemId: "item-audio-1",
      });
    }),
  );

  it.effect("maps Codex realtime item-added notifications to nested items", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-realtime-item-added"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "thread/realtime/itemAdded",
        payload: {
          threadId: "thread-1",
          item: {
            id: "rt-item-1",
            type: "message",
            role: "assistant",
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }

      assert.equal(firstEvent.value.type, "thread.realtime.item-added");
      if (firstEvent.value.type !== "thread.realtime.item-added") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload.item, {
        id: "rt-item-1",
        type: "message",
        role: "assistant",
      });
    }),
  );

  it.effect("maps Codex realtime transcript notifications to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.forkChild,
      );

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-realtime-transcript-delta"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "thread/realtime/transcript/delta",
        payload: {
          threadId: "thread-1",
          role: "user",
          delta: "hello",
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-realtime-transcript-done"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "thread/realtime/transcript/done",
        payload: {
          threadId: "thread-1",
          role: "assistant",
          text: "Hello there.",
        },
      } satisfies ProviderEvent);

      const events = yield* Fiber.join(eventsFiber);

      assert.equal(events.length, 2);
      const [delta, done] = events;
      assert.equal(delta?.type, "thread.realtime.transcript.delta");
      if (delta?.type === "thread.realtime.transcript.delta") {
        assert.deepEqual(delta.payload, {
          role: "user",
          delta: "hello",
        });
      }

      assert.equal(done?.type, "thread.realtime.transcript.done");
      if (done?.type === "thread.realtime.transcript.done") {
        assert.deepEqual(done.payload, {
          role: "assistant",
          text: "Hello there.",
        });
      }
    }),
  );

  it.effect("maps Codex realtime closed payload reasons to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-realtime-closed"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "thread/realtime/closed",
        payload: {
          threadId: "thread-1",
          reason: "client stopped realtime",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "thread.realtime.closed");
      if (firstEvent.value.type !== "thread.realtime.closed") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload, {
        reason: "client stopped realtime",
      });
    }),
  );

  it.effect("unwraps Codex account rate-limit update snapshots", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const rateLimits = {
        limitId: "primary-window",
        limitName: "Primary usage",
        primary: {
          usedPercent: 42,
          windowMinutes: 300,
          resetsAt: "2026-06-04T21:00:00.000Z",
        },
        secondary: null,
        credits: null,
        individualLimit: null,
        planType: "plus",
        rateLimitReachedType: null,
      };

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-account-rate-limits-updated"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "account/rateLimits/updated",
        payload: {
          rateLimits,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "account.rate-limits.updated");
      if (firstEvent.value.type !== "account.rate-limits.updated") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload.rateLimits, rateLimits);
    }),
  );

  it.effect("maps Codex model verification notifications to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-model-verification"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-verification-1"),
        createdAt: new Date().toISOString(),
        method: "model/verification",
        payload: {
          threadId: "thread-1",
          turnId: "turn-verification-1",
          verifications: ["trustedAccessForCyber"],
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.ok(Option.isSome(firstEvent));
      if (Option.isNone(firstEvent)) {
        return;
      }
      assert.equal(firstEvent.value.type, "model.verification");
      if (firstEvent.value.type !== "model.verification") {
        return;
      }
      assert.equal(String(firstEvent.value.turnId), "turn-verification-1");
      assert.deepEqual(firstEvent.value.payload.verifications, ["trustedAccessForCyber"]);
    }),
  );

  it.effect("prefers manager-assigned turn ids for Codex task events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-task-started-parent-turn"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-parent"),
        createdAt: new Date().toISOString(),
        method: "codex/event/task_started",
        payload: {
          id: "turn-child",
          msg: {
            type: "task_started",
            turn_id: "turn-child",
            collaboration_mode_kind: "default",
          },
          conversationId: "child-provider-thread",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "task.started");
      if (firstEvent.value.type !== "task.started") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-parent");
      assert.equal(firstEvent.value.providerRefs?.providerTurnId, "turn-child");
      assert.equal(firstEvent.value.payload.taskId, "turn-child");
    }),
  );

  it.effect("unwraps Codex token usage payloads for context window events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-thread-token-usage-updated"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: new Date().toISOString(),
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              inputTokens: 11_833,
              cachedInputTokens: 3456,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 11_839,
            },
            last: {
              inputTokens: 120,
              cachedInputTokens: 0,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 126,
            },
            modelContextWindow: 258_400,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "thread.token-usage.updated");
      if (firstEvent.value.type !== "thread.token-usage.updated") {
        return;
      }

      assert.deepEqual(firstEvent.value.payload.usage, {
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
      });
    }),
  );
});

afterAll(() => {
  if (lifecycleManager.stopAllImpl.mock.calls.length === 0) {
    lifecycleManager.stopAll();
  }
  assert.ok(lifecycleManager.stopAllImpl.mock.calls.length >= 1);
});
