// @ts-nocheck
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "contracts";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

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
const TEST_WORKSPACE_ROOT = path.resolve(new URL("../../../../../", import.meta.url).pathname);
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

const emptyMcpToolRuntime = async () => ({
  descriptors: [],
  executors: new Map(),
  warnings: [],
  skillPrompt: undefined,
  close: async () => undefined,
});

const defaultBootstrapProbe = () =>
  Effect.succeed({
    bootstrap: {
      approvalPolicies: {
        fileWrite: "ask",
        shellCommand: "ask",
        destructiveChange: "ask",
        networkCommand: "ask",
        mcpSideEffect: "ask",
        outsideWorkspace: "ask",
      },
      protectedPaths: [
        ".git",
        ".env",
        ".env.*",
        "~/.ssh",
        "~/.aws",
        "~/.config/gcloud",
        "~/.shioricode",
      ],
      browserUse: { enabled: false },
      computerUse: { enabled: false },
      mobileApp: { enabled: false },
      subagents: {
        enabled: true,
        profiles: {
          codex: {
            supported: true,
            tools: ["spawn_agent", "send_input", "wait_agent", "close_agent"],
          },
          claude: {
            supported: true,
            tools: ["agent", "send_message", "wait_agent", "close_agent"],
          },
        },
      },
    },
    message: null,
  });

