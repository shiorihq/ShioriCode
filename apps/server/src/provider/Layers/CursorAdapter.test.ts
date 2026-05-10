import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "contracts";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { CursorAdapter } from "../Services/CursorAdapter.ts";
import {
  makeCursorAdapterLive,
  parseCursorResume,
  resolveCursorPermissionOptionId,
} from "./CursorAdapter.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-cursor-test");

class FakeCursorAcpRuntime {
  private askQuestionHandler:
    | ((params: unknown) => Effect.Effect<unknown, EffectAcpErrors.AcpError>)
    | undefined;
  private updateTodosHandler:
    | ((params: unknown) => Effect.Effect<void, EffectAcpErrors.AcpError>)
    | undefined;
  readonly setModelCalls: Array<string> = [];
  readonly cancelCalls: Array<void> = [];
  promptEffect: Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError> =
    Effect.succeed({ stopReason: "end_turn" });
  startTodoUpdate: unknown | undefined;

  readonly shape = {
    handleRequestPermission: () => Effect.void,
    handleElicitation: () => Effect.void,
    handleReadTextFile: () => Effect.void,
    handleWriteTextFile: () => Effect.void,
    handleCreateTerminal: () => Effect.void,
    handleTerminalOutput: () => Effect.void,
    handleTerminalWaitForExit: () => Effect.void,
    handleTerminalKill: () => Effect.void,
    handleTerminalRelease: () => Effect.void,
    handleSessionUpdate: () => Effect.void,
    handleElicitationComplete: () => Effect.void,
    handleUnknownExtRequest: () => Effect.void,
    handleUnknownExtNotification: () => Effect.void,
    handleExtRequest: (method: string, _schema: unknown, handler: typeof this.askQuestionHandler) =>
      Effect.sync(() => {
        if (method === "cursor/ask_question") {
          this.askQuestionHandler = handler;
        }
      }),
    handleExtNotification: (
      method: string,
      _schema: unknown,
      handler: typeof this.updateTodosHandler,
    ) =>
      Effect.sync(() => {
        if (method === "cursor/update_todos") {
          this.updateTodosHandler = handler;
        }
      }),
    start: () => {
      const result = {
        sessionId: "cursor-session-1",
        initializeResult: {},
        sessionSetupResult: {},
        modelConfigId: undefined,
      } as unknown as import("../acp/AcpSessionRuntime.ts").AcpSessionRuntimeStartResult;
      if (this.startTodoUpdate && this.updateTodosHandler) {
        return this.updateTodosHandler(this.startTodoUpdate).pipe(Effect.as(result));
      }
      return Effect.succeed(result);
    },
    getEvents: () => Stream.empty,
    getModeState: Effect.succeed(undefined),
    getConfigOptions: Effect.succeed([]),
    prompt: () => this.promptEffect,
    cancel: Effect.sync(() => {
      this.cancelCalls.push(undefined);
    }),
    setMode: () => Effect.succeed({}),
    setConfigOption: () => Effect.succeed({ configOptions: [] }),
    setModel: (model: string) =>
      Effect.sync(() => {
        this.setModelCalls.push(model);
      }),
    request: () => Effect.succeed({}),
    notify: () => Effect.void,
  } as unknown as AcpSessionRuntimeShape;

  askQuestion(params: unknown) {
    if (!this.askQuestionHandler) {
      return Effect.die("cursor/ask_question handler was not registered");
    }
    return this.askQuestionHandler(params);
  }
}

function makeHarness(fake: FakeCursorAcpRuntime) {
  return makeCursorAdapterLive({
    makeRuntime: () => Effect.succeed(fake.shape),
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest("/tmp/cursor-adapter-test", { prefix: "cursor" })),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("unused child process spawner")),
      ),
    ),
  );
}

