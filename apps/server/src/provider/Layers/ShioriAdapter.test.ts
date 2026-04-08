// @ts-nocheck
import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "contracts";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import { afterEach, describe, it, vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import { HostedShioriAuthTokenStore } from "../../hostedShioriAuthTokenStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  WorkspaceEntries,
  type WorkspaceEntriesShape,
} from "../../workspace/Services/WorkspaceEntries.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ShioriAdapter } from "../Services/ShioriAdapter.ts";
import {
  ShioriAdapterLive,
  SHIORI_WORKSPACE_RULES,
  buildShioriWorkspaceRules,
  buildHostedToolDescriptors,
  buildInterruptedTurnEvents,
  makeShioriAdapterLive,
  toolRequestKind,
} from "./ShioriAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asRuntimeItemId = (value: string): RuntimeItemId => RuntimeItemId.makeUnsafe(value);

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in this test")),
  getBinding: () => Effect.succeed(Option.none()),
  remove: () => Effect.void,
  listThreadIds: () => Effect.succeed([]),
});

const hostedShioriAuthTokenStoreTestLayer = Layer.succeed(HostedShioriAuthTokenStore, {
  getToken: Effect.succeed("header.payload.signature"),
  setToken: () => Effect.void,
  streamChanges: Stream.empty,
});

const workspaceEntriesTestLayer = Layer.succeed(WorkspaceEntries, {
  listDirectory: () => Effect.die(new Error("WorkspaceEntries.listDirectory is not used in test")),
  search: () => Effect.die(new Error("WorkspaceEntries.search is not used in test")),
  invalidate: () => Effect.void,
} satisfies WorkspaceEntriesShape);

const shioriAdapterTestLayer = ShioriAdapterLive.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-shiori-adapter-test-" })),
  Layer.provideMerge(
    ServerSettingsService.layerTest({
      providers: {
        shiori: {
          apiBaseUrl: "http://shiori.test",
        },
      },
    }),
  ),
  Layer.provideMerge(hostedShioriAuthTokenStoreTestLayer),
  Layer.provideMerge(providerSessionDirectoryTestLayer),
  Layer.provideMerge(workspaceEntriesTestLayer),
  Layer.provideMerge(NodeServices.layer),
);

function makeShioriAdapterTestLayer(options?: Parameters<typeof makeShioriAdapterLive>[0]) {
  return makeShioriAdapterLive(options).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-shiori-adapter-test-" }),
    ),
    Layer.provideMerge(
      ServerSettingsService.layerTest({
        providers: {
          shiori: {
            apiBaseUrl: "http://shiori.test",
          },
        },
      }),
    ),
    Layer.provideMerge(hostedShioriAuthTokenStoreTestLayer),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(workspaceEntriesTestLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function encodeSseChunk(value: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
}

function responseFromChunks(chunks: ReadonlyArray<unknown>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encodeSseChunk(chunk));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
      },
    },
  );
}

function bodyToString(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body).toString("utf8");
  }
  return "";
}

describe("buildInterruptedTurnEvents", () => {
  it("closes reasoning and assistant items before marking the turn interrupted", () => {
    const events = buildInterruptedTurnEvents({
      threadId: asThreadId("thread-shiori-interrupt"),
      turnId: asTurnId("turn-shiori-interrupt"),
      assistantItemId: asRuntimeItemId("assistant:turn-shiori-interrupt"),
      assistantStarted: true,
      openReasoningItemIds: [asRuntimeItemId("reasoning:turn-shiori-interrupt:reasoning-1")],
      assistantText: "Partial output",
    });

    assert.deepStrictEqual(
      events.map((event) => event.type),
      ["item.completed", "item.completed", "turn.completed"],
    );

    const [reasoningCompleted, assistantCompleted, turnCompleted] = events;
    assert.equal(reasoningCompleted?.type, "item.completed");
    if (reasoningCompleted?.type === "item.completed") {
      assert.equal(reasoningCompleted.payload.itemType, "reasoning");
      assert.equal(reasoningCompleted.payload.status, "completed");
    }

    assert.equal(assistantCompleted?.type, "item.completed");
    if (assistantCompleted?.type === "item.completed") {
      assert.equal(assistantCompleted.payload.itemType, "assistant_message");
      assert.equal(assistantCompleted.payload.status, "completed");
      assert.equal(assistantCompleted.payload.detail, "Partial output");
    }

    assert.equal(turnCompleted?.type, "turn.completed");
    if (turnCompleted?.type === "turn.completed") {
      assert.equal(turnCompleted.payload.state, "interrupted");
    }
  });

  it("still emits an interrupted turn completion when no streamed items started", () => {
    const events = buildInterruptedTurnEvents({
      threadId: asThreadId("thread-shiori-idle"),
      turnId: asTurnId("turn-shiori-idle"),
      assistantItemId: asRuntimeItemId("assistant:turn-shiori-idle"),
      assistantStarted: false,
      openReasoningItemIds: [],
      assistantText: "",
    });

    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "turn.completed");
    if (events[0]?.type === "turn.completed") {
      assert.equal(events[0].payload.state, "interrupted");
    }
  });
});

describe("ShioriAdapterLive interruptTurn", () => {
  it("treats a clean stream close after abort as interrupted", async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (signal?.aborted) {
            controller.close();
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              controller.close();
            },
            { once: true },
          );
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
        },
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ShioriAdapter;
        const threadId = asThreadId("thread-shiori-stop");

        yield* adapter.startSession({
          provider: "shiori",
          threadId,
          runtimeMode: "approval-required",
        });

        const turn = yield* adapter.sendTurn({
          threadId,
          input: "Please stop this turn.",
        });

        yield* adapter.interruptTurn(threadId, turn.turnId);

        const thread = yield* adapter.readThread(threadId);
        assert.equal(thread.turns.length, 0);

        const sessions = yield* adapter.listSessions();
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0]?.status, "ready");
      }).pipe(Effect.provide(shioriAdapterTestLayer), Effect.scoped),
    );
  });
});