const shioriAdapterTestLayer = makeShioriAdapterLive({
  buildMcpToolRuntime: emptyMcpToolRuntime,
  buildSkillToolRuntime: emptyMcpToolRuntime,
  fetchBootstrapProbe: defaultBootstrapProbe,
}).pipe(
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
  return makeShioriAdapterLive({
    buildMcpToolRuntime: emptyMcpToolRuntime,
    buildSkillToolRuntime: emptyMcpToolRuntime,
    fetchBootstrapProbe: defaultBootstrapProbe,
    ...options,
  }).pipe(
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

const SAMPLE_WEB_SEARCH_HTML = `
  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a
          rel="nofollow"
          class="result__a"
          href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.cdc.gov%2Fchickenpox%2Ftreatment%2Findex.html&amp;rut=abc"
        >
          How to Treat Chickenpox | Chickenpox (Varicella) | CDC
        </a>
      </h2>
      <div class="result__extras">
        <div class="result__extras__url">
          <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.cdc.gov%2Fchickenpox%2Ftreatment%2Findex.html&amp;rut=abc">
            www.cdc.gov/chickenpox/treatment/index.html
          </a>
        </div>
      </div>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.cdc.gov%2Fchickenpox%2Ftreatment%2Findex.html&amp;rut=abc">
        The best way to prevent <b>chickenpox</b> is to get the <b>chickenpox</b> vaccine.
      </a>
      <div class="clear"></div>
    </div>
  </div>
`;

describe("buildInterruptedTurnEvents", () => {
  it("closes reasoning and assistant items before marking the turn interrupted", () => {
    const events = buildInterruptedTurnEvents({
      threadId: asThreadId("thread-shiori-interrupt"),
      turnId: asTurnId("turn-shiori-interrupt"),
      assistantItemId: asRuntimeItemId("assistant:turn-shiori-interrupt"),
      assistantStarted: true,
      openReasoningItemIds: [asRuntimeItemId("reasoning:turn-shiori-interrupt:reasoning-1")],
      assistantText: "",
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
      assert.equal(assistantCompleted.payload.detail, undefined);
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
      assistantItemId: null,
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

  it("emits session.exited when a Shiori session is stopped", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-session-stop");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "approval-required",
          });

          const exitedFiber = yield* Effect.forkScoped(
            Stream.runHead(
              adapter.streamEvents.pipe(
                Stream.filter(
                  (event): event is Extract<ProviderRuntimeEvent, { type: "session.exited" }> =>
                    event.type === "session.exited",
                ),
              ),
            ),
          );
          yield* Effect.sleep("10 millis");

          yield* adapter.stopSession(threadId);

          const exited = yield* Fiber.join(exitedFiber);
          assert.equal(exited._tag, "Some");
          if (exited._tag === "Some") {
            assert.equal(exited.value.payload.exitKind, "graceful");
            assert.equal(exited.value.payload.reason, "Session stopped.");
            assert.equal(exited.value.payload.recoverable, true);
          }
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("emits turn.started before the hosted request resolves", async () => {
    let resolveResponse: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-start-immediately");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "approval-required",
          });

          const startedFiber = yield* Effect.forkScoped(
            Stream.runHead(
              adapter.streamEvents.pipe(
                Stream.filter(
                  (event): event is Extract<ProviderRuntimeEvent, { type: "turn.started" }> =>
                    event.type === "turn.started",
                ),
              ),
            ),
          );
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
            input: "Please start immediately.",
          });

          const started = yield* Fiber.join(startedFiber);
          assert.equal(started._tag, "Some");
          if (started._tag === "Some") {
            assert.equal(started.value.type, "turn.started");
          }

          expect(fetchMock).toHaveBeenCalledTimes(1);
          assert.ok(resolveResponse);
          resolveResponse?.(
            responseFromChunks([
              {
                type: "finish",
                finishReason: "stop",
              },
            ]),
          );

          const completed = yield* Fiber.join(completedFiber);
          assert.equal(completed._tag, "Some");
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });
});

describe("ShioriAdapterLive session state", () => {
  it("prewarms the local tool runtime at session start and reuses the in-flight load", async () => {
    let resolveRuntime:
      | ((runtime: Awaited<ReturnType<typeof emptyMcpToolRuntime>>) => void)
      | null = null;
    const runtimeReady = new Promise<Awaited<ReturnType<typeof emptyMcpToolRuntime>>>((resolve) => {
      resolveRuntime = resolve;
    });
    const buildMcpToolRuntime = vi.fn(() => runtimeReady);
    const fetchMock = vi.fn(async () =>
      responseFromChunks([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "Ready." },
        { type: "text-end", id: "text-1" },
        { type: "finish", finishReason: "stop" },
      ]),
    );

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-prewarm");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            cwd: TEST_WORKSPACE_ROOT,
            runtimeMode: "approval-required",
          });

          yield* Effect.sleep("100 millis");
          expect(buildMcpToolRuntime).toHaveBeenCalledTimes(1);

          const sendFiber = yield* Effect.forkScoped(
            adapter.sendTurn({
              threadId,
              input: "hello",
            }),
          );

          yield* Effect.sleep("10 millis");
          expect(buildMcpToolRuntime).toHaveBeenCalledTimes(1);
          expect(fetchMock).not.toHaveBeenCalled();

          const runtime = yield* Effect.promise(() => emptyMcpToolRuntime());
          resolveRuntime?.(runtime);

          yield* Fiber.join(sendFiber);
          yield* Effect.sleep("10 millis");

          expect(buildMcpToolRuntime).toHaveBeenCalledTimes(1);
          expect(fetchMock).toHaveBeenCalledTimes(1);
        }).pipe(
          Effect.provide(
            makeShioriAdapterTestLayer({
              buildMcpToolRuntime,
              buildSkillToolRuntime: emptyMcpToolRuntime,
            }),
          ),
        ),
      ),
    );
  });

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
            cwd: TEST_WORKSPACE_ROOT,
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

  it("does not recurse when the hosted provider already executed the tool successfully", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let hostedCallCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      hostedCallCount += 1;
      requestBodies.push(JSON.parse(bodyToString(init?.body)));

      return responseFromChunks([
        {
          type: "tool-input-available",
          toolCallId: "tool-hosted-success-1",
          toolName: "read_file",
          input: { path: "docs/plan.md" },
          providerExecuted: true,
        },
        {
          type: "tool-output-available",
          toolCallId: "tool-hosted-success-1",
          output: {
            path: "docs/plan.md",
            content: "# Hosted plan\n\nUse the API result directly.",
          },
          providerExecuted: true,
        },
        { type: "text-start", id: "text-hosted-success-1" },
        {
          type: "text-delta",
          id: "text-hosted-success-1",
          delta: "Used the hosted tool result directly.",
        },
        { type: "text-end", id: "text-hosted-success-1" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-hosted-tool-success");

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
            input: "Use the hosted tool result if it is already there.",
          });

          const completed = yield* Fiber.join(completionFiber);
          assert.equal(completed._tag, "Some");
          assert.equal(hostedCallCount, 1);

          const session = (yield* adapter.listSessions())[0];
          const resumeCursor = session?.resumeCursor as
            | {
                messages?: Array<{
                  role?: string;
                  parts?: Array<Record<string, unknown>>;
                }>;
              }
            | undefined;
          const lastAssistantMessage = resumeCursor?.messages?.at(-1);
          const lastParts = Array.isArray(lastAssistantMessage?.parts)
            ? lastAssistantMessage.parts
            : [];
          const toolPart = lastParts.find(
            (part) => part?.type === "dynamic-tool" && part.toolCallId === "tool-hosted-success-1",
          );

          assert.equal(lastAssistantMessage?.role, "assistant");
          assert.equal(toolPart?.state, "output-available");
          assert.deepStrictEqual(toolPart?.output, {
            path: "docs/plan.md",
            content: "# Hosted plan\n\nUse the API result directly.",
          });
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("does not recurse when the hosted provider already returned a tool failure", async () => {
    let hostedCallCount = 0;
    const fetchMock = vi.fn(async () => {
      hostedCallCount += 1;
      return responseFromChunks([
        {
          type: "tool-input-available",
          toolCallId: "tool-hosted-error-1",
          toolName: "read_file",
          input: { path: "missing-from-hosted-runtime.md" },
          providerExecuted: true,
        },
        {
          type: "tool-output-error",
          toolCallId: "tool-hosted-error-1",
          errorText: "Hosted runtime could not read the file.",
          providerExecuted: true,
        },
        { type: "text-start", id: "text-hosted-error-1" },
        {
          type: "text-delta",
          id: "text-hosted-error-1",
          delta: "The hosted tool failed, so I am reporting the error directly.",
        },
        { type: "text-end", id: "text-hosted-error-1" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-hosted-tool-error");

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
            input: "Report hosted tool failures directly.",
          });

          const completed = yield* Fiber.join(completionFiber);
          assert.equal(completed._tag, "Some");
          assert.equal(hostedCallCount, 1);

          const session = (yield* adapter.listSessions())[0];
          const resumeCursor = session?.resumeCursor as
            | {
                messages?: Array<{
                  role?: string;
                  parts?: Array<Record<string, unknown>>;
                }>;
              }
            | undefined;
          const lastAssistantMessage = resumeCursor?.messages?.at(-1);
          const lastParts = Array.isArray(lastAssistantMessage?.parts)
            ? lastAssistantMessage.parts
            : [];
          const toolPart = lastParts.find(
            (part) => part?.type === "dynamic-tool" && part.toolCallId === "tool-hosted-error-1",
          );

          assert.equal(lastAssistantMessage?.role, "assistant");
          assert.equal(toolPart?.state, "output-error");
          assert.equal(toolPart?.errorText, "Hosted runtime could not read the file.");
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("emits separate assistant items for successive hosted text blocks", async () => {
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

      return responseFromChunks([
        { type: "text-start", id: "text-2" },
        { type: "text-delta", id: "text-2", delta: "After tool." },
        { type: "text-end", id: "text-2" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-text-blocks");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "full-access",
          });

          const eventsFiber = yield* Effect.forkScoped(
            Stream.runCollect(adapter.streamEvents.pipe(Stream.take(10))),
          );
          yield* Effect.sleep("10 millis");

          const turn = yield* adapter.sendTurn({
            threadId,
            input: "Inspect the repo and continue.",
          });

          const events = Array.from(yield* Fiber.join(eventsFiber));
          const assistantCompletions = events.filter(
            (event) =>
              event.type === "item.completed" && event.payload.itemType === "assistant_message",
          );

          assert.deepStrictEqual(
            assistantCompletions.map((event) => String(event.itemId)),
            [`assistant:${String(turn.turnId)}:text-1`, `assistant:${String(turn.turnId)}:text-2`],
          );
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
              "I'll start by exploring the workspace structure, then launch a team of background agents to explore different parts of the app.",
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
          const assistantText = events
            .filter(
              (event) =>
                event.type === "content.delta" && event.payload.streamKind === "assistant_text",
            )
            .map((event) => event.payload.delta)
            .join("");

          assert.equal(requestBodies.length, 2);
          assert.ok(commentaryEvent);
          assert.match(
            String(commentaryEvent?.payload.detail ?? ""),
            /I'll start by exploring the workspace structure/i,
          );
          assert.equal(assistantText, "Here is the final answer.");
          assert.ok(!assistantText.includes("I'll start"));
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("treats pre-tool web-search narration as commentary instead of assistant output", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      requestBodies.push(JSON.parse(bodyToString(init?.body)));

      if (callCount === 1) {
        return responseFromChunks([
          { type: "text-start", id: "text-web-commentary-1" },
          {
            type: "text-delta",
            id: "text-web-commentary-1",
            delta: "I'll search the web for information about treating chicken pox.",
          },
          {
            type: "tool-input-available",
            toolCallId: "tool-web-commentary-1",
            toolName: "web_search",
            input: {
              query: "best way to get rid of chicken pox treatment",
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
      assert.equal(lastParts[0]?.toolName, "web_search");

      return responseFromChunks([
        { type: "text-start", id: "text-web-commentary-2" },
        {
          type: "text-delta",
          id: "text-web-commentary-2",
          delta: "The CDC recommends supportive care and vaccination for prevention.",
        },
        { type: "text-end", id: "text-web-commentary-2" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-web-commentary");

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
            input: "Search the web for the best way to get rid of chicken pox.",
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
          const assistantText = events
            .filter(
              (event) =>
                event.type === "content.delta" && event.payload.streamKind === "assistant_text",
            )
            .map((event) => event.payload.delta)
            .join("");

          assert.ok(commentaryEvent);
          assert.match(
            String(commentaryEvent?.payload.detail ?? ""),
            /I'll search the web for information about treating chicken pox\./i,
          );
          assert.equal(
            assistantText,
            "The CDC recommends supportive care and vaccination for prevention.",
          );
          assert.ok(!assistantText.includes("I'll search the web"));
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("emits hosted tool lifecycle events before the next step's assistant text", async () => {
    const fetchMock = vi.fn(async () =>
      responseFromChunks([
        {
          type: "tool-input-available",
          toolCallId: "tool-wait-internal-1",
          toolName: "wait_for_response",
          input: { phase: "preflight" },
        },
        {
          type: "tool-output-available",
          toolCallId: "tool-wait-internal-1",
          output: { phase: "ready" },
        },
        { type: "finish-step" },
        { type: "start-step" },
        {
          type: "tool-input-available",
          toolCallId: "tool-live-web-search-1",
          toolName: "web_search",
          input: { query: "chicken pox treatment" },
        },
        {
          type: "tool-output-available",
          toolCallId: "tool-live-web-search-1",
          output: {
            provider: "duckduckgo",
            query: "chicken pox treatment",
            results: [],
          },
        },
        { type: "finish-step" },
        { type: "start-step" },
        { type: "text-start", id: "text-live-web-search-1" },
        {
          type: "text-delta",
          id: "text-live-web-search-1",
          delta: "The best protection is vaccination.",
        },
        { type: "text-end", id: "text-live-web-search-1" },
        { type: "finish-step" },
        { type: "finish", finishReason: "stop" },
      ]),
    );

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-live-web-search-order");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "full-access",
          });

          const eventsFiber = yield* Effect.forkScoped(
            Stream.runCollect(
              adapter.streamEvents.pipe(
                Stream.filter(
                  (event) =>
                    (event.type === "item.started" &&
                      event.payload.itemType === "web_search" &&
                      String(event.itemId) === "tool:tool-live-web-search-1") ||
                    (event.type === "item.completed" &&
                      event.payload.itemType === "web_search" &&
                      String(event.itemId) === "tool:tool-live-web-search-1") ||
                    (event.type === "content.delta" &&
                      event.payload.streamKind === "assistant_text" &&
                      event.payload.delta === "The best protection is vaccination.") ||
                    event.type === "turn.completed",
                ),
                Stream.take(4),
              ),
            ),
          );
          yield* Effect.sleep("10 millis");

          yield* adapter.sendTurn({
            threadId,
            input: "Search the web and answer inline.",
          });

          const events = Array.from(yield* Fiber.join(eventsFiber));
          const internalWaitEvents = events.filter(
            (event) =>
              (event.type === "item.started" || event.type === "item.completed") &&
              String(event.itemId) === "tool:tool-wait-internal-1",
          );
          const toolStartedIndex = events.findIndex(
            (event) =>
              event.type === "item.started" &&
              event.payload.itemType === "web_search" &&
              String(event.itemId) === "tool:tool-live-web-search-1",
          );
          const toolCompletedIndex = events.findIndex(
            (event) =>
              event.type === "item.completed" &&
              event.payload.itemType === "web_search" &&
              String(event.itemId) === "tool:tool-live-web-search-1",
          );
          const toolStartedEvent = events.find(
            (event) =>
              event.type === "item.started" &&
              event.payload.itemType === "web_search" &&
              String(event.itemId) === "tool:tool-live-web-search-1",
          );
          const toolCompletedEvent = events.find(
            (event) =>
              event.type === "item.completed" &&
              event.payload.itemType === "web_search" &&
              String(event.itemId) === "tool:tool-live-web-search-1",
          );
          const assistantDeltaIndex = events.findIndex(
            (event) =>
              event.type === "content.delta" &&
              event.payload.streamKind === "assistant_text" &&
              event.payload.delta === "The best protection is vaccination.",
          );

          assert.equal(internalWaitEvents.length, 0);
          assert.notEqual(toolStartedIndex, -1);
          assert.notEqual(toolCompletedIndex, -1);
          assert.notEqual(assistantDeltaIndex, -1);
          assert.ok(toolStartedIndex < assistantDeltaIndex);
          assert.ok(toolCompletedIndex < assistantDeltaIndex);
          assert.equal(toolStartedEvent?.payload.detail, "chicken pox treatment");
          assert.equal(toolCompletedEvent?.payload.detail, "chicken pox treatment");
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("streams visible hosted text deltas before the text block ends", async () => {
    const fetchMock = vi.fn(async () =>
      responseFromChunks([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "Visible " },
        { type: "text-delta", id: "text-1", delta: "answer." },
        { type: "text-end", id: "text-1" },
        { type: "finish", finishReason: "stop" },
      ]),
    );

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-live-deltas");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "full-access",
          });

          const eventsFiber = yield* Effect.forkScoped(
            Stream.runCollect(adapter.streamEvents.pipe(Stream.take(6))),
          );
          yield* Effect.sleep("10 millis");

          yield* adapter.sendTurn({
            threadId,
            input: "Answer directly.",
          });

          const events = Array.from(yield* Fiber.join(eventsFiber));
          const assistantDeltas = events.filter(
            (event) =>
              event.type === "content.delta" && event.payload.streamKind === "assistant_text",
          );

          assert.deepStrictEqual(
            assistantDeltas.map((event) => event.payload.delta),
            ["Visible ", "answer."],
          );
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("reuses the session tool runtime across turns and closes it when the session stops", async () => {
    const mcpClose = vi.fn(async () => undefined);
    const skillClose = vi.fn(async () => undefined);
    const buildMcpToolRuntime = vi.fn(async () => ({
      descriptors: [],
      executors: new Map(),
      warnings: [],
      close: mcpClose,
    }));
    const buildSkillToolRuntime = vi.fn(async () => ({
      descriptors: [],
      executors: new Map(),
      warnings: [],
      skillPrompt: undefined,
      close: skillClose,
    }));
    const fetchMock = vi.fn(async () =>
      responseFromChunks([
        { type: "text-start", id: "text-runtime-cache" },
        { type: "text-delta", id: "text-runtime-cache", delta: "ok" },
        { type: "text-end", id: "text-runtime-cache" },
        { type: "finish", finishReason: "stop" },
      ]),
    );

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-runtime-cache");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            cwd: TEST_WORKSPACE_ROOT,
            runtimeMode: "full-access",
          });

          const waitForReady = Effect.fn("waitForReady")(function* () {
            for (let attempt = 0; attempt < 50; attempt += 1) {
              const session = (yield* adapter.listSessions()).find(
                (candidate) => candidate.threadId === threadId,
              );
              if (session?.status === "ready") {
                return;
              }
              yield* Effect.sleep("10 millis");
            }
            assert.fail("Timed out waiting for the Shiori session to become ready.");
          });

          yield* adapter.sendTurn({
            threadId,
            input: "First turn.",
          });
          yield* waitForReady();

          yield* adapter.sendTurn({
            threadId,
            input: "Second turn.",
          });
          yield* waitForReady();

          yield* adapter.stopSession(threadId);

          assert.equal(buildMcpToolRuntime.mock.calls.length, 1);
          assert.equal(buildSkillToolRuntime.mock.calls.length, 1);
          assert.equal(mcpClose.mock.calls.length, 1);
          assert.equal(skillClose.mock.calls.length, 1);
        }).pipe(
          Effect.provide(
            makeShioriAdapterTestLayer({
              buildMcpToolRuntime,
              buildSkillToolRuntime,
            }),
          ),
        ),
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
            cwd: TEST_WORKSPACE_ROOT,
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

  it("restores pending approval requests from the resume cursor and continues after restart", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      requestBodies.push(JSON.parse(bodyToString(init?.body)));

      if (callCount === 1) {
        return responseFromChunks([
          {
            type: "tool-input-available",
            toolCallId: "tool-approval-resume-1",
            toolName: "read_file",
            input: { path: "missing-after-restart.txt" },
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
        { type: "text-start", id: "text-approved-restart" },
        {
          type: "text-delta",
          id: "text-approved-restart",
          delta: "Recovered after restart.",
        },
        { type: "text-end", id: "text-approved-restart" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-approved-tool-restart");

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
            input: "Read the file after restart approval.",
          });

          const approval = yield* Fiber.join(approvalFiber);
          assert.equal(approval._tag, "Some");
          assert.equal(approval.value.type, "request.opened");

          const resumeCursor = (yield* adapter.listSessions())[0]?.resumeCursor;
          assert.ok(resumeCursor);

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "approval-required",
            resumeCursor,
          });

          const restoredSession = (yield* adapter.listSessions())[0];
          assert.equal(restoredSession?.status, "running");

          yield* adapter.respondToRequest(threadId, approval.value.requestId, "accept");

          const completed = yield* Fiber.join(completionFiber);
          assert.equal(completed._tag, "Some");
          assert.equal(callCount, 2);
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("processes every tool call emitted in a single hosted step before resuming", async () => {
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "shiori-adapter-tools-"));
    writeFileSync(path.join(workspaceRoot, "README.md"), "hello from readme\n", "utf8");
    writeFileSync(path.join(workspaceRoot, "package.json"), '{"name":"fixture"}\n', "utf8");
    const requestBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      requestBodies.push(JSON.parse(bodyToString(init?.body)));

      if (callCount === 1) {
        return responseFromChunks([
          {
            type: "tool-input-available",
            toolCallId: "tool-batch-1",
            toolName: "read_file",
            input: { path: "README.md" },
          },
          {
            type: "tool-input-available",
            toolCallId: "tool-batch-2",
            toolName: "read_file",
            input: { path: "package.json" },
          },
        ]);
      }

      return responseFromChunks([
        { type: "text-start", id: "text-batch-finished" },
        { type: "text-delta", id: "text-batch-finished", delta: "Finished both tools." },
        { type: "text-end", id: "text-batch-finished" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* ShioriAdapter;
            const threadId = asThreadId("thread-shiori-multi-tool-step");

            yield* adapter.startSession({
              provider: "shiori",
              threadId,
              cwd: workspaceRoot,
              runtimeMode: "full-access",
            });

            yield* adapter.sendTurn({
              threadId,
              input: "Inspect the workspace and then read the README.",
            });

            for (let attempt = 0; attempt < 50 && requestBodies.length < 2; attempt += 1) {
              yield* Effect.sleep("10 millis");
            }
            assert.equal(callCount, 2);

            const secondMessages = Array.isArray(requestBodies[1]?.messages)
              ? (requestBodies[1].messages as Array<Record<string, unknown>>)
              : [];
            const lastAssistantMessage = secondMessages.at(-1);
            const lastParts = Array.isArray(lastAssistantMessage?.parts)
              ? (lastAssistantMessage.parts as Array<Record<string, unknown>>)
              : [];
            const toolParts = lastParts.filter((part) => part.type === "dynamic-tool");

            assert.equal(toolParts.length, 2);
            assert.deepStrictEqual(
              toolParts.map((part) => part.toolCallId),
              ["tool-batch-1", "tool-batch-2"],
            );
            assert.deepStrictEqual(
              toolParts.map((part) => part.state),
              ["output-available", "output-available"],
            );

            yield* adapter.stopSession(threadId);
          }).pipe(Effect.provide(shioriAdapterTestLayer)),
        ),
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("executes hosted web_search tool calls and replays the results into the next step", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let hostedCallCount = 0;
    let searchCallCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (requestUrl.startsWith("https://duckduckgo.com/html/")) {
        searchCallCount += 1;
        return new Response(SAMPLE_WEB_SEARCH_HTML, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      hostedCallCount += 1;
      requestBodies.push(JSON.parse(bodyToString(init?.body)));

      if (hostedCallCount === 1) {
        return responseFromChunks([
          {
            type: "tool-input-available",
            toolCallId: "tool-web-search-1",
            toolName: "web_search",
            input: { query: "chicken pox treatment" },
          },
        ]);
      }

      const secondMessages = Array.isArray(requestBodies[1]?.messages)
        ? (requestBodies[1].messages as Array<Record<string, unknown>>)
        : [];
      const lastAssistantMessage = secondMessages.at(-1);
      const lastParts = Array.isArray(lastAssistantMessage?.parts)
        ? (lastAssistantMessage.parts as Array<Record<string, unknown>>)
        : [];
      const toolPart = lastParts.find((part) => part?.type === "dynamic-tool");

      assert.equal(toolPart?.toolName, "web_search");
      assert.equal(toolPart?.state, "output-available");
      assert.equal(toolPart?.output?.provider, "duckduckgo");
      assert.equal(toolPart?.output?.query, "chicken pox treatment");
      assert.deepStrictEqual(toolPart?.output?.results, [
        {
          title: "How to Treat Chickenpox | Chickenpox (Varicella) | CDC",
          url: "https://www.cdc.gov/chickenpox/treatment/index.html",
          snippet: "The best way to prevent chickenpox is to get the chickenpox vaccine.",
          displayUrl: "www.cdc.gov/chickenpox/treatment/index.html",
        },
      ]);

      return responseFromChunks([
        { type: "text-start", id: "text-web-search-finished" },
        { type: "text-delta", id: "text-web-search-finished", delta: "Search completed." },
        { type: "text-end", id: "text-web-search-finished" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-web-search");

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
            input: "Search the web for the best way to get rid of chicken pox.",
          });

          const completed = yield* Fiber.join(completionFiber);
          assert.equal(completed._tag, "Some");
          assert.equal(completed.value.type, "turn.completed");
          assert.equal(hostedCallCount, 2);
          assert.equal(searchCallCount, 1);
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("waits for all approval requests from the same hosted step before resuming", async () => {
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "shiori-adapter-approvals-"));
    writeFileSync(path.join(workspaceRoot, "README.md"), "hello from readme\n", "utf8");
    writeFileSync(path.join(workspaceRoot, "package.json"), '{"name":"fixture"}\n', "utf8");
    const requestBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      requestBodies.push(JSON.parse(bodyToString(init?.body)));

      if (callCount === 1) {
        return responseFromChunks([
          {
            type: "tool-input-available",
            toolCallId: "tool-approval-batch-1",
            toolName: "read_file",
            input: { path: "README.md" },
          },
          {
            type: "tool-input-available",
            toolCallId: "tool-approval-batch-2",
            toolName: "read_file",
            input: { path: "package.json" },
          },
        ]);
      }

      return responseFromChunks([
        { type: "text-start", id: "text-approval-batch-finished" },
        {
          type: "text-delta",
          id: "text-approval-batch-finished",
          delta: "Finished the approved reads.",
        },
        { type: "text-end", id: "text-approval-batch-finished" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* ShioriAdapter;
            const threadId = asThreadId("thread-shiori-approval-batch");

            yield* adapter.startSession({
              provider: "shiori",
              threadId,
              cwd: workspaceRoot,
              runtimeMode: "approval-required",
            });

            const approvalsFiber = yield* Effect.forkScoped(
              Stream.runCollect(
                adapter.streamEvents.pipe(
                  Stream.filter(
                    (event): event is Extract<ProviderRuntimeEvent, { type: "request.opened" }> =>
                      event.type === "request.opened",
                  ),
                  Stream.take(2),
                ),
              ),
            );
            yield* Effect.sleep("10 millis");

            yield* adapter.sendTurn({
              threadId,
              input: "Read the README and inspect the root after approval.",
            });

            const approvals = Array.from(yield* Fiber.join(approvalsFiber));
            assert.equal(approvals.length, 2);

            yield* adapter.respondToRequest(threadId, approvals[0]!.requestId, "accept");
            assert.equal(callCount, 1);

            const pendingSession = (yield* adapter.listSessions())[0];
            const pendingResumeCursor = pendingSession?.resumeCursor as
              | {
                  runtime?: {
                    pendingApprovals?: Array<Record<string, unknown>>;
                  };
                  messages?: Array<Record<string, unknown>>;
                }
              | undefined;
            assert.equal(pendingResumeCursor?.runtime?.pendingApprovals?.length, 1);

            const pendingAssistantMessage = pendingResumeCursor?.messages?.at(-1);
            const pendingParts = Array.isArray(pendingAssistantMessage?.parts)
              ? (pendingAssistantMessage.parts as Array<Record<string, unknown>>)
              : [];
            const pendingToolParts = pendingParts.filter((part) => part.type === "dynamic-tool");
            assert.deepStrictEqual(
              pendingToolParts.map((part) => part.state),
              ["output-available", "approval-requested"],
            );

            yield* adapter.respondToRequest(threadId, approvals[1]!.requestId, "accept");

            for (let attempt = 0; attempt < 50 && requestBodies.length < 2; attempt += 1) {
              yield* Effect.sleep("10 millis");
            }
            assert.equal(callCount, 2);

            const secondMessages = Array.isArray(requestBodies[1]?.messages)
              ? (requestBodies[1].messages as Array<Record<string, unknown>>)
              : [];
            const lastAssistantMessage = secondMessages.at(-1);
            const lastParts = Array.isArray(lastAssistantMessage?.parts)
              ? (lastAssistantMessage.parts as Array<Record<string, unknown>>)
              : [];
            const toolParts = lastParts.filter((part) => part.type === "dynamic-tool");

            assert.equal(toolParts.length, 2);
            assert.deepStrictEqual(
              toolParts.map((part) => part.state),
              ["output-available", "output-available"],
            );

            yield* adapter.stopSession(threadId);
          }).pipe(Effect.provide(shioriAdapterTestLayer)),
        ),
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
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

  it("emits file_change approval on edit resolution", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return responseFromChunks([
          {
            type: "tool-input-available",
            toolCallId: "tool-edit-1",
            toolName: "edit",
            input: {
              patch: "*** Begin Patch\n*** Update File: notes.txt\n@@\n-old\n+new\n*** End Patch\n",
            },
          },
        ]);
      }

      return responseFromChunks([
        { type: "text-start", id: "text-patch" },
        { type: "text-delta", id: "text-patch", delta: "Applied the patch." },
        { type: "text-end", id: "text-patch" },
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
          const threadId = asThreadId("thread-shiori-edit");

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
            input: "Edit the file after approval.",
          });

          const approval = yield* Fiber.join(approvalFiber);
          assert.equal(approval._tag, "Some");
          assert.equal(approval.value.type, "request.opened");
          assert.ok(approval.value.requestId);
          assert.equal(approval.value.payload.requestType, "file_change_approval");

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
            modelId: "anthropic/claude-sonnet-4-5",
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

  it("emits separate assistant item ids for multiple text blocks in one turn", async () => {
    const fetchMock = vi.fn(async () =>
      responseFromChunks([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "First block." },
        { type: "text-end", id: "text-1" },
        { type: "text-start", id: "text-2" },
        { type: "text-delta", id: "text-2", delta: "Second block." },
        { type: "text-end", id: "text-2" },
        { type: "finish", finishReason: "stop" },
      ]),
    );

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-multi-text");

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

          const turn = yield* adapter.sendTurn({
            threadId,
            input: "Explain the repo.",
          });

          const events = Array.from(yield* Fiber.join(eventsFiber));
          const assistantStarted = events.filter(
            (event) =>
              event.type === "item.started" && event.payload.itemType === "assistant_message",
          );
          const assistantCompleted = events.filter(
            (event) =>
              event.type === "item.completed" && event.payload.itemType === "assistant_message",
          );

          assert.deepStrictEqual(
            assistantStarted.map((event) => String(event.itemId)),
            [`assistant:${String(turn.turnId)}:text-1`, `assistant:${String(turn.turnId)}:text-2`],
          );
          assert.deepStrictEqual(
            assistantCompleted.map((event) => String(event.itemId)),
            [`assistant:${String(turn.turnId)}:text-1`, `assistant:${String(turn.turnId)}:text-2`],
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

  it("restores pending user-input requests from the resume cursor and continues after restart", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return responseFromChunks([
          {
            type: "tool-input-available",
            toolCallId: "tool-plan-question-restart-1",
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
        { type: "text-start", id: "plan-text-question-restart" },
        {
          type: "text-delta",
          id: "plan-text-question-restart",
          delta: "# Final plan after restart\n\n- Tighten the adapter behavior",
        },
        { type: "text-end", id: "plan-text-question-restart" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-plan-question-restart");

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
            input: "Plan the fix and pause for scope input.",
            interactionMode: "plan",
          });

          const requested = yield* Fiber.join(requestedFiber);
          assert.equal(requested._tag, "Some");
          assert.equal(requested.value.type, "user-input.requested");

          const resumeCursor = (yield* adapter.listSessions())[0]?.resumeCursor;
          assert.ok(resumeCursor);

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "full-access",
            resumeCursor,
          });

          const restoredSession = (yield* adapter.listSessions())[0];
          assert.equal(restoredSession?.status, "running");

          yield* adapter.respondToUserInput(threadId, requested.value.requestId, {
            scope: "Tight",
          });

          const completed = yield* Fiber.join(completedFiber);
          assert.equal(completed._tag, "Some");
          assert.equal(callCount, 2);
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("truncates large exec_command output before replaying it into the next hosted step", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      requestBodies.push(JSON.parse(bodyToString(init?.body)));

      if (callCount === 1) {
        return responseFromChunks([
          {
            type: "tool-input-available",
            toolCallId: "tool-large-command",
            toolName: "exec_command",
            input: {
              command: `node -e "process.stdout.write('x'.repeat(13050))"`,
            },
          },
        ]);
      }

      return responseFromChunks([
        { type: "text-start", id: "text-command-truncated" },
        {
          type: "text-delta",
          id: "text-command-truncated",
          delta: "Handled the command output.",
        },
        { type: "text-end", id: "text-command-truncated" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-large-command-output");

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            cwd: TEST_WORKSPACE_ROOT,
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
            input: "Run the command and continue.",
          });

          const completed = yield* Fiber.join(completionFiber);
          assert.equal(completed._tag, "Some");
          assert.equal(requestBodies.length, 2);

          const secondMessages = Array.isArray(requestBodies[1]?.messages)
            ? (requestBodies[1].messages as Array<Record<string, unknown>>)
            : [];
          const lastAssistantMessage = secondMessages.at(-1);
          const lastParts = Array.isArray(lastAssistantMessage?.parts)
            ? (lastAssistantMessage.parts as Array<Record<string, unknown>>)
            : [];
          const toolPart = lastParts.find(
            (part) => part?.type === "dynamic-tool" && part.toolCallId === "tool-large-command",
          ) as Record<string, unknown> | undefined;
          const outputRecord =
            toolPart?.output && typeof toolPart.output === "object"
              ? (toolPart.output as Record<string, unknown>)
              : null;
          const stdout = typeof outputRecord?.stdout === "string" ? outputRecord.stdout : "";

          assert.ok(stdout.length < 13_050);
          assert.match(stdout, /\[truncated \d+ chars\]/);
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

          yield* adapter.stopSession(threadId);
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

  it("restores completed subagents across session restart so wait_agent can still resolve them", async () => {
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
          { type: "text-start", id: `subagent-restore-text-${subagentRequestBodies.length}` },
          {
            type: "text-delta",
            id: `subagent-restore-text-${subagentRequestBodies.length}`,
            delta: "Background review completed.",
          },
          { type: "text-end", id: `subagent-restore-text-${subagentRequestBodies.length}` },
          { type: "finish", finishReason: "stop" },
        ]);
      }

      parentCallCount += 1;
      parentRequestBodies.push(requestBody);

      if (parentCallCount === 1) {
        return responseFromChunks([
          {
            type: "tool-input-available",
            toolCallId: "tool-subagent-spawn-restore-1",
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
          { type: "text-start", id: "parent-restore-text-1" },
          {
            type: "text-delta",
            id: "parent-restore-text-1",
            delta: "Spawned the reviewer.",
          },
          { type: "text-end", id: "parent-restore-text-1" },
          { type: "finish", finishReason: "stop" },
        ]);
      }

      if (parentCallCount === 3) {
        return responseFromChunks([
          {
            type: "tool-input-available",
            toolCallId: "tool-subagent-wait-restore-1",
            toolName: "wait_agent",
            input: {
              targets: ["reviewer"],
              timeout_ms: 5_000,
            },
          },
        ]);
      }

      const messages = Array.isArray(requestBody?.messages)
        ? (requestBody.messages as Array<Record<string, unknown>>)
        : [];
      const lastAssistantMessage = messages.at(-1);
      const lastParts = Array.isArray(lastAssistantMessage?.parts)
        ? (lastAssistantMessage.parts as Array<Record<string, unknown>>)
        : [];
      const dynamicToolPart = lastParts.find((part) => part?.type === "dynamic-tool");

      assert.equal(lastAssistantMessage?.role, "assistant");
      assert.equal(dynamicToolPart?.state, "output-available");
      assert.deepStrictEqual(dynamicToolPart?.output?.statuses, [
        {
          target: "reviewer",
          id: dynamicToolPart?.output?.statuses?.[0]?.id,
          task_name: "reviewer",
          status: "completed",
          summary: "Background review completed.",
        },
      ]);

      return responseFromChunks([
        { type: "text-start", id: "parent-restore-text-2" },
        {
          type: "text-delta",
          id: "parent-restore-text-2",
          delta: "Recovered the reviewer state after restart.",
        },
        { type: "text-end", id: "parent-restore-text-2" },
        { type: "finish", finishReason: "stop" },
      ]);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-subagents-restore");

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

          const firstCompletionFiber = yield* waitForCompletion();
          yield* Effect.sleep("10 millis");
          yield* adapter.sendTurn({
            threadId,
            input: "Delegate this task to the reviewer.",
          });
          const firstCompleted = yield* Fiber.join(firstCompletionFiber);
          assert.equal(firstCompleted._tag, "Some");

          for (let attempt = 0; attempt < 50 && subagentRequestBodies.length < 1; attempt += 1) {
            yield* Effect.sleep("10 millis");
          }
          assert.equal(subagentRequestBodies.length, 1);

          let resumeCursor = (yield* adapter.listSessions())[0]?.resumeCursor as
            | {
                runtime?: {
                  subagents?: Array<Record<string, unknown>>;
                };
              }
            | undefined;
          for (
            let attempt = 0;
            attempt < 50 && (resumeCursor?.runtime?.subagents?.length ?? 0) === 0;
            attempt += 1
          ) {
            yield* Effect.sleep("10 millis");
            resumeCursor = (yield* adapter.listSessions())[0]?.resumeCursor as
              | {
                  runtime?: {
                    subagents?: Array<Record<string, unknown>>;
                  };
                }
              | undefined;
          }
          assert.ok(resumeCursor);
          assert.equal(resumeCursor?.runtime?.subagents?.length, 1);

          yield* adapter.stopSession(threadId);
          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
            resumeCursor,
          });

          const secondCompletionFiber = yield* waitForCompletion();
          yield* Effect.sleep("10 millis");
          yield* adapter.sendTurn({
            threadId,
            input: "Wait for the reviewer and summarize what happened.",
          });
          const secondCompleted = yield* Fiber.join(secondCompletionFiber);
          assert.equal(secondCompleted._tag, "Some");

          assert.equal(parentRequestBodies.length, 4);
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("releases closed subagents so later follow-ups fail fast instead of reusing retained state", async () => {
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
          { type: "text-start", id: `subagent-close-text-${subagentRequestBodies.length}` },
          {
            type: "text-delta",
            id: `subagent-close-text-${subagentRequestBodies.length}`,
            delta: "Background review completed.",
          },
          { type: "text-end", id: `subagent-close-text-${subagentRequestBodies.length}` },
          { type: "finish", finishReason: "stop" },
        ]);
      }

      parentCallCount += 1;
      parentRequestBodies.push(requestBody);

      if (parentCallCount === 1) {
        return responseFromChunks([
          {
            type: "tool-input-available",
            toolCallId: "tool-subagent-spawn-close-1",
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
            toolCallId: "tool-subagent-wait-close-1",
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
          { type: "text-start", id: "parent-close-text-1" },
          { type: "text-delta", id: "parent-close-text-1", delta: "Subagent completed." },
          { type: "text-end", id: "parent-close-text-1" },
          { type: "finish", finishReason: "stop" },
        ]);
      }

      if (parentCallCount === 4) {
        return responseFromChunks([
          {
            type: "tool-input-available",
            toolCallId: "tool-subagent-close-1",
            toolName: "close_agent",
            input: {
              target: "reviewer",
            },
          },
        ]);
      }

      if (parentCallCount === 5) {
        return responseFromChunks([
          { type: "text-start", id: "parent-close-text-2" },
          { type: "text-delta", id: "parent-close-text-2", delta: "Subagent closed." },
          { type: "text-end", id: "parent-close-text-2" },
          { type: "finish", finishReason: "stop" },
        ]);
      }

      if (parentCallCount === 6) {
        return responseFromChunks([
          {
            type: "tool-input-available",
            toolCallId: "tool-subagent-send-after-close-1",
            toolName: "send_input",
            input: {
              target: "reviewer",
              message: "Anything else to add?",
            },
          },
        ]);
      }

      if (parentCallCount === 7) {
        const messages = Array.isArray(requestBody?.messages)
          ? (requestBody.messages as Array<Record<string, unknown>>)
          : [];
        const lastAssistantMessage = messages.at(-1);
        const lastParts = Array.isArray(lastAssistantMessage?.parts)
          ? (lastAssistantMessage.parts as Array<Record<string, unknown>>)
          : [];
        const dynamicToolPart = lastParts.find((part) => part?.type === "dynamic-tool");

        assert.equal(lastAssistantMessage?.role, "assistant");
        assert.equal(dynamicToolPart?.state, "output-error");
        assert.equal(dynamicToolPart?.errorText, "Unknown subagent target 'reviewer'.");

        return responseFromChunks([
          { type: "text-start", id: "parent-close-text-3" },
          {
            type: "text-delta",
            id: "parent-close-text-3",
            delta: "The reviewer has already been closed.",
          },
          { type: "text-end", id: "parent-close-text-3" },
          { type: "finish", finishReason: "stop" },
        ]);
      }

      throw new Error(`Unexpected parent call ${parentCallCount}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-subagents-close");

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

          const runTurn = (input: string) =>
            Effect.gen(function* () {
              const completionFiber = yield* waitForCompletion();
              yield* Effect.sleep("10 millis");
              yield* adapter.sendTurn({
                threadId,
                input,
              });
              const completed = yield* Fiber.join(completionFiber);
              assert.equal(completed._tag, "Some");
            });

          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });

          yield* runTurn("Delegate this task and wait for the result.");
          yield* runTurn("Close the reviewer subagent.");
          yield* runTurn("Try sending another message to the closed reviewer.");

          assert.equal(subagentRequestBodies.length, 1);
          assert.equal(parentRequestBodies.length, 7);
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
    assert.match(prompt, /^## Local Launch Actions\n/m);
    assert.match(prompt, /^## Uncertainty And Honesty\n/m);
    assert.match(prompt, /^## Response Style\n/m);
    assert.match(prompt, /You are ShioriCode/);
    assert.match(prompt, /You are not Codex/);
    assert.ok(!prompt.includes("browser-launch"));
    assert.ok(!prompt.includes("browser page"));
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

  it("adds browser and computer prompt sections only when their gates are enabled", () => {
    const disabledRules = buildShioriWorkspaceRules({
      cwd: "/tmp/project",
      browserUseEnabled: false,
      computerUseEnabled: false,
    });

    assert.ok(disabledRules.every((rule) => !rule.includes("## Browser Use")));
    assert.ok(disabledRules.every((rule) => !rule.includes("## Computer Use")));
    assert.ok(disabledRules.every((rule) => !rule.includes("browser-opening command")));

    const enabledRules = buildShioriWorkspaceRules({
      cwd: "/tmp/project",
      browserUseEnabled: true,
      computerUseEnabled: true,
    });

    assert.ok(enabledRules.some((rule) => rule.includes("## Browser Use")));
    assert.ok(enabledRules.some((rule) => rule.includes("## Computer Use")));
    assert.ok(enabledRules.some((rule) => rule.includes("browser-opening command")));
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
      generateMemories: false,
    });

    assert.equal(rules.length, 3);
    assert.match(rules[1] ?? "", /^## Response Rendering\n/m);
    const runtimePrompt = rules[2];
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

  it("registers edit as a file-change tool", () => {
    const tools = buildHostedToolDescriptors({
      allowedRequestKinds: new Set(),
      session: {
        runtimeMode: "approval-required",
      } satisfies Pick<ProviderSession, "runtimeMode">,
    });

    const descriptor = tools.find((tool) => tool.name === "edit");
    assert.ok(descriptor);
    assert.equal(descriptor.title, "Edit files");
    assert.equal(toolRequestKind("edit"), "file-change");
    assert.deepStrictEqual(descriptor.inputSchema, {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description: "Unified diff patch text.",
        },
      },
      required: ["patch"],
      additionalProperties: false,
      "x-shioricode-request-kind": "file-change",
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

  it("registers web_search as a hosted tool without approval metadata", () => {
    const tools = buildHostedToolDescriptors({
      allowedRequestKinds: new Set(),
      session: {
        runtimeMode: "approval-required",
      } satisfies Pick<ProviderSession, "runtimeMode">,
    });

    const descriptor = tools.find((tool) => tool.name === "web_search");
    assert.ok(descriptor);
    assert.equal(descriptor.title, "Web search");
    assert.equal(toolRequestKind("web_search"), undefined);
    assert.deepStrictEqual(descriptor.inputSchema, {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to run on the public web.",
        },
        max_results: {
          type: "number",
          description: "Optional maximum number of results to return. Defaults to 5.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    });
  });

  it("honors hosted bootstrap subagent gating", () => {
    const tools = buildHostedToolDescriptors({
      allowedRequestKinds: new Set(),
      session: {
        runtimeMode: "approval-required",
      } satisfies Pick<ProviderSession, "runtimeMode">,
      hostedBootstrap: {
        approvalPolicies: {},
        protectedPaths: [],
        subagents: {
          enabled: false,
          profiles: {},
        },
      },
    });

    assert.ok(!tools.some((tool) => tool.name === "spawn_agent"));
    assert.ok(!tools.some((tool) => tool.name === "agent"));
  });

  it("fails closed when hosted bootstrap is unavailable", () => {
    const tools = buildHostedToolDescriptors({
      allowedRequestKinds: new Set(["command"]),
      session: {
        runtimeMode: "full-access",
      } satisfies Pick<ProviderSession, "runtimeMode">,
      hostedBootstrap: undefined,
    });

    const execDescriptor = tools.find((tool) => tool.name === "exec_command");
    assert.ok(execDescriptor);
    assert.equal(execDescriptor.inputSchema["x-shioricode-needs-approval"], true);
    assert.ok(!tools.some((tool) => tool.name === "spawn_agent"));
    assert.ok(!tools.some((tool) => tool.name === "agent"));
  });

  it("forces command approval when hosted bootstrap requires shell commands to ask", () => {
    const tools = buildHostedToolDescriptors({
      allowedRequestKinds: new Set(["command"]),
      session: {
        runtimeMode: "full-access",
      } satisfies Pick<ProviderSession, "runtimeMode">,
      hostedBootstrap: {
        approvalPolicies: {
          shellCommand: "ask",
          outsideWorkspace: "ask",
        },
        protectedPaths: [],
        subagents: null,
      },
    });

    const descriptor = tools.find((tool) => tool.name === "exec_command");
    assert.ok(descriptor);
    assert.equal(descriptor.inputSchema["x-shioricode-needs-approval"], true);
  });
});

// Zero-delay retry schedule; still exercises retry semantics without wall-clock sleep.
const INSTANT_RETRY_DELAY = () => 0;
const INSTANT_RETRY_MAX = 3;

function makeShioriTestLayerWithInstantRetries(
  options?: Parameters<typeof makeShioriAdapterLive>[0],
) {
  return makeShioriAdapterLive({
    buildMcpToolRuntime: emptyMcpToolRuntime,
    buildSkillToolRuntime: emptyMcpToolRuntime,
    maxFetchRetries: INSTANT_RETRY_MAX,
    fetchRetryDelayMs: INSTANT_RETRY_DELAY,
    ...options,
  }).pipe(
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

describe("ShioriAdapterLive fetch reliability", () => {
  it("retries transient 5xx failures and then succeeds", async () => {
    let streamCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.includes("/config/bootstrap")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      streamCalls += 1;
      if (streamCalls < 3) {
        return new Response("temporary outage", {
          status: 503,
          statusText: "Service Unavailable",
        });
      }
      return responseFromChunks([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "ok" },
        { type: "text-end", id: "text-1" },
        { type: "finish", finishReason: "stop" },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-retry-5xx");
          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "approval-required",
          });

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

          yield* adapter.sendTurn({ threadId, input: "hello" });
          const completed = yield* Fiber.join(completedFiber);
          assert.equal(completed._tag, "Some");
          if (completed._tag === "Some") {
            assert.equal(completed.value.payload.state, "completed");
          }
          assert.equal(streamCalls, 3);
        }).pipe(Effect.provide(makeShioriTestLayerWithInstantRetries())),
      ),
    );
  });

  it("fails with a clear error once transient failures exhaust the retry budget", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.includes("/config/bootstrap")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error("fetch failed: ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-retry-exhaust");
          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "approval-required",
          });

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

          yield* adapter.sendTurn({ threadId, input: "hello" });
          const completed = yield* Fiber.join(completedFiber);
          assert.equal(completed._tag, "Some");
          if (completed._tag === "Some") {
            assert.equal(completed.value.payload.state, "failed");
            assert.match(
              String(completed.value.payload.errorMessage ?? ""),
              /ECONNREFUSED|fetch failed|request failed/i,
            );
          }
          // Initial attempt + 3 retries = 4 total fetch calls to the stream endpoint.
          const streamCallCount = fetchMock.mock.calls.filter(([input]) => {
            const url = typeof input === "string" ? input : (input as URL).toString();
            return url.includes("/agent/stream");
          }).length;
          assert.equal(streamCallCount, 4);
        }).pipe(Effect.provide(makeShioriTestLayerWithInstantRetries())),
      ),
    );
  });

  it("does not retry 4xx responses and surfaces the server detail", async () => {
    let streamCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.includes("/config/bootstrap")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      streamCalls += 1;
      return new Response(JSON.stringify({ error: "Invalid request body." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-400");
          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "approval-required",
          });

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

          yield* adapter.sendTurn({ threadId, input: "hello" });
          const completed = yield* Fiber.join(completedFiber);
          assert.equal(completed._tag, "Some");
          if (completed._tag === "Some") {
            assert.equal(completed.value.payload.state, "failed");
            assert.match(
              String(completed.value.payload.errorMessage ?? ""),
              /Invalid request body/i,
            );
          }
          assert.equal(streamCalls, 1);
        }).pipe(Effect.provide(makeShioriTestLayerWithInstantRetries())),
      ),
    );
  });

  it("clears the cached auth token and surfaces a sign-in prompt on 401", async () => {
    const tokens = { current: "header.payload.signature" as string | null };
    const setToken = vi.fn(async (value: string | null) => {
      tokens.current = value;
    });
    const customTokenLayer = Layer.succeed(HostedShioriAuthTokenStore, {
      getToken: Effect.sync(() => tokens.current),
      setToken: (value) => Effect.sync(() => setToken(value)),
      streamChanges: Stream.empty,
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.includes("/config/bootstrap")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Token expired." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const customLayer = makeShioriAdapterLive({
      buildMcpToolRuntime: emptyMcpToolRuntime,
      buildSkillToolRuntime: emptyMcpToolRuntime,
      maxFetchRetries: INSTANT_RETRY_MAX,
      fetchRetryDelayMs: INSTANT_RETRY_DELAY,
    }).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-shiori-adapter-test-" }),
      ),
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          providers: { shiori: { apiBaseUrl: "http://shiori.test" } },
        }),
      ),
      Layer.provideMerge(customTokenLayer),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(workspaceEntriesTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-401");
          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "approval-required",
          });

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

          yield* adapter.sendTurn({ threadId, input: "hello" });
          const completed = yield* Fiber.join(completedFiber);
          assert.equal(completed._tag, "Some");
          if (completed._tag === "Some") {
            assert.equal(completed.value.payload.state, "failed");
            assert.match(
              String(completed.value.payload.errorMessage ?? ""),
              /Sign out and sign back in/i,
            );
          }
          assert.equal(tokens.current, null);
          assert.ok(setToken.mock.calls.some(([value]) => value === null));
        }).pipe(Effect.provide(customLayer)),
      ),
    );
  });

  it("fails the turn when the stream payload exceeds the configured byte cap", async () => {
    const huge = "x".repeat(8 * 1024);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.includes("/config/bootstrap")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Long text delta that will push past the cap before the stream completes.
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encodeSseChunk({ type: "text-start", id: "text-big" }));
            for (let index = 0; index < 8; index += 1) {
              controller.enqueue(
                encodeSseChunk({ type: "text-delta", id: "text-big", delta: huge }),
              );
            }
            controller.enqueue(encodeSseChunk({ type: "text-end", id: "text-big" }));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const layer = makeShioriAdapterLive({
      buildMcpToolRuntime: emptyMcpToolRuntime,
      buildSkillToolRuntime: emptyMcpToolRuntime,
      maxFetchRetries: INSTANT_RETRY_MAX,
      fetchRetryDelayMs: INSTANT_RETRY_DELAY,
      maxStreamBytes: 2 * 1024, // far smaller than the chunk we emit
    }).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-shiori-adapter-test-" }),
      ),
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          providers: { shiori: { apiBaseUrl: "http://shiori.test" } },
        }),
      ),
      Layer.provideMerge(hostedShioriAuthTokenStoreTestLayer),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(workspaceEntriesTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-overflow");
          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "approval-required",
          });

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

          yield* adapter.sendTurn({ threadId, input: "hello" });
          const completed = yield* Fiber.join(completedFiber);
          assert.equal(completed._tag, "Some");
          if (completed._tag === "Some") {
            assert.equal(completed.value.payload.state, "failed");
            assert.match(
              String(completed.value.payload.errorMessage ?? ""),
              /maximum size|too large|exceeded/i,
            );
          }
        }).pipe(Effect.provide(layer)),
      ),
    );
  });

  it("persists assistant text when the stream closes mid-turn without a finish event", async () => {
    // The stream ends cleanly after a single text-delta — no text-end and no
    // finish. The adapter must still keep the partial assistant reply in the
    // thread history so the next turn can build on it.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.includes("/config/bootstrap")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return responseFromChunks([
        { type: "text-start", id: "text-partial" },
        {
          type: "text-delta",
          id: "text-partial",
          delta: "Here is the partial answer",
        },
        // No text-end, no finish — stream closes as if the network dropped out.
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-partial-text");
          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "approval-required",
          });

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

          yield* adapter.sendTurn({ threadId, input: "hello" });
          const completed = yield* Fiber.join(completedFiber);
          assert.equal(completed._tag, "Some");

          const sessions = yield* adapter.listSessions();
          const session = sessions.find((entry) => String(entry.threadId) === String(threadId));
          assert.ok(session);
          const resumeCursor = session?.resumeCursor as
            | {
                messages?: Array<{
                  role?: string;
                  parts?: Array<{ type?: string; text?: string }>;
                }>;
              }
            | undefined;
          const lastMessage = resumeCursor?.messages?.at(-1);
          assert.equal(lastMessage?.role, "assistant");
          const textPart = lastMessage?.parts?.find((part) => part.type === "text");
          assert.ok(textPart);
          assert.match(String(textPart?.text ?? ""), /partial answer/i);
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("emits an error state when the stream produces an error chunk", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.includes("/config/bootstrap")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return responseFromChunks([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "partial " },
        {
          type: "error",
          errorText: JSON.stringify({
            code: 502,
            message: "Network connection lost.",
            metadata: { error_type: "provider_unavailable" },
          }),
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-error-chunk");
          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "approval-required",
          });

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

          yield* adapter.sendTurn({ threadId, input: "hello" });
          const completed = yield* Fiber.join(completedFiber);
          assert.equal(completed._tag, "Some");
          if (completed._tag === "Some") {
            assert.equal(completed.value.payload.state, "failed");
            assert.match(
              String(completed.value.payload.errorMessage ?? ""),
              /Network connection lost\. \(provider unavailable\)/i,
            );
          }
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });

  it("tags the hosted request with X-ShioriCode-Api-Version so drift is detectable", async () => {
    let apiVersionHeader: string | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.includes("/config/bootstrap")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const headers = init?.headers as Record<string, string> | undefined;
      apiVersionHeader = headers?.["X-ShioriCode-Api-Version"] ?? null;
      return responseFromChunks([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "ok" },
        { type: "text-end", id: "text-1" },
        { type: "finish", finishReason: "stop" },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* ShioriAdapter;
          const threadId = asThreadId("thread-shiori-version-header");
          yield* adapter.startSession({
            provider: "shiori",
            threadId,
            runtimeMode: "approval-required",
          });
          yield* adapter.sendTurn({ threadId, input: "hello" });
          // Give the fork a moment to complete.
          yield* Effect.sleep("20 millis");
          assert.ok(apiVersionHeader, "expected X-ShioriCode-Api-Version header");
        }).pipe(Effect.provide(shioriAdapterTestLayer)),
      ),
    );
  });
});