describe("CursorAdapterLive", () => {
  it.effect("uses nonstandard ACP option ids for approval decisions", () =>
    Effect.sync(() => {
      const options: ReadonlyArray<EffectAcpSchema.PermissionOption> = [
        { optionId: "session-yes", name: "Accept for session", kind: "allow_always" },
        { optionId: "once-yes", name: "Accept", kind: "allow_once" },
        { optionId: "nope", name: "Decline", kind: "reject_once" },
      ];

      assert.deepStrictEqual(resolveCursorPermissionOptionId(options, "acceptForSession"), {
        optionId: "session-yes",
      });
      assert.deepStrictEqual(resolveCursorPermissionOptionId(options, "accept"), {
        optionId: "once-yes",
      });
      assert.deepStrictEqual(resolveCursorPermissionOptionId(options, "decline"), {
        optionId: "nope",
      });
    }),
  );

  it.effect("emits a cancelled turn when interrupting a never-resolving prompt", () => {
    const fake = new FakeCursorAcpRuntime();
    fake.promptEffect = Effect.never;
    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "cursor",
        cwd: "/tmp/cursor-adapter-test",
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello" });
      yield* adapter.interruptTurn(THREAD_ID);

      const completed = yield* Fiber.join(completedFiber);
      if (Option.isNone(completed)) {
        assert.fail("Expected a turn.completed event");
      }
      assert.deepInclude(completed.value.payload, {
        state: "cancelled",
      });
      assert.lengthOf(fake.cancelCalls, 1);
    }).pipe(Effect.provide(makeHarness(fake)), Effect.scoped);
  });

  it.effect("resolves pending ask_question requests when interrupted", () => {
    const fake = new FakeCursorAcpRuntime();
    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "cursor",
        cwd: "/tmp/cursor-adapter-test",
        runtimeMode: "approval-required",
      });
      const requestedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "user-input.requested"),
        Stream.runHead,
        Effect.forkScoped,
      );

      const responseFiber = yield* fake
        .askQuestion({
          toolCallId: "tool-1",
          questions: [
            {
              id: "mode",
              prompt: "Which mode?",
              options: [{ id: "agent", label: "Agent" }],
            },
          ],
        })
        .pipe(Effect.forkScoped);
      yield* Fiber.join(requestedFiber);
      yield* adapter.interruptTurn(THREAD_ID);

      const response = yield* Fiber.join(responseFiber);
      assert.deepStrictEqual(response, { outcome: { outcome: "cancelled" } });
    }).pipe(Effect.provide(makeHarness(fake)), Effect.scoped);
  });

  it.effect("flushes update_todos notifications emitted before context assignment", () => {
    const fake = new FakeCursorAcpRuntime();
    fake.startTodoUpdate = {
      toolCallId: "todos-1",
      merge: false,
      todos: [{ id: "a", content: "Flush startup todos", status: "in_progress" }],
    };
    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const planFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.plan.updated"),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "cursor",
        cwd: "/tmp/cursor-adapter-test",
        runtimeMode: "approval-required",
      });

      const plan = yield* Fiber.join(planFiber);
      if (Option.isNone(plan)) {
        assert.fail("Expected a turn.plan.updated event");
      }
      assert.deepStrictEqual(plan.value.payload.plan, [
        { step: "Flush startup todos", status: "inProgress" },
      ]);
    }).pipe(Effect.provide(makeHarness(fake)), Effect.scoped);
  });

  it("parses v1 and v2 resume cursors and returns diagnostics for invalid input", () => {
    assert.deepStrictEqual(parseCursorResume({ schemaVersion: 1, sessionId: "old" }), {
      sessionId: "old",
    });
    assert.deepStrictEqual(
      parseCursorResume({ schemaVersion: 2, provider: "cursor", sessionId: "new" }),
      {
        sessionId: "new",
      },
    );
    assert.match(
      parseCursorResume({ schemaVersion: 99, sessionId: "future" })?.diagnostic ?? "",
      /unsupported/u,
    );
  });
});