describe("ShioriAdapterLive session state", () => {
  it("restores rollback state from the resume cursor", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      return responseFromChunks([
        { type: "text-start", id: `text-${callCount}` },
        { type: "text-delta", id: `text-${callCount}`, delta: `turn-${callCount}` },
        { type: "text-end", id: `text-${callCount}` },
        {
          type: "finish",
          finishReason: "stop",
        },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-rollback");

          const waitForCompletion = () =>
            Effect.forkScoped(
              Stream.runHead(
                adapter.streamEvents.pipe(
                  Stream.filter(
                    (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
                      event.type === "turn.completed",
                  ),
                ),
              ),
            );

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          const firstCompletion = yield* waitForCompletion();
          yield* Effect.sleep("10 millis");
          yield* adapter.sendTurn({ threadId, input: "first" });
          const firstCompleted = yield* Fiber.join(firstCompletion);
          assert.equal(firstCompleted._tag, "Some");

          const secondCompletion = yield* waitForCompletion();
          yield* Effect.sleep("10 millis");
          yield* adapter.sendTurn({ threadId, input: "second" });
          const secondCompleted = yield* Fiber.join(secondCompletion);
          assert.equal(secondCompleted._tag, "Some");

          const beforeRollback = yield* adapter.readThread(threadId);
          assert.equal(beforeRollback.turns.length, 2);

          const rolledBack = yield* adapter.rollbackThread(threadId, 1);
          assert.equal(rolledBack.turns.length, 1);

          const sessions = yield* adapter.listSessions();
          const resumeCursor = sessions[0]?.resumeCursor;
          assert.ok(resumeCursor);

          yield* adapter.stopSession(threadId);
          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "full-access",
            resumeCursor,
          });

          const restored = yield* adapter.readThread(threadId);
          assert.equal(restored.turns.length, 1);
          assert.equal(restored.turns[0]?.id, beforeRollback.turns[0]?.id);
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("preserves pre-tool assistant text and continues after auto tool failure", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      requestBodies.push(JSON.parse(bodyToString(init?.body)));

      if (callCount === 1) {
        return responseFromChunks([
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", delta: "Before tool. " },
          {
            type: "tool-input-available",
            toolCallId: "tool-1",
            toolName: "read_file",
            input: { path: "missing.txt" },
          },
        ]);
      }

      const secondBody = requestBodies[1];
      const secondMessages = Array.isArray(secondBody?.messages)
        ? (secondBody.messages as Array<Record<string, unknown>>)
        : [];
      const lastAssistantMessage = secondMessages.at(-1);
      const lastParts = Array.isArray(lastAssistantMessage?.parts)
        ? (lastAssistantMessage.parts as Array<Record<string, unknown>>)
        : [];

      assert.equal(lastAssistantMessage?.role, "assistant");
      assert.equal(lastParts[0]?.type, "text");
      assert.equal(lastParts[0]?.text, "Before tool. ");
      assert.equal(lastParts[1]?.type, "dynamic-tool");
      assert.equal(lastParts[1]?.state, "output-error");

      return responseFromChunks([
        { type: "text-start", id: "text-2" },
        { type: "text-delta", id: "text-2", delta: "Recovered after tool." },
        { type: "text-end", id: "text-2" },
        {
          type: "finish",
          finishReason: "stop",
        },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-tool-error");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "full-access",
          });

          const completionFiber = yield* Effect.forkScoped(
            Stream.runHead(
              adapter.streamEvents.pipe(
                Stream.filter(
                  (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
                    event.type === "turn.completed",
                ),
              ),
            ),
          );
          yield* Effect.sleep("10 millis");

          yield* adapter.sendTurn({
            threadId,
            input: "Please inspect the file.",
          });

          const completed = yield* Fiber.join(completionFiber);
          assert.equal(completed._tag, "Some");
          if (completed._tag === "Some") {
            assert.equal(completed.value.type, "turn.completed");
            assert.equal(completed.value.payload.state, "completed");
          }

          assert.equal(requestBodies.length, 2);
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("keeps commentary-like pre-tool text out of replay history and the final answer", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      requestBodies.push(JSON.parse(bodyToString(init?.body)));

      if (callCount === 1) {
        return responseFromChunks([
          { type: "text-start", id: "text-1" },
          {
            type: "text-delta",
            id: "text-1",
            delta:
              "I'll start by exploring the workspace to understand the recent changes. Now let me check the git history to see recent changes. Now let me check the most recent changes in detail.",
          },
          {
            type: "tool-input-available",
            toolCallId: "tool-1",
            toolName: "read_file",
            input: { path: "missing.txt" },
          },
        ]);
      }

      const secondBody = requestBodies[1];
      const secondMessages = Array.isArray(secondBody?.messages)
        ? (secondBody.messages as Array<Record<string, unknown>>)
        : [];
      const lastAssistantMessage = secondMessages.at(-1);
      const lastParts = Array.isArray(lastAssistantMessage?.parts)
        ? (lastAssistantMessage.parts as Array<Record<string, unknown>>)
        : [];

      assert.equal(lastAssistantMessage?.role, "assistant");
      assert.equal(lastParts[0]?.type, "dynamic-tool");
      assert.equal(lastParts[0]?.state, "output-error");

      return responseFromChunks([
        { type: "text-start", id: "text-2" },
        { type: "text-delta", id: "text-2", delta: "Here is the final answer." },
        { type: "text-end", id: "text-2" },
        {
          type: "finish",
          finishReason: "stop",
        },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-commentary");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "full-access",
          });

          const eventsFiber = yield* Effect.forkScoped(
            Stream.runCollect(adapter.streamEvents.pipe(Stream.take(8))),
          );
          yield* Effect.sleep("10 millis");

          yield* adapter.sendTurn({
            threadId,
            input: "Review the repo changes.",
          });

          const events = Array.from(yield* Fiber.join(eventsFiber));
          const commentaryEvent = events.find(
            (event) =>
              event.type === "item.completed" &&
              event.payload.itemType === "assistant_message" &&
              event.payload.data &&
              typeof event.payload.data === "object" &&
              "item" in event.payload.data &&
              typeof event.payload.data.item === "object" &&
              event.payload.data.item !== null &&
              "phase" in event.payload.data.item &&
              event.payload.data.item.phase === "commentary",
          );
          const finalAssistantCompletion = events
            .toReversed()
            .find(
              (event) =>
                event.type === "item.completed" &&
                event.payload.itemType === "assistant_message" &&
                event.payload.detail === "Here is the final answer.",
            );

          assert.equal(requestBodies.length, 2);
          assert.ok(commentaryEvent);
          assert.match(
            String(commentaryEvent?.payload.detail ?? ""),
            /I'll start by exploring the workspace/i,
          );
          assert.ok(finalAssistantCompletion);
          assert.equal(finalAssistantCompletion?.payload.detail, "Here is the final answer.");
          assert.ok(!String(finalAssistantCompletion?.payload.detail ?? "").includes("I'll start"));
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("preserves assistant reasoning parts when replaying tool calls", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      requestBodies.push(JSON.parse(bodyToString(init?.body)));

      if (callCount === 1) {
        return responseFromChunks([
          { type: "reasoning-start", id: "reasoning-1" },
          {
            type: "reasoning-delta",
            id: "reasoning-1",
            delta: "Need the file contents first. ",
            providerMetadata: {
              openai: {
                itemId: "rs_reasoning_1",
                reasoningEncryptedContent: "encrypted-reasoning",
              },
            },
          },
          { type: "reasoning-end", id: "reasoning-1" },
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", delta: "Before tool. " },
          {
            type: "tool-input-available",
            toolCallId: "tool-1",
            toolName: "read_file",
            input: { path: "missing.txt" },
            providerMetadata: {
              openai: {
                itemId: "fc_tool_1",
              },
            },
          },
        ]);
      }

      const secondBody = requestBodies[1];
      const secondMessages = Array.isArray(secondBody?.messages)
        ? (secondBody.messages as Array<Record<string, unknown>>)
        : [];
      const lastAssistantMessage = secondMessages.at(-1);
      const lastParts = Array.isArray(lastAssistantMessage?.parts)
        ? (lastAssistantMessage.parts as Array<Record<string, unknown>>)
        : [];

      assert.equal(lastAssistantMessage?.role, "assistant");
      assert.equal(lastParts[0]?.type, "reasoning");
      assert.equal(lastParts[0]?.text, "Need the file contents first. ");
      assert.deepStrictEqual(lastParts[0]?.providerMetadata, {
        openai: {
          itemId: "rs_reasoning_1",
          reasoningEncryptedContent: "encrypted-reasoning",
        },
      });
      assert.equal(lastParts[1]?.type, "text");
      assert.equal(lastParts[1]?.text, "Before tool. ");
      assert.equal(lastParts[2]?.type, "dynamic-tool");

      return responseFromChunks([
        { type: "text-start", id: "text-2" },
        { type: "text-delta", id: "text-2", delta: "Recovered after replay." },
        { type: "text-end", id: "text-2" },
        {
          type: "finish",
          finishReason: "stop",
        },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-reasoning-replay");

          const completionFiber = yield* Effect.forkScoped(
            Stream.runHead(
              adapter.streamEvents.pipe(
                Stream.filter(
                  (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
                    event.type === "turn.completed",
                ),
              ),
            ),
          );
          yield* Effect.sleep("10 millis");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          yield* adapter.sendTurn({
            threadId,
            input: "Inspect before using the tool.",
          });

          const completed = yield* Fiber.join(completionFiber);
          assert.equal(completed._tag, "Some");
          assert.equal(requestBodies.length, 2);
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("continues after an approved tool failure instead of wedging the turn", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      requestBodies.push(JSON.parse(bodyToString(init?.body)));

      if (callCount === 1) {
        return responseFromChunks([
          {
            type: "tool-input-available",
            toolCallId: "tool-approval-1",
            toolName: "read_file",
            input: { path: "missing-after-approval.txt" },
          },
        ]);
      }

      const secondBody = requestBodies[1];
      const secondMessages = Array.isArray(secondBody?.messages)
        ? (secondBody.messages as Array<Record<string, unknown>>)
        : [];
      const lastAssistantMessage = secondMessages.at(-1);
      const lastParts = Array.isArray(lastAssistantMessage?.parts)
        ? (lastAssistantMessage.parts as Array<Record<string, unknown>>)
        : [];

      assert.equal(lastParts[0]?.type, "dynamic-tool");
      assert.equal(lastParts[0]?.state, "output-error");

      return responseFromChunks([
        { type: "text-start", id: "text-approved" },
        { type: "text-delta", id: "text-approved", delta: "The read failed." },
        { type: "text-end", id: "text-approved" },
        {
          type: "finish",
          finishReason: "stop",
        },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-approved-tool-error");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          });

          const approvalFiber = yield* Effect.forkScoped(
            Stream.runHead(
              adapter.streamEvents.pipe(
                Stream.filter(
                  (event): event is Extract<ProviderRuntimeEvent, { type: "request.opened" }> =>
                    event.type === "request.opened",
                ),
              ),
            ),
          );
          yield* Effect.sleep("10 millis");

          const completionFiber = yield* Effect.forkScoped(
            Stream.runHead(
              adapter.streamEvents.pipe(
                Stream.filter(
                  (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
                    event.type === "turn.completed",
                ),
              ),
            ),
          );
          yield* Effect.sleep("10 millis");

          yield* adapter.sendTurn({
            threadId,
            input: "Read the file after approval.",
          });

          const approval = yield* Fiber.join(approvalFiber);
          assert.equal(approval._tag, "Some");
          assert.equal(approval.value.type, "request.opened");
          assert.ok(approval.value.requestId);

          yield* adapter.respondToRequest(threadId, approval.value.requestId, "accept");

          const completed = yield* Fiber.join(completionFiber);
          assert.equal(completed._tag, "Some");
          if (completed._tag === "Some") {
            assert.equal(completed.value.type, "turn.completed");
            assert.equal(completed.value.payload.state, "completed");
          }
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("fails the turn when the hosted stream reports invalid tool input", async () => {
    const fetchMock = vi.fn(async () =>
      responseFromChunks([
        {
          type: "tool-input-error",
          toolCallId: "tool-invalid-1",
          toolName: "read_file",
          input: { path: 123 },
          errorText: "Input did not match the read_file schema.",
        },
      ]),
    );

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-tool-input-error");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          yield* adapter.sendTurn({
            threadId,
            input: "Read the file.",
          });
          yield* Effect.sleep("200 millis");

          const session = (yield* adapter.listSessions())[0];
          assert.equal(session?.status, "ready");
          assert.match(session?.lastError ?? "", /Input did not match the read_file schema/i);
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("does not append an empty trailing assistant message after a tool-only continuation", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return responseFromChunks([
          { type: "text-start", id: "text-tool-only" },
          { type: "text-delta", id: "text-tool-only", delta: "Before tool. " },
          {
            type: "tool-input-available",
            toolCallId: "tool-only-1",
            toolName: "read_file",
            input: { path: "missing.txt" },
          },
        ]);
      }

      return responseFromChunks([
        {
          type: "finish",
          finishReason: "stop",
        },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-tool-only");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          const completionFiber = yield* Effect.forkScoped(
            Stream.runHead(
              adapter.streamEvents.pipe(
                Stream.filter(
                  (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
                    event.type === "turn.completed",
                ),
              ),
            ),
          );
          yield* Effect.sleep("10 millis");

          yield* adapter.sendTurn({
            threadId,
            input: "Inspect the missing file.",
          });

          const completed = yield* Fiber.join(completionFiber);
          assert.equal(completed._tag, "Some");

          const session = (yield* adapter.listSessions())[0];
          const resumeCursor = session?.resumeCursor as
            | {
                messages?: Array<{
                  role?: string;
                  parts?: Array<{ type?: string; text?: string }>;
                }>;
              }
            | undefined;
          assert.ok(resumeCursor);
          assert.equal(resumeCursor?.messages?.length, 3);
          assert.equal(resumeCursor?.messages?.at(-1)?.role, "assistant");
          assert.ok((resumeCursor?.messages?.at(-1)?.parts?.length ?? 0) > 0);
          assert.equal(resumeCursor?.messages?.at(-1)?.parts?.[0]?.type, "text");
          assert.equal(resumeCursor?.messages?.at(-1)?.parts?.[0]?.text, "Before tool. ");
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("emits file_change approval on write_file resolution", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return responseFromChunks([
          {
            type: "tool-input-available",
            toolCallId: "tool-write-1",
            toolName: "write_file",
            input: { path: "notes.txt", content: "hello" },
          },
        ]);
      }

      return responseFromChunks([
        { type: "text-start", id: "text-write" },
        { type: "text-delta", id: "text-write", delta: "Wrote the file." },
        { type: "text-end", id: "text-write" },
        {
          type: "finish",
          finishReason: "stop",
        },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-write-file");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          });

          const approvalFiber = yield* Effect.forkScoped(
            Stream.runHead(
              adapter.streamEvents.pipe(
                Stream.filter(
                  (event): event is Extract<ProviderRuntimeEvent, { type: "request.opened" }> =>
                    event.type === "request.opened",
                ),
              ),
            ),
          );
          yield* Effect.sleep("10 millis");

          const resolvedFiber = yield* Effect.forkScoped(
            Stream.runHead(
              adapter.streamEvents.pipe(
                Stream.filter(
                  (event): event is Extract<ProviderRuntimeEvent, { type: "request.resolved" }> =>
                    event.type === "request.resolved",
                ),
              ),
            ),
          );
          yield* Effect.sleep("10 millis");

          yield* adapter.sendTurn({
            threadId,
            input: "Write the file after approval.",
          });

          const approval = yield* Fiber.join(approvalFiber);
          assert.equal(approval._tag, "Some");
          assert.equal(approval.value.type, "request.opened");
          assert.ok(approval.value.requestId);

          yield* adapter.respondToRequest(threadId, approval.value.requestId, "accept");

          const resolved = yield* Fiber.join(resolvedFiber);
          assert.equal(resolved._tag, "Some");
          if (resolved._tag === "Some") {
            assert.equal(resolved.value.type, "request.resolved");
            assert.equal(resolved.value.payload.requestType, "file_change_approval");
          }
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("interrupts running turns before clearing sessions in stopAll", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener(
              "abort",
              () => {
                controller.close();
              },
              { once: true },
            );
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
        },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-stop-all");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "full-access",
          });

          const completionFiber = yield* Effect.forkScoped(
            Stream.runHead(
              adapter.streamEvents.pipe(
                Stream.filter(
                  (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
                    event.type === "turn.completed",
                ),
              ),
            ),
          );
          yield* Effect.sleep("10 millis");

          yield* adapter.sendTurn({
            threadId,
            input: "Stop all sessions.",
          });

          yield* adapter.stopAll();

          const completed = yield* Fiber.join(completionFiber);
          assert.equal(completed._tag, "Some");
          if (completed._tag === "Some") {
            assert.equal(completed.value.type, "turn.completed");
            assert.equal(completed.value.payload.state, "interrupted");
          }

          const sessions = yield* adapter.listSessions();
          assert.equal(sessions.length, 0);
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("forwards Shiori reasoning settings and emits reasoning lifecycle events", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(bodyToString(init?.body)));
      return responseFromChunks([
        { type: "reasoning-start", id: "reasoning-1" },
        { type: "reasoning-delta", id: "reasoning-1", delta: "Comparing adapters." },
        { type: "reasoning-end", id: "reasoning-1" },
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "Root cause found." },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: "stop",
        },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-reasoning");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          const eventsFiber = yield* Effect.forkScoped(
            Stream.runCollect(adapter.streamEvents.pipe(Stream.take(8))),
          );
          yield* Effect.sleep("10 millis");

          yield* adapter.sendTurn({
            threadId,
            input: "Investigate the missing thinking blocks.",
            modelSelection: {
              provider: "shiori",
              model: "anthropic/claude-sonnet-4.5",
              options: {
                thinking: true,
                reasoningEffort: "high",
              },
            },
          });

          const events = Array.from(yield* Fiber.join(eventsFiber));
          assert.equal(requestBodies.length, 1);
          assert.deepStrictEqual(requestBodies[0]?.model, {
            provider: "shiori",
            modelId: "anthropic/claude-sonnet-4.5",
            settings: {
              reasoningEnabled: true,
              reasoningEffort: "high",
            },
          });
          assert.deepStrictEqual(
            events.map((event) => event.type),
            [
              "turn.started",
              "item.started",
              "content.delta",
              "item.completed",
              "item.started",
              "content.delta",
              "item.completed",
              "turn.completed",
            ],
          );
          assert.equal(events[1]?.type, "item.started");
          if (events[1]?.type === "item.started") {
            assert.equal(events[1].payload.itemType, "reasoning");
            assert.match(String(events[1].itemId), /:reasoning-1$/);
          }
          assert.equal(events[2]?.type, "content.delta");
          if (events[2]?.type === "content.delta") {
            assert.equal(events[2].payload.streamKind, "reasoning_text");
            assert.equal(events[2].payload.delta, "Comparing adapters.");
          }
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("emits separate reasoning item ids for multiple reasoning blocks in one turn", async () => {
    const fetchMock = vi.fn(async () =>
      responseFromChunks([
        { type: "reasoning-start", id: "reasoning-1" },
        { type: "reasoning-delta", id: "reasoning-1", delta: "First block." },
        { type: "reasoning-end", id: "reasoning-1" },
        { type: "reasoning-start", id: "reasoning-2" },
        { type: "reasoning-delta", id: "reasoning-2", delta: "Second block." },
        { type: "reasoning-end", id: "reasoning-2" },
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "Done." },
        { type: "text-end", id: "text-1" },
        { type: "finish", finishReason: "stop" },
      ]),
    );

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-multi-reasoning");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          const eventsFiber = yield* Effect.forkScoped(
            Stream.runCollect(adapter.streamEvents.pipe(Stream.take(10))),
          );
          yield* Effect.sleep("10 millis");

          const turn = yield* adapter.sendTurn({
            threadId,
            input: "Investigate the project.",
          });

          const events = Array.from(yield* Fiber.join(eventsFiber));
          const reasoningStarted = events.filter(
            (event) => event.type === "item.started" && event.payload.itemType === "reasoning",
          );
          const reasoningCompleted = events.filter(
            (event) => event.type === "item.completed" && event.payload.itemType === "reasoning",
          );

          assert.deepStrictEqual(
            reasoningStarted.map((event) => String(event.itemId)),
            [
              `reasoning:${String(turn.turnId)}:reasoning-1`,
              `reasoning:${String(turn.turnId)}:reasoning-2`,
            ],
          );
          assert.deepStrictEqual(
            reasoningCompleted.map((event) => String(event.itemId)),
            [
              `reasoning:${String(turn.turnId)}:reasoning-1`,
              `reasoning:${String(turn.turnId)}:reasoning-2`,
            ],
          );
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("uses plan-mode tools and emits structured plan events in plan mode", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      requestBodies.push(JSON.parse(bodyToString(init?.body)));

      if (callCount === 1) {
        return responseFromChunks([
          {
            type: "tool-input-available",
            toolCallId: "tool-plan-update-1",
            toolName: "update_plan",
            input: {
              explanation: "Collecting the fix steps.",
              plan: [
                { step: "Inspect the Shiori adapter flow", status: "in_progress" },
                { step: "Wire plan events into the UI contract", status: "pending" },
              ],
            },
          },
        ]);
      }

      const secondBody = requestBodies[1];
      const secondMessages = Array.isArray(secondBody?.messages)
        ? (secondBody.messages as Array<Record<string, unknown>>)
        : [];
      const lastAssistantMessage = secondMessages.at(-1);
      const lastParts = Array.isArray(lastAssistantMessage?.parts)
        ? (lastAssistantMessage.parts as Array<Record<string, unknown>>)
        : [];

      assert.equal(lastAssistantMessage?.role, "assistant");
      assert.equal(lastParts[0]?.type, "dynamic-tool");
      assert.equal(lastParts[0]?.toolName, "update_plan");
      assert.equal(lastParts[0]?.state, "output-available");

      return responseFromChunks([
        { type: "text-start", id: "plan-text-1" },
        {
          type: "text-delta",
          id: "plan-text-1",
          delta:
            "# Fix Shiori plan mode\n\n- Inspect the adapter flow\n- Emit structured plan runtime events",
        },
        { type: "text-end", id: "plan-text-1" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-plan-mode");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          const eventsFiber = yield* Effect.forkScoped(
            Stream.runCollect(adapter.streamEvents.pipe(Stream.take(5))),
          );
          yield* Effect.sleep("10 millis");

          yield* adapter.sendTurn({
            threadId,
            input: "Can you create a plan for this?",
            interactionMode: "plan",
          });

          const events = Array.from(yield* Fiber.join(eventsFiber));

          assert.equal(requestBodies.length, 2);
          const firstTools = Array.isArray(requestBodies[0]?.tools)
            ? (requestBodies[0]?.tools as Array<Record<string, unknown>>)
            : [];
          assert.ok(firstTools.some((tool) => tool.name === "update_plan"));
          assert.ok(firstTools.some((tool) => tool.name === "request_user_input"));

          const firstRules = Array.isArray(requestBodies[0]?.workspaceContext?.rules)
            ? (requestBodies[0]?.workspaceContext?.rules as string[])
            : [];
          assert.ok(firstRules.some((rule) => rule.includes("## Plan Mode")));

          assert.deepStrictEqual(
            events.map((event) => event.type),
            [
              "turn.started",
              "turn.plan.updated",
              "turn.proposed.delta",
              "turn.proposed.completed",
              "turn.completed",
            ],
          );

          assert.equal(events[1]?.type, "turn.plan.updated");
          if (events[1]?.type === "turn.plan.updated") {
            assert.equal(events[1].payload.explanation, "Collecting the fix steps.");
            assert.deepStrictEqual(events[1].payload.plan, [
              { step: "Inspect the Shiori adapter flow", status: "inProgress" },
              { step: "Wire plan events into the UI contract", status: "pending" },
            ]);
          }

          assert.equal(events[2]?.type, "turn.proposed.delta");
          if (events[2]?.type === "turn.proposed.delta") {
            assert.match(events[2].payload.delta, /^# Fix Shiori plan mode/);
          }

          assert.equal(events[3]?.type, "turn.proposed.completed");
          if (events[3]?.type === "turn.proposed.completed") {
            assert.match(events[3].payload.planMarkdown, /^# Fix Shiori plan mode/);
          }
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("treats request_user_input as a blocking plan-mode user input tool", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return responseFromChunks([
          {
            type: "tool-input-available",
            toolCallId: "tool-plan-question-1",
            toolName: "request_user_input",
            input: {
              questions: [
                {
                  header: "Scope",
                  id: "scope",
                  question: "How broad should the implementation be?",
                  options: [
                    { label: "Tight", description: "Only fix the bug." },
                    { label: "Broader", description: "Fix it and add guardrails." },
                  ],
                },
              ],
            },
          },
        ]);
      }

      return responseFromChunks([
        { type: "text-start", id: "plan-text-question" },
        {
          type: "text-delta",
          id: "plan-text-question",
          delta: "# Final plan\n\n- Tighten the adapter behavior\n- Verify the plan flow",
        },
        { type: "text-end", id: "plan-text-question" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-plan-question");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          const requestedFiber = yield* Effect.forkScoped(
            Stream.runHead(
              adapter.streamEvents.pipe(
                Stream.filter(
                  (
                    event,
                  ): event is Extract<ProviderRuntimeEvent, { type: "user-input.requested" }> =>
                    event.type === "user-input.requested",
                ),
              ),
            ),
          );
          yield* Effect.sleep("10 millis");

          const completedFiber = yield* Effect.forkScoped(
            Stream.runHead(
              adapter.streamEvents.pipe(
                Stream.filter(
                  (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
                    event.type === "turn.completed",
                ),
              ),
            ),
          );
          yield* Effect.sleep("10 millis");

          yield* adapter.sendTurn({
            threadId,
            input: "Plan the fix and ask me if you need a scope decision.",
            interactionMode: "plan",
          });

          const requested = yield* Fiber.join(requestedFiber);
          assert.equal(requested._tag, "Some");
          assert.equal(requested.value.type, "user-input.requested");
          assert.ok(requested.value.requestId);
          assert.deepStrictEqual(requested.value.payload.questions, [
            {
              id: "scope",
              header: "Scope",
              question: "How broad should the implementation be?",
              options: [
                { label: "Tight", description: "Only fix the bug." },
                { label: "Broader", description: "Fix it and add guardrails." },
              ],
              multiSelect: false,
            },
          ]);

          yield* adapter.respondToUserInput(threadId, requested.value.requestId, {
            scope: "Tight",
          });

          const completed = yield* Fiber.join(completedFiber);
          assert.equal(completed._tag, "Some");
          assert.equal(completed.value.type, "turn.completed");
          assert.equal(callCount, 2);
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("injects configured MCP tools into Shiori turns and executes them locally", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;
    const closeMcpRuntime = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      requestBodies.push(JSON.parse(bodyToString(init?.body)));

      if (callCount === 1) {
        return responseFromChunks([
          {
            type: "tool-input-available",
            toolCallId: "tool-mcp-1",
            toolName: "mcp__demo__lookup_weather",
            input: { city: "Zurich" },
          },
        ]);
      }

      const secondBody = requestBodies[1];
      const secondMessages = Array.isArray(secondBody?.messages)
        ? (secondBody.messages as Array<Record<string, unknown>>)
        : [];
      const lastAssistantMessage = secondMessages.at(-1);
      const lastParts = Array.isArray(lastAssistantMessage?.parts)
        ? (lastAssistantMessage.parts as Array<Record<string, unknown>>)
        : [];

      assert.equal(lastAssistantMessage?.role, "assistant");
      assert.equal(lastParts[0]?.type, "dynamic-tool");
      assert.equal(lastParts[0]?.toolName, "mcp__demo__lookup_weather");
      assert.equal(lastParts[0]?.state, "output-available");
      assert.deepStrictEqual(lastParts[0]?.output, {
        forecast: "Sunny",
        temperatureC: 18,
      });

      return responseFromChunks([
        { type: "text-start", id: "text-mcp" },
        { type: "text-delta", id: "text-mcp", delta: "Forecast captured." },
        { type: "text-end", id: "text-mcp" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    const layer = makeShioriAdapterTestLayer({
      buildMcpToolRuntime: async () => ({
        descriptors: [
          {
            name: "mcp__demo__lookup_weather",
            title: "Demo · lookup_weather",
            description: "Look up the weather for a city.",
            inputSchema: {
              type: "object",
              properties: {
                city: { type: "string" },
              },
              required: ["city"],
              additionalProperties: false,
            },
          },
        ],
        executors: new Map([
          [
            "mcp__demo__lookup_weather",
            {
              title: "Demo · lookup_weather",
              execute: async (input: Record<string, unknown>) => {
                assert.deepStrictEqual(input, { city: "Zurich" });
                return { forecast: "Sunny", temperatureC: 18 };
              },
            },
          ],
        ]),
        warnings: [],
        close: closeMcpRuntime,
      }),
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-mcp");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          const completionFiber = yield* Effect.forkScoped(
            Stream.runHead(
              adapter.streamEvents.pipe(
                Stream.filter(
                  (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
                    event.type === "turn.completed",
                ),
              ),
            ),
          );
          yield* Effect.sleep("10 millis");

          yield* adapter.sendTurn({
            threadId,
            input: "Use the MCP weather tool.",
          });

          const completed = yield* Fiber.join(completionFiber);
          assert.equal(completed._tag, "Some");
          assert.equal(requestBodies.length, 2);

          const firstTools = Array.isArray(requestBodies[0]?.tools)
            ? (requestBodies[0]?.tools as Array<Record<string, unknown>>)
            : [];
          assert.ok(firstTools.some((tool) => tool.name === "mcp__demo__lookup_weather"));
          assert.equal(closeMcpRuntime.mock.calls.length, 1);
        }).pipe(Effect.provide(layer)),
      ),
    );
  });

  it("continues turn execution when MCP runtime initialization fails", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(bodyToString(init?.body)));
      return responseFromChunks([
        { type: "text-start", id: "text-no-mcp" },
        { type: "text-delta", id: "text-no-mcp", delta: "Fallback response." },
        { type: "text-end", id: "text-no-mcp" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    const layer = makeShioriAdapterTestLayer({
      buildMcpToolRuntime: async () => {
        throw new Error("MCP unavailable");
      },
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-mcp-fallback");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "full-access",
          });

          const completionFiber = yield* Effect.forkScoped(
            Stream.runHead(
              adapter.streamEvents.pipe(
                Stream.filter(
                  (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
                    event.type === "turn.completed",
                ),
              ),
            ),
          );
          yield* Effect.sleep("10 millis");

          yield* adapter.sendTurn({
            threadId,
            input: "Proceed even if MCP is unavailable.",
          });

          const completed = yield* Fiber.join(completionFiber);
          assert.equal(completed._tag, "Some");
          assert.equal(completed.value.type, "turn.completed");
          assert.equal(requestBodies.length, 1);

          const requestTools = Array.isArray(requestBodies[0]?.tools)
            ? (requestBodies[0].tools as Array<Record<string, unknown>>)
            : [];
          assert.ok(requestTools.every((tool) => !String(tool.name ?? "").startsWith("mcp__")));
        }).pipe(Effect.provide(layer)),
      ),
    );
  });

  it("runs subagents via spawn/wait and forwards completion notifications to the next turn", async () => {
    const parentRequestBodies: Array<Record<string, unknown>> = [];
    const subagentRequestBodies: Array<Record<string, unknown>> = [];
    let parentCallCount = 0;

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestBody = JSON.parse(bodyToString(init?.body));
      const sessionId =
        typeof requestBody?.sessionId === "string" ? (requestBody.sessionId as string) : "";

      if (sessionId.includes(":subagent")) {
        subagentRequestBodies.push(requestBody);
        return responseFromChunks([
          { type: "text-start", id: `subagent-text-${subagentRequestBodies.length}` },
          {
            type: "text-delta",
            id: `subagent-text-${subagentRequestBodies.length}`,
            delta: "Background review completed.",
          },
          { type: "text-end", id: `subagent-text-${subagentRequestBodies.length}` },
          { type: "finish", finishReason: "stop" },
        ]);
      }

      parentCallCount += 1;
      parentRequestBodies.push(requestBody);

      if (parentCallCount === 1) {
        return responseFromChunks([
          {
            type: "tool-input-available",
            toolCallId: "tool-subagent-spawn-1",
            toolName: "spawn_agent",
            input: {
              task_name: "reviewer",
              message: "Review the changed files and report back.",
              agent_type: "researcher",
            },
          },
        ]);
      }

      if (parentCallCount === 2) {
        return responseFromChunks([
          {
            type: "tool-input-available",
            toolCallId: "tool-subagent-wait-1",
            toolName: "wait_agent",
            input: {
              targets: ["reviewer"],
              timeout_ms: 5_000,
            },
          },
        ]);
      }

      if (parentCallCount === 3) {
        return responseFromChunks([
          { type: "text-start", id: "parent-text-1" },
          { type: "text-delta", id: "parent-text-1", delta: "Subagent completed successfully." },
          { type: "text-end", id: "parent-text-1" },
          { type: "finish", finishReason: "stop" },
        ]);
      }

      return responseFromChunks([
        { type: "text-start", id: "parent-text-2" },
        { type: "text-delta", id: "parent-text-2", delta: "Notification consumed." },
        { type: "text-end", id: "parent-text-2" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-subagents");
          const observedEvents: ProviderRuntimeEvent[] = [];

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          yield* Effect.forkScoped(
            Stream.runForEach(adapter.streamEvents, (event) =>
              Effect.sync(() => {
                observedEvents.push(event);
              }),
            ),
          );
          yield* Effect.sleep("10 millis");

          const firstCompletionFiber = yield* Effect.forkScoped(
            Stream.runHead(
              adapter.streamEvents.pipe(
                Stream.filter(
                  (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
                    event.type === "turn.completed",
                ),
              ),
            ),
          );
          yield* Effect.sleep("10 millis");

          yield* adapter.sendTurn({
            threadId,
            input: "Delegate this task to a teammate and wait for completion.",
          });

          const firstCompletion = yield* Fiber.join(firstCompletionFiber);
          assert.equal(firstCompletion._tag, "Some");

          const secondCompletionFiber = yield* Effect.forkScoped(
            Stream.runHead(
              adapter.streamEvents.pipe(
                Stream.filter(
                  (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
                    event.type === "turn.completed",
                ),
              ),
            ),
          );
          yield* Effect.sleep("10 millis");

          yield* adapter.sendTurn({
            threadId,
            input: "Use any pending subagent updates before answering.",
          });

          const secondCompletion = yield* Fiber.join(secondCompletionFiber);
          assert.equal(secondCompletion._tag, "Some");

          assert.equal(parentRequestBodies.length, 4);
          assert.equal(subagentRequestBodies.length, 1);

          const taskStarted = observedEvents.find((event) => event.type === "task.started");
          const taskCompleted = observedEvents.find(
            (event) => event.type === "task.completed" && event.payload.status === "completed",
          );
          assert.ok(taskStarted);
          assert.ok(taskCompleted);
          if (taskStarted?.type === "task.started") {
            assert.equal(taskStarted.payload.taskType, "researcher");
          }

          const secondTurnMessages = Array.isArray(parentRequestBodies[3]?.messages)
            ? (parentRequestBodies[3]!.messages as Array<Record<string, unknown>>)
            : [];
          const notificationMessage = secondTurnMessages.find(
            (message) =>
              typeof message?.id === "string" &&
              message.id.startsWith("user-subagent-notification-"),
          );
          assert.ok(notificationMessage);
          const notificationParts = Array.isArray(notificationMessage?.parts)
            ? (notificationMessage?.parts as Array<Record<string, unknown>>)
            : [];
          const notificationText =
            typeof notificationParts[0]?.text === "string" ? notificationParts[0].text : "";
          assert.match(notificationText, /<subagent_notification>/);
          assert.match(notificationText, /"agent_path":"reviewer"/);
          assert.match(notificationText, /"status":"completed"/);
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });
});

describe("hosted tools", () => {
  it("anchors the Shiori identity and tool-grounding rules", () => {
    assert.equal(SHIORI_WORKSPACE_RULES.length, 1);
    const [prompt] = SHIORI_WORKSPACE_RULES;
    assert.ok(prompt);
    assert.match(prompt, /^# ShioriCode System Prompt\n/m);
    assert.match(prompt, /^## Identity\n/m);
    assert.match(prompt, /^## Mission\n/m);
    assert.match(prompt, /^## Operating Priorities\n/m);
    assert.match(prompt, /^## Capabilities\n/m);
    assert.match(prompt, /^## Tool Grounding\n/m);
    assert.match(prompt, /^## Tool Use Policy\n/m);
    assert.match(prompt, /^## Coding Behavior\n/m);
    assert.match(prompt, /^## Browser And Desktop Actions\n/m);
    assert.match(prompt, /^## Uncertainty And Honesty\n/m);
    assert.match(prompt, /^## Response Style\n/m);
    assert.match(prompt, /You are ShioriCode/);
    assert.match(prompt, /You are not Codex/);
    assert.ok(prompt.includes("Never contradict a successful tool call"));
    assert.ok(prompt.includes("Do not ask the user to manually perform an action"));
    assert.ok(
      prompt.includes("Use Markdown formatting for normal text responses when it improves clarity"),
    );
    assert.ok(
      prompt.includes(
        "Prefer real Markdown structure such as headings, bullets, numbered lists, tables, and fenced code blocks instead of plain-text pseudo-formatting.",
      ),
    );
  });

  it("builds runtime context rules with machine and local time details", () => {
    const rules = buildShioriWorkspaceRules({
      cwd: "/tmp/project",
      now: new Date("2026-04-04T03:10:05.000Z"),
      hostname: "test-macbook",
      username: "choki",
      platform: "darwin",
      arch: "arm64",
      timeZone: "Europe/Zurich",
    });

    assert.equal(rules.length, 2);
    const runtimePrompt = rules[1];
    assert.ok(runtimePrompt);
    assert.match(runtimePrompt, /^## Runtime Context\n/m);
    assert.ok(runtimePrompt.includes("Local date:"));
    assert.ok(runtimePrompt.includes("Local weekday:"));
    assert.ok(runtimePrompt.includes("Local time:"));
    assert.ok(runtimePrompt.includes("Local timezone: Europe/Zurich"));
    assert.ok(runtimePrompt.includes("Machine hostname: test-macbook"));
    assert.ok(runtimePrompt.includes("Local username: choki"));
    assert.ok(runtimePrompt.includes("Platform: darwin"));
    assert.ok(runtimePrompt.includes("Architecture: arm64"));
    assert.ok(runtimePrompt.includes("Workspace root: /tmp/project"));
  });

  it("adds the selected personality overlay as a separate prompt appendix", () => {
    const rules = buildShioriWorkspaceRules({
      cwd: "/tmp/project",
      personality: "sassy",
    });

    assert.equal(rules.length, 3);
    const personalityPrompt = rules[1];
    assert.ok(personalityPrompt);
    assert.match(personalityPrompt, /^## Personality Overlay\n/m);
    assert.ok(
      personalityPrompt.includes(
        "Apply this as a light tone overlay on top of every other instruction in this prompt.",
      ),
    );
    assert.ok(personalityPrompt.includes("Sound playful, confident, and a little witty."));
    assert.ok(
      personalityPrompt.includes("Aim any sharpness at the situation or code, never at the user."),
    );
  });

  it("registers list_directory as a file-read tool", () => {
    const tools = buildHostedToolDescriptors({
      allowedRequestKinds: new Set(),
      session: {
        runtimeMode: "approval-required",
      } satisfies Pick<ProviderSession, "runtimeMode">,
    });

    const descriptor = tools.find((tool) => tool.name === "list_directory");
    assert.ok(descriptor);
    assert.equal(descriptor.title, "List directory");
    assert.equal(toolRequestKind("list_directory"), "file-read");
    assert.deepStrictEqual(descriptor.inputSchema, {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to the current workspace root. Defaults to '.'.",
        },
      },
      additionalProperties: false,
      "x-shioricode-request-kind": "file-read",
      "x-shioricode-needs-approval": true,
    });
  });

  it("adds plan-mode specific planning tools when the thread is in plan mode", () => {
    const tools = buildHostedToolDescriptors({
      allowedRequestKinds: new Set(),
      session: {
        runtimeMode: "approval-required",
      } satisfies Pick<ProviderSession, "runtimeMode">,
      interactionMode: "plan",
    });

    assert.ok(tools.some((tool) => tool.name === "update_plan"));
    assert.ok(tools.some((tool) => tool.name === "request_user_input"));
  });
});
